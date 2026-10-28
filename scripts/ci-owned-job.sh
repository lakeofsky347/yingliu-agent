#!/usr/bin/env bash
# Source from the shell that launched the single background job. A PID alone
# never authorizes terminating a process; it must still belong to this shell.
acceptance_owns_running_job() {
  local acceptance_candidate
  for acceptance_candidate in $(jobs -pr); do
    if [[ "$acceptance_candidate" == "$1" ]]; then return 0; fi
  done
  return 1
}

acceptance_stop_owned_job() {
  local acceptance_pid="$1" acceptance_attempt
  [[ "$acceptance_pid" =~ ^[0-9]+$ ]] || return 2
  if ! acceptance_owns_running_job "$acceptance_pid"; then return 0; fi
  kill -TERM "$acceptance_pid" 2>/dev/null || true
  for ((acceptance_attempt=0; acceptance_attempt<20; acceptance_attempt++)); do
    if ! acceptance_owns_running_job "$acceptance_pid"; then
      wait "$acceptance_pid" 2>/dev/null || true
      return 0
    fi
    sleep 0.1
  done
  if acceptance_owns_running_job "$acceptance_pid"; then
    kill -KILL "$acceptance_pid" 2>/dev/null || true
  fi
  for ((acceptance_attempt=0; acceptance_attempt<10; acceptance_attempt++)); do
    if ! acceptance_owns_running_job "$acceptance_pid"; then
      wait "$acceptance_pid" 2>/dev/null || true
      return 0
    fi
    sleep 0.1
  done
  echo "The owned acceptance job did not stop within the cleanup deadline." >&2
  return 1
}
