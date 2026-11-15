import { useState } from 'react';
import type { StudioController } from './controller.ts';

interface QualityReport {
  decision: 'pass' | 'fail' | 'needs-review';
  checks: { severity: 'hard' | 'advisory'; status: 'pass' | 'fail' | 'unchecked'; message: string }[];
}

/** Runs the export gate without starting the renderer, so a hard failure is visible first. */
export function QualityPanel({ controller }: { controller: StudioController }) {
  const [report, setReport] = useState<QualityReport | null>(null);
  const [error, setError] = useState('');
  async function run() {
    setError('');
    try {
      const projectId = controller.getSnapshot().snapshot?.project?.id;
      setReport(await controller.api.call<QualityReport>('quality.check', { projectId }));
    } catch (cause) { setError(cause instanceof Error ? cause.message : '质检失败'); }
  }
  return <section className="yl-quality-report" aria-label="导出前质检">
    <div className="yl-panel-heading"><div><h3>导出前质检</h3><p>先看硬失败。缺素材或没有镜头时不能导出，强制导出也不能绕过。</p></div><button type="button" onClick={() => void run()}>运行质检</button></div>
    {error && <p className="yl-error" role="alert">{error}</p>}
    {report && <>
      <p role="status">结论：{report.decision === 'fail' ? '不能导出' : report.decision === 'needs-review' ? '有镜头未抽样' : '可以通过'}</p>
      <ul>{report.checks.map((check, index) => <li key={index} className={check.status === 'fail' ? 'is-fail' : 'is-pass'}>{check.status === 'fail' ? '失败' : '通过'} · {check.message}</li>)}</ul>
    </>}
  </section>;
}
