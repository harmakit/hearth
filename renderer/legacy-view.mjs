import {copy, onCopyLocale , getCopyLocale} from './copy.mjs';
const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const safe = value => String(value ?? '').replace(/[&<>"']/g, character => entities[character]);
const section = (title, body) => `<section class="inline-result legacy-record"><h3>${title}</h3>${body}</section>`;
const button = (label, key, id) => `<button class="action secondary" type="button" data-${key}="${safe(id)}">${safe(label)}</button>`;
const list = entries => `<ul class="legacy-list">${entries.map(entry => `<li>${entry}</li>`).join('')}</ul>`;
const paragraph = value => `<p class="long-text">${safe(value)}</p>`;
let amounts = new Intl.NumberFormat(getCopyLocale());
onCopyLocale(()=>{ amounts=new Intl.NumberFormat(getCopyLocale()); });
let dateTime = new Intl.DateTimeFormat(getCopyLocale(), { dateStyle: 'medium', timeStyle: 'short' });
onCopyLocale(()=>{ dateTime=new Intl.DateTimeFormat(getCopyLocale(), { dateStyle: 'medium', timeStyle: 'short' }); });
const date = value => value && Number.isFinite(new Date(value).getTime()) ? dateTime.format(new Date(value)) : '';

export const questionOptions = item => Array.isArray(item.choices) ? item.choices : Array.isArray(item.options) ? item.options : [];
export function answerPayload(item, { answer = '', choiceId, attachmentIds = [], operationId } = {}) {
  return { inboxId: item.id, answer, ...(item.kind === 'question' ? {
    version: item.version ?? 1, ...(choiceId ? { choiceId } : {}), attachmentIds, operationId,
  } : {}) };
}

export function renderQuestionDetails(item,{taskTitles=new Map()}={}) {
  const options = questionOptions(item);
  const history = item.history ?? item.versions ?? [];
  return (item.version ? copy`<p class="muted">Версия ${safe(item.version)}</p>` : '') +
    (item.context ? section(copy('Контекст'), paragraph(item.context)) : '') +
    (options.length ? section(copy('Варианты'), list(options.map(choice => `<strong>${safe(choice.label ?? choice.title ?? choice.text ?? choice.id)}</strong>${choice.description ? paragraph(choice.description) : ''}`))) : '') +
    (item.answerChoiceId || item.choiceId ? section(copy('Выбранный вариант'), paragraph(options.find(choice => choice.id === (item.answerChoiceId || item.choiceId))?.label ?? (item.answerChoiceId || item.choiceId))) : '') +
    (item.blockedTaskIds?.length ? section(copy('Ждут этого решения'), list(item.blockedTaskIds.map(id => button(taskTitles.get(id) ?? copy('Открыть задачу'), 'task', id)))) : '') +
    (history.length ? section(copy('История'), list(history.map(entry => copy`<strong>Версия ${safe(entry.version)}</strong>${paragraph(entry.answer ?? entry.body ?? entry.status)}`))) : '');
}

const makeCheckStatuses = () => ({ passed: copy('Пройдена'), pass: copy('Пройдена'), failed: copy('Не пройдена'), fail: copy('Не пройдена'),
  skipped: copy('Пропущена'), not_assessed: copy('Не оценена'), 'NOT ASSESSED': copy('Не оценена'), timeout: copy('Время истекло'),
  running: copy('Выполняется'), pending: copy('Ожидает запуска') });
let checkStatuses = makeCheckStatuses();
onCopyLocale(() => { checkStatuses = makeCheckStatuses(); });
const makeIntegrationStatuses = () => ({ integrated: copy('Слито'), merged: copy('Слито'), blocked: copy('Ждёт решения'), ready: copy('Готово к слиянию'), conflict: copy('Конфликт'), stale: copy('Версия изменилась') });
let integrationStatuses = makeIntegrationStatuses();
onCopyLocale(() => { integrationStatuses = makeIntegrationStatuses(); });
const revisionText = revision => typeof revision === 'object' && revision
  ? [revision.headOid, revision.candidateOid, revision.targetOid].filter(Boolean).join(' · ')
  : revision;
const recordRevision = revision => revision ? copy`<p class="muted legacy-oid">Версия: ${safe(revisionText(revision))}</p>` : '';

export function renderEvidence(evidence = [], { attributes, heading = true } = {}) {
  if (!evidence.length) return '';
  const rows = `<ul class="legacy-list">${evidence.map(item => `<li${attributes ? ' '+attributes(item) : ''}>
    <strong>${safe(item.name ?? item.filename ?? item.sourcePath ?? item.kind ?? copy('Файл'))}</strong>
    <p class="muted">${[item.contentType, Number.isFinite(item.size) ? copy`${amounts.format(item.size)} байт` : '', item.digest].filter(Boolean).map(safe).join(' · ')}</p>
    ${recordRevision(item.revision)}<div class="actions">${!item.contentType || /^(?:text\/|image\/(?:jpeg|png|webp|gif)$|video\/|audio\/|application\/(?:json|pdf)$)/.test(item.contentType)
    ? button(copy('Открыть'), 'evidence', item.id) : ''}${button(copy('Показать в папке'), 'reveal-evidence', item.id)}${button(copy('Копировать путь'), 'copy-evidence-path', item.id)}${button(copy('Сохранить копию'), 'save-evidence', item.id)}</div></li>`).join('')}</ul>`;
  return heading ? section(copy('Доказательства'), rows) : rows;
}

export function renderDelivery({ checks = [], evidence = [], delivery, worktree, receipts = [] } = {}) {
  return (worktree ? section(copy('Рабочая копия Git'), paragraph(worktree.branchRef ?? worktree.branch) +
    (worktree.targetRef ? copy`<p class="muted">Цель: ${safe(worktree.targetRef)}</p>` : '') +
    recordRevision(worktree.revision ?? worktree.headOid)) : '') +
    (delivery ? section(copy('Доставка'), paragraph(integrationStatuses[delivery.status] ?? delivery.status) +
      (delivery.reason ? paragraph(delivery.reason) : '') + recordRevision(delivery.revision ?? delivery.targetOid)) : '') +
    (checks.length ? section(copy('Проверки'), list(checks.map(check =>
      `<strong>${safe(check.label ?? check.checkId ?? check.id)}</strong> · ${safe(checkStatuses[check.status] ?? check.status)}
        ${recordRevision(check.revision)}${check.reason ? paragraph(check.reason) : ''}${check.logRef ? copy`<details><summary>Журнал проверки</summary>${paragraph(check.logRef)}</details>` : ''}`))) : '') +
    (receipts.length ? section(copy('Квитанции ревью'), list(receipts.map(receipt =>
      `${paragraph(receipt.result ?? receipt.status)}${recordRevision(receipt.revision)}`))) : '') +
    renderEvidence(evidence);
}

export function renderUsageReport(report = {}) {
  const rows = Array.isArray(report) ? report : (report.byAttempt?.map(row => ({ ...report.events?.find(event => event.attemptId === row.attemptId), ...row })) ??
    report.events ?? report.rows ?? report.groups ?? report.usage ?? []);
  const count = value => value == null ? copy('Нет данных') : amounts.format(value);
  const table = (title, rows, label) => rows?.length ? copy`<div class="legacy-table" tabindex="0" role="region" aria-label="${safe(title)}">
    <table><caption>${safe(title)}</caption><thead><tr><th>Группа</th><th>Вход</th><th>Выход</th><th>Чтение кэша</th><th>Запись в кэш</th></tr></thead>
    <tbody>${rows.map(row => `<tr><th scope="row">${safe(label(row) || copy('Без детализации'))}</th>
      <td>${count(row.input)}</td><td>${count(row.output)}</td><td>${count(row.cacheRead)}</td><td>${count(row.cacheWrite)}</td></tr>`).join('')}</tbody></table></div>` : '';
  const breakdowns = [
    [copy('По попыткам'), rows, row => [row.role, row.runtime ?? row.provider, row.model, row.attemptId].filter(Boolean).join(' · ')],
    [copy('По ролям'), report.byRole, row => row.role],
    [copy('По моделям'), report.byModel, row => [row.provider, row.model].filter(Boolean).join(' · ')],
    [copy('По провайдерам'), report.byProvider, row => row.provider],
  ];
  return (rows.length ? table(copy('Всего по студии'), report.totals ? [report.totals] : [], () => copy('Все попытки')) +
    breakdowns.map(([title, values, label]) => values?.length ? `<details><summary>${title}</summary>${table(title, values, label)}</details>` : '').join('') +
    section(copy('Оценка расходов'), paragraph(report.estimatedCost ? `${count(report.estimatedCost.amount)} ${report.estimatedCost.currency}` : copy('Нет тарифа')))
    : copy('<p class="muted">Данные о токенах пока недоступны.</p>')) + (report.subscription
      ? section(copy('Лимит подписки'), paragraph(copy`${count(report.subscription.usedPercent)} % использовано${report.subscription.resetsAt ? copy` · Сброс: ${date(report.subscription.resetsAt)}` : ''}`))
      : copy('<p class="muted">Лимит подписки: нет данных.</p>'));
}

export function renderDiagnostic(report = {}) {
  const diagnosticLabels = { unknown: copy('Нет данных'), running: copy('Выполняется'), waiting: copy('Ожидание'), idle: copy('Нет активного запуска'), stopping: copy('Завершается'), interrupted: copy('Прерван'), connected: copy('Подключён'), ready: copy('Доступно'), disconnected: copy('Нет подключения'),
    resume: copy('Возобновить'), retry: copy('Повторить'), reconcile: copy('Сверить состояние'), reconnect: copy('Восстановить подключение'), wait: copy('Подождать'), inspect: copy('Просмотреть'), restart: copy('Перезапустить'), 'resolve-conflict': copy('Разрешить конфликт'),
    authorization: copy('Авторизация'), 'rate-limit': copy('Лимит провайдера'), 'git-conflict': copy('Конфликт Git'), transient: copy('Временный сбой'), configuration: copy('Настройки'), provider: copy('Ошибка провайдера') };
  const label = key => diagnosticLabels[key] ?? key;
  const rows = [
    [copy('Подключение'), [report.connection?.runtime, label(report.connection?.status)].filter(Boolean).join(' · ')],
    [copy('Процесс'), label(report.process?.status ?? report.lifecycle)],
    [copy('Последний сигнал от запуска'), date(report.process?.observedAt)],
    [copy('Расписание'), report.schedule?.waiting ? copy('Ждёт рабочего окна') : copy('Нет ожидания')],
    [copy('Следующее окно'), date(report.schedule?.nextAt ?? report.nextWindow ?? report.nextRunAt)],
    [copy('В очереди'), report.queue?.pending ?? report.queue?.queued ?? report.queued],
    [copy('В работе'), report.queue?.active ?? report.queue?.running ?? report.running],
    [copy('Ждут решения'), report.queue?.waiting ?? report.waiting],
    [copy('Последняя ошибка'), [label(report.lastError?.kind), date(report.lastError?.at)].filter(Boolean).join(' · ')],
    [copy('Следующая попытка'), date(report.lastError?.retryAt)],
    [copy('Доступное действие'), label(report.action)],
  ].filter(([, value]) => ['string', 'number'].includes(typeof value) && value !== '');
  return rows.length ? `<dl class="studio-meta">${rows.map(([label, value]) => `<dt>${label}</dt><dd>${safe(value)}</dd>`).join('')}</dl>`
    : copy('<p class="muted">Диагностические данные недоступны.</p>');
}

export function renderRetrospective(facts) {
  if (!facts) return '';
  const counts = [
    [copy('План'), facts.planned], [copy('Принято'), facts.accepted], [copy('Перенесено'), facts.carried], [copy('Блокировки'), facts.blocked],
    [copy('Замены'), facts.replaced], [copy('Открытые улучшения'), facts.debt],
  ];
  return copy`<details class="legacy-record"><summary>Факты ретроспективы</summary>
    <p class="muted">Методика: версия ${safe(facts.methodVersion)}</p>
    <dl class="studio-meta">${counts.filter(([, value]) => value).map(([label, value]) =>
      copy`<dt>${label}</dt><dd>${safe(value.count)} задач · ${value.points === null ? copy('баллы не оценены') : copy`${safe(value.points)} баллов`}</dd>`).join('')}
      ${facts.training ? copy`<dt>Обучение</dt><dd>Принято ${safe(facts.training.accepted)} из ${safe(facts.training.count)}</dd>` : ''}
      ${facts.rework ? copy`<dt>Циклы доработки</dt><dd>${safe(facts.rework.cycles)}</dd>` : ''}
      ${facts.qa ? copy`<dt>Попытки ревью</dt><dd>${safe(facts.qa.reviewAttempts)} · ошибок: ${safe(facts.qa.failedReviewAttempts)}</dd>` : ''}
    </dl></details>`;
}
