/** User supplied rates only. This module performs no requests and never authorizes paid work. */
export function priceNumber(value:unknown):number|null {
  if(typeof value!=='number'&&typeof value!=='string'||typeof value==='string'&&!value.trim())return null;
  const number=Number(value);return Number.isFinite(number)&&number>=0?number:null;
}
export function priceCurrency(parameters:Record<string,unknown>):string {
  return parameters.priceCurrency===undefined?'CNY':typeof parameters.priceCurrency==='string'&&/^[A-Z]{3}$/.test(parameters.priceCurrency)?parameters.priceCurrency:'UNKNOWN';
}
export function configuredTokenCost(parameters:Record<string,unknown>,input:number,output:number,currency=priceCurrency(parameters)):number|null {
  const a=priceNumber(parameters.pricePerMInput),b=priceNumber(parameters.pricePerMOutput);
  if(a===null||b===null||!/^[A-Z]{3}$/.test(currency)||currency!==priceCurrency(parameters)||![input,output].every(value=>Number.isSafeInteger(value)&&value>=0))return null;
  const cost=(input*a+output*b)/1_000_000;return Number.isFinite(cost)?cost:null;
}
export function estimateTokenScenario(parameters:Record<string,unknown>,input:number,output:number,rounds:number):{cost:number|null;currency:string;reason:string} {
  const currency=priceCurrency(parameters);
  if(!Number.isSafeInteger(rounds)||rounds<1||rounds>200)return {cost:null,currency,reason:'轮数须为 1–200 的整数'};
  if(![input,output].every(value=>Number.isSafeInteger(value)&&value>=0))return {cost:null,currency,reason:'每轮 token 数量须为非负安全整数'};
  const cost=configuredTokenCost(parameters,input*rounds,output*rounds,currency);
  return {cost,currency,reason:cost===null?'输入/输出单价或 token 数量不完整，费用未知':'按填写的单价与 token 情景计算；实际账单以供应商为准'};
}
