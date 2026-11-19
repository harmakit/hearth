import { catalogue } from './copy-catalog.mjs';
let locale = 'ru';
export const getCopyLocale = () => locale;
const listeners = new Set();
export function setCopyLocale(value) {
  if (value === locale) return;
  locale = value;
  for (const fn of listeners) fn();
}
export function onCopyLocale(fn) { listeners.add(fn); }
const languageIndex = { en:0, es:1, fr:2, 'zh-Hans':3 };
const entities = {'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'};
function part(value, html, language=locale) {
  if(language==='ru' || typeof value!=='string') return value;
  return value.split(/([<>"=\n\r])/u).map(piece=>{
    const key=piece.trim();
    if(!key || !Object.hasOwn(catalogue,key)) return piece;
    const result=catalogue[key][languageIndex[language] ?? 0];
    return piece.slice(0,piece.indexOf(key)) + (html ? result.replace(/[&<>"']/g,c=>entities[c]) : result) + piece.slice(piece.indexOf(key)+key.length);
  }).join('');
}
// Only authored source segments pass through the dictionary. Interpolated data is preserved verbatim.
export function copy(source,...values) {
  if (typeof source==='string') return part(source,/[<>]|=\s*"/.test(source));
  const html=source.some(s=>/[<>]|=\s*"/.test(s));
  return source.reduce((out,chunk,i)=>out+(i?values[i-1]:'')+part(chunk,html),'');
}

// Keep the interpolated title in its original language, including quotation marks.
export function copySystem(value,translate=copy) {
  if(typeof value!=='string' || !value)return value;
  for(const separator of [' · ',' «',': ']){
    const cut=value.indexOf(separator);
    if(cut>0) {
      const prefix=value.slice(0,cut+separator.length);
      const translated=translate(prefix);
      if(translated!==prefix)return translated+value.slice(cut+separator.length);
    }
  }
  return Object.hasOwn(catalogue,value) ? translate(value) : value;
}
export function inboxLabel(item,translate=copy) {
  return ['error','acceptance','reconcile'].includes(item?.kind) ? copySystem(item.title,translate) : item?.title;
}
export const inboxLabelIn = (item,language)=>inboxLabel(item,s=>part(s,false,language));
