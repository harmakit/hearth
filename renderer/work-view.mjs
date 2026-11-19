import { roleNames } from './workshop.mjs';
import { coachTitle, renderBoardTraining } from './coach-view.mjs';
import { renderEvidence, renderRetrospective } from './legacy-view.mjs';

const tabs = {
  registry: 'Реестр задач',
  board: 'Доска', epics: 'Эпики и истории', sprints: 'Спринты', meetings: 'Встречи', artifacts: 'Артефакты', planning: 'Планирование',
};
const stages = {
  backlog: 'Бэклог', ready: 'Готова к работе', in_progress: 'В работе', review: 'Ревью',
  qa: 'Проверка', done: 'Готово', blocked: 'Заблокирована',
};
const legacyStages = {
  queued: 'ready', scheduled: 'ready', running: 'in_progress', waiting: 'blocked',
  completed: 'done', failed: 'blocked', interrupted: 'blocked', cancelled: 'blocked',
};
const attempts = {
  queued: 'В очереди', scheduled: 'В очереди', running: 'Выполняется', waiting: 'Ждёт ответа',
  completed: 'Завершена', failed: 'Ошибка', interrupted: 'Прервана', cancelled: 'Отменена',
};
const planStatuses = {
  draft: 'Черновик', pending: 'Ждёт согласования', approved: 'Согласован', returned: 'На доработке',
};
const sprintStatuses = { active: 'В работе', completed: 'Завершён' };
const meetingKinds = {
  planning: 'Планирование', retrospective: 'Ретроспектива', review: 'Обзор результатов', grooming: 'Разбор очереди задач', topic: 'Обсуждение',
};
const meetingStages = { positions: 'Позиции участников', facilitation: 'Обсуждение', objections: 'Возражения', owner_review: 'Ждёт решения владельца', resolved: 'Решение сохранено', held: 'Приостановлена' };
const meetingDate = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium' });
const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const safe = value => String(value ?? '').replace(/[&<>"']/g, character => entities[character]);
const lookup = (dictionary, key) => Object.hasOwn(dictionary, key) ? dictionary[key] : undefined;
const stageOf = task => lookup(stages, task.stage) ? task.stage : (lookup(legacyStages, task.status) ?? 'backlog');
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
    <strong>${safe(nameOf(task, 'Задача без названия'))}</strong>
    ${task.kind === 'debt' ? '<span class="debt-label">Улучшение</span>' : ''}
    ${showStage ? `<span>${stages[stageOf(task)]}</span>` : ''}
  </button>`;
}

function linkedTasks(tasks, byTask) {
  if (!tasks.length) return '';
  return `<ul class="work-links">${tasks.map(task => {
    const dependencies = listed(task.dependencies);
    return `<li>
      ${taskLink(task)}
      ${task.artifactPath ? `<p class="work-file">${safe(task.artifactPath)}</p>` : ''}
      ${bulletBlock('Критерии приёмки', task.criteria)}
      ${dependencies.length ? `<div class="work-dependencies"><span>Зависимости</span>
        <ul>${dependencies.map(id => {
          const dependency = byTask.get(id);
          return `<li>${dependency ? taskLink(dependency) : `<span>${safe(id)}</span>`}</li>`;
        }).join('')}</ul>
      </div>` : ''}
    </li>`;
  }).join('')}</ul>`;
}

function board(tasks, studio, byTask) {
  const replaced = tasks.filter(task => task.stage === 'replaced');
  if (!tasks.length) return empty('На доске пока пусто', 'Задачи появятся здесь после согласования плана или создания вручную.');
  const byStage = Map.groupBy(tasks.filter(task => task.stage !== 'replaced'), stageOf);
  const agents = new Map((studio.agents ?? []).map(agent => [agent.id, agent]));
  return `<div class="work-board" role="region" aria-label="Доска задач" tabindex="0">
    ${Object.entries(stages).map(([stage, label]) => {
      const lane = byStage.get(stage) ?? [];
      return `<section class="work-lane" data-stage="${stage}" aria-labelledby="work-stage-${stage}">
        <header><h2 id="work-stage-${stage}">${label}</h2><span>${lane.length}</span></header>
        <ul>${lane.map(task => {
          const agent = agents.get(task.agentId);
          const owner = agent ? (agent.systemRole === 'coach' ? coachTitle : agent.name || lookup(roleNames, agent.role)) :
            (task.agentId ? '' : (studio.director?.name || 'Директор'));
          const attempt = lookup(attempts, task.status) ?? task.status;
          return `<li class="work-task"${['train', 'debt'].includes(task.kind) ? ` data-task-kind="${task.kind}"` : ''}>
            ${taskLink(task, false)}
            ${owner ? `<p class="work-owner">${safe(owner)}</p>` : ''}
            ${task.priority != null ? `<p class="work-owner">Приоритет: ${safe(task.priority)}</p>` : ''}
            ${task.gitDelivery ? '<p class="work-owner">Git-доставка</p>' : ''}
            ${renderBoardTraining(task, agents, byTask)}
            ${attempt ? `<p class="work-attempt" data-attempt="${safe(task.status)}"><span>Попытка</span> ${safe(attempt)}</p>` : ''}
          </li>`;
        }).join('')}</ul>
      </section>`;
    }).join('')}
  </div>${replaced.length ? `<details class="work-record"><summary>Заменённые задачи · ${replaced.length}</summary>${linkedTasks(replaced, byTask)}</details>` : ''}`;
}

function epicView(epics, stories, tasks, byTask, expandedEpics) {
  const storiesByEpic = groupByField(stories, 'epicId');
  const tasksByStory = groupByField(tasks, 'storyId');
  const tasksByEpic = groupByField(tasks, 'epicId');
  const epicIds = new Set(epics.map(epic => epic.id));
  const storyIds = new Set(stories.map(story => story.id));
  const orphanStories = stories.filter(story => !epicIds.has(story.epicId));
  const orphanTasks = tasks.filter(task => !epicIds.has(task.epicId) && !storyIds.has(task.storyId));
  if (!epics.length && !stories.length && !tasks.length) {
    return empty('Эпиков и историй пока нет', 'Они появятся здесь после согласования плана.');
  }

  const showStories = entries => entries.map(story => `<section class="work-story">
    <h3>${safe(nameOf(story, 'История без названия'))}</h3>
    ${textBlock('Цель', story.goal || story.description)}
    ${bulletBlock('Критерии приёмки', story.acceptance ?? story.criteria ?? story.acceptanceCriteria)}
    ${linkedTasks(tasksByStory.get(story.id) ?? [], byTask)}
  </section>`).join('');

  return `<div class="work-records">
    ${epics.toSorted((a, b) => (b.priority ?? 0) - (a.priority ?? 0)).map(epic => {
      const epicStories = storiesByEpic.get(epic.id) ?? [];
      const directTasks = (tasksByEpic.get(epic.id) ?? []).filter(task => !storyIds.has(task.storyId));
      const taskCount = epicStories.reduce((count, story) => count + (tasksByStory.get(story.id)?.length ?? 0), directTasks.length);
      return `<details class="work-record work-epic" name="studio-epics" data-epic-section="${safe(epic.id)}"${expandedEpics.has(epic.id) ? ' open' : ''}>
        <summary>
          <strong>${safe(epic.kind === 'debt' && nameOf(epic) === 'Техдолг' ? 'Улучшения проекта' : nameOf(epic, 'Эпик без названия'))}</strong>
          <span class="work-muted">Историй: ${epicStories.length} · Задач: ${taskCount}</span>
        </summary>
        <div class="work-epic-body">
          ${textBlock('Цель', epic.goal || epic.description)}
          <p class="work-muted">Приоритет · ${safe(epic.priority ?? 'не задан')}</p>
          <div class="actions">${action('Изменить приоритет', 'epic-priority', epic.id)}</div>
          ${showStories(epicStories)}
          ${linkedTasks(directTasks, byTask)}
        </div>
      </details>`;
    }).join('')}
    ${orphanStories.length ? `<article class="work-record"><h2>Истории без эпика</h2>${showStories(orphanStories)}</article>` : ''}
    ${orphanTasks.length ? `<article class="work-record"><h2>Задачи без эпика и истории</h2>${linkedTasks(orphanTasks, byTask)}</article>` : ''}
  </div>`;
}

function planButton(plan) {
  const title = safe(nameOf(plan, 'План спринта'));
  return `<button type="button" class="work-plan-button" data-plan="${safe(plan.id)}" aria-label="Открыть план «${title}»">Открыть план</button>`;
}

function sprintView(studio, sprints, plans, tasks, byTask) {
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
    const progress = `Задач готово ${done} из ${members.length}`;
    return `<article class="work-record">
      <header><h2>${safe(nameOf(sprint, plan?.title || 'Спринт без названия'))}</h2>
        <div class="work-record-statuses">
          ${sprint.debtSprint || plan?.debtSprint ? '<span class="debt-label">Спринт улучшений</span>' : ''}
          ${lifecycle ? `<span class="work-muted">${lifecycle}</span>` : ''}
          ${status ? `<span class="work-approval" data-plan-status="${safe(plan?.status ?? sprint.approvalStatus)}">${status}</span>` : ''}
        </div>
      </header>
      ${textBlock('Цель', sprint.goal || plan?.goal)}
      ${members.length ? `<div class="work-progress">
        <p aria-hidden="true">${progress}</p>
        <progress max="${members.length}" value="${done}" aria-label="${progress}"></progress>
      </div>` : '<p class="work-muted">В спринте пока нет задач.</p>'}
      ${linkedTasks(members, byTask)}
      ${textBlock('Итоги', sprint.outcome || sprint.summary)}
      ${renderRetrospective(sprint.retrospective)}
      ${sprint.carryovers?.length ? `<div class="work-text"><strong>Переносы</strong><ul>${sprint.carryovers.map(row => `<li>
        ${byTask.get(row.taskId) ? taskLink(byTask.get(row.taskId), false) : safe(row.taskId)} · ${safe(row.reason)}</li>`).join('')}</ul></div>` : ''}
      <div class="actions">${plan ? planButton(plan) : ''}${sprint.status === 'active' ? action('Закрыть спринт', 'close-sprint', sprint.id) : ''}</div>
    </article>`;
  });
  const upcoming = plans.filter(plan => !attachedPlans.has(plan.id) && (plan.kind === 'sprint' || plan.status !== 'approved'));
  if (!entries.length && !upcoming.length) return empty('Спринтов пока нет', 'Здесь появятся планы спринтов, состав задач и результаты.');
  const canPlanNext = sprints.some(sprint => sprint.status === 'completed') &&
    !sprints.some(sprint => sprint.status === 'active') &&
    !upcoming.some(plan => ['draft', 'pending'].includes(plan.status)) &&
    !['draft', 'planning', 'awaiting-approval'].includes(studio.lifecycle);
  return `<div class="work-records">
    ${canPlanNext ? `<div class="actions">${action('Запланировать следующий спринт', 'open', 'next-sprint')}</div>` : ''}
    ${upcoming.map(plan => `<article class="work-record">
      <header><h2>${safe(nameOf(plan, 'План спринта'))}</h2>
        <div class="work-record-statuses">
          ${plan.debtSprint ? '<span class="debt-label">Спринт улучшений</span>' : ''}
          <span class="work-approval" data-plan-status="${safe(plan.status)}">${safe(lookup(planStatuses, plan.status) ?? plan.status)}</span>
        </div>
      </header>
      ${textBlock('Цель', plan.goal)}
      ${planButton(plan)}
    </article>`).join('')}
    ${entries.join('')}
  </div>`;
}

function meetingsView(meetings, byTask, sprints) {
  const controls = `<div class="actions">${action('Назначить встречу', 'open', 'meeting')}</div>`;
  if (!meetings.length) return controls + empty('Встреч пока не было', 'Здесь сохраняются позиции участников, решения и задачи по итогам встречи.');
  const bySprint = new Map(sprints.map(sprint => [sprint.id, sprint]));
  return controls + `<div class="work-records">${meetings.map(meeting => {
    const kind = lookup(meetingKinds, meeting.kind ?? meeting.type);
    const sprint = bySprint.get(meeting.sprintId);
    const date = new Date(meeting.createdAt);
    const time = Number.isFinite(date.getTime())
      ? `<time datetime="${date.toISOString()}">${meetingDate.format(date)}</time>`
      : '';
    const related = listed(meeting.taskIds).map(id => byTask.get(id)).filter(Boolean);
    return `<article class="work-record">
      <header><h2>${safe(nameOf(meeting, kind || 'Встреча'))}</h2>
        ${time ? `<span class="work-muted">${time}</span>` : ''}
      </header>
      ${meeting.stage ? `<p class="work-muted">${safe(meetingStages[meeting.stage] ?? meeting.stage)} · Версия ${safe(meeting.version)}</p>` : ''}
      ${sprint ? `<p class="work-muted">${safe(nameOf(sprint, 'Спринт'))}</p>` : ''}
      ${textBlock('Итог', meeting.outcome || meeting.summary)}
      ${bulletBlock('Решения', listed(meeting.decisions).map(decision => decision.text ?? decision))}
      ${linkedTasks(related, byTask)}
      ${meeting.id ? action('Открыть встречу', 'meeting-detail', meeting.id) : ''}
    </article>`;
  }).join('')}</div>`;
}

export const publishedPaths = plan => (plan.publishedFiles ?? [])
  .map(file => typeof file === 'string' ? file : file?.path)
  .filter(path => typeof path === 'string' && path.length > 0);

function artifactsView(tasks, plans, evidence) {
  const taskResults = tasks.filter(task => task.artifactPath || task.artifact || task.summary);
  const planResults = plans.map(plan => ({ plan, paths: [...new Set(publishedPaths(plan))] }))
    .filter(({ paths }) => paths.length);
  if (!taskResults.length && !planResults.length && !evidence.length) {
    return empty('Артефактов пока нет', 'Здесь появятся файлы планов и результаты задач.');
  }

  return `<div class="work-records">
    ${renderEvidence(evidence)}
    ${taskResults.length ? `<section class="work-record">
      <h2>Результаты задач</h2>
      <ul class="work-links">${taskResults.map(task => `<li>
        ${taskLink(task, false)}
        ${task.artifactPath ? `<button type="button" class="text-button work-file-link" data-artifact="${safe(task.id)}">${safe(task.artifactPath)}</button>` : '<span class="work-muted">Отчёт</span>'}
      </li>`).join('')}</ul>
    </section>` : ''}
    ${planResults.length ? `<section class="work-record">
      <h2>Файлы планов</h2>
      ${planResults.map(({ plan, paths }) => `<section class="work-story">
        <h3>${safe(nameOf(plan, 'План без названия'))}</h3>
        <ul class="work-artifact-files">${paths.map(path => `<li>
          <button type="button" class="text-button work-file-link" data-plan-file="${safe(path)}" data-plan-id="${safe(plan.id)}">${safe(path)}</button>
        </li>`).join('')}</ul>
      </section>`).join('')}
    </section>` : ''}
  </div>`;
}

function planningView(studio, phases, tasks) {
  const grooming = studio.grooming;
  const backlog = tasks.filter(task => !task.sprintId && task.kind !== 'train' && !['done', 'replaced'].includes(task.stage))
    .toSorted((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  return `<div class="work-records">
    <section class="work-record"><header><h2>Бэклог</h2>${action('Добавить в бэклог', 'open', 'backlog-task')}</header>
      <p class="work-muted">Версия ${safe(studio.backlogVersion ?? 0)} · Задач: ${backlog.length}</p>
      ${backlog.length ? `<ul class="work-links">${backlog.map(task => `<li>
        ${taskLink(task)}
        <p class="work-muted">Приоритет: ${safe(task.priority ?? 'не задан')}${task.points != null ? ` · Баллы: ${safe(task.points)}` : ''}</p>
        ${task.status !== 'running' ? `<div class="actions">${action('Изменить', 'backlog-edit', task.id)}${backlog.length > 1 ? action('Заменить', 'backlog-replace', task.id) : ''}</div>` : ''}
      </li>`).join('')}</ul>` : '<p class="work-muted">Здесь будут задачи вне спринта.</p>'}
    </section>
    <section class="work-record"><header><h2>Подготовка задач к спринту</h2>${grooming?.status === 'open' ? action('Завершить разбор', 'resolve-grooming', grooming.id) : action('Разобрать очередь', 'open', 'request-grooming')}</header>
      ${grooming ? `<p class="work-muted">${grooming.status === 'open' ? 'Открыт' : 'Завершён'} · Готовых задач: ${safe(grooming.readyTasks)} · Порог: ${safe(grooming.threshold)}</p>`
        : '<p class="work-muted">Директор уточняет карточки и зависимости, чтобы подготовить задачи к следующему спринту.</p>'}
      ${grooming?.result ? textBlock('Что изменилось', grooming.result) : ''}
      ${grooming?.error ? textBlock('Ошибка подготовки', grooming.error) : ''}</section>
    <section class="work-record"><header><h2>Фазы проекта</h2>${action('Добавить фазу', 'open', 'phase')}</header>
      ${phases.length ? phases.map(phase => `<article class="work-story"><h3>${safe(phase.title)}</h3>
        ${textBlock('Цель', phase.goal)}${bulletBlock('Условия завершения', (phase.criteria ?? []).map(row => row.description))}
        <p class="work-muted">${phase.status === 'completed' ? 'Завершена' : phase.transition?.status === 'pending' ? 'Ждёт согласования' : 'В работе'}</p>
        ${phase.status !== 'completed' ? `<div class="actions">${phase.transition?.status === 'pending' ? action('Решение о завершении', 'phase-transition', phase.id) :
          action('Изменить', 'phase-edit', phase.id) + action('Предложить завершение', 'phase-transition', phase.id)}</div>` : ''}
      </article>`).join('') : '<p class="work-muted">Фазы объединяют эпики и спринты вокруг одной цели.</p>'}</section>
  </div>`;
}

export function registerRows(tasks, studio, sprints, query, stage) {
  const owners = new Map((studio.agents ?? []).map(a => [a.id, a.name || a.roleTitle || a.role]));
  const sprintNames = new Map(sprints.map(s => [s.id, s.title]));
  const needle = query.trim().toLocaleLowerCase();
  const rows = [];
  for (const task of tasks) {
    const owner = owners.get(task.agentId) || (task.agentId ? 'Неизвестный агент' : 'Директор');
    const sprint = sprintNames.get(task.sprintId) || '';
    const state = task.stage === 'replaced' ? 'replaced' : stageOf(task);
    if (stage && state !== stage) continue;
    if (![task.title, task.id, owner, sprint, task.prompt].join(' ').toLocaleLowerCase().includes(needle)) continue;
    rows.push(`<tr><td>${taskLink(task, false)}</td><td>${safe(owner)}</td><td>${safe(sprint || '—')}</td><td>${safe(stages[state] || 'Заменена')}</td></tr>`);
  }
  return rows.join('') || '<tr><td colspan="4">По этим условиям задач нет.</td></tr>';
}

export function renderWork({ studio = {}, tasks = [], epics = [], stories = [], sprints = [], meetings = [], plans = [], phases = [], evidence = [], tab = 'board', expandedEpics = new Set(), registryQuery = '', registryStage = '' } = {}) {
  const selected = lookup(tabs, tab) ? tab : 'board';
  const byTask = new Map(tasks.map(task => [task.id, task]));
  const views = {
    registry: () => `<section><div class="actions"><input type="search" data-registry-query aria-label="Найти задачу" placeholder="Название, ID, агент, спринт" value="${safe(registryQuery)}"><select data-registry-stage aria-label="Этап"><option value="">Все этапы</option>${Object.entries({...stages, replaced: 'Заменена'}).map(([key,label]) => `<option value="${key}" ${registryStage === key ? 'selected' : ''}>${label}</option>`).join('')}</select></div><div class="registry-scroll"><table class="registry"><thead><tr><th>Задача</th><th>Ответственный</th><th>Спринт</th><th>Этап</th></tr></thead><tbody data-registry-rows>${registerRows(tasks, studio, sprints, registryQuery, registryStage)}</tbody></table></div></section>`,
    board: () => board(tasks, studio, byTask),
    epics: () => epicView(epics, stories, tasks, byTask, expandedEpics),
    sprints: () => sprintView(studio, sprints, plans, tasks, byTask),
    meetings: () => meetingsView(meetings, byTask, sprints),
    artifacts: () => artifactsView(tasks, plans, evidence),
    planning: () => planningView(studio, phases, tasks),
  };
  return `<section class="work-view" aria-label="Работа студии">
    <div class="work-tabs" role="group" aria-label="Разделы работы">
      ${Object.entries(tabs).map(([id, label]) => `<button type="button" data-work-tab="${id}" aria-pressed="${id === selected}">${label}</button>`).join('')}
    </div>
    ${views[selected]()}
  </section>`;
}
