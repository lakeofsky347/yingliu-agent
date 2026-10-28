import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('../scripts/ci-owned-job.sh', import.meta.url));
const bashTest = { skip: process.platform === 'win32' ? 'Linux CI shell helper; native Windows uses PowerShell' : false };
function run(script: string, ...args: string[]) {
  return execFileSync('/bin/bash', ['-c', `set -euo pipefail\nsource "$1"\n${script}`, 'acceptance-owned-test', helper, process.execPath, ...args], { encoding: 'utf8', timeout: 6500 });
}

test('single background job with process substitution has the owned PID and stops', bashTest, () => {
  const result = run(`"$2" -e 'process.stdin.resume(); setInterval(() => {}, 1000)' < <(printf fixture) &
owned_pid=$!
acceptance_owns_running_job "$owned_pid"
acceptance_stop_owned_job "$owned_pid"
if kill -0 "$owned_pid" 2>/dev/null; then exit 31; fi
printf stopped`);
  assert.equal(result, 'stopped');
});

test('owned job ignoring TERM is killed within the cleanup deadline', bashTest, () => {
  const started = Date.now();
  const result = run(`"$2" -e 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)' &
owned_pid=$!
sleep 0.3
acceptance_stop_owned_job "$owned_pid"
if kill -0 "$owned_pid" 2>/dev/null; then exit 32; fi
printf stopped`);
  assert.equal(result, 'stopped');
  assert.ok(Date.now() - started < 6000);
});

test('PID from another process owner never authorizes a signal', bashTest, () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    assert.ok(child.pid);
    assert.equal(run('acceptance_stop_owned_job "$3"\nprintf untouched', String(child.pid)), 'untouched');
    assert.doesNotThrow(() => process.kill(child.pid!, 0));
  } finally { child.kill('SIGKILL'); }
});

test('exited owned job and invalid PID do not wait or signal', bashTest, () => {
  assert.equal(run('true &\nowned_pid=$!\nwait "$owned_pid"\nacceptance_stop_owned_job "$owned_pid"\nif acceptance_stop_owned_job invalid; then exit 33; fi\nprintf done'), 'done');
});
