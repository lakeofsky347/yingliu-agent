/**
 * R04: structured outcome of a paid submission, carried on thrown errors as `error.submission`.
 * - preflight_failed: nothing was sent to the provider (validation, credentials, revision conflict).
 * - failed: the provider definitively rejected or failed the request (no billable work in flight).
 * - unknown: the request may have been accepted (network error/timeout after sending, poll timeout, abort,
 *   or success that could not be registered). Never resubmit automatically.
 */
export type SubmissionState = 'preflight_failed' | 'failed' | 'unknown';
export interface SubmissionInfo { submission: SubmissionState; jobId?: string }

export function withSubmission(error: unknown, submission: SubmissionState, jobId?: string): Error & SubmissionInfo {
  const value = (error instanceof Error ? error : new Error(String(error))) as Error & SubmissionInfo & { submissionUncertain?: boolean };
  // An inner layer that already decided keeps its verdict unless the outer one is more cautious.
  if (!value.submission || submission === 'unknown') value.submission = submission;
  if (jobId && !value.jobId) value.jobId = jobId;
  value.submissionUncertain = value.submission === 'unknown';
  return value;
}
/** Outcome of an error thrown while (possibly) sending: definite 4xx rejections are 'failed', everything else 'unknown'. */
export function sendOutcome(error: unknown): SubmissionState {
  const status = Number((error as { httpStatus?: unknown; status?: unknown })?.httpStatus ?? (error as { status?: unknown })?.status);
  return Number.isInteger(status) && status >= 400 && status < 500 && status !== 408 && status !== 429 ? 'failed' : 'unknown';
}
/** Read the structured state; legacy `submissionUncertain` flags map onto it. undefined = not declared by the adapter. */
export function submissionOf(error: unknown): SubmissionState | undefined {
  const value = error as { submission?: unknown; submissionUncertain?: unknown } | undefined;
  if (value?.submission === 'preflight_failed' || value?.submission === 'failed' || value?.submission === 'unknown') return value.submission;
  if (value?.submissionUncertain === true) return 'unknown';
  if (value?.submissionUncertain === false) return 'preflight_failed';
  return undefined;
}
