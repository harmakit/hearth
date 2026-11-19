import {textFor} from './locale.mjs';
const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const safe = value => String(value ?? '').replace(/[&<>"']/g, symbol => entities[symbol]);
const statuses = {
  draft: 'Черновик', planning: 'Готовит план', 'awaiting-approval': 'Ждёт согласования', active: 'В работе',
  paused: 'На паузе', idle: 'Без активных задач', error: 'Нужно внимание',
};

export function renderWorkspaceHome({ studios = [], tasks = [], inbox = [], appLocale = 'ru' }) {
  const ui = key=>textFor(appLocale,key);
  const create = `<button type="button" class="action" data-open="studio">${ui('create')}</button>`;
  const metrics = (running, open) => `<dt>${ui('running')}</dt><dd>${running}</dd><dt>${ui('open')}</dt><dd>${open}</dd>`;
  if (!studios.length) return `<header class="page-heading"><h1>${ui('workspace')}</h1></header>
    <div class="panel empty"><h2>${ui('empty')}</h2><p class="muted">${ui('start')}</p>${create}</div>`;
  const counts = new Map(studios.map(({ id }) => [String(id), { running: 0, open: 0 }]));
  let running = 0;
  let open = 0;
  for (const item of tasks) {
    const count = counts.get(String(item.studioId));
    if (count && item.status === 'running') { count.running++; running++; }
  }
  for (const item of inbox) {
    const count = counts.get(String(item.studioId));
    if (!count || item.status !== 'open') continue;
    count.open++; open++;
    const blocking = Boolean(item.blockedTaskIds?.length || item.taskId || item.kind === 'plan');
    const oldest = item.createdAt || '9999';
    if (!count.decision || (blocking && !count.blocking) || (blocking === count.blocking && oldest < count.oldest)) {
      Object.assign(count, { decision: item, blocking, oldest });
    }
  }
  return `<header class="page-heading"><h1>${ui('workspace')}</h1><div class="actions">${create}</div></header>
    <div class="stack"><dl class="workspace-summary panel padded" aria-label="${ui('workspace')}">
      <dt>${ui('studios')}</dt><dd>${studios.length}</dd>${metrics(running, open)}</dl>
      <div class="workspace-cards">${studios.map(studio => {
        const id = safe(studio.id);
        const name = safe(studio.name);
        const count = counts.get(String(studio.id));
        return `<article class="panel padded stack compact workspace-card">
          <header><h2><button type="button" class="workspace-studio-name" data-enter-studio="${id}">${name}</button></h2>
          <p class="muted">${ui(studio.manualPaused ? 'paused' : studio.lifecycle === 'stopped' || Object.hasOwn(statuses,studio.lifecycle) ? studio.lifecycle : 'idle')}</p></header>
          ${studio.root ? `<p class="muted workspace-path">${safe(studio.root)}</p>` : ''}
          <dl class="workspace-card-metrics">${metrics(count.running, count.open)}</dl>
          ${count.decision?.title ? `<div><button class="text-button" type="button" data-workspace-inbox="${id}" data-decision="${safe(count.decision.id)}">${safe(count.decision.title)}</button></div>` : ''}
          ${count.open ? `<div><button type="button" class="action secondary" data-workspace-inbox="${id}" aria-label="${ui('inbox')} · ${name}">${ui('openInbox')}</button></div>` : ''}
        </article>`;
      }).join('')}</div></div>`;
}
