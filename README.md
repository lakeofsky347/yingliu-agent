# 映流智能体（`yingliu-agent`）

**由导演智能体驱动的本地视频创作应用与无头命令行：自主规划、工具执行、人类审批、实时画布联动与本地 MP4 导出。**

`yingliu-agent`（当前版本 **1.1.0**）是映流系列的**智能体旗舰版**。它在完整独立桌面工作台（已对齐基座 1.0.0 全部工作台能力）之上，将**导演智能体循环**与**可视化分镜工作台**深度打通，并附带可供其他 AI 智能体和自动化脚本直接调用的 **`yingliu` Headless CLI**。

> **映流三仓库对照（选哪个？）**
>
> | 仓库 | 形态 | 适合场景 |
> | --- | --- | --- |
> | `yingliu-video-studio` | DSH Desktop 插件（v1.0.0） | 已在使用 DSH，希望在会话旁直接打开工作台并联动 DSH 会话／子代理 |
> | `yingliu-studio` | 独立 Electron 桌面应用（v0.5.0） | 不依赖 DSH，偏好由人一步步手动推进的独立桌面工作台 |
> | **`yingliu-agent`（本仓库）** | 智能体独立桌面应用 + CLI（v1.1.0） | 希望导演智能体自主规划、执行、质检并与工作台实时联动，或用 `yingliu` CLI 自动化出片 |
>
> *与 `yingliu-studio` 可同时安装：数据目录（`yingliu-agent`）、默认工程目录（`~/Documents/YingliuAgentProjects`）与浏览器开发端口（`19440`）完全隔离，也可通过 `YINGLIU_DATA_DIR` / `YINGLIU_PROJECTS` 自定义。*

---

## 快速开始

### 环境要求
- **运行源码 / CLI**：Node.js ≥ 22.18
- **渲染预览与导出 MP4**：本机安装 Chrome / Chromium、FFmpeg 与 ffprobe（首页与 `yingliu doctor` 会自动探测，也可在工作台 **运行环境** 手填绝对路径）
- **Blender 3D 白模预演（可选）**：本机安装 Blender（建议 ≥ 3.6）后，智能体自动激活白模预演能力，在分镜确认后先做 3D 白模场景/运镜预演供审阅，通过后再交给创作模型实际呈现

### 方式 A：启动桌面应用或浏览器界面

```bash
npm ci
npm start        # 启动 Electron 桌面窗口（密钥经系统 safeStorage 加密保存）
# 或
npm run dev      # 启动本地浏览器服务，默认 http://127.0.0.1:19440（密钥仅存内存）
```

> 首次打开空工作区会自动弹出可跳过的 **新手引导**，引导快速配置文本与视觉理解模型（新工作区默认预填 OpenAI 兼容地址，已有 DeepSeek 与自定义配置继续保留）。

### 方式 B：用 `yingliu` CLI 无头调用（适合其他智能体与脚本）

无需接入 MCP 或 IPC，安装依赖后即可用一行 JSON 和固定退出码驱动整条制片流水线：

```bash
scripts/setup-cli.sh                              # 构建并检查本机渲染环境（可选 --link 装入 PATH）
export YINGLIU_DATA_DIR=/tmp/yl-demo/data         # 建议用独立数据目录隔离测试与 --mock 运行

yingliu doctor --json                             # 检查 Node / Chromium / FFmpeg / ffprobe
yingliu styles list --json                        # 查看风格库
P=$(yingliu project create --title "10秒片头" --json | jq -r .data.id)
# 也支持带风格创建：yingliu project create --title "纸艺短片" --style <styleId> --json

# 使用本地模拟导演跑通「规划 → 建镜 → 导出审批」（不走外网，遇导出审批返回 exit 4）
yingliu agent run --project "$P" --goal "做一个 10 秒片头" --mock --json
yingliu agent status <runId> --json               # 查看 pending.callId 与 pending.execId
yingliu agent approve <runId> --call <callId> --exec <execId> --mock --json
yingliu export mp4 "$P" --out ./out.mp4 --json
```

完整 CLI 参数、退出码表与安全约定见 [docs/CLI.md](docs/CLI.md)。

---

## 核心功能全景

