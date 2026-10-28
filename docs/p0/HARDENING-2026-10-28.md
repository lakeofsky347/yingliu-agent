# Tauri P0 隔离分支加固记录

日期：2026-10-28，Asia/Singapore。交付记录为 v1.0.0，应用 package 版本保持 0.5.0。

工作分支为 `codex/tauri-p0-hardening-20261028`。本次重新冻结验收基于主线 runtime 有界重试修复 `6ae4103919ce511412bc7c4b18eb7101f445fdf5`，在隔离分支的合并基线为 `4de336a6b50e96c2981f1c13a513bd6e0fa98a60`，同时包含 P0 加固及 Windows 进程证据拒绝路径修改。构建 manifest 中的 commit 指向该产品验收合并基线；它不单独代表该主线提交的全部原生验收已通过。本记录不改写历史测量或把 P0 壳当成主线应用；原 spike、PR 4 和主线不自动合并。

随后仅同步测试断言修正 `e7cbf37b532e44e7b4937126051806f68fd04a32`，隔离分支对应合并提交为 `97612038a2cb10d4ececeb88e60ecf10a9fc42a4`。已核对相对 `4de336a` 的 `src / scripts / bin / .github / package.json / package-lock.json / assets` 差异为空，仅 `tests/task-failure-diagnostics.test.ts` 更新：Windows 文件尝试次数允许在 1..8 内随期限提前结束，其他平台仍须一次失败；失败状态、固定 IO 诊断和不上传 raw 字段的断言保留。该同步后另跑 23/23 专项及类型检查通过，产品与 SEA 字节等价，因此没有伪称重跑全量或重新生成 SEA。

最后同步测试 fixture 修正 `988a064a4df9c92822e7c6d7a048462758ee6340`，对应隔离分支合并提交为 `c859e21e6574e7c2cfa257da682d774d409d22a2`。此次相对前一同步只改变 `tests/application-owner.test.ts`，产品目录相对 `4de336a` 仍为空差异；最终重新执行 548/548 全量、零失败零跳过及类型检查通过。新增计数来自 fixture 碰撞回归，完整结果已覆盖 owner 17 项及 runtime 相关 23 项，不重复额外运行。547 项产品基线结果与原 SEA 十项演练继续作为各自真实执行证据；本次没有重建 SEA 或重跑演练。

之前 `9137eb7..eb514f4` 仅为验收脚本、测试和文档同步，当时产品源码等价；该结论不延伸到之后的实际渲染字体屏障、文本渲染与合成参数、工程目录锁等待、不可变运行时发布、可选错误诊断、安全复用及 runtime 文件级重试修改。本次已重新执行下面的 547 项全量、UI/应用构建、Node SEA 打包及 source/SEA 共 10 项故障演练，没有沿用旧 Node/渲染运行时结果替代。Rust 源码树与 `dd711fe` 验收合并基线相同，沿用该轮 4 项测试与编译检查证据。旧基线证据仍保存在各自忽略目录，未被本轮覆盖。

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

同步主线的固定 `category / operation / ioCode / syscall` 元数据，从 renderer 实际错误进入匹配 revision 的 check 报告、任务状态和日志，上传摘要再次按枚举校验。原 error 文本和旧任务日志仍兼容；冻结或不可写的 Error 保留原异常信息，原生验收的历史读取挂起时仍返回 2 秒预算内已采集的固定任务状态。诊断不决定任务状态、审批或任务/模型重试，不放宽 PNG 验收或修改通用持久化 helper；runtime 文件级重试只由下述实际平台、code 和 syscall 判据触发。

## 不可变 runtime 资源复用

`a7c31c7` 的 Windows 脱敏固定诊断已证实重复发布路径上的 IO 失败：package 预览为 `runtime_spec_publish / EPERM / rename`，native 良好源码恢复为 `runtime_frame_publish / EPERM / rename`。这不证明具体锁持有者或杀毒软件是原因，也不反推此前缺少这些字段的 `2cb084b` 根因。

