# P0 基线

- 基线提交：`main` @ `c03828f`（spike/tauri-p0 由此分出）；Electron 44.5.1（main 上的版本，fix/leftovers 中升到 44.9.3，不影响结论）。
- 环境：Linux x64 容器，Xvfb，Node 22.20.0，Bun 1.4.2，rustc 1.99.1，Tauri 2.12.5，WebKitGTK 2.54。
- Electron 包：`npm run package:app` → `artifacts/yingliu-agent-linux-x64` 共 314,829,068 B（其中 resources/app 约 18.6 MB）。
- Electron 空闲（S0）：见 `evidence/measure/electron-warm.json`，10 次，ready 中位 734 ms / P95 1014 ms，PSS 中位 340.8 MiB。
- 测量需 `--remote-debugging-port`（判定 ready）与 `--no-sandbox`（容器内），两者对内存影响很小但需注明。
