# 智能体设计文档（1.2.0）

映流智能体（`yingliu-agent`）将**智能体副驾驶**作为主工作台左侧一等公民面板（与基座 `yingliu-video-studio` 1.0.0 的 Marble White / 深色设计体系完全一致）。用户输入创作目标后，智能体循环执行「沟通规划 → 白模预演 → 审阅确认 → 模型呈现与质检」，并支持流式输出、多轮追问与中途纠偏。

## 四阶段标准创作流水线（含 Blender 白模预演）

```
阶段 1：对话确认分镜        plan_story / plan_shots（用户审阅批准剧本、角色与分镜）
          ↓
阶段 2：Blender 白模预演    blender_render_previz（按确认分镜在 Blender 搭建白模场景/站位/运镜，渲染白模首帧 PNG + 动态 MP4）
          ↓
阶段 3：用户审阅预演        submit_previz_review（审批卡片直接预览白模帧与预演视频；不满意则调整机位/站位重渲，零付费 API 损耗）
          ↓
阶段 4：创作模型实际呈现    generate_video / generate_image / shot_write_source（将审阅通过的白模参考帧输入具体创作模型呈现最终画面 + 音轨 + 质检导出）
```

### 设计原则与职责边界
1. **Blender 专职镜头预演（Previsualization）**：Blender 不是直接交付成片的替代品，而是给智能体用于验证**空间关系、多人站位、镜头焦距（24/35/50/85mm）与运镜轨迹（推拉摇移环绕）**的低成本白模预演工具。
2. **先审阅白模，再花钱调创作模型**：用户通过对话与智能体确认分镜后，智能体调用 `blender_render_previz` 生成白模参考帧（PNG）和白模动态视频（MP4），再通过 `submit_previz_review`（`plan` 风险级，强制等待用户批准）把预演结果呈现在审批卡片与工作台中。用户审阅通过后，对应分镜标记为 `previz.status = 'approved'`，智能体才将白模参考帧作为 `imageAssetId` / `previzAssetId` 输入给生视频/生图模型（或用于镜头源码构图参考）做最终实际呈现。
3. **无头确定性安全执行**：`src/host/blender.ts` 通过内置确定性模板脚本运行无头 Blender（`--background --factory-startup --disable-autoexec --python-exit-code 1`），不执行模型任意 Python 代码；产物经 PNG 魔数与 `ffprobe` 实测校验后才入库，标记为 `provenance: { origin: 'code_render', usage: 'reference_only' }`（不会误混入 Schema v3 正式成片）。应用仅清理自身启动的 Blender/FFmpeg 子进程。
4. **未安装 Blender 时优雅降级**：在「运行环境」或 `yingliu doctor` 中检测 Blender 路径；若本机未安装 Blender，`capabilities.roles` 不暴露 `blender`，`blender_render_previz` 隐藏，智能体平滑回退到常规直出流程。

## 架构

| 模块 | 文件 | 作用 |
| --- | --- | --- |
| 协议与流式 | `src/agent/model-client.ts` | OpenAI 兼容 `/chat/completions` 的 `tools` / `tool_calls` 与 SSE 流式增量（`stream: true`，不兼容接口自动降级为非流式）；模型不支持 `tools` 时自动降级为「计划 JSON」（`{message,done,actions}`） |
| 工具注册表 | `src/agent/tools.ts` | 每个工具带 JSON Schema、风险等级（`read` / `write` / `plan` / `cost` / `export`）和处理函数，全部复用宿主机与媒体服务 |
| 循环与并发 | `src/agent/service.ts` `AgentService` | 多轮循环、**只读非视觉工具安全有界并行（4 并发保序回填）**、多轮续聊与运行中纠偏（`sendMessage`）、审批挂起、等待异步媒体任务、自检回合、按错误分类重试 |
| Blender 执行器 | `src/host/blender.ts` | 自动探测本机 Blender，无头确定性白模预演（PNG 关键帧 + FFmpeg H.264 MP4），自有进程追踪与超时强杀 |
| 持久化 | `src/agent/run-store.ts` | `<数据目录>/agent-runs/<id>.json` 原子快照 + `<id>.trace.jsonl` 追加轨迹，写入前脱敏密钥 |
| 预算 | `src/agent/budget.ts` | 步数、工具调用、token、费用上限；按模型参数 `pricePerMInput` / `pricePerMOutput`（每百万 token）计价；费用未知单独计数 |
| 上下文与记忆 | `src/agent/context.ts` | 不含本地路径的工程摘要（含 `videoClips` 与 `productionPolicy`）；超字符预算时保留结构化事实头（最新 `revision` 与关键资产/镜头/预演 ID）并压缩旧工具输出；素材文本用 `<untrusted>` 标记 |
| 接口 | `src/app/application.ts` | `agent.start/list/get/trace/approve/reject/resume/pause/cancel/message/tools/capabilities`、`audio.generate`、`models.discover`、`production.set`、`director.document.save/approve`、`quality.check/last` |
| 推送 | `src/app/ui-server.ts` | `POST /events/agent?projectId=`（带应用令牌）返回 `text/event-stream`（推送 `run`、`step` 与实时 `delta` 文本流）；界面断开时自动回退为轮询 |
| 界面 | `src/client/App.tsx` / `AgentPanel.tsx` / `StoryPanel.tsx` | 主工作台左侧 1.0.0 统一 AI 副驾驶（智能体 / 计划与预演 / 创作对话）、四阶段流程条、流式思考区、Blender 白模预演图文视频审阅卡、多轮追问输入框 |

