# 映流 Studio 0.3 模型、多模态与对话协议

正常应用通过模型中心保存多个连接，每个连接可注册多个模型，再将导演、场景代码、视觉检查、生图、生视频和配音角色分配给模型。文本与媒体分别使用各自协议；任意 Base URL 不代表兼容，应用不要求常驻公共网关，也不读取 DSH、Codex 或其他应用凭据。

`custom` 是保留的旧文本配置兼容入口。首次迁移时，旧 `provider.json` 及 `yingliu.custom-model.api-key` 引用成为默认连接和模型；没有旧数据时保留 DeepSeek 兼容地址与模型作为未配置起点。缺少所需凭据时，在创建工程或持久化 pending 回合之前拒绝 AI 请求；显式配置 `auth:none` 的本地/无密钥服务不需要 Key。旧数据不会因迁移被删除，已有模型注册表优先。

离线 `demo / offline-director` 只允许测试显式构造 `ProviderManager(...,{allowFixtures:true})`，不出现在正常供应商目录。本次验证使用离线单元测试和 localhost 测试网关，未执行真实付费请求。协议通过、生成成功与成片质量分别记录；目录可访问、源码保存及运行检查不能替代真实供应商创作或视觉验收。

## 模型注册与角色路由

版本化结构定义在 `src/models/contracts.ts`，应用 `model-registry.json` 的版本为 1：

| 对象 | 字段与含义 |
| --- | --- |
| `ProviderConnection` | 稳定 id、name、protocol、baseUrl、auth、credentialRef、enabled、revision、requestTimeoutMs、concurrency |
| `ModelDefinition` | 本地稳定 id、connectionId、供应商 model 名、name、enabled、inputModalities、outputModalities、标量 parameters |
| `RoleBinding` | role 与本地 modelId；角色为 director / scene / vision / image / video / speech |

`provider` 路由值现在是连接 ID；供应商模型名与本地 modelId 不应混用。文本调用可以显式指定连接/模型，也可以先解析角色。角色须满足相应协议及模态；vision 还需要 image 输入能力。连接 auth 只支持 bearer 或 none，参数不接受密钥、凭据或任意认证头。

模型中心 RPC 为 `models.list`、`models.connection.save/remove`、`models.model.save/remove`、`models.role.bind` 和 `models.check`。saveConnection 的 apiKey 只写入凭据服务，不回显；留空不传则保留，显式空字符串清除。读取返回 hasKey 与可选 credentialStatus，系统加密不可用时阻止需要密钥的调用，不回退到明文。每次媒体 HTTP 操作按原凭据引用重新读取 Key，允许轮换；在用模型/连接受到删除与关键配置修改保护。

连接请求超时允许 5–900 秒，concurrency 为 1–16；文本兼容传输将实际超时限制到 300 秒。当前连接并发设置用于媒体任务调度，不等价于所有文本或语音入口的统一供应商限流器。模型目录由已注册定义构成，用户可手动填写供应商 model 名，无需目录探测先成功。

`models.check` 仅调用已保存 Base URL 下的 `GET /models`，即使媒体服务未实现目录，也不会触发一次生成来“测试连接”。没有目录或目录未列出某模型时，真实生成仍为 NOT_CHECKED。旧 `providers.save` 继续更新 custom 配置；`providers.get/check` 默认反映当前 director 路由，get 另附可用的 legacyConfig。完整新增连接和角色分配使用 models 接口。

## 首批协议

| 协议 | HTTP 操作 | 应用使用方式 |
| --- | --- | --- |
| `chat-completions` | `POST {baseUrl}/chat/completions`，普通 JSON 或 SSE | 对话及 director/scene/vision 角色；内部 `complete` 与 ProviderHost stream |
| `images` | `POST {baseUrl}/images/generations` | `media.generate`，文生图，支持 URL / b64_json 结果 |
| `video-gateway` | 映流异步媒体网关 v1 | `media.generate`，文生视频或图生视频；模型须声明 image 输入能力才可图生视频 |
| `speech` | `POST {baseUrl}/audio/speech` | 工作流 speech 角色与现有兼容 TTS；要求返回可检查音频 |

baseUrl 一般填写到 `/v1`，适配器负责拼接具体接口。视频连接必须实现 [网关 v1 契约](media-gateway-v1/README.md)，不是把生视频服务注册为聊天模型。未配置 speech 角色时，工作流沿用本地语音与旧 TTS 设置；未配置媒体模型不会影响手动制作和本地导出。

## 文本服务与参数

