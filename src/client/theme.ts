export const LOOKS=['graphite','lightbox'] as const;
export type Look=typeof LOOKS[number];
const KEY='yingliu-look',DEFAULT_LOOK:Look='graphite';
const valid=(value:string|null|undefined):value is Look=>(LOOKS as readonly string[]).includes(value||'');

export function currentLook():Look{
  const value=typeof document==='undefined'?undefined:document.documentElement.dataset.look;
  return valid(value)?value:DEFAULT_LOOK;
}

/** Applies the stored look before first paint; storage may be unavailable, which falls back to the default. */
export function initLook():void{
  let stored:string|null=null;
  try{stored=localStorage.getItem(KEY);}catch{/* storage blocked */}
  document.documentElement.dataset.look=valid(stored)?stored:DEFAULT_LOOK;
}

export function setLook(look:Look):void{
  document.documentElement.dataset.look=look;
  try{localStorage.setItem(KEY,look);}catch{/* storage blocked */}
  window.dispatchEvent(new Event('yingliu-look-changed'));
}

/** Reads a CSS custom property from the root element, for canvas drawing. */
export function token(name:string,fallback:string):string{
  if(typeof document==='undefined')return fallback;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()||fallback;
}