## 工具

| 工具 | 风险 | 说明 |
| --- | --- | --- |
| `project_get` `shot_read_source` `env_check` `task_status` `styles_list` `story_get` `skill_read` | read | 读取工程摘要、镜头源码、本机工具（含 Blender）、任务状态、风格库、创作计划与导演技能（含 `blender-previz`） |
| `render_check` `quality_check` `capture_frame` `visual_review` `consistency_review` | read | 预览检查、导出前质检、截帧、关键帧视觉检查（最多 3 帧）与一致性评分（最多 6 帧，需绑定 vision） |
| `plan_story` `plan_shots` `submit_previz_review` | plan | 提交剧本/角色/分镜计划与 **Blender 白模预演审阅单**（默认强制等待用户批准） |
| `video_update` `shot_write_source` `audio_edit` `undo` `redo` | write | 均严格校验 `expectedRevision` 并可撤销；`audio_edit` 具备显式音轨参数 Schema |
| `video_clip_save` `video_clip_remove` `video_clip_extract` | write | 镜头视频片段绑定、裁剪/倍速/留原声、移除及抽取原声轨 |
| `blender_render_previz` | write | 需要本机 `blender`：按结构化 3D 场景规格无头渲染白模关键帧（PNG）与动态预演视频（MP4）并导入工程 |
| `media_apply` `synthesize_sfx` `character_upsert` `frame_handoff` `align_to_voice` `project_set_style` `asset_remove` | write | 采用生成素材、本地免费合成音效（支持直接入轨）、维护角色库、尾帧承接、配音时长对齐、应用风格与清理资产 |
| `generate_image` `generate_video` `generate_voice` `generate_music` `generate_sfx` `run_workflow` | cost | 收费生成（每次默认需审批）；`generate_video` 支持 `durationSeconds`/`aspectRatio`/`width`/`height`/`seed`/`negativePrompt`/`previzAssetId` 并自动优先关联已批准的 Blender 白模预演帧；`generate_image` 支持 `size`/`quality`/`style`/`n` |
| `export_mp4` | export | 导出成片（导出前自动质检，严重问题阻断除非 `force=true`） |

## 默认策略

- read 与 write 自动执行（write 均可撤销，可在面板中改为逐步确认）；**cost 与 export 每次都需要用户批准**。
- 设置费用上限时，费用未知或预计超出的收费调用一律需要批准。
- 默认上限：24 步、60 次工具调用、40 万 token、自检 2 轮。
- 写入后模型宣布完成时，自动运行 `visual_review`（未配置视觉模型时改为 `render_check`）；不通过则把问题交还模型修复。
- 网络错误、HTTP 429/5xx 按指数退避重试 3 次；版本冲突和参数错误作为工具结果交还模型处理。
- 应用重启时，进行中的运行标记为「已暂停」，可从队列中的下一个工具调用继续；等待审批的运行保持等待。
- 同工程的启动、审批、拒绝、恢复、暂停与取消通过生命周期队列串行化；旧循环排空后重新检查占用，避免同工程两个智能体同时执行。不同工程可独立运行。此边界位于单个应用服务内，不代表跨 CLI/桌面进程锁。
- 智能体通过 `director` 角色规划与调用工具。新工作区文本接口预填 OpenAI 的 `gpt-4.1-mini`，在模型参数里设 `supportsTools:false` 可强制使用计划 JSON。已配置视觉角色且本轮允许发送时，审片图片交给视觉角色，导演接收文字检查结果。

## 测试

`tests/agent.test.ts` 和 `tests/agent-app.test.ts` 使用 `tests/model-gateway.ts` 中的 `toolGateway` 本地脚本网关返回 `tool_calls`，不请求任何付费服务。覆盖：原生工具循环、审批/拒绝/重启后批准、中断恢复、两种降级、重试与预算、冲突反馈、视觉自检回合、媒体任务等待与计费、密钥脱敏、并发保护、SSE 与真实工程提交。

## 尚未验收

- 真实 DeepSeek 等供应商的工具调用质量、费用和稳定性。
- 桌面端（Electron）实机界面与 SSE；视觉自检使用真实视觉模型的效果。
- 长任务的上下文压缩质量。

