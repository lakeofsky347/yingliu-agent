#!/usr/bin/env bash
# Set up the yingliu CLI: install deps, build, check the environment. Optional: --link installs `yingliu` on PATH.
#   scripts/setup-cli.sh [--link [BIN_DIR]]     (default BIN_DIR=/usr/local/bin; uses a small wrapper, not npm link)
# Env: YINGLIU_DATA_DIR (wrapper default: ~/.local/share/yingliu-agent-cli), YINGLIU_PROJECTS (optional).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
command -v node >/dev/null || { echo "需要 Node.js >= 22.18" >&2; exit 6; }
node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=18)?0:1)' || { echo "Node.js 版本过低：$(node -v)，需要 >= 22.18" >&2; exit 6; }
if [ ! -d node_modules ] || [ package-lock.json -nt node_modules ]; then ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci --no-audit --no-fund; fi
npm run build --silent
if [ "${1:-}" = "--link" ]; then
  BIN_DIR="${2:-/usr/local/bin}"
  NODE_BIN="$(command -v node)"
  cat > "$BIN_DIR/yingliu" <<WRAP
#!/usr/bin/env bash
# yingliu CLI wrapper → $ROOT
export YINGLIU_DATA_DIR="\${YINGLIU_DATA_DIR:-\$HOME/.local/share/yingliu-agent-cli}"
exec "$NODE_BIN" "$ROOT/bin/yingliu.mjs" "\$@"
WRAP
  chmod +x "$BIN_DIR/yingliu"
  echo "已安装：$BIN_DIR/yingliu → $ROOT"
fi
node bin/yingliu.mjs doctor --json || echo "doctor 未全部通过（导出需要 Chromium 与 ffmpeg），其余命令可用" >&2
