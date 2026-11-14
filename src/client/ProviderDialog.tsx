import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { ProviderConfig, ProviderSettings } from '../app/contracts.ts';
import { OPENAI_BASE_URL, OPENAI_CHAT_MODEL, TEXT_CONNECTION_ID, VISION_CONNECTION_ID } from '../models/provider-defaults.ts';
import type { StudioApi } from '../shared/types.ts';
import { ModelCenter } from './ModelCenter.tsx';
import { AppIcon, errorMessage } from './ui.tsx';

type QuickSection = 'text' | 'multimodal';
type Section = QuickSection | 'advanced';

const sectionLabels: Record<Section, { title: string; usage: string }> = {
  text: { title: '文本模型', usage: '创作对话、分镜与场景代码' },
  multimodal: { title: '多模态模型', usage: '参考图理解与关键帧检查' },
  advanced: { title: '高级模型中心', usage: '角色绑定、图片、视频和音频生成' },
};

const connectionIds = { text: TEXT_CONNECTION_ID, multimodal: VISION_CONNECTION_ID };

function initialConfig(section: QuickSection, settings: ProviderSettings | null): ProviderConfig {
  const vision = section === 'multimodal';
  const saved = vision ? settings?.visionConfig : settings?.legacyConfig ?? (settings?.config.id === TEXT_CONNECTION_ID ? settings.config : undefined);
  return {
    id: connectionIds[section], name: 'OpenAI', baseUrl: OPENAI_BASE_URL, model: OPENAI_CHAT_MODEL,
    temperature: .7, maxTokens: 7000, requestTimeoutMs: 90000, contextMessageLimit: 24, contextCharLimit: 90000,
    ...saved, supportsVision: vision, enableVision: vision,
  };
}

function endpointOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash) return url.origin;
  } catch { /* Incomplete URLs are editable while typing. */ }
}

function presetFor(baseUrl: string) {
  const origin = endpointOrigin(baseUrl);
  if (origin === new URL(OPENAI_BASE_URL).origin) return 'openai';
  if (origin === 'https://api.deepseek.com') return 'deepseek';
  return 'compatible';
}

interface Props {
  api: StudioApi;
  initial: ProviderSettings | null;
  initialSection?: QuickSection;
  onClose: () => void;
  onSave: (settings: ProviderSettings) => Promise<void>;
  blocked: boolean;
}

