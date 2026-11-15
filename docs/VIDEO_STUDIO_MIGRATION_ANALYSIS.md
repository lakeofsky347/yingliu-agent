# 插件后端与 DSH 能力迁移分析

本文只做梳理和方案。不改业务代码，不改 `docs/REFACTOR_PLAN.md` 的已定条文。对照日期 2026-11-15。

基线：

| 仓库 | 位置 | 提交 | 许可证（包声明） |
| --- | --- | --- | --- |
| 本仓库 yingliu-agent | 分支 `cursor/refactor-plan-293f` | `6526005` | GPL-3.0-only |
| 插件 yingliu-video-studio | `main`，0.8.0 | `c39ead740fe7557a5171bc9022df1b53c3cdd291` | GPL-3.0-only |
| 重构壳 yingliu-agent2 | `main`，P0 | `07ed7c5c7acdb303ab3187065a16f6731b95336d` | GPL-3.0-only |
| 识图桥 dsh-vision | `main`，0.1.0 | `79f3ecb7af753a723156426629b7762060be9453` | MIT |

插件 `SOURCE.json` 写明：0.8.0 合并基线是 `0aa5e3c`；2026-11-11 选择性迁移的供体是本仓库 `ef3fc82`（当时 1.1.0），模块 M01–M07。此后两边各自继续。迁回去不是整仓覆盖，而是把插件后来多出来的领域能力接回独立应用，同时保留本仓库在供体之后加上的智能体、双槽模型和安全边界。

`docs/REFACTOR_PLAN.md` 原先写「不引入 DSH、cordis」。2026-11-15 已收窄为：不引入运行时，可以移植不依赖宿主的领域模块。代码在本仓库 `cursor/refactor-plan-293f` 原地替换。已定条目见第 10 节。业务代码等 chen 确认本文的分阶段计划后再改。

硬约束贯穿全文：API Key 只进凭据服务；工程、注册表、偏好、日志和本文都不出现密钥。不读取其他应用的凭据文件。CSP 维持 `default-src 'self'`，不放宽。

没有对 `workflows/service.ts`、`store.ts`、`renderer.ts` 做逐行 diff。下面的「已有 / 缺失」按公开接口、类型和文件是否存在来判断。这三个大文件里还可能有未列出的行为差。本次没有跑两边的测试，也没有调用付费供应商。

---

## 1. DSH 在插件仓库里具体指什么

DSH 是 DeepSeek Harness：一套用 cordis 组装的宿主。插件不是独立进程。`package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`，里面只插入一行插件：

```yaml
- insert:
    - id: video-studio
      name: yingliu-video-studio
      config: {}
```

服务端入口是 `src/host/index.ts` 的 `apply(ctx)`。`inject` 为 `connection`、`llm`、`tools`、`jobs`、`attachments`、`sessionController`。客户端入口是 `src/client/index.tsx` 的 `apply(ctx)`，注入布局、主题、会话和工作区槽位。启动前 `src/shared/host-contract.ts` 的 `assertHostContract` / `assertClientContract` 只检查方法在不在，不看宿主版本号。说明见 `docs/COMPATIBILITY.md`。

cordis 在这里是依赖注入和插件挂载（`ctx.effect`、`ctx.get`、`ctx.on`），不是视频业务。业务在 `ProjectHub` 和 `StudioService`。

`dsh-vision` **不是** yingliu-video-studio 的依赖。插件源码里没有引用这个包。它是另一个 cordis 插件：在宿主 `llm/stream` 瀑布上，把纯文本模型收到的图片改写成文字描述。见第 3 节。

插件消费的宿主服务，类型写在 `src/host/platform.ts`，声明补在 `types/dsh-session.d.ts`、`types/dsh-runtime.d.ts`：

| 服务 | 插件实际调用 | 文件 |
| --- | --- | --- |
| `connection.fetch.register` | 为每个端点注册 `POST /api/video-studio/<endpoint>`。请求体必须是 `{type:'client-request', rpcId, method, payload}`，响应用 `{type:'server-response', rpcId, result}` | `src/host/index.ts` |
| `llm.listProviders` / `listModels` / `resolveModelInfo` / `stream` | 会话里的文本与看图。流式块是 `{type, text?, reason?}`。密钥留在宿主，插件不读取宿主 LLM 的密钥 | `src/host/platform.ts`、`src/host/service.ts`（`catalog`）、`src/host/generator.ts`、`src/host/project-hub.ts`（工作流文本） |
| `credentials`（`ctx.get('credentials')`） | `resolve` / `set` / `unset` / `describe`。引用必须匹配 `^DSH_VIDEO_STUDIO_[A-Z0-9_]+$`，否则拒绝 | `src/host/platform.ts` 的 `modelSecrets` |
| `tools.register` / `defineTool` | 向宿主会话注册 8 个工具 | `src/host/session-tools.ts` |
| `jobs.start` | 长任务登记为 kind `video` 的宿主 Job。`job_kill` 只停本地等待，不保证取消云端订单 | `src/host/session-tools.ts` |
| `attachments.readImage` / `fileHostPath` | 把会话图片或文件附件导入工程。图片引用是 `ImageAttachmentRef`，文件引用是 `FileAttachmentRef` | `src/host/session-tools.ts`、`types/dsh-session.d.ts` |
| `sessionController.list` / `projections` | 会话目录、父子会话、子代理继承工程 | `src/host/platform.ts`、`src/host/project-hub.ts` |
| 客户端 `theme.getTheme`、`theme/change` | 把宿主浅色/深色推进 `controller.setScheme` | `src/client/index.tsx` |
| 客户端 `slots` / `layout` / `sessions` / `workspaces` / `locale` | 侧栏面板、工具卡片、会话列表、中英案 | `src/client/index.tsx`、`src/client/session-host-adapter.ts` |
| `effect` | 注册与卸载路由、工具和样式 | `src/host/index.ts`、`src/client/index.tsx` |

客户端把整份 `styles.css` 塞进 `<style data-plugin="dsh-video-studio">`。这是宿主没有静态文件白名单时的接法，依赖页面允许内联样式。独立应用不能照搬。

凭据边界：媒体密钥的引用形如 `DSH_VIDEO_STUDIO_MODELS_` + 数据目录与连接 id 的 SHA-256 大写十六进制 + `_API_KEY`（`src/host/project-hub.ts`）。配音密钥引用是 `DSH_VIDEO_STUDIO_TTS_API_KEY`（`src/host/service.ts`）。`tts.json` 写入前会删掉 `apiKey`。快照里的 `tts.apiKey` 置为 `undefined`，只返回 `ttsConfigured`。插件代码不打开其他应用的凭据文件。宿主凭据服务本身是整个 DSH profile 共用的；前缀检查是插件自己的过滤器，不是操作系统隔离。

---

## 2. 插件后端能力盘点

端点表在 `src/host/index.ts`。路由实现主要在 `src/host/project-hub.ts` 的 `route`，单工程逻辑在 `src/host/service.ts` 的 `rpc`。

### 2.1 模型注册、连接与凭据

