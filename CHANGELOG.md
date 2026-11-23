# 版本记录

## 未发布

- 完成 **v2.0 第四轮审计全部边界与并发一致性修复**（并发媒体门禁、批次中断对账、子代理断点与预演审批绑定）：
  - **并发读取后策略再校验与未发批次费用核销**：`MediaTaskService` 在实际发出 HTTP 请求前再次调用 `authorizeOperation` 校验最新制作策略指纹，避免读取素材期间切换模式或往返切换后旧排队任务继续外发；本地策略拦截与未提交取消明确记 `usage.cost = 0`；`batch_generate_media` 持久化 `requestedCount` 并在中断恢复后显式列出 `submission_uncertain` 与 `not_started` 子项，同时截断超长子项错误信息保证工具回包始终在字符上限内。
  - **剧组子代理断点重试、精确重写归因与真实渲染失败回传**：`runCrewSubagent` 对检查点写失败先以原状态快照重试一次再抛出 `SubagentCheckpointError`（保留父级 `delegate_crew` 排队调用供恢复），避免误消费下一工具或重复回复；`turn_limit` 溢出跳过项通过忽略 `expectedRevision` 的参数深度比对精确核销；`render_check` 返回 `status: 'failed'` 时写入 `failedTools` 并在后续复检通过时清除；`TaskState.failedShotIds` 精确归因目标镜头失败，环境缺失或邻镜故障不再盲目重写健康目标镜头。
  - **预演审批镜头快照绑定、圣经全集合游标分页与素材导入幂等**：`submit_previz_review` 在提交审批时绑定目标镜头与工作台已批准计划哈希（`previzReview`），审批执行时若目标镜头或工作台批准状态已变更则拒绝旧单（`STALE_APPROVAL`），并保留草稿相机/深度图编辑与正式清空的预演状态；`bible_get` / `story_get` 新增 `section`、`offset`、`limit`、`textOffset` 集合与超长单条续读游标，配合 `hybridGrants` 摘要兜底保证百镜与多场景布局工程不超限；`StudioService` `import` 按内容哈希校验 `requestId` 幂等复用并在 `ProjectHub` 透传 `reusedAssetId`。
- 完成 **v2.0 第三轮审计全部 11 项边界优化与高并发确定性加固**（且完整保留场景代码检查—修复—复检核心业务闭环）：
  - **并发排期再授权与口型模板反向门禁（P1–P3）**：`MediaTaskService` 在受连接并发限制排队的 `pending` 任务真正发起远端 HTTP 请求前再次调用 `authorizeOperation` 复核最新制作策略，确保工程切回纯代码模式时排队中的未发视频请求本地拦截（远端请求数为 0），而已在途任务继续回收；专用口型模板（如 `replicate-lipsync`）反向收窄可用操作为仅 `lip-sync-video`，前置拦截误投递的普通文生视频请求。
  - **子代理拟音/尾帧幂等、同工具异目标第 7 项追踪与取消质检诚实回传（P2）**：`StudioService` `import` 新增 `requestId` 哈希幂等复用（`importRequests`），`synthesize_sfx` 与 `frame_handoff` 绑定执行 ID 且子代理检查点出队与 `usage.toolCalls` 合并为单次原子落盘，消除子步骤崩溃重放重复生成 WAV 素材或虚增调用计数；同轮第 7 项溢出跳过的同名不同目标写工具（如第 1 项改镜 1、第 7 项改镜 2）按目标签名与轮次隔离对账并保留原始 `callId`；子代理内 `render_check` 被取消或超时时诚实标为未通过（若同次委派后续复检通过则自动清除，100% 保留 `scene_coder` 核心编码修复闭环）；补齐 `video_clip_extract`、`video_clip_remove` 与 `audio` 在镜头沙箱下的越界门禁。
  - **满额批次回执核销、邻镜报错归因、改镜草稿预演隔离与 7 图身份保留（P2–P3）**：`batch_generate_media` 全部子项回执均已落盘后若在最终总回执写入前中断，重启恢复不再虚增额外 `unknownCostCalls` 或失败数；无头预览报错标注具体 `shotId` 并在 `generateSceneCode` 检测到仅相邻镜头历史故障时跳过对健康目标镜头的盲目二次重写；工作台未批草稿已改写分镜提示词或自带预演图时，批准旧计划预演不再覆盖草稿画面与状态；角色已有 6 张辅助参考图并绑定第 7 张独立主身份图时，`Story -> DirectorDocument` 回写不再截断丢失主身份图。
  - **百素材确定性游标分页、24 角色自适应分页与高并发测试隔离（P2）**：`summarizeProject` 按工程原始素材顺序严格游标切片（消除按引用重排导致的翻页重复/遗漏与 0 镜 100 素材死循环，末页不再返回 `nextAssetOffset`）；`story_get` 与 `bible_get` 新增 `characterOffset` / `characterLimit` 与多角色群像自适应分页；全量 v2 测试隔离 `projectsDirectory` 并加固句柄释放，消除高并发偶发抖动与进程驻留。
