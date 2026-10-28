# Tauri P0 隔离分支加固记录

日期：2026-10-28，Asia/Singapore。交付记录为 v1.0.0，应用 package 版本保持 0.5.0。

工作分支为 `codex/tauri-p0-hardening-20261028`。本次重新冻结验收基于主线诊断候选 `0f26d9a3e9d2e51b51f847abbf546cbbbaf781e8`，在隔离分支的合并基线为 `86a62833e976e2b98a15a158ce6c5fc1b04fb5a6`，同时包含 P0 加固及 Windows 进程证据拒绝路径修改。构建 manifest 中的 commit 指向该产品验收合并基线；它不单独代表该主线提交的全部原生验收已通过。本记录不改写历史测量或把 P0 壳当成主线应用；原 spike、PR 4 和主线不自动合并。

之前 `9137eb7..eb514f4` 仅为验收脚本、测试和文档同步，当时产品源码等价；该结论不延伸到之后的实际渲染字体屏障、文本渲染与合成参数、工程目录锁等待、不可变运行时发布及可选错误诊断修改。本次已重新执行下面的 534 项全量、UI/应用构建、Node SEA 打包及 source/SEA 共 10 项故障演练，没有沿用旧 Node/渲染运行时结果替代。Rust 源码树与 `dd711fe` 验收合并基线相同，沿用该轮 4 项测试与编译检查证据。旧基线证据仍保存在各自忽略目录，未被本轮覆盖。

## 凭据迁移事务

`src/migration/credential-migration.ts` 仍为使用注入式 decryptor/keyring 的设计验证，尚未接入真实 OS keyring。验收只用合成密文与内存 Map，未读取真实旧凭据。

- 迁移先保存并同步密文备份，再持久化新账户的写入意图，随后写 keyring 并读回核对。旧密文原件保持不动，明文不进入日志、状态、临时文件或参数。
- schema v2 的 `credentials-state.json` 是唯一逻辑提交点；`credentials-journal.json` 是可修复的过程记录。状态已安装后，后续同步/日志错误不能触发删除已提交账户。
- 新账户使用独立的 `service:migration:<attempt>:<ref-hash>` 命名，提交状态中的 `accounts` 保存 ref 到 account 的映射。接入真实 keyring 时必须按该映射读取，不能继续假定共享的 `service:ref` 名称。
- 自动清理和显式回滚只删除本次 attempt 的新账户。已有 canonical account 不覆盖、不回滚删除；回滚同样先校验新 profile 的 owner 权限。
- 只有 ENOENT 表示缺失。损坏、空值、数组或无法读取的状态不会当成空记录；schema v1 的试验状态也需人工审阅，不做危险的猜测性清理。
- 字典使用 null prototype，`__proto__` 等合法自有 ref 不会吞掉写入意图。中断后的未提交 journal 会先清理它记录的新账户再进入新 attempt。

## 自有场景进程与 Rust 握手

`src/sandbox/scene-worker.ts` 从 spawn 返回时就登记 child 所有权，启动与执行共用一个总超时。POSIX 清理已登记的独立进程组，leader 先退出时仍会结束它留在原组内的后代；未登记的 ChildProcess 不能充当终止权限。失败路径与实际 wall time 均覆盖启动阶段。

Windows 的独立 `runScene` 在启动前明确返回 `SCENE_PLATFORM_UNSUPPORTED`，零 spawn。**未实现或验收 JobObject，当前拒绝无法保证后代清理的执行**；需要 Windows 原生作业对象方案与目标机验收后再开放。这不影响 Electron 的生产渲染路径。

Rust `SidecarProcess` 从 spawn 开始持有子进程；缺管道、首行错误、协议或 origin 不匹配、握手超时以及 capability/window setup 的 `?` 返回都会经 Drop 执行 kill + wait。首行限制为 16 KiB，默认期限 30 秒，使用 tagged ready/error 解码；不记录携带 token 的原始握手。握手线程通过可返回错误的 Builder 创建，避免 release 的 abort panic 跳过清理。正常退出先请求 graceful shutdown，期限后 kill + wait。

## Sidecar 与共同所有权

`src/sidecar/main.ts` 在应用初始化与恢复前取得 `OwnerLease`，再通过 `ownership` 显式借给 `createApplication`，避免默认应用再次取得相同端口而自锁。它沿用主线的 profile、projects 目录及实际工程 root 保护，外部工程也不能通过另一 profile 绕过。

