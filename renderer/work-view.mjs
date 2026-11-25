import {textFor} from './locale.mjs';
import {copy as uiCopy, onCopyLocale , getCopyLocale} from './copy.mjs';
import { roleNames } from './workshop.mjs';
import { coachTitle, pendingDependencies } from './coach-view.mjs';
import {progressMark,stageMark} from './presentation.mjs';
import { renderEvidence, renderRetrospective } from './legacy-view.mjs';
import { taskOwnerDecision, taskOwnerState, taskStage as stageOf } from './owner-facts.mjs';

const makeTabs = () => ({
  registry: uiCopy('Реестр задач'),
  board: uiCopy('Доска'), epics: uiCopy('Эпики и истории'), sprints: uiCopy('Спринты'), meetings: uiCopy('Встречи'), artifacts: uiCopy('Артефакты'), planning: uiCopy('Планирование'),
});
let tabs = makeTabs();
onCopyLocale(() => { tabs = makeTabs(); });
const makeStages = () => ({
  backlog: uiCopy('Бэклог'), ready: uiCopy('Готова к работе'), in_progress: uiCopy('В работе'), review: uiCopy('Ревью'),
  qa: uiCopy('Проверка'), done: uiCopy('Готово'), blocked: uiCopy('Заблокирована'),
});
let stages = makeStages();
onCopyLocale(() => { stages = makeStages(); });
const makePlanStatuses = () => ({
  draft: uiCopy('Черновик'), pending: uiCopy('Ждёт согласования'), approved: uiCopy('Согласован'), returned: uiCopy('На доработке'),
});
let planStatuses = makePlanStatuses();
onCopyLocale(() => { planStatuses = makePlanStatuses(); });
const makeSprintStatuses = () => ({ active: uiCopy('В работе'), completed: uiCopy('Завершён') });
let sprintStatuses = makeSprintStatuses();
onCopyLocale(() => { sprintStatuses = makeSprintStatuses(); });
const makeMeetingKinds = () => ({
  planning: uiCopy('Планирование'), retrospective: uiCopy('Ретроспектива'), review: uiCopy('Обзор результатов'), grooming: uiCopy('Разбор очереди задач'), topic: uiCopy('Обсуждение'),
});
let meetingKinds = makeMeetingKinds();
onCopyLocale(() => { meetingKinds = makeMeetingKinds(); });
const makeMeetingStages = () => ({ positions: uiCopy('Позиции участников'), facilitation: uiCopy('Обсуждение'), objections: uiCopy('Возражения'), owner_review: uiCopy('Ждёт решения владельца'), resolved: uiCopy('Решение сохранено'), held: uiCopy('Приостановлена') });
let meetingStages = makeMeetingStages();
onCopyLocale(() => { meetingStages = makeMeetingStages(); });
let meetingDate = new Intl.DateTimeFormat(getCopyLocale(), { dateStyle: 'medium' });
onCopyLocale(()=>{ meetingDate=new Intl.DateTimeFormat(getCopyLocale(), { dateStyle: 'medium' }); });
const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const safe = value => String(value ?? '').replace(/[&<>"']/g, character => entities[character]);
const lookup = (dictionary, key) => Object.hasOwn(dictionary, key) ? dictionary[key] : undefined;
const listed = value => Array.isArray(value) ? value : (value ? [value] : []);
const nameOf = (record, fallback) => record.title || record.name || fallback;
const groupByField = (records, field) => Map.groupBy(records, record => record[field]);
const action = (label, command, id = '') => `<button type="button" class="action secondary" data-${command}="${safe(id)}">${safe(label)}</button>`;

function empty(title, message) {
  return `<article class="work-empty"><h2>${title}</h2><p>${message}</p></article>`;
}

function textBlock(title, value) {
  return value ? `<div class="work-text"><strong>${title}</strong><p>${safe(value)}</p></div>` : '';
}

function bulletBlock(title, value) {
  const items = listed(value);
  return items.length
    ? `<div class="work-text"><strong>${title}</strong><ul>${items.map(item => `<li>${safe(item)}</li>`).join('')}</ul></div>`
    : '';
}

function taskLink(task, showStage = true) {
  return `<button type="button" class="work-task-link" data-task="${safe(task.id)}">
    <strong>${safe(nameOf(task, uiCopy('Задача без названия')))}</strong>
    ${task.kind === 'debt' ? uiCopy('<span class="debt-label">Улучшение</span>') : ''}
    ${showStage ? stageMark(stageOf(task),stages[stageOf(task)]) : ''}
  </button>`;
}

function dependencyLink(task,byTask) {
  const pending=pendingDependencies(task,byTask), first=pending.find(row=>!row.missing);
  if(!pending.length)return '';
  const label=uiCopy`Зависимости · ${pending.length}`;
  return `<button class="text-button work-wait-mark" type="button" data-task="${safe(first?.id??task.id)}" aria-label="${safe(label)}" title="${safe(label)}">
    <svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4"><path d="m6 6 2-2a2.5 2.5 0 0 1 4 4l-2 2M6 7 4 9a2.5 2.5 0 0 0 4 4l2-2m-4-1 4-4"/></svg>${pending.length}</button>`;
}

function linkedTasks(tasks, byTask) {
  if (!tasks.length) return '';
  return `<ul class="work-links work-compact-links">${tasks.map(task => `<li>
      ${taskLink(task)}
      ${task.artifactPath ? `<small class="work-muted">${safe(task.artifactPath)}</small>` : ''}
      ${dependencyLink(task,byTask)}
    </li>`).join('')}</ul>`;
}

export function boardRows(tasks, studio, sprints, {showEmpty, allSprints, query='', stage='', sprintId='', agentId='', decision=false, inbox=[]}={}) {
  const allTasks = tasks;
  const byTask = new Map(allTasks.map(task => [task.id, task]));
  const active=sprints.findLast(row=>row.status==='active');
  const explicitSearch = Boolean(query.trim() || stage || sprintId || agentId || decision);
  if (active && !allSprints && !explicitSearch) tasks = tasks.filter(t=>t.sprintId===active.id||active.taskIds?.includes(t.id));
  const { matches, owners } = taskSearch(studio,sprints,{query,stage,sprintId,agentId,decision,inbox});
  tasks = tasks.filter(matches);
  const replaced = tasks.filter(task => task.stage === 'replaced');
  const byStage = Map.groupBy(tasks.filter(task => task.stage !== 'replaced'), stageOf);
  const control = action(showEmpty?uiCopy('Скрыть пустые этапы'):uiCopy('Показать пустые этапы'),'board-empty','toggle')+
    (active && !explicitSearch ? action(allSprints?uiCopy('Текущий спринт'):uiCopy('Все задачи'),'board-scope','toggle'):'');
  return uiCopy`<div class="actions">${control}</div>
  ${!tasks.length&&!showEmpty ? explicitSearch
    ? `<p class="work-muted" role="status">${uiCopy('По этим условиям задач нет.')}</p>`
    : empty(uiCopy('На доске пока пусто'),uiCopy('Задачи появятся здесь после согласования плана или создания вручную.')) : ''}
  <div class="work-board" role="region" aria-label="Доска задач" tabindex="0">
    ${Object.entries(stages).filter(([stage])=>showEmpty||byStage.has(stage)).map(([stage, label]) => {
      const lane = byStage.get(stage) ?? [];
      return `<section class="work-lane" data-stage="${stage}" aria-labelledby="work-stage-${stage}">
        <header><h2 id="work-stage-${stage}">${stageMark(stage,label)}</h2><span>${lane.length}</span></header>
        <ul>${lane.map(task => {
          const owner = owners.get(task.agentId) ?? (!task.agentId ? studio.director?.name || uiCopy('Директор') : '');
          const state = taskOwnerState(task,{inbox,tasks:allTasks});
          const reason = state.label !== label ? `<small class="work-muted">${safe(state.label)}</small>` : '';
          return `<li class="work-task"${['train', 'debt'].includes(task.kind) ? ` data-task-kind="${task.kind}"` : ''}>
            ${taskLink(task, false)}
            ${reason}
            <div class="work-ticket-meta"><small class="registry-meta">${safe(task.legacyId||task.id?.slice(0,8))}</small>${dependencyLink(task,byTask)||`<small class="work-owner">${safe(owner)}</small>`}</div>
          </li>`;
        }).join('')}</ul>
      </section>`;
    }).join('')}
  </div>${replaced.length ? uiCopy`<details class="work-record"><summary>Заменённые задачи · ${replaced.length}</summary>${linkedTasks(replaced, byTask)}</details>` : ''}`;
}

function epicView(epics, stories, tasks, byTask, expandedEpics, expandedRecords) {
  const storiesByEpic = groupByField(stories, 'epicId');
  const tasksByStory = groupByField(tasks, 'storyId');
  const tasksByEpic = groupByField(tasks, 'epicId');
  const epicIds = new Set(epics.map(epic => epic.id));
  const storyIds = new Set(stories.map(story => story.id));
  const orphanStories = stories.filter(story => !epicIds.has(story.epicId));
  const orphanTasks = tasks.filter(task => !epicIds.has(task.epicId) && !storyIds.has(task.storyId));
  if (!epics.length && !stories.length && !tasks.length) {
    return empty(uiCopy('Эпиков и историй пока нет'), uiCopy('Они появятся здесь после согласования плана.'));
  }

  const showStories = entries => entries.map(story => {
    const children=tasksByStory.get(story.id)??[], key='story:'+story.id;
    return uiCopy`<details class="work-story work-fold" data-work-record="${safe(key)}"${expandedRecords.has(key)?' open':''}>
      <summary><span class="work-muted">История</span> <button type="button" class="text-button" data-owner-story="${safe(story.id)}">${safe(nameOf(story,uiCopy('История без названия')))}</button>
      ${progressMark(children.filter(t=>stageOf(t)==='done').length,children.length)}</summary>
      ${linkedTasks(children,byTask)}
    </details>`;
  }).join('');

  return `<div class="work-records">
    ${epics.toSorted((a, b) => (b.priority ?? 0) - (a.priority ?? 0)).map(epic => {
      const epicStories = storiesByEpic.get(epic.id) ?? [];
      const directTasks = (tasksByEpic.get(epic.id) ?? []).filter(task => !storyIds.has(task.storyId));
      const taskCount = epicStories.reduce((count, story) => count + (tasksByStory.get(story.id)?.length ?? 0), directTasks.length);
      return uiCopy`<details class="work-record work-epic" name="studio-epics" data-epic-section="${safe(epic.id)}"${expandedEpics.has(epic.id) ? ' open' : ''}>
        <summary>
          <span class="work-muted">Эпик</span>
          <strong>${safe(epic.kind === 'debt' && nameOf(epic) === 'Техдолг' ? uiCopy('Улучшения проекта') : nameOf(epic, uiCopy('Эпик без названия')))}</strong>
          <span class="work-muted">Историй: ${epicStories.length} · Задач: ${taskCount}</span>
        </summary>
        <div class="work-epic-body">
          ${textBlock(uiCopy('Цель'), epic.goal || epic.description)}
          <p class="work-muted">Приоритет · ${safe(epic.priority ?? uiCopy('не задан'))}</p>
          <div class="actions">${action(uiCopy('Изменить приоритет'), 'epic-priority', epic.id)}</div>
          ${showStories(epicStories)}
          ${linkedTasks(directTasks, byTask)}
        </div>
      </details>`;
    }).join('')}
    ${orphanStories.length ? uiCopy`<article class="work-record"><h2>Истории без эпика</h2>${showStories(orphanStories)}</article>` : ''}
    ${orphanTasks.length ? uiCopy`<article class="work-record"><h2>Задачи без эпика и истории</h2>${linkedTasks(orphanTasks, byTask)}</article>` : ''}
  </div>`;
}

function planButton(plan) {
  const title = safe(nameOf(plan, uiCopy('План спринта')));
  return uiCopy`<button type="button" class="work-plan-button" data-plan="${safe(plan.id)}" aria-label="Открыть план «${title}»">Открыть план</button>`;
}

function sprintView(studio, sprints, plans, tasks, byTask, expandedRecords) {
  const plansById = new Map(plans.map(plan => [plan.id, plan]));
  const plansBySprint = new Map(plans.filter(plan => plan.sprintId).map(plan => [plan.sprintId, plan]));
  const tasksBySprint = groupByField(tasks, 'sprintId');
  const attachedPlans = new Set();
  const entries = sprints.map(sprint => {
    const plan = plansById.get(sprint.planId) ?? plansBySprint.get(sprint.id);
    if (plan) attachedPlans.add(plan.id);
    const memberIds = new Set([
      ...(tasksBySprint.get(sprint.id) ?? []).map(task => task.id),
      ...listed(sprint.taskIds),
    ]);
    const members = [...memberIds].map(id => byTask.get(id)).filter(Boolean);
    const done = members.filter(task => stageOf(task) === 'done').length;
    const status = lookup(planStatuses, plan?.status ?? sprint.approvalStatus);
    const lifecycle = lookup(sprintStatuses, sprint.status);
    const progress = uiCopy`Задач готово ${done} из ${members.length}`;
    const key='sprint:'+sprint.id;
    return `<details class="work-record work-fold" data-work-record="${safe(key)}"${expandedRecords.has(key)?' open':''}>
      <summary><strong>${safe(nameOf(sprint, plan?.title || uiCopy('Спринт без названия')))}</strong>
        <div class="work-record-statuses">
          ${sprint.debtSprint || plan?.debtSprint ? uiCopy('<span class="debt-label">Спринт улучшений</span>') : ''}
          ${lifecycle ? `<span class="work-muted">${lifecycle}</span>` : ''}
          ${status ? `<span class="work-approval" data-plan-status="${safe(plan?.status ?? sprint.approvalStatus)}">${status}</span>` : ''}
        </div>
        ${progressMark(done,members.length)}
      </summary>
      ${textBlock(uiCopy('Цель'), sprint.goal || plan?.goal)}
      ${members.length ? `<div class="work-progress">
        <p aria-hidden="true">${progress}</p>
        <progress max="${members.length}" value="${done}" aria-label="${progress}"></progress>
      </div>` : uiCopy('<p class="work-muted">В спринте пока нет задач.</p>')}
      ${linkedTasks(members, byTask)}
      ${textBlock(uiCopy('Итоги'), sprint.outcome || sprint.summary)}
      ${renderRetrospective(sprint.retrospective)}
      ${sprint.carryovers?.length ? uiCopy`<div class="work-text"><strong>Переносы</strong><ul>${sprint.carryovers.map(row => `<li>
        ${byTask.get(row.taskId) ? taskLink(byTask.get(row.taskId), false) : safe(row.taskId)} · ${safe(row.reason)}</li>`).join('')}</ul></div>` : ''}
      <div class="actions">${plan ? planButton(plan) : ''}${sprint.status === 'active' ? action(uiCopy('Закрыть спринт'), 'close-sprint', sprint.id) : ''}</div>
    </details>`;
  });
  const upcoming = plans.filter(plan => !attachedPlans.has(plan.id) && (plan.kind === 'sprint' || plan.status !== 'approved'));
  const closed=sprints.filter(s=>s.status==='completed');
  const ui=k=>textFor(getCopyLocale(),k);
  const comparison=closed.length>1 ? `<details class="work-record"><summary>${ui('compare')}</summary>
    <table class="owner-table"><thead><tr><th>${uiCopy('Спринт')}</th><th>${ui('completedOfPlanned')}</th><th>${ui('carried')}</th><th>${ui('method')}</th></tr></thead><tbody>${closed.map(s=>{
      const facts=s.retrospective;
      return `<tr><td>${action(s.title,'owner-sprint',s.id)}<br><small>${safe(s.closedAt?.slice(0,10))}</small></td>
        <td>${safe(facts?.accepted?.count??'—')} / ${safe(facts?.planned?.count??'—')}</td><td>${safe(facts?.carried?.count??'—')}</td><td>${safe(facts?.methodVersion??'—')}</td></tr>`;
    }).join('')}</tbody></table></details>` : '';
  if (!entries.length && !upcoming.length) return empty(uiCopy('Спринтов пока нет'), uiCopy('Здесь появятся планы спринтов, состав задач и результаты.'));
  const canPlanNext = sprints.some(sprint => sprint.status === 'completed') &&
    !sprints.some(sprint => sprint.status === 'active') &&
    !upcoming.some(plan => ['draft', 'pending'].includes(plan.status)) &&
    !['draft', 'planning', 'awaiting-approval'].includes(studio.lifecycle);
  return `<div class="work-records">
    ${canPlanNext ? `<div class="actions">${action(uiCopy('Запланировать следующий спринт'), 'open', 'next-sprint')}</div>` : ''}
    ${upcoming.map(plan => `<article class="work-record">
      <header><h2>${safe(nameOf(plan, uiCopy('План спринта')))}</h2>
        <div class="work-record-statuses">
          ${plan.debtSprint ? uiCopy('<span class="debt-label">Спринт улучшений</span>') : ''}
          <span class="work-approval" data-plan-status="${safe(plan.status)}">${safe(lookup(planStatuses, plan.status) ?? plan.status)}</span>
        </div>
      </header>
      ${textBlock(uiCopy('Цель'), plan.goal)}
      ${planButton(plan)}
    </article>`).join('')}
    ${comparison}${entries.join('')}
  </div>`;
}

function meetingsView(meetings, byTask, sprints, expandedRecords) {
  const controls = `<div class="actions">${action(uiCopy('Назначить встречу'), 'open', 'meeting')}</div>`;
  if (!meetings.length) return controls + empty(uiCopy('Встреч пока не было'), uiCopy('Здесь сохраняются позиции участников, решения и задачи по итогам встречи.'));
  const bySprint = new Map(sprints.map(sprint => [sprint.id, sprint]));
  return controls + `<div class="work-records">${meetings.map(meeting => {
    const kind = lookup(meetingKinds, meeting.kind ?? meeting.type);
    const sprint = bySprint.get(meeting.sprintId);
    const date = new Date(meeting.createdAt);
    const time = Number.isFinite(date.getTime())
      ? `<time datetime="${date.toISOString()}">${meetingDate.format(date)}</time>`
      : '';
    const related = listed(meeting.taskIds).map(id => byTask.get(id)).filter(Boolean);
    const key='meeting:'+String(meeting.id??meeting.title??'');
    return `<details class="work-record work-fold" data-work-record="${safe(key)}"${expandedRecords.has(key)?' open':''}>
      <summary><strong>${safe(nameOf(meeting, kind || uiCopy('Встреча')))}</strong>
        ${time ? `<span class="work-muted">${time}</span>` : ''}
        ${meeting.stage ? stageMark(meeting.stage==='resolved'?'done':'review',meetingStages[meeting.stage]??meeting.stage):''}
      </summary>
      ${meeting.stage ? uiCopy`<p class="work-muted">${safe(meetingStages[meeting.stage] ?? meeting.stage)} · Версия ${safe(meeting.version)}</p>` : ''}
      ${sprint ? `<p class="work-muted">${safe(nameOf(sprint, uiCopy('Спринт')))}</p>` : ''}
      ${textBlock(uiCopy('Итог'), meeting.outcome || meeting.summary)}
      ${bulletBlock(uiCopy('Решения'), listed(meeting.decisions).map(decision => decision.text ?? decision))}
      ${linkedTasks(related, byTask)}
      ${meeting.id ? action(uiCopy('Открыть встречу'), 'meeting-detail', meeting.id) : ''}
    </details>`;
  }).join('')}</div>`;
}

export const publishedPaths = plan => (plan.publishedFiles ?? [])
  .map(file => typeof file === 'string' ? file : file?.path)
  .filter(path => typeof path === 'string' && path.length > 0);

function artifactsView(tasks, plans, evidence, studio, sprints) {
  const ui = key=>textFor(getCopyLocale(),key);
  const info=t=>[t?.title,t?.id,t?.sprintId,sprints.find(s=>s.id===t?.sprintId)?.title,studio.agents?.find(a=>a.id===t?.agentId)?.name].filter(Boolean);
  const attrs=(key,at)=>`data-file-key="${safe(key.filter(Boolean).join(' '))}" data-file-date="${safe(at?.slice(0,10))}"`;
  const fileButtons=(id,path,isPlan)=>['revealArtifact','copyArtifactPath'].map((cmd,i)=>
    `<button type="button" class="text-button" data-file-action="${cmd}" data-file-source="${isPlan?'plan':'task'}" data-file-id="${safe(id)}" data-file-path="${safe(path)}">${uiCopy(i ? 'Копировать путь' : 'Показать в папке')}</button>`).join(' ');
  const taskResults = tasks.filter(task => task.artifactPath || task.artifact || task.summary || task.gitDelivery?.artifactPaths?.length)
    .toSorted((a,b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));
  const planResults = plans.map(plan => ({ plan, paths: [...new Set(publishedPaths(plan))] }))
    .filter(({ paths }) => paths.length);
  if (!taskResults.length && !planResults.length && !evidence.length) {
    return empty(uiCopy('Артефактов пока нет'), uiCopy('Здесь появятся файлы планов и результаты задач.'));
  }

  return `<div class="work-records">
    <div class="actions"><input data-file-query aria-label="${ui('findFile')}" placeholder="${ui('findFile')}"><label>${ui('periodFrom')} <input type="date" data-file-from></label><label>${ui('periodTo')} <input type="date" data-file-to></label></div>
    <p class="work-muted" role="status" data-file-no-matches hidden>${uiCopy('Файлов по этим условиям нет.')}</p>
    ${taskResults.length ? uiCopy`<section class="work-record" data-file-section>
      <h2>Результаты задач</h2>
      <ul class="work-links">${taskResults.map(task => `<li data-report-task="${safe(task.id)}" ${attrs([...info(task),task.artifactPath,...(task.artifactVersions??[]),...(task.gitDelivery?.artifactPaths??[])],task.updatedAt)}>
        ${taskLink(task, false)} <small>${safe(info(task).slice(2).join(" · "))} ${safe(task.updatedAt?.slice(0,10))}</small>
        ${task.artifactPath ? `<button type="button" class="text-button work-file-link" data-artifact="${safe(task.id)}">${safe(task.artifactPath)}</button>` : uiCopy('<span class="work-muted">Отчёт</span>')}
        ${task.artifactPath ? fileButtons(task.id,task.artifactPath,false) : ''}
        ${(task.artifactVersions??[]).filter(p=>p!==task.artifactPath).map(p=>`<div><button type="button" class="text-button" data-file-action="openArtifact" data-file-source="task" data-file-id="${safe(task.id)}" data-file-path="${safe(p)}">${safe(p)}</button> ${fileButtons(task.id,p,false)}</div>`).join('')}
        ${(task.gitDelivery?.artifactPaths??[]).map(path=>`<div><button type="button" class="text-button work-file-link" data-report-link="${safe(encodeURI(path))}">${safe(path)}</button></div>`).join('')}
      </li>`).join('')}</ul>
    </section>` : ''}
    ${planResults.length ? uiCopy`<section class="work-record" data-file-section>
      <h2>Файлы планов</h2>
      ${planResults.map(({ plan, paths }) => `<section class="work-story">
        <h3>${safe(nameOf(plan, uiCopy('План без названия')))}</h3>
        <ul class="work-artifact-files">${paths.map(path => `<li ${attrs([plan.title,plan.id,path],plan.createdAt)}>
          <button type="button" class="text-button work-file-link" data-plan-file="${safe(path)}" data-plan-id="${safe(plan.id)}">${safe(path)}</button> ${fileButtons(plan.id,path,true)}
        </li>`).join('')}</ul>
      </section>`).join('')}
    </section>` : ''}
    ${evidence.length ? uiCopy`<details class="work-record" data-artifact-evidence data-file-section>
      <summary>Журналы и доказательства · ${evidence.length}</summary>
      ${renderEvidence(evidence, {heading:false, attributes:e=>attrs([e.name,e.sourcePath,e.kind,...info(tasks.find(t=>t.id===e.taskId))],e.recordedAt)})}
    </details>` : ''}
  </div>`;
}

function planningView(studio, phases, tasks) {
  const grooming = studio.grooming;
  const backlog = tasks.filter(task => !task.sprintId && task.kind !== 'train' && !['done', 'replaced'].includes(task.stage))
    .toSorted((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  return uiCopy`<div class="work-records">
    <section class="work-record"><header><h2>Бэклог</h2>${action(uiCopy('Добавить в бэклог'), 'open', 'backlog-task')}</header>
      <p class="work-muted">Версия ${safe(studio.backlogVersion ?? 0)} · Задач: ${backlog.length}</p>
      ${backlog.length ? `<ul class="work-links">${backlog.map(task => uiCopy`<li>
        ${taskLink(task)}
        <p class="work-muted">Приоритет: ${safe(task.priority ?? uiCopy('не задан'))}${task.points != null ? uiCopy` · Баллы: ${safe(task.points)}` : ''}</p>
        ${task.status !== 'running' ? `<div class="actions">${action(uiCopy('Изменить'), 'backlog-edit', task.id)}${backlog.length > 1 ? action(uiCopy('Заменить'), 'backlog-replace', task.id) : ''}</div>` : ''}
      </li>`).join('')}</ul>` : uiCopy('<p class="work-muted">Здесь будут задачи вне спринта.</p>')}
    </section>
    <section class="work-record"><header><h2>Подготовка задач к спринту</h2>${grooming?.status === 'open' ? action(uiCopy('Завершить разбор'), 'resolve-grooming', grooming.id) : action(uiCopy('Разобрать очередь'), 'open', 'request-grooming')}</header>
      ${grooming ? uiCopy`<p class="work-muted">${grooming.status === 'open' ? uiCopy('Открыт') : uiCopy('Завершён')} · Готовых задач: ${safe(grooming.readyTasks)} · Порог: ${safe(grooming.threshold)}</p>`
        : uiCopy('<p class="work-muted">Директор уточняет карточки и зависимости, чтобы подготовить задачи к следующему спринту.</p>')}
      ${grooming?.result ? textBlock(uiCopy('Что изменилось'), grooming.result) : ''}
      ${grooming?.error ? textBlock(uiCopy('Ошибка подготовки'), grooming.error) : ''}</section>
    <section class="work-record"><header><h2>Фазы проекта</h2>${action(uiCopy('Добавить фазу'), 'open', 'phase')}</header>
      ${phases.length ? phases.map(phase => `<article class="work-story"><h3>${safe(phase.title)}</h3>
        ${textBlock(uiCopy('Цель'), phase.goal)}${bulletBlock(uiCopy('Условия завершения'), (phase.criteria ?? []).map(row => row.description))}
        <p class="work-muted">${phase.status === 'completed' ? uiCopy('Завершена') : phase.transition?.status === 'pending' ? uiCopy('Ждёт согласования') : uiCopy('В работе')}</p>
        ${phase.status !== 'completed' ? `<div class="actions">${phase.transition?.status === 'pending' ? action(uiCopy('Решение о завершении'), 'phase-transition', phase.id) :
          action(uiCopy('Изменить'), 'phase-edit', phase.id) + action(uiCopy('Предложить завершение'), 'phase-transition', phase.id)}</div>` : ''}
      </article>`).join('') : uiCopy('<p class="work-muted">Фазы объединяют эпики и спринты вокруг одной цели.</p>')}</section>
  </div>`;
}

function taskSearch(studio, sprints, {query='',stage='',sprintId='',agentId='',decision=false,inbox=[]}={}) {
  const owners = new Map((studio.agents ?? []).map(a => [a.id, a.systemRole==='coach' ? coachTitle : a.name || a.roleTitle || lookup(roleNames,a.role) || a.role]));
  const sprintNames = new Map(sprints.map(s => [s.id, s.title]));
  const needle = query.trim().toLocaleLowerCase();
  return {owners,sprintNames,matches(task) {
    if (sprintId && task.sprintId !== sprintId) return false;
    if (agentId && (agentId==='director' ? Boolean(task.agentId) : task.agentId !== agentId)) return false;
    if (stage && stageOf(task) !== stage) return false;
    if (decision && !taskOwnerDecision(task,inbox)) return false;
    return [task.title, task.id, task.legacyId, owners.get(task.agentId) ?? studio.director?.name ?? uiCopy('Директор'),
      sprintNames.get(task.sprintId), task.prompt].join(' ').toLocaleLowerCase().includes(needle);
  }};
}

export function registerRows(tasks, studio, sprints, query, stage, sprintId='', agentId='', {decision=false,inbox=[]}={}) {
  const {matches,owners,sprintNames} = taskSearch(studio,sprints,{query,stage,sprintId,agentId,decision,inbox});
  const byTask=new Map(tasks.map(task=>[task.id,task]));
  const rows = tasks.filter(matches).map(task => {
    const owner = owners.get(task.agentId) || (task.agentId ? uiCopy('Неизвестный агент') : uiCopy('Директор'));
    const sprint = sprintNames.get(task.sprintId) || '';
    const state = taskOwnerState(task,{inbox,tasks});
    return `<tr><td><div class="registry-task">${taskLink(task, false)}<small class="registry-meta">${safe(task.legacyId || task.id?.slice(0,8))}${task.priority!=null ? ' · P'+safe(task.priority) : ''}</small></div></td><td>${safe(owner)}</td><td>${safe(sprint || '—')}</td><td>${stageMark(state.stage,state.label)}${dependencyLink(task,byTask)}${task.updatedAt ? `<time class="registry-meta" datetime="${safe(task.updatedAt)}">${safe(task.updatedAt.slice(0,10))}</time>` : ''}</td></tr>`;
  });
  return rows.join('') || uiCopy('<tr><td colspan="4">По этим условиям задач нет.</td></tr>');
}

export function renderWork({ studio = {}, tasks = [], epics = [], stories = [], sprints = [], meetings = [], plans = [], phases = [], evidence = [], inbox=[], tab = 'board', expandedEpics = new Set(), expandedRecords=new Set(), boardShowEmpty=false, boardAllSprints=false, registryQuery = '', registryStage = '', registrySprint = '', registryOwner = '', registryDecision=false } = {}) {
  const filterSelect=(name,label,items,selected)=>uiCopy`<label class="registry-filter">${label}<select data-registry-${name}><option value="">Все</option>${items.map(i=>`<option value="${safe(i.id)}" ${i.id===selected?'selected':''}>${safe(i.title || i.name || i.roleTitle || i.role || i.id)}</option>`).join('')}</select></label>`;
  const selected = lookup(tabs, tab) ? tab : 'board';
  const byTask = new Map(tasks.map(task => [task.id, task]));
  const filters = uiCopy`<div class="actions"><input type="search" data-registry-query aria-label="Найти задачу" placeholder="Название, ID, агент, спринт" value="${safe(registryQuery)}"><select data-registry-stage aria-label="Этап"><option value="">Все этапы</option>${Object.entries({...stages, replaced: uiCopy('Заменена')}).map(([key,label]) => `<option value="${key}" ${registryStage === key ? 'selected' : ''}>${label}</option>`).join('')}</select>${filterSelect('sprint',uiCopy('Спринт'),sprints,registrySprint)}${filterSelect('owner',uiCopy('Исполнитель'),[{id:'director',name:uiCopy('Директор')},...(studio.agents ?? [])],registryOwner)}<label class="checkbox-field"><input type="checkbox" data-registry-decision${registryDecision?' checked':''}> <span>Требуется моё решение</span></label></div>`;
  const views = {
    registry: () => uiCopy`<section>${filters}<div class="registry-scroll"><table class="registry"><thead><tr><th>Задача</th><th>Ответственный</th><th>Спринт</th><th>Этап</th></tr></thead><tbody data-registry-rows>${registerRows(tasks, studio, sprints, registryQuery, registryStage, registrySprint, registryOwner,{decision:registryDecision,inbox})}</tbody></table></div></section>`,
    board: () => `${filters}<div data-board-rows>${boardRows(tasks,studio,sprints,{showEmpty:boardShowEmpty,allSprints:boardAllSprints,query:registryQuery,stage:registryStage,sprintId:registrySprint,agentId:registryOwner,decision:registryDecision,inbox})}</div>`,
    epics: () => epicView(epics, stories, tasks, byTask, expandedEpics,expandedRecords),
    sprints: () => sprintView(studio, sprints, plans, tasks, byTask,expandedRecords),
    meetings: () => meetingsView(meetings, byTask, sprints,expandedRecords),
    artifacts: () => artifactsView(tasks, plans, evidence,studio,sprints),
    planning: () => planningView(studio, phases, tasks),
  };
  return uiCopy`<section class="work-view" aria-label="Работа студии">
    <div class="work-tabs" role="group" aria-label="Разделы работы">
      ${Object.entries(tabs).map(([id, label]) => `<button type="button" data-work-tab="${id}" aria-pressed="${id === selected}">${label}</button>`).join('')}
    </div>
    ${views[selected]()}
  </section>`;
}