- 完成 **v2.0 二轮复审全部 14 项次生边界问题清零加固**：
  - **制作策略入轨复核与口型模板能力门禁（P0）**：`ProjectHub.mediaPort` 接入 `authorizeOperation` 并在 `applyMediaResult` / `video.clip.save` 入轨前实时复核当前 Schema v3 `assertProductionOperation`（切换纯代码模式后保留历史生成素材可查，但拦截新视频计费请求与旧视频重新激活镜头）；新增 `templateAcceptsLipSync` 校验异步模板是否同时包含视频与配音占位符，在发出请求前阻断不具备口型能力的普通视频模板。
  - **受限部门字幕保护、名额预留、原子检查点与跳过回执（P0–P3）**：限定 `scopedShotIds` 时 `post_overlay_subtitle` 仅替换授权镜头字幕并严守范围外字幕与全局音轨不变性；`delegate_crew` 预留外层工具名额确保总调用次数不超 `maxToolCalls`；检查点持久化 `completedResult` 并随父队列 `settleToolSuccess` 同一次落盘原子清理，消除极端崩溃恢复重复写入窗口；新增 `skippedTools` 区分前置跳过（`skipped`）与单轮上限溢出跳过（`partial`）。
  - **媒体异常回传、预览取消门禁、多素材授权展示与终态串行收件（P1–P3）**：下载 404 导致本地观察 `paused` 时父运行及时退出等待并向上回传；`autoApply` 失败诚实标记 `apply_failed` 并计入未完成项；批次子项受理即刻记入未知费用并在中断重启后继续由 `waitingBatch` 跟踪已知首项；`generateSceneCode` 仅在宿主预览记录为 `complete` 时报告通过校验（取消或超时明确报错）；`AgentPanel` 展示口型同步等全部待上传素材名称、类型与目的地；`complete()` 写轨迹与落盘期间收到 `sendMessage` 自动中止收尾回到主循环。
  - **草稿字段级增量合并、视频参考/身份绑定无损回写与百镜多素材分页（P1–P2）**：资产/场记更新与单镜预演批准对工作台未批草稿按实际变更字段做局部合并，保留草稿角色身份等用户编辑；`Story -> DirectorDocument` 与 `.yingliu` 备份完整保留合法视频运动参考（`motion`）与非首张定妆图身份绑定（`identityAssetId`）；子代理工具回包上限提升至 `12,000` 字符，`summarizeProject` 支持 60+ 素材紧凑分页保真指定镜头页，`bible_get` 与 `story_get` 新增百镜分页参数。