`/chat/completions` 使用同一个多轮 `messages`，支持 SSE 和普通 JSON 回复。Key 只交给注入的 `SecretStore`；注册表保存凭据引用，legacy provider.json 保留旧配置，不保存 Key。服务错误中的 Key 被脱敏。模型注册表及 `ProviderManager.save()` 串行合并更新并原子替换；配置保存失败时恢复此前凭据。

下表为文本传输读取的模型 parameters 默认值与保护范围；supportsVision 由模型 inputModalities 推导，旧 custom 配置保留同名字段：

| 参数 | 默认 | 范围 |
|---|---:|---|
| `temperature` | 0.7 | 0–2 |
| `maxTokens` | 7000 | 256–32768；具体模型可另有上限 |
| `requestTimeoutMs` | 90000 | 5000–300000 毫秒 |
| `contextMessageLimit` | 24 | 4–100 条历史消息 |
| `contextCharLimit` | 90000 | 8000–300000 字符的文本预算 |
| `supportsVision` | false | 用户确认供应商/模型支持图片输入 |
| `enableVision` | false | 用户明确开启图片发送 |
| `maxVisionImages` | 3 | 1–3 |
| `maxVisionBytes` | 6291456 | 1024–6291456 字节，总和 |
| `maxVisionDimension` | 4096 | 64–4096，最长边 |

参数上限是应用保护范围，不保证所有供应商都接受。服务端拒绝会明确呈现。上下文优先保留最近对话，再附当前工程、选中镜头、素材元信息和工具回执；超过预算时截断旧文本，不截断图片 data URL。应用不保存或展示模型的隐藏思考过程。

模型中心删除 Key 使用 `models.connection.save({id,apiKey:''})`；`providers.save({apiKey:''})` 只清除旧 custom 凭据。

## 闲聊、讨论、创作与修改

`ChatInput.intent` 可显式选择 `auto / chat / discuss / create / modify`；未提供时由明确语句和模型计划共同识别。闲聊和讨论只回答，不自动创建工程或启动预览。讨论后，用户可以继续说“开始制作”。已有工程的修改先读取当前版本，保留未要求修改的手动内容。

模型返回 JSON 导演计划。一次对话最多 4 轮，每轮最多 16 个动作。`done:false` 可以请求读取工程或源码回执；修改在内存候选工程中规划，直到 `done:true`。包含读取动作的计划须先实际读取并把回执返回模型，即使模型误写了 `done:true`，也不会直接宣称已读或提前提交。应用先校验所有动作、镜头主链、素材引用和源码，再执行一次事务：新工程 `create({project,sources})`；已有工程 `apply({projectId,expectedRevision,project,sources})`。计划末尾的无效动作不会留下前面动作的部分修改。

示例：

```json
{
  "intent": "modify",
  "message": "第二镜改为滑入，保留手改标题",
  "done": true,
  "actions": [{
    "tool": "video_update",
    "arguments": {
      "expectedRevision": 5,
      "update": {
        "shotPatches": [{
          "id": "existing-shot-id",
          "patch": {"params": {"motion": "slide"}, "durationSeconds": 8}
        }]
      }
    }
  }]
}
```

五类工具语义：

| 动作 | 支持的行为 |
|---|---|
| `video_project` | 查看当前工程；用户明确新建时规划新工程简报 |
| `video_update` | 项目标题/主题/target/时长；1–12 镜的首次分镜与对应源码；添加、删除、重排镜头；镜头标题/时长/参数；选中镜头；绑定已导入素材；局部源码更新 |
| `video_inspect` | 已有工程/镜头规范与可选源码读取；当前不返回截图像素 |
| `video_render` | 提交后预览和代码运行检查；MP4 导出由界面发起 |
| `video_audio` | 已导入音轨的添加、更新、移除；不从任意路径导入或自行发起远程合成 |

首次分镜使用 `storyboard.shots` 和对应的 `sourcesByIndex`。镜头数量按内容为 1–12；每个新增镜头必须有源码。已有镜头通过 `shotPatches` 保留 ID。新增镜头使用 `addShots:[{tempId,afterId?,...,source}]`，应用分配 ID；`shotOrder` 可以引用既有 ID 或该计划的 `tempId`。`deleteShotIds`、`assetBindings`、`selectedShotId` 分别承担删除、素材绑定与选择。不得用全量 storyboard 覆盖已有非空主链。

“第二镜”“第十二个镜头”按当前主链顺序定位。局部修改限制到选中或明确指定的镜头；删除/添加/重排须与用户请求相符。标题未被明确要求改变时保留。源码由 `html/css/js` 构成，JS 导出 `render(ctx)`，可导出异步 `ready(ctx)`，按帧独立求值并读取 `ctx.params`。

