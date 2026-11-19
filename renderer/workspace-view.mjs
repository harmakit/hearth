const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const safe = value => String(value ?? '').replace(/[&<>"']/g, symbol => entities[symbol]);
const create = '<button type="button" class="action" data-open="studio">Создать студию</button>';
const statuses = {
  draft: 'Черновик', planning: 'Готовит план', 'awaiting-approval': 'Ждёт согласования', active: 'В работе',
  paused: 'На паузе', idle: 'Без активных задач', error: 'Нужно внимание',
};
const metrics = (running, open) => `<dt>Задачи в работе</dt><dd>${running}</dd><dt>Открытые входящие</dt><dd>${open}</dd>`;

export function renderWorkspaceHome({ studios = [], tasks = [], inbox = [] }) {
  if (!studios.length) return `<header class="page-heading"><h1>Все студии</h1></header>
    <div class="panel empty"><h2>Студий пока нет</h2><p class="muted">Создайте студию и дайте директору первую задачу.</p>${create}</div>`;
  const counts = new Map(studios.map(({ id }) => [String(id), { running: 0, open: 0 }]));
  let running = 0;
  let open = 0;
  for (const item of tasks) {
    const count = counts.get(String(item.studioId));
    if (count && item.status === 'running') { count.running++; running++; }
  }
  for (const item of inbox) {
    const count = counts.get(String(item.studioId));
    if (count && item.status === 'open') { count.open++; open++; }
  }
  return `<header class="page-heading"><h1>Все студии</h1><div class="actions">${create}</div></header>
    <div class="stack"><dl class="workspace-summary panel padded" aria-label="Сводка по студиям">
      <dt>Студии</dt><dd>${studios.length}</dd>${metrics(running, open)}</dl>
      <div class="workspace-cards">${studios.map(studio => {
        const id = safe(studio.id);
        const name = safe(studio.name);
        const count = counts.get(String(studio.id));
        return `<article class="panel padded stack compact workspace-card">
          <header><h2><button type="button" class="workspace-studio-name" data-enter-studio="${id}">${name}</button></h2>
          <p class="muted">${safe(studio.manualPaused ? 'На паузе' : statuses[studio.lifecycle] ?? 'Без активных задач')}</p></header>
          ${studio.root ? `<p class="muted workspace-path">${safe(studio.root)}</p>` : ''}
          <dl class="workspace-card-metrics">${metrics(count.running, count.open)}</dl>
          ${count.open ? `<div><button type="button" class="action secondary" data-workspace-inbox="${id}" aria-label="Входящие студии ${name}">Открыть входящие</button></div>` : ''}
        </article>`;
      }).join('')}</div></div>`;
}
