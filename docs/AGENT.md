# 智能体设计文档（v2.0 · 全链路虚拟影视剧组架构）

映流智能体（`yingliu-agent`）将**总导演智能体（Showrunner）与六大专业剧组子智能体**作为主工作台的一等公民引擎。用户输入影视创作目标后，智能体围绕**统一制片圣经（Unified Production Bible）**协同推进「剧作拉片 → 3D 预演与深度图 → 风格化首尾帧重绘 → 场次并发视效生成 → 分角色对白与闪避混音 → 时序动态审片与工业后期交付」，并支持流式输出、多轮续聊与运行中实时纠偏。

## 六阶段全链路影视制作流水线

```
阶段 1：剧作拉片与制片圣经   analyze_reference_video / plan_story / plan_shots（1–120 镜，双向同步 DirectorDocument）
          ↓
阶段 2：美术母版与 3D 预演   location_upsert / prop_upsert / blender_render_previz（关节姿态、演员走位、浅景深 fStop、电影布光、Z-Depth 深度图）
          ↓
阶段 3：用户审阅空间预演     submit_previz_review（审批卡片直接预览白模帧、深度图与动态预演 MP4，零付费 API 损耗）
          ↓
阶段 4：关键帧桥梁与并发视效  stylize_keyframe（防白模材质污染）→ batch_generate_media / generate_video（首尾帧受控） / delegate_scene_code
          ↓
阶段 5：分角色表演与专业混音  generate_voice（按角色音色路由）→ align_to_voice（多句顺序话轮，不叠音）→ apply_lip_sync → audio_mix_master（侧链闪避 + -14 LUFS）
          ↓
阶段 6：动态审片与工业交付   shot_patch（双镜叠化/调色）→ temporal_video_review（5 帧宫格审片）→ quality_check → export_mp4 / export_delivery_bundle
```

## v2.0 核心架构演进

### 1. 分层虚拟影视剧组（Showrunner + 6 部门专业子代理）
总导演 `AgentService` 负责全局叙事把控、预算与审批门禁（`plan` / `cost` / `export` 权限仅由总导演统一触发），并可通过 `delegate_crew` 将高频局部精修委派给隔离上下文的 6 个专业子代理（`src/agent/subagents.ts`）：
- **`screenwriter`（剧作与拉片分镜师）**：参考样片 `scdet` 切镜节奏分析、1–120 镜分镜编排与场记连续性维护。
- **`art_director`（美术与资产设定师）**：全片色彩体系、角色特征库、固定场景母版库（`Locations`）与关键道具库（`Props`）。
- **`cinematographer`（3D 预演与摄影指导 DP）**：焦距景别、光圈景深、180° 轴线规则、演员走位调度与 Blender 预演深度图渲染。
- **`scene_coder`（动态图形与场景代码师）**：优先路由至已绑定的 `scene` 角色模型，编写帧确定性 HTML/CSS/SVG/Canvas 源码并执行 `render_check` 自修复。另提供单镜快速委派工具 `delegate_scene_code`。
- **`sound_director`（声音与对白表演师）**：多句对白话轮顺序排布、12 种程序化拟音合成、侧链自动闪避（Auto-Ducking）与 `-14 LUFS` 响度实测。
- **`post_editor_qc`（精剪调色与多模质检师）**：双镜叠化/擦除/闪白转场、逐镜曝光/色温/对比度/暗角调色、候选条 Takes 优选、画中画叠加、多平台画幅重构图及 5 帧时序宫格审片。
- **剧组沙箱与持久断点护栏**：子代理受参数入口 + 宿主提交双层 `scopedShotIds` 硬边界保护（禁止越界改写非委派镜头或全局重构图），每步实时受父运行与项目 `budgetLimit` 熔断治理，并具备子步骤级持久回执 `subagentCheckpoints`（故障恢复不重复已成功的写入）与严格 `tool_calls` 1:1 响应配对。

### 2. 统一制片圣经（Unified Production Bible）
- 彻底打通 `Story`（`agent-data/stories/<projectId>.json`）与专业契约 `DirectorDocument`（`project.extensions.directorDocument`，`src/director/contracts.ts`）的双向实时同步。
- 突破单轮 12 镜硬上限，完整支持 **1–120 镜**中短片叙事规模。
- 新增一等资产实体：**固定场景母版库（`locations`：内/外景、昼夜、建筑陈设、光影基调与参考图）**、**关键道具库（`props`）**、**三维世界坐标锚点（`worldLayouts`）** 与 **180° 轴线场记日志（`continuityLog`）**，并在生图/生视频时自动注入角色 + 场景 + 道具三维一致性锚点。