只对带内容 hash 的 scene、frame、spec 地址复用已有完整相同字节。检查使用同一读取描述符的 stat；大小相同时最多读取预期长度加 1 字节，确认完整内容和 EOF 后复用。缺失或内容不一致仍通过原耐久临时文件、sync、原子 rename 发布；只有 open 的 ENOENT 视为缺失，其余 open/stat/read/close 错误继续失败，替换前先关闭读取描述符。Mutable aliases 和 index 不使用条件跳过，继续原子发布，也没有删除/截断 fallback。六项复用回归覆盖旧实现第二次 prepare 的 EPERM 失败、修复后相同资源不替换、变更版本完整发布、缺失/损坏原子修复、非 ENOENT 读错误，以及超大和 stat 后变长文件的读取上限；原五项发布门闩继续保留。

## Runtime 专属 Windows rename 重试

源码等价的文档提交 `95bbf31` 在 Windows 原生复验中再次取得实际 IO 证据：无限循环恢复的 revision 2 预览失败，固定诊断为 `IO_ERROR / runtime_index_publish / EPERM / rename`；package、models、film、editor 已通过。对应 workflow 为 40690138976、job 为 122822547537，允许字段摘要 artifact 12817187216 的 ZIP SHA-256 为 `0ecd4aa0c4541b4e992c6d57158c547e3116ad53b753da6bb07d5ac5deadf205`。这证明必须原子替换的 index 路径也受到影响，仍不能归因于某个锁持有者。

本次 `writeRuntimeFile` 仅用于 runtime prepare：必要的 hash 发布，以及 aliases 和最后的 index 发布。只有实际 Windows、`code === 'EPERM'` 且 `syscall === 'rename'` 同时满足才重试，固定间隔 100ms、最多 8 次尝试，重试窗口为 750ms 单调时钟；单次内核 IO 继续等待完成，不声称可被该窗口中断。每次完整执行原有耐久写入，不用 Promise.race 遗留后台写，不修改全局 paid 回执持久化 helper。纯 EPERM/rename 耗尽时抛首个原 Node IO 错误；若后继遇其他 code 或 syscall，立即抛该当前错误。成功 rename 后目录 fsync 失败也不重试或回滚已经完整发布的 index。

七项新增回归验证临时拒绝释放后成功、永久拒绝的尝试上限、窗口耗尽保留原错、非 Windows/其他 code/其他 syscall/仅消息相似时单次失败，以及实际临时文件 fsync 和发布后目录 fsync 错误不重试。真实 localhost HTTP 双门闩核对等待期间旧图完整、每次新临时文件均同步、index 最后发布；这属于本机平台 fixture，不能代替新源码自己的 Windows 原生 CI。

## 已执行检查与边界

| 检查 | 结果 | 范围 |
| --- | --- | --- |
| 最后 test-only 同步后的全量 | **548/548，零失败、零跳过；typecheck PASS** | 在 `988a064` 同步合并提交 `c859e21` 完整执行；包含主线 512 项和 P0 五组 36 项，产品目录相对 `4de336a` 差异为空 |
| 产品源码基线的全量 | **547/547，零失败、零跳过** | 在 `6ae4103` 产品验收合并基线 `4de336a` 重新完整执行；包含当时主线 511 项和 P0 五组 36 项；对应本轮构建、SEA 和演练的真实源版本 |
| test-only 同步后的补验 | **23/23，零失败、零跳过；typecheck PASS** | `9761203` 上重新执行 runtime rename 7、publication 11、failure diagnostics 5 项；产品差异为空，沿用 `4de336a` 全量/构建/SEA 与故障演练证据 |
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

本轮 SEA 二进制为 129,362,576 字节，连同资源为 131,572,125 字节；SHA-256 为 `6aa562bb793467f3b13906773ef256037fe42ccb60fb290f1d67cdc7ab469ac6`。这只是当前本机产物的身份，不用于和历史 Linux 包直接比较体积。manifest 的 `signed=false`，构建中的 macOS ad-hoc 签名不等于发行签名或公证。本机 Homebrew Node 26.8.2 明确禁用了 SEA，本轮改用已有 Node 24.19.0 完成打包，未更改全局 Node。

