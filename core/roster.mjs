import { randomUUID } from 'node:crypto';
import { field, object, trainingTopics } from './protocol.mjs';
import { roleObjective } from './training.mjs';

const kinds = ['hire', 'retire', 'return', 'update', 'rollback'];
const editableFields = ['key', 'role', 'roleTitle', 'name', 'description', 'mode', 'runtime', 'model', 'effort'];
const active = agent => agent.rosterStatus !== 'retired';
const finished = task => ['done', 'cancelled'].includes(task.stage) || task.status === 'cancelled'
  || (!task.workflowManaged && task.status === 'completed');
const busy = task => ['running', 'waiting'].includes(task.status)
  || ['in_progress', 'review', 'acceptance', 'integrating'].includes(task.stage)
  || task.activeAgentId;
const timestamp = () => new Date().toISOString();

function findAgent(studio, agentId) {
  const agent = studio.agents.find(({ id }) => id === agentId);
  if (!agent) throw new Error('Роль не найдена в этой студии.');
  return agent;
}

export function assertAssignable(studio, agentId) {
  if (!agentId) return;
  const agent = findAgent(studio, agentId);
  if (!active(agent)) throw new Error('Роль выведена из состава студии.');
  return agent;
}

export function normalizeStaffing(input = {}) {
  const data = object(input, 'ограничения состава');
  const { maxAgents, maxBudget, permissions } = data;
  if (maxAgents != null && (!Number.isSafeInteger(maxAgents) || maxAgents < 0)) throw new Error('Некорректный лимит численности.');
  if (maxBudget != null && (!Number.isFinite(maxBudget) || maxBudget < 0)) throw new Error('Некорректный бюджет команды.');
  if (permissions != null && !Array.isArray(permissions)) throw new Error('Некорректный список разрешений.');
  return {
    maxAgents: maxAgents ?? null, maxBudget: maxBudget ?? null,
    permissions: [...new Set((permissions ?? []).map(value => field(value, 'разрешение', 120)))],
  };
}

