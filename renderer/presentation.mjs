import { copy } from './copy.mjs';

export const escapeMarkup = value => String(value ?? '').replace(/[&<>"']/g,
  char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const marks = {
  backlog:['neutral','M8 3a5 5 0 1 0 0 10A5 5 0 0 0 8 3Z'],
  ready:['neutral','M4 4h8v8H4z'],
  in_progress:['active','m6 3 7 5-7 5z'],
  review:['waiting','M2 8s2-4 6-4 6 4 6 4-2 4-6 4-6-4-6-4Z M8 7v2'],
  qa:['waiting','M4 3h8v10H4z M6 8l1 1 3-3'],
  done:['done','m3 8 3 3 7-7'],
  blocked:['blocked','M8 2 14 13H2z M8 6v3m0 2v.2'],
};

export function stageMark(stage, label) {
  const [tone,path] = marks[stage] ?? marks.backlog;
  return `<span class="stage-mark" data-tone="${tone}"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${path}"/></svg>${escapeMarkup(label)}</span>`;
}

export function progressMark(done, total) {
  if (!Number.isSafeInteger(total) || total <= 0) return `<small class="muted">${copy('Задач пока нет.')}</small>`;
  const complete = Number.isSafeInteger(done) ? Math.max(0,Math.min(total,done)) : 0;
  const visible = Math.min(total,10);
  const filled = Math.floor(complete * visible / total);
  const segments = Array.from({length:visible},(_,index)=>`<i${index<filled?' data-done':''}></i>`).join('');
  return copy`<span class="stage-progress"><span class="stage-segments" aria-hidden="true">${segments}</span><span>Готово ${complete} из ${total}</span></span>`;
}
