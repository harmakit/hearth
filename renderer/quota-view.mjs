import { copy,getCopyLocale } from './copy.mjs';

const providerName = runtime => runtime==='codex'?'Codex':runtime==='claude'?'Claude Code':runtime;
const date = value => new Date(value).toLocaleString(getCopyLocale());

export function quotaThresholdText(value) {
  return value==null?copy('Порог отключён'):copy('Приостановить при остатке')+' '+value+'%';
}

export function quotaObservationText(quota) {
  if(quota?.status==='unsupported')return copy('Недельная квота: провайдер не передаёт данные.');
  const last=quota?.lastKnown;
  const reset=last?.resetAt?copy('Сброс')+' · '+date(last.resetAt):'';
  if(quota?.status==='known' && last)return [copy('Недельный остаток')+' · '+last.remainingPercent+'%',reset].filter(Boolean).join(' · ');
  return [copy('Недельный остаток неизвестен'),last?copy('Последнее измерение')+' · '+last.remainingPercent+'% ('+date(last.observedAt)+')':'',reset].filter(Boolean).join(' · ');
}

export function quotaPauseText(pause) {
  if(!pause)return '';
  return [
    copy('Новые автоматические запуски на паузе.'),
    providerName(pause.runtime)+' · '+pause.remainingPercent+'% · '+copy(pause.scope==='app'?'Общий порог':'Порог студии')+' '+pause.threshold+'%.',
    pause.resetAt?copy('Сброс')+' · '+date(pause.resetAt)+'.':'',
    pause.stale?copy('Данные устарели; пауза сохранится до нового измерения.'):copy('Активные запуски завершатся без прерывания.'),
  ].filter(Boolean).join(' ');
}