### 1. 导演智能体：四阶段预演与创作闭环
- **四阶段标准创作流水线**：**① 对话确认分镜**（`plan_story`/`plan_shots` 审阅批准）→ **② Blender 白模预演**（`blender_render_previz` 搭建白模人物站位、道具与机位运镜，无头渲染关键帧 PNG 与动态 MP4）→ **③ 用户审阅预演**（`submit_previz_review` 审批卡片直接看白模图/视频，不满意可零付费成本重调重渲）→ **④ 创作模型实际呈现**（预演通过后自动将白模参考帧输入生视频/生图/镜头代码模型完成最终呈现与质检导出）。详见 [docs/AGENT.md](docs/AGENT.md)。
- **主位统一 AI 副驾驶**：将智能体从底部抽屉提升为主工作台左侧可折叠主副驾驶面板（与基座 1.0.0 Marble White / 深色美术风格 100% 对齐），内置 **「智能体 / 计划与预演 / 创作对话」** 分段切换；支持 **SSE 流式思考输出**、**多轮追问与运行中中途纠偏（`agent.message`）**、以及**只读非视觉工具安全有界并行**。
- **结构化制片资产与风险审批**：支持创作计划审阅表、角色库与视觉一致性打分（最多 6 帧）、尾帧承接、配音时长对齐、视频片段裁剪/变速/抽原声、项目级费用账本与预算上限；收费生成、导出与计划/预演审阅默认须由人一次性批准（绑定 `execId` 与参数哈希）。
- **能力热切换与兜底**：随模型中心与本地环境实时增减工具——未接入外部模型时由导演用代码动效与本地音效合成兜底；未安装 Blender 时自动平滑回退直出流程。

### 2. 全量对齐基座 1.0.0 的可视化工作台与美术设计
- **统一 1.0.0 Marble White / 深色双主题**：彻底消除旧版暗黑双顶栏外壳；首页（`ProjectHome`）、新建影片向导、单顶栏工作台（`StudioHeader`）、左侧智能体副驾驶与全部弹窗全面使用 `--vs-*` 语义 Token。
- **Schema v3 制作策略与导演计划文档**：支持显式制作模式隔离（`code_animation` / `model_video` / `hybrid` 单镜头授权）与结构化导演计划文档（角色、空间布局 `worldLayouts`、镜头要求与版本哈希防覆盖）。
- **多视图舞台、后台自动预览与源码草稿持久化**：监视器 / 分镜画布 / 分栏切换、缩略图卡片与小地图、时间线拖拽与快捷键、1.2 秒防抖后台自动预览、按工程与镜头持久化的源码草稿与防误操作保护。

### 3. 自定义视频风格库
- 在首页、顶栏或新建向导进入 **风格库**，支持新建／编辑／删除，或导入 **Markdown、TXT、JSON、ZIP 风格包与风格文件夹**（仅读取纯文本，绝不执行风格包里的任何代码）。
- 选用风格新建影片后，风格快照随工程独立保存，并统一注入**创作对话、分镜与场景生成、协作制作工作流以及智能体**（支持 `styles_list` / `project_set_style` 工具与 `yingliu styles list` / `yingliu project create --style <id>`）。

### 4. 官方多厂商模型协议、音频生成与导出前质检
- **官方多厂商协议直连 + 通用异步模板共存**：已全量接入基座 1.0.0 官方协议适配器（`openai-videos`、`kling-video` 含 `accessKey:secretKey` 自动签发 HS256 JWT、`minimax-video`、`volc-video` 火山方舟 Seedance、`dashscope-video` 百炼万相、`gemini-image`、`gemini-video` Veo、`images`、`video-gateway`、`speech`），支持**服务端模型目录自动发现（`models.discover`）**与**提交前能力强校验（`validateMediaRequest`）**；同时保留可配置 **`async-task` 通用模板**（支持 ElevenLabs TTS/SFX、Replicate MusicGen 等自定义接口）。
- **完整音频链路与人工 UI 入口**：`speech` 角色绑定 `async-task` 时自动走模板适配器；**声音与配音** 面板新增 **「AI 音乐与音效生成」** 人工入口（`audio.generate`），与本地离线确定性合成音效（`audio.sfx`）及多轨混音无缝协作。
- **双轨导出前质检与成片留证**：**导出成片** 面板同时集成 `agent.qc` 与基座 1.0.0 `LocalQualityPanel` / `ExportQualityReport`（本地抽样帧分析、音轨元数据与 SHA-256 成片报告留证）。

