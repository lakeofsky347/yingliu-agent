# 智能体（0.4.0）

工作台新增「智能体」面板。用一句话描述目标后，智能体会循环执行「规划 → 调用工具 → 观察结果 → 反思」：读取工程、逐步修改镜头和音轨、检查渲染与画面，最后用中文总结。

## 架构

| 模块 | 文件 | 作用 |
| --- | --- | --- |
| 协议 | `src/agent/model-client.ts` | OpenAI 兼容 `/chat/completions` 的 `tools` / `tool_calls`；模型不支持时降级为与旧导演一致的「计划 JSON」（`{message,done,actions}`）。供应商对 `tools` 返回 400/404/422 时自动降级并记入轨迹 |
| 工具注册表 | `src/agent/tools.ts` | 每个工具带 JSON Schema、风险等级（read / write / cost / export）和处理函数，全部复用现有服务 |
| 循环 | `src/agent/service.ts` `AgentService` | 多轮循环、审批挂起、等待异步媒体任务、暂停/继续/取消、自检回合、按错误分类重试 |
| 持久化 | `src/agent/run-store.ts` | `<数据目录>/agent-runs/<id>.json` 原子快照 + `<id>.trace.jsonl` 追加轨迹，写入前脱敏密钥 |
| 预算 | `src/agent/budget.ts` | 步数、工具调用、token、费用上限；按模型参数 `pricePerMInput` / `pricePerMOutput`（每百万 token）计价；费用未知单独计数 |
| 上下文 | `src/agent/context.ts` | 不含本地路径的工程摘要；源码按需读取；超过字符预算时压缩较早的工具结果并丢弃旧图片；素材文本用 `<untrusted>` 标记 |
| 接口 | `src/app/application.ts` | `agent.start/list/get/trace/approve/reject/resume/pause/cancel/tools` |
| 推送 | `src/app/ui-server.ts` | `POST /events/agent?projectId=`（带应用令牌）返回 `text/event-stream`；界面断开时自动回退为轮询 |
| 界面 | `src/client/AgentPanel.tsx` | 目标输入、自动批准选项、预算条、审批卡片、步骤列表、对话记录、最终总结 |

## 工具

| 工具 | 风险 | 说明 |
| --- | --- | --- |
| `project_get` `shot_read_source` `env_check` `task_status` | read | 读取工程、源码、本机工具和任务状态 |
| `render_check` `capture_frame` `visual_review` | read | 刷新预览检查、截帧、关键帧视觉检查（需要绑定 vision 角色） |
| `video_update` `audio_edit` | write | 通过与对话相同的 `compileDirectorPlan` 校验，再以 `expectedRevision` 原子提交 |
| `shot_write_source` `media_apply` `undo` | write | 保存源码、采用生成素材、撤销 |
| `generate_image` `generate_video` `generate_voice` `run_workflow` | cost | 收费生成；媒体任务使用 `clientRequestId=<运行>.<调用>` 防止重复提交 |
| `export_mp4` | export | 导出成片 |

## 默认策略

- read 与 write 自动执行（write 均可撤销，可在面板中改为逐步确认）；**cost 与 export 每次都需要用户批准**。
- 设置费用上限时，费用未知或预计超出的收费调用一律需要批准。
- 默认上限：24 步、60 次工具调用、40 万 token、自检 2 轮。
- 写入后模型宣布完成时，自动运行 `visual_review`（未配置视觉模型时改为 `render_check`）；不通过则把问题交还模型修复。
- 网络错误、HTTP 429/5xx 按指数退避重试 3 次；版本冲突和参数错误作为工具结果交还模型处理。
- 应用重启时，进行中的运行标记为「已暂停」，可从队列中的下一个工具调用继续；等待审批的运行保持等待。
- 模型使用 `director` 角色绑定的模型，默认可配置 `deepseek-chat`；在模型参数里设 `supportsTools:false` 可强制使用计划 JSON。

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
| `chat-completions` | 导演 / 场景 / 视觉检查 | OpenAI 兼容，默认可用 deepseek-chat |
| `images` | 生图 | OpenAI `/images/generations` 兼容（含火山方舟 Seedream 等兼容接口） |
| `video-gateway` | 生视频 | 映流媒体网关 v1 |
| `speech` | 配音 | 应用原有 TTS 设置 |
| `async-task` | 生图 / 生视频 / 配音 / 音乐 / 音效 | **可配置协议模板**：提交 → 轮询 → 取结果，或同步返回二进制 |