- 完成 **v2.0 工具与团队通信安全/一致性 16 项审计闭环加固**：
  - **剧组子代理硬边界与持久恢复**：`runCrewSubagent` 新增参数级 + 提交级双层 `scopedShotIds` 镜头范围硬拦截（阻断越界改镜与全局重构图）、每步实时校验父运行与项目 `budgetLimit` 并累计 `steps`/`toolCalls`、子步骤级持久断点回执 `subagentCheckpoints`（中途中招 503 恢复后不重复执行已落盘写入）、严格 1:1 配对溢出 `tool_calls`、区分 `complete`/`partial`/`failed`/`step_limit_partial` 状态并同步最新 `revision`；总导演结束前复查排空 `pendingUserMessages` 防止临终纠偏丢失。
  - **批次回执、多目标授权与真实媒体流通道**：`batch_generate_media` 增加全子项前置合法性与策略预检、逐子项持久回执 `batchReceipts` 复用及逐项独立核销 `unknownCostCalls`；`referenceGrants` 升级为按 `(execId, role, fingerprint)` 分组保存，消除生图+生视频双目的地上传授权乒乓死锁；`apply_lip_sync` 改为通过 `MediaProjectPort.readMediaAsset` 直接流式读取工程内真实大小音视频并纳入外发授权，消除 4,000 字符参数限制；`delegate_scene_code` 严格绑定初始 `baseRevision` 乐观锁并同步等待无头渲染校验与单轮报错自修复；修复采用视频与保存片段把 Schema v3 降级为 Schema 2 的问题。
  - **制片圣经草稿隔离、百镜分页、CLI 视觉开关与时间线自寻址**：工作台保存未批草稿不再覆盖已批准 `Story` 或在美术同步时被误提权为 `approved`；补齐 `DirectorDocument ↔ Story` 与 `.yingliu` 备份还原对摄影参考、`native` 音频策略、逐拍表演、对白事件、镜头事件及验收条件的无损保留；`project_get` 支持 120 镜自适应分页且保证始终返回合法可解析 JSON；CLI `agent run` 新增 `--allow-images` 开启远程视觉与 5 帧时序审片；导出 `.otio` 与 `.fcpxml` 改为按时间线所在导出子目录计算相对素材路径（`../../assets/...`），并实现 59/59 全工具入口回归覆盖。
- 升级智能体至 **v2.0 全链路虚拟影视剧组架构（Full-Spectrum Virtual Film Crew）**：
  - **分层剧组编排**：以 `AgentService` 作为总导演（Showrunner），新增 6 大专业部门子代理（`screenwriter`、`art_director`、`cinematographer`、`scene_coder`、`sound_director`、`post_editor_qc`）与 `delegate_crew` / `delegate_scene_code` 委派机制，收费与导出门禁统一收口至总导演。
  - **统一制片圣经与百镜分镜容量**：双向打通 `Story` 与专业契约 `DirectorDocument`（`project.extensions.directorDocument`），单轮分镜上限由 12 镜提升至 120 镜；新增固定场景母版库（`locations`）、关键道具库（`props`）、三维世界坐标（`worldLayouts`）与 180° 轴线场记日志（`continuityLog`）。
  - **Blender 3D 预演升级与防白模污染桥梁**：预演支持关节化人物 6 种姿态、起止走位动画、物理光圈景深 `fStop`、5 套电影布光预设及归一化 Z-Depth 深度图导出；新增 `stylize_keyframe`（`image-compose` 多图融合重绘）生成正式画风首尾帧。
  - **多模态扩展原语与场次并发池**：新增 `image-compose`、`first-last-frame-video`（适配网关、可灵、火山 Seedance、百炼万相、Gemini Veo 首尾帧字段）与 `lip-sync-video`（含 `replicate-lipsync` 预设）；新增 `batch_generate_media` 支持单次审批并发生成多镜头并自动入轨。
  - **分角色表演与专业闪避混音**：`generate_voice` 支持按角色专属 `voice` 路由，`align_to_voice` 支持同镜多句对白顺序话轮排布与全局字幕同步；`synthesize_sfx` 扩充至 12 种电影拟音；`AudioMixer` 新增 `sidechaincompress` 自动闪避、人声空间混响与 `-14 LUFS` `loudnorm` 标准化；新增 `audio.analyze`（`ebur128` 实测响度/削波）与 `media.deconstruct`（`scdet` 视觉拉片切镜拆解）。
  - **后期精剪 NLE、时序审片与工业交换交付**：渲染运行时支持双镜真实叠化 `dissolve`、`wipe_left`、`flash_white`、逐镜调色 `colorGrade`、画中画 `overlayClips` 与全局字幕 `subtitles`；新增 `shot_take_manage` 多候选条管理、`reframe_project` 多画幅智能重构图、`temporal_video_review` 5 帧时序宫格审片及 `export_delivery_bundle`（导出 `.srt` / `.ass` / `.otio` / `.fcpxml` / `.edl`）。