本轮原始本机证据另存于忽略目录 `.local/p0-final-6ae4103-20261028/`：`node-tests.log`、`typecheck.log`、`build.log`、`sea-build.log`、`rust-source-equivalence.log`、`fault-drills-source.json`、`fault-drills-sea.json` 和 `sidecar-build/node-darwin-arm64/manifest.json`；test-only 同步补验另存为 `test-only-target.log`、`test-only-typecheck.log` 与 `test-only-sync-diff.log`。Rust 同源码树哈希为 `0483a15df701f7d994887b643d99deca05928406`，对应测试与检查日志保留在 `.local/p0-final-dd711fe-20261028/`。本轮在启动全量测试前已恢复自有临时依赖链接，取得 547/547、零跳过。前一轮 `2f39b31` 曾因链接未恢复跳过真实 Electron 用例，其初始日志与重新取得 507/507 的日志仍各自保留在原目录，不计为本轮结果。这些原始数据不随源码发布；本记录只保留脱敏计数、范围和产物哈希，未覆盖 `docs/p0/evidence/` 的历史性能或演练记录。

最终 fixture 测试同步的 548 项全量与类型检查另存于 `.local/p0-test-sync-988a064-20261028/`：`node-tests.log`、`typecheck.log`、`test-sync-diff.log`。它没有覆盖前述产品基线、SEA 或历史演练日志；测试前恢复的自有临时依赖链接在全部检查结束后清理。

## CI 触发与适用范围

专用 `Tauri P0 spike` workflow 的 push 条件包含 `spike/tauri-p0` 与本次独立加固分支。PR 路径过滤除 Rust、sidecar 和 P0 脚本外，也覆盖迁移、场景 worker、P0 测试及其 fixture。它运行三平台 Node SEA 构建、stdio 冒烟和 Rust release 编译，产物仍为未发行签名的实验构建；**不代表 Tauri 原生窗口或性能验收**。

通用 `Platform checks` 与 `Native and media acceptance` 不限制上述分支，但其原生应用对象仍是主线 Electron 应用。触发配置说明哪些检查会被尝试执行，不构成对应提交的远端 CI 已通过证据，应查看该提交实际 Actions 结果。

此前主线在用户手动处理系统钥匙串后，新包于 `2026-10-28T11:19:03.529Z` 取得单次完整本机 73/73 通过，包含此前无限循环恢复、Keychain 与 sandbox 路径；这是当时主线 Electron 本机验收。`accfdf3` 的三平台快速矩阵已通过（Actions run 40679330829），三平台 Electron 原生媒体验收也已通过（run 40679330857）。这些旧提交证据不替代最新源码自己的原生验收。

前一主线诊断提交 `0f26d9a` 的三平台快速矩阵已通过（Actions run 40683701636），同一干净提交的 Electron 原生媒体验收三平台也全部成功（run 40683701661：macOS 73、Windows 73、Linux 74 项）。主线本机完整 498/498、类型检查、构建与搬迁包布局检查已通过；新增诊断后的 GUI 结果以这次远端干净提交为证，不标成本轮重新执行的本机 73 项。

独立分支此前提交 `2cb084b` 的专用 SEA/stdio/Rust 三平台与通用快速三平台已通过，但继承的 Windows Electron 原生验收失败：package 的 revision 4 预览任务为 `TASK_FAILED`，native 在聊天重试等待处超时；models、film、editor 已通过。当时脱敏摘要没有具体 IO code 或 syscall，不能判定其 Windows 根因，也不将其记为通过。随后 `a7c31c7` 的专用与快速三平台也通过，但 Windows Electron 原生失败并取得上述固定 IO/rename 证据。此前主线 `ef3104c` 及独立分支 `7c21a490e81149d31b0b0f7cb4fb89bf463a12c1` 曾取得各自三平台通过，但其源码等价文档提交 `95bbf31` 的 Windows 原生复验再次失败，不能用旧通过覆盖该失败。当前 `6ae4103` 修改了 runtime 文件发布行为，不再与上述旧源码等价；本次主线和独立分支均须核对自己的新 CI。本轮没有执行 Tauri 原生窗口验收，P0 中断恢复演练也不替代该验收。