关闭请求、stdin 关闭、信号、初始化失败和 HTTP 监听失败均先排空本应用及 HTTP 服务，最后释放入口持有的 lease。启动与清理期间的重复终止请求不会提前释放；启动失败仍返回单行 `error`，正常关闭保留协议 1 的 `shutdown` 回执。相关测试只使用隔离 profile、内存凭据服务和 mock 模型。

## 可选错误诊断

同步主线的固定 `category / operation / ioCode / syscall` 元数据，从 renderer 实际错误进入匹配 revision 的 check 报告、任务状态和日志，上传摘要再次按枚举校验。原 error 文本和旧任务日志仍兼容；冻结或不可写的 Error 保留原异常信息，原生验收的历史读取挂起时仍返回 2 秒预算内已采集的固定任务状态。诊断不决定任务状态、审批或重试，没有增加自动重试、放宽 PNG 验收或修改通用持久化 helper。

## 已执行检查与边界

| 检查 | 结果 | 范围 |
| --- | --- | --- |
| 全量 Node/tsx 回归 | **534/534，零失败、零跳过** | 在 `0f26d9a` 产品验收合并基线重新完整执行；包含主线 498 项和 P0 五组 36 项 |
| P0 五组 Node/tsx 回归 | 36 个独立用例包含在上述全量结果内 | 合成迁移 13、自有进程生命周期与 Windows 前置拒绝 4、真实 Chromium 隔离 4、脚本门槛 9、sidecar 共同 lease 6 |
| 先前验收脚本同步专项 | **15/15，零失败、零跳过** | 同步 `eb514f4` 后曾执行 `acceptance-task.test.ts` 与 `platform-acceptance.test.ts`；这是前一轮脚本补验记录 |
| 进程证据平台边界专项 | **9/9，当前 macOS 零跳过** | 单独补验且纳入本轮全量；不将该本机计数解释为 Windows 真实进程回收通过，Windows POSIX 实进程用例明确跳过 |
| `npm run typecheck` / `npm run build` | PASS / PASS | 当前冻结源码；普通构建生成 UI、web、Electron 和 CLI bundle |
| Rust `cargo test` | 4/4，沿用 `dd711fe` 同源码证据 | 沉默进程、坏标签/JSON/协议/origin、EOF/超长/非法 UTF-8/无换行，以及 setup guard 回收；本轮核对 `src-tauri` Git 树哈希相同 |
| Rust `cargo check --locked` | PASS，沿用 `dd711fe` 同源码证据 | macOS arm64 宿主编译检查；test 同样使用 `--locked`，Cargo.lock 未改动 |
| Node SEA 重新构建 | PASS | 现成本机 Node 24.19.0、darwin arm64；每次重建 UI，资源 `app.js` 与最新构建字节相同 |
| source sidecar 严格故障演练 | **5/5 PASS** | 隔离源码入口与 HTTP harness；真实本机 Chromium 进程与本地导出任务中断 |
| SEA sidecar 严格故障演练 | **5/5 PASS** | 对本轮新构建二进制重复全部五项；不以源码或 fixture 结果替代 |

真实 Chromium 检查包含死循环时宿主心跳、HTTP/WS/UDP 接收器无流量，以及场景无 Node/IPC/token 桥。它不是 Tauri 原生窗口、完整视频流程或跨机器发行验收。故障注入使用临时目录与自有进程，不是实机断电或实际账户迁移。

`fault-drills.mjs` 现在对恢复状态、对应 uncertain 回执、孤儿进程和自动重投做硬断言；故意坏的 fixture 必须失败。五项分别是智能体导出 QC 捕帧中断、实际本地导出任务中断、渲染中取消、客户端断连、宿主 stdin 关闭。前两项分别验证 `paused + 对应执行的 uncertain` 和同一任务 ID 的 `failed + TASK_INTERRUPTED`，后者不能通过空任务列表跳过。source 和 SEA 本轮均观测到真实 Chromium 进程；崩溃后自有孤儿进程为空，没有自动重投；取消为 `cancelled` 且无渲染进程残留；stdin 关闭后退出码为 0，可重新取得同 profile 所有权。这是中断与恢复验收，不代表已完成 MP4 的全片解码或真实生成质量验收。

`measure.mjs` 对清缓存失败的样本不启动应用、不纳入 cold 统计；Electron React 挂载、Tauri WebView load 和 sidecar backend ready 分别标识，当前三者 `crossShellComparable=false`。所有 idle 计时从相应模式的实际判据后开始。`build-sidecar.mjs` 每次先重建 UI，再复制资源。

