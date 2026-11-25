import {inboxLabelIn} from './copy.mjs';
import {textFor} from './locale.mjs';
import {progressMark,stageMark} from './presentation.mjs';
import {copy} from './copy.mjs';
import {studioActivityStatus} from './owner-facts.mjs';
import {quotaPauseText} from './quota-view.mjs';
import {todayItems} from './today-view.mjs';
const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const safe = value => String(value ?? '').replace(/[&<>"']/g, symbol => entities[symbol]);
const statuses = new Set(['draft', 'planning', 'awaiting-approval', 'active', 'paused', 'idle', 'error', 'stopped']);

export function renderWorkspaceHome(snapshot) {
  const {studios:allStudios = [], tasks = [], attempts, sprints=[], inbox = [], appLocale = 'ru', projectAvailability={}, hasDraft=false,quotaPolicy} = snapshot;
  const ui = key=>textFor(appLocale,key);
  const archived=allStudios.filter(s=>s.archivedAt);
  const studios=allStudios.filter(s=>!s.archivedAt);
  const decisions=todayItems(snapshot,projectAvailability);
  const archive=archived.length ? `<details class="panel padded" data-work-record="studio-archive"><summary>${ui('archived')} · ${archived.length}</summary>${archived.map(s=>`<div class="row">
    <button type="button" class="text-button" data-archive-details="${safe(s.id)}">${safe(s.name)}</button><button type="button" class="action secondary" data-restore-studio="${safe(s.id)}">${ui('restore')}</button></div>`).join('')}</details>` : '';
  const create = `<button type="button" class="action" data-open="studio">${hasDraft?copy('Продолжить создание'):ui('create')}</button>`+
    `<button type="button" class="action secondary" data-open="studio-folder">${copy('Открыть папку студии')}</button>`+
    `<button type="button" class="action secondary" data-open="import-bundle">${copy('Импортировать файл Hearth')}</button>`;
  const taskButton=t=>`<button type="button" class="text-button" data-portfolio-task="${safe(t.id)}" data-studio="${safe(t.studioId)}">${safe(t.title || t.id)}</button>`;
  const requestButton=i=>`<button type="button" class="text-button" data-workspace-inbox="${safe(i.studioId)}" data-decision="${safe(i.id)}">${safe(inboxLabelIn(i,appLocale) || i.id)}</button>`;
  const metric=(label,count,values,button)=>`<dt>${label}</dt><dd>${values.some(v=>v.id) ? `<details><summary aria-label="${label} · ${count}">${count}</summary>${values.filter(v=>v.id).map(button).join('<br>')}</details>` : count}</dd>`;
  const liveIds = new Set((attempts??[]).filter(a=>a.status==='running' && a.taskId).map(a=>JSON.stringify([a.studioId,a.taskId])));
  const liveTasks = tasks.filter(t=>attempts ? liveIds.has(JSON.stringify([t.studioId,t.id])) : t.status==='running');
  const metrics = (running, open,id) => metric(ui('running'),running,liveTasks.filter(t=>!id || t.studioId===id),taskButton)+metric(ui('open'),open,inbox.filter(i=>(!id || i.studioId===id) && i.status==='open'),requestButton);
  if (!studios.length) return `<header class="page-heading"><h1>${ui('workspace')}</h1></header>
    <div class="panel empty"><h2>${ui('empty')}</h2><p class="muted">${ui('start')}</p>${create}</div>${archive}`;
  const counts = new Map(studios.map(({ id }) => [String(id), { running: 0, open: 0, needsAttention: false }]));
  let running = 0;
  let open = 0;
  for (const item of liveTasks) {
    const count = counts.get(String(item.studioId));
    if (count) { count.running++; running++; }
  }
  for (const task of tasks) {
    const count = counts.get(String(task.studioId));
    if (count && task.status === 'failed') count.needsAttention = true;
  }
  for (const item of inbox) {
    const count = counts.get(String(item.studioId));
    if (!count || item.status !== 'open') continue;
    count.open++; open++;
    if (item.kind === 'error' || item.kind === 'reconcile') count.needsAttention = true;
    if (item.id && item.title) {
      const blocking = Boolean(item.blockedTaskIds?.length || item.taskId || item.kind==='plan');
      const oldest = item.createdAt || '9999';
      if (!count.legacyDecision || (blocking && !count.blocking) || (blocking===count.blocking && oldest<count.oldest)) {
        Object.assign(count,{legacyDecision:item,blocking,oldest});
      }
    }
  }
  return `<header class="page-heading"><h1>${ui('workspace')}</h1><div class="actions">${create}</div></header>
    <div class="stack"><dl class="workspace-summary panel padded" aria-label="${ui('workspace')}">
      <dt>${ui('studios')}</dt><dd>${studios.length}</dd>${metrics(running, open)}</dl>
      ${quotaPolicy?.pause?`<p class="panel padded activity" role="status">${safe(quotaPauseText(quotaPolicy.pause))}</p>`:''}
      <div class="workspace-cards">${studios.map(studio => {
        const id = safe(studio.id);
        const name = safe(studio.name);
        const count = counts.get(String(studio.id));
        const status = studioActivityStatus(studio, studio.activeAttempts ?? count.running, count.needsAttention);
        const sprint = sprints.findLast(s=>s.studioId===studio.id && s.status==='active');
        const members=sprint?tasks.filter(t=>t.studioId===studio.id&&t.stage!=='replaced'&&(t.sprintId===sprint.id||sprint.taskIds?.includes(t.id))):[];
        const latest = tasks.filter(t=>t.studioId===studio.id && t.updatedAt).toSorted((a,b)=>b.updatedAt.localeCompare(a.updatedAt))[0];
        const next = decisions.find(row=>row.studioId===studio.id);
        const decision = next ? inbox.find(item=>item.id===next.inboxId && item.studioId===studio.id) : count.legacyDecision;
        const decisionLabel = decision ? inboxLabelIn(decision,appLocale) : next?.label;
        const createdAt=next?.createdAt??decision?.createdAt;
        const date = Number.isFinite(Date.parse(createdAt)) ? new Date(createdAt).toLocaleString(appLocale) : '';
        const decisionAction=decision
          ? `data-workspace-inbox="${id}" data-decision="${safe(decision.id)}"`
          : next ? `data-today-id="${safe(next.id)}" data-today-kind="${safe(next.kind)}" data-today-studio="${id}"` : '';
        return `<article class="panel padded stack compact workspace-card">
          <header><h2><button type="button" class="workspace-studio-name" data-enter-studio="${id}">${name}</button></h2>
          ${stageMark(status === 'active' ? 'in_progress' : status === 'error' ? 'blocked' : 'backlog', ui(statuses.has(status) ? status : 'idle'))}</header>
          ${studio.projectDetached || projectAvailability[studio.id]?.available===false ? `<button type="button" class="text-button" data-project-settings="${id}">${ui(studio.projectDetached?'detached':'missingFolder')}</button>` : ''}
          ${decisionAction && decisionLabel ? `<div class="workspace-decision"><small class="muted">${safe(copy('Ближайшее решение'))}${date ? ' · '+safe(date) : ''}</small><br>
            <button class="text-button" type="button" ${decisionAction}>${safe(decisionLabel)}</button>
            ${next?.affectedTaskIds.length ? `<small class="muted">${safe(copy('Связанных задач'))} · ${next.affectedTaskIds.length}</small>` : ''}</div>` : ''}
          ${sprint?.goal || studio.brief ? `<p>${ui('goal')} · ${safe(sprint?.goal || studio.brief)}</p>` : ''}
          ${sprint?progressMark(members.filter(t=>t.stage==='done').length,members.length):''}
          ${studio.nextScheduleAt ? `<small>${ui('window')} · ${safe(new Date(studio.nextScheduleAt).toLocaleString(appLocale))}</small>` : ''}
          ${studio.quotaPause?.scope==='studio'?`<p class="muted">${safe(quotaPauseText(studio.quotaPause))}</p>`:''}
          <dl class="workspace-card-metrics">${metrics(count.running, count.open,studio.id)}</dl>
          ${latest ? `<div><small>${ui('latest')} · ${safe(new Date(latest.updatedAt).toLocaleString(appLocale))}</small> ${taskButton(latest)}</div>` : ''}
          ${count.open ? `<div><button type="button" class="action secondary" data-workspace-inbox="${id}" aria-label="${ui('inbox')} · ${name}">${ui('openInbox')}</button></div>` : ''}
          ${studio.root ? `<details class="workspace-path"><summary>${safe(copy('Папка проекта'))}</summary><p class="muted">${safe(studio.root)}</p></details>` : ''}
        </article>`;
      }).join('')}</div>${archive}</div>`;
}
