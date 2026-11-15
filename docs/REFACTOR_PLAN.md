# 映流智能体整体重构方案

本文只做调研与方案。基线是当前分支 `cursor/openai-split-model-config-1c46`（PR #9，未合并），提交 `2baca93`。新仓库按此方案从头实现；本仓库业务代码不在本次改动范围内。

对照实现：

- 插件版 [yingliu-video-studio](https://github.com/lakeofsky347/yingliu-video-studio) `0.6.1`：DSH / cordis 插件。宿主 `src/host/index.ts` 用 `apply(ctx)` 逐条注册 `/api/video-studio/<endpoint>`；客户端 `src/client/index.tsx` 从宿主 `theme` 同步 `controller.setScheme`，只注入一份 `styles.css`。
- 独立桌面版 [yingliu-studio](https://github.com/lakeofsky347/yingliu-studio)：本仓库的拆分来源，模块划分与本仓库同源。智能体循环是本仓库相对插件的增量，插件没有 `src/agent/`。

新仓库借鉴插件的**接法**（显式端点表、单一变量表、主题从外部推入控制器、`ModelRegistry` 为模型配置事实），不引入 DSH、cordis，也不读取其他应用的凭据。

约束贯穿全文：API Key 只进凭据服务；工程、`provider.json`、注册表、偏好、备份、任务参数都不出现密钥明文；CSP 维持 `default-src 'self'`，不放宽。

---

## 1. 现状诊断

### 1.1 模块划分

运行时是「浏览器 UI + 本机 HTTP/IPC + 应用服务 + 工程存储」。`docs/ARCHITECTURE.md` 的模块表仍然准确，源码落点如下。

| 层 | 路径 | 现在实际在做什么 |
| --- | --- | --- |
| 桌面壳 | `src/desktop/main.ts`、`preload.ts`、`web-preferences.ts`、`native-secrets.ts` | Electron 44 单实例、sandbox + contextIsolation、safeStorage。`editorWebPreferences` 关闭 Node。 |
| 实验壳 | `src-tauri/`、`src/sidecar/main.ts` | Tauri 2 + sidecar，P0 实验，不参与默认构建。见 `docs/p0/REPORT.md`。 |
| 应用编排 | `src/app/application.ts`、`backend.ts`、`ui-server.ts`、`web-server.ts` | 白名单路由、组装模型/对话/媒体/工作流/智能体、127.0.0.1 UI 服务。 |
| 智能体 | `src/agent/*` | 工具循环、审批、回执、预算、创作计划。入口在 `AgentService`。 |
| 对话导演 | `src/app/conversation.ts` | 另一套「计划 JSON」导演，与智能体循环并行。 |
| 固定流程 | `src/workflows/service.ts` | 导演 / 画面 / 配音 / 检查的宏流程，智能体里是工具 `run_workflow`。 |
| 模型 | `src/app/model.ts`、`src/models/*` | 快速配置 `ProviderManager` 与 `ModelRegistry` 双写。 |
| 凭据 | `src/app/secrets.ts`、`src/desktop/native-secrets.ts`、`src/migration/credential-migration.ts` | 引用 + 加密文件。界面只看 `hasKey`。 |
| 工程 | `src/host/store.ts`、`service.ts`、`project-hub.ts`、`src/core/index.ts` | 不可变版本、原子 head、`expectedRevision`、整数帧。 |
| 媒体任务 | `src/jobs/media-tasks.ts`、`src/models/adapters/*` | 异步生成、对账、下载校验。 |
| 画面 | `src/host/renderer.ts`、`src/runtime/browser.ts`、`src/sandbox/scene-worker.ts` | 场景与编辑器分 origin；场景 CSP 更严，无 preload。 |
| UI | `src/client/*` | React 18。首页/对话在 `App.tsx`，工作台在 `Studio.tsx`，状态在 `StudioController`。 |
| CLI | `src/cli/main.ts`、`bin/yingliu.mjs` | 与桌面共用所有权锁与应用服务。 |
| 构建 | `scripts/build.mjs` | esbuild，浏览器目标 `chrome120`，UI 打成单个 `dist/ui/app.js`（CSS 经 loader 打进样式，另有 `app.css` 服务路径）。 |

`package.json`：React 18.3.1、esbuild 0.28.2、Electron 44.9.3、`@comfyorg/litegraph` 0.17.2、Node `>=22.18`、测试 `node --import tsx --test`。CI：`.github/workflows/platform-checks.yml`（ubuntu / windows / macos）、`native-acceptance.yml`、实验性 `tauri-p0.yml`。

### 1.2 数据流

```
React（App / Studio / AgentPanel）
  → StudioController 或组件内 fetch
  → POST /api/<endpoint>（X-Yingliu-Token + 同源）或 Electron IPC
  → Application.route（ENDPOINTS 白名单）
       ├─ 工程：ProjectHub → HostService 串行队列 → Store（expectedRevision）
       ├─ 模型：ProviderManager → ModelRegistry → SecretStore（只传引用）
       ├─ 对话：ConversationService → 文本 slot
       ├─ 智能体：AgentService → director 文本模型；图片只走 vision 角色
       ├─ 媒体：MediaTaskService / WorkflowService
       └─ 导出：Renderer（冻结 revision）→ FFmpeg
```

工程事实在 `.studio/versions/<id>.json` 与 `.studio/state.json`。`project.json` 和 `shots/` 是可修复投影。同一工程的写操作排队，写入前核对 `expectedRevision`。导出先复制该 revision 的源码与素材。

模型配置有两条磁盘记录：

1. `provider.json`，本分支写入 **version 3**：`{ version, config, vision, mode }`。`config` 是文本接口，强制 `supportsVision/enableVision = false`；`vision` 是独立多模态接口，未保存则为 `null`。见 `src/app/model.ts` 的 `persistFile`。
2. `model-registry.json`，`RegistryState.version = 1`（`src/models/contracts.ts`）。连接、模型、角色的正式目录。密钥不在文件里，只有 `credentialRef`。

文本密钥引用固定为 `yingliu.custom-model.api-key`，多模态为 `yingliu.custom-vision.api-key`（`TEXT_KEY_REF` / `VISION_KEY_REF`）。默认文本是 OpenAI `https://api.openai.com/v1` + `gpt-6-luna`；多模态建议 `gpt-6.1-terra`，未保存则不发送图片。`ProviderManager.initialize` 把 `provider.json` 投影进注册表；`save` / `commitVision` 再把快速配置写回两份文件。模型中心走 `models.connection.save`，密钥经 `updateCredential` 进 `SecretStore`，请求体里的 `apiKey` 只活在这次调用中。

画面与编辑器分离：UI 服务 CSP 在 `src/app/ui-server.ts`，场景服务 CSP 在 `src/host/renderer.ts`。静态文件白名单只有 `/`、`/index.html`、`/app.js`、`/app.css`。`/api/*` 与 `/events/agent` 要令牌和 origin。

### 1.3 主要技术债（带路径）

**1. 两套样式，浅色主题盖不住外壳。**

- `src/client/styles.css`：`vs-` 前缀，约 143 个类。`.vs-studio[data-scheme=light]` 只改工作台变量。
- `src/client/app.css`：`yl-` 前缀，约 98 个类。`:root` 与大量规则写死深色十六进制（如 `#090f18`、`#0c1420`），并用 `.yl-editor .vs-*` 覆盖工作台变量。
- `src/client/index.tsx` 启动时 `controller.setScheme('dark')`。`setScheme` 只改 `StudioState.scheme`（`src/client/controller.ts`），`Studio.tsx` 把它放到 `data-scheme`。没有本地接口，没有落盘。
- 智能体、故事、质检样式后贴在 `app.css` 末尾（`.vs-agent-*`、`.vs-story-*`），颜色仍是另一套硬编码（`#d9a441`、`#dc2626`），不跟 `data-scheme` 走。

这就是「前端过于普通」的结构原因：外壳是一套深色皮肤，工作台是从插件抄来的第二套皮肤，主题开关只作用于内层。

**2. 模型配置双源。**

`ProviderManager`（`src/app/model.ts`，约 241 行但极密）同时维护 `this.config` / `this.vision` 和 `this.registry`。快速配置、角色绑定、旧版迁移、文本禁图都挤在同一个类里。注册表才是协议、并发、角色的正源；`provider.json` 仍是启动时会被读回来的第二份快照。漏改一边就会出现「界面上的文本模型」和「director 角色」不一致。PR #9 已把默认接口拆开，这个拆分要保留，双写要去掉。

**3. 三套编排叠在一个 `createApplication` 里。**

`src/app/application.ts` 在一个函数里组装对话、媒体、工作流、智能体，并用字符串集合 `ENDPOINTS` 扩路由。`AgentPort.route`（`src/agent/contracts.ts`）把任意端点交回应用。工具层因此能碰到完整 RPC，而不是一份收窄的端口。插件版的做法相反：`src/host/index.ts` 把每个 endpoint 登记成独立的 `fetch.register`，服务边界是 `ProjectHub.route`。

三套用户可见的「导演」：

- `ConversationService`：讨论 / 构建初稿 / 修改，计划 JSON。
- `AgentService`（`src/agent/service.ts`，约 590 行）：工具循环，含审批、回执、预算。
- `WorkflowService`（约 350 行）：固定协作流程。

智能体已经把工作流收成工具 `run_workflow`。对话面板仍是另一条执行器。新仓库应只留一个循环。

**4. 超密源码，行为藏在单行里。**

`src/host/store.ts`（429）、`renderer.ts`（422）、`service.ts`（393）、`src/core/index.ts`（367）、`src/cli/main.ts`（316）、`src/client/App.tsx`（81 行但单行 JSX 极长）都是「能跑、难改」。`App.tsx` 同时拥有首页、对话、工程管理、模型对话框和十几个 `useState`。这是重写而不是再打补丁的原因。

**5. 凭据边界有一个类型口子。**

`src/shared/types.ts` 的 `TtsSettings.apiKey?` 仍出现在共享类型里。运行时 `src/host/service.ts` 读 `tts.json` 会 `delete this.tts.apiKey`，快照返回前把 `apiKey` 置为 `undefined`，真实密钥在引用 `YINGLIU_TTS_API_KEY`。类型却允许密钥进入工程形状。新仓库的共享类型里不应有 `apiKey` 字段。

**6. 文档与版本漂移。**

`package.json` 为 `1.1.0`，`README.md` 多处仍写 `0.5.0`。`docs/ARCHITECTURE.md` 仍把模型注册表描述成「旧 custom 迁入、快速配置只编辑 custom」，和本分支的 v3 双槽不一致。重构时以代码和本方案为准，不照抄过期段落。

**7. Tauri 实验没有达到换壳条件。**

`docs/p0/REPORT.md`：Linux 空闲内存比 Electron 高约 46%，结论是有条件继续、不要直接迁移。`src-tauri/tauri.conf.json` 的产品名是 `yingliu-shell-p0`，`bundle.active = false`。

### 1.4 保留、重写、丢弃

| 处置 | 内容 | 理由 |
| --- | --- | --- |
| 保留协议，换清晰实现 | 工程 schema v2、稳定 ID、有理数 FPS、整数帧、相对资产路径、`expectedRevision`、不可变版本 + 原子 head、`.yingliu` v1/v2 | 这是已验收的数据契约，重写存储格式没有收益。 |
| 保留行为 | 同工程写队列、场景与编辑器分进程/分 origin、场景无 Node/IPC、媒体任务对账与「不确定则不重投」、智能体成功回执、cost/export 默认要审批 | 可靠性工作的核心，测试已覆盖（`tests/storage.test.ts`、`tests/agent-success-receipt.test.ts`、`tests/p0-scene-isolation.test.ts` 等）。 |
| 保留并收成单一事实 | 文本 / 多模态分离、OpenAI 默认、两个密钥引用、`ModelRegistry` 的协议与角色表 | PR #9 的产品决定。去掉 `provider.json` 双写，引用字符串保持不变以便旧钥匙环继续可用。 |
| 保留依赖与形态 | Electron 44、esbuild `chrome120` 单包、LiteGraph 只做分镜主链、`node --test`、Playwright verify、三平台 CI | 见第 3 节取舍。 |
| 重写 | UI 皮肤与信息架构、应用组装、RPC 类型、智能体端口、样式系统、偏好存储 | 当前结构挡着主题和后续功能。 |
| 重写时参考插件接法 | 端点逐条登记、`setScheme` 由外部驱动、一份 CSS 变量、`ProjectHub` 作为工程边界 | `yingliu-video-studio` `src/host/index.ts`、`src/client/index.tsx`、`src/client/styles.css`。 |
| 丢弃，不迁入新仓库默认树 | Tauri 壳、sidecar 作为产品入口、DSH/cordis 注入、`demo` 模式进入正常数据目录、把节点图画成通用 Comfy 执行器、对话与智能体两套导演 | Tauri 未过内存线；DSH 与「凭据只属于本应用」冲突；双导演是技术债。P0 报告可作决策记录留档，不带可执行壳。 |

---

## 2. 目标架构

### 2.1 分层

依赖只允许向下。UI 与壳都不 import 存储实现；智能体不 import Electron。

```
桌面壳 Electron
  窗口、文件对话框、safeStorage、IPC 白名单
        │
UI（React，单包）
  纸感 / 暗房同一布局；只通过本地 API
        │
本地 API（127.0.0.1，令牌，路径白名单，CSP）
  ui.preferences | projects | models | agent | jobs | workflows
        │
编排
  一个 AgentRuntime（讨论是只读模式；制作是工具循环）
  WorkflowRunner 仅作为 run_workflow 的实现
        │
┌───────┼────────────┬──────────────┐
文本 Provider   多模态 Provider   工具注册表
director/scene  vision + 图像块   风险等级 + 显式端口
（禁止图片）    （独立连接与密钥）
        │
存储与凭据
  ProjectStore（CAS）  CredentialPort（只存引用的解析）
  PreferencesStore     RunStore / JobStore
```

模型 provider 层拆成两个端口，而不是一个带 `enableVision` 开关的连接：

- **文本端口**：`director`、`scene`。输入模态只有 `text`。请求构造函数拒绝 `image_url`。
- **多模态端口**：`vision`，以及将来明确绑定到该端口的看图调用。未配置时 `visual_review` 降级为不上传像素的 `render_check`（与现在 `docs/AGENT.md` 一致）。
- **生成端口**（生图 / 生视频 / 语音 / 音乐 / 音效）继续走注册表里的协议适配器，各自的 `credentialRef`，不复用文本或视觉的那两把钥匙。

工具 / 插件层：工具是进程内注册表，不是 DSH 插件。每个工具声明风险、JSON Schema、以及它需要的端口方法。没有 `route(endpoint, payload)` 这种后门。

### 2.2 目录草图（新仓库）

```
src/
  domain/                 工程、镜头、帧、资产、修订号（无 IO）
  credentials/            CredentialPort、引用常量、更新回滚
  providers/
    text/                 Chat Completions，禁止图片
    vision/               Chat Completions，image_url 校验
    media/                images、video-gateway、speech、async-task
    registry/             唯一配置文件 model-registry.json
    migrate-provider.ts   读旧 provider.json，不写密钥
  agent/
    runtime.ts            循环、审批、回执
    tools/                一工具一文件
    port.ts               收窄的 AgentPort
    story.ts budget.ts
  projects/               Store、队列、归档、Hub
  jobs/                   媒体任务
  workflows/              宏流程（仅被工具调用）
  render/                 场景发布、CSP、FFmpeg
  api/                    端点表与 HTTP/IPC 适配
  ui/
    tokens.css            paper / darkroom
    shell/                顶栏、首页、对话
    studio/               工作台、图、预览、源码
    preferences.ts
  desktop/                Electron main、preload、safeStorage
  cli/
tests/                    与 src 镜像，node:test
scripts/verify-*.ts       Playwright 验收，不代替单测
```

不设 `src-tauri/`。不设第二份全局 CSS。

### 2.3 关键接口（签名级）

凭据。实现可以是 Electron `safeStorage` 或测试用内存表。配置与工程类型里不出现密钥字段。

```ts
export interface CredentialStatus {
  available: boolean;
  backend: string;
  hasStoredKey?: boolean;
  error?: string;
}

/** 只按引用读写。value 是调用期秘密，不得写入日志、工程或注册表。 */
export interface CredentialPort {
  get(ref: string): Promise<string | undefined>;
  status(ref?: string): Promise<CredentialStatus>;
  /** commit 失败时恢复上一份密文，包括无法解密的旧值。 */
  update(ref: string, value: string | undefined, commit: () => Promise<void>): Promise<void>;
}

export const TEXT_KEY_REF = 'yingliu.custom-model.api-key';
export const VISION_KEY_REF = 'yingliu.custom-vision.api-key';
```

注册表。`parameters` 继续拒绝 `key|secret|token|authorization|credential|password` 这类键（现有 `src/models/registry.ts` 的规则保留）。

```ts
export type TextRole = 'director' | 'scene';
export type VisionRole = 'vision';
export type MediaRole = 'image' | 'video' | 'speech' | 'music' | 'sfx';

export interface ProviderConnection {
  id: string;
  name: string;
  protocol: 'chat-completions' | 'images' | 'video-gateway' | 'speech' | 'async-task';
  baseUrl: string;
  auth: 'bearer' | 'none';
  credentialRef: string;
  enabled: boolean;
  revision: number;
  requestTimeoutMs: number;
  concurrency: number;
}

export interface TextProvider {
  complete(input: {
    role: TextRole;
    system: string;
    messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
    signal: AbortSignal;
    maxTokens?: number;
  }): AsyncIterable<{ type: 'text-delta'; text: string } | { type: 'finish'; reason: 'stop' | 'length' | 'failure' }>;
}

export interface VisionProvider {
  /** 未绑定 vision 或未授权时抛 VisionNotConfigured，调用方改为无像素检查。 */
  describe(input: {
    system: string;
    prompt: string;
    images: { mime: 'image/png' | 'image/jpeg' | 'image/webp'; bytes: Uint8Array }[];
    signal: AbortSignal;
  }): Promise<string>;
}
```

文本消息的 `content` 类型是 `string`，结构上放不进图片。视觉图片是字节加 MIME，由端口编码成 `image_url`，并沿用现有数量、字节、边长校验。

主题。布局组件不分支主题，只读 `data-theme`。

```ts
export type ThemeId = 'paper' | 'darkroom';

export interface UiPreferences {
  version: 1;
  theme: ThemeId;
}

export interface PreferencesStore {
  get(): Promise<UiPreferences>;
  set(next: UiPreferences): Promise<UiPreferences>;
}
```

本地 API（与现有一样只走 POST + 令牌；静态资源仍只有四个路径）：

```ts
export interface LocalApi {
  'ui.preferences.get': { args: Record<string, never>; result: UiPreferences };
  'ui.preferences.set': { args: { theme: ThemeId }; result: UiPreferences };
  'models.list': { args: Record<string, never>; result: RegistrySnapshot };
  'models.connection.save': { args: ConnectionInput & { apiKey?: string }; result: { id: string } };
  'providers.save': { args: QuickTextInput | { vision: QuickVisionInput | null }; result: ProviderSettings };
  'agent.start': { args: AgentStartInput; result: PublicRun };
}
```

`apiKey` 只存在于上述保存调用的参数里，响应类型只有 `hasKey` 与 `credentialStatus`。`QuickTextInput` 不包含 `supportsVision` / `enableVision`。

智能体端口。用方法代替通用 `route`。

```ts
export interface AgentPort {
  snapshot(projectId: string): Promise<StudioSnapshot>;
  readSource(projectId: string, shotId: string): Promise<SceneSource>;
  saveSource(projectId: string, shotId: string, expectedRevision: number, source: SceneSource): Promise<StudioSnapshot>;
  commit(projectId: string, expectedRevision: number, project: VideoProject, sources: Record<string, SceneSource>, label: string): Promise<StudioSnapshot>;
  capture(projectId: string, frame: number, signal: AbortSignal): Promise<{ bytes: Uint8Array; mime: string; frame: number; shotId: string }>;
  vision?: VisionProvider['describe'];
  importImage(projectId: string, name: string, bytes: Uint8Array, mime: string): Promise<{ id: string; name: string }>;
  importAudio(projectId: string, name: string, bytes: Uint8Array, mime: string): Promise<{ id: string; name: string }>;
  capabilities(): Promise<{ roles: (VisionRole | MediaRole)[]; director?: string }>;
}

export interface AgentTool {
  name: string;
  description: string;
  parameters: JsonSchema;
  risk: 'read' | 'write' | 'plan' | 'cost' | 'export';
  requires?: (VisionRole | MediaRole)[];
  estimate?(args: Record<string, unknown>): number | null;
  run(args: Record<string, unknown>, ctx: { runId: string; projectId: string; signal: AbortSignal; port: AgentPort }): Promise<ToolResult>;
}
```

工程提交保持现有语义：`expectedRevision` 不匹配则拒绝；成功后 revision 单调增加；undo 是新 revision，不把版本号拨回去。

偏好文件是数据目录里的 `ui-preferences.json`，模式 `0o600`，原子替换。字段只有 `version` 与 `theme`。它不进工程、不进 `.yingliu`、不进注册表。

### 2.4 视觉：同一布局，两套主题

选定方案，不再平行设计第三种皮肤。

| | L1 纸感 `paper` | L2 暗房 `darkroom` |
| --- | --- | --- |
| 场景 | 默认。阅读简报、改字、对字幕 | 长时间剪辑、看预览暗部 |
| 底 | 暖纸色，低对比分隔线 | 近黑蓝灰，避免纯黑大面 |
| 文字 | 墨色正文，次级信息降一档 | 冷白正文，次级用灰蓝 |
| 强调 | 一种低饱和青绿，主按钮与当前镜头共用 | 同色相，提高在暗底上的亮度 |
| 布局 | 顶栏、左对话、右工作台、底dock。断点与现在的容器查询一致 | 同一 DOM，不换网格 |

实现要点：

- 令牌写在 `tokens.css` 的 `:root[data-theme="paper"]` 与 `:root[data-theme="darkroom"]`。组件只使用 `--bg`、`--panel`、`--text`、`--muted`、`--line`、`--accent`、`--danger`。
- 工作台不再用第二套前缀去覆盖外壳。插件版 `.vs-studio[data-scheme=light]`（`yingliu-video-studio` `src/client/styles.css`）可以当令牌草稿，外壳必须吃同一组变量。现在 `app.css` 把外壳写死，所以只改 `data-scheme` 不够。
- 切换调用 `ui.preferences.set`，成功后设置 `document.documentElement.dataset.theme` 并更新控制器。刷新后 `ui.preferences.get` 恢复。插件是宿主 `theme/change` 推入 `setScheme`；独立应用用偏好接口扮演那个宿主，不读取系统主题作为强制值（可在决策里选「跟随系统」为附加项）。
- 图标继续用现有描边 SVG（`src/client/ui.tsx` 的 `AppIcon`）。不引入组件库。
- 尊重 `prefers-reduced-motion`。对比度按正文与底色一对来检查，两套主题都要过。

CSP：样式文件仍由 `/app.css` 提供，`style-src 'self'`。新界面不用 `style={{}}` 注入颜色。现有 CSP 含 `style-src 'unsafe-inline'`（`src/app/ui-server.ts`），因为历史内联样式和 LiteGraph。新仓库第一阶段保持这条不变，避免为了「更严」改动安全策略；去掉 `unsafe-inline` 单独立项，确认画布不再依赖内联样式后再收紧。不新增 `unsafe-eval`，不放宽 `default-src`、`script-src`、`connect-src`。

---

## 3. 技术选型

每一项都是取舍，不是清单式「全部留下」。

### Electron：留下

| 方案 | 得到 | 失去 |
| --- | --- | --- |
| 继续 Electron 44 | 三平台已有打包与验收；`safeStorage` 与钥匙环行为有测试（`tests/native-secrets.test.ts`）；场景用 site-per-process 隔离，`docs/ARCHITECTURE.md` 已写明验收查 PID | 安装体积大（P0 报告里 Electron 包约 315 MB，不含用户自备的 Chrome/FFmpeg） |
| 换成 Tauri 2 | Linux 上 Node SEA 体积约小 56% | 同报告：Linux 空闲内存约 +46%，macOS/Windows 内存未测，媒体闭环与真实钥匙环迁移未完成。换壳会把重构从「架构」变成「再做一遍桌面」 |
| 只做浏览器 | 少一个壳 | 密钥无法进系统钥匙环（现在浏览器模式只放进程内存）；大文件与工程包路径入口依赖桌面 |

推荐：**新仓库默认壳仍是 Electron**。体积用打包裁剪处理，不靠换 WebView。Tauri 代码不迁入。

### LiteGraph：留下，继续关在适配器后面

`src/shared/types.ts` 的 `GraphEditorAdapter` 和 `src/client/graph-adapter.ts` 已经把库关在界面内。图表示线性镜头主链和素材绑定，不是模型工作流执行器（`docs/ARCHITECTURE.md`）。

自绘画布能去掉一个依赖、更好跟令牌走，但命中测试、连线、分组都要重做，而用户要改的是外壳气质，不是节点交互模型。推荐保留 LiteGraph 0.17.x。节点绘制颜色改为读 CSS 变量的计算值，避免画布永远是深色（现在 `onDrawForeground` 写死 `#192a37`、`#79d8c0`）。

### esbuild：留下

UI 白名单只有一个脚本和一个样式（`src/app/ui-server.ts` 的 `files` 表）。`scripts/build.mjs` 用 esbuild 打出单个 `app.js`，目标 `chrome120`，与 Electron 44 的 Chromium 匹配。

Vite/webpack 的默认产物是带哈希的多文件，会直接打破白名单，除非同时改服务器并放宽路径。收益主要是开发时热更新。推荐新仓库仍用 esbuild；开发体验用 `esbuild --watch` 加手动刷新。不把 CSS 拆成第二个需要放行的 URL 以外的文件：令牌和组件样式打进同一个 `/app.css`。

### 样式：合成一套

| 方案 | 取舍 |
| --- | --- |
| 继续 `yl-` + `vs-` | 能逐页改色，但两套断点、两套按钮、主题永远补不齐。这是现状，不采用 |
| CSS Modules / Tailwind | 要改构建和 CSP 策略的讨论成本高；Tailwind 运行时或任意类会推着放宽 `style-src`。不采用 |
| 一份手写 CSS，语义令牌，`data-theme` | 与插件版单一 `styles.css` 同路，又满足四个静态 URL。类名统一为 `yl-`（产品外壳） |

推荐第三种。插件的 `data-scheme` 与变量名可作迁移对照，不把 `--dsw-*`（DSH 宿主变量，见插件 `VideoCard` 的内联样式）带进独立应用。独立应用也不学习插件把 CSS 塞进 `<style>` 标签的做法，那是 DSH 没有静态文件白名单时的接法，会依赖 `unsafe-inline`。

### 状态：控制器留下，页面状态拆开

`StudioController` + `useSyncExternalStore` 在本仓库和插件里都是同一模式（插件 `src/client/index.tsx`）。它拥有工程草稿、revision、未保存检查，这不该交给通用状态库。

不引入 Redux、Zustand 或 React Router。`App.tsx` 里的对话、库、对话框拆成三个小模块，各自本地 state，跨页事实只留在控制器和服务器。主题不放在 React state 里当唯一副本：服务器偏好是事实，DOM `data-theme` 是投影。

### 测试

| 层 | 做法 | 取舍 |
| --- | --- | --- |
| 契约 | 继续 `node --test` + `tsx`，不换 Jest/Vitest | 84 个测试文件已经是 CI 的事实标准。换运行器要重写夹具，不提高对 CAS 和回执的信心 |
| 先搬的测试 | 存储与 revision、凭据不落盘、provider v3 迁移、文本请求无图片、场景隔离、智能体回执与审批 | 这些锁定「不能改错」的行为 |
| UI | 现有 `tests/controller.test.ts`、`tests/credential-ui.test.ts` 的方式：不启动浏览器，断言控制器与「响应里没有密钥」 | 组件像素测试成本高，主题用 DOM 契约测：两套 `data-theme` 下结构相同、偏好往返、偏好 JSON 不含 `apiKey` |
| 验收 | Playwright 脚本保留为 `verify` / `verify:editor`，mock 网关，不打付费 API | 与现在相同：mock 通过不等于模型质量验收 |

三平台 CI 保留 ubuntu / windows / macos 的类型检查、测试、构建。原生媒体验收仍要求本机 Chrome 与 FFmpeg，缺工具记失败而不是跳过当通过（与 `native-acceptance` 的口径一致）。

### 语言与格式

新代码用正常换行和 TypeScript 严格模式，不再把一个函数写成一行。`strict` 已开启（`tsconfig.json`）。共享类型从 `src/shared/types.ts` 拆到 `domain/`，并删掉 `TtsSettings.apiKey`。

---

## 4. 迁移路线

新仓库空目录开始。旧仓库冻结功能、只修缺陷，直到新仓库 P2 能读入旧数据。阶段按可独立验收切，不按日历。

### P0 — 壳、主题、空工程边界

交付：Electron 窗口加载单页；纸感与暗房同一布局（顶栏 + 左栏 + 工作台占位）；`ui.preferences` 读写 `ui-preferences.json`；静态资源只有四个路径；CSP 与现在 `ui-server.ts` 同级。

验收：

- `ui.preferences.set` 后刷新，主题仍在；文件内容只有 `version` 与 `theme`。
- 两套主题的主要区域 DOM 结构一致（同一组件树）。
- 故意请求 `/secrets` 或其他路径得到 404；无令牌的 POST `/api/*` 得到 403。
- 响应头仍是 `default-src 'self'`，且没有比基线更宽的指令。
- ubuntu / windows / macos 上 `typecheck`、`test`、`build` 通过。
- 数据目录里不出现密钥样例。

### P1 — 工程可以手改

搬入：domain、ProjectStore、队列、图适配器、源码编辑、预览运行时、`.yingliu` 导入导出。此阶段没有模型调用。

验收：

- 新建工程为 schema 2；能打开旧 schema 1 并在保存时写成 2，镜头 ID 不变。
- 过期 `expectedRevision` 被拒绝；undo/redo 产生新 revision。
- 导入 v1 与 v2 工程包，包内无对话、无密钥。
- 场景页没有 preload，CSP 不允许外联脚本；编辑器与场景不同源。
- 图上增删镜头、改时长，预览帧号与整数帧一致。

### P2 — 文本与多模态分开接入

搬入：注册表、两种 Chat 端口、快速配置、模型中心、凭据端口、`provider.json` 迁移器。检查连接只访问模型目录，不提交生成（保持现在 `ProviderManager.check` 的口径）。

验收：

- 夹具：v3 `provider.json`（含 `vision: null` 与含 vision 对象两种）加上 v1 `model-registry.json`，迁完后 director/scene 指向文本连接，vision 只在有 vision 对象或注册表角色时存在。
- 迁完后的注册表与偏好文件用正则扫描不到 `sk-` 形态或原始密钥；密钥仍能用原 `credentialRef` 从凭据端口读出。
- 文本端口的类型与运行时都拒绝图片内容。
- 未配置多模态时，对话与 `visual_review` 不发送像素。
- 快速保存文本接口不会把 `yingliu.custom-vision.api-key` 复制到文本连接（本分支 `1706037` 已修的行为，用测试锁住）。

### P3 — 智能体、生成、导出

搬入：AgentRuntime、工具、工作流工具、媒体任务、FFmpeg 导出、CLI。讨论模式是同一个 runtime 的 `read` 策略，不再保留 `ConversationService` 第二循环。

验收：

- mock 网关下：工具循环、审批拒绝、重启后续跑、成功回执不重复提交、预算上限。
- `export_mp4` 默认要批准；费用未知的 cost 工具要批准。
- `verify` 在隔离数据目录打出可解码的短 MP4；不请求付费供应商。
- CLI 退出码与 `docs/CLI.md` 一致（0/2/3/4/5/6/7/8），`--allow-paid` 与 `--max-cost` 仍是付费闸门。

P3 之后才考虑：素材垃圾回收、多人编辑、节点市场。这三件现在 `README.md` 已明确不做。

### 与旧数据的兼容

默认数据目录继续分开：旧应用是系统 appData 下的 `yingliu-agent`，新应用用新目录名（实现时再定，例如 `yingliu-agent-next`）。不自动扫描旧目录。用户显式选择「导入旧数据目录」或设置 `YINGLIU_DATA_DIR` 时才迁移。`YINGLIU_PROJECTS` 语义保留。

| 旧文件 | 处理 |
| --- | --- |
| `provider.json` version 3 | 读 `config` → 文本连接 `custom`，角色 director + scene，引用 `yingliu.custom-model.api-key`。`vision` 为对象 → 连接 `custom-vision`，角色 vision，引用 `yingliu.custom-vision.api-key`。`vision: null` 或字段缺失 → 不创建视觉连接。`mode: demo` 只在测试夹具里承认，导入用户目录时忽略并记一条说明。 |
| `provider.json` version ≠ 3 | 与现 `ProviderManager.initialize` 相同：只迁文本，并卸掉绑在文本模型上的 vision 角色。不猜测旧的 `enableVision` 就是一把独立钥匙。 |
| `model-registry.json` version 1 | 原样载入后，用上面的快速槽覆盖同 id（`custom`、`custom-vision`、`custom-model`、`custom-vision-model`）的连接与模型，避免两份快照分叉。其他用户自建连接保留，它们的 `credentialRef`（`yingliu.models.<id>.api-key`）不变。 |
| 迁完写回 | 注册表升为 version 2，仅增加 `slots: { textConnectionId, visionConnectionId: string \| null }`，便于 UI 找到快速配置。`provider.json` 改写为 `{ "version": 4, "migrated": true }`，不含 `config`。迁移失败则两份都不改，按旧文件只读打开并提示。 |
| `credentials.encrypted.json` | 不重加密、不导出明文。新壳用同一 `CredentialPort` 按原引用解密。换了操作系统钥匙环后端时走现有 `src/migration/credential-migration.ts` 的日志与回滚，仍只用引用。 |
| `tts.json` | 读入时丢弃 `apiKey` 字段。语音密钥只认 `YINGLIU_TTS_API_KEY`。 |
| 工程目录、`.yingliu` v1/v2 | P1 可读。写回 schema 2。不改镜头 ID、相对路径、素材哈希。 |
| `agent-runs/`、`agent-data/stories`、`ledger` | P3 按现有 version 1 读取。读不懂则隔离该文件并保留原件，不猜测着改工程。 |
| 对话记录 | 可选导入。不参与工程包。 |

密钥迁移的验收夹具使用假密钥，与 `tests/p0-credential-migration.test.ts` 一样。

---

## 5. 风险与待决问题

### 风险

| 风险 | 表现 | 控制 |
| --- | --- | --- |
| 双源迁移丢角色 | 用户在模型中心绑过的 director 被快速槽覆盖 | version 2 只覆盖 `custom` / `custom-vision` 这两个保留 id；其余连接不动。覆盖前把旧注册表复制到 `model-registry.v1.bak.json`（仍无密钥） |
| 文本模型被塞进图片 | 类型放宽或工具直接组 HTTP | `TextProvider` 的消息类型没有图片；再加一条测试，请求体序列化结果不含 `image_url` |
| 主题只换了工作台 | 重演 `app.css` 覆盖 | 验收要求外壳背景来自变量，纸感与暗房的计算样式不同，DOM 层级相同 |
| 收窄 `AgentPort` 时漏掉工具 | `generate_*`、`export_mp4` 编译失败 | P3 按 `src/agent/tools.ts` 的工具表逐项移植，缺端口就补方法，不恢复通用 `route` |
| 场景沙箱在重写时被放松 | 模型生成的页面拿到 Node 或凭据 | P1 把 `tests/p0-scene-isolation.test.ts` 的断言原样搬来：无 preload、CSP、跨源 |
| CSP 为了字体或主题被放宽 | 引入在线字体或 CSS-in-JS | 字体用系统字体栈（现有 `PingFang SC` / `Microsoft YaHei`）。不加载第三方样式 |
| 新旧应用同时打开同一工程 | 锁语义不一致 | 新应用沿用数据目录与工程根的所有权锁（`src/app/ownership.ts`）。导入是副本，不是原地共写 |
| 线数很少但逻辑很密，移植时看漏分支 | `model.ts`、`application.ts` 的单行函数 | 移植以测试为清单，不按「重写一遍看起来一样」手工抄 |

### 需要你拍板的问题

**1. 新仓库与旧仓库的关系**

- A. 新目录新 Git 历史，旧仓库只读到 P2 验收完再归档。
- B. 在本仓库里大改，保留 git blame。
- 推荐 **A**。你已经决定新开仓库；本仓库的历史对 blame 帮助有限，因为核心文件是压缩写法。许可证保持 GPL-3.0-only，NOTICE 写明源自 yingliu-agent / yingliu-studio。

**2. 默认主题**

- A. 首次启动纸感（L1）。
- B. 首次启动暗房（L2），与今天 `index.tsx` 的 `setScheme('dark')` 一致。
- C. 首次跟随 `prefers-color-scheme`，之后以偏好文件为准。
- 推荐 **A**。纸感是你选定的主视觉；暗房作为同布局的第二态。跟随系统可以放在偏好里做可选项，不作为出厂默认，避免「没打开过设置，界面却随系统跳变」。

**3. 对话面板是否在 P3 前就接上智能体**

- A. P0–P2 工作台只保留手工编辑，对话入口显示「尚未接入」。
- B. P2 结束后用只读讨论打通文本端口，制作工具留到 P3。
- 推荐 **B**。文本端口的验收需要一条真实 UI 路径；制作、计费、导出仍等到回执和审批测试齐了再开。

**4. 旧 `provider.json` 在迁移成功后**

- A. 改写为 version 4 的迁移标记，删掉其中的 `config` / `vision`。
- B. 保留 v3 文件永远双写。
- 推荐 **A**。双写就是现在的债。标记文件让旧版本应用打开时能明确拒绝，而不是静默用过期快照。密钥本来就不在这个文件里。

**5. 类名前缀**

- A. 全部改为 `yl-`。
- B. 工作台继续 `vs-`，外壳 `yl-`，只统一变量。
- 推荐 **A**。前缀分裂是两套皮肤的入口。变量统一而类名不统一，覆盖规则还会长回来。

**6. 节点图**

- A. 继续 LiteGraph，颜色改读主题。
- B. P1 就换成自绘列表 + 时间线，去掉图。
- 推荐 **A**。图是现有手工编辑的主界面，换掉它会把 P1 从「存储与预览」撑成产品重做。若你之后想要更轻的分镜，可以在适配器后加第二种视图，而不是先删库。

**7. Tauri**

- A. 新仓库不包含。
- B. 把 `src-tauri` 作为可选实验一并拷贝。
- 推荐 **A**。决策记录用一页文档引用 `docs/p0/REPORT.md` 的结论即可。实验壳和产品壳放在一个仓库里，会再次出现「哪一个才是默认」的问题。

**8. 数据目录**

- A. 新应用名对应新目录，提供一次导入。
- B. 直接复用 `yingliu-agent` 数据目录。
- 推荐 **A**。复用目录意味着未发布的迁移器和仍在运行的旧应用会抢锁、抢 `provider.json`。导入在副本上做。

---

## 6. 不在本次重构里做的事

- 不改 PR #9 的产品决定：默认 OpenAI、文本与多模态两套配置、两把钥匙。
- 不把 DSH 插件运行时嵌进来。插件只提供接法。
- 不放宽 CSP，不把密钥写入仓库样例、工程或偏好。
- 不在本仓库改业务代码、不开 PR、不建远程新仓库。新仓库由你按本方案另建。