export function createRoster({ read, list, insert, update, transaction, changed, training, agentSettings, validateFixed, wake = () => {} }) {
  function ownTask(studio, taskId) {
    const task = read('tasks', taskId, 'Задача');
    if (task.studioId !== studio.id) throw new Error('Задача принадлежит другой студии.');
    return task;
  }

  function staffingLimits(studio, kind, estimatedBudget) {
    if (!['hire', 'return'].includes(kind)) return [];
    const { maxAgents, maxBudget } = normalizeStaffing(studio.staffing);
    const workingAgents = studio.agents.filter(agent => active(agent) && !agent.systemRole);
    const reasons = [];
    if (maxAgents != null && workingAgents.length >= maxAgents) reasons.push('headcount');
    if (maxBudget != null) {
      const committed = workingAgents.reduce((sum, agent) => sum + (agent.estimatedBudget ?? 0), 0);
      if (estimatedBudget == null || workingAgents.some(agent => agent.estimatedBudget == null)) reasons.push('budget-unverified');
      if (estimatedBudget != null && estimatedBudget + committed > maxBudget) reasons.push('budget');
    }
    return reasons;
  }

  function configuration(studio, input = {}, existing) {
    const requested = object(input, 'изменение роли');
    if (Object.keys(requested).some(key => !editableFields.includes(key))) throw new Error('Полномочия и другие настройки студии меняет владелец.');
    const { key, ...details } = requested;
    const settings = agentSettings(details, existing);
    if (settings.mode === 'fixed' || details.model || details.effort) validateFixed(studio, settings);
    if (key !== undefined) {
      if (existing && key !== existing.key) throw new Error('Стабильный ключ существующей роли нельзя изменить.');
      settings.key = field(key, 'ключ роли', 120);
      if (!/^[A-Za-z0-9_-]+$/.test(settings.key)) throw new Error('Некорректный ключ роли.');
    }
    return settings;
  }

  function affectedTasks(studio, agentId) {
    return list('tasks').filter(task => task.studioId === studio.id && !finished(task)
      && (task.agentId === agentId || task.reviewerId === agentId || task.training?.targetAgentId === agentId));
  }

  function retirementPlan({ studioId, agentId }) {
    const studio = read('studios', studioId, 'Студия');
    assertAssignable(studio, agentId);
    const affected = affectedTasks(studio, agentId);
    const meetingIds = (list('meetings') ?? []).filter(meeting => meeting.studioId === studio.id
      && ['positions', 'objections', 'facilitation', 'held', 'owner_review'].includes(meeting.stage)
      && (meeting.participants?.includes(agentId) || meeting.facilitatorId === agentId)).map(({ id }) => id);
    return {
      blockedTaskIds: affected.filter(busy).map(({ id }) => id),
      taskIds: affected.filter(task => task.kind !== 'train' && !busy(task)).map(({ id }) => id),
      trainingTaskIds: affected.filter(task => task.kind === 'train' && !busy(task)).map(({ id }) => id),
      meetingIds,
    };
  }

  function proposal(input, initiator, withinTransaction = false) {
    const { studioId, agentId, kind, firstTaskId, rollbackProposalId } = input;
    if (!kinds.includes(kind)) throw new Error('Неизвестное изменение состава студии.');
    const reason = field(input.reason, 'причина изменения состава', 2000);
    const operationId = field(input.operationId, 'идентификатор операции', 200);
    const firstResult = input.firstResult === undefined ? undefined : field(input.firstResult, 'первый результат роли', 2000);
    if (['hire', 'return'].includes(kind) && !firstTaskId && !firstResult) throw new Error('Укажите первый результат роли.');
    const estimatedBudget = input.estimatedBudget ?? null;
    if (estimatedBudget !== null && (!Number.isFinite(estimatedBudget) || estimatedBudget < 0)) throw new Error('Некорректная оценка бюджета роли.');
    const topics = trainingTopics(input.topics);
    const signature = JSON.stringify({ agentId, kind, reason, firstTaskId, firstResult, agent: input.agent, topics, estimatedBudget, rollbackProposalId, initiator });
    const write = () => {
      const existing = list('rosterProposals').find(record => record.operationId === operationId && record.studioId === studioId);
      if (existing) {
        if (existing.signature !== signature) throw new Error('Операция состава уже использована.');
        return existing;
      }
      const studio = read('studios', studioId, 'Студия');
      const agent = kind === 'hire' ? undefined : findAgent(studio, agentId);
      if (agent?.systemRole) throw new Error('Изменение системной роли требует владельческих настроек.');
      if (agent && active(agent) === (kind === 'return')) throw new Error('Изменение неприменимо к текущему состоянию роли.');
      const first = firstTaskId ? ownTask(studio, firstTaskId) : undefined;
      if (first && (first.kind === 'train' || busy(first) || finished(first))) throw new Error('Первый результат требует доступной задачи.');
      const rollback = kind === 'rollback' ? read('rosterProposals', rollbackProposalId, 'Предложение роли') : undefined;
      if (rollback && (rollback.kind !== 'update' || rollback.status !== 'approved' || rollback.studioId !== studioId || rollback.agentId !== agentId)) {
        throw new Error('Выберите утверждённое изменение этой роли для отката.');
      }
      const requested = rollback ? rollback.previousSettings : input.agent;
      let settings;
      if (['hire', 'update', 'rollback'].includes(kind) || (kind === 'return' && requested)) {
        settings = configuration(studio, requested, agent);
        if (settings.key && studio.agents.some(item => item.id !== agentId && (item.key ?? item.id) === settings.key)) throw new Error('Ключ роли уже используется.');
      } else if (requested !== undefined) {
        throw new Error('Для вывода роли параметры не задаются.');
      }
      return insert('rosterProposals', {
        id: randomUUID(), studioId, agentId, kind, reason, firstTaskId, firstResult: firstResult ?? first?.title, settings,
        topics, rollbackProposalId, initiator, operationId, signature, estimatedBudget, limitReasons: staffingLimits(studio, kind, estimatedBudget),
        roleVersion: agent?.rosterVersion ?? 0, version: 1, status: 'pending', createdAt: timestamp(),
      });
    };
    return withinTransaction ? write() : changed(transaction(write));
  }

  function transfer(studio, task, { agentId, reviewerId, removeDependencies = [], proposalId }) {
    const priorTargetedTrainingId = task.targetedTrainingId;
    const moved = {
      ...task, agentId, reviewerId,
      dependencies: (task.dependencies ?? []).filter(id => !removeDependencies.includes(id)),
      targetedTrainingId: removeDependencies.includes(priorTargetedTrainingId) ? undefined : priorTargetedTrainingId,
      modelRecommendations: undefined,
      assignmentHistory: [...(task.assignmentHistory ?? []), {
        agentId: task.agentId, reviewerId: task.reviewerId, targetedTrainingId: priorTargetedTrainingId, proposalId, date: timestamp(),
      }],
      updatedAt: timestamp(),
    };
    if (moved.stage === 'backlog' && moved.dependencies.every(id => read('tasks', id, 'Зависимость').stage === 'done')) moved.stage = 'ready';
    update('tasks', training.withDependencies(studio, moved));
  }

  function retire(studio, agent, proposal, replacementId) {
    const plan = retirementPlan({ studioId: studio.id, agentId: agent.id });
    if (plan.blockedTaskIds.length) throw new Error('Завершите или остановите активную работу роли перед выводом.');
    if (plan.meetingIds.length) throw new Error('Завершите открытые встречи роли или назначьте замену.');
    if (plan.taskIds.length && !replacementId) throw new Error('Укажите роль для передачи незавершённых задач.');
    if (replacementId) {
      const replacement = assertAssignable(studio, replacementId);
      if (replacement.id === agent.id || replacement.systemRole) throw new Error('Выберите другую рабочую роль для передачи задач.');
      for (const id of plan.taskIds) {
        const task = ownTask(studio, id);
        if ((task.agentId === agent.id && task.reviewerId === replacement.id)
          || (task.reviewerId === agent.id && task.agentId === replacement.id)) throw new Error('Исполнитель и рецензент должны отличаться.');
      }
      for (const id of plan.taskIds) {
        const task = ownTask(studio, id);
        transfer(studio, task, {
          agentId: task.agentId === agent.id ? replacement.id : task.agentId,
          reviewerId: task.reviewerId === agent.id ? replacement.id : task.reviewerId,
          removeDependencies: [agent.trainingTaskId, ...plan.trainingTaskIds].filter(Boolean), proposalId: proposal.id,
        });
      }
      for (const admission of list('prerequisites') ?? []) {
        if (admission.studioId !== studio.id || admission.consumerType !== 'task'
          || !plan.taskIds.includes(admission.consumerId) || admission.agentId !== agent.id || admission.retired) continue;
        update('prerequisites', {
          ...admission, retired: { reason: 'role-retired', replacementAgentId: replacement.id, proposalId: proposal.id, createdAt: timestamp() },
        });
      }
    }
    for (const id of plan.trainingTaskIds) {
      update('tasks', { ...ownTask(studio, id), status: 'cancelled', stage: 'cancelled', rosterProposalId: proposal.id, updatedAt: timestamp() });
    }
    agent.rosterStatus = 'retired';
  }

  function startTraining(studio, agent, proposal) {
    const first = proposal.firstTaskId ? ownTask(studio, proposal.firstTaskId) : undefined;
    if (first && (busy(first) || finished(first))) throw new Error('Задача первого результата уже изменилась.');
    if (first?.reviewerId === agent.id) throw new Error('Исполнитель и рецензент должны отличаться.');
    const { sprintId, epicId, storyId } = first ?? {};
    const lesson = training.add(studio, agent, {
      topics: proposal.topics, objective: proposal.firstResult ?? roleObjective(agent), sprintId, epicId, storyId,
    });
    if (lesson && sprintId) {
      const sprint = read('sprints', sprintId, 'Спринт');
      update('sprints', { ...sprint, taskIds: [...sprint.taskIds, lesson.id] });
    }
    if (first) {
      const previousAgent = studio.agents.find(({ id }) => id === first.agentId);
      const removeDependencies = [previousAgent?.trainingTaskId, first.targetedTrainingId].filter(Boolean);
      transfer(studio, first, { agentId: agent.id, reviewerId: first.reviewerId, removeDependencies, proposalId: proposal.id });
    }
    for (const task of affectedTasks(studio, agent.id)) {
      if (task.kind === 'train' || task.id === first?.id) continue;
      const next = training.withDependencies(studio, task);
      if (next !== task) update('tasks', next);
    }
  }

  function decideRosterChange({ proposalId, expectedVersion, decision, transferAgentId, overrideLimits = false }) {
    if (!['approve', 'reject'].includes(decision)) throw new Error('Неизвестное решение по роли.');
    const decisionSignature = JSON.stringify({ expectedVersion, decision, transferAgentId, overrideLimits });
    const resolution = transaction(() => {
      const proposal = read('rosterProposals', proposalId, 'Предложение роли');
      if (proposal.decisionSignature === decisionSignature) return proposal;
      if (proposal.status !== 'pending' || proposal.version !== expectedVersion) throw new Error('Версия предложения роли изменилась.');
      const studio = read('studios', proposal.studioId, 'Студия');
      const resolved = {
        ...proposal, status: decision === 'approve' ? 'approved' : 'rejected', version: proposal.version + 1,
        decisionSignature, decidedAt: timestamp(), decidedBy: 'owner',
      };
      if (decision === 'reject') return update('rosterProposals', resolved);
      const { kind, estimatedBudget, settings } = proposal;
      const limitReasons = staffingLimits(studio, kind, estimatedBudget);
      if (limitReasons.length && overrideLimits !== true) throw new Error('Требуется решение владельца о превышении лимитов состава.');
      resolved.limitReasons = limitReasons;
      resolved.limitsOverridden = limitReasons.length > 0;
      const agent = kind === 'hire' ? { id: randomUUID() } : findAgent(studio, proposal.agentId);
      if ((agent.rosterVersion ?? 0) !== proposal.roleVersion || active(agent) === (kind === 'return')) throw new Error('Версия роли изменилась.');
      if (kind === 'hire' && settings.key && studio.agents.some(item => (item.key ?? item.id) === settings.key)) throw new Error('Ключ роли уже используется.');
      if (kind === 'retire') {
        retire(studio, agent, proposal, transferAgentId);
      } else {
        if (affectedTasks(studio, agent.id).some(task => busy(task) || task.kind === 'train')) {
          throw new Error('Завершите текущую работу и обучение роли перед изменением.');
        }
        const approvedSettings = settings ?? agent;
        if (approvedSettings.mode === 'fixed' || approvedSettings.model || approvedSettings.effort) validateFixed(studio, approvedSettings);
        if (kind === 'update') resolved.previousSettings = Object.fromEntries(editableFields.filter(key => agent[key] !== undefined).map(key => [key, agent[key]]));
        Object.assign(agent, settings, { rosterStatus: 'active' });
        if (kind === 'hire') studio.agents.push(agent);
        if (['hire', 'return'].includes(kind)) Object.assign(agent, { estimatedBudget, firstResult: proposal.firstResult });
        startTraining(studio, agent, proposal);
      }
      Object.assign(agent, { rosterVersion: proposal.roleVersion + 1, rosterProposalId: proposal.id });
      update('studios', studio);
      return update('rosterProposals', { ...resolved, agentId: agent.id, transferAgentId });
    });
    wake(resolution.studioId);
    return changed(resolution);
  }

  return {
    assertAssignable, retirementPlan, decideRosterChange,
    proposeRosterChange: input => proposal(input, 'owner'),
    proposeDirectorChange: input => proposal(input, 'director'),
    proposeDirectorChangeWithinTransaction: input => proposal(input, 'director', true),
  };
}