| 能力 | 行为 | 路径 |
| --- | --- | --- |
| 注册表 | `RegistryState.version = 1`。文件名 `models.json`，不叫 `model-registry.json`。连接、模型、角色。参数键拒绝密钥类名字的规则在注册表实现里 | `src/models/contracts.ts`、`src/models/registry.ts`、`src/host/project-hub.ts` |
| 协议 | `chat-completions`、`images`、`gemini-image`、`video-gateway`、`openai-videos`、`kling-video`、`minimax-video`、`volc-video`、`dashscope-video`、`gemini-video`、`speech`。没有 `async-task`，没有 `music` / `sfx` 角色 | `src/models/contracts.ts`、`src/models/protocols.ts` |
| 官方适配器 | 按协议组请求、轮询、取消。`artifactAuth` 只在下载时带鉴权头 | `src/models/adapters/official.ts`、`src/models/adapters/media.ts` |
| 能力预检 | 操作、参考图角色、时长、比例。`verification.realProviderTested` 固定为 `false`，`checkedAt` 为 `2026-11-06`。文档声明不等于真实账号验收 | `src/models/capabilities.ts`、`docs/MODEL-CAPABILITIES.md` |
| 端点 | `models.list` / `connection.save` / `connection.remove` / `model.save` / `model.remove` / `role.bind` / `check`，以及 `media.capabilities` | `src/host/index.ts`、`src/host/project-hub.ts` |
| 两套模型来源 | 看图和部分文本走宿主 `ctx.llm`（会话当前 provider/model）。生图、生视频、注册表语音走 `models.json`。工作流把会话模型当作 `textRoute` 传进来 | `src/host/session-tools.ts`、`src/host/project-hub.ts`、`src/host/generator.ts` |
| 凭据 | 只经 `modelSecrets`。保存连接时的 `apiKey` 只活在这次调用里，写入宿主凭据服务 | `src/host/platform.ts`、`src/models/registry.ts` |

`src/shared/types.ts` 的 `TtsSettings` 仍有可选 `apiKey`。运行时从 `tts.json` 删除它，但类型允许它出现在设置形状里。和本仓库同一类口子。

### 2.2 工程库 project-hub

| 能力 | 行为 | 路径 |
| --- | --- | --- |
| 多工程 | 一个工程一个 `StudioService`。索引文件 `sessions.json`，version 2：`projects` + `bindings`。读到 version 1 的 `sessions` 映射会升到 v2 | `src/host/project-hub.ts` |
| 会话绑定 | `bind` / `bindSession` / `unbindSession` / `focus`。子代理可继承上级工程；`forceNew` 才新建 | `src/host/project-hub.ts`、`src/host/session-tools.ts` |
| 工程操作 | `catalog`、`current`、`create`、`open`、`save`、`import`、`list`、`rename`、`duplicate`、`archive`、`restore`、`history`、`undo`、`redo`、`source`、`saveSource`、`restoreSource`、`apply`、`inspect`、`preview`、`generate`、`export`、`cancel`、`tasks`、`jobs`、`retry`、`job.retry`、`environment`、`reveal` | `src/host/index.ts`、`src/host/service.ts` |
| 存储 | 工程 schema 当前为 3。`.studio` 下不可变版本、原子 head、`expectedRevision`。公开写入口缺版本返回 `REVISION_REQUIRED`，过期返回 `REVISION_CONFLICT` | `src/core/index.ts`、`src/host/store.ts`、`src/shared/types.ts`、`docs/API.md`、`docs/RELEASE-0.8.0.md` |
| 制作策略 | `productionPolicy`：`unresolved` / `code_animation` / `model_video` / `hybrid`。混合按镜头授权。智能体调用 `production.set` 会被 `PRODUCTION_CONFIRMATION_REQUIRED` 拒绝，只能人在工作台确认。普通 `save` 不能改策略，也不能改受保护的扩展字段 | `src/core/production-policy.ts`、`src/host/project-hub.ts`、`src/host/service.ts` |
| 风格库 | `styles.json`。`styles.list` / `styles.save` / `styles.delete`。与工程分开 | `src/host/project-hub.ts`、`src/client/style-import.ts`、`src/client/StyleLibrary.tsx` |

### 2.3 导演文档

工程扩展字段 `extensions.directorDocument`，文档自己的 `schemaVersion` 是 1，和工程 schema 3 不是同一个版本号。

| 能力 | 行为 | 路径 |
| --- | --- | --- |
| 计划形状 | 影片类型、角色、节拍、世界坐标、表演、对白、镜头事件、验收条件。批准只表示创作内容，不授权付费、上传或混合制作 | `src/director/contracts.ts`、`src/director/document.ts`、`src/director/rules.ts`、`src/director/index.ts` |
| 端点 | `director.rules` / `validate` / `compile` / `patch`；`director.document.get` / `save` / `approve`。带会话调用者时，`approve` 返回 `DIRECTOR_APPROVAL_REQUIRED` | `src/host/project-hub.ts`、`src/host/service.ts` |
| 工作流快照 | 协作流程复制已批准计划，不要求上传无关镜头的角色图 | `src/workflows/director-plan.ts`、`src/workflows/service.ts`、`docs/DIRECTOR-CONSTRAINTS.md` |

### 2.4 任务与生成管线

| 能力 | 行为 | 路径 |
| --- | --- | --- |
| 媒体任务 | `media.generate` / `list` / `get` / `cancel` / `pause` / `retry` / `apply`。公开任务把 `credentialRef` 清空。`retry` 只恢复查询，不重新下单。`apply` 要 `expectedRevision`，失败保留候选 | `src/jobs/media-tasks.ts`、`src/jobs/contracts.ts`、`src/jobs/download.ts` |
| 能力闸门 | 生成前走 `getMediaCapabilities`。未知原生音轨按失败关闭，不把「未知」当成「有声音」 | `src/models/capabilities.ts` |
| 工作流 | `workflows.run` / `list` / `get` / `preview` / `pause` / `retry` / `apply`。文本提交前写耐久标记；不能证明外部结果时保持 uncertain，不重复请求 | `src/workflows/service.ts`、`src/workflows/contracts.ts`、`docs/MIGRATION-20261111.md` |
| 导入回执 | 固定输入 + `requestId`。只有存储证明尚未写入的冲突才有限重试 | `src/host/local-import.ts`、`src/host/service.ts`、`src/shared/durable-file.ts` |
| 本地质检 | 导出前对冻结版本抽样，最多 12 帧。结构硬失败阻止导出，`force` 不能绕过。历史成片各自保留报告 | `src/workflows/local-quality.ts`、`src/workflows/quality.ts`、`src/host/service.ts`（`quality.check` / `quality.last`） |
| 渲染 | 内容寻址的预览资源、每镜头独立 origin、首帧就绪 | `src/host/renderer.ts`、`src/runtime/browser.ts`、`docs/RENDERING.md` |
| 本地音效 | `tone` / `sweep` / `chime` / `noise` / `whoosh` / `click`，确定性 WAV，不走模型。端点 `audio.sfx` | `src/media/local-sfx.ts`、`src/host/service.ts` |
| 声音 | `audio`、`tts`。配音密钥只走凭据引用 | `src/host/audio.ts`、`src/shared/tts-capability.ts` |
| 媒体检查 | 导入与生成结果的容器检查 | `src/media/inspect.ts`、`src/media/video.ts` |

