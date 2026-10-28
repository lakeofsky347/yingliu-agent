import { spawnSync } from 'node:child_process';
import { basename, isAbsolute } from 'node:path';

export const EDITOR_READY_EXPRESSION = "document.readyState==='complete'&&!!document.querySelector('#root')&&document.querySelector('#root').childElementCount>0";
export const READY_CRITERIA = {
  electron: { id: 'editor-react-mounted', specification: EDITOR_READY_EXPRESSION, crossShellComparable: false },
  tauri: { id: 'webview-page-load-finished', specification: '仅WebView页面加载事件；尚未验证React挂载，不用于Electron比较', crossShellComparable: false },
  sidecar: { id: 'backend-ready-handshake', specification: 'sidecar协议1 ready回执；不含任何编辑器页面', crossShellComparable: false },
};
export function clearCacheEvidence({ requested, command, args = [] }, execute = spawnSync) {
  if (!requested) return { requested: false, succeeded: false, state: 'uncontrolled', coldEligible: false };
  if (!command || !isAbsolute(command) || /^sudo(?:\.exe)?$/i.test(basename(command))) return { requested: true, succeeded: false, state: 'invalid', coldEligible: false, error: '清缓存请求必须显式提供绝对路径--cache-clear-command；脚本不会调用sudo或默认清理宿主缓存' };
  const result = execute(command, args, { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] });
  const succeeded = !result.error && result.status === 0;
  return { requested: true, succeeded, state: succeeded ? 'operator-command-succeeded' : 'invalid', coldEligible: succeeded, exitCode: result.status ?? null, ...(succeeded ? {} : { error: '清缓存命令失败，该样本未启动且不得计入cold统计' }) };
}
const quantile = (values, percentile) => { if (!values.length) return null; const sorted = [...values].sort((a, b) => a - b); return sorted[Math.max(0, Math.ceil(sorted.length * percentile) - 1)]; };
export function summarizeSamples(mode, samples, idleMs) {
  const valid = samples.filter(sample => sample.valid === true && Number.isFinite(sample.readyMs) && sample.readyMs >= 0 && sample.s0 && Number.isFinite(sample.s0.pssBytes) && sample.s0.pssBytes > 0 && (!sample.cache.requested || sample.cache.succeeded));
  const cold = valid.filter(sample => sample.cache.coldEligible);
  return {
    mode, readyCriterion: READY_CRITERIA[mode], idleMs, idleClock: '本模式记录的readyCriterion完成后开始计时', crossShellComparable: false,
    samples: samples.length, eligibleSamples: valid.length, invalidSamples: samples.length - valid.length,
    observedReadyMedianMs: quantile(valid.map(sample => sample.readyMs), 0.5), observedReadyP95Ms: quantile(valid.map(sample => sample.readyMs), 0.95),
    s0PssMedianMiB: valid.length ? quantile(valid.map(sample => sample.s0.pssBytes), 0.5) / 2 ** 20 : null,
    s0PssP95MiB: valid.length ? quantile(valid.map(sample => sample.s0.pssBytes), 0.95) / 2 ** 20 : null,
    coldSamples: cold.length, coldObservedReadyMedianMs: quantile(cold.map(sample => sample.readyMs), 0.5), coldObservedReadyP95Ms: quantile(cold.map(sample => sample.readyMs), 0.95),
    comparisonNote: '三种模式的ready判据不同；仅同模式、同判据、同缓存策略的有效样本可以比较。',
  };
}
