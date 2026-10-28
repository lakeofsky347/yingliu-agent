import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export function withTimeout(promise, timeoutMs, label) {
  let timer; return Promise.race([promise, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(label + '超时')), timeoutMs); })]).finally(() => clearTimeout(timer));
}
/** PID alone is never evidence that a process still belongs to this drill. */
export async function processTable() {
  const result = spawnSync('ps', ['-eo', 'pid=,ppid=,lstart=,comm='], { encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error('无法检查自有进程树');
  const rows = result.stdout.trim().split('\n').filter(Boolean).map(line => {
    const [pid, ppid, ...rest] = line.trim().split(/\s+/);
    return { pid: Number(pid), ppid: Number(ppid), started: rest.slice(0, 5).join(' '), comm: rest.slice(5).join(' ') };
  });
  return Promise.all(rows.map(async row => {
    if (process.platform === 'linux') {
      try { const stat = await readFile(`/proc/${row.pid}/stat`, 'utf8'); row.started = 'linux-ticks:' + stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/)[19]; }
      catch { row.started = ''; }
    }
    return row;
  }));
}
export async function ownedTree(pid) {
  const rows = await processTable(), found = [], visited = new Set();
  function walk(parent) { if (visited.has(parent)) return; visited.add(parent); for (const row of rows.filter(row => row.ppid === parent)) { found.push(row); walk(row.pid); } }
  const root = rows.find(row => row.pid === pid); if (!root?.started) throw new Error('自有宿主进程已退出或身份无法确认');
  found.push(root); walk(pid); return found;
}
export async function stillOwned(processes) {
  const current = await processTable();
  return processes.filter(expected => expected.started && current.some(row => row.pid === expected.pid && row.started === expected.started));
}
/** Only processes captured under a child we started, with unchanged birth identity, are termination candidates. */
export async function killOwned(processes) {
  const unique = [...new Map(processes.map(row => [row.pid + ':' + row.started, row])).values()];
  for (const expected of unique) for (const processInfo of await stillOwned([expected])) try { process.kill(processInfo.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
}
export async function waitUntil(check, timeoutMs, label, pollMs = 50) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await sleep(pollMs); }
  throw new Error(label + '超时');
}