进程证据辅助模块仅在 Linux/macOS 上检查 POSIX 进程出生身份。Windows 在调用 `ps` 或授予任何信号权限之前，明确返回 `PROCESS_EVIDENCE_UNSUPPORTED`；没有将缺少 POSIX 工具解释成空进程树或清理通过。真实 fixture 子进程的出生身份/回收测试在 Windows 明确标记为不支持并跳过，另一个独立测试验证零 spawn 的拒绝路径。它不构成 Windows 进程树回收、故障演练或性能测量通过；专用 SEA/stdio/Rust 构建可以继续独立验收。

本轮 SEA 二进制为 129,362,576 字节，连同资源为 131,572,125 字节；SHA-256 为 `ff24f441fff95ba61e3fe3cc9f11eaf32fec2aebf797cf8fcef5ca6ac134fb7b`。这只是当前本机产物的身份，不用于和历史 Linux 包直接比较体积。manifest 的 `signed=false`，构建中的 macOS ad-hoc 签名不等于发行签名或公证。本机 Homebrew Node 26.8.2 明确禁用了 SEA，本轮改用已有 Node 24.19.0 完成打包，未更改全局 Node。

本轮原始本机证据另存于忽略目录 `.local/p0-final-0f26d9a-20261028/`：`node-tests.log`、`typecheck.log`、`build.log`、`sea-build.log`、`rust-source-equivalence.log`、`fault-drills-source.json`、`fault-drills-sea.json` 和 `sidecar-build/node-darwin-arm64/manifest.json`。Rust 同源码树哈希为 `0483a15df701f7d994887b643d99deca05928406`，对应测试与检查日志保留在 `.local/p0-final-dd711fe-20261028/`。本轮在启动全量测试前已恢复自有临时依赖链接，取得 534/534、零跳过。前一轮 `2f39b31` 曾因链接未恢复跳过真实 Electron 用例，其初始日志与重新取得 507/507 的日志仍各自保留在原目录，不计为本轮结果。这些原始数据不随源码发布；本记录只保留脱敏计数、范围和产物哈希，未覆盖 `docs/p0/evidence/` 的历史性能或演练记录。

## CI 触发与适用范围

专用 `Tauri P0 spike` workflow 的 push 条件包含 `spike/tauri-p0` 与本次独立加固分支。PR 路径过滤除 Rust、sidecar 和 P0 脚本外，也覆盖迁移、场景 worker、P0 测试及其 fixture。它运行三平台 Node SEA 构建、stdio 冒烟和 Rust release 编译，产物仍为未发行签名的实验构建；**不代表 Tauri 原生窗口或性能验收**。

通用 `Platform checks` 与 `Native and media acceptance` 不限制上述分支，但其原生应用对象仍是主线 Electron 应用。触发配置说明哪些检查会被尝试执行，不构成对应提交的远端 CI 已通过证据，应查看该提交实际 Actions 结果。

此前主线在用户手动处理系统钥匙串后，新包于 `2026-10-28T11:19:03.529Z` 取得单次完整本机 73/73 通过，包含此前无限循环恢复、Keychain 与 sandbox 路径；这是当时主线 Electron 本机验收。`accfdf3` 的三平台快速矩阵已通过（Actions run 40679330829），三平台 Electron 原生媒体验收也已通过（run 40679330857）。这些旧提交证据不替代当前诊断候选自己的原生验收。

当前主线 `0f26d9a` 的三平台快速矩阵已通过（Actions run 40683701636），同一干净提交的 Electron 原生媒体验收三平台也全部成功（run 40683701661：macOS 73、Windows 73、Linux 74 项）。主线本机完整 498/498、类型检查、构建与搬迁包布局检查已通过；新增诊断后的 GUI 结果以这次远端干净提交为证，不标成本轮重新执行的本机 73 项。

独立分支前一提交 `2cb084b` 的专用 SEA/stdio/Rust 三平台与通用快速三平台已通过，但继承的 Windows Electron 原生验收失败：package 的 revision 4 预览任务为 `TASK_FAILED`，native 在聊天重试等待处超时；models、film、editor 已通过。现有脱敏摘要没有具体 IO code 或 syscall，不能判定 Windows 根因，也不将其记为通过。本次 `0f26d9a` 同步诊断用于下一次实际 CI 取证；本次独立分支提交的专用、快速及原生结果都须按新提交核对。本轮没有执行 Tauri 原生窗口验收，P0 中断恢复演练也不替代该验收。

本轮没有执行 sudo/drop_caches、真实计费 API、真实旧凭据迁移、Tauri 原生 GUI 验收、Windows JobObject 验收、干净目标机安装、发行签名/公证或新的 Linux 冷启动/PSS 同口径性能比较。历史 P0 报告和 evidence 保留为历史记录，不用本轮加固追认旧性能数字。