主线 runtime 修复源码 `6ae4103` 的三平台 Electron 原生流程已全部成功（workflow 40693416863）。其 Windows 快速矩阵唯一失败是旧诊断测试仍假定文件只尝试一次，这一测试-only 断言已在 `e7cbf37` 修正；不能把这项旧断言失败写成通过。`e7cbf37` 和本独立分支最新提交仍分别等待自己的完整 CI 结果；旧源码或本机平台 fixture 的通过均不替代它们。

`e7cbf37` 的 Linux 快速矩阵随后在不同 profile/projects 的测试 fixture 中遇到目录身份派生锁端口碰撞，保守返回 BUSY；该次失败继续保留，不推断具体锁持有者。`988a064` 仅为 fixture 选择不冲突的临时目录身份，保留原成功、互斥和数据保护断言，并新增碰撞回归；产品锁协议及保守 BUSY 约定未改变。主线 `988a064` 本机全量 512/512 与本分支 548/548 已通过，但 `988a064` 及本独立分支最终提交仍须核对各自 CI，不能用 `6ae4103` 原生通过替代新提交的快速矩阵结果。

本轮没有执行 sudo/drop_caches、真实计费 API、真实旧凭据迁移、Tauri 原生 GUI 验收、Windows JobObject 验收、干净目标机安装、发行签名/公证或新的 Linux 冷启动/PSS 同口径性能比较。历史 P0 报告和 evidence 保留为历史记录，不用本轮加固追认旧性能数字。

## 此前独立提交的远端验收（历史）

本表保留历史源码验收提交 `7c21a490e81149d31b0b0f7cb4fb89bf463a12c1`，其本机产品源码为 `11ff0074a9b19b325cc62808d9e43720f2e71f94`，当时两者之间仅 HARDENING 文档变化。后续文档同步至 `95bbf31` 仍保持该产品源码等价，但 Windows 原生复验再次失败，见上文。当前有界重试修复是新源码，此表不构成其通过证据，也不循环改写旧表以追逐说明提交触发的新 CI 编号。

| 检查 | 三平台结果 | 范围 |
| --- | --- | --- |
| [Platform checks 40688252045](https://github.com/lakeofsky347/yingliu-agent/actions/runs/40688252045) | PASS；Mac/Linux各526通过14跳过，Windows511通过29跳过，全部零失败 | 总数540；Windows未支持的POSIX进程用例明确跳过 |
| [Tauri P0 spike 40688252168](https://github.com/lakeofsky347/yingliu-agent/actions/runs/40688252168) | Windows/macOS/Linux全部PASS | SEA构建、stdio冒烟、Rust release编译；非Tauri原生GUI |
| [Native and media acceptance 40688252048](https://github.com/lakeofsky347/yingliu-agent/actions/runs/40688252048) | Mac73/73、Windows73/73、Linux74/74；全部PASS | 继承的Electron搬迁包/原生/媒体/模型费用/编辑安全；非Tauri原生GUI |

三份原生允许字段摘要已分别下载，核对 clean 提交、所有阶段、系统凭据后端、sandbox、加密与临时数据清理，以及 GitHub 公布的 ZIP SHA-256。对应 artifact 为Linux12816042962、macOS12815863062、Windows12815678992，摘要身份完整保存在同步后的 [机器可读交付记录](../acceptance-2026-10-28.json)。此前2cb失败保持UNKNOWN、a7的EPERM/rename实证继续保留；没有把旧失败重标PASS，没有放宽哈希或自动重试任务。