JSON 格式或本地规划校验错误会返回未提交回执，供有限修复。已知工程版本冲突会读取最新工程并要求模型合并，不能覆盖用户的新修改。I/O 或不明事务失败不会自动重复提交。提交后的预览失败保留已保存版本，回合标记失败并明确需要修复或撤销，不静默回滚内容。

## 持久回合、取消与重试

`Conversation.messages` 保留聊天内容，新增 `turnId/status`；`Conversation.turns` 保存每轮请求、时间、状态、重试来源、错误及已提交 revision。状态为 `pending / succeeded / failed / cancelled / interrupted`。聊天记录按工程 ID 的 SHA256 文件名保存在应用数据目录的 `conversations/`。工程创建前的讨论可在创建后关联到工程。

重试复用 `chat.send({retryTurnId,message:'',projectId,provider:connectionId,model})`（也可通过 role 选择已绑定的文本角色），重新读取当前工程，不复用过时 revision。重启读取历史时，残留 pending 回合转为 interrupted 并落盘；不自动重投可能已执行的事务。

`cancel()` 中止模型信号并仅取消本轮拥有的本地任务。`activity()` 和 `hasActiveTurn()` 供桌面退出流程识别未完任务。退出需 `await shutdown()`，等待取消回合与持久化写入收尾后再关闭后端。

## 明确授权的图片输入

对话图片发送同时需要：模型 inputModalities 包含 image（兼容配置表现为 `supportsVision:true`）、模型参数 `enableVision:true`、当前请求 `allowImageUpload:true`，以及明确 `imageAssetIds`。不会自动发送所有工程资产。选中镜头存在时，图片必须属于该镜头的生产或参考素材；未选中时也仅发送明确列出的资产 ID。

每轮最多 3 张、总计 6 MB、最长边 4096 像素、每张总像素不超过 16,777,216。工程路径通过 `projectPath` 校验，拒绝绝对路径、越界与符号链接；读取前后核对字节，读取文件签名和实际尺寸，支持 PNG/JPEG/WebP。超限时明确报错，用户先导入较小素材。图片以 data URL 发送到当前配置的模型服务，不写入聊天记录。有限修复的后续请求仍使用本轮明确选中的图片，移除较早请求中的重复图片块，以确保当前请求内的图片数量和字节上限。回合只记录实际发送的 asset ID。

未启用时只有文字/素材元信息进入模型。发送原素材像素仍不代表模型观察了渲染帧。对话的 `video_inspect` 当前返回源码与元数据，运行检查回执也不能宣称视觉验收。协作工作流有独立的实际关键帧检查，见下节。模型回复误称未发送图片的视觉观察会被替换为准确的元数据说明。

## 持久媒体任务与视频网关

应用 RPC `media.generate` 接收 projectId、expectedRevision、可选 shotId、operation、prompt、可选 modelId/connectionId、imageAssetIds/allowImageUpload 与标量 parameters。operation 为 text-to-image / text-to-video / image-to-video。仅能引用已配置连接、模型和已登记工程资产，不能传入任意 Key、认证头或外部图片地址。

图片参数当前允许 size、quality、style、response_format、background、output_format、n；视频参数允许 durationSeconds、width、height、fps、aspectRatio、seed、negativePrompt。适配器按 maxDurationSeconds/maxWidth/maxHeight/maxFps 等声明进一步限制，支持能力不由任意 URL 推断。图生视频的图片以经过校验的数据内容传递，最多三张、共 6 MiB、最长边 4096，且逐项验证所选镜头/工程归属和输入哈希。

网关 HTTP 最小操作固定如下（baseUrl 以 `/v1` 为例）：

| 操作 | 方法与路径 | 语义 |
| --- | --- | --- |
| 提交 | `POST /v1/media/jobs` | clientRequestId、model、operation、prompt、inputs、parameters；同请求 ID 幂等 |
| 查询 | `GET /v1/media/jobs/{jobId}` | queued/running/succeeded/failed/cancelled，可选 progress、artifacts、error、usage |
| 提交对账 | `GET /v1/media/jobs?clientRequestId=...` | 查询响应丢失的提交，不生成新任务 |
| 远端取消 | `POST /v1/media/jobs/{jobId}/cancel` | 可选能力，以远端实际状态为准 |

Schema 和请求/响应样例位于 `docs/media-gateway-v1/`。媒体任务提交前写入稳定请求 ID、起始 revision、模型配置快照与输入哈希。响应丢失先对账，重启恢复查询；成功生成后的下载失败仅重试下载，过期产物 URL 可由远程查单刷新。同步生图没有对账接口，提交响应不确定时保留 unknown 并停止自动重投。

