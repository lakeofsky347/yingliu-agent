import { useEffect, useState } from 'react';
import type { VideoStyle } from '../shared/types.ts';
import type { CreateBrief, PackCatalog, ProjectSummary } from './project-ui.ts';
import { OUTPUT_PROFILES, briefPayload } from './project-ui.ts';
import { Icon } from './icons.tsx';
import { AppIcon, errorMessage, localTime } from './ui.tsx';

export interface AppHealth {
  dataDirectory:string;
  model:{configured:boolean;model:string};
  tools:Record<string,{path:string;available:boolean;optional?:boolean;version?:string;message?:string}>;
  canRender:boolean;
  canPreviz?:boolean;
}

export function ProjectHome({projects,loading,configured,health,styleCount=0,onCreate,onOpen,onImport,onImportPackage,onConfigure,onManage,onHealth,onStyles}:{
  projects:ProjectSummary[];loading:boolean;configured:boolean;health:AppHealth|null;styleCount?:number;
  onCreate:()=>void;onOpen:(project:ProjectSummary)=>void;onImport:()=>void;onImportPackage:()=>void;
  onConfigure:()=>void;onManage:(project:ProjectSummary,action:'rename'|'duplicate'|'archive'|'restore'|'backup')=>void;
  onHealth:()=>void;onStyles?:()=>void;
}){
  const [query,setQuery]=useState(''),[archived,setArchived]=useState(false);
  const visible=projects.filter(project=>!!project.archived===archived&&`${project.title} ${project.path}`.toLowerCase().includes(query.toLowerCase()));
  const blenderReady=Boolean(health?.canPreviz??health?.tools?.blender?.available);

  return <main className="vs-project-home vs-home" data-video-home="true" aria-label="影片首页">
    <section className="vs-home-hero">
      <div>
        <h1>把想法，做成一部影片。</h1>
        <p>与智能体沟通确认分镜，用 Blender 搭建白模场景与运镜预演，审阅通过后交给创作模型实际呈现；也可以直接在工作台编排镜头、精修源码与音轨。素材、计划和历史都留在本地工程中。</p>
      </div>
      <div className="vs-library-actions">
        <button className="vs-primary" onClick={onCreate}><Icon name="plus"/><span>新建影片</span></button>
        {onStyles&&<button onClick={onStyles}><Icon name="spark"/><span>视频制作风格{styleCount?` · ${styleCount}`:''}</span></button>}
        <button onClick={onImport}><Icon name="folder"/><span>打开工程目录</span></button>
        <button onClick={onImportPackage}><Icon name="download"/><span>导入工程包</span></button>
      </div>
    </section>

    <div className="vs-home-readiness">
      <button onClick={onConfigure}>
        <i className={configured?'':'is-missing'}/>
        <div>
          <strong>{configured?'创作与多模态模型已连接':'连接你的创作模型'}</strong>
          <small>{configured?(health?.model.model||'已配置导演模型 · 可在高级模型中心绑定生图/生视频/音频模型'):'配置导演文本、视觉、视频与音频模型；也可以先手动编排分镜。'}</small>
        </div>
        <span>模型设置 ↗</span>
      </button>
      <button onClick={onHealth}>
        <i className={health?.canRender?'':'is-missing'}/>
        <div>
          <strong>{health?.canRender?'本地渲染环境已就绪':'检查本地渲染与预演环境'}</strong>
          <small>Chromium · FFmpeg · ffprobe{blenderReady?' · Blender 白模预演已就绪':' · Blender（可选预演未配置）'}</small>
        </div>
        <span>环境检查 ↗</span>
      </button>
    </div>

    <section className="vs-home-library" aria-label="影片工程列表">
      <div className="vs-library-heading">
        <div className="vs-library-title">
          <h2>我的影片 <small>{projects.filter(project=>!project.archived).length}</small></h2>
          <p>打开工程后继续上次的创作，智能体计划、白模预演与撤销历史会一起恢复。</p>
        </div>
        <div className="vs-library-tools">
          <div className="vs-library-tabs vs-segmented">
            <button aria-pressed={!archived} className={!archived?'is-active':''} onClick={()=>setArchived(false)}>正在创作</button>
            <button aria-pressed={archived} className={archived?'is-active':''} onClick={()=>setArchived(true)}>已归档 {projects.filter(project=>project.archived).length||''}</button>
          </div>
          <input type="search" aria-label="搜索影片工程" value={query} onChange={event=>setQuery(event.target.value)} placeholder="搜索影片名称或目录…"/>
        </div>
      </div>

      {loading?<div className="vs-library-empty"><p role="status"><span className="vs-spinner"/> 正在读取工程列表…</p></div>
        :!visible.length?<div className="vs-library-empty">
          <div className="vs-library-empty-icon"><Icon name={query?'search':archived?'folder':'film'}/></div>
          <h3>{query?'没有找到匹配工程':archived?'暂无归档工程':'你的第一部影片，从这里开始'}</h3>
          <p>{archived?'归档保留工程文件，可以随时恢复。':'新建影片填写简报，或打开已有项目继续编辑。'}</p>
          {!archived&&!query&&<button className="vs-primary" onClick={onCreate}><Icon name="plus"/><span>新建影片</span></button>}
        </div>
        :<div className="vs-project-grid">{visible.map((project,index)=><article className={`vs-project-card ${project.archived?'is-archived':''}`} key={project.id} data-project-id={project.id} style={{animationDelay:`${Math.min(index,8)*40}ms`}}>
          <button className="vs-project-cover" disabled={project.archived} onClick={()=>onOpen(project)} aria-label={`打开影片 ${project.title}`}>
            <span className="vs-project-cover-number">{String(index+1).padStart(2,'0')}</span>
            <span className="vs-project-cover-play"><Icon name={project.archived?'folder':'play'}/></span>
            <small>{project.archived?'已归档':'打开工作台'}</small>
          </button>
          <div className="vs-project-card-content">
            <button className="vs-project-card-title" disabled={project.archived} onClick={()=>onOpen(project)}>{project.title}</button>
            <p className="vs-project-path" title={project.path}>{project.path}</p>
            <div className="vs-project-card-meta">
              {project.revision!==undefined&&<span>v{project.revision}</span>}
              <span>{project.archivedAt?`归档于 ${localTime(project.archivedAt)}`:project.updatedAt?`更新于 ${localTime(project.updatedAt)}`:'本地影片工程'}</span>
            </div>
            <div className="vs-project-card-actions">
              {project.archived?<button onClick={()=>onManage(project,'restore')}>恢复工程</button>
                :<>
                  <button className="vs-primary" onClick={()=>onOpen(project)}>打开工作台</button>
                  <button onClick={()=>onManage(project,'backup')}>备份</button>
                  <details className="vs-project-more">
                    <summary aria-label={`管理工程 ${project.title}`}><Icon name="more"/></summary>
                    <div>
                      <button onClick={()=>onManage(project,'rename')}>重命名</button>
                      <button onClick={()=>onManage(project,'duplicate')}>复制工程</button>
                      <button onClick={()=>onManage(project,'archive')}>归档</button>
                    </div>
                  </details>
                </>}
            </div>
          </div>
        </article>)}</div>}
    </section>
  </main>;
}

