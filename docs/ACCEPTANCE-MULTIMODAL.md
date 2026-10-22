# 映流 Studio 0.3.0 多模型验收

记录日期：2026-10-21。环境为 Linux x64、Node 24.19.0、Chromium 151、FFmpeg/ffprobe 7.1.5。所有供应商请求均发往隔离的 localhost 测试网关，未调用真实计费服务。

## 交付与验证

| 范围 | 本轮结果 |
| --- | --- |
| 类型、自动化回归 | `npm run typecheck` 通过；`npm test` 195 项通过，0 失败、0 跳过 |
| 多连接与角色 | 连接/模型增删改、凭据隔离与轮换、免密钥服务、旧 custom 迁移、导演/场景/视觉角色路由通过 |
| 媒体协议及恢复 | JSON/SSE、Images URL/Base64、视频提交/对账/取消、下载重试、未知提交不重复收费请求、CAS 候选采用通过 |
| 视频与备份 | 真实视频导入、CFR 副本、原件保留、裁剪/倍速、随机取帧、音轨及混排导出；v1/v2 包、流式限额和 65 MiB 素材往返通过 |
| 制作工作流 | 逐步复用、提交回执恢复、预算阻断、并发互斥、候选快照审片、冲突后重新审片、单次主事务和编辑保留通过 |
| 浏览器界面 | `npm run verify:models` 8 项通过；实际操作模型中心、图片/视频生成采用、视频导入裁剪、工作流和限额表单 |
| 完整成片 | `npm run verify:film` 最终连续两次均 7 项通过，两次 MP4 字节一致 |
| 打包 | `npm run package:app` 通过；Linux x64 portable 包迁出源码目录后，包内运行时、依赖、服务、工程创建及备份恢复 6 项通过 |

完整成片包含代码、生成图片和生成视频三个镜头，每镜通过已配置 Speech 接口返回测试音频。使用真实 Chromium 取帧及 FFmpeg 编码/完整解码：320×180、12/1 FPS、72 帧、6 秒、H.264/yuv420p、AAC 48 kHz 双声道。三张候选审片画面与主提交后的同帧 SHA256 一致；导出后继续修改源码至 revision 6，媒体和片段仍保留。

最终 MP4 SHA256：`e2b56ed1e3b65cc43c41e83ee0b80406211cb56f3de1ffd126277a4227c2c1a9`。Speech fixture 是合成正弦音，用于验证协议和音频链路，不代表自然配音或模型创作质量。

验收定位并修复了多段旁白混音时 FFmpeg `amix` 丢失 PTS、导致 6 秒 WAV 偶发截为约 5.245 秒的问题。修复在混音后重建采样时间戳，升级缓存版本；真实回归连续 10 次冷混音均为准确 6 秒且 PCM 哈希相同，保留原有导出音画同步判定。

## 本地交付物

- Linux 包：`artifacts/yingliu-studio-0.3.0-linux-x64.tar.gz`，解压后运行 `yingliu-studio-linux-x64/yingliu-studio.sh`。
- 浏览器界面截图与记录：`artifacts/acceptance-multimodal/`。
- 成片记录：`artifacts/acceptance-v03/multimodal-film-final.json`；脚本每次输出独立成片、关键帧、probe 和脱敏报告。
- Linux 包检查：`artifacts/acceptance-v03/package-verification-linux-x64.json`。
- 混音根因及修复证据：`artifacts/acceptance-v03/audio-timestamp-regression/report.json`。

上述大型产物、临时工程及日志不进入源码仓库。协议样例、测试网关和验收脚本随源码交付。

## 验证边界

包检查使用 `--layout-only`，桌面 GUI 项明确为 SKIP，包验收总状态为 PARTIAL；本轮没有新增 Windows/macOS 原生窗口、钥匙环或安装验收。实际 Chromium 媒体和界面测试已运行，但不能代替原生桌面验收。

真实供应商的协议兼容、生成成功率、成片质量、成本和性能收益尚未验收。当前全流程费用不可可靠预报价，设置 `maxCost` 会在任何模型调用前暂停；任务数量限制可用，费用未知不会记为零。厂商原生视频协议仍需新增适配器。

使用方式与恢复语义见 [多模态说明](MULTIMODAL.md)、[模型协议](MODEL-PROTOCOL.md)、[工程包 v2](ARCHIVE.md) 和 [视频网关 v1](media-gateway-v1/README.md)。
