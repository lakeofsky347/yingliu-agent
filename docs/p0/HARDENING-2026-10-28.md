# Tauri P0 隔离分支加固记录

日期：2026-10-28，Asia/Singapore。交付记录为 v1.0.0，应用 package 版本保持 0.5.0。

工作分支为 `codex/tauri-p0-hardening-20261028`。产品冻结验收基于主线 `9137eb7b7921423c9039704b4872cc2eff77b334`，在隔离分支的合并基线为 `d843ee5d1c19bf0872c703a6db02c3c9ffb25f0d`，同时包含与本记录同批交付的 P0 加固修改。构建 manifest 中的 commit 指向该产品验收合并基线，不能单独解释为不含本轮修改的纯基线二进制。本记录不改写历史测量或把 P0 壳当成主线应用；原 spike、PR 4 和主线不自动合并。

最后同步的主线为 `eb514f452e910bb8d1b75f71529f13660c15ab9f`，对应本分支合并提交 `563a1f9ab073982866b9daae1a8a66128b0363c1`。`9137eb7..eb514f4` 仅改变 9 个验收脚本、测试或交付记录文件；对 `src/`、`package.json`、`package-lock.json`、`assets/` 的 Git 差异为空，本轮 P0 产品代码也保持冻结。同步后实际补跑验收任务屏障与平台摘要 15 项专项，全部通过；下面的 482 项全量、Rust 4 项以及 source/SEA 共 10 项演练仍对应上述 `9137eb7` 产品等价代码，不把脚本同步描述成重新执行了更大的全量套件。

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

## 已执行检查与边界

| 检查 | 结果 | 范围 |
| --- | --- | --- |
| 全量 Node/tsx 回归 | **482/482，零失败、零跳过** | 在 `9137eb7` 产品验收合并基线一次完整执行；包含当时主线 447 项和 P0 五组 35 项 |
| P0 五组 Node/tsx 回归 | 35 个独立用例包含在上述全量结果内 | 合成迁移 13、自有进程生命周期与 Windows 前置拒绝 4、真实 Chromium 隔离 4、脚本门槛 8、sidecar 共同 lease 6 |
| 后续验收脚本同步专项 | **15/15，零失败、零跳过** | 同步 `eb514f4` 后执行 `acceptance-task.test.ts` 与 `platform-acceptance.test.ts`；实际补验任务就绪/失败屏障及脱敏平台摘要 |
| `npm run typecheck` / `npm run build` | PASS / PASS | 当前冻结源码；普通构建生成 UI、web、Electron 和 CLI bundle |
| Rust `cargo test` | 4/4 | 沉默进程、坏标签/JSON/协议/origin、EOF/超长/非法 UTF-8/无换行，以及 setup guard 回收 |
| Rust `cargo check --locked` | PASS | 当前 macOS arm64 宿主编译检查；test 同样使用 `--locked`，Cargo.lock 未改动 |
| Node SEA 重新构建 | PASS | 现成本机 Node 24.19.0、darwin arm64；每次重建 UI，资源 `app.js` 与最新构建字节相同 |
| source sidecar 严格故障演练 | **5/5 PASS** | 隔离源码入口与 HTTP harness；真实本机 Chromium 进程与本地导出任务中断 |
| SEA sidecar 严格故障演练 | **5/5 PASS** | 对本轮新构建二进制重复全部五项；不以源码或 fixture 结果替代 |

真实 Chromium 检查包含死循环时宿主心跳、HTTP/WS/UDP 接收器无流量，以及场景无 Node/IPC/token 桥。它不是 Tauri 原生窗口、完整视频流程或跨机器发行验收。故障注入使用临时目录与自有进程，不是实机断电或实际账户迁移。

`fault-drills.mjs` 现在对恢复状态、对应 uncertain 回执、孤儿进程和自动重投做硬断言；故意坏的 fixture 必须失败。五项分别是智能体导出 QC 捕帧中断、实际本地导出任务中断、渲染中取消、客户端断连、宿主 stdin 关闭。前两项分别验证 `paused + 对应执行的 uncertain` 和同一任务 ID 的 `failed + TASK_INTERRUPTED`，后者不能通过空任务列表跳过。source 和 SEA 本轮均观测到真实 Chromium 进程；崩溃后自有孤儿进程为空，没有自动重投；取消为 `cancelled` 且无渲染进程残留；stdin 关闭后退出码为 0，可重新取得同 profile 所有权。这是中断与恢复验收，不代表已完成 MP4 的全片解码或真实生成质量验收。

`measure.mjs` 对清缓存失败的样本不启动应用、不纳入 cold 统计；Electron React 挂载、Tauri WebView load 和 sidecar backend ready 分别标识，当前三者 `crossShellComparable=false`。所有 idle 计时从相应模式的实际判据后开始。`build-sidecar.mjs` 每次先重建 UI，再复制资源。

本轮 SEA 二进制为 129,346,160 字节，连同资源为 131,554,217 字节；SHA-256 为 `6956c17f358fdb5e7f6fcc1514395e92de6de4d7ee49c5d155fd2bb9d32bd48d`。这只是当前本机产物的身份，不用于和历史 Linux 包直接比较体积。manifest 的 `signed=false`，构建中的 macOS ad-hoc 签名不等于发行签名或公证。本机 Homebrew Node 26.8.2 明确禁用了 SEA，本轮改用已有 Node 24.19.0 完成打包，未更改全局 Node。

本轮原始本机证据另存于忽略目录 `.local/p0-final-9137eb7-20261028/`：`node-tests.log`、`fault-drills-source.json`、`fault-drills-sea.json` 和 `sidecar-build/node-darwin-arm64/manifest.json`。它们不随源码发布；本记录只保留脱敏计数、范围和产物哈希，未覆盖 `docs/p0/evidence/` 的历史性能或演练记录。

## CI 触发与适用范围

专用 `Tauri P0 spike` workflow 的 push 条件包含 `spike/tauri-p0` 与本次独立加固分支。PR 路径过滤除 Rust、sidecar 和 P0 脚本外，也覆盖迁移、场景 worker、P0 测试及其 fixture。它运行三平台 Node SEA 构建、stdio 冒烟和 Rust release 编译，产物仍为未发行签名的实验构建；**不代表 Tauri 原生窗口或性能验收**。

通用 `Platform checks` 与 `Native and media acceptance` 不限制上述分支，但其原生应用对象仍是主线 Electron 应用。触发配置说明哪些检查会被尝试执行，不构成对应提交的远端 CI 已通过证据，应查看该提交实际 Actions 结果。

本轮没有执行 sudo/drop_caches、真实计费 API、真实旧凭据迁移、Tauri 原生 GUI 验收、Windows JobObject 验收、干净目标机安装、发行签名/公证或新的 Linux 冷启动/PSS 同口径性能比较。历史 P0 报告和 evidence 保留为历史记录，不用本轮加固追认旧性能数字。
