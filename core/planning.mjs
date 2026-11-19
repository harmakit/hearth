import { randomUUID } from 'node:crypto';
import { validatePoints } from './debt.mjs';
import { field, object } from './protocol.mjs';
import { retrospectiveFacts } from './retrospective.mjs';

const linkTypes = ['blocks', 'origin', 'replaces', 'debt'];
const terminalStages = ['done', 'replaced'];
const activeAttemptStatuses = ['running', 'reconcile', 'reconciling', 'reconciliation', 'unknown'];

const distinct = (values) => [...new Set(values)];
const linkKey = ({ type, taskId }) => JSON.stringify([type, taskId]);
const distinctLinks = (links) => [...new Map(links.map((link) => [linkKey(link), link])).values()];

function values(input, label, max = 100) {
  if (!Array.isArray(input) || input.length > max) throw new Error(`Некорректный список «${label}».`);
  return input;
}

function ids(input, label) {
  return distinct(values(input, label).map((value) => field(value, label, 200)));
}

function integer(value, min, max, label) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Некорректное значение «${label}».`);
  return value;
}

export function normalizeGroomingPolicy({ enabled, threshold = null, nextSprintCapacity = 1 }) {
  if (typeof enabled !== 'boolean') throw new Error('Укажите, включена ли автоматическая подготовка задач.');
  return {
    enabled, threshold: threshold === null ? null : integer(threshold, 1, 200, 'запас готовых задач'),
    nextSprintCapacity: integer(nextSprintCapacity, 0, 200, 'ёмкость следующего спринта'),
  };
}

export function taskLinks(task) {
  return distinctLinks([...(task.links ?? []), ...(task.dependencies ?? []).map((taskId) => ({ type: 'blocks', taskId }))]);
}

function withLinks(task, links) {
  const unique = distinctLinks(links);
  return { ...task, links: unique, dependencies: unique.filter(({ type }) => type === 'blocks').map(({ taskId }) => taskId) };
}

function assertAcyclic(graph, type) {
  const checked = new Set();
  const checking = new Set();
  function visit(taskId) {
    if (checked.has(taskId)) return;
    if (checking.has(taskId)) throw new Error('Связи задач образуют цикл.');
    const task = graph.get(taskId);
    if (!task || (type === 'blocks' && terminalStages.includes(task.stage))) return;
    checking.add(taskId);
    for (const link of taskLinks(task)) {
      if (link.type === type) visit(link.taskId);
    }
    checking.delete(taskId);
    checked.add(taskId);
  }
  for (const taskId of graph.keys()) visit(taskId);
}

function editTask(task, edit) {
  const result = { ...task };
  for (const [name, label, max] of [
    ['title', 'название задачи', 200], ['prompt', 'описание задачи', 8_000],
    ['criteria', 'критерии приёмки', 8_000], ['debtCategory', 'категория техдолга', 100],
  ]) {
    if (edit[name] !== undefined) result[name] = edit[name] === null && ['criteria', 'debtCategory'].includes(name) ? undefined : field(edit[name], label, max);
  }
  if (edit.priority !== undefined) result.priority = integer(edit.priority, 0, 100, 'приоритет');
  if (edit.points !== undefined) result.points = edit.points === null ? undefined : validatePoints(edit.points);
  return result;
}

export function createPlanning({
  read, list, insert, update, transaction, changed, now = () => new Date().toISOString(),
  hasActiveAttempt = () => false, onSprintClosed, onPhaseProposal, onGroomingRequest,
}) {
  const records = (table, studioId) => list(table).filter((record) => record.studioId === studioId);
  const getStudio = (studioId) => read('studios', studioId, 'Студия');

  function own(table, id, studioId, label) {
    const record = read(table, id, label);
    if (!record || record.studioId !== studioId) throw new Error(`${label} не найдено в студии.`);
    return record;
  }

  function busy(task, attempts) {
    return task.status === 'running' || hasActiveAttempt(task.studioId, task.id)
      || attempts.some(({ taskId, status }) => taskId === task.id && activeAttemptStatuses.includes(status));
  }

  function reviseBacklog({ studioId, baseVersion, edits }) {
    return changed(transaction(() => {
      const studio = getStudio(studioId);
      const version = studio.backlogVersion ?? 0;
      if (baseVersion !== version) throw new Error('Версия бэклога изменилась. Обновите список задач.');
      const instructions = values(edits, 'правки бэклога');
      if (!instructions.length) throw new Error('Добавьте правку бэклога.');
      const attempts = records('attempts', studioId);
      const tasks = new Map(records('tasks', studioId).map((task) => [task.id, task]));
      const updated = new Map();
      const created = new Set();
      function save(task) {
        const record = { ...task, updatedAt: now() };
        tasks.set(task.id, record);
        updated.set(task.id, record);
      }
      function editable(id) {
        const task = tasks.get(id);
        if (!task || task.kind === 'train' || terminalStages.includes(task.stage) || busy(task, attempts)) {
          throw new Error('Задача бэклога недоступна для изменения.');
        }
        return task;
      }
      for (const entry of instructions) {
        const edit = object(entry, 'правка бэклога');
        const { type, taskId } = edit;
        let editedTaskId = taskId;
        if (type === 'create') {
          const id = taskId === undefined ? randomUUID() : field(taskId, 'ID задачи', 200);
          if (tasks.has(id) || list('tasks').some((task) => task.id === id)) throw new Error('Задача с этим ID уже существует.');
          if (edit.kind !== undefined && !['work', 'debt'].includes(edit.kind)) throw new Error('Некорректный вид задачи.');
          const draft = {
            id, studioId, title: field(edit.title, 'название задачи', 200), prompt: field(edit.prompt, 'описание задачи'),
            ...(edit.kind === 'debt' ? { kind: 'debt' } : {}), status: 'queued', stage: 'backlog', createdAt: now(),
          };
          if (edit.kind === 'debt') draft.epicId = getDebtEpic(studioId).id;
          created.add(id);
          editedTaskId = id;
          save(editTask(draft, edit));
        } else if (type === 'update') {
          save(editTask(editable(taskId), edit));
        } else if (type === 'replace') {
          const old = editable(taskId);
          const replacement = editable(edit.replacementId);
          if (old.id === replacement.id) throw new Error('Задача не может заменить саму себя.');
          if (edit.redirectDependencies !== undefined && typeof edit.redirectDependencies !== 'boolean') throw new Error('Некорректная настройка переноса зависимостей.');
          save({ ...old, stage: 'replaced', status: 'cancelled', replacedBy: replacement.id });
          save(withLinks(replacement, [...taskLinks(replacement), { type: 'replaces', taskId: old.id }]));
          if (edit.redirectDependencies) {
            for (const dependent of tasks.values()) {
              if (terminalStages.includes(dependent.stage) || !taskLinks(dependent).some((link) => link.type === 'blocks' && link.taskId === old.id)) continue;
              if (busy(dependent, attempts)) throw new Error('Сначала завершите активную попытку зависимой задачи.');
              save(withLinks(dependent, taskLinks(dependent).map((link) => link.type === 'blocks' && link.taskId === old.id
                ? { ...link, taskId: replacement.id } : link)));
            }
          }
        } else {
          throw new Error('Неизвестная правка бэклога.');
        }
        if (edit.links !== undefined && ['create', 'update'].includes(type)) {
          const task = tasks.get(editedTaskId);
          const links = values(edit.links, 'связи задачи').map((entry) => {
            const link = object(entry, 'связь задачи');
            if (!linkTypes.includes(link.type)) throw new Error('Неизвестный вид связи задачи.');
            return { type: link.type, taskId: field(link.taskId, 'ID связанной задачи', 200) };
          });
          const history = taskLinks(task).filter(({ type }) => type === 'replaces');
          save(withLinks(task, [...history, ...links]));
        }
      }
      for (const task of updated.values()) {
        for (const link of taskLinks(task)) {
          if (link.taskId === task.id) throw new Error('Связь задачи с самой собой образует цикл.');
          if (!tasks.has(link.taskId)) throw new Error(`Связанная задача ${link.taskId} не найдена в студии.`);
        }
      }
      assertAcyclic(tasks, 'blocks');
      assertAcyclic(tasks, 'replaces');
      for (const task of updated.values()) (created.has(task.id) ? insert : update)('tasks', task);
      update('studios', { ...studio, backlogVersion: version + 1 });
      return { studioId, version: version + 1, tasks: [...updated.values()] };
    }));
  }

  function getDebtEpic(studioId) {
    return records('epics', studioId).find(({ kind }) => kind === 'debt') ?? insert('epics', {
      id: randomUUID(), studioId, kind: 'debt', title: 'Улучшения проекта', description: 'Устраняют препятствия для дальнейшей работы студии.',
      priority: 0, sprintIds: [], history: [], createdAt: now(),
    });
  }

  function addReportedImprovements(source) {
    if (!source.improvements?.length || source.stage !== 'done') return;
    const { studioId } = source;
    const titleKey = title => title.toLocaleLowerCase().replace(/\s+/g, ' ').trim();
    const seen = new Set(records('tasks', studioId).filter(task =>
      task.kind === 'debt' && task.links?.some(link => link.type === 'origin' && link.taskId === source.id))
      .map(task => titleKey(task.title)));
    for (const { title, reason, acceptance } of source.improvements) {
      const key = titleKey(title);
      if (seen.has(key)) continue;
      seen.add(key);
      const date = now();
      insert('tasks', {
        id: randomUUID(), studioId, kind: 'debt', epicId: getDebtEpic(studioId).id, title, prompt: reason,
        criteria: acceptance, links: [{ type: 'origin', taskId: source.id }], dependencies: [],
        stage: 'backlog', status: 'queued', summary: '', artifact: '', createdAt: date, updatedAt: date,
      });
    }
  }

  function selectPlanStructure(studio, plan) {
    const studioId = studio.id;
    const epicId = plan.epicId ?? plan.epic?.id;
    const storyId = plan.storyId ?? plan.story?.id;
    const existingStory = storyId ? own('stories', storyId, studioId, 'История') : undefined;
    const selectedEpicId = epicId ?? existingStory?.epicId;
    const epic = selectedEpicId ? own('epics', selectedEpicId, studioId, 'Эпик') : insert('epics', {
      ...object(plan.epic, 'эпик'), id: randomUUID(), studioId, priority: plan.epic.priority ?? 0, sprintIds: [], history: [], createdAt: now(),
    });
    if (existingStory && existingStory.epicId !== epic.id) throw new Error('История относится к другому эпику.');
    const story = existingStory ?? insert('stories', {
      ...object(plan.story, 'история'), id: randomUUID(), studioId, epicId: epic.id, sprintIds: [], createdAt: now(),
    });
    return { epic, story };
  }

  function attachPlanStructure({ epic, story, sprint, phaseId, debtEpic }) {
    const saveSprint = (table, record, history = false) => {
      const sprintIds = record.sprintIds ?? [];
      if (sprintIds.includes(sprint.id)) return record;
      return update(table, {
        ...record, sprintIds: [...sprintIds, sprint.id],
        ...(history ? { history: [...(record.history ?? []), { type: 'sprint', sprintId: sprint.id, at: now() }] } : {}),
      });
    };
    saveSprint('epics', epic, true);
    if (debtEpic && debtEpic.id !== epic.id) saveSprint('epics', debtEpic, true);
    saveSprint('stories', story);
    if (phaseId) {
      const phase = own('phases', phaseId, sprint.studioId, 'Фаза');
      if (phase.status === 'completed' || phase.transition?.status === 'pending') throw new Error('Фаза закрыта для планирования.');
      update('phases', {
        ...phase, epicIds: distinct([...phase.epicIds, epic.id]), sprintIds: distinct([...phase.sprintIds, sprint.id]), updatedAt: now(),
      });
    }
  }

  function sprintFacts(sprint, carryovers) {
    const tasks = records('tasks', sprint.studioId);
    const attempts = records('attempts', sprint.studioId).filter(({ sprintId, startedAt }) =>
      sprintId ? sprintId === sprint.id : !sprint.createdAt || !startedAt || startedAt >= sprint.createdAt);
    return retrospectiveFacts({ sprint, tasks, attempts, carryovers });
  }

  function calculateRetrospective({ studioId, sprintId }) {
    const sprint = own('sprints', sprintId, studioId, 'Спринт');
    return sprint.retrospective ?? sprintFacts(sprint, sprint.carryovers);
  }

  function finalizeSprint(sprint, { carryovers = [], operationId, summary } = {}) {
    const closedAt = now();
    const retrospective = sprintFacts(sprint, carryovers);
    const taskIds = new Set(sprint.taskIds ?? []);
    const closed = update('sprints', {
      ...sprint, status: 'completed', closedAt, ...(summary === undefined ? {} : { summary }),
      ...(operationId === undefined ? {} : { closeOperationId: operationId }), carryovers, retrospective,
      closedTasks: records('tasks', sprint.studioId).filter(({ id }) => taskIds.has(id)).map((task) => ({
        taskId: task.id, title: task.title, kind: task.kind, stage: task.stage, status: task.status, points: task.points, summary: task.summary,
      })),
    });
    insert('meetings', {
      id: randomUUID(), studioId: sprint.studioId, sprintId: sprint.id, kind: 'retrospective', title: 'Ретроспектива спринта',
      summary: summary ?? sprint.summary ?? '', taskIds: [...taskIds], retrospective, createdAt: closedAt,
    });
    return closed;
  }

  function closeSprint({ studioId, sprintId, carryovers = [], operationId }) {
    const closeId = field(operationId, 'ID закрытия спринта', 200);
    const decisions = values(carryovers, 'перенос задач').map((entry) => {
      const input = object(entry, 'перенос задачи');
      const taskId = field(input.taskId, 'ID задачи', 200);
      const reason = field(input.reason, 'причина переноса');
      if (!['backlog', 'ready'].includes(input.stage)) throw new Error('Выберите этап переноса задачи.');
      return { taskId, reason, stage: input.stage, ...(input.sprintId ? { sprintId: field(input.sprintId, 'ID следующего спринта', 200) } : {}) };
    });
    const byTask = new Map(decisions.map((decision) => [decision.taskId, decision]));
    if (byTask.size !== decisions.length) throw new Error('Для задачи указан повторный перенос.');
    return changed(transaction(() => {
      const studio = getStudio(studioId);
      const sprint = own('sprints', sprintId, studioId, 'Спринт');
      const previous = records('sprints', studioId).find(({ closeOperationId }) => closeOperationId === closeId);
      if (previous) {
        const recorded = new Map(previous.carryovers.map(({ fromStage, ...decision }) => [decision.taskId, decision]));
        if (previous.id !== sprintId || recorded.size !== byTask.size || decisions.some((decision) => JSON.stringify(recorded.get(decision.taskId)) !== JSON.stringify(decision))) {
          throw new Error('ID операции уже использован для другого закрытия.');
        }
        return previous;
      }
      if (sprint.status !== 'active') throw new Error('Закрыть можно только активный спринт.');
      const members = new Set(sprint.taskIds ?? []);
      if (decisions.some(({ taskId }) => !members.has(taskId))) throw new Error('Перенос доступен только для задач исходного спринта.');
      const tasks = records('tasks', studioId).filter(({ id }) => members.has(id));
      const attempts = records('attempts', studioId);
      if (tasks.some((task) => busy(task, attempts))) throw new Error('Завершите или сверьте активную попытку перед закрытием спринта.');
      const remaining = tasks.filter(({ stage, sprintId: taskSprintId }) => !terminalStages.includes(stage) && taskSprintId === sprintId);
      if (remaining.length !== decisions.length || remaining.some(({ id }) => !byTask.has(id))) {
        throw new Error('Укажите перенос каждой незавершённой задачи спринта.');
      }
      const targets = new Map();
      for (const decision of decisions) {
        if (!decision.sprintId) continue;
        const target = own('sprints', decision.sprintId, studioId, 'Следующий спринт');
        if (target.id === sprint.id || target.status !== 'active') throw new Error('Выберите другой активный спринт для переноса.');
        targets.set(target.id, target);
      }
      const historical = remaining.map((task) => ({ ...byTask.get(task.id), fromStage: task.stage }));
      const closed = finalizeSprint(sprint, { carryovers: historical, operationId: closeId });
      for (const task of remaining) {
        const decision = byTask.get(task.id);
        update('tasks', {
          ...task, sprintId: decision.sprintId, stage: decision.stage,
          status: task.status === 'waiting' ? task.status : 'queued',
          workflowManaged: Boolean(decision.sprintId), activeAgentId: undefined,
          carryoverHistory: [...(task.carryoverHistory ?? []), {
            fromSprintId: sprintId, ...decision, revision: task.revision, failedReviews: task.failedReviews, at: closed.closedAt,
          }],
          updatedAt: closed.closedAt,
        });
      }
      for (const target of targets.values()) {
        const moving = remaining.filter(({ id }) => byTask.get(id).sprintId === target.id);
        const plannedWork = target.plannedWork ?? tasksInPlan(target);
        const plannedIds = new Set(plannedWork.map(({ id }) => id));
        update('sprints', {
          ...target, taskIds: distinct([...(target.taskIds ?? []), ...moving.map(({ id }) => id)]),
          plannedWork: [...plannedWork, ...moving.filter(({ id, kind }) => kind !== 'train' && !plannedIds.has(id)).map(({ id, points }) => ({ id, points }))],
        });
      }
      update('studios', { ...studio, backlogVersion: (studio.backlogVersion ?? 0) + 1 });
      onSprintClosed?.(getStudio(studioId), closed);
      return closed;
    }));
  }

  function tasksInPlan(sprint) {
    const members = new Set(sprint.taskIds ?? []);
    return records('tasks', sprint.studioId).filter(({ id, kind }) => members.has(id) && kind !== 'train')
      .map(({ id, points }) => ({ id, points }));
  }

  function phaseFields(input, phase) {
    const patch = {};
    if (input.title !== undefined || !phase) patch.title = field(input.title, 'название фазы', 200);
    if (input.goal !== undefined || !phase) patch.goal = field(input.goal, 'цель фазы');
    if (input.criteria !== undefined || !phase) {
      patch.criteria = values(input.criteria, 'критерии фазы', 30).map((entry) => {
        const criterion = typeof entry === 'string' ? { description: entry } : object(entry, 'критерий фазы');
        return {
          id: criterion.id === undefined ? randomUUID() : field(criterion.id, 'ID критерия', 200),
          description: field(criterion.description, 'описание критерия'),
          evidenceIds: ids(criterion.evidenceIds ?? [], 'доказательства критерия'),
        };
      });
      if (!patch.criteria.length || distinct(patch.criteria.map(({ id }) => id)).length !== patch.criteria.length) {
        throw new Error('Укажите уникальные критерии завершения фазы.');
      }
    }
    for (const [key, table, label] of [['epicIds', 'epics', 'Эпик'], ['sprintIds', 'sprints', 'Спринт']]) {
      if (input[key] !== undefined || !phase) {
        patch[key] = ids(input[key] ?? [], label);
        for (const id of patch[key]) own(table, id, input.studioId, label);
      }
    }
    return patch;
  }

  function createPhase(input) {
    return changed(transaction(() => {
      const { studioId } = input;
      getStudio(studioId);
      return insert('phases', {
        id: randomUUID(), studioId, ...phaseFields(input), status: 'active', transitionHistory: [], createdAt: now(),
      });
    }));
  }

  function updatePhase(input) {
    return changed(transaction(() => {
      const phase = own('phases', input.phaseId, input.studioId, 'Фаза');
      if (phase.status === 'completed' || phase.transition?.status === 'pending') throw new Error('Сначала решите вопрос о переходе фазы.');
      return update('phases', { ...phase, ...phaseFields(input, phase), updatedAt: now() });
    }));
  }

  function checkedEvidence(phase, evidenceIds) {
    const linkedSprints = records('sprints', phase.studioId).filter((sprint) =>
      phase.sprintIds.includes(sprint.id) || phase.epicIds.includes(sprint.epicId));
    const sprintIds = new Set(linkedSprints.map(({ id }) => id));
    const memberIds = new Set(linkedSprints.flatMap(({ taskIds }) => taskIds ?? []));
    const completedTasks = records('tasks', phase.studioId).filter((task) => task.kind !== 'train' && task.stage === 'done'
      && (phase.epicIds.includes(task.epicId) || sprintIds.has(task.sprintId) || memberIds.has(task.id)));
    const taskIds = new Set(completedTasks.map(({ id }) => id));
    const accepted = new Set([...taskIds, ...linkedSprints.filter(({ status }) => status === 'completed').map(({ id }) => id)]);
    if (!evidenceIds.length || evidenceIds.some((id) => !accepted.has(id))) throw new Error('Укажите доказательства завершения из связанных задач или спринтов.');
    if (phase.criteria.every(({ evidenceIds: assigned }) => !assigned.length) && phase.criteria.length === 1) return;
    for (const criterion of phase.criteria) {
      const bound = new Set([...criterion.evidenceIds, ...completedTasks.filter((task) => task.phaseCriterionIds?.includes(criterion.id)).map(({ id }) => id)]);
      if (!evidenceIds.some((id) => bound.has(id))) throw new Error(`Добавьте доказательство для критерия «${criterion.description}».`);
    }
  }

  function finishPhase(phase, proposal, decision) {
    const transition = { ...proposal, status: decision === 'approve' ? 'approved' : 'rejected', decidedAt: now() };
    return update('phases', {
      ...phase, status: decision === 'approve' ? 'completed' : 'active', transition,
      transitionHistory: [...(phase.transitionHistory ?? []), transition], updatedAt: transition.decidedAt,
    });
  }

  function proposePhaseTransition({ studioId, phaseId, evidenceIds }) {
    return changed(transaction(() => {
      const studio = getStudio(studioId);
      const phase = own('phases', phaseId, studioId, 'Фаза');
      const evidence = ids(evidenceIds, 'доказательства');
      if (phase.transition?.status === 'pending' && JSON.stringify(phase.transition.evidenceIds) === JSON.stringify(evidence)) return phase;
      if (phase.status === 'completed' || phase.transition?.status === 'pending') throw new Error('Переход фазы уже предложен или завершён.');
      checkedEvidence(phase, evidence);
      const transition = { id: randomUUID(), status: 'pending', evidenceIds: evidence, proposedAt: now() };
      if (!studio.approveSprints) return finishPhase(phase, transition, 'approve');
      const pending = update('phases', { ...phase, transition, updatedAt: transition.proposedAt });
      onPhaseProposal?.(pending);
      return pending;
    }));
  }

  function decidePhaseTransition({ studioId, phaseId, decision }) {
    return changed(transaction(() => {
      const phase = own('phases', phaseId, studioId, 'Фаза');
      if (!['approve', 'reject'].includes(decision) || phase.transition?.status !== 'pending') throw new Error('Нет ожидающего решения о переходе фазы.');
      if (decision === 'approve') checkedEvidence(phase, phase.transition.evidenceIds);
      return finishPhase(phase, phase.transition, decision);
    }));
  }

  function updateGrooming({ studioId, enabled, threshold = null, nextSprintCapacity = 1 }) {
    const settings = normalizeGroomingPolicy({ enabled, threshold, nextSprintCapacity });
    return changed(transaction(() => update('studios', { ...getStudio(studioId), groomingPolicy: settings })));
  }

  function openGrooming({ studioId }, source) {
    let opened = false;
    const result = transaction(() => {
      const studio = getStudio(studioId);
      if (studio.grooming?.status === 'open') return studio.grooming;
      const policy = studio.groomingPolicy ?? {};
      const threshold = policy.threshold ?? 2 * (studio.wipLimit ?? studio.wip ?? studio.dispatcher?.wip ?? 1);
      const tasks = records('tasks', studioId);
      const done = new Set(tasks.filter(({ stage }) => stage === 'done').map(({ id }) => id));
      const readyTasks = tasks.filter((task) => !task.sprintId && task.kind !== 'train' && task.status === 'queued'
        && ['backlog', 'ready', undefined].includes(task.stage) && (task.dependencies ?? []).every((id) => done.has(id))).length;
      const nextSprintCapacity = policy.nextSprintCapacity ?? 1;
      const draft = records('plans', studioId).findLast(({ kind, status }) => kind === 'sprint' && status === 'pending');
      const planned = draft?.tasks?.filter(({ kind }) => kind !== 'train').length ?? 0;
      const freeCapacity = Math.max(0, nextSprintCapacity - planned);
      if (source === 'automatic' && (!policy.enabled || !freeCapacity || readyTasks >= threshold)) return undefined;
      const grooming = { id: randomUUID(), status: 'open', source, readyTasks, threshold, nextSprintCapacity, freeCapacity, createdAt: now() };
      update('studios', { ...studio, grooming });
      onGroomingRequest?.(studio, grooming);
      opened = true;
      return grooming;
    });
    return opened ? changed(result) : result;
  }

  function resolveGrooming({ studioId, groomingId }) {
    return changed(transaction(() => {
      const studio = getStudio(studioId);
      if (studio.grooming?.id !== groomingId || studio.grooming.status !== 'open') throw new Error('Открытый разбор бэклога не найден.');
      const grooming = { ...studio.grooming, status: 'completed', completedAt: now() };
      update('studios', { ...studio, grooming });
      return grooming;
    }));
  }

  return {
    reviseBacklog, closeSprint, calculateRetrospective, finalizeSprint, selectPlanStructure, attachPlanStructure, getDebtEpic, addReportedImprovements,
    createPhase, updatePhase, proposePhaseTransition, decidePhaseTransition,
    updateGrooming, resolveGrooming, requestGrooming: (input) => openGrooming(input, 'manual'),
    maybeRequestGrooming: (input) => openGrooming(input, 'automatic'),
  };
}
