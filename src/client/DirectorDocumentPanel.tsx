import { useEffect, useState } from 'react';
import type { Story } from '../agent/story.ts';
import type { VideoProject } from '../shared/types.ts';
import type { StudioController } from './controller.ts';

interface DirectorView { schemaVersion: 1; status: 'draft' | 'approved'; hash: string; version: number; plan: { story: Story } }

/** Human editor for the in-project director document. Approval stays on this panel. */
export function DirectorDocumentPanel({ controller, project }: { controller: StudioController; project: VideoProject }) {
  const [title, setTitle] = useState(project.title);
  const [logline, setLogline] = useState('');
  const [shots, setShots] = useState('');
  const [document, setDocument] = useState<DirectorView | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  async function load() {
    const value = await controller.api.call<{ document: DirectorView | null }>('director.document.get', { projectId: project.id });
    setDocument(value.document);
    if (value.document) {
      const story = value.document.plan.story;
      setTitle(story.title || project.title);
      setLogline(story.logline || '');
      setShots(story.shots.map(shot => shot.summary).join('\n'));
    }
  }
  useEffect(() => { void load().catch(cause => setError(cause instanceof Error ? cause.message : '导演文档读取失败')); }, [project.id, project.revision]);
  function story(): Story {
    return { version: 0, projectId: project.id, status: 'empty', title: title.trim(), logline: logline.trim(), targetSeconds: project.targetDuration, style: { look: '', palette: '', typography: '', motion: '', negative: '' }, characters: [], shots: shots.split('\n').map(line => line.trim()).filter(Boolean).map((summary, index) => ({ id: 's' + (index + 1), summary, shotType: 'wide', camera: 'fixed', durationSeconds: 2, dialogue: '', characters: [], continueFromPrevious: false })), updatedAt: new Date(0).toISOString(), consistency: {} } satisfies Story;
  }
  async function save() {
    setError(''); setNotice('');
    await controller.action('director.document.save', { story: story(), ...(document ? { baseHash: document.hash } : {}) }, '导演文档已保存为草稿。批准前智能体不能代签。');
    if (controller.getSnapshot().error) { setError(controller.getSnapshot().error); return; }
    setNotice('已保存为草稿。内容变了就要重新批准。');
    await load();
  }
  async function approve() {
    if (!document) return;
    setError(''); setNotice('');
    await controller.action('director.document.approve', { hash: document.hash }, '导演文档已批准。制作策略没有改变。');
    if (controller.getSnapshot().error) { setError(controller.getSnapshot().error); return; }
    setNotice('已批准。哈希和制作策略保持不变。');
    await load();
  }
  return <section className="vs-story-panel" aria-label="导演文档">
    <h4>导演文档 {document ? `· ${document.status === 'approved' ? '已批准' : '草稿'} · v${document.version}` : '· 尚未保存'}</h4>
    <p className="vs-muted">这是工程里的计划真源。保存和批准都由你在这里完成，智能体不能代签，也不能因此改制作策略。</p>
    <label className="vs-field"><span>标题</span><input aria-label="导演文档标题" value={title} onChange={event => setTitle(event.target.value)} /></label>
    <label className="vs-field"><span>一句话</span><textarea aria-label="导演文档一句话" rows={2} value={logline} onChange={event => setLogline(event.target.value)} /></label>
    <label className="vs-field"><span>分镜（一行一个镜头）</span><textarea aria-label="导演文档分镜" rows={4} value={shots} onChange={event => setShots(event.target.value)} placeholder={'海边走路\n回头看灯塔'} /></label>
    {document && <p className="vs-muted">内容哈希 {document.hash.slice(0, 16)}…</p>}
    {error && <p className="vs-inline-error" role="alert">{error}</p>}
    {notice && <p className="vs-media-success" role="status">{notice}</p>}
    <div className="vs-media-actions">
      <button type="button" onClick={() => void save().catch(cause => setError(cause instanceof Error ? cause.message : '保存失败'))}>保存导演文档</button>
      <button type="button" className="vs-primary" disabled={!document} onClick={() => void approve().catch(cause => setError(cause instanceof Error ? cause.message : '批准失败'))}>批准导演文档</button>
    </div>
  </section>;
}
