import { useState } from 'react';
import { estimateTokenScenario, priceCurrency } from '../shared/model-cost.ts';

export function ModelCostEstimate({parameters,onChange,disabled=false}:{parameters:string;onChange:(value:string)=>void;disabled?:boolean}){
  const [input,setInput]=useState('10000'),[output,setOutput]=useState('2000'),[rounds,setRounds]=useState('1');
  let config:Record<string,unknown>={},valid=true;
  try{config=JSON.parse(parameters);if(!config||typeof config!=='object'||Array.isArray(config)){valid=false;config={};}}catch{valid=false;}
  const scenario=estimateTokenScenario(valid?config:{},Number(input||NaN),Number(output||NaN),Number(rounds||NaN));
  const field=(key:string)=>typeof config[key]==='string'||typeof config[key]==='number'?String(config[key]):'';
  function update(key:string,value:string){if(!valid)return;const next={...config};if(value==='')delete next[key];else next[key]=value;onChange(JSON.stringify(next,null,2));}
  return <details className="vs-media-advanced"><summary>文本费用情景试算</summary>
    <p className="vs-media-help">填写你账户的单价。这里不会调用模型；试算只计算文本 token，不包含图片、视频、配音或重试费用，也不会自动批准收费操作。</p>
    {!valid&&<p role="alert">请先修正模型参数 JSON。</p>}
    <div className="vs-field-pair"><label className="vs-field"><span>每百万输入 token 单价</span><input aria-label="每百万输入 token 单价" inputMode="decimal" value={field('pricePerMInput')} disabled={disabled||!valid} onChange={event=>update('pricePerMInput',event.target.value)}/></label><label className="vs-field"><span>每百万输出 token 单价</span><input aria-label="每百万输出 token 单价" inputMode="decimal" value={field('pricePerMOutput')} disabled={disabled||!valid} onChange={event=>update('pricePerMOutput',event.target.value)}/></label></div>
    <label className="vs-field"><span>单价币种</span><select aria-label="单价币种" value={priceCurrency(config)} disabled={disabled||!valid} onChange={event=>update('priceCurrency',event.target.value)}><option value="CNY">CNY</option><option value="USD">USD</option></select></label>
    <label className="vs-field"><span>价格来源与核对日期</span><input aria-label="价格来源与核对日期" placeholder="例如：账户价格页，2026-10-28" value={field('priceSource')} disabled={disabled||!valid} onChange={event=>update('priceSource',event.target.value)}/></label>
    <div className="vs-field-pair"><label className="vs-field"><span>每轮输入 token</span><input aria-label="试算输入 token" type="number" min="0" step="1" value={input} disabled={disabled} onChange={event=>setInput(event.target.value)}/></label><label className="vs-field"><span>每轮输出 token</span><input aria-label="试算输出 token" type="number" min="0" step="1" value={output} disabled={disabled} onChange={event=>setOutput(event.target.value)}/></label></div>
    <label className="vs-field"><span>预计轮数</span><input aria-label="试算轮数" type="number" min="1" max="200" step="1" value={rounds} disabled={disabled} onChange={event=>setRounds(event.target.value)}/></label>
    <p role="status">{scenario.cost===null?'费用未知':`文本情景费用约 ${scenario.cost.toFixed(6)} ${scenario.currency}`}。{scenario.reason}。</p>
    <p className="vs-media-help">单价随模型设置保存。账本与单价币种不一致时保留费用未知，不自动换汇。</p>
  </details>;
}