### 3. 3D 预演升级与「白模→成片」防污染重绘桥梁
- **Blender 确定性 3D 预演升级**（`src/host/blender.ts` + `blender-previz-template.py`）：支持关节化人体模型与 6 种表演姿态（`stand` / `walk` / `run` / `sit` / `point` / `crouch`）、起止坐标与朝向插值走位（`position → endPos`）、物理相机景深光圈（`fStop` / `focusDistance` / `rollDeg`）、5 套电影布光预设（`three_point` / `daylight` / `noir_rim` / `neon_night` / `golden_hour`），并同步导出归一化 **Z-Depth 空间深度图（`depth.png`）**。
- **风格化关键帧桥梁 `stylize_keyframe`**：将预演深度图/构图帧与角色定妆图、场景母版图经多图融合（`image-compose`，不支持多图输入时自动回退强锚点文生图）重绘为正式电影画风首帧（`styledKeyframeAssetId`）与尾帧（`styledTailAssetId`），避免灰白 3D 塑料材质直接污染图生视频。

### 4. 首尾帧受控生成、场次并发池与口型同步
- **扩展媒体原语**：`MediaOperation` 新增 `image-compose`（多图融合重绘）、`first-last-frame-video`（首尾双关键帧受控视频生成，原生适配 `video-gateway`、可灵 `image_tail`、火山 Seedance `last_frame`、百炼万相 `last_frame_url`、Gemini Veo `lastFrame`）与 `lip-sync-video`（音频驱动口型同步，内置 `replicate-lipsync` 模板预设）。
- **场次并发调度池 `batch_generate_media`**：单次审批即可并行投递最多 8 个镜头的生图或生视频任务，`waitForMediaTasks` 并发等待全部任务收敛，支持 `autoApply=true` 自动按序绑定入轨。

### 5. 分角色对白、程序化拟音与专业闪避母带
- **分角色音色与顺序话轮**：`generate_voice` 自动按 `characterId` 匹配角色专属 `voice` 音色；`align_to_voice` 将同镜头内多句对白按先后顺序排布并留出自然句间停顿（`interLineGapSeconds`，彻底消除多句叠在 `0s` 的问题），同时可一键同步生成全局精确时间轴字幕轨。
- **12 种本地确定性拟音（`synthesize_sfx`）**：在原有 6 种基础上新增 `rain`（夜雨环境）、`heartbeat`（悬疑心跳）、`footstep`（脚步声）、`riser`（情绪抬升）、`sub_drop`（重低音震击）、`ambience_hum`（空间底噪）。
- **专业闪避与响度母带（`AudioMixer` + `audio_mix_master` + `audio_analyze`）**：基于 FFmpeg `sidechaincompress` 实现人声出现自动压低 BGM（Auto-Ducking），支持 `room`/`hall`/`phone` 空间人声处理与 `loudnorm`（默认 `-14 LUFS`）响度标准化，并提供 `ebur128` 实测响度与削波检测（未配置 `audioMix` 时保持旧版滤镜链字节级兼容）。

### 6. 后期精剪 NLE、5 帧时序审片与工业交换格式交付
- **确定性渲染运行时升级（`src/runtime/browser.ts`）**：原生支持双镜头真实叠化 `dissolve`、左向擦除 `wipe_left`、闪白 `flash_white`、逐镜头调色 `colorGrade`（曝光/对比度/饱和度/冷暖色温/色调/暗角）、B-Roll 画中画叠加层 `overlayClips` 与全局时间轴字幕 `subtitles`。
- **时序动态审片 `temporal_video_review`**：纯 Node `zlib` 确定性拼合镜头 0%/25%/50%/75%/100% 连续 5 帧（加切镜交界帧）为带进度条的宫格联系表 PNG（`src/host/contact-sheet.ts`），交由视觉模型检查运动崩坏、闪烁与 180° 越轴。
- **工业级后期交付包 `export_delivery_bundle`**（`src/media/delivery.ts`）：除直接导出 MP4 成片外，支持在工程 `exports/` 目录一键生成 `.srt`、`.ass` 字幕以及 OpenTimelineIO（`.otio`）、Final Cut Pro XML（`.fcpxml`）与 CMX3600（`.edl`）时间轴工程交换文件，无缝衔接达芬奇、Premiere、Final Cut 与剪映。

## 模块索引

