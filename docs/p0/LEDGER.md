# 工作台账

| 项 | 状态 | 证据 |
|---|---|---|
| W0 基线/合约/协议/模板/决策线 | 完成 | 本目录 |
| W1 Node SEA sidecar | 通过（Linux） | evidence/node-linux-x64/ |
| W1 Bun sidecar | 通过（Linux） | evidence/bun-linux-x64/ |
| W2 Tauri 壳（Linux 实跑） | 通过 | src-tauri/、evidence/measure/ |
| W2 三平台 CI 构建 | 见 PR CI | .github/workflows/tauri-p0.yml |
| W4 场景隔离 | 通过（Linux） | evidence/w4/、tests/p0-scene-isolation.test.ts |
| Day8 故障演练 | 通过（Node/Bun） | evidence/fault-drills-*.json |
| 凭据迁移演练 | 通过（合成凭据） | tests/p0-credential-migration.test.ts |
| W3 RPC / preview session | 未测（P0 范围外） | — |
| macOS/Windows 原生 UI、WebView2、签名、S1/S2、Linux 发行版矩阵 | 未测 | 见 REPORT.md |
