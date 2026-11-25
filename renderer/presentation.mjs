import { copy } from './copy.mjs';
import { escapeMarkup, renderReportMarkdown, renderWebLink } from './report-markdown.mjs';
export { escapeMarkup, renderReportMarkdown, renderReportMarkdown as renderDirectorReplyText };

export function reconciliationDecisionCopy(item, decision) {
  if (decision === 'retry') return {
    label: copy('Повторить шаг'), submit: copy('Поставить повтор в очередь'),
    description: copy('Hearth поставит этот шаг в очередь. Он запустится, когда студия возобновит работу и появится свободное место.'),
  };
  return {
    label: copy('Закрыть сверку без повтора'), submit: copy('Закрыть сверку без повтора'),
    description: copy(item.taskId
      ? 'Задача останется прерванной, её файлы сохранятся. Зависимые задачи будут ждать её завершения.'
      : 'Шаг останется прерванным, его файлы сохранятся. Новый запуск можно начать из обзора студии.'),
  };
}

export function renderReconciliationDecisions(item) {
  const choices = (item.directorSuggestions ?? []).filter(({ id }) => id === 'retry' || id === 'discard');
  if (item.status !== 'open' || !choices.length) return '';
  const check = item.reconciliationState === 'exit' ? copy('Я проверил завершение прежнего процесса и сохранённые изменения.') :
    item.reconciliationState === 'work' ? copy('Я проверил сохранённые изменения.') : '';
  return `<section class="reconciliation-decisions stack compact" aria-labelledby="reconciliation-decision-title">
    <h3 id="reconciliation-decision-title">${escapeMarkup(copy('Что сделать с шагом'))}</h3>
    <div class="reconciliation-choices">${choices.map(({ id }) => {
      const { label, description } = reconciliationDecisionCopy(item, id);
      return `<button type="button" class="reconciliation-choice" data-reconcile-choice="${id}" aria-pressed="false">
        <strong>${escapeMarkup(label)}</strong><span>${escapeMarkup(description)}</span></button>`;
    }).join('')}</div>
    <div class="reconciliation-confirm stack compact" data-reconciliation-confirm hidden>
      ${check ? `<label class="checkbox-field"><input type="checkbox" data-reconciliation-check><span>${escapeMarkup(check)}</span></label>` : ''}
      <div class="actions"><button type="button" class="action" data-reconciliation-apply disabled></button></div>
    </div></section>`;
}

export function conversationContextHeading(mode) {
  return copy(mode==='running'?'Контекст текущего ответа':mode==='queued'?'Контекст ответа в очереди':'Контекст следующего ответа');
}

export function conversationHistorySlice(messages, startId, beforeId) {
  const start=messages.findIndex(row=>row.id===startId);
  const before=beforeId===null?messages.length:messages.findIndex(row=>row.id===beforeId);
  return start<0||before<0?[]:messages.slice(start,before).filter(row=>row.status!=='queued');
}

const sourceLabels = { read:'Страница прочитана', found:'Ссылка найдена', failed:'Страница не открылась',
  attempted:'Была попытка открыть страницу', unverified:'Ссылка требует проверки' };

export function renderWebResearch(research) {
  if (!research) return '';
  const sources = Array.isArray(research.sources) ? research.sources.filter(source=>typeof source?.url==='string') : [];
  const unverified = Array.isArray(research.unverified) ? research.unverified.filter(fact=>typeof fact==='string') : [];
  const reason = typeof research.reason === 'string' ? research.reason : '';
  if (!sources.length && !unverified.length && !reason) return '';
  const sourceItems = sources.map(({url,status,note}) => {
    const label = copy(Object.hasOwn(sourceLabels,status) ? sourceLabels[status] : sourceLabels.unverified);
    const detail = note === 'permission' ? copy('Провайдер отклонил запрос к странице.') : note;
    return `<li><strong>${escapeMarkup(label)}</strong><div dir="ltr" class="research-source-url">${renderWebLink(url)}</div>${detail ? `<div>${escapeMarkup(detail)}</div>` : ''}</li>`;
  }).join('');
  return `<div class="director-research">
    ${reason ? `<p>${escapeMarkup(reason)}</p>` : ''}
    ${sourceItems ? `<ul aria-label="${escapeMarkup(copy('Источники'))}">${sourceItems}</ul>` : ''}
    ${unverified.length ? `<strong>${escapeMarkup(copy('Осталось проверить'))}</strong><ul>${unverified.map(fact=>`<li>${escapeMarkup(fact)}</li>`).join('')}</ul>` : ''}
  </div>`;
}
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

// Keep the performer's time-of-submission text as evidence. Host verification
// occurred later; its recorded result is shown separately for the exact revision.
export function renderRecordedChecks(delivery) {
  const revision = delivery?.revision;
  if (!revision?.headOid || !revision?.targetOid) return '';
  const phase = revision.candidateOid ? 'candidate' : 'work';
  const checks = (delivery.checks ?? []).filter(check => check.required && check.phase === phase &&
    check.revision?.headOid === revision.headOid && check.revision?.targetOid === revision.targetOid &&
    (phase !== 'candidate' || check.revision?.candidateOid === revision.candidateOid));
  if (!checks.length) return '';
  const passed = checks.filter(check => check.status === 'PASS').length;
  const tone = passed === checks.length ? 'done' : checks.some(check => check.status === 'FAIL') ? 'blocked' : 'qa';
  const label = `${copy('Пройдено обязательных проверок Hearth')} · ${passed}/${checks.length}`;
  return `<div class="recorded-checks">${stageMark(tone,label)}<small class="muted">${escapeMarkup(copy(phase === 'candidate' ? 'Версия кандидата' : 'Версия рабочей копии'))}</small></div>`;
}

export function progressMark(done, total) {
  if (!Number.isSafeInteger(total) || total <= 0) return `<small class="muted">${copy('Задач пока нет.')}</small>`;
  const complete = Number.isSafeInteger(done) ? Math.max(0,Math.min(total,done)) : 0;
  const visible = Math.min(total,10);
  const filled = Math.floor(complete * visible / total);
  const segments = Array.from({length:visible},(_,index)=>`<i${index<filled?' data-done':''}></i>`).join('');
  return copy`<span class="stage-progress"><span class="stage-segments" aria-hidden="true">${segments}</span><span>Готово ${complete} из ${total}</span></span>`;
}
