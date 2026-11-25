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

const useAvailable = ['Продолжи с доступными материалами. Отметь, что ещё требует проверки.',
  'Continue with the available materials. Mark what still needs verification.',
  'Continúa con el material disponible. Señala lo que queda por verificar.',
  'Continue avec les éléments disponibles. Signale ce qui reste à vérifier.',
  '用现有资料继续。标明仍需核实的内容。'];
const findSources = ['Найди другие источники и попробуй сверить факты по ним.',
  'Find alternative sources and try to verify the facts against them.',
  'Busca otras fuentes e intenta verificar los hechos con ellas.',
  'Cherche d’autres sources et essaie d’y vérifier les faits.',
  '寻找其他来源，并尝试用它们核实事实。'];
const findAnotherWay = ['Проверь материалы студии и попробуй другой способ выполнить задачу.',
  'Check the studio materials and try another way to complete the task.',
  'Revisa el material del estudio e intenta resolver la tarea de otro modo.',
  'Examine les éléments du studio et essaie une autre façon de réaliser la tâche.',
  '检查工作室的资料，并尝试用其他办法完成任务。'];
const continueLabel = ['Продолжить с тем, что есть','Continue with what’s available','Continuar con lo que hay',
  'Continuer avec les éléments disponibles','使用现有资料继续'];
const sourcesLabel = ['Найти другие источники','Find alternative sources','Buscar otras fuentes','Chercher d’autres sources','寻找其他来源'];
const alternativeLabel = ['Попробовать другой способ','Try another approach','Intentar otro método','Essayer une autre méthode','尝试其他办法'];

export function continueFromInbox(text) {
  if (ownerKeepsSourceQuestionOpen(text)) return false;
  const reply = normalized(text);
  return [...useAvailable, ...findAnotherWay].some(option => {
    const choice = normalized(option);
    return reply === choice || reply.startsWith(choice + '. ') || reply.startsWith(choice + '。');
  });
}