- 迁移 `yingliu-video-studio 1.0.0` 工作台视觉与交互能力：补全 Marble White 浅色工作台与全部抽屉面板主题令牌、工作台菜单主题切换（持久保存）、资源拖拽/空分类回退到「全部」、导出前与草稿/冲突防呆、画布 1.2 秒防抖后台自动刷新预览、窗口/标签卸载前冲刷源码草稿。
- 源码草稿按工程与镜头持久化。桌面端存入应用数据目录，浏览器端存入 `localStorage`，保留版本基准并支持对照旧版草稿和从清单跳转。
- 新增自定义视频制作风格库（支持 Markdown/TXT、JSON、ZIP 风格包与风格文件夹纯文本导入，风格副本随工程保存并注入创作对话、分镜/场景生成、协作工作流与智能体工程摘要）；CLI 新增 `yingliu styles list` 与 `yingliu project create --style <id>`。
- 新增工作台本机确定性合成音效（`audio.sfx` 端点与 `LocalSfxPanel`，支持 `requestId` 幂等重放检验）及导出面板 `agent.qc.last` / `agent.qc` 版本校对卡片与成片 `qa` 摘要展示。
- 深化智能体与工作台集成：`Studio` 维护单项目 `AgentRunFeed`，步骤或状态推进自动刷新画面与时间线，顶部显示「智能体待批准／智能体运行中」可点击状态胶囊。
- 路径打开限制至工程根目录内（`projectOpenPath`）与跨平台临时文件 UUID + `atomicRename` 安全替换；去除工作台冗余顶栏 `.yl-editor-heading` 释放垂直视口。
- 新工作区的文本与视觉理解快速配置预填 OpenAI，分别保存端点、模型和凭据。已有 DeepSeek 和自定义设置可继续使用。
- 创作对话、场景代码和智能体规划的请求使用文本。明确授权的素材图和审片帧交由视觉角色处理，图生视频的参考图交由视频生成角色处理。
- 新工作区提供可跳过、可从应用顶部重新打开的新手引导，覆盖模型设置、新建影片和预览导出。
- 切换接口站点时要求为新站点设置密钥或先清除旧密钥。协作制作分别确认审片帧与图生视频参考图的发送权限。
- 素材生成面板可以选择已配置的异步生图／生视频模型。图生视频选择器和提交前校验会核对模板是否接收参考图。
- 取消或刷新预览时及时关闭读取中的资源文件，避免快速切换导致预览服务退出。

## v1.1.0 — 2026-10-28

应用包版本自 0.5.0 统一为 1.1.0（`package.json`、验收摘要 `deliveryVersion`、验收报告版本号同步）。本版本合并：v1.0.0 主施工（PR #5）、Tauri P0 试验与加固（原 PR #4/#6，实验性质）以及以下修复。

主要内容（v1.0.0 主施工，详见上节与 `docs/DELIVERY-v1.0.0.md`）：
- Workflow 耐久回执与故障恢复复用、单一所有者（CLI/桌面/浏览器/默认服务共用锁）、渲染运行时哈希资源与原子发布、三平台原生与媒体验收。

修复：
- 锁端口碰撞误报 BUSY：锁协议升级为 v2（1 个主端口 + 3 个备用端口，按身份键区分），不同数据目录哈希到同一端口时不再误报；旧版 v1 持有者仍按 BUSY 处理，保持互斥。
- 桌面端启动时遇到 BUSY 不再静默退出：弹出对话框，可重试、等待（最长 60 s）或退出。
- 智能体导入尾帧图片/本地合成音频时，若工程版本在读取与导入之间被用户修改，自动重新读取并重试（最多 3 次，不会重复导入）。