## 多模态模型接入与能力切换

### 协议
| 协议 | 用途 | 说明 |
| --- | --- | --- |
| `chat-completions` | 导演 / 场景 / 视觉检查 | OpenAI 及兼容服务，支持模型目录发现与流式输出 |
| `images` / `gemini-image` | 生图 | OpenAI `/images/generations` 兼容与 Google Gemini 原生图像 |
| `video-gateway` | 生视频 | 映流媒体网关 v1（支持 `clientRequestId` 查单） |
| `openai-videos` / `kling-video` / `minimax-video` / `volc-video` / `dashscope-video` / `gemini-video` | 生视频（官方协议直连） | 与基座 1.0.0 一致的官方多厂商协议：支持可灵 `accessKey:secretKey` 自动签发 HS256 JWT 与文生/图生自动分流、火山方舟 Seedance、百炼万相、MiniMax、Gemini Veo、OpenAI Videos，附带提交前参数能力强校验（`validateMediaRequest`）与模型目录发现（`models.discover`） |
| `speech` | 配音 | OpenAI `/audio/speech` 兼容或本机 macOS `local:say` |
| `async-task` | 生图 / 生视频 / 配音 / 音乐 / 音效 | **可配置通用模板**：提交 → 轮询 → 取结果，或同步返回二进制；`speech` 角色绑定 `async-task` 时自动走模板适配器（支持 ElevenLabs `xi-api-key` 等非 OpenAI 接口），且在音频面板提供人工调用入口（`audio.generate`） |

`async-task` 模型的模板字段都写在模型参数里（不含密钥）：`preset`、`submitPath`、`submitMethod`、`submitBody`（JSON 模板，支持 `{{prompt}}` `{{model}}` `{{image}}` `{{duration|5}}` `{{param.x|默认}}`；占位符在解析后的结构里替换，提示词无法破坏 JSON；缺失的可选字段会自动省略）、`idPath`、`pollPath`、`pollMethod`、`statusPath`、`statusMap`、`resultPath`（如 `output.results[].url`）、`resultMime`、`errorPath`、`progressPath`、`cancelPath`、`checkPath`、`responseType`（json/binary）、`authHttpName`、`authPrefix`、`extraHttpName`/`extraHttpValue`（不能用来放凭据）。

内置预设：

| 预设 | 产出 | Base URL 示例 |
| --- | --- | --- |
| `dashscope-image` 通义万相文生图 | 图片 | `https://dashscope.aliyuncs.com/api/v1` |
| `dashscope-video` 通义万相生视频 | 视频 | 同上 |
| `kling-video` 可灵 | 视频 | `https://api-beijing.klingai.com`（需填可灵 JWT 作为 API Key，见下） |
| `ark-video` 火山方舟 / 即梦 Seedance | 视频 | `https://ark.cn-beijing.volces.com/api/v3` |
| `runway-video` Runway | 视频 | `https://api.dev.runwayml.com` |
| `replicate` 官方模型，模型 ID 填 owner/name | 图片/视频/音频 | `https://api.replicate.com/v1` |
| `replicate-version` 社区指定版本，模型 ID 填版本哈希或 owner/name:版本哈希 | 图片/视频/音频 | 同上 |
| `elevenlabs-sfx` 音效 | 音频 | `https://api.elevenlabs.io` |
| `openai-speech` OpenAI 兼容 TTS | 音频 | `https://api.openai.com/v1` |
| `generic-async` 自定义 | 任意 | 自定义 |

