#!/usr/bin/env bash
# Run a command (as the calling user) in a private mount namespace where the source tree, the dev node_modules,
# the /opt CLI install and every system node/npm/bun binary are unreachable. Linux only; needs sudo.
# Usage: isolate.sh <hide-path>... -- <command> [args...]
set -euo pipefail
hide=(); while [[ $# -gt 0 && $1 != -- ]]; do hide+=("$1"); shift; done; shift
uid=$(id -u) gid=$(id -g)
script='set -e; for p in "$@"; do case $p in --) shift; break;; esac; if [ -d "$p" ]; then mount -t tmpfs -o ro,size=1k none "$p"; elif [ -e "$p" ]; then mount --bind /dev/null "$p"; fi; shift; done; exec setpriv --reuid='$uid' --regid='$gid' --init-groups env -i HOME="$HOME_KEEP" PATH=/usr/bin:/bin DISPLAY="${DISPLAY_KEEP:-}" "$@"'
for b in node npm npx bun tsx; do for d in /usr/bin /usr/local/bin /bin; do [ -e "$d/$b" ] && hide+=("$d/$b"); done; done
exec sudo HOME_KEEP="$HOME" DISPLAY_KEEP="${DISPLAY:-}" unshare -m --propagation private bash -c "$script" isolate "${hide[@]}" -- "$@"
