import { useEffect, useRef } from 'react';
import './onboarding.css';
import { AppIcon } from './ui.tsx';

interface Props {
  textReady: boolean;
  inStudio: boolean;
  busy: boolean;
  onConfigure: (section: 'text' | 'multimodal') => void;
  onContinue: () => void;
  onDismiss: () => void;
}

export function OnboardingDialog({textReady,inStudio,busy,onConfigure,onContinue,onDismiss}:Props){
  const dialogRef=useRef<HTMLDialogElement>(null);
  useEffect(()=>{
    const dialog=dialogRef.current;
    if(!dialog)return;
    dialog.showModal();
    return()=>{dialog.close();};
  },[]);

  return (
    <dialog ref={dialogRef} className="yl-modal yl-onboarding-modal" aria-labelledby="yl-onboarding-title" aria-describedby="yl-onboarding-intro" onCancel={event=>{event.preventDefault();onDismiss();}}>
      <div className="yl-modal-heading">
        <h2 id="yl-onboarding-title">开始使用映流智能体</h2>
        <button className="yl-button yl-icon-button" aria-label="关闭新手引导" onClick={onDismiss}><AppIcon name="close"/></button>
      </div>
      <div className="yl-onboarding-content">
        <p id="yl-onboarding-intro">你可以随时从顶部「新手引导」回到这里。</p>
        <ol className="yl-onboarding-steps">
          <li>
            <div className="yl-onboarding-step-heading"><h3>配置创作模型</h3><span>可选</span></div>
            <p>文本模型用于讨论、写分镜和生成画面代码，默认接入 OpenAI。分析参考图片需配置多模态模型。图片、视频和音频生成可在「高级模型中心」配置。</p>
            <div className="yl-onboarding-links">
              <button className="yl-button" disabled={busy} onClick={()=>onConfigure('text')}><AppIcon name={textReady?'check':'settings'}/>{textReady?'查看文本模型':'配置文本模型'}</button>
              <button className="yl-button" disabled={busy} onClick={()=>onConfigure('multimodal')}><AppIcon name="image"/>配置多模态模型</button>
            </div>
          </li>
          <li>
            <div className="yl-onboarding-step-heading"><h3>填写影片简报</h3></div>
            <p>新建影片后，填写主题、片长和输出规格。选择「从空图开始」可直接手动创作。配置文本模型后，也可以让模型构建初稿。</p>
          </li>
          <li>
            <div className="yl-onboarding-step-heading"><h3>编辑、预览与导出</h3></div>
            <p>在工作台点击「添加镜头」，安排画面和顺序，再打开「影片预览」。准备导出时，可在「运行环境」检查 Chromium、FFmpeg 和 ffprobe，再打开「导出成片」。</p>
          </li>
        </ol>
      </div>
      <div className="yl-modal-actions">
        <button className="yl-button" onClick={onDismiss}>{inStudio?'关闭引导':'稍后再看'}</button>
        <button className="yl-button yl-primary" disabled={busy&&!inStudio} onClick={onContinue}>{inStudio?'回到工作台':'开始新建影片'}</button>
      </div>
    </dialog>
  );
}
