const key='hearth:studio-creation-draft';
const fieldNames=['name','brief','firstResult','folderMode','root','newFolderName','targetRef','offerGit',
  'language','projectLanguage','runtime','model','effort'];
function normalize(value) {
  if (!value || typeof value!=='object' || !Number.isInteger(value.step) ||
      value.step<0 || value.step>2 || !value.fields || typeof value.fields!=='object') return null;
  const fields=Object.fromEntries(fieldNames.flatMap(name => {
    const input=value.fields[name];
    return typeof input==='string'||(name==='offerGit'&&typeof input==='boolean')?[[name,input]]:[];
  }));
  const existingIds=Array.isArray(value.existingIds)?value.existingIds.filter(id=>typeof id==='string'):[];
  return {version:1,step:value.step,pending:value.pending===true,existingIds,fields};
}
export function readStudioDraft(storage) {
  try {
    const value=JSON.parse(storage.getItem(key));
    return value?.version===1?normalize(value):null;
  } catch {return null;}
}
export function writeStudioDraft(storage,draft,{afterReview=false}={}) {
  const value=normalize(draft);
  if(!value)return false;
  if(!afterReview&&readStudioDraft(storage)?.pending)return false;
  try {storage.setItem(key,JSON.stringify(value));return true;}
  catch {return false;}
}
export function clearStudioDraft(storage) {
  try {storage.removeItem(key);}
  catch { /* The profile may be unavailable. */ }
}