发布说明写明 M08–M12 不在 0.8.0：累计账本、费用试算、尾帧承接、显式配音对齐、一致性复核、再加供应商。这些在本仓库的智能体工具里已经有对应实现，见第 4 节。

### 2.5 会话工具（给宿主里的对话模型，不是本仓库的 AgentService）

`src/host/session-tools.ts` 的 `createSessionTools`：

| 工具 | 作用 |
| --- | --- |
| `video_director` | 规则、校验、编译、局部修改、读写导演文档。不能批准 |
| `video_workflow` | 在已确认的制作模式里跑协作流程 |
| `video_media` | 生成与任务生命周期。不接收 URL、密钥、请求头或路径 |
| `video_project` | 创建、打开、绑定、查看。不能自行改制作策略 |
| `video_update` | 把已讨论的分镜和源码写入工程。必须带 `expectedRevision` |
| `video_inspect` | 读规格、源码或某一帧。不改片 |
| `video_render` | 预览、检查、导出。默认丢给宿主 Job |
| `video_audio` | 导入、剪辑、配音、`local_sfx` |
| `video_quality` | `check` / `last`。不代替人审，不调用视觉生成 |

工具卡片只挂了 `video_project`、`video_update`、`video_inspect`、`video_render`、`video_audio`（`src/client/index.tsx`）。

### 2.6 导入导出与路径

工程包语义在宿主存储和 `docs/API.md`，不是本仓库的 `.yingliu` 归档器。复制工程会清掉执行请求身份，并把导演批准降为草稿（`src/host/store.ts`）。素材必须落在工程内 `assets/`，源码在 `shots/`。原子替换见 `src/host/atomic-rename.ts`、`src/host/directory-sync.ts`。用系统打开文件见 `src/host/file-opener.ts`，底层仍要宿主提供 `reveal`。

环境探测与 FFmpeg / 浏览器路径在 `src/host/tool-environment.ts`、`src/host/renderer.ts`。用户自备 Chrome 与 FFmpeg，包内不带这两个二进制。

---

## 3. dsh-vision 提供什么，和插件的关系

仓库 https://github.com/lakeofsky347/dsh-vision ，`main` @ `79f3ecb`。MIT。`package.json` 声明 `dsh.bundle`，`cordis.patch.yml` 插入 `id: vision`。

`src/index.ts` 的 `apply(ctx)`：