### 5. 工程历史、打包与备份
- **持久历史与 `.yingliu` 备份**：修改历史跨重启支持撤销／重做；支持重命名、复制、归档／恢复与 `.yingliu` 工程包流式导出／导入（含分镜、简报、源码、素材及智能体 `story` / `ledger` / `qc`，不含对话日志与大型导出成片）。
- **单一数据所有者锁**：CLI、桌面应用与浏览器服务共用基于目录身份的本机 TCP listener 锁（v2 协议，支持多槽位防碰撞），进程异常退出由系统自动释放，桌面端遇占用时会明确提示重试、等待或退出。

---

## 打包独立应用

```bash
npm run package:app
```

| 平台 | 构建产物与入口 |
| --- | --- |
| macOS | `artifacts/映流智能体.app`（保留本机 ad-hoc 临时签名） |
| Windows | `artifacts/yingliu-agent-win32-<arch>/yingliu-agent.exe`（请整目录移动） |
| Linux | `artifacts/yingliu-agent-linux-<arch>/yingliu-agent.sh`（可运行包内 `install-desktop-entry.sh` 安装菜单入口） |

> Electron 固定为 `44.9.3`（Node 侧 HTTP 请求通过 `src/host/http.ts` 统一安装 `undici@7.30.1` 以规避内置 Undici 漏洞）。实验性 Tauri 2 壳（`src-tauri/`）默认不启用、不参与打包，Electron 是当前唯一受支持的桌面壳。

---

## 开发与验证命令

```bash
npm run typecheck          # TypeScript 类型检查
npm run build              # 构建 UI、Web 服务、桌面主进程/预加载与 CLI
npm test                   # 全量单元、智能体、CLI、存储与真实 Chromium 交互测试
npm run verify:editor      # 真实 Chromium 编辑器草稿安全与智能体互斥验收
npm run verify:models      # 多模型界面、费用试算与媒体流程验收（本地模拟服务）
npm run verify:film        # 本地多模态成片闭环验收
npm run verify             # Electron 桌面界面 + 6 秒合成音 MP4 渲染解码验收
node scripts/verify-package.mjs --layout-only   # 应用包布局检查
```

---

## 安全边界与已知限制

- **事务与沙箱**：同一工程写操作串行排队并校验 `expectedRevision`；文件定位严格限制在工程根目录内；场景代码运行在无 Node / IPC / 凭据权限的隔离环境中。
- **凭据与隐私**：桌面密钥存系统安全存储，CLI 仅记录环境变量名（`--api-key-env`）而不落盘明文密钥；日志与轨迹自动脱敏；`--mock` 模式下拦截所有非本地模拟网关的外部网络请求。
- **已知限制**：发行构建目前未签名、未公证且未提供系统安装器；本地 mock／协议验收不等同真实付费供应商画质与语音质量验收；不支持云端成片渲染或多人实时协同。

---

## 文档索引与许可

- **智能体与 CLI**：[智能体使用说明](docs/AGENT.md) · [CLI 完整手册](docs/CLI.md) · [0.5 方案](docs/ROADMAP-0.5.md) · [工作台设计](docs/FRONTEND-REDESIGN.md)
- **多模态与架构**：[多模型与多模态](docs/MULTIMODAL.md) · [媒体网关 v1](docs/media-gateway-v1/README.md) · [架构与恢复协议](docs/ARCHITECTURE.md) · [模型导演协议](docs/MODEL-PROTOCOL.md) · [工程包格式](docs/ARCHIVE.md)
- **版本与验收**：[更新记录](CHANGELOG.md) · [v1.0.0 交付说明](docs/DELIVERY-v1.0.0.md) · [验收证据](docs/ACCEPTANCE.md) · [多模型验收](docs/ACCEPTANCE-MULTIMODAL.md) · [平台适配进度](docs/PLATFORM-SUPPORT.md) · [项目来源](docs/ORIGIN.md)
- **许可证**：自有代码及随仓工作包数据采用 **GPL-3.0-only**（[LICENSE](LICENSE)）；版权与来源说明见 [NOTICE](NOTICE)，历史许可留存见 [Legacy-Apache-2.0](licenses/Legacy-Apache-2.0.txt) / [Legacy-MIT](licenses/Legacy-MIT.txt)，第三方声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
