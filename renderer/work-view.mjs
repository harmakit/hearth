import { roleNames } from './workshop.mjs';

const tabs = {
  board: 'Доска', epics: 'Эпики и истории', sprints: 'Спринты', meetings: 'Встречи',
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
  planning: 'Планирование', retrospective: 'Ретроспектива', review: 'Обзор результатов',
};
const meetingDate = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium' });
const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const safe = value => String(value ?? '').replace(/[&<>"']/g, character => entities[character]);
const lookup = (dictionary, key) => Object.hasOwn(dictionary, key) ? dictionary[key] : undefined;
const stageOf = task => lookup(stages, task.stage) ? task.stage : (lookup(legacyStages, task.status) ?? 'backlog');
const listed = value => Array.isArray(value) ? value : (value ? [value] : []);
const nameOf = (record, fallback) => record.title || record.name || fallback;
const groupByField = (records, field) => Map.groupBy(records, record => record[field]);

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

function board(tasks, studio) {
  if (!tasks.length) return empty('На доске пока пусто', 'Задачи появятся здесь после согласования плана или создания вручную.');
  const byStage = Map.groupBy(tasks, stageOf);
  const agents = new Map((studio.agents ?? []).map(agent => [agent.id, agent]));
  return `<div class="work-board" role="region" aria-label="Доска задач" tabindex="0">
    ${Object.entries(stages).map(([stage, label]) => {
      const lane = byStage.get(stage) ?? [];
      return `<section class="work-lane" data-stage="${stage}" aria-labelledby="work-stage-${stage}">
        <header><h2 id="work-stage-${stage}">${label}</h2><span>${lane.length}</span></header>
        <ul>${lane.map(task => {
          const agent = agents.get(task.agentId);
          const owner = agent ? (agent.name || lookup(roleNames, agent.role)) :
            (task.agentId ? '' : (studio.director?.name || 'Директор'));
          const attempt = lookup(attempts, task.status) ?? task.status;
          return `<li class="work-task">
            ${taskLink(task, false)}
            ${owner ? `<p class="work-owner">${safe(owner)}</p>` : ''}
            ${attempt ? `<p class="work-attempt" data-attempt="${safe(task.status)}"><span>Попытка</span> ${safe(attempt)}</p>` : ''}
          </li>`;
        }).join('')}</ul>
      </section>`;
    }).join('')}
  </div>`;
}

function epicView(epics, stories, tasks, byTask) {
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
    ${epics.map(epic => `<article class="work-record">
      <h2>${safe(nameOf(epic, 'Эпик без названия'))}</h2>
      ${textBlock('Цель', epic.goal || epic.description)}
      ${showStories(storiesByEpic.get(epic.id) ?? [])}
      ${linkedTasks((tasksByEpic.get(epic.id) ?? []).filter(task => !storyIds.has(task.storyId)), byTask)}
    </article>`).join('')}
    ${orphanStories.length ? `<article class="work-record"><h2>Истории без эпика</h2>${showStories(orphanStories)}</article>` : ''}
    ${orphanTasks.length ? `<article class="work-record"><h2>Задачи без эпика и истории</h2>${linkedTasks(orphanTasks, byTask)}</article>` : ''}
  </div>`;
}

function planButton(plan) {
  const title = safe(nameOf(plan, 'План спринта'));
  return `<button type="button" class="work-plan-button" data-plan="${safe(plan.id)}" aria-label="Открыть план «${title}»">Открыть план</button>`;
}

function sprintView(sprints, plans, tasks, byTask) {
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
      ${plan ? planButton(plan) : ''}
    </article>`;
  });
  const upcoming = plans.filter(plan => !attachedPlans.has(plan.id) && (plan.kind === 'sprint' || plan.status !== 'approved'));
  if (!entries.length && !upcoming.length) return empty('Спринтов пока нет', 'Здесь появятся планы спринтов, состав задач и результаты.');
  return `<div class="work-records">
    ${upcoming.map(plan => `<article class="work-record">
      <header><h2>${safe(nameOf(plan, 'План спринта'))}</h2>
        <span class="work-approval" data-plan-status="${safe(plan.status)}">${safe(lookup(planStatuses, plan.status) ?? plan.status)}</span>
      </header>
      ${textBlock('Цель', plan.goal)}
      ${planButton(plan)}
    </article>`).join('')}
    ${entries.join('')}
  </div>`;
}

function meetingsView(meetings, byTask, sprints) {
  if (!meetings.length) return empty('Встреч пока не было', 'Здесь сохраняются решения встреч и задачи, которые по ним создала студия.');
  const bySprint = new Map(sprints.map(sprint => [sprint.id, sprint]));
  return `<div class="work-records">${meetings.map(meeting => {
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
      ${sprint ? `<p class="work-muted">${safe(nameOf(sprint, 'Спринт'))}</p>` : ''}
      ${textBlock('Итог', meeting.outcome || meeting.summary)}
      ${bulletBlock('Решения', meeting.decisions)}
      ${linkedTasks(related, byTask)}
    </article>`;
  }).join('')}</div>`;
}

export function renderWork({ studio = {}, tasks = [], epics = [], stories = [], sprints = [], meetings = [], plans = [], tab = 'board' } = {}) {
  const selected = lookup(tabs, tab) ? tab : 'board';
  const byTask = new Map(tasks.map(task => [task.id, task]));
  const views = {
    board: () => board(tasks, studio),
    epics: () => epicView(epics, stories, tasks, byTask),
    sprints: () => sprintView(sprints, plans, tasks, byTask),
    meetings: () => meetingsView(meetings, byTask, sprints),
  };
  return `<section class="work-view" aria-label="Работа студии">
    <div class="work-tabs" role="group" aria-label="Разделы работы">
      ${Object.entries(tabs).map(([id, label]) => `<button type="button" data-work-tab="${id}" aria-pressed="${id === selected}">${label}</button>`).join('')}
    </div>
    ${views[selected]()}
  </section>`;
}
