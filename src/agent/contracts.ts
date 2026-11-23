import type { StudioSnapshot, SceneSource, VideoProject } from '../shared/types.ts';
import type { Ledger, QcReport, Story } from './story.ts';
import type { AuthorizeUpload, UploadConsentChallenge, UploadDestination } from '../models/upload-consent.ts';
import type { MediaRequest, MediaTask } from '../jobs/contracts.ts';

/** Risk tiers: read runs freely; write is revision-checked and undoable; cost/export always need a human by default. */
export type ToolRisk = 'read' | 'write' | 'plan' | 'cost' | 'export';
export type JsonSchema = Record<string, unknown>;
export type CrewDepartment = 'screenwriter' | 'art_director' | 'cinematographer' | 'scene_coder' | 'sound_director' | 'post_editor_qc';

export interface ReferenceUploadGroup { role: 'image' | 'video'; assetIds: string[] }

export interface SubagentSkippedTool {
  id?: string;
  tool: string;
  reason: string;
  kind: 'precondition' | 'turn_limit' | 'cancelled' | 'timeout';
  status?: string;
  targetSig?: string;
  turnStep?: number;
}

export interface SubagentCheckpoint {
  department: CrewDepartment;
  messages: AgentMessage[];
  stepIdx: number;
  pendingCalls: ToolCall[];
  executedTools: string[];
  failedTools: { tool: string; error: string }[];
  skippedTools?: SubagentSkippedTool[];
  latestRevision?: number;
  completedResult?: ToolResult;
}