实验性（默认不启用，不参与 Electron 构建与打包）：
- Tauri 2 壳（`src-tauri/`）+ Node SEA/Bun sidecar、场景隔离 worker、合成凭据迁移事务、P0 测量/故障演练脚本与证据、`Tauri P0 spike` CI 工作流。结论与门槛状态见 `docs/p0/REPORT.md`：Linux 空闲内存门槛未通过（+46%），其余平台与多项门槛未测；**Electron 仍是默认且唯一受支持的桌面壳**。

已知限制：发行构建未签名、未公证；未在干净机器上验证安装；未使用真实付费供应商验收。

## v1.0.0 交付说明 — 2026-10-28

应用包版本保持 0.5.0，本节使用用户指定的本轮提交标识。完整说明见 `docs/DELIVERY-v1.0.0.md`。

- Workflow 耐久写入与独立文本/音频成功回执，故障恢复复用已成功结果；按工程采纳记录对账。
- CLI、桌面、浏览器及默认应用服务共用所有权，覆盖实际外部工程根目录；启动失败与重复关闭保留清理边界。
- Replicate 官方模型路径分段编码，社区模型新增指定版本入口；通用变量和任务 ID 仍整体编码。
- 纯本地文本费用情景试算；缺失单价/用量和币种不匹配保留未知，账本历史币种保护。
- 三平台原生与媒体验收工程、实际 sandbox/系统凭据检查、阶段数据隔离与允许字段摘要；修复 Windows 浏览器预检、原生截图超时与 Linux 钥匙环清理。
- 工作流完成态尾部和关闭期间的请求排空；预览版本的窗口消息隔离与成功帧清除错误状态。
- CLI所选目录锁等待时间也用于后续实际工程根目录，并保留取消边界；默认嵌入服务继续立即检查冲突。
- 无界面取帧固定灰阶文字、完整合成阶段与软件合成，严格复验默认三分镜的首帧、逆序和冷启动；编辑器配置不变，新增WebGL1/2实际读回回归。
- 运行时scene/core/spec使用不可变哈希资源，index最后原子发布；HTTP大小与正文来自同一文件句柄，避免刷新时读空文件或截断响应。
- 哈希运行时资源完整字节相等时复用，有界读取并在修复前关闭句柄；缺失/损坏仍耐久原子发布，避免重复替换引发 Windows EPERM/rename。
- Windows运行时发布只针对实际EPERM/rename设置次数和单调时间上限，保留完整原子写入、index最后发布与原错误；不重试任务、模型或全局付费回执。
- 源码编辑器取得实际源码前不显示可编辑空框；迟回旧镜头忽略，已加载草稿继续保护。
- 场景写入实际文本与字号后重新等待布局和字体就绪；保留严格PNG哈希，失败时增加阶段、帧和有界像素聚合诊断。
- 媒体轮换密钥与后台任务fixture改用实际请求、终态和日志一致条件，消除固定延时或轮询次数对Windows调度速度的假设。
- 任务失败补充固定类别、操作和IO字段，journal恢复与上传摘要二次白名单；不改变任务、审批、重试和严格哈希判据。
- Tauri 已知阻塞在独立试验分支修复；正式迁移、真实供应商、发行签名和干净机器安装仍待分别验收。

## 未发布 — 2026-10-27

- 以远端 `main@5ff743e` 同步开发基线，保留 CLI、Electron HTTP 安全与预览恢复修复；施工计划和验证记录见 `docs/DEVELOPMENT-PLAN-2026-10-27.md`。
- 同工程智能体生命周期排队并重新检查占用；每个工具执行前检查项目累计预算，已批准调用仍受上限约束。
- 角色库与预算草稿纳入切面板、首页、切工程及关闭保护，提供保存/放弃操作；轮询保留编辑值，旧工程异步响应失效。
- 智能体启动、批准、拒绝和恢复先检查保存结果与草稿；实时事件流关闭后回落为不重叠的轮询。
- 素材导入、音轨修改强制 `expectedRevision`；客户端、内部登记和验收脚本同步传入版本。
- 同步媒体生成成功后复用持久产物进行下载/检查重试及重启恢复，避免将本地回执 ID 当作远端任务查询；恢复不重投生成请求。

## 0.5.0（映流智能体）— 2026-10-22

