# yingliu CLI（给智能体和脚本用）

`yingliu` 是映流智能体的 headless 命令行。它不打开界面，也不需要接入 MCP/IPC。它调用的服务和桌面应用相同（`createApplication().route()`），所以工程、审批、预算和质检规则都一样。

## 快速开始

```bash
scripts/setup-cli.sh                       # npm ci + build + 环境检查；可选 --link 安装到 PATH
export YINGLIU_DATA_DIR=/tmp/yl/data       # 数据目录（模型配置、运行记录、账本）
export YINGLIU_PROJECTS=/tmp/yl/projects   # 工程目录（可选；默认 $YINGLIU_DATA_DIR/projects）
yingliu doctor --json                      # 或 node bin/yingliu.mjs / npx yingliu / npm run cli --
P=$(yingliu project create --title 片头 --json | jq -r .data.id)
yingliu agent run --project "$P" --goal "做一个 10 秒片头" --mock --json   # 停在导出审批 → exit 4
yingliu agent status <runId> --json        # 看 pending.callId / pending.execId
yingliu agent approve <runId> --call <callId> --exec <execId> --mock --json
yingliu export mp4 "$P" --out ./out.mp4 --json
```

`--mock` 会使用内置的本地模拟导演（`http://mock.yingliu.invalid/v1`，请求在进程内应答，不走网络）。它会把导演角色绑定到模拟模型上。为了不覆盖真实配置，**mock 请使用单独的 `YINGLIU_DATA_DIR`**。模拟脚本依次调用 project_get、video_update（一个镜头）、export_mp4（需要审批）。mock 结果只证明流程跑通，不代表真实模型的效果。

## 全局约定

- 每次调用都是非交互的。加 `--json` 后，stdout 只输出一行 JSON。
- 成功：`{"ok":true,"data":<结果>}`
- 失败：`{"ok":false,"error":{"code":"USAGE|NOT_FOUND|ERROR|...","message":"中文说明"}}`
- 不加 `--json` 时，结果以可读 JSON 输出，错误写到 stderr。
- `--timeout <秒>`：等待运行或任务的上限，默认 600。超时后运行会被暂停，可以用 `agent resume` 继续。
- **单一数据所有者（C01）。** 每条命令在打开应用前，会按数据目录（`YINGLIU_DATA_DIR`）和工程目录（`YINGLIU_PROJECTS`）的真实目录身份，取得由操作系统持有的本机 TCP listener 锁，应用清理完毕才释放。符号链接别名指向同一把锁。其他进程最多等 `--lock-timeout` 秒（默认 30）；这一等待同样覆盖后续发现的实际工程根目录，并沿用命令的取消信号。超时返回 `BUSY`（exit 9）；能识别占用者时附上 pid 和命令。进程崩溃时操作系统自动释放，无需删除 `.yingliu-owner.lock`；旧版本遗留的空或截断文件不参与新锁判断。端口由目录身份哈希到 21000–28999（刻意避开 Linux 32768–60999 与 Windows/macOS 49152–65535 的临时端口范围，出站连接不会占用它）。每个目录有 1 个主端口和 3 个备用端口；监听方在握手里报出目录身份的哈希。若端口已被**另一个 profile** 的 yingliu 进程或会主动发数据的其他服务占用，就顺延到下一个备用端口，不再误报 BUSY；只有同一目录身份的持有者才返回 BUSY。抢到端口后还会复查前后各槽位，两个进程同时抢同一目录时，至少一方能看到对方，所以不会出现双重所有者。端口上是不发数据的监听者，或旧版（v1 协议）进程占着主端口时，无法确认身份，仍保守返回 BUSY，不会接管；4 个端口都被其他 profile 占满时同样返回 BUSY。仍可设置 `YINGLIU_LOCK_PORT=<1024–65535>` 指定固定端口（所有目录共用这一把锁，即整机串行，不再顺延），取值无效时返回配置错误（CONFIG，exit 10）。该互斥适用于同机采用相同协议的 CLI、桌面、浏览器服务及默认嵌入应用；旧 CLI 的 listener 协议继续兼容，不协调未采用它的旧桌面、其他机器或其他网络命名空间。实际工程根目录在打开或修复前动态加锁，不同 profile 打开同一外部工程时同样有界等待，仍被占用则返回 BUSY。长时间运行的桌面或 `agent run` 会独占整个 profile；并行任务请使用不同的数据、工程目录和实际工程。不要删除锁文件或绕过所有权。
- 只读命令（`project list/get`、`agent status`、`story/ledger show`、`qc show`（不带 `--run`）、`models list`）以只读方式打开：不会结算中断的运行，不会恢复媒体任务，也不会改写状态。
- 正常退出前会等待运行关联的工程任务。收到 SIGINT/SIGTERM 时，入口停止新调用，等待应用停止其拥有的工作与子进程，然后释放锁；JSON 返回 `INTERRUPTED`，分别退出 130/143。
- `agent run/resume/approve/reject` 按工具回执中保存的任务 ID 汇总所有关联任务，结果在 `tasks` 数组中返回。任何未被成功显式重试替代的失败或取消任务都会返回 `ok:false`、`code: RUN_FAILED`（exit 7），并在 `error.run`、`error.task`、`error.tasks` 中附上详情；后续预览成功不会覆盖导出失败。成功导出按任务记录的 `outputId` 返回对应的 `data.output.path`，不会选择工程最后一个产物。模型可用 `export_mp4` 的 `retryTaskId` 显式重试失败或取消的导出；只有该重试链上成功且有对应成片时，才替代原失败任务。

