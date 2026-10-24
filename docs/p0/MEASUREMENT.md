# 测量协议

工具：`scripts/p0/measure.mjs --mode electron|tauri|sidecar --runs 10 --idle-ms 10000 [--drop-caches]`

- ready：Electron = CDP 页面加载完成；Tauri = 壳 stderr `[p0-shell] page-load-finished`；sidecar = ready 握手。
- S0 内存：ready 后空闲 10 s，汇总整个进程树的 PSS（`/proc/*/smaps_rollup`），同时记录 RSS 与分进程明细。
- warm：连续运行；cold：每次前 `echo 3 > /proc/sys/vm/drop_caches`。
- 报告中位与 P95、失败次数、残留进程。
- 已知偏差：一部分 warm 运行与 W4 测试并发；Linux/Xvfb 的数字不能代表 macOS/Windows。