从 yingliu-studio 拆分为独立仓库 yingliu-agent：应用名「映流智能体」、包名 `yingliu-agent`、独立数据目录（appData/yingliu-agent、~/Documents/YingliuAgentProjects）、macOS 标识 `local.yingliu.agent`、浏览器开发端口 19440；固定流程保留为 `run_workflow` 宏工具。功能同下方 0.5.0。

## 0.5.0 — 2026-10-22

结构化创作计划与一致性（方案见 docs/ROADMAP-0.5.md）：
- 每个工程有一份 `story.json`，记录剧本、风格设定、角色库、分镜表和一致性分数。新增风险级别 `plan`，`plan_story` / `plan_shots` 默认需要审批，审批卡片用结构化视图展示；已批准的计划会注入导演的系统提示。
- 角色库：可见特征和参考图。`generate_image` / `generate_video` 传 `characterIds` 时自动拼接风格与角色锚点；`useReference` 可以用角色参考图作首帧。
- `consistency_review`：视觉模型按镜头打 0–100 分并写入计划；低于阈值只给出重生建议，重生仍需审批。
- 项目级账本：花费跨运行累计、按工具分项、可设项目上限。超过上限的收费调用强制审批，花费达到上限时停止运行。
- 导出前质检 `quality_check`：检查黑帧/纯色帧（PNG 亮度分析）、静音、字幕越界与配音超出镜头、时长偏差、一致性低分。`export_mp4` 遇到严重问题时拦截导出。
- `frame_handoff`：取上一镜尾帧作为下一镜首帧。`align_to_voice`：按配音时长调整镜头时长。
- `skill_read`：自写的导演技能文档，共 7 个主题。
- 智能体面板新增：计划审批视图、创作计划与分镜表（含一致性分数）、角色库编辑、项目预算、质检结果；「创作计划无需审批」开关。
- 0.4.0 已冻结为标签 `v0.4.0`。

## 0.4.0 — 2026-10-22

智能体应用：原生函数调用协议与工具注册表、AgentService 规划-执行-反思循环、风险分档审批（收费生成和导出必须确认）、断点恢复、预算账本与重试、SSE 推送与「智能体」面板、视觉自检闭环、上下文压缩、JSONL 轨迹、密钥脱敏与不可信素材标记。不支持工具调用的模型自动降级为计划 JSON。详见 docs/AGENT.md。另修复配音超时计时器被 unref 导致测试取消的问题。

多模态接入：新增可配置的 `async-task` 协议模板，内置通义万相（图/视频）、可灵、火山方舟/即梦 Seedance、Runway、Replicate、ElevenLabs 音效、OpenAI 兼容 TTS 预设；新增 music/sfx 角色；模型中心可选模板并做不计费的连通性检查。智能体按已绑定角色热更新工具列表：未接入生成模型时由导演用代码自制画面并本地合成简单音效，接入后生成工具自动激活，收费调用仍需批准。

## 0.2.0 — 2026-10-06

完整本地使用流程：项目首页、创作简报、手动分镜与真实模型配置、对话讨论/构建/修改、素材和源码、任务重试、成片历史、工程备份与恢复。

- 正常模型通道默认 DeepSeek/自定义；去除展示式离线助手，fixture 仅供测试。
- 先校验整次导演计划，再一次事务提交；持久回合记录和中断/取消/重试。
- 工程与全部源码的不可变版本、原子状态指针、投影修复和持久 Undo/Redo。
- 复制、改名、归档和恢复；带内容清单与有界解压的 `.yingliu` 备份。
- 按输入 revision 固定导出源码；保存和源码草稿保护，关闭前保存与任务退出选择。
- 本地工具实际执行检查；场景独立 renderer、十秒响应 watchdog、无限循环恢复。
- 60 项回归、21 项原生、14 项应用包检查；实际六秒带合成音 MP4 编码、完整解码和原生播放。

macOS 本机包仍使用临时签名；Chrome/FFmpeg 由本机提供，真实供应商和跨机器发行分别待验收。

## 0.1.0 — 2026-10-06

从 dsh-video-studio 与 frontend-video-foundation 提取独立桌面入口、工程编辑器和本地制作链路，建立本地仓库及对应私有远端。