Replicate 默认官方模型路径为 `/models/{{modelOwner}}/{{modelName}}/predictions`，owner 与 name 分别编码；通用 `{{model}}`、任务 ID 等变量仍整体编码。社区指定版本模板通过 `/predictions` 的 `version` 字段提交，依据 [官方 HTTP API](https://replicate.com/docs/reference/http)。路径、请求体与恢复由本机协议回归验证；实际模型类型、输入参数、权限和真实生成质量仍需账户验收。自定义覆盖的模板路径不会被自动重写。

连接检查只发 GET 请求（`checkPath` 或根路径），不提交生成；401/403 会提示凭据被拒绝。

### 角色与能力
角色：`director` `scene` `vision` `image` `video` `speech` `music`（新增）`sfx`（新增）。

智能体在**每一步**都会重新读取已绑定的角色（热更新）：
- 未绑定生图/生视频：不提供 `generate_image` / `generate_video` / `media_apply`，系统提示切换为「导演兼任美术和动画师」，用 HTML/CSS/SVG/Canvas 亲手绘制画面。
- 未绑定配音：旁白写成字幕；未绑定音乐：不加背景音乐，或合成简单铺底音；未绑定音效：提供免费的本地合成工具 `synthesize_sfx`（提示音、扫频、风声、点击、钟声、噪声冲击，生成 WAV 并导入）。
- 绑定后对应工具自动出现（`generate_image` / `generate_video` / `generate_voice` / `generate_music` / `generate_sfx`），运行中的智能体在下一步收到「能力已变化」通知。收费工具依旧每次需要批准。
- 「智能体」面板的「当前能力」区域显示导演模型、已接入角色、由导演自制的部分和当前激活的工具；每次运行也会记录当步激活的工具。

### 已知限制
- 官方协议直连已支持可灵 `accessKey:secretKey` 自动签发 HS256 JWT 及火山方舟 `volc-video`、百炼 `dashscope-video`、MiniMax、Gemini Veo、OpenAI Videos；若使用 `async-task` 自定义模板模式对接可灵，仍需手动填写有效 JWT。
- `async-task` 模板模式与非 `video-gateway` 官方协议不支持按 `clientRequestId` 查单：提交响应丢失时任务标记为「待确认」，不会自动重复提交。
- 未支持远端取消的协议只能停止本地等待。

## 0.5：创作计划、一致性、项目预算与质检

### 创作计划（story.json）
- 保存在 `<数据目录>/agent-data/stories/<工程 ID>.json`，带 `version`（乐观并发：UI 保存时必须带 `expectedVersion`）。
- 风险级别 `plan`：`plan_story`（标题、梗概、目标时长、风格、角色）和 `plan_shots`（分镜表）**默认需要审批**；拒绝后不落盘。启动时勾选「创作计划无需审批」即可把 `plan` 加入自动批准。
- 系统提示：没有已批准的计划时，要求多镜头/有角色的目标先规划；有计划时把计划摘要注入提示。

### 角色与一致性
- 角色：`{id,name,description,features[],referenceAssetIds[],voice?}`，可在面板「角色库」编辑；智能体用 `character_upsert` 维护（参考图须是工程内的图片素材）。
- `generate_image` / `generate_video` 的 `characterIds` 会在提示词后追加「【一致性锚点】」（画风、配色、运动、角色特征、避免项）。
- `consistency_review`（需要 vision 角色）：最多 6 个关键帧，视觉模型返回 `{"scores":[{"shotId","score","notes"}]}`，写入 `story.consistency`；低于阈值（默认 75）只给出建议。

### 项目预算
- `<数据目录>/agent-data/ledger/<工程 ID>.json`：`spent`、`unknownCostCalls`、`byTool`、`maxCost`。导演模型的 token 费用（如果模型配置了价格）记为 `director`；媒体任务完成后回报的费用记入 `media`。
- 设置了 `maxCost` 时，收费调用即使在自动批准名单中，也会因为「费用未知」或「将超过项目上限」而要求审批；累计花费达到上限时运行停止（`budget_exceeded`）。
- 项目累计费用在每个排队工具执行前检查，用户已批准的调用也受当前上限约束；同一模型回合返回多项收费操作不能跨过上限。已经成功的工具回执优先完成本地结算，不重新提交。
- 模型中心的「文本费用情景试算」按用户填写的每百万输入/输出 token 单价、币种、来源和轮数计算，不发模型请求，也不批准媒体费用。未填、空白或非法单价、缺失/非法 usage 以及单价/运行/账本币种不一致都保留未知；未知导演费用也记入项目账本。历史花费或未知费用存在时不能直接换账本币种标签，不自动换汇。

### 质检
- `quality_check` 工具 / `agent.qc` 端点；结果保存在 `agent-data/qc/`，可用 `agent.qc.last` 读取。
- `export_mp4` 先质检，有 `high` 级问题时返回 `blocked`；确认后可用 `force: true` 强制导出（仍需导出审批）。
- 局限：只能分析 PNG 截帧；静音检查基于工程数据，不解码音频波形。

### 其他工具
- `frame_handoff`（需要 video 角色）：截取上一镜最后一帧，导入为图片素材，作为 `generate_video.imageAssetId`。
- `align_to_voice`：镜头时长 = 配音时长 + 余量（默认 0.4 秒），配音片段对齐到镜头开头，一次提交，可撤销。
- `skill_read`：主题包括 `scene-structure`、`deterministic-motion`、`layout-safe-area`、`subtitles-voice`、`self-made-visuals`、`performance-pitfalls`、`consistency`、`blender-previz`。

### 端点汇总
`agent.start`、`agent.list`、`agent.get`、`agent.trace`、`agent.approve`、`agent.reject`、`agent.resume`、`agent.pause`、`agent.cancel`、`agent.message`、`agent.tools`、`agent.capabilities`、`story.get`、`story.save`、`agent.qc`、`agent.qc.last`、`agent.ledger`、`agent.budget.set`、`audio.generate`、`models.discover`、`production.set`、`director.document.save`、`director.document.approve`、`quality.check`、`quality.last`。
