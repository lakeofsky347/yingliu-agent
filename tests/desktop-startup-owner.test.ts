import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { acquireDesktopOwner, busyDialogOptions, BUSY_WAIT_MS, type BusyChoice } from '../src/desktop/startup-owner.ts';
import { BusyError } from '../src/cli/lock.ts';

const busy = () => new BusyError({ pid: 4321, host: 'h', startedAt: '2026-10-28T00:00:00.000Z', command: 'agent run' }, '/data/profile');
const lease = { claim: async () => {}, release: async () => {} };
function script(outcomes: ('busy' | 'ok' | Error)[], choices: BusyChoice[]) {
  const calls: number[] = [], asked: BusyError[] = [];
  return {
    calls, asked,
    acquire: async (timeoutMs: number) => { calls.push(timeoutMs); const next = outcomes.shift(); if (next === 'ok') return lease; if (next instanceof Error) throw next; throw busy(); },
    ask: async (error: BusyError) => { asked.push(error); const choice = choices.shift(); assert.ok(choice, 'unexpected extra dialog'); return choice; },
  };
}

test('desktop startup: a free profile starts without any dialog', async () => {
  const s = script(['ok'], []);
  assert.equal(await acquireDesktopOwner(s.acquire, s.ask), lease);
  assert.deepEqual(s.calls, [0]); assert.equal(s.asked.length, 0);
});

test('desktop startup: BUSY asks instead of exiting silently; retry tries again immediately', async () => {
  const s = script(['busy', 'busy', 'ok'], ['retry', 'retry']);
  assert.equal(await acquireDesktopOwner(s.acquire, s.ask), lease);
  assert.deepEqual(s.calls, [0, 0, 0]); assert.equal(s.asked.length, 2); assert.equal(s.asked[0]!.owner?.pid, 4321);
});

test('desktop startup: wait blocks up to the bounded wait, then asks again if still BUSY', async () => {
  const s = script(['busy', 'busy', 'ok'], ['wait', 'wait']);
  assert.equal(await acquireDesktopOwner(s.acquire, s.ask), lease);
  assert.deepEqual(s.calls, [0, BUSY_WAIT_MS, BUSY_WAIT_MS]);
});

test('desktop startup: quit returns no owner; non-BUSY errors are not turned into a dialog', async () => {
  const s = script(['busy'], ['quit']);
  assert.equal(await acquireDesktopOwner(s.acquire, s.ask), undefined);
  const config = Object.assign(new Error('YINGLIU_LOCK_PORT 必须是 1024-65535 之间的整数'), { code: 'CONFIG' });
  const t = script([config], []);
  await assert.rejects(acquireDesktopOwner(t.acquire, t.ask), /YINGLIU_LOCK_PORT/); assert.equal(t.asked.length, 0);
});

test('desktop startup: the dialog names the holder and offers retry / wait / quit with quit as cancel', () => {
  const options = busyDialogOptions(busy());
  assert.deepEqual(options.buttons.length, 3); assert.match(options.buttons[0]!, /重试/); assert.match(options.buttons[1]!, /等待/); assert.match(options.buttons[2]!, /退出/);
  assert.equal(options.cancelId, 2); assert.match(options.detail, /4321/); assert.match(options.detail, /agent run/); assert.match(options.detail, /\/data\/profile/);
  const unknown = busyDialogOptions(new BusyError(undefined, '/p'));
  assert.match(unknown.detail, /未知/);
});

test('desktop main wires BUSY startup to the native dialog instead of quitting silently', () => {
  const main = readFileSync(join(import.meta.dirname, '../src/desktop/main.ts'), 'utf8');
  assert.match(main, /acquireDesktopOwner\(/); assert.match(main, /dialog\.showMessageBox\(\{\.\.\.busyDialogOptions\(/);
  assert.doesNotMatch(main, /acquireApplicationOwner\(directories,'desktop',0,/);
});
