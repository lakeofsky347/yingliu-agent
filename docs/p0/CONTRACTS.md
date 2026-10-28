# Sidecar 合约（protocolVersion 1）

## 启动
`yingliu-sidecar --data-root <abs> --projects-root <abs> --resource-root <abs> [--port N] [--secrets memory] [--mock] [--lock-timeout-ms N]`

- 路径必须为绝对路径（允许空格/中文）；否则 USAGE(2)。
- 启动前先取 owner 锁（与 CLI 同一把锁）；占用 → BUSY(9)；`YINGLIU_LOCK_PORT` 等配置无效 → CONFIG(10)；其余启动失败 → STARTUP(11)。
- UI server 以 `sceneFrames:false` 启动 → CSP `frame-src 'none'`，场景不在 WebView 中执行。

## 就绪握手（stdout 单行 JSON）
`{"type":"ready","protocolVersion":1,"resourceVersion":"p0-1","profileId","pid","port","origin","token","mock","readyMs","runtime"}`
token 仅经 stdout 交给宿主；日志与证据中一律脱敏。

## 关闭
触发：stdin `{"type":"shutdown"}` / stdin EOF（宿主死亡）/ SIGINT / SIGTERM。
顺序：dispose（取消任务、结束子进程）→ server close → 释放锁 → stdout `{"type":"shutdown","ok","reason"}` → exit 0。

## 壳（src-tauri）
- 只允许导航到 sidecar origin；`on_new_window` 一律 Deny。
- 运行时按精确 origin 添加 capability（`remote(origin/*)`），无通配。
- 命令仅 `pick_project`、`quit_app`。
