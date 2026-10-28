#!/usr/bin/env bash
# Only for an isolated CI Linux session. Never selects basic_text or disables the application sandbox.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/ci-owned-job.sh"
if [[ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ]]; then
  echo "A session D-Bus is required; run with dbus-run-session." >&2
  exit 1
fi
acceptance_keyring_root=$(mktemp -d)
export XDG_DATA_HOME="$acceptance_keyring_root/data" XDG_CONFIG_HOME="$acceptance_keyring_root/config" XDG_CACHE_HOME="$acceptance_keyring_root/cache"
export GNOME_KEYRING_CONTROL="$acceptance_keyring_root/control" XDG_CURRENT_DESKTOP=GNOME DESKTOP_SESSION=gnome
export YINGLIU_VERIFY_PASSWORD_STORE=gnome-libsecret
mkdir -p "$XDG_DATA_HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$GNOME_KEYRING_CONTROL"
acceptance_keyring_password=$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")
gnome-keyring-daemon --foreground --unlock --components=secrets --control-directory="$GNOME_KEYRING_CONTROL" < <(printf '%s' "$acceptance_keyring_password") >"$acceptance_keyring_root/keyring.out" 2>"$acceptance_keyring_root/keyring.err" &
acceptance_keyring_pid=$!
unset acceptance_keyring_password
cleanup_acceptance_keyring() {
  local acceptance_exit=$?
  trap - EXIT
  acceptance_stop_owned_job "$acceptance_keyring_pid" || acceptance_exit=1
  rm -rf "$acceptance_keyring_root"
  exit "$acceptance_exit"
}
trap cleanup_acceptance_keyring EXIT
acceptance_keyring_ready=false
for ((attempt=0; attempt<30; attempt++)); do
  # Query the bus without auto-activating a different keyring daemon.
  if [[ "$(gdbus call --session --dest org.freedesktop.DBus --object-path /org/freedesktop/DBus --method org.freedesktop.DBus.NameHasOwner org.freedesktop.secrets 2>/dev/null)" == '(true,)' ]]; then
    acceptance_keyring_ready=true
    break
  fi
  sleep 0.2
done
if [[ "$acceptance_keyring_ready" != true ]]; then
  echo "The isolated Secret Service did not start; native credential acceptance cannot pass." >&2
  exit 1
fi
xvfb-run -a -s '-screen 0 1920x1200x24' node scripts/run-platform-acceptance.mjs "$@"
