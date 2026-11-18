const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const safe = value => String(value ?? '').replace(/[&<>"']/g, character => entities[character]);
const section = (title, body) => `<section class="inline-result legacy-record"><h3>${title}</h3>${body}</section>`;
const button = (label, key, id) => `<button class="action secondary" type="button" data-${key}="${safe(id)}">${safe(label)}</button>`;
const list = entries => `<ul class="legacy-list">${entries.map(entry => `<li>${entry}</li>`).join('')}</ul>`;
const paragraph = value => `<p class="long-text">${safe(value)}</p>`;
const amounts = new Intl.NumberFormat('ru-RU');
const dateTime = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium', timeStyle: 'short' });
const date = value => value && Number.isFinite(new Date(value).getTime()) ? dateTime.format(new Date(value)) : '';

export const questionOptions = item => Array.isArray(item.choices) ? item.choices : Array.isArray(item.options) ? item.options : [];
export function answerPayload(item, { answer = '', choiceId, attachmentIds = [], operationId } = {}) {
  return { inboxId: item.id, answer, ...(item.kind === 'question' ? {
    version: item.version ?? 1, ...(choiceId ? { choiceId } : {}), attachmentIds, operationId,
  } : {}) };
}

export function renderQuestionDetails(item) {
  const options = questionOptions(item);
  const history = item.history ?? item.versions ?? [];
  return (item.version ? `<p class="muted">Версия ${safe(item.version)}</p>` : '') +
    (item.context ? section('Контекст', paragraph(item.context)) : '') +
    (options.length ? section('Варианты', list(options.map(choice => `<strong>${safe(choice.label ?? choice.title ?? choice.text ?? choice.id)}</strong>${choice.description ? paragraph(choice.description) : ''}`))) : '') +
    (item.answerChoiceId || item.choiceId ? section('Выбранный вариант', paragraph(options.find(choice => choice.id === (item.answerChoiceId || item.choiceId))?.label ?? (item.answerChoiceId || item.choiceId))) : '') +
    (item.blockedTaskIds?.length ? section('Ждут этого решения', list(item.blockedTaskIds.map(id => button('Открыть задачу', 'task', id)))) : '') +
    (history.length ? section('История', list(history.map(entry => `<strong>Версия ${safe(entry.version)}</strong>${paragraph(entry.answer ?? entry.body ?? entry.status)}`))) : '');
}

const checkStatuses = { passed: 'Пройдена', pass: 'Пройдена', failed: 'Не пройдена', fail: 'Не пройдена',
  skipped: 'Пропущена', not_assessed: 'Не оценена', 'NOT ASSESSED': 'Не оценена', timeout: 'Время истекло',
  running: 'Выполняется', pending: 'Ожидает запуска' };
const integrationStatuses = { integrated: 'Слито', merged: 'Слито', blocked: 'Ждёт решения', ready: 'Готово к слиянию', conflict: 'Конфликт', stale: 'Версия изменилась' };
const revisionText = revision => typeof revision === 'object' && revision
  ? [revision.headOid, revision.candidateOid, revision.targetOid].filter(Boolean).join(' · ')
  : revision;
const recordRevision = revision => revision ? `<p class="muted legacy-oid">Версия: ${safe(revisionText(revision))}</p>` : '';

export function renderEvidence(evidence = []) {
  if (!evidence.length) return '';
  return section('Доказательства', list(evidence.map(item => `<strong>${safe(item.name ?? item.filename ?? item.sourcePath ?? item.kind ?? 'Файл')}</strong>
    <p class="muted">${[item.contentType, Number.isFinite(item.size) ? `${amounts.format(item.size)} байт` : '', item.digest].filter(Boolean).map(safe).join(' · ')}</p>
    ${recordRevision(item.revision)}<div class="actions">${!item.contentType || /^(?:text\/|image\/(?:jpeg|png|webp|gif)$|video\/|audio\/|application\/(?:json|pdf)$)/.test(item.contentType)
    ? button('Открыть', 'evidence', item.id) : ''}${button('Сохранить копию', 'save-evidence', item.id)}</div>`)));
}

export function renderDelivery({ checks = [], evidence = [], delivery, worktree, receipts = [] } = {}) {
  return (worktree ? section('Рабочая копия Git', paragraph(worktree.branchRef ?? worktree.branch) +
    (worktree.targetRef ? `<p class="muted">Цель: ${safe(worktree.targetRef)}</p>` : '') +
    recordRevision(worktree.revision ?? worktree.headOid)) : '') +
    (delivery ? section('Доставка', paragraph(integrationStatuses[delivery.status] ?? delivery.status) +
      (delivery.reason ? paragraph(delivery.reason) : '') + recordRevision(delivery.revision ?? delivery.targetOid)) : '') +
    (checks.length ? section('Проверки', list(checks.map(check =>
      `<strong>${safe(check.label ?? check.checkId ?? check.id)}</strong> · ${safe(checkStatuses[check.status] ?? check.status)}
        ${recordRevision(check.revision)}${check.reason ? paragraph(check.reason) : ''}${check.logRef ? `<details><summary>Журнал проверки</summary>${paragraph(check.logRef)}</details>` : ''}`))) : '') +
    (receipts.length ? section('Квитанции ревью', list(receipts.map(receipt =>
      `${paragraph(receipt.result ?? receipt.status)}${recordRevision(receipt.revision)}`))) : '') +
    renderEvidence(evidence);
}

export function renderUsageReport(report = {}) {
  const rows = Array.isArray(report) ? report : (report.byAttempt?.map(row => ({ ...report.events?.find(event => event.attemptId === row.attemptId), ...row })) ??
    report.events ?? report.rows ?? report.groups ?? report.usage ?? []);
  const count = value => value == null ? 'Нет данных' : amounts.format(value);
  const table = (title, rows, label) => rows?.length ? `<div class="legacy-table" tabindex="0" role="region" aria-label="${safe(title)}">
    <table><caption>${safe(title)}</caption><thead><tr><th>Группа</th><th>Вход</th><th>Выход</th><th>Чтение кэша</th><th>Запись в кэш</th></tr></thead>
    <tbody>${rows.map(row => `<tr><th scope="row">${safe(label(row) || 'Без детализации')}</th>
      <td>${count(row.input)}</td><td>${count(row.output)}</td><td>${count(row.cacheRead)}</td><td>${count(row.cacheWrite)}</td></tr>`).join('')}</tbody></table></div>` : '';
  const breakdowns = [
    ['По попыткам', rows, row => [row.role, row.runtime ?? row.provider, row.model, row.attemptId].filter(Boolean).join(' · ')],
    ['По ролям', report.byRole, row => row.role],
    ['По моделям', report.byModel, row => [row.provider, row.model].filter(Boolean).join(' · ')],
    ['По провайдерам', report.byProvider, row => row.provider],
  ];
  return (rows.length ? table('Всего по студии', report.totals ? [report.totals] : [], () => 'Все попытки') +
    breakdowns.map(([title, values, label]) => values?.length ? `<details><summary>${title}</summary>${table(title, values, label)}</details>` : '').join('') +
    section('Оценка расходов', paragraph(report.estimatedCost ? `${count(report.estimatedCost.amount)} ${report.estimatedCost.currency}` : 'Нет тарифа'))
    : '<p class="muted">Данные о токенах пока недоступны.</p>') + (report.subscription
      ? section('Лимит подписки', paragraph(`${count(report.subscription.usedPercent)} % использовано${report.subscription.resetsAt ? ` · Сброс: ${date(report.subscription.resetsAt)}` : ''}`))
      : '<p class="muted">Лимит подписки: нет данных.</p>');
}

export function renderDiagnostic(report = {}) {
  const diagnosticLabels = { unknown: 'Нет данных', running: 'Выполняется', waiting: 'Ожидание', idle: 'Нет активного запуска', stopping: 'Завершается', interrupted: 'Прерван', connected: 'Подключён', ready: 'Доступно', disconnected: 'Нет подключения',
    resume: 'Возобновить', retry: 'Повторить', reconcile: 'Сверить состояние', reconnect: 'Восстановить подключение', wait: 'Подождать', inspect: 'Просмотреть', restart: 'Перезапустить', 'resolve-conflict': 'Разрешить конфликт',
    authorization: 'Авторизация', 'rate-limit': 'Лимит провайдера', 'git-conflict': 'Конфликт Git', transient: 'Временный сбой', configuration: 'Настройки', provider: 'Ошибка провайдера' };
  const label = key => diagnosticLabels[key] ?? key;
  const rows = [
    ['Подключение', [report.connection?.runtime, label(report.connection?.status)].filter(Boolean).join(' · ')],
    ['Процесс', label(report.process?.status ?? report.lifecycle)],
    ['Расписание', report.schedule?.waiting ? 'Ждёт рабочего окна' : 'Нет ожидания'],
    ['Следующее окно', date(report.schedule?.nextAt ?? report.nextWindow ?? report.nextRunAt)],
    ['В очереди', report.queue?.pending ?? report.queue?.queued ?? report.queued],
    ['В работе', report.queue?.active ?? report.queue?.running ?? report.running],
    ['Ждут решения', report.queue?.waiting ?? report.waiting],
    ['Последняя ошибка', [label(report.lastError?.kind), date(report.lastError?.at)].filter(Boolean).join(' · ')],
    ['Следующая попытка', date(report.lastError?.retryAt)],
    ['Доступное действие', label(report.action)],
  ].filter(([, value]) => ['string', 'number'].includes(typeof value) && value !== '');
  return rows.length ? `<dl class="studio-meta">${rows.map(([label, value]) => `<dt>${label}</dt><dd>${safe(value)}</dd>`).join('')}</dl>`
    : '<p class="muted">Диагностические данные недоступны.</p>';
}

export function renderRetrospective(facts) {
  if (!facts) return '';
  const counts = [
    ['План', facts.planned], ['Принято', facts.accepted], ['Перенесено', facts.carried], ['Блокировки', facts.blocked],
    ['Замены', facts.replaced], ['Незавершённый техдолг', facts.debt],
  ];
  return `<details class="legacy-record"><summary>Факты ретроспективы</summary>
    <p class="muted">Методика: версия ${safe(facts.methodVersion)}</p>
    <dl class="studio-meta">${counts.filter(([, value]) => value).map(([label, value]) =>
      `<dt>${label}</dt><dd>${safe(value.count)} задач · ${value.points === null ? 'баллы не оценены' : `${safe(value.points)} баллов`}</dd>`).join('')}
      ${facts.training ? `<dt>Обучение</dt><dd>Принято ${safe(facts.training.accepted)} из ${safe(facts.training.count)}</dd>` : ''}
      ${facts.rework ? `<dt>Циклы доработки</dt><dd>${safe(facts.rework.cycles)}</dd>` : ''}
      ${facts.qa ? `<dt>Попытки ревью</dt><dd>${safe(facts.qa.reviewAttempts)} · ошибок: ${safe(facts.qa.failedReviewAttempts)}</dd>` : ''}
    </dl></details>`;
}