export function ProviderDialog({ api, initial, initialSection = 'text', onClose, onSave, blocked }: Props) {
  const [section, setSection] = useState<Section>(initialSection);
  const [drafts, setDrafts] = useState<Partial<Record<QuickSection, ProviderConfig>>>({});
  const [keys, setKeys] = useState<Partial<Record<QuickSection, string>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const dialog = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previous = document.activeElement;
    closeButton.current?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);

  const slot = section === 'advanced' ? null : section;
  const vision = slot === 'multimodal';
  const saved = slot ? initialConfig(slot, initial) : null;
  const config = slot && saved ? drafts[slot] ?? saved : null;
  const apiKey = slot ? keys[slot] ?? '' : '';
  const credential = vision ? initial?.visionCredentialStatus : initial?.legacyCredentialStatus ??
    (initial?.config.id === TEXT_CONNECTION_ID ? initial.credentialStatus : undefined);
  const hasKey = vision ? initial?.visionHasKey : initial?.legacyHasKey ??
    (initial?.config.id === TEXT_CONNECTION_ID ? initial.hasKey : false);
  const hasStoredKey = !!(hasKey || credential?.hasStoredKey);
  const storageUnavailable = credential?.available === false;
  const origin = config ? endpointOrigin(config.baseUrl) : undefined;
  const changedOrigin = !!(hasStoredKey && origin && saved && origin !== endpointOrigin(saved.baseUrl));
  const valid = !!(config?.name.trim() && config?.model.trim() && origin);
  const disabled = busy || blocked;
  const activeRoute = vision ? initial?.visionRoute : initial?.route;
  const activeReady = vision ? initial?.visionReady : initial?.ready ?? initial?.hasKey;
  const activeOverride = !!(slot && activeRoute && (activeRoute.provider !== connectionIds[slot] || activeRoute.model !== saved?.model));

  function edit(patch: Partial<ProviderConfig>) {
    if (!slot || !config) return;
    if (patch.baseUrl !== undefined && endpointOrigin(patch.baseUrl) !== endpointOrigin(config.baseUrl)) {
      setKeys(value => ({ ...value, [slot]: '' }));
    }
    setDrafts(value => ({ ...value, [slot]: { ...config, ...patch } }));
    setError('');
    setStatus('');
  }

  function switchSection(next: Section) {
    setSection(next);
    setError('');
    setStatus('');
    if (dialog.current) dialog.current.scrollTop = 0;
  }

  function changePreset(preset: string) {
    if (!slot) return;
    if (preset === 'openai') edit({ name: 'OpenAI', baseUrl: OPENAI_BASE_URL, model: OPENAI_CHAT_MODEL });
    if (preset === 'deepseek') edit({ name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' });
    if (preset === 'compatible') edit({ name: '自定义接口', baseUrl: '', model: '' });
  }

  async function save(action: 'save' | 'check' | 'remove') {
    if (!slot || !config || disabled) return;
    setBusy(true);
    setError('');
    setStatus('');
    const enteredKey = apiKey.trim();
    try {
      if (action !== 'remove' && !valid) throw new Error('请填写接口名称、有效的 HTTP(S) 接口地址和模型 ID。');
      if (action !== 'remove' && changedOrigin && !enteredKey) throw new Error('接口站点已变更。请填写新密钥，或先删除已保存的密钥。');
      const payload = action === 'remove' ? { apiKey: '' } : {
        ...config, ...(vision ? {} : { mode: 'custom' }), ...(enteredKey ? { apiKey: enteredKey } : {}),
      };
      const value = await api.call<ProviderSettings>(vision ? 'providers.vision.save' : 'providers.save', payload);
      setKeys(previous => ({ ...previous, [slot]: '' }));
      if (action !== 'remove') setDrafts(previous => ({ ...previous, [slot]: undefined }));
      await onSave(value);
      if (action === 'check') {
        const checked = await api.call<{ ok: boolean; message: string }>('providers.check', { connectionId: connectionIds[slot] });
        if (!checked.ok) throw new Error(`设置已保存，${checked.message}`);
        setStatus(checked.message);
      } else {
        setStatus(action === 'remove' ? '已删除此接口的密钥。' : `${sectionLabels[slot].title}设置已保存。`);
      }
    } catch (cause) {
      const message = errorMessage(cause);
      setError(enteredKey ? message.split(enteredKey).join('[redacted]') : message);
    } finally { setBusy(false); }
  }

  function handleKeys(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (!busy) onClose();
    }
    if (event.key !== 'Tab') return;
    const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, a[href]')).filter(element => element.getClientRects().length);
    const first = focusable[0], last = focusable.at(-1);
    if (event.shiftKey && event.target === first && last) { event.preventDefault(); last.focus(); }
    if (!event.shiftKey && event.target === last && first) { event.preventDefault(); first.focus(); }
  }

  return <div className="yl-modal-backdrop yl-settings-backdrop" onMouseDown={event => { if (event.currentTarget === event.target && !busy) onClose(); }}>
    <section ref={dialog} className={`yl-modal yl-provider-modal${slot ? ' yl-provider-quick' : ''}`} role="dialog" aria-modal="true" aria-labelledby="yl-provider-title" onKeyDown={handleKeys}>
      <div className="yl-modal-heading">
        <h2 id="yl-provider-title">模型与 API 接入</h2>
        <button ref={closeButton} className="yl-button yl-icon-button" aria-label="关闭模型设置" disabled={busy} onClick={onClose}><AppIcon name="close"/></button>
      </div>
      <nav className="yl-provider-tabs" aria-label="模型设置类型">
        {(Object.keys(sectionLabels) as Section[]).map(key => <button key={key} className={section === key ? 'is-active' : ''} aria-pressed={section === key} aria-label={sectionLabels[key].title} disabled={busy} onClick={() => switchSection(key)}>
          <strong>{sectionLabels[key].title}</strong><small>{sectionLabels[key].usage}</small>
        </button>)}
      </nav>
      {slot && config ? <form className="yl-provider-fields" aria-label={`${sectionLabels[slot].title}设置`} onSubmit={event => { event.preventDefault(); void save('save'); }}>
        <p className="yl-provider-route">{vision ? '视觉理解' : '创作对话'}{activeReady ? `已配置 · ${activeRoute?.model ?? config.model}` : '尚未配置'}{activeOverride ? ' · 角色由高级模型中心管理' : ''}</p>
        {!vision && initial?.sceneRoute && <p className="yl-provider-help">场景代码 · {initial.sceneRoute.model}{initial.sceneReady === false ? '（待配置）' : ''}</p>}
        {vision && <p className="yl-provider-help">选择支持图片输入的模型。对话中的参考图在你选择图片并授权本次请求后才会发送。</p>}
        <div className="yl-field-pair">
          <label className="yl-field"><span>服务商</span><select aria-label="服务商" value={presetFor(config.baseUrl)} onChange={event => changePreset(event.target.value)} disabled={disabled}>
            <option value="openai">OpenAI</option>{!vision && <option value="deepseek">DeepSeek</option>}<option value="compatible">自定义 OpenAI 兼容接口</option>
            {vision && presetFor(config.baseUrl) === 'deepseek' && <option value="deepseek">DeepSeek 兼容接口（已保存）</option>}
          </select></label>
          <label className="yl-field"><span>模型 ID</span><input aria-label="模型 ID" value={config.model} onChange={event => edit({ model: event.target.value })} placeholder={OPENAI_CHAT_MODEL} disabled={disabled}/></label>
        </div>
        <label className="yl-field"><span>API Key <small>{hasKey ? '已保存' : hasStoredKey ? '已保存，当前无法读取' : '尚未填写'}</small></span>
          <input aria-label="API Key" type="password" autoComplete="new-password" value={apiKey} onChange={event => setKeys(value => ({ ...value, [slot]: event.target.value }))} placeholder={changedOrigin ? '输入新站点的 API Key' : hasStoredKey ? '留空保留已保存的密钥' : '填写服务商提供的 API Key'} disabled={disabled || storageUnavailable}/>
        </label>
        <div className="yl-field-pair">
          <label className="yl-field"><span>接口名称</span><input aria-label="接口名称" value={config.name} onChange={event => edit({ name: event.target.value })} placeholder="OpenAI" disabled={disabled}/></label>
          <label className="yl-field"><span>API Base URL</span><input type="url" aria-label="API Base URL" value={config.baseUrl} onChange={event => edit({ baseUrl: event.target.value })} placeholder={OPENAI_BASE_URL} disabled={disabled}/></label>
        </div>
        {changedOrigin && <p className="yl-provider-help">接口站点已变更。请填写新密钥，或先删除已保存的密钥。</p>}
        {hasStoredKey && <button type="button" className="yl-button yl-danger" disabled={disabled} onClick={() => void save('remove')}>删除已保存密钥</button>}
        <details className="yl-model-advanced"><summary>生成参数与上下文</summary>
          <div className="yl-field-pair">
            <label className="yl-field"><span>温度</span><input aria-label="模型温度" type="number" step="0.1" min="0" max="2" value={config.temperature} onChange={event => edit({ temperature: Number(event.target.value) })} disabled={disabled}/></label>
            <label className="yl-field"><span>最大输出 token</span><input aria-label="最大输出 token" type="number" min="256" max="32768" value={config.maxTokens} onChange={event => edit({ maxTokens: Number(event.target.value) })} disabled={disabled}/></label>
          </div>
          <div className="yl-field-pair">
            <label className="yl-field"><span>请求超时（秒）</span><input aria-label="请求超时（秒）" type="number" min="5" max="300" value={(config.requestTimeoutMs ?? 90000) / 1000} onChange={event => edit({ requestTimeoutMs: Number(event.target.value) * 1000 })} disabled={disabled}/></label>
            <label className="yl-field"><span>上下文消息条数</span><input aria-label="上下文消息条数" type="number" min="4" max="100" value={config.contextMessageLimit} onChange={event => edit({ contextMessageLimit: Number(event.target.value) })} disabled={disabled}/></label>
          </div>
          <label className="yl-field"><span>上下文字符预算</span><input aria-label="上下文字符预算" type="number" min="8000" max="300000" value={config.contextCharLimit} onChange={event => edit({ contextCharLimit: Number(event.target.value) })} disabled={disabled}/></label>
        </details>
        {credential?.error && <p className="yl-error" role="alert">{credential.error}</p>}
        {error && <p className="yl-error" role="alert">{error}</p>}
        {status && <p className="yl-dialog-success" role="status"><AppIcon name="check"/>{status}</p>}
        <p className="yl-credential-note">两个接口的密钥分别保存。保存并检查会请求该服务的模型目录。</p>
        <div className="yl-modal-actions">
          <button type="button" className="yl-button" disabled={disabled || !valid || storageUnavailable || !(apiKey.trim() || (hasKey && !changedOrigin))} onClick={() => void save('check')}>{busy ? '正在处理' : '保存并检查连接'}</button>
          <button className="yl-button yl-primary" type="submit" disabled={disabled || !valid || (changedOrigin && !apiKey.trim())}>{busy ? '正在保存' : '保存设置'}</button>
        </div>
      </form> : <ModelCenter api={api} blocked={disabled}/>}
    </section>
  </div>;
}
