const approval = {
  plan: ['Подтверди план и запусти спринт.', 'Approve the plan and start the sprint.', 'Aprueba el plan e inicia el sprint.', 'Approuve le plan et lance le sprint.', '批准计划并启动迭代。'],
  acceptance: ['Прими этот результат.', 'Accept this result.', 'Acepta este resultado.', 'Accepte ce résultat.', '接受这个结果。'],
  merge: ['Прими результат и слей в ветку ', 'Accept the result and merge into ', 'Acepta el resultado y fusiona en ', 'Accepte le résultat et fusionne dans ', '接受结果并合并到分支 '],
  meeting: ['Подтверди решение встречи.', 'Approve the meeting decision.', 'Aprueba la decisión de la reunión.', 'Approuve la décision de la réunion.', '确认会议决定。'],
  roster: ['Одобри изменение состава.', 'Approve the team change.', 'Aprueba el cambio del equipo.', 'Approuve le changement d’équipe.', '批准团队变更。'],
};
const locales = ['ru','en','es','fr','zh-Hans'];
const phrase = value => String(value ?? '').normalize('NFC').trim().replace(/\s+/gu,' ').replace(/[.!。！]+$/u,'');
const normalized = value => phrase(value).toLowerCase();

export function explicitInboxApproval(kind, text, branch) {
  if (kind === 'merge') return Boolean(branch && approval.merge.some(prefix => {
    const candidate = phrase(text);
    return candidate.slice(0,prefix.length).toLowerCase()===prefix.toLowerCase() && candidate.slice(prefix.length)===branch;
  }));
  const alternatives = {plan:['подтверди план','утверждаю план','approve the plan'],acceptance:['прими результат','принимаю результат','accept the result']};
  return (approval[kind] ?? []).map(normalized).concat(alternatives[kind] ?? []).includes(normalized(text));
}

export function explicitInboxRevision(text) {
  return /^(?:верни|пересобери|переделай|исправь|измени|доработай|отклони|отправь на доработку|revise|return|fix|change|reject|rework|devuelve|revisa|rechaza|révise|renvoie|corrige|refuse|修改|退回|拒绝)(?:\s|$|(?=[\p{Script=Han}]))/iu.test(phrase(text));
}

export function explicitInboxRetry(text) {
  return /^(?:повтори|возобнови|перезапусти|retry|resume|restart|reintenta|reanuda|relance|reprends|重试|恢复)(?:\s|$|(?=[\p{Script=Han}]))/iu.test(phrase(text));
}

export function explicitExitAndRetry(text) {
  return ['Я проверил, что прежний процесс завершился. Повтори шаг.', 'I verified that the previous process has exited. Retry the step.',
    'He verificado que el proceso anterior ha terminado. Reintenta el paso.', 'J’ai vérifié que le processus précédent est terminé. Relance l’étape.',
    '我已确认先前的进程已退出。重试此步骤。'].map(normalized).includes(normalized(text));
}

export function inboxSuggestions(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0,3).flatMap((choice,index)=>{
    const label = typeof choice?.label === 'string' ? choice.label.trim().slice(0,100) : '';
    const answer = typeof choice?.text === 'string' ? choice.text.trim().slice(0,1200) : '';
    return label && answer ? [{id:'director-'+index,label,answer}] : [];
  });
}

const defaults = {
  explain: ['Объясни, что произошло и что будет дальше.', 'Explain what happened and what comes next.', 'Explica qué ocurrió y qué sigue.', 'Explique ce qui s’est passé et la suite.', '解释发生了什么以及下一步。'],
  planRevision: ['Пересобери план с меньшим объёмом.', 'Revise the plan with a smaller scope.', 'Revisa el plan con un alcance menor.', 'Révise le plan avec un périmètre réduit.', '修改计划，缩小范围。'],
  reviewRevision: ['Верни результат на доработку и объясни, что исправить.', 'Return the result for revisions and explain what to fix.', 'Devuelve el resultado para revisión y explica qué corregir.', 'Renvoie le résultat pour révision et explique quoi corriger.', '退回结果进行修改，并说明要修正什么。'],
  rejectRoster: ['Отклони изменение состава.', 'Reject the team change.', 'Rechaza el cambio del equipo.', 'Refuse le changement d’équipe.', '拒绝团队变更。'],
  retry: ['Повтори шаг, если это безопасно.', 'Retry the step if it is safe.', 'Reintenta el paso si es seguro.', 'Relance l’étape si elle peut l’être sans risque.', '重试此步骤（如果安全）。'],
};

export function directorInboxSuggestions(item, locale, { branch, retry } = {}) {
  const index=Math.max(0,locales.indexOf(locale));
  const out=[];
  const append=(id, text)=>{if(text && !out.some(option=>option.text===text))out.push({id,label:text,text});};
  const key=item.kind==='acceptance' && branch ? 'merge' : item.kind;
  if (approval[key]) append('approve', key==='merge'?approval.merge[index]+branch:approval[key][index]);
  const revision = {plan:'planRevision',acceptance:'reviewRevision',roster:'rejectRoster'}[item.kind];
  if (revision) append('revise', defaults[revision][index]);
  if (retry) append('retry', defaults.retry[index]);
  const suggested=item.choices ?? item.options;
  for (const [i, choice] of (Array.isArray(suggested)?suggested:[]).entries()) {
    if (out.length>=2 && item.kind!=='question') break;
    const text=choice?.answer ?? choice?.text ?? choice?.label;
    if (typeof text==='string' && text.trim() && !out.some(option=>option.text===text)) out.push({
      id:'suggested-'+i,label:choice.label || text,text,
    });
    if(out.length===3) return out;
  }
  append('explain',defaults.explain[index]);
  return out.slice(0,3);
}
