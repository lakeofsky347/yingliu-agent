/** Self-written director & virtual crew craft guidance, loaded on demand with skill_read. */
export const SKILLS: Record<string, { title: string; body: string }> = {
  'scene-structure': { title: '镜头源码结构', body: `每个镜头是一份 { html, css, js }。
- html：只写静态骨架，用 data-role 标记会被脚本改写的节点；根节点用绝对定位铺满（position:absolute; inset:0）。
- css：用 CSS 变量承载颜色、字号、位置，脚本只改变量，避免每帧重排大量样式。
- js：导出 ready(ctx)（可选，做一次性准备并校验节点存在）与 render(ctx)（每帧调用）。
- ctx 常用字段：root（DOM 根）、ctx2d（画布 2D 上下文，绘制在 DOM 之下）、params（镜头参数：text/subtitle/background/foreground/accent/fontSize/motion 等）、width/height、time（本镜头内秒数）、assets（已解码的图片等素材）、hasVideo（是否有视频底层）。
- 修改前先 shot_read_source，改完用 shot_write_source 或委派 delegate_scene_code 提交（带 expectedRevision），再 render_check。` },
  'deterministic-motion': { title: '确定性动画与帧对齐', body: `渲染是逐帧截图，必须"同一时间点 → 同一画面"。
- 动画只依赖 ctx.time，不用 Date.now()、requestAnimationFrame、setTimeout、CSS transition/animation（它们按真实时间走，导出时会错位）。
- 随机数用以镜头 ID 为种子的伪随机（ctx.helpers.random(key)），不要用 Math.random()。
- 缓动：先把进度 clamp 到 0–1，再套 easeOutCubic / smoothstep 等函数；分段动画用 (time - start) / duration。
- 入场 0.3–0.6 秒，停留时间 ≥ 文字阅读时间（中文约 4–6 字/秒），出场前留 0.2 秒余量。` },
  'layout-safe-area': { title: '版式与安全区', body: `- 文字保持在四周 6%–8% 的安全区内；竖屏（高>宽）字幕放在底部 7%–12%，避开平台按钮区域。
- 字号按 min(width,height)/1080 缩放；标题不超过两行，正文每行 12–18 个汉字。
- 对比度：正文与背景亮度对比 ≥ 4.5:1；浅色背景用深色字，复杂图片上加半透明底板。
- 同一作品统一 2–3 种颜色和 1–2 种字体（遵守已批准制片圣经中的 style）。` },
  'subtitles-voice': { title: '字幕与配音', body: `- 有多角色对白时：先在角色库为不同角色设置不同 voice，调用 generate_voice 时传入 lines=[{shotId, characterId, text, pauseAfterSeconds}]。
- 生成后用 align_to_voice(syncSubtitles=true) 自动将同镜头多句对白顺序排布（不叠音）、贴合镜头时长并生成时间轴字幕轨。
- 没有配音模型时：用 post_overlay_subtitle 建立时间轴字幕轨或写在 params.subtitle，节奏按每秒 4–6 个汉字估算时长。` },
  'self-made-visuals': { title: '导演自制画面（未接入生成模型时）', body: `- 用 SVG/Canvas 画几何插画、图标、图表、粒子、渐变光斑；用 CSS 变量和 ctx.time 驱动视差、缩放、描边动画（stroke-dashoffset）。
- 角色可以用简化的扁平造型（头身比、发型轮廓、主色），保持和计划中角色特征一致：同一角色在每个镜头用同一组颜色和轮廓。
- 背景分 2–3 层（远景色块、中景形状、前景细节），用不同速度移动，制造景深。
- 避免外链资源（字体、图片 URL）；需要图片时用素材库已有素材。` },
  'performance-pitfalls': { title: '性能与常见错误', body: `- render 里不要创建大量 DOM；在 ready 中建好节点，render 只改属性。
- Canvas 每帧先 setTransform 重置再绘制，绘制结束 restore，避免状态累积。
- 常见报错：选择器找不到节点（ready 中检查）、未处理的图片未加载（只用 ctx.assets 里已解码的图片）、源码超过 2MB。
- 每次写入后 render_check；有视觉模型时再 visual_review 或 temporal_video_review。` },
  'consistency': { title: '角色、场景与道具一致性', body: `- 开拍前在制片圣经中锁定三要素：1) 角色库（character_upsert：五官发型服装与定妆参考图）；2) 场景母版库（location_upsert：内/外景、昼夜、建筑陈设与布光参考图）；3) 关键道具库（prop_upsert）。
- 生成图片/视频时传入 characterIds、locationId、propIds，系统会自动注入全套一致性锚点并绑定参考图。
- 跨镜头连续性用 continuity_log_upsert 记录 180° 轴线方向与服装光影状态；生成后用 consistency_review 打分。` },
  'blender-previz': { title: 'Blender 3D 预演与深度控制', body: `当本机已接入 Blender 且分镜获批后，执行升级版空间预演：
- 坐标系：右手系，+X 向右、+Y 向前（景深方向）、+Z 向上（米为单位）；角色 kind="character" 支持身高 height、起止走位 position → endPos、转身 facingDeg → endFacingDeg、以及关节姿态 pose（stand/walk/run/sit/point/crouch）。
- 焦距、景深与布光：24mm 广角建景，35mm 叙事，50mm 中近景，85mm 特写（可配 fStop=2.0 + focusDistance 虚化背景）；lighting 支持 three_point / daylight / noir_rim（悬疑逆光）/ neon_night（赛博夜景）/ golden_hour（黄昏暖光）。
- Z-Depth 深度图与防污染闭环：blender_render_previz 默认同时导出白模帧 imageAssetId 与深度图 depthAssetId。审阅通过（submit_previz_review）后，切勿把灰白胶囊人直接作为普通 I2V 首帧！应先调 stylize_keyframe 融合深度/构图帧与角色场景参考图生成正式美术首尾帧，再传给 generate_video。` },
  'cinematography-blocking': { title: '电影摄影调度与 180° 轴线法则', body: `- 双人对话（正反打 Over-the-Shoulder）：先在 worldLayouts 设定角色 A（如 [-0.8, 0, 0]）与角色 B（如 [0.8, 0, 0]），摄影机始终保持在轴线同一侧（例如 Y < 0 一侧），保证镜头切换时 A 始终在画面左侧朝右看、B 始终在画面右侧朝左看，严禁无动机越轴。
- 景别递进：场次开篇用全景/远景交代场景母版（Location）与人物空间关系，情绪推进切中近景，高潮反应切 85mm 特写。` },
  'keyframe-to-video': { title: '关键帧合成与首尾帧受控生视频', body: `- 高可控影视生成黄金链路：1) 用 generate_image 生成角色定妆图与场景空镜母版并绑定到角色/场景库；2) 用 stylize_keyframe 将白模构图/深度图 + 角色图 + 场景图合成为镜头正式首帧（styledKeyframeAssetId）及大幅运镜的正式尾帧（styledTailAssetId）；3) 调用 generate_video 传入首帧与 tailImageAssetId（自动激活 first-last-frame-video），实现精准构图起幅与落幅。
- 多镜场次优先使用 batch_generate_media 打包整场戏请求，一次审批、多路并发生成。` },
  'sound-dialogue-mixing': { title: '对白表演、口型与专业混音', body: `- 对白层次：遵照 DirectorPlan 的 DialogueEvent，保留人物思考停顿（pauseAfterSeconds）与戏剧性抢话。近景说话镜头在配音完成后可调 apply_lip_sync 驱动口型对齐。
- 声音铺底与闪避：悬疑/叙事片用 synthesize_sfx(kind="ambience_hum"|"rain") 铺设环境底噪消除干瘪感；配乐入轨后必须调用 audio_mix_master(autoDucking=true, duckingDb=8, targetLufs=-14) 让对白出现时 BGM 自动平滑压低，并用 audio_analyze 检验实测 LUFS 与削波峰值。` },
  'nle-color-post': { title: '非线性精剪、调色匹配与工业交付', body: `- 转场语言：常规叙事切镜用 cut；时空跨越/回忆用 dissolve（双镜头真实叠化）；章节段落起止用 fade（黑场淡入淡出）；冲击转折用 flash_white 或 wipe_left。
- 色彩统一：不同模型生成的视频常有色温与黑位差异，用 shot_patch 设置每镜头的 colorGrade（exposure/contrast/saturation/temperature/tint/vignette）消除跳色。
- 多格式交付：成片除 export_mp4 外，可调 export_delivery_bundle 导出标准 .srt/.ass 外挂字幕以及 .otio/.fcpxml/.edl 工程文件供达芬奇/Premiere 精修。` },
};
export function skillIndex(): string { return Object.entries(SKILLS).map(([id, s]) => `${id}（${s.title}）`).join('、'); }