## 退出码

| 码 | 名称 | 含义 |
|---|---|---|
| 0 | OK | 成功；运行状态为 complete |
| 1 | ERROR | 服务端拒绝（例如审批过期、参数不合法） |
| 2 | USAGE | 命令或参数错误，或违反安全规则（例如自动批准付费操作却没给预算上限） |
| 3 | NOT_FOUND | 工程或运行不存在 |
| 4 | NEEDS_APPROVAL | 运行停在 awaiting_approval 或 paused，需要 approve/reject/resume |
| 5 | BUDGET | budget_exceeded |
| 6 | ENVIRONMENT | doctor 未通过，或导出缺少 Chromium/ffmpeg |
| 7 | RUN_FAILED | 运行状态为 failed/cancelled，或导出任务失败 |
| 8 | TIMEOUT | 等待超时（运行已暂停） |
| 9 | BUSY | 该数据目录正被另一个 yingliu 进程占用（等待 `--lock-timeout` 秒后仍未释放） |
| 10 | CONFIG | `cli-key-env.json` 损坏或无法读写（原文件保持不变） |
| 11 | STARTUP | 启动失败（数据目录无法创建、所有者锁无法取得、应用状态无法加载等）；`--json` 下只输出一行 `ok:false` |
| 130 / 143 | INTERRUPTED | 收到 SIGINT / SIGTERM；等待应用清理后退出 |

## 命令参考

| 命令 | data |
|---|---|
| `doctor` | `{ok, checks:[{name:"node"|"ffmpeg"|"ffprobe"|"chromium", ok, detail}], dataDirectory, projectsDirectory}` |
| `project create --title T [--topic T]` | `{id, title, root, revision}` |
| `project list [--include-archived]` | `[{id, path, title, createdAt, updatedAt, archived?}]` |
| `project get <id>` | `{project:VideoProject, root, task}` |
| `project export-zip <id> --out F` | `{name, path, size}`（.yingliu 包，含 agent/story、ledger、qc） |
| `project import <F>` | `{id, title, root}`（新 ID；校验不通过时不会注册工程） |
| `agent run --project ID --goal G [选项]` | Run（见下） |
| `agent status <runId> [--trace]` | Run；加 `--trace` 时附带 `trace:[事件]` |
| `agent resume <runId>` | Run |
| `agent approve <runId> --call C --exec E [--args-hash H]` | Run（execId 必填；过期会返回 ERROR） |
| `agent reject <runId> --call C --exec E [--reason R]` | Run |
| `story show <projectId>` | Story |
| `qc show <projectId> [--run]` | 上次的 QcReport 或 null；加 `--run` 时立即重新质检 |
| `ledger show <projectId>` | `{spent, maxCost, currency, unknownCostCalls, byTool}` |
| `render <projectId>` / `export mp4 <projectId> [--out F]` | `{projectId, path, output}` |
| `models list` | `{connections:[{id,name,protocol,baseUrl,auth,hasKey,apiKeyEnv}], models, roles}` |
| `models add --name N --base-url U --model M [--protocol P] [--role R\|none] [--output-modality O] [--api-key-env ENV]` | `{connectionId, modelId, protocol, outputModality, role, apiKeyEnv}`。按协议推导输出和默认角色：chat-completions→text/director，images→image/image，video-gateway→video/video，speech→audio/speech；async-task 必须给 `--role`（music/sfx/image/video/speech）或 `--output-modality`。先做全部预检，任何一步失败都会回滚，不留下连接、模型或密钥绑定 |

