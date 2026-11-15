import { useState } from 'react';
import type { VideoProject } from '../shared/types.ts';
import type { StudioController } from './controller.ts';

type Mode = 'code_animation' | 'model_video' | 'hybrid';

/** Human confirmation for production.set. The agent route still rejects this endpoint. */
export function ProductionPolicyPanel({ controller, project }: { controller: StudioController; project: VideoProject }) {
  const current = project.productionPolicy;
  const [mode, setMode] = useState<Mode>(current?.mode === 'model_video' || current?.mode === 'hybrid' || current?.mode === 'code_animation' ? current.mode : 'code_animation');
  const [images, setImages] = useState(current?.allowGeneratedImages === true);
  const [imported, setImported] = useState(current?.allowImportedVideo === true);
  const [baseMode, setBaseMode] = useState<'code_animation' | 'model_video'>(current?.baseMode === 'model_video' ? 'model_video' : 'code_animation');
  const [error, setError] = useState('');
  async function confirm() {
    setError('');
    await controller.action('production.set', { mode, allowGeneratedImages: images, allowImportedVideo: imported, ...(mode === 'hybrid' ? { baseMode } : {}) }, '制作策略已由你确认。智能体不能代替这一步。');
    if (controller.getSnapshot().error) setError(controller.getSnapshot().error);
  }
  return <section className="vs-subtle-box" aria-label="制作策略">
    <strong>制作策略</strong>
    <p>未确认时不能生成图片、视频，也不能导出。这一步只能由你确认。</p>
    <p className="vs-muted">当前：{current?.mode === 'unresolved' || !current ? '未确认' : current.mode}{current ? ` · ${current.decisionId}` : ''}</p>
    <label className="vs-field"><span>模式</span>
      <select aria-label="制作策略模式" value={mode} onChange={event => setMode(event.target.value as Mode)}>
        <option value="code_animation">代码动画</option>
        <option value="model_video">模型视频</option>
        <option value="hybrid">混合</option>
      </select>
    </label>
    {mode === 'hybrid' && <label className="vs-field"><span>混合基准</span>
      <select aria-label="混合基准" value={baseMode} onChange={event => setBaseMode(event.target.value as 'code_animation' | 'model_video')}>
        <option value="code_animation">以代码动画为基准</option>
        <option value="model_video">以模型视频为基准</option>
      </select>
    </label>}
    <label className="vs-media-check"><input aria-label="允许生成图片" type="checkbox" checked={images} onChange={event => setImages(event.target.checked)} />允许生成图片</label>
    <label className="vs-media-check"><input aria-label="允许导入视频" type="checkbox" checked={imported} onChange={event => setImported(event.target.checked)} />允许导入视频</label>
    {error && <p className="vs-inline-error" role="alert">{error}</p>}
    <button type="button" className="vs-primary" onClick={() => void confirm()}>确认制作策略</button>
  </section>;
}