- 监听 cordis 事件 `llm/stream`。
- 请求里没有图片则原样放过。
- 路由模型的 `inputModalities` 含 `image` 则原样放过。
- 否则把图片块换成 `[用户附件图片的视觉描述]` 文本，再重新进入 `ctx.llm.stream`。
- 默认视觉路由 `provider: xiaomi`，`model: mimo-v2-omni`。可在 profile 的 patch 里覆盖。描述按 session 与附件 id 记忆化。视觉失败写成占位文本，不让主回合失败。
- 依赖 `@deepseek-ai/cordis`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/schemastery`。密钥仍在宿主 LLM 路由里，这个包的配置字段没有 API Key。

它和插件的 `vision` 角色不是同一条路。插件的 `vision` 是注册表角色，由工作流显式调用。dsh-vision 是宿主级瀑布，会改写任何纯文本会话的图片。本仓库的重构方案要求文本端口拒绝图片、看图走独立多模态端口。把 dsh-vision 嵌进来会绕开这条边界。

---

## 4. 和 yingliu-agent 当前实现逐项对比

本仓库当前树就是独立应用：Electron 壳、`127.0.0.1` HTTP、IPC、CLI。`src/host/platform.ts` 的 `HostContext.llm` 类型是 `src/app/contracts.ts` 的 `ProviderHost`，方法名和插件的 `ctx.llm` 很像，实现是本应用的 `ProviderManager`，不是 cordis 服务。

### 4.1 已有，且应保留本仓库的做法

| 项 | 本仓库 | 插件 | 结论 |
| --- | --- | --- | --- |
| 工程身份 | schema 1 读入、保存为 2。稳定 ID、有理数 FPS、整数帧、相对路径、`expectedRevision`、不可变版本 | 在同样契约上升到 schema 3，并强制制作策略 | 保留 2 的读取；写入是否升到 3 见第 10 节 |
| 写队列 | `src/host/service.ts`、`src/host/store.ts` | 同一模式，公开写入口更严格 | 保留。插件更严的错误码可以补上 |
| 模型注册表形状 | `model-registry.json`，version 1。角色含 `music`、`sfx`。协议含 `async-task` | `models.json`，version 1。角色到 `speech` 为止。协议是具名官方适配器 | 注册表文件和引用保持本仓库。官方协议作为适配器补进注册表，不换成 `models.json` |
| 文本 / 多模态分槽 | `provider.json` version 3。引用 `yingliu.custom-model.api-key` 与 `yingliu.custom-vision.api-key`。文本强制不能看图 | 文本看图走宿主会话模型，没有这份 v3 文件 | 保留分槽。不把宿主会话模型当成导演的唯一来源 |
| 凭据 | `src/app/secrets.ts`、`src/desktop/native-secrets.ts`（safeStorage）、`src/migration/credential-migration.ts`。界面只看 `hasKey` | 宿主凭据服务 + `DSH_VIDEO_STUDIO_*` | 保留本应用凭据。不读 DSH profile，也不读插件引用 |
| 媒体任务 | `src/jobs/media-tasks.ts`。`images` / `video-gateway` / `async-task`。不确定则不重投 | 同一任务机加上官方协议和能力预检 | 任务机保留。补协议和预检 |
| 工作流耐久 | `src/workflows/service.ts` 有成功回执和 uncertain | 供体迁出后又在插件侧加了制作策略和导演快照 | 耐久行为保留。导演快照按第 6 节适配 |
| 智能体 | `src/agent/service.ts`、`src/agent/tools.ts`。审批、回执、预算、账本 | 没有这套循环。会话工具交给宿主里的另一个模型 | 保留本仓库循环。不注册 `video_*` |
| M08–M12 | `generate_music`、`generate_sfx`、`frame_handoff`、`align_to_voice`、`consistency_review`、`agent.ledger` | 发布说明明确不做 | 留在本仓库。插件没有可迁的实现 |
| 本地音效算法 | `src/agent/synth.ts`，工具 `synthesize_sfx` | `src/media/local-sfx.ts`，端点 `audio.sfx` | 算法同类（六种 WAV）。缺的是工作台端点，不是公式 |
| 质检 | 智能体工具 `quality_check`，端点 `agent.qc` | 导出前 `local-quality`，和成片绑定，结构硬失败不能 `force` | 插件这份和导出绑定的报告本仓库没有同等端点 |
| 壳与安全 | Electron 44、场景分 origin、`src/sandbox/scene-worker.ts`、`src/app/ui-server.ts` 的 CSP | 跑在宿主页面里，样式内联注入 | 保留壳和 CSP |
| 导入导出包 | `src/app/archive.ts`，`.yingliu` schema 1/2，可带 `agent/story|ledger|qc` | 以工程目录和 `.studio` 为备份单位，复制时降级批准 | 包格式保留。打开插件 schema 3 目录要单独做 |
| CLI | `src/cli/main.ts`。密钥只通过环境变量名 | 无 | 保留 |

### 4.2 本仓库没有、插件有

| 能力 | 插件路径 | 独立应用里的空位 |
| --- | --- | --- |
| 工程 schema 3 与 `productionPolicy` | `src/core/production-policy.ts`、`src/core/index.ts`、`src/shared/types.ts` | `src/core/index.ts` 只认 1 和 2 |
| 导演文档、规则、编译、批准权在人 | `src/director/*` | 创作计划在 `src/agent/story.ts`，是另一份结构，批准进 sidecar，不是工程扩展 |
| 官方图像/视频协议与能力预检 | `src/models/protocols.ts`、`src/models/adapters/official.ts`、`src/models/capabilities.ts` | 本仓库是 `async-task` 模板（`src/models/adapters/template.ts`）加 `images` / `video-gateway` |
| 导出前本地质检与历史报告 | `src/workflows/local-quality.ts`、`quality.check` | `quality_check` 不把报告绑到某一次导出的成片文件 |
| 工作台本地音效端点 | `audio.sfx` | 只有智能体工具 |
| 风格库 | `styles.json`、`styles.*` | 无独立风格库文件 |
| 会话绑定、子代理继承工程 | `sessions.json` v2、`bindSession` | `src/host/project-hub.ts` 的索引是 `registry.json` version 1，`sessions` 是简单映射，没有 DSH 会话目录 |
| 宿主 Job、附件、工具卡片 | `src/host/session-tools.ts` | 无。长任务在应用进程内 |
| 插件多出来的端点 | `production.set`、`director.*`、`quality.*`、`audio.sfx`、`styles.*`、`media.capabilities`、`workflows.preview`、`bind` / `bindSession` / `unbindSession`、`job.retry` | `src/app/application.ts` 的 `ENDPOINTS` 没有这些名字 |

### 4.3 实现方式冲突

**进程。** 插件和宿主同一 cordis 进程，`apply` 挂路由。本仓库是 Electron 主进程加渲染进程，场景再开一个 origin（`src/app/ui-server.ts`、`src/host/renderer.ts`、`src/sandbox/scene-worker.ts`）。把 `apply(ctx)` 原样搬进来，独立应用就得先变成 DSH 宿主。

**存储。** 插件数据目录用 `models.json`、`sessions.json`、`styles.json`。本仓库用 `model-registry.json`、`provider.json`、`registry.json`，凭据在 `credentials.encrypted.json`。同名概念，文件名和版本号都不同。`sessions.json` v2 的 `bindings` 不能当成 `registry.json` 的 `sessions` 直接改名。

**Provider。** 插件导演文本默认就是当前 DSH 会话的 provider/model，注册表角色是另一条。本仓库导演和场景角色来自文本槽，视觉是另一把钥匙，生成角色再各用自己的 `credentialRef`。合并成「会话模型顺便当导演」会把文本和看图重新耦回去。

**凭据。** 插件引用前缀 `DSH_VIDEO_STUDIO_`，存在宿主凭据服务。本仓库引用是 `yingliu.custom-model.api-key`、`yingliu.custom-vision.api-key`、`yingliu.models.<id>.api-key`、`YINGLIU_TTS_API_KEY`，存在本应用 safeStorage。两套引用不能互相当作同一把钥匙。按本应用的约束，也不去读 DSH 的凭据库来「迁移密钥」。用户要在新应用里重新保存密钥。

**API。** 插件是带 rpcId 的信封，路径前缀 `/api/video-studio/`。本仓库是 `POST /api/<endpoint>`，头 `X-Yingliu-Token`，或 IPC `yingliu:call`（`src/desktop/main.ts`）。白名单是 `ENDPOINTS`。不增加一套信封。

**安全边界。** 本仓库 CSP 在 `src/app/ui-server.ts`：

`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: http://localhost:*; media-src 'self' http://localhost:*; frame-src http://localhost:*; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'`

`style-src` 里的 `unsafe-inline` 是现有基线。重构方案要求第一阶段维持，不放宽 `default-src`。插件的内联 `<style>` 和工具卡片不能成为放宽理由。场景页继续无 Node、无 preload、无凭据。

**工具名。** 重构方案已经定过：不注册 `video_project`、`video_update`、`video_inspect`、`video_render`、`video_audio`、`video_media`。插件这些工具的行为落到已有或计划中的端口：重试不重新下单在 `task_status`，采用失败保留候选在 `media_apply`，制作策略只能由人确认。

**许可证。** 见第 9 节。两边主许可证相同。冲突不在 GPL 文本，而在于要不要把 cordis 运行时链进发行物。

**运行时版本。** 插件 CI 用 Node 24，并安装 `@deepseek-ai/dsh` 的 `0.2.1-rc.2`、`latest`、`next`（`.github/workflows/platform-checks.yml`）。本仓库 CI 用 Node 22，不安装 DSH（`.github/workflows/platform-checks.yml`、`native-acceptance.yml`）。

---

## 5. 哪些能力依赖宿主，独立应用里怎么替代

| 插件能力 | 依赖 | 处置 | 理由与风险 |
| --- | --- | --- | --- |
| `apply`、`ctx.effect`、cordis patch、peer `@deepseek-ai/*` | 宿主进程 | **放弃运行时** | 独立应用已经有进程和路由。嵌进来等于把产品改成 DSH 插件，凭据落在 profile 共用服务，CSP 不再由本应用单独保证。风险是以后宿主改方法语义时，存在性检查发现不了（`docs/COMPATIBILITY.md` 自己写了这一点） |
| `connection.fetch` 信封 | 宿主 RPC | **用现有模块重写接法** | 端点语义可保留，传输用现有 POST + 令牌 / IPC。不新增 `/api/video-studio/` |
| `ctx.llm.stream` | 宿主已配置的聊天模型 | **用现有模块重写** | 文本走文本端口，看图走视觉端口。不调用宿主 LLM，也就不会碰到宿主替其他插件保存的密钥 |
| `credentials` | 宿主凭据服务 | **用现有模块重写** | `CredentialPort` / `NativeSecrets`。新连接继续 `yingliu.models.<id>.api-key`。不把 `DSH_VIDEO_STUDIO_*` 写进本应用，也不去解析旧引用 |
| `jobs.start` | 宿主任务视图 | **用现有模块重写** | 媒体任务和导出任务已经在进程内。进度走现有任务快照或智能体事件。不做 DSH Job 卡片 |
| `attachments.*` | 会话附件库 | **做适配层** | 独立应用的「附件」就是工程素材和用户选中的文件。导入仍进 `assets/`，记录素材 id。不读取 DSH 附件目录 |
| `sessionController`、会话绑定、子代理继承 | 宿主会话树 | **放弃** | 本应用没有 DSH 会话。工程选择用工程库。智能体运行用 `agent-runs`。把子代理继承搬进来没有对应对象 |
| `tools.register` 与 `video_*` | 宿主工具总线 | **放弃工具名，保留行为约束** | 行为挂到重构方案里的工具表。再注册一套名字会出现两个导演 |
| `theme.getTheme` | 宿主主题 | **用现有设计重写** | 偏好接口扮演「外部把主题推进界面」。见第 6 节 |
| 内联 `<style>` | 宿主页面 | **放弃** | 样式走 `/app.css` |
| schema 3、制作策略 | 不依赖宿主 | **直接移植领域模块** | 纯函数和工程字段。风险是旧应用写回 schema 2 会丢掉策略。需要版本闸门 |
| 导演文档 | 不依赖宿主 | **直接移植数据与校验，批准权留在界面** | 不要让模型调用 `approve`。和 `story` sidecar 的关系见第 10 节 |
| 官方协议适配器与能力预检 | 不依赖宿主。密钥仍只在调用期从凭据端口取出 | **直接移植适配器，接到现有注册表** | `capabilities.ts` 写明没有真实供应商测试。迁入后仍只做契约测试和 mock。风险是厂商接口在 `checkedAt` 之后变化，预检会把过时形状当成可用 |
| 导出本地质检 | 依赖现有渲染捕帧，不依赖 DSH | **直接移植，接到导出** | 和智能体 `quality_check` 并存时要定哪份能挡住导出。推荐导出只认这份硬失败 |
| `audio.sfx` | 不依赖宿主 | **用现有 `synth.ts` 接到音轨端点** | 避免两份合成器。以测试锁住六类 WAV 的有界参数 |
| 风格库 | 不依赖宿主 | **做适配层或后置** | 只是一份提示词列表。不进工程包。P3 之后再做也不阻塞成片 |
| 插件前端 | 依赖宿主槽位和 `vs-` 皮肤 | **放弃，按第 6 节重做** | 与纸感/暗房冲突 |
| dsh-vision 瀑布 | 依赖 cordis 与宿主 LLM | **放弃** | 与「文本端口拒绝图片」冲突。看图保持视觉端口。MIT 许可不能单独成为嵌进运行时的理由 |

直接移植的文件应去掉 `@deepseek-ai/*` import，改为本仓库类型。移植时保留两边 NOTICE 里已经记载的历史 MIT / Apache 声明。

---

## 6. 前端：后端能力要哪些界面，怎么套进纸感 / 暗房

不搬 `yingliu-video-studio/src/client`。那套类名是 `vs-`，主题是宿主推进的 `data-scheme`，样式整段注入。和本次设计相反。

视觉基线用 yingliu-agent2 `main` @ `07ed7c5` 已经落地的 P0：

| 设计点 | agent2 路径 |
| --- | --- |
| 令牌 | `src/ui/tokens.css`。`:root` 与 `:root[data-theme="paper"]`、`:root[data-theme="darkroom"]`。组件用 `--bg`、`--panel`、`--text`、`--muted`、`--line`、`--accent`、`--danger`。文件里还有工作台备用变量（`--side`、`--graph-*` 等），布局组件可以只用规定的七个 |
| 类名 | `src/ui/shell/shell.css`，前缀 `yl-` |
| 布局 | `src/ui/shell/Shell.tsx`：顶栏、左栏「导演」、右栏 `Workspace`。同一组件树，不按主题换网格 |
| 偏好 | `ui.preferences.get` / `set`，文件只有 `version` 与 `theme`。默认纸感。见 `docs/DECISIONS.md` |
| CSP | `src/api/csp.ts` 与本仓库 `src/app/ui-server.ts` 同一条，含基线里的 `style-src 'unsafe-inline'`，没有放宽 `default-src` |
| 对话栏 | P0 文案是「尚未接入」 |

agent2 的 `tokens.css` 比「只用七个令牌」多写了图形和表单变量。迁界面时，新组件若需要边框或图节点色，优先复用这些已经写在 `data-theme` 下的变量，不要在组件里写死十六进制。七个核心令牌仍然是主题对比度的验收面。

本仓库现有前端是两套皮：`src/client/styles.css`（`vs-`）和 `src/client/app.css`（`yl-`，外壳写死深色）。`src/client/index.tsx` 启动时 `setScheme('dark')`。替换方式沿用重构方案：外壳和工作台合成一套 `yl-`，旧文件在对应阶段退出默认构建，而不是再覆盖一层。

后端能力对应的界面，全部放进同一布局：

| 后端能力 | 界面 | 放在哪 | 主题做法 |
| --- | --- | --- | --- |
| 工程库、打开与归档 | 首页列表 | 右栏工作台的空状态 / 首页，替换 `ProjectHome` 的皮肤 | 只改类名和变量，交互保持 |
| 文本槽、视觉槽、模型中心、连接检查 | 设置层 | 顶栏入口打开的面板。密钥输入框的值不回显，只显示 `hasKey` 和凭据状态 | 面板用 `--panel` / `--line`，危险操作用 `--danger` |
| 制作策略 | 「制作要求」 | 工作台内一块，人才能提交 `production.set`。未确认时生成按钮不可用 | 不另做暗色皮肤 |
| 导演文档 | 计划稿 | 左栏导演区，在文本端口接通之后。批准是主按钮，和付费批准分开 | 左栏保持 `yl-chat` 宽度规则（agent2 在 1100px 收到 280px） |
| 分镜、源码、预览 | 工作台 | 右栏。LiteGraph 颜色读主题变量的计算值，按重构方案已定决策 | 图节点不要写死 `#192a37` |
| 媒体任务、采用候选 | 底栏或右栏任务列表 | 替换 `MediaPanel` / `TaskPanel` 的 `vs-` 标记 | 进度和错误只用令牌 |
| 音轨、本地六类音效、配音 | 声音区 | 替换 `AudioPanel`。本地音效标明不调用模型 | 与生成按钮视觉分开，避免看成付费操作 |
| 导出与本地质检 | 导出区 | 硬失败挡住导出。启发式条目用 `--muted`，硬失败用 `--danger` | 报告不引入第二套颜色 |
| 风格库 | 可后置 | 做的话放在制作要求旁边的列表，不进工程文件 | 同上 |
| 会话绑定、工具卡片、宿主侧栏 | 不做好 | 没有宿主槽位 | — |

替换顺序：先让 agent2 那套壳成为本产品的默认 UI（或继续在 agent2 里长功能，见第 10 节），再按块把 `src/client/App.tsx`、`Studio.tsx`、`controller.ts` 的行为迁到新组件。控制器里工程草稿、revision、未保存检查仍然要有，不引入新的状态库。旧 `vs-` 页面在对应块验收通过后不再打进 `app.js`。

P0 壳里的「尚未接入」保留到文本端口接通。制作策略、模型中心、任务和导出不要在壳阶段做空按钮。

---

## 7. 和 REFACTOR_PLAN、yingliu-agent2 的关系

2026-11-15 已定。重构方案里「不引入 DSH、cordis」收窄为下面两句，并已写回 `docs/REFACTOR_PLAN.md`：

- **不引入** cordis 进程、`cordis.patch.yml`、`@deepseek-ai/*` peer、DSH 凭据服务、DSH 会话、dsh-vision 瀑布、插件前端和 `video_*` 工具名。
- **引入** 不依赖宿主的领域行为：schema 3 制作策略、导演文档、官方协议适配器、能力预检、导出质检、工作台本地音效、更明确的 `expectedRevision` 错误码。

重构方案决策 1A 曾定为新仓库、新 Git 历史。同日的问题 1 不按当时的推荐，改为在本仓库 `cursor/refactor-plan-293f` 原地替换。agent2 `main` @ `07ed7c5` 不再作为产品落点。它的 P0 壳和主题可以参考或移植进本仓库。两个仓库都是 GPL-3.0-only。移植时在 NOTICE 写明来源，不把它的数据目录和未完成的后端占位一起当成产品。

下面的兼容约定按这个落点执行。

### 7.1 数据与工程

| 对象 | 建议 |
| --- | --- |
| 本仓库 schema 2 工程 | 继续读。保存时写成 schema 3，镜头 ID、相对路径、素材哈希不变。不自动改制作模式，缺省 `unresolved`，人确认前不能生成 |
| 插件 schema 3 目录 | 只读打开时保留 `productionPolicy` 和 `directorDocument`。不理解的扩展字段原样留下，不丢弃。写回前必须能完整验证这两块，否则拒绝写，避免用 schema 2 覆盖 |
| 插件 `sessions.json` | 不自动当成智能体数据目录。用户显式选择工程文件夹来打开。绑定信息没有对应对象，忽略并记一条说明，不删用户原文件 |
| 插件 `models.json` | 可导入连接的协议、base URL、模型名、角色。`credentialRef` 不导入、不解析。用户为每条连接重新保存密钥。导入结果用本仓库引用 |
| 插件 `styles.json` | 可选导入为风格列表。不含密钥 |
| `provider.json` v3 | 仍按重构方案：迁入文本槽和视觉槽，成功后写成 version 4 标记。与插件无关 |
| `.yingliu` | 保持 v1/v2。若包内将来要带导演文档，单独升包版本，不要偷偷塞进 v2 |
| 密钥 | 不从 DSH 凭据服务导出，不从其他应用的 `credentials.encrypted.json` 读取。迁移文档和日志只写引用名是否存在 |

### 7.2 接口抽象

独立应用侧保持这些端口，插件类型停在适配层外面：

- `CredentialPort`：按引用读写。配置类型里没有密钥字段。
- `TextProvider`：消息内容是字符串。
- `VisionProvider`：图片是字节加 MIME。未配置则看图降级，不把图片塞进文本。
- `MediaAdapter`：现有网关、图像、语音，加上官方协议。选择只靠注册表 id。
- `ProjectStore`：`expectedRevision`。策略和导演文档是工程字段，普通保存不能改它们。
- 本地 API：继续 POST + 令牌，不增加 DSH 信封。

`TtsSettings.apiKey` 在移植时从共享类型去掉。配音只认 `YINGLIU_TTS_API_KEY`。插件和本仓库现在都还有这个字段，属于要一起收口的口子，不是插件独有。

---

## 8. 分阶段迁移（本仓库原地替换）

落点是 `yingliu-agent` 的 `cursor/refactor-plan-293f`。在现有 `src/` 上替换，不另起仓库，不嵌入 DSH。阶段按可验收的切片，不按日历。业务代码等 chen 确认本节后再改。

每一阶段都要守住本仓库已经有的六项，不把它们换成插件的会话工具：

| 要留下的能力 | 现在的位置 | 阶段里不允许的改法 |
| --- | --- | --- |
| 智能体循环 | `src/agent/service.ts`、`src/agent/tools.ts`。审批、回执、预算、八阶段工具名 | 不注册 `video_*`。不恢复 `ConversationService` 作为第二执行器。不把循环改成 `ctx.tools.register` |
| 文本 / 视觉分槽 | `provider.json` version 3，引用 `yingliu.custom-model.api-key` 与 `yingliu.custom-vision.api-key`。文本请求不能带图片 | 不把 DSH 会话模型当成导演来源。不把视觉钥匙复制到文本连接。官方协议只加在生成角色上 |
| 媒体任务 | `src/jobs/media-tasks.ts`。对账、不确定则不重投、公开对象清空 `credentialRef` | 新协议走同一任务机。不另起一套 DSH Job |
| 账本 | `agent.ledger`，数据在 `agent-data` 的 ledger | 导演文档和制作策略不替代账本。费用仍记在账本，未知报价不能写成 0 |
| 尾帧承接 | 工具 `frame_handoff` | 保持「截上一镜尾帧作下一镜首帧，不调用视频模型」 |
| 配音对齐 | 工具 `align_to_voice` | 保持一次提交、可撤销。本地六类音效是另一条不调用模型的路径，不取代这个工具 |

每阶段结束：ubuntu、windows、macos 上 `typecheck`、`test`、`build` 通过。Node 保持本仓库的 22（`.github/workflows/platform-checks.yml`）。不加入插件的 DSH 宿主矩阵（`0.2.1-rc.2` / `latest` / `next`、Node 24）。涉及真实画面或成片的阶段仍跑 `native-acceptance.yml`：本机 Chrome 与 FFmpeg，缺工具记失败，不把跳过当通过。

密钥夹具只用测试里已经在用的假密钥办法。数据目录扫描不到密钥字段。CSP 响应头与 `src/app/ui-server.ts` 基线逐字比较：`default-src` 仍是 `'self'`，不新增来源，不新增 `unsafe-eval`。现有智能体、分槽、媒体任务、账本、尾帧和配音对齐的测试在每一阶段都要继续通过，不能只跑新增测试。

### 阶段 A — 决定写入文档

范围：只改 `docs/VIDEO_STUDIO_MIGRATION_ANALYSIS.md` 和 `docs/REFACTOR_PLAN.md` 里与本决定相关的句子。不改业务代码。

验收：第 10 节九条都标成 2026-11-15 已定。问题 1 写明不按原推荐，改为本仓库原地替换。问题 2–9 写明按原推荐。重构方案里的 DSH 句子已收窄，并指向本文。

CI：无新代码。推送仍会触发三平台工作流；文档变更不应让 `typecheck`、`test`、`build` 失败。

### 阶段 B — 纸感 / 暗房壳进现有构建

范围：把 yingliu-agent2 `07ed7c5` 的 P0 壳和主题移植进本仓库的 UI 构建。包括 `tokens.css`、`yl-` 布局、`data-theme` 为 `paper` | `darkroom`、偏好文件只有 `version` 与 `theme`。默认纸感。旧的 `vs-` 页面可以暂时还在包里，但不再充当主题事实。不在这一阶段改 `src/agent`、注册表、媒体任务或工程 schema。

保留：智能体端点仍可调用；文本槽和视觉槽的保存路径不动；媒体任务、账本、`frame_handoff`、`align_to_voice` 的测试不改断言含义。

验收：

- `ui.preferences.set` 后刷新，主题仍在。偏好 JSON 只有 `version` 与 `theme`。
- 两套 `data-theme` 的主布局 DOM 层级一致，背景来自变量，计算值不同。
- 静态资源仍只有 `/`、`/index.html`、`/app.js`、`/app.css`。无令牌的 `POST /api/*` 为 403，未知路径 404。
- CSP 与基线逐字一致。
- NOTICE 写明壳来自 agent2，许可证仍是 GPL-3.0-only。
- 三平台 `typecheck`、`test`、`build` 通过，含现有智能体与凭据测试。

### 阶段 C — 工程 schema 3 与制作策略

范围：在现有 `src/core`、`src/host/store.ts`、`src/host/service.ts` 上读 schema 1/2/3，保存写成 3。加入制作策略纯函数和只能由人调用的 `production.set`。普通保存不能改策略，也不能改受保护的扩展字段。这一阶段不接官方供应商，不改工具注册表的名字。

保留：写队列和 `expectedRevision` 仍是现在的串行语义。智能体提交工程仍走同一队列。媒体任务对账不因策略字段丢失已有回执。账本不进 `project.json`。`frame_handoff` 与 `align_to_voice` 仍只改工程修订，不改策略。

验收：

- 新建工程在人选定策略前不能生图、生视频，也不能当作用代码成片导出。
- schema 2 打开后镜头 ID 不变；保存后为 schema 3，策略为 `unresolved`。
- 过期 `expectedRevision` 在写入前拒绝。
- 智能体和模型调用路径提交 `production.set` 得到拒绝。
- 现有存储、智能体回执、媒体任务测试通过。
- 三平台 `typecheck`、`test`、`build` 通过。

### 阶段 D — 导演文档成为计划真源

范围：把插件的 `DirectorDocument` 校验、草稿和人批准放进工程扩展。`agent-data/stories` 只作旧档导入。八阶段里写计划的工具改为读写这份文档，批准权留在界面。不删除账本、尾帧承接和配音对齐。插件文档里八阶段用不到的字段保留，允许为空。

保留：`AgentService` 仍是唯一循环。`agent.ledger` 的文件和端点还在。`frame_handoff` 不调用视频模型。`align_to_voice` 仍是一次可撤销的提交。文本端口继续拒绝图片；看图仍只走视觉槽。

验收：

- 批准前后哈希一致才算批准。工具和模型不能把状态写成 `approved`。
- 批准不开始生成，也不改制作策略。
- 旧 sidecar 导入后不再双写。撤销后旧草稿不能覆盖新的基线哈希。
- 文档 JSON 无密钥字段。
- 账本、尾帧、配音对齐的现有测试通过。
- 三平台 `typecheck`、`test`、`build` 通过。

### 阶段 E — 官方协议接进现有注册表和媒体任务

范围：在 `src/models` 与 `src/jobs/media-tasks.ts` 增加插件那些协议 id 和适配器。能力预检失败就不提交。`async-task` 留给没有官方适配器的端点。连接引用继续 `yingliu.models.<id>.api-key`。可选导入插件 `models.json` 的 URL、协议、模型名和角色，不导入、不解析 `credentialRef`。

保留：文本槽和视觉槽的两把钥匙、`provider.json` 迁到 version 4 的规则不变。媒体任务仍是不确定则不重投。公开任务对象的 `credentialRef` 仍为空。账本继续记费用尝试。`frame_handoff` 不因为新视频协议而改成模型调用。

验收：

- mock 传输覆盖每个新协议的提交、轮询、失败和取消。不访问外网。
- 预检拒绝未知音轨、超额参考图和不支持的角色。
- 响应和注册表文件无密钥。文本保存不会把视觉引用复制到文本连接。
- 现有 `images`、`video-gateway`、`async-task` 任务测试通过。
- 三平台 `typecheck`、`test`、`build` 通过。原生媒体验收仍用本地画面，不把官方协议的 mock 算成画质验收。

### 阶段 F — 导出质检与本地音效

范围：导出前走本地质检，历史成片留下那次报告。结构硬失败不能用 `force` 绕过。六类本地 WAV 用现有 `src/agent/synth.ts` 接到音轨端点，不另写一份合成器。智能体 `quality_check` 保留为建议，不能放行硬失败。

保留：`export_mp4` 仍要批准。账本不因本地质检改记价规则。`align_to_voice` 不改成本地音效。媒体任务的采用失败仍保留候选。

验收：

- 缺素材或结构硬失败时不产出新的成片文件。
- 抽样帧有上界，报告写明未覆盖的镜头。
- 同一 seed 与参数得到同一 WAV 字节，且不发起网络请求。
- 尾帧承接和配音对齐测试通过。
- 三平台 `typecheck`、`test`、`build` 通过。成片解码走现有原生媒体验收。

### 阶段 G — 旧界面退出默认包

范围：制作要求、导演计划、模型中心、媒体任务、声音和导出放进阶段 B 的同一套 `yl-` 布局。行为仍走现有控制器和本地 API。`vs-` 页退出默认 `app.js`。不增加 DSH 信封，不加第二个静态样式 URL。

保留：左栏接上的是现有智能体循环，不是插件工具卡片。模型面板只显示 `hasKey`。未确认制作策略时生成控件不可用。账本、尾帧和配音对齐在界面上仍可走已有工具，不换成 `video_audio` 或 `video_render`。

验收：

- 两套主题的主布局 DOM 层级一致。刷新后主题仍在。
- 模型面板和偏好文件无密钥。
- 静态资源白名单和 CSP 与基线一致。
- 现有智能体审批、回执、预算、分槽、媒体任务、账本、尾帧、配音对齐测试通过。
- 三平台 `typecheck`、`test`、`build` 通过。界面验收用现有 Playwright 脚本和隔离数据目录，不打付费 API。

阶段 C–F 可以用 API 测试先验收，界面仍用阶段 B 的壳包住旧页面。阶段 G 再让旧皮肤退出默认包。不要为了换皮推迟阶段 C 的人确认闸门。

### 原地替换多出来的风险

这些风险来自「改在本仓库」，不是问题 2–9 的推荐项本身。

- 本仓库的 `service.ts`、`store.ts`、`application.ts`、`renderer.ts` 很密。原地改容易漏掉回执、队列或场景隔离分支。每一阶段以现有测试为清单，不按插件文件整段覆盖。
- `src/host/service.ts` 的 `ctx.llm` 名字像 DSH，类型其实是本应用的 `ProviderHost`。原地替换时禁止把它接回 cordis。
- 阶段 B 到 G 之间会短期同时存在 `yl-` 和 `vs-`。默认包仍只能有一份 `/app.css`。不能为了过渡再放宽 CSP，也不能学习插件把 CSS 注入 `<style>`。
- 应用身份仍是 yingliu-agent。schema 3 和 `provider.json` version 4 若直接写进用户正在使用的数据目录，旧构建再打开会失败或抢锁。实现时用隔离数据目录做验收。对用户目录的升级只在显式导入的副本上进行，不在未确认的现场目录里自动改写。这不改变问题 9：仍然不扫描 DSH profile。
- 从 agent2 移植壳时只取 P0 的界面和偏好。不把 agent2 里尚未实现的后端空模块当成第二套服务。
- 阶段 D 把计划真源从 sidecar 改到工程扩展。八阶段工具如果只改了一半，会出现 sidecar 与导演文档同时算「已批准」。验收要求导入后不再双写。

---

## 9. 许可证

| 来源 | 所见 | 和本仓库 GPL-3.0-only 的关系 |
| --- | --- | --- |
| yingliu-video-studio `package.json`、`LICENSE`、`NOTICE` | GPL-3.0-only。NOTICE 保留更早的 MIT 与 Apache-2.0 文本路径：`licenses/Legacy-MIT.txt`、`licenses/Legacy-Apache-2.0.txt` | 与本仓库当前许可证相同，源码可以迁入。迁入时带上这些历史声明，以及 LiteGraph、fflate 的 MIT 声明（两边 `THIRD_PARTY_NOTICES.md` 都有） |
| yingliu-agent | GPL-3.0-only。`NOTICE` 写明含 dsh-video-studio 0.2.0 的历史 MIT | 接收方 |
| yingliu-agent2 | GPL-3.0-only。NOTICE 写明协议来自 yingliu-agent 与 yingliu-studio | 只移植其 P0 壳和主题到本仓库。两仓库许可证相同。NOTICE 写明该壳来自 agent2 `07ed7c5` |
| dsh-vision | 仓库 `LICENSE` 为 MIT，版权 2026 lakeofsky347 | 若将来复制其源码，须保留 MIT 声明，发行物仍是 GPL-3.0-only。本次建议不复制运行时 |
| deepseek-ai/deepseek-harness 仓库根 `LICENSE` | 读到的是 MIT，版权 2026 DeepSeek | 这是该仓库根文件。**不能**据此认定 npm 上的 `@deepseek-ai/cordis` 或其余 `@deepseek-ai/dsh-*` 包许可证相同。那些包没有随插件源码分发，本次没有解包核对 |

因此：迁领域源码，两边都是 GPL-3.0-only，许可证相容。把 cordis 或 DSH 包打进独立应用的发行物之前，必须先读取每个包自己的许可证和 NOTICE。在没有读到之前，不把「可以引入 DSH」写成已满足许可证。

这不是法律意见。

---

## 10. 已定决定（2026-11-15）

chen 在这一日确认。问题 1 不按当时的推荐。问题 2–9 按当时的推荐。选项留在下面，避免以后只看见结论。

### 1. 代码落在哪

已定 **B**（不按推荐 A）。代码写在旧仓库 yingliu-agent 的 `cursor/refactor-plan-293f`，在本仓库原地替换。前端按纸感 / 暗房重做，可以参考或移植 yingliu-agent2 `main` @ `07ed7c5` 的 P0 壳和主题。两个仓库都是 GPL-3.0-only。

- A. 维持重构方案决策 1A：产品继续在 yingliu-agent2 里做。本仓库这份文档是能力清单。
- B. 改在本仓库 `yingliu-agent` 里原地替换。agent2 的 P0 壳和主题可以移植进来。
- C. 两边同时写。

当时推荐 A，是因为 agent2 的历史更干净，本仓库核心文件很密。chen 选择 B。原地替换的额外风险写在第 8 节末尾。不选 C。

### 2. 是否引入 DSH / cordis 运行时

已定 **A**。不引入运行时。只移植第 5 节里不依赖宿主的领域模块，宿主服务用本应用端口替代。`docs/REFACTOR_PLAN.md` 里「不引入 DSH、cordis」已按此收窄。dsh-vision 不作为可选瀑布。

- A. 不引入运行时。只移植领域模块，并收窄重构方案那一句。
- B. 把 cordis 和 DSH 宿主嵌进独立应用，让插件 `apply(ctx)` 原样跑。
- C. 独立应用改回 DSH 插件，不再做 Electron 壳。

### 3. 工程 schema 是否升到 3

已定 **A**。写入 schema 3。读 1/2/3。制作策略待确认前禁止生成和按成片导出。

- A. 独立应用写入 schema 3。读 1/2/3。制作策略待确认前禁止生成和按成片导出。
- B. 保持写入 schema 2。制作策略放在 sidecar，不进 `project.json`。
- C. 只读 schema 3，保存时降回 2。

### 4. 导演文档和现有 `story` sidecar 的关系

已定 **A**。导演文档成为工程内的计划真源。`agent-data/stories` 只作旧档导入。八阶段工具读写这份文档。插件文档比现有 story 细的字段保留，用不到的留空。

- A. 导演文档成为工程内的计划真源。sidecar 只作导入。
- B. 两份并存：sidecar 给智能体八阶段，导演文档只给手工工作台。
- C. 不迁导演文档，八阶段继续用现在的 `story`。

### 5. 官方协议怎么进注册表

已定 **A**。增加插件那些协议 id。`async-task` 留给没有官方适配器的端点。能力预检失败就不提交。预检未做真实供应商测试，迁移阶段只用 mock。

- A. 增加插件协议 id，保留 `async-task`，预检失败不提交。
- B. 继续只用 `async-task` 模板描述所有厂商。
- C. 用官方适配器替换并删除 `async-task`。

### 6. 插件工程里的模型连接如何交给用户

已定 **A**。导入 URL、协议、模型名和角色。密钥由用户重新保存。不读 DSH 凭据。

- A. 导入非密钥字段，密钥重新填写。
- B. 按 `DSH_VIDEO_STUDIO_*` 从本机 DSH 配置拷贝密钥。
- C. 不提供连接导入，只打开工程文件。

### 7. 导出闸门以哪份质检为准

已定 **A**。导出只认本地质检。结构硬失败不能 `force`。智能体 `quality_check` 仍可做建议，不能放行。

- A. 导出只认本地质检。硬失败不能 `force`。`quality_check` 只作建议。
- B. 保持现在的智能体 `force` 语义，本地质检只展示。
- C. 两份都只展示，人随时导出。

### 8. 前端替换的载体

已定 **A**。以 agent2 的 P0 壳为代码起点，移植进本仓库，在同一套 `yl-` / `data-theme` 上加第 6 节的面板。

- A. 移植 agent2 的 P0 壳，在同一套令牌上加面板。
- B. 在本仓库 `src/client` 上把 `vs-` 涂成纸感。
- C. 插件 `styles.css` 和 agent2 令牌各留一套，运行时切换。

### 9. 旧插件用户的数据目录

已定 **A**。不扫描 DSH profile，也不自动扫描本应用正在使用的数据目录。用户指定工程文件夹再按第 7.1 节打开。密钥不迁移。

- A. 不扫描。用户指定工程文件夹。密钥不迁移。
- B. 启动时扫描常见 DSH 目录并列出工程。

---

## 11. 不确定与未核对

- 没有对 `src/workflows/service.ts`、`src/host/store.ts`、`src/host/renderer.ts` 做逐行 diff。插件在供体 `ef3fc82` 之后的耐久、发布和 Windows 重命名修复，可能还有本仓库尚未对齐的分支。阶段 C 开始前应把这三份文件的测试差列成清单，而不是假设「供体在本仓库，所以插件没有更多修复」。
- `src/models/capabilities.ts` 的 `realProviderTested: false` 与 `checkedAt: '2026-11-06'` 是插件自己的边界。本文不声称这些请求形状在 2026-11-15 仍被厂商接受。
- `@deepseek-ai/cordis` 与其他 DSH npm 包的许可证没有从包内 LICENSE 核对。只核对了 deepseek-harness 仓库根文件，以及 dsh-vision 仓库的 MIT。
- 本仓库 `src/host/service.ts` 仍有 `ctx.llm.listProviders()` 这种命名。它现在指向 `ProviderHost`，不是 cordis。阅读旧代码时容易看成插件宿主，移植时不要按这个名字去接 DSH。
- 没有运行插件的 `npm test`，也没有运行本仓库测试。文件与提交以第 1 节表格为准。
- agent2 是私有仓库，本文根据 GitHub API 读到的 `07ed7c5` 树。没有在本机克隆。
- 插件 CI 文档写「配置存在不等于任务已经通过」。本文不把某次 Actions 链接写成持续绿色。
