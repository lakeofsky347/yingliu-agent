# P0 报告：Tauri 2 + sidecar 可行性

测量基线 `main@c03828f`（试验分支起点）；随 v1.1.0 并入 `main`（合并基线 `main@6c41a2e`，v1.0.0 主施工），代码在此基础上复核，测量数字未重测。所有数字来自 Linux x64 容器（Xvfb），原始数据在 `docs/p0/evidence/`。

> 状态：**实验性**。Tauri 壳与 sidecar 不参与默认构建与打包，Electron 仍为默认桌面壳。

## 0. 门槛状态（如实）

| 门槛 | 状态 |
|---|---|
| 安装体积 ≤ Electron −40% | 仅 Linux 实测通过（Node SEA −56%）；macOS/Windows 未测（CI 只给出未签名产物大小） |
| 空闲内存 ≤ Electron −20% | **Linux 未通过（+46%）**；macOS/Windows 未测 |
| 冷启动 ready P95 | 仅 Linux 测量；两种壳的 ready 定义不同，不可直接比较，不作为通过依据 |
| Tauri 原生 GUI（三平台）、preview session、W3 RPC/requestId | 未测 |
| 真实系统钥匙环迁移（本轮仅合成凭据） | 未测 |
| 更新/回滚、代码签名与公证、干净机器安装 | 未测 |
| Windows JobObject 子进程回收 | 未测 |
| Tauri 内完整媒体闭环（渲染导出 MP4） | 未测（仅 sidecar 独立运行时实测） |


## 1. 结果

| 项 | 结果 | 证据 |
|---|---|---|
| W1 Node SEA sidecar 隔离安装（路径含空格与中文，源码/node/opt 隐藏） | 通过 | evidence/node-linux-x64/verify-log.json |
| W1 Bun sidecar 同上 | 通过 | evidence/bun-linux-x64/verify-log.json |
| 项目读写、mock agent 到审批、真实 Chromium 渲染并导出 MP4（1920x1080 h264 30fps 30s，完整解码无误） | 通过 | ffprobe.json |
| 归档导出/导入，CLI 与第二个 sidecar 得到 BUSY(9)，平滑关闭约 515 ms，无残留子进程，锁已释放 | 通过 | verify-log.json |
| W2 Tauri 壳（Linux 实跑：精确 origin capability、导航限制、新窗口拒绝） | 通过 | src-tauri/ |
| W2 三平台 CI 构建 + 未签名产物（大小/sha256） | 见 PR CI | .github/workflows/tauri-p0.yml |
| W4 场景隔离（网络、WebSocket、WebRTC、导航、弹窗、超时看门狗杀进程组） | 通过 | evidence/w4/、tests/p0-scene-isolation.test.ts |
| Day8：渲染中 SIGKILL sidecar | 通过：3 s 后无孤儿 chrome；重启约 300 ms 取得锁；run 变为 paused，导出标记为 uncertain，**不会自动重新提交** | evidence/fault-drills-*.json |
| Day8：渲染中取消 | 通过：run=cancelled，渲染进程全部退出 | 同上 |
| Day8：客户端断开（SSE 与进行中的请求） | 通过：sidecar 继续服务 | 同上 |
| Day8：宿主死亡（stdin EOF） | 通过：exit 0，可立即重新启动 | 同上 |
| Day8：成功后写入失败 | 已由现有测试覆盖（tests/agent-success-receipt.test.ts R2-01/R2-01b） | — |
| 凭据迁移演练（备份、日志、回读、回滚、重试；只用合成凭据） | 通过 6/6 | tests/p0-credential-migration.test.ts |

发现并修复的问题：W4 中，向预先存在的 about:blank 页面 `setContent` 时 init script 不会执行，RTCPeerConnection 仍然可用。改为新建页面并导航到 data: URL 后修复。生产渲染器使用新 context 加 goto，不受影响。

## 2. 数字

### 安装体积（不含按需下载的 Chromium/FFmpeg）
| 方案 | 字节 | 相对 Electron |
|---|---|---|
| Electron 44 包 | 314,829,068 | — |
| Tauri 壳 5,027,952 + Node SEA 发布目录约 133.3 MB | 约 138.3 MB | **-56%**（线 -40%，通过） |
| Tauri 壳 + Bun 发布目录约 91.4 MB | 约 96.4 MB | **-69%** |

注意：Linux 上 WebKitGTK 是系统依赖，未计入；macOS 的 WKWebView 和 Windows 的 WebView2 也是系统自带。

### ready 与空闲内存（S0 PSS，空闲 10 s，进程树合计）
| 方案 | 次数 | ready 中位 / P95 | PSS 中位 |
|---|---|---|---|
| Electron（warm） | 10 | 734 / 1014 ms | 340.8 MiB |
| Tauri + Node（warm） | 10 | 681 / 823 ms | 498.0 MiB（**+46%**） |
| Tauri + Bun（warm） | 10 | 644 / 758 ms | 474.2 MiB（**+39%**） |
| Electron（cold，drop_caches） | 5 | 924 / 1022 ms | 356.2 MiB |
| Tauri + Node（cold） | 5 | 914 / 946 ms | 512.3 MiB |
| 单独的 sidecar：Node / Bun | 10 | 291 / 266 ms | 113.3 / 86.8 MiB |

Tauri 进程拆分：壳约 84 MiB，sidecar 约 128 MiB，WebKitNetworkProcess 约 31 MiB，WebKitWebProcess 270–300 MiB。设置 `WEBKIT_DISABLE_COMPOSITING_MODE` 无改善。**在 Linux 上，空闲内存没有达到 -20% 的线，反而更差。** 部分 warm 运行与 W4 测试并发进行，可能有轻微偏差，但不足以改变结论。

## 3. 未测（及原因）
- macOS/Windows 原生 UI 运行、WebView2 行为与内存：本机只有 Linux，CI 只做构建和打包。
- 代码签名与公证：按要求不购买证书、不发布。
- S1/S2 场景内存、S3 导出期间 sidecar 的内存：时间不够，下一步应补测。
- Linux 发行版矩阵（WebKitGTK 版本差异）、preview session、W3 RPC：不在本轮 P0 范围内。

## 4. 建议
**有条件继续，不要直接迁移。**
- 体积目标已用 Node SEA 达成（-56%）。Bun 只额外省约 42 MB 和约 25 ms 启动时间，还会引入运行时差异，目前不值得采用。
- 迁移的主要理由“更省内存”在 Linux 上不成立（+46%）。必须先在 macOS 和 Windows 上实测 S0/S1。只有这两个平台达到 -20% 才继续；否则，仅凭体积不足以抵消迁移成本，应留在 Electron，并只做体积优化（例如更小的 Electron 打包）。
- sidecar 架构本身（锁、握手、关闭、崩溃恢复、场景隔离）已验证可用，无论是否换壳都可以保留。

重新估算（达到可发布质量的 Tauri 版本，按施工计划修订）：**约 8–12 人周**（不含 Electron 的并行维护）。包括 W3 RPC/requestId 与 preview session、三平台原生 UI 适配与内存实测、真实钥匙环迁移、签名/公证与更新回滚流水线、WebKitGTK 兼容矩阵、Windows JobObject、干净机器安装与 Tauri 内完整媒体闭环验收。此前“约 5–6 人周”的估计未计入后几项，已作废。