`agent run` 选项：
- `--auto-approve read,write,plan`（默认值）
- `--allow-paid --max-cost N`
- `--max-steps N`
- `--max-review-rounds N`
- `--no-wait` 已不支持（返回 USAGE，exit 2）：CLI 没有常驻进程，命令退出后运行会被中断。用 `--timeout` 控制等待，超时后运行会暂停，可用 `agent resume` 继续

**Run** 的结构：

```json
{"id":"…","projectId":"…","status":"running|awaiting_approval|waiting_task|paused|complete|failed|cancelled|budget_exceeded",
 "message":"…","goal":"…","usage":{"steps":0,"toolCalls":0,"inputTokens":0,"outputTokens":0,"cost":0,"unknownCostCalls":0,"currency":"CNY"},
 "budget":{"maxSteps":24,"maxToolCalls":60,"maxTokens":400000,"maxCost":null,"currency":"CNY"},
 "pending":{"callId":"…","execId":"…","argsHash":"…","tool":"export_mp4","risk":"export","arguments":"{}","reason":"…","estimate":0},
 "uncertainSubmissions":[{"execId":"…","tool":"…","error":"…","jobId":"…"}],
 "final":"…","error":"…","steps":8,"task":{"kind":"export","status":"complete"}}
```

## 安全规则（智能体必须遵守）

1. **付费和导出默认不自动批准。** 只有同时提供 `--allow-paid` 和正数 `--max-cost`，`--auto-approve` 里才能包含 `cost` 或 `export`，否则返回 exit 2。预算上限会写入运行的 `budget.maxCost`。费用未知的付费调用仍需人工批准。
2. **审批必须带 execId。** 只能批准 `agent status` 当前返回的 `pending.execId`。参数变化或步骤已过期都会被拒绝，不要猜测或复用旧的 execId。
3. **`uncertainSubmissions` 非空时，表示云端可能已经受理并计费。** 系统不会自动重新提交，后续付费调用都需要人工批准。重新提交前先确认外部任务（jobId）的状态。
4. **API Key 只通过环境变量提供。** `models add --api-key-env NAME` 只保存变量名（`$YINGLIU_DATA_DIR/cli-key-env.json`），不保存密钥本身，也不会打印。运行时从环境变量读取。该文件只有在不存在时才视为空；内容损坏或权限错误会返回 `CONFIG`（exit 10），且不会改动原文件。写入采用临时文件加 rename 的原子方式。
5. `--mock` 模式下，除本地模拟网关外的任何网络请求（模型、媒体、语音、恢复轮询，包括直接调用全局 fetch 的通道）都会在发出前被拒绝；已存在的非 mock 待处理媒体任务不会被恢复或轮询，保持原状，等非 mock 命令再处理。不要把 mock 结果当成真实模型验收；不要读取其他应用的凭据。
6. 同一 profile 同一时刻只有一个 CLI 进程持有数据（见“单一数据所有者”）。收到 `BUSY` 时，应该等待后重试，不要删除锁文件。