`media.list/get` 读取任务；`media.pause` 停止本地观察；`media.cancel` 才请求远端取消，unsupported/未确认不显示云端已取消。`media.retry` 恢复查单/下载，不重投已结束任务。任务 observation 和 remoteStatus 与本地 phase 分开：ready 是候选结果，complete 是工程采用完成。`media.apply({taskId,expectedRevision})` 通过工程队列采用当前版本，重复回执用任务来源记录对账；镜头删除或版本冲突保留结果等待处理。

图片/视频先下载、校验真实媒体再登记为工程资产。视频规范化为 CFR MP4，并通过 `video.clip.save/remove/extract` 进行主视频绑定、裁剪、变速、适应方式及原声处理。按工程帧定位和解码完成后的取帧由运行时负责；源码叠加仍可编辑。任务日志及临时签名地址保存在应用数据中，不进入 v2 工程包；已采用素材及其生成来源可以进入。

## 固定多模态协作

`workflows.run` 接收 projectId、expectedRevision、prompt、可选 shotIds、visual（code/image/video）、narration、review、allowImageUpload、可选 imageAssetIds/maxTasks/maxCost。面板提供 `workflows.list/get/retry/pause/apply`。同一工程一次运行一个协作流程，画面/配音步骤最多两个并发；媒体任务另受连接并发限制。

导演保留已有镜头 ID 并输出镜头规格；code 调用 scene 角色生成源码，image/video 创建持久媒体任务，配音通过 speech 角色或已有本地方式生成。image/video 流程保留已有代码图层；不是每个模式都会额外调用 scene 重新写源码。候选结果完整并完成已启用的视觉检查后，自动以起始 revision 提交。遇到版本冲突标记 awaiting-apply，用户显式采用时基于当前版本更新目标镜头并保留其他镜头；启用视觉检查时，重新构建候选快照并审片后再提交。目标镜头已删除时拒绝覆盖并保留产物。

视觉检查需要本轮明确授权、vision 模型图片能力与 enableVision 开关。在主工程提交之前，服务冻结候选工程、源码和素材快照，选取目标镜头中点、最多三张实际渲染帧，将帧像素发给模型并保存帧号和 SHA256。捕帧与检查执行失败时不提交候选结果；成功完成检查后仍须通过 expectedRevision 校验，防止覆盖期间的用户修改。基于最新 revision 显式采用时重新审查新候选快照，不沿用旧帧证据。检查只针对这些帧提供意见，不代表完整影片美术验收；仅查看源码或运行诊断不会记作这一步完成。

恢复复用已完成步骤；显式重试已经远端 failed/cancelled 的媒体步骤可创建新生成请求，并保留此前任务 ID。同步配音如果提交结果不确定，不自动重试收费。暂停/退出保存进度并停止本地观察，不等价于远端取消。工作流状态是 running/paused/failed/awaiting-apply/complete，与媒体任务远端状态分离。

maxTasks 提供步骤数量边界。当前文本与语音缺少可靠预报价，完整工作流费用始终标记未知；设置 maxCost 时在任何模型请求之前暂停，不能将未知费用当作零继续。媒体网关返回的 usage.cost/currency 可记录为媒体小计。步骤/模型调用耗时、生成/下载时间和下载字节用于后续对比，不能据此直接宣称多模型提升了质量或速度。

对话工具计划与协作流程仍分别执行，共用模型注册表、文本传输和工程 CAS；旧对话工具没有扩充为任意媒体编排入口。工程/视频/v2 包细节见 [架构](ARCHITECTURE.md)。

## 设计配方与验收

`packId` 可选择内置配方作为本轮简报参考；未选择时不会把所有配方塞入导演上下文。配方保持 `design_proposal`，不是已实现且已通过美术验收的风格渲染器。实际生成代码、运行检查、画面观看和媒体导出分别验收。

本地文本测试网关位于 `tests/model-gateway.ts`，媒体任务网关位于 `tests/media-gateway.ts`。`npm run verify:models` 使用隔离数据目录、localhost 网关与真实 Chromium 操作模型中心、图片/视频生成采用、视频裁剪及工作流，不调用真实供应商；它需要本机 Chromium、FFmpeg 和 ffprobe，默认浏览器为 `/usr/bin/chromium`，可用 CHROME_PATH 指定。协议与界面验收不证明真实供应商创作质量。DeepSeek 请求参数与完成原因依据[官方 Chat Completions 文档](https://api-docs.deepseek.com/api/create-chat-completion/)；本应用没有强制启用 JSON mode，因为兼容服务的支持情况不同，采用提示格式和有限修复。