export interface ToolContext {
  runId: string; projectId: string; signal: AbortSignal; port: AgentPort;
  /** Per-project structured plan (story.json / Production Bible) and spend ledger. */
  docs: AgentDocs;
  /** Non-empty when running inside a shot-scoped crew sub-agent sandbox. */
  scopedShotIds?: ReadonlySet<string>;
  videoReference?: {
    assetId: string;
    assetIds?: string[];
    role?: 'image' | 'video';
    authorizeUpload: AuthorizeUpload;
    authorizeRoleUpload?: (role: 'image' | 'video') => AuthorizeUpload;
  };
  /** Hierarchical delegation to specialized film crew sub-agents (isolated context, shared CAS & ledger). */
  delegateCrew?: (department: CrewDepartment, task: string, shotIds?: string[], execId?: string) => Promise<ToolResult>;
  /** Durable per-item submission receipts for batch media tools so partial failures never duplicate paid requests. */
  getBatchReceipt?: (batchKey: string) => Record<number, string> | undefined;
  saveBatchItemReceipt?: (batchKey: string, index: number, taskId: string, shotId?: string) => Promise<void>;
}
export interface AgentDocs {
  story(): Promise<Story>;
  updateStory(change: (story: Story) => Story, expectedVersion?: number): Promise<Story>;
  ledger(): Promise<Ledger>;
  saveQc(report: QcReport): Promise<void>;
}
export interface ProjectTaskRef { id: string; kind: 'storyboard' | 'scenes' | 'modify' | 'preview' | 'export' | 'audio'; retryOf?: string }
export interface ToolResult {
  /** Text returned to the model (redacted, size-bounded). */
  content: string;
  /** Optional images (PNG/JPEG bytes) for vision-capable models. */
  images?: { mime: string; bytes: Uint8Array }[];
  /** Reported spend for this call when the provider gives one. */
  cost?: number | null;
  /** When set, the run suspends until this async task reaches a terminal phase. */
  waitFor?: { kind: 'media' | 'workflow'; id: string };
  /** When set, the run suspends until all async media tasks in this batch settle concurrently. */
  waitForBatch?: { kind: 'media'; ids: string[]; autoApplyShots?: Record<string, string> };
  /** Exact host task started by this call; later tasks must not replace this association. */
  projectTask?: ProjectTaskRef;
  revision?: number;
}
/** Persisted separately before any fallible bookkeeping, so a known side effect is never submitted again. */
export interface ToolSuccessReceipt { execId: string; tool: string; argsHash: string; risk: ToolRisk; stepIndex: number; at: string; result: ToolResult }
export interface AgentTool {
  /** Tool only exposed when all these roles are bound. */
  requires?: GenRole[];
  /** Tool only exposed when none of these roles are bound (director fallback). */
  fallbackFor?: GenRole[];
  name: string; description: string; parameters: JsonSchema; risk: ToolRisk;
  /** Estimated spend before running (used by budget gate); null = unknown. */
  estimate?(args: Record<string, unknown>): number | null;
  referenceImage?(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
  referenceImages?(args: Record<string, unknown>, ctx: ToolContext): Promise<{ assetIds: string[]; role: 'image' | 'video' } | { groups: ReferenceUploadGroup[] }>;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export type GenRole = 'image' | 'video' | 'speech' | 'music' | 'sfx' | 'vision' | 'blender';
export interface Capabilities { roles: GenRole[]; director?: string; scene?: string; models?: Partial<Record<GenRole, string>> }
/** `id` is the provider's tool_call_id (only used to thread tool messages); `execId` is server-generated and single-use. */
export interface ToolCall { id: string; name: string; arguments: string; execId?: string }
export type AgentMessage =
  | { role: 'system' | 'user'; content: string | AgentContent[] }
  | { role: 'assistant'; content: string | null; tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[] }
  | { role: 'tool'; tool_call_id: string; content: string };
export type AgentContent = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

export interface ModelTurn {
  content: string; toolCalls: ToolCall[]; finish: 'stop' | 'tool_calls' | 'length' | 'other';
  usage: { inputTokens: number; outputTokens: number }; usageKnown: boolean; mode: 'tools' | 'plan-json';
}

export interface Budget {
  maxSteps: number; maxToolCalls: number; maxTokens: number;
  /** Spend ceiling in `currency`; null = no monetary ceiling (unknown costs still require approval for cost tools). */
  maxCost: number | null; currency: string;
}
export interface Usage { steps: number; toolCalls: number; inputTokens: number; outputTokens: number; cost: number; unknownCostCalls: number; currency: string }

export interface ApprovalPolicy { autoApprove: ToolRisk[] }
export type RunStatus = 'running' | 'awaiting_approval' | 'waiting_task' | 'paused' | 'complete' | 'failed' | 'cancelled' | 'budget_exceeded';

export interface RunStep {
  index: number; kind: 'model' | 'tool' | 'approval' | 'review' | 'compress';
  status: 'running' | 'complete' | 'failed' | 'pending' | 'rejected' | 'skipped';
  startedAt: string; finishedAt?: string; durationMs?: number;
  tool?: string; callId?: string; risk?: ToolRisk; arguments?: string; summary?: string; error?: string; attempts?: number;
}
export interface PendingApproval { callId: string; tool: string; risk: ToolRisk; arguments: string; reason: string; estimate: number | null; execId?: string; argsHash?: string }

export interface AgentRun {
  version: 1; id: string; projectId: string; goal: string; status: RunStatus; message: string;
  createdAt: string; updatedAt: string;
  model: { connectionId?: string; model?: string; mode?: 'tools' | 'plan-json' };
  budget: Budget; usage: Usage; policy: ApprovalPolicy;
  messages: AgentMessage[]; steps: RunStep[];
  /** Tool calls from the last assistant turn not yet executed (resumable). */
  queue: ToolCall[];
  pending?: PendingApproval;
  waiting?: { kind: 'media' | 'workflow'; id: string; callId: string; execId?: string };
  waitingBatch?: { kind: 'media'; ids: string[]; callId: string; execId?: string; autoApplyShots?: Record<string, string>; uncertainCount?: number; uncertainError?: string };
  taskRefs?: (ProjectTaskRef & { callId: string; execId?: string })[];
  /** Usage settlement keys already applied to this snapshot; the project ledger has its own atomic deduplication. */
  settledToolExecIds?: string[];
  /** Legacy (≤0.5.0) field; never trusted for skipping approval. */
  approvedCallIds: string[];
  /** One-shot approvals bound to a server execution ID + tool + canonical argument hash; consumed on use. */
  approvals?: { execId: string; tool: string; argsHash: string }[];
  reviewRounds: number;
  allowImages?: boolean;
  visionGrant?: string;
  visionChallengeFingerprint?: string;
  visionConsentRequired?: UploadConsentChallenge;
  videoReferenceGrant?: { execId: string; assetId: string; assetIds?: string[]; role?: 'image' | 'video'; fingerprint: string };
  referenceGrants?: { execId: string; role: 'image' | 'video'; assetIds: string[]; fingerprint: string }[];
  pendingVideoReference?: { execId: string; assetId: string; assetIds?: string[]; role?: 'image' | 'video' };
  subagentCheckpoints?: Record<string, SubagentCheckpoint>;
  batchReceipts?: Record<string, Record<number, string>>;
  batchReceiptShots?: Record<string, Record<number, string>>;
  /** Reflection was interrupted before a request was authorized. */
  pendingSelfCheck?: boolean;
  /** Paid/side-effect submissions whose outcome is unknown (accepted-then-lost response). Never auto-resubmitted. */
  /** R03: receipt persisted *before* a paid/export side effect starts; cleared once its outcome is known. */
  inFlight?: { execId: string; tool: string; argsHash: string; startedAt: string };
  uncertainSubmissions?: { execId: string; tool: string; at: string; error: string; attempts: number; jobId?: string }[]; final?: string; error?: string;
  /** Pending follow-up / steering user messages queued while running. */
  pendingUserMessages?: string[];
  /** Capabilities and tool names active at the latest model step. */
  active?: { roles: GenRole[]; tools: string[]; selfMade: string[] };
}

export interface AgentStartInput {
  projectId: string; goal: string; budget?: Partial<Budget>; autoApprove?: ToolRisk[];
  allowImages?: boolean; maxReviewRounds?: number;
}
export type AgentEvent = { type: 'run'; run: PublicRun } | { type: 'step'; runId: string; step: RunStep } | { type: 'delta'; runId: string; text: string };
export type PublicRun = Omit<AgentRun, 'messages'|'visionGrant'|'visionChallengeFingerprint'|'pendingSelfCheck'|'videoReferenceGrant'|'referenceGrants'|'pendingVideoReference'|'subagentCheckpoints'|'batchReceipts'|'batchReceiptShots'> & { transcript: { role: string; content: string; tool?: string }[] };

/** Narrow host surface the agent may touch. Never exposes file paths or credentials. */
export interface AgentPort {
  snapshot(projectId: string): Promise<StudioSnapshot>;
  readSource(projectId: string, shotId: string): Promise<SceneSource>;
  saveSource(projectId: string, shotId: string, expectedRevision: number, source: SceneSource): Promise<StudioSnapshot>;
  commit(projectId: string, expectedRevision: number, project: VideoProject, sources: Record<string, SceneSource>, label: string): Promise<StudioSnapshot>;
  route(endpoint: string, payload: Record<string, unknown>): Promise<{ ok: boolean; value?: unknown; error?: { code: string; message: string } }>;
  capture(projectId: string, frame: number, signal: AbortSignal): Promise<{ bytes: Uint8Array; mime: string; frame: number; shotId: string }>;
  /** Synthesize narration/dialogue and register it as a project asset (idempotent per requestId, supports character voice/speed). */
  voice?(projectId: string, shotId: string, text: string, signal: AbortSignal, options?: { expectedRevision?: number; requestId?: string; voice?: string; speed?: number; speaker?: string }): Promise<{ id: string; name: string; revision?: number }>;
  /** Generate audio with a bound role (speech/music/sfx) and import it as a project asset. */
  generateAudio?(projectId: string, role: 'speech' | 'music' | 'sfx', prompt: string, options: { durationSeconds?: number; signal: AbortSignal; shotId?: string }): Promise<{ id: string; name: string; cost?: number | null }>;
  /** Import locally synthesized audio bytes (WAV) as a project asset (idempotent when requestId is supplied). */
  importAudio?(projectId: string, name: string, bytes: Uint8Array, mime: string, requestId?: string): Promise<{ id: string; name: string }>;
  /** Which generation roles are currently bound (hot: read every step). */
  capabilities?(): Promise<Capabilities>;
  /** Import image bytes (e.g. a captured tail frame) as a project asset (idempotent when requestId is supplied). */
  importImage?(projectId: string, name: string, bytes: Uint8Array, mime: string, requestId?: string): Promise<{ id: string; name: string }>;
  visionDestination?(): Promise<UploadDestination>;
  vision?(prompt: string, images: { mime: string; bytes: Uint8Array }[], signal: AbortSignal, authorizeUpload?: AuthorizeUpload): Promise<string>;
  imageReferenceDestination?(): Promise<UploadDestination>;
  generateImageReference?(request: MediaRequest, authorizeUpload: AuthorizeUpload): Promise<MediaTask>;
  videoReferenceDestination?(): Promise<UploadDestination>;
  generateVideoReference?(request: MediaRequest, authorizeUpload: AuthorizeUpload): Promise<MediaTask>;
  /** Render a deterministic whitebox 3D shot previsualization (with articulated poses & Z-depth pass) via local headless Blender. */
  renderPreviz?(projectId: string, spec: import('../host/blender.ts').PrevizSceneSpec, options: { shotId?: string; name?: string; bindPreviewClip?: boolean; signal: AbortSignal }): Promise<{ imageAssetId: string; depthAssetId?: string; videoAssetId?: string; width: number; height: number; fps: number; frameCount: number; revision: number }>;
  /** Generate or refine deterministic HTML/CSS/JS scene code using the bound `scene` role model (falling back to `director`). */
  generateSceneCode?(projectId: string, shotId: string, instruction: string, signal: AbortSignal, expectedRevision?: number): Promise<{ shotId: string; revision: number; summary: string }>;
}