export function CreateWizard({packs,configured,busy,onCreate,onClose,onConfigure,styles=[],initialStyle,onStyles}:{
  packs:PackCatalog|null;configured:boolean;busy:boolean;onCreate:(brief:CreateBrief)=>Promise<void>;
  onClose:()=>void;onConfigure:()=>void;styles?:VideoStyle[];initialStyle?:VideoStyle;onStyles?:()=>void;
}){
  const [brief,setBrief]=useState<CreateBrief>({title:'',topic:'',duration:30,profile:'presentation-landscape',preset:'clear-message',mode:'blank',productionMode:'',...(initialStyle?{videoStyle:initialStyle}:{})});
  const [error,setError]=useState('');
  useEffect(()=>{if(initialStyle)setBrief(value=>({...value,videoStyle:initialStyle}));},[initialStyle]);
  async function submit(){try{briefPayload(brief);setError('');if(brief.mode==='ai'&&!configured){onConfigure();return;}await onCreate(brief);}catch(cause){setError(errorMessage(cause));}}
  return <div className="yl-modal-backdrop"><section className="yl-modal yl-create-modal" role="dialog" aria-modal="true" aria-labelledby="yl-create-title">
    <div className="yl-modal-heading"><div><span className="yl-eyebrow">START A FILM</span><h2 id="yl-create-title">开启一部新影片</h2></div><button className="yl-button yl-icon-button" aria-label="关闭新建影片" disabled={busy} onClick={onClose}><AppIcon name="close"/></button></div>
    <p>这些设定会保存进工程，之后可以在工作台与智能体中继续修改。</p>
    <label className="yl-field"><span>影片名称</span><input autoFocus aria-label="影片名称" placeholder="这部影片叫什么？" value={brief.title} onChange={event=>setBrief({...brief,title:event.target.value})} disabled={busy}/></label>
    <label className="yl-field"><span>主题与创作简报</span><textarea aria-label="主题与创作简报" rows={3} placeholder="要表达什么？面向谁？有哪些必须出现的人物、分镜或素材？" value={brief.topic} onChange={event=>setBrief({...brief,topic:event.target.value})} disabled={busy}/></label>
    <div className="yl-field">
      <span>制作模式（可选约束）</span>
      <div className="vs-choice-cards" role="radiogroup" aria-label="制作模式">
        {([['','智能体自由协作','按已接入能力自动调度代码、白模预演与生成模型','spark'],['code_animation','代码动画','锁定 HTML/Canvas 动效，禁止调用视频生成','code'],['model_video','模型视频','锁定视频生成或导入素材，不执行自由源码','video']] as const).map(([value,label,hint,icon])=>
          <button type="button" key={value} role="radio" aria-checked={(brief.productionMode??'')===value} className={(brief.productionMode??'')===value?'is-active':''} disabled={busy} onClick={()=>setBrief({...brief,productionMode:value})}>
            <Icon name={icon}/><span><strong>{label}</strong><small>{hint}</small></span>
          </button>
        )}
      </div>
    </div>
    <div className="yl-field-pair">
      <label className="yl-field"><span>目标片长（秒）</span><input aria-label="目标片长（秒）" type="number" min="1" max="3600" value={brief.duration} onChange={event=>setBrief({...brief,duration:Number(event.target.value)})} disabled={busy}/></label>
      <label className="yl-field"><span>输出规格</span><select aria-label="初始输出规格" value={brief.profile} onChange={event=>setBrief({...brief,profile:event.target.value})} disabled={busy}>{OUTPUT_PROFILES.map(profile=><option value={profile.id} key={profile.id}>{profile.name} · {profile.detail}</option>)}</select></label>
    </div>
    <div className="yl-field-pair">
      <label className="yl-field"><span>创作方向</span><select aria-label="创作方向" value={brief.preset} onChange={event=>setBrief({...brief,preset:event.target.value})} disabled={busy}>{(packs?.art||[{id:'clear-message',name:'信息聚焦',summary:''}]).map(pack=><option key={pack.id} value={pack.id}>{pack.name}</option>)}</select></label>
      <label className="yl-field"><span>自定义视频风格（可选）</span><select aria-label="自定义视频风格" value={brief.videoStyle?.id||''} disabled={busy} onChange={event=>setBrief({...brief,videoStyle:styles.find(style=>style.id===event.target.value)})}><option value="">使用上方创作方向</option>{styles.map(style=><option key={style.id} value={style.id}>{style.name}</option>)}</select></label>
    </div>
    {onStyles&&<button type="button" className="yl-button" disabled={busy} onClick={onStyles}>打开视频风格库</button>}
    <div className="yl-start-options">
      <button type="button" className={brief.mode==='blank'?'is-active':''} onClick={()=>setBrief({...brief,mode:'blank'})} disabled={busy}><AppIcon name="plus"/><strong>从空图开始</strong><small>进入工作台，手工编排或交给智能体规划分镜</small></button>
      <button type="button" className={brief.mode==='ai'?'is-active':''} onClick={()=>setBrief({...brief,mode:'ai'})} disabled={busy}><AppIcon name="chat"/><strong>让模型构建初稿</strong><small>{configured?'根据简报生成可编辑镜头':'先配置你的模型，再开始创作'}</small></button>
    </div>
    {error&&<p className="yl-error" role="alert">{error}</p>}
    <div className="yl-modal-actions">
      <button type="button" className="yl-button" onClick={onClose} disabled={busy}>取消</button>
      <button type="button" className="yl-button yl-primary" onClick={()=>void submit()} disabled={busy}>{busy?'正在创建':brief.mode==='ai'&&!configured?'配置模型并继续':brief.mode==='ai'?'创建并生成初稿':'创建空白影片'}</button>
    </div>
  </section></div>;
}