| 模块 | 文件 | 作用 |
| --- | --- | --- |
| 协议与流式 | `src/agent/model-client.ts` | OpenAI 兼容 `tools` / `tool_calls`、SSE 流式增量与 `plan-json` 自动降级 |
| 剧组子代理 | `src/agent/subagents.ts` | 6 大专业影视部门子代理规格、工具白名单隔离与有界执行器 |
| 工具注册表 | `src/agent/tools.ts` | 59 个全链路影视工具（含风险分级、参考图收集、锚点注入与质检） |
| 编排与并发池 | `src/agent/service.ts` | 主循环、只读工具 4 路并行、`waitingBatch` 多路媒体并发池、上传授权挑战、审批与预算护栏 |
| 统一制片圣经 | `src/agent/story.ts` / `src/director/contracts.ts` | 剧本、角色、场景母版、道具、世界坐标、场记与 120 镜分镜双向同步 |
| 3D 预演与深度 | `src/host/blender.ts` / `blender-previz-template.py` | 关节姿态、走位动画、景深光圈、电影布光与 Z-Depth 深度图无头渲染 |
| 时序联系表 | `src/host/contact-sheet.ts` | 纯 Node `zlib` PNG 编解码与多帧进度宫格拼图 |
| 拉片与声学分析 | `src/media/deconstruct.ts` | FFmpeg `scdet` 镜头切点节奏分析与 `ebur128` 实测响度/真峰值/静音检测 |
| 后期交换交付 | `src/media/delivery.ts` | `.srt` / `.ass` / `.otio` / `.fcpxml` / `.edl` 标准格式生成器 |
| 专业混音与渲染 | `src/host/audio.ts` / `src/runtime/browser.ts` | 侧链闪避、`loudnorm` 混音总线及双镜叠化、调色、画中画与全局字幕确定性渲染 |

## 59 项全链路工具矩阵

| 领域 | 工具名称 | 风险 |
| --- | --- | --- |
| 感知与拉片 | `project_get` `bible_get` `story_get` `shot_read_source` `env_check` `task_status` `styles_list` `skill_read` `analyze_reference_video` | `read` |
| 圣经与策略 | `request_production_policy` `plan_story` `plan_shots` `bible_save_plan` `submit_previz_review` | `plan` |
| 美术与场记 | `character_upsert` `location_upsert` `prop_upsert` `continuity_log_upsert` `project_set_style` | `write` |
| 分镜与委派 | `shots_mutate` `shot_patch` `video_update` `shot_write_source` `delegate_scene_code` `delegate_crew` | `write` |
| 3D 预演 | `blender_render_previz` | `write` |
| 多模态视效 | `generate_image` `stylize_keyframe` `generate_video` `batch_generate_media` `apply_lip_sync` `run_workflow` | `cost` |
| 素材承接 | `media_apply` `frame_handoff` `asset_remove` | `write` |
| 声音与混音 | `generate_voice` `generate_music` `generate_sfx`（`cost`）；`align_to_voice` `synthesize_sfx` `audio_edit` `audio_mix_master`（`write`）；`audio_analyze`（`read`） | `cost` / `write` / `read` |
| 后期精剪 NLE | `video_clip_save` `video_clip_remove` `video_clip_extract` `shot_take_manage` `post_overlay_subtitle` `reframe_project` `undo` `redo` | `write` |
| 审片与质检 | `render_check` `capture_frame` `visual_review` `temporal_video_review` `consistency_review` `quality_check` | `read` |
| 成片与交付 | `export_mp4` `export_delivery_bundle` | `export` |

## 验证范围与尚未验收边界

- **已通过本地与协议回归验证**：`tests/agent-v2-full-spectrum.test.ts`、`tests/agent-v2-audit-remediation.test.ts`、`tests/agent-v2-audit-recheck-closure.test.ts` 与全量 652 项测试套件使用本机真实 FFmpeg / ffprobe / Chromium / Blender（可用时）与本地脚本化协议网关，实现 **59 / 59 全工具入口回归覆盖**，覆盖 16–120 镜与 60+ 素材制片圣经/部门分页读取、草稿字段级增量合并与视频运动参考/多图身份绑定无损往返、剧组子代理范围外字幕/镜头沙箱与崩溃恢复幂等、口型模板能力门禁与制作模式切换入轨复核、下载 404/采用冲突/预览取消诚实回传、终态收件串行化、CLI `--allow-images` 远程视觉时序审片及时间线自相对素材路径导出，**零外部计费 API 请求**。
- **尚未验收（不作为真实模型质量声明）**：真实付费商业大模型（DeepSeek / OpenAI / Gemini / 可灵 / 即梦 Seedance / ElevenLabs / Replicate 等）在线长片多轮编排稳定性、生成画质审美、真实口型自然度与跨平台发行签名公证仍需使用真实账户单独验收。
