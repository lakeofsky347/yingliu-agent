# 映流智能体工作区核对与施工计划

日期：2026-10-27（Asia/Singapore）。本轮先只读核对本地、远端、实现及既有验收记录，再修复已复现的数据丢失、并发执行和恢复缺陷。界面、智能体、工程存储与媒体恢复分别审查，最终统一验证。

## 开发基线

| 对象 | 核对结果 | 处理 |
| --- | --- | --- |
| 初始本地分支 | `codex/fix-audit-round-2`，`035c00bf8951e95bef064e483b7f74cd6b885303`；工作区干净 | 保留原分支 |
| 远端主线 | `main`，`5ff743eaf0a076de10551f2ca7ab72a3485bc1bc` | 作为本轮基线 |
| 进度差异 | 原 HEAD 是 main 的祖先；main 多 15 个可达提交，含 CLI 后续修复、HTTP 运行时安全和预览进程恢复 | 新建 `codex/workspace-improvements-20261027` |
| 其他开发分支 | 最新 `feat/cli@4ba5ae5`、`fix/audit-2026-10@aeab444` 已包含在 main | 不重复移植 |
| Tauri 试验 | `spike/tauri-p0@5134295`；[PR 4](https://github.com/lakeofsky347/yingliu-agent/pull/4) 标明 draft、do not merge | 独立保留，不作为可替换 Electron 的发布基线 |
| 既有 CI | main 对应 [Platform checks 40169024170](https://github.com/lakeofsky347/yingliu-agent/actions/runs/40169024170) 为 success | 仅证明该历史提交，不替代本轮测试 |
| 本机依赖 | 已安装 Electron 44.5.1、Undici 7.30.0；main 锁定 44.9.3、7.30.1 | 按锁文件 `npm ci` 后再测试 |

核对范围包括 README、架构、CLI、智能体及平台验收文档，工程/历史/备份实现，智能体执行与恢复、媒体任务与协作流程、客户端编辑与导航，以及现有测试和 CI 配置。未读取用户凭据或日常工程内容。

## 已复现缺陷

| 编号 | 优先级 | 触发与影响 | 主要入口 |
| --- | --- | --- | --- |
| D01 | P1 | 两个并发 start 都可能通过占用检查；暂停 A、启动 B 后恢复 A 也可产生同工程两个 active run | `src/agent/service.ts` |
| D02 | P1 | A 工程角色草稿没有纳入全局未保存检查；切 B 后保留 A 草稿，保存时使用 B 的 ID/version，覆盖 B 角色库 | `src/client/StoryPanel.tsx`、`Studio.tsx`、`controller.ts` |
| D03 | P1 | 智能体 start/approve/resume 直接调用 API，绕过工程保存失败和源码草稿检查 | `src/client/AgentPanel.tsx` |
| D04 | P1 | import/audio 省略 expectedRevision 仍可修改工程；音轨 update/remove 可覆盖更新 | `src/host/service.ts`、`controller.ts` |
| D05 | P1 | 项目预算只在下个模型回合检查；同回合首个工具达到上限后仍可批准第二个收费工具 | `src/agent/service.ts` |
| D06 | P2 | 5 秒轮询更新账本时重新 setCap，覆盖用户正在编辑的预算 | `src/client/StoryPanel.tsx` |
| D07 | P2 | 同步 binary 结果检查暂时失败后，retry 以本地 clientRequestId 当远端 jobId 查询不存在的任务，无法复用持久产物 | `src/jobs/media-tasks.ts` |
| D08 | P2 | SSE/poll 读取初始 live 闭包，流正常结束缺少状态回落；工程切换后旧请求可能回写；首次列表与订阅之间的状态变化可能漏掉审批 | `src/client/AgentPanel.tsx` |

复现仅使用临时目录、内存响应或本机模拟网关。没有真实生成或计费请求。

## 施工计划表

状态随施工更新；验收必须对应最终代码。P1 为数据或执行安全，P2 为可恢复性及交互可靠性。

| 编号 | 对应缺陷 | 施工内容 | 依赖 | 验收条件 | 状态 |
| --- | --- | --- | --- | --- | --- |
| S01 | 基线 | 刷新远端、确认祖先关系、建立新施工分支 | 无 | 原工作保留，main SHA 已核对 | 完成 |
| S02 | D01 | 同工程生命周期串行与占用复核，覆盖 start/resume/approve/reject | S01 | 并发 start 仅一个继续；恢复/审批不能越过其他占用；不同工程可并行 | 完成 |
| S03 | D02 | 角色/预算草稿接入 controller；保存或显式放弃后解除；保护切面板、首页、工程和关闭 | S01 | 草稿不丢失、不串工程；错误保存保留草稿 | 完成 |
| S04 | D03 | 智能体执行操作通过统一保存/草稿检查 | S03 | 保存失败、源码或面板草稿存在时不发送 start/approve/reject/resume | 完成 |
| S05 | D04 | import/audio 强制 CAS；客户端及内部合法调用补齐版本 | S01 | 缺版本拒绝；旧版本拒绝；同版本并发写仅一个成功 | 完成 |
| S06 | D06/D08 | 轮询保护编辑值，异步响应绑定工程，SSE 断开后有界回退 | S03/S04 | 预算跨轮询保留；旧工程响应无效；断流回退；订阅后保证补读 | 完成 |
| S07 | 环境 | 锁文件安装、类型检查、针对性回归、完整测试、构建 | S02–S06/S11/S12 | 最终完整测试 348/348、零跳过；类型检查与构建通过 | 完成 |
| S08 | 验收 | 隔离目录下的界面、媒体与搬迁包检查 | S07 | Chromium 8/8；搬迁原生包 19/19；完整原生成片 21/21 | 完成 |
| S09 | 文档 | 保留历史证据，新增本轮验收入口与未完成边界 | S07/S08 | 计划、变更和脱敏验证摘要相互对应 | 完成 |
| S10 | 交付 | 提交、推送本施工分支，核对远端 SHA | S07–S09 | 工作区干净，本地 HEAD 等于远端施工分支；交付消息记录最终 SHA | 交付阶段 |
| S11 | D07 | 成功同步媒体结果重试/重启优先复用持久产物 | S01 | 13 个恢复回归通过；一次 POST；重试/重启复用；真实异步 ID 查询保留 | 完成 |
| S12 | D05 | 每个工具及已批准调用执行前检查项目预算 | S02 | 达上限后停止；前置准备期间收紧上限也无提交；成功回执优先结算一次 | 完成 |

并行施工边界：智能体 service 与对应测试、客户端与对应测试、host/media 与对应测试各由独立审查者负责；文档、环境和集成验证统一汇总。任何共享文件冲突先协调。

## 验证顺序与交付标准

1. 使用锁文件安装，核对 Electron/Undici 实际版本；生产依赖、锁文件和构建身份一致。
2. 对每项缺陷做行为回归，使用隔离目录和可控响应。覆盖并发冲突、异步旧结果、错误后重试与重启恢复。
3. 执行 `npm run typecheck`、`npm test`、`npm run build`，核对失败/跳过原因。
4. 使用本机 Chromium 检查角色/预算草稿和智能体操作；实际媒体测试由 Chrome/FFmpeg/ffprobe 执行，有环境缺失明确记录。
5. 按需要执行 `npm run package:app` 和 `node scripts/verify-package.mjs --layout-only`，将布局/服务验证与完整原生界面验收分开。
6. 检查差异、敏感文件排除和许可证；仅提交源码、测试及脱敏文档。推送施工分支，核对 SHA，不自动合并 main。

## 后续完善清单

| 项目 | 当前判断 | 下一步和进入条件 |
| --- | --- | --- |
| Workflow 回执耐久性 | `WorkflowService.persist` 为 writeFile + rename，未达到 agent durable-file 的文件/目录 fsync 等级；未做断电故障注入 | 先制定提交/回执边界，再做故障注入、失败保留与平台能力验证 |
| CLI 与桌面共同所有权 | CLI 文档明确其锁只协调采用相同协议的同机 CLI | 先定义桌面/服务共用协议及迁移兼容，不能仅凭锁文件宣称解决跨进程写入 |
| 真实模型与预算估算 | 协议回归不证明供应商质量或报价；未知费用不能当零 | 使用用户在应用内配置的账户、明确费用授权和独立验收方案后执行 |
| Replicate 模型路径 | owner/name 的编码行为仅本机网关覆盖 | 在实际账号验收前维持已记录限制，不宣称兼容 |
| 跨机器发行 | 本机构建和 CI 不等同干净目标机安装/钥匙环/播放验收 | 分别验收 Windows、Linux、macOS 架构和钥匙环后更新支持声明 |
| 签名与公证 | macOS 为 ad-hoc；无公开发行验收 | Developer ID、公证及安装包另列发布任务 |
| Tauri 迁移 | P0 可行性分支仍禁止合并 | 先解决其独立 review 阻塞项并复核原生窗口与恢复，再另行决策 |

## 本轮验收结果

最终代码完成两轮独立交叉审查；新增的最晚执行预算竞态和 SSE 订阅窗口缺口均已补回归。完整回归在这些修复后的稳定代码上执行，后续仅更新文档与交付记录。

| 检查 | 本轮结果 | 实际范围 |
| --- | --- | --- |
| 依赖 | Electron 44.9.3、Undici 7.30.1，与锁文件一致 | `npm ci` 安装；依赖版本未升级 |
| `npm run typecheck` | PASS | 最终源码与测试 |
| `npm test` | 348 total / 348 pass / 0 fail / 0 skip | 隔离工程、本机网关、实际 Chromium/FFmpeg 与运行时安全回归 |
| `npm run build` / `npm run package:app` | PASS | 最终 macOS arm64 应用；ad-hoc 临时签名 |
| `npm run verify:editor` | 8/8 PASS | 真实 Chromium、临时工程、智能体回执 fixture；无未捕获浏览器异常 |
| `node scripts/verify-package.mjs` | 19/19 PASS，0 skip | 搬迁到源码目录外，实际 Electron GUI、原生预览、备份恢复和关闭重启 |
| `YINGLIU_VERIFY_EXECUTABLE=… npm run verify` | 21/21 PASS | 使用最终打包应用，6 秒/144 帧 H.264 + 合成音、ffprobe、全片解码、原生播放、备份恢复、重启、加密合成凭据、undo/redo、死循环场景恢复 |
| `git diff --check` | PASS | 补丁空白检查 |

脱敏、可提交摘要：[acceptance-2026-10-27.json](acceptance-2026-10-27.json)。完整本地报告为 `artifacts/acceptance-editor-safety/report.json`、`artifacts/acceptance-v03/package-verification.json`、`artifacts/acceptance-v03/verification.json`；日志、截图、测试工程及成片保留本地并由 `.gitignore` 排除。

本轮原生测试使用应用独立的临时验收目录、合成凭据和本机 HTTP 网关；真实供应商、真实计费、完整人工观片听音和跨机器安装仍为未验收。远端 CI 的平台 skips 应按对应提交的 Actions 单独读取，不以本机零跳过代替远端结论。