`async-task` 模型的模板字段都写在模型参数里（不含密钥）：`preset`、`submitPath`、`submitMethod`、`submitBody`（JSON 模板，支持 `{{prompt}}` `{{model}}` `{{image}}` `{{duration|5}}` `{{param.x|默认}}`；占位符在解析后的结构里替换，提示词无法破坏 JSON；缺失的可选字段会自动省略）、`idPath`、`pollPath`、`pollMethod`、`statusPath`、`statusMap`、`resultPath`（如 `output.results[].url`）、`resultMime`、`errorPath`、`progressPath`、`cancelPath`、`checkPath`、`responseType`（json/binary）、`authHttpName`、`authPrefix`、`extraHttpName`/`extraHttpValue`（不能用来放凭据）。

内置预设：

| 预设 | 产出 | Base URL 示例 |
| --- | --- | --- |
| `dashscope-image` 通义万相文生图 | 图片 | `https://dashscope.aliyuncs.com/api/v1` |
| `dashscope-video` 通义万相生视频 | 视频 | 同上 |
| `kling-video` 可灵 | 视频 | `https://api-beijing.klingai.com`（需填可灵 JWT 作为 API Key，见下） |
| `ark-video` 火山方舟 / 即梦 Seedance | 视频 | `https://ark.cn-beijing.volces.com/api/v3` |
| `runway-video` Runway | 视频 | `https://api.dev.runwayml.com` |
| `replicate` 任意 Replicate 模型 | 图片/视频/音频 | `https://api.replicate.com/v1` |
| `elevenlabs-sfx` 音效 | 音频 | `https://api.elevenlabs.io` |
| `openai-speech` OpenAI 兼容 TTS | 音频 | `https://api.openai.com/v1` |
| `generic-async` 自定义 | 任意 | 自定义 |

连接检查只发 GET 请求（`checkPath` 或根路径），不提交生成；401/403 会提示凭据被拒绝。

### 角色与能力
角色：`director` `scene` `vision` `image` `video` `speech` `music`（新增）`sfx`（新增）。

智能体在**每一步**都会重新读取已绑定的角色（热更新）：
- 未绑定生图/生视频：不提供 `generate_image` / `generate_video` / `media_apply`，系统提示切换为「导演兼任美术和动画师」，用 HTML/CSS/SVG/Canvas 亲手绘制画面。
- 未绑定配音：旁白写成字幕；未绑定音乐：不加背景音乐，或合成简单铺底音；未绑定音效：提供免费的本地合成工具 `synthesize_sfx`（提示音、扫频、风声、点击、钟声、噪声冲击，生成 WAV 并导入）。
- 绑定后对应工具自动出现（`generate_image` / `generate_video` / `generate_voice` / `generate_music` / `generate_sfx`），运行中的智能体在下一步收到「能力已变化」通知。收费工具依旧每次需要批准。
- 「智能体」面板的「当前能力」区域显示导演模型、已接入角色、由导演自制的部分和当前激活的工具；每次运行也会记录当步激活的工具。

### 已知限制
- 可灵官方接口用 AccessKey/SecretKey 签发 JWT；本应用暂不签发，请填入有效 JWT 或经自建网关转发。即梦（火山引擎视觉智能）的 AK/SK 签名接口同理，建议用火山方舟 `ark-video` 或网关。
- 模板模式不支持按 clientRequestId 查单：提交响应丢失时任务标记为「待确认」，不会自动重复提交。
- 未配置 `cancelPath` 的服务只能停止本地等待。