const sourceWords = /источник|ссылк|dns|404|\b(?:sources?|web|websites?|archives?|fuentes?)\b|来源|资料/iu;
const localOnly = /(?:не (?:ищи(?:те)?|поищи(?:те)?|используй(?:те)? (?:веб|интернет))|только (?:по|в) материалах студии|(?:do not|don’t|don't) (?:search|browse|use the web)|only (?:in|with|from) (?:the )?studio materials|no busques en internet|ne cherche pas sur le web|不要在网上搜索)(?:\s|[.,!?:。！]|$)/iu;

export function ownerSourceDirective(text) {
  const value = normalized(text);
  if (continueFromInbox(text) || localOnly.test(value)) return 'local';
  if (findSources.map(normalized).includes(value)) return 'search';
  if (/^(?:(?:пожалуйста|please)[, ]+)?(?:найди(?:те)?|поищи(?:те)?|ищи(?:те)?|search|find|look for|busca|cherche|寻找|搜索)(?:\s|(?=[\p{Script=Han}]))/iu.test(value) &&
      (sourceWords.test(value) || /интернет|онлайн|архив|en ligne/iu.test(value))) return 'search';
}

export function ownerKeepsSourceQuestionOpen(text) {
  return /оставь (?:этот )?вопрос открытым|не (?:закрывай (?:вопрос|входящее)|продолжай задачу)|keep (?:the |this )?question open|(?:do not|don’t|don't) (?:close the question|resume the task)|deja la pregunta abierta|laisse la question ouverte|(?:保留|先别关闭)(?:这个)?问题/iu.test(normalized(text));
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

const reconciliationDetails = {
  active: 'Hearth ждёт завершения прежнего запуска. После этого здесь появятся доступные действия.',
  exit: 'Завершение прежнего процесса не подтверждено. Проверьте процесс и сохранившиеся изменения, затем выберите действие.',
  work: 'Шаг прервался. Проверьте сохранённые изменения, затем повторите шаг или оставьте его прерванным.',
  ready: 'Прежний запуск завершён. Можно повторить шаг или оставить его прерванным.',
  missing: 'Запись прежнего запуска недоступна. Откройте задачу, чтобы посмотреть её историю.',
};
const reconciliationChecks = {
  exit: ['Я проверил завершение прежнего процесса и сохранённые изменения.', 'I verified that the previous process exited and checked the saved changes.',
    'Confirmé que terminó el proceso anterior y revisé los cambios guardados.', 'J’ai vérifié que le processus précédent est terminé et contrôlé les modifications enregistrées.', '我已确认先前的进程已退出，并检查了保存的更改。'],
  work: ['Я проверил сохранённые изменения.', 'I checked the saved changes.', 'Revisé los cambios guardados.', 'J’ai contrôlé les modifications enregistrées.', '我已检查保存的更改。'],
};
const reconciliationActions = {
  retry: {
    labels:['Повторить шаг','Retry the step','Reintentar el paso','Relancer l’étape','重试步骤'],
    checkedLabels:['Подтвердить сверку и повторить','Confirm and retry','Confirmar y reintentar','Confirmer et relancer','确认并重试'],
    text:defaults.retry,
  },
  discard: {
    labels:['Оставить шаг прерванным','Leave step interrupted','Dejar el paso interrumpido','Laisser l’étape interrompue','保持步骤中断'],
    text:['Оставь шаг прерванным.','Leave the step interrupted.','Deja el paso interrumpido.','Laisse l’étape interrompue.','保持步骤中断。'],
  },
};

export function reconciliationState(attempt) {
  if (attempt?.status !== 'reconcile') return 'missing';
  if (attempt.processActive) return 'active';
  if (attempt.processUnconfirmed || attempt.processUnconfirmed !== false && ['restart','lease-expired'].includes(attempt.reason)) return 'exit';
  return attempt.reason === 'stopped' && attempt.processUnconfirmed === false ? 'ready' : 'work';
}

export function reconciliationDetail(state) {
  return reconciliationDetails[state];
}

function reconciliationOptions(state, index) {
  if (!['exit','work','ready'].includes(state)) return [];
  const check = reconciliationChecks[state]?.[index];
  return Object.entries(reconciliationActions).map(([id,{labels,checkedLabels,text}])=>({
    id, label:(check && checkedLabels ? checkedLabels : labels)[index], text:check ? `${check} ${text[index]}` : text[index],
  }));
}

export function reconciliationDecision(state, text) {
  const value=normalized(text);
  for (let index=0; index<locales.length; index++) {
    const option=reconciliationOptions(state,index).find(option=>normalized(option.text)===value);
    if (option) return {decision:option.id,confirmProcessExited:state==='exit'};
  }
  if (state==='exit' && explicitExitAndRetry(text)) return {decision:'retry',confirmProcessExited:true};
}

export function isDirectorExplanation(text) {
  return defaults.explain.map(normalized).includes(normalized(text));
}

export function directorInboxSuggestions(item, locale, { branch, retry, reconciliation, webSearch = 'unknown', taskSummary } = {}) {
  const index=Math.max(0,locales.indexOf(locale));
  if (item.kind==='reconcile') return [...reconciliationOptions(reconciliation,index),
    {id:'explain',label:defaults.explain[index],text:defaults.explain[index]}];
  const out=[];
  const append=(id, text, label=text)=>{
    if(text && !out.some(option=>option.text===text)) {
      const intent=item.kind==='question' ? ownerSourceDirective(text) : undefined;
      out.push({id,label,text,...(intent?{intent}:{})});
    }
  };
  const key=item.kind==='acceptance' && branch ? 'merge' : item.kind;
  if (approval[key] && !item.review?.reworkRequired) append('approve', key==='merge'?approval.merge[index]+branch:approval[key][index]);
  const revision = {plan:'planRevision',acceptance:'reviewRevision',roster:'rejectRoster'}[item.kind];
  if (revision) append('revise', defaults[revision][index]);
  if (retry) append('retry', defaults.retry[index]);
  if (item.kind==='question' && (item.classification==='technical' || !(item.choices?.length || item.options?.length))) {
    const sources = webSearch === 'available' && sourceWords.test(`${item.title ?? ''} ${item.body ?? ''} ${taskSummary ?? ''}`);
    append('alternative',sources?findSources[index]:findAnotherWay[index],sources?sourcesLabel[index]:alternativeLabel[index]);
    append('continue',useAvailable[index],continueLabel[index]);
  }
  const suggested=item.choices ?? item.options;
  for (const [i, choice] of (Array.isArray(suggested)?suggested:[]).entries()) {
    if (out.length>=2 && item.kind!=='question') break;
    const text=choice?.answer ?? choice?.text ?? choice?.label;
    if (webSearch !== 'available' && (ownerSourceDirective(text) === 'search' || sourcesLabel.map(normalized).includes(normalized(choice?.label)))) continue;
    if (typeof text==='string' && text.trim()) append('suggested-'+i,text,choice.label || text);
    if(out.length===3) return out;
  }
  append('explain',defaults.explain[index]);
  return out.slice(0,3);
}
