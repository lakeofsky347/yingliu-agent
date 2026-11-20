# 映流智能体（Yingliu Agent）工作台设计与联动说明

本文档记录 `yingliu-agent` 从基线 `yingliu-video-studio 1.0.0` 迁入并深化智能体集成后的工作台设计与交互契约。

## 1. 界面结构与主题（Marble White / 深色模式）

- **完整工作台令牌与响应式断点**：`src/client/styles.css` 提供完整 `--vs-*` 令牌系统（深色默认 + `[data-scheme=light]` Marble White 浅色工作台）、Popover / 菜单、运行环境与对话框样式，以及 `medium` / `narrow` 响应式布局。
- **工作台内主题切换**：点击顶部 `更多操作 → 切换到浅色工作台 / 切换到深色工作台`，状态写入 `localStorage['yingliu-agent-workbench-scheme']`，并在应用启动（`src/client/index.tsx`）即同步应用，避免加载闪屏。
- **抽屉面板令牌统一**：`TaskPanel`、`HistoryPanel`、`ExportPanel` 与智能体面板共享 `--vs-*` 前景、边框和输入框变量，浅色模式下所有文字与状态条保持高对比度。

## 2. 智能体与工作台深度联动

- **唯一项目级 `AgentRunFeed`**：`Studio.tsx` 按当前打开的 `project.id` 维护唯一订阅（SSE `/events/agent?projectId=...`，断线自动退回非重叠轮询），并把 `externalRuns` / `externalLive` / `onExternalRefresh` 传入 `AgentPanel.tsx`，避免抽屉折叠或切换标签时断开监听。
- **自动回刷工程画面**：当任意智能体运行状态或步骤推进（含通过审批、工具修改工程、执行完任务），`Studio` 自动调用 `controller.refreshMediaProject()`（受 CAS 与源码草稿保护，不覆盖未保存前端源码），监视器、画布与时间线实时更新。
- **顶部状态胶囊与抽屉角标**：
  - 存在待批准工具调用或上传授权请求时，顶部显示可点击警告胶囊 `.vs-agent-pill.is-warn`（`智能体待批准`），「智能体」标签显示 `.vs-tab-dot.is-warn` 角标；
  - 有活跃运行或等待任务时，顶部显示 `.vs-agent-pill.is-busy`（`智能体运行中`）；点击胶囊直接展开抽屉并跳转到「智能体」面板。
- **导出前质检与成片报告**：`ExportPanel` 顶部展示 `.yl-export-qc` 卡片，读取 `agent.qc.last`、校对报告记录的工程 `revision` 是否与当前一致（不一致时发出警告），支持一键运行 `agent.qc`；每条已导出成片展示 `output.qa` 检查摘要。

## 3. 创作与可靠性保障

- **源码草稿持久化（`src/client/source-drafts.ts`）**。未提交的 HTML、CSS 和 JS 按工程与镜头保存。桌面端使用应用数据目录中的 `source-drafts.json`，浏览器端使用 `localStorage['yingliu-agent.source-drafts.v1']`。可以切换镜头或重开工作台，顶部提示条支持跳转和下载副本。有源码草稿时暂停预览刷新、导出和模型生成。工程版本更新后可对照最新源码再保存草稿。
- **1.2 秒防抖自动刷新预览**：主链完整且无未保存草稿或冲突时，编辑保存约 1.2 秒后调用 `controller.refreshPreview()` 在后台准备监视器预览和画布缩略图。使用 `previewing` 标识同步状态，编辑输入仍可用。
- **自定义视频风格库（`src/shared/video-style.ts`）**：支持导入 `.md` / `.txt` / `.json` / `.zip` 及风格文件夹或自定义创建；随工程复制文本快照并在导演对话、`AppSceneGenerator`、工作流及 `summarizeProject` 中引用（风格目录中的脚本与二进制不会执行）。
- **本地合成音效（`src/media/local-sfx.ts` / `audio.sfx`）**：无外部依赖的确定性 WAV 音效合成（`chime` / `tone` / `sweep` / `noise` / `whoosh` / `click`），带 `expectedRevision` 与 `requestId` 幂等回执保护，一次合成即可导入工程并加入全片音轨。
- **路径安全与跨平台原子替换**：`file-opener.ts` 将文件打开限定在工程根目录下并校验规范路径，`atomic-rename.ts` 兼容 Windows `EPERM`/`EACCES`/`EBUSY` 短暂占用的安全原子写入。
