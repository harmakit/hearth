import { field, object, relativeArtifactPath, trainingTopics } from './protocol.mjs';

const collections = ['tasks', 'inbox', 'plans', 'epics', 'stories', 'sprints', 'meetings', 'skills'];
const statuses = ['queued', 'scheduled', 'running', 'waiting', 'completed', 'failed', 'interrupted'];
const stages = ['backlog', 'ready', 'in_progress', 'review', 'qa', 'done', 'blocked'];
const relations = {
  agentId: 'agents', reviewerId: 'agents', taskId: 'tasks', parentTaskId: 'tasks', reviewTaskId: 'tasks',
  planId: 'plans', epicId: 'epics', storyId: 'stories', sprintId: 'sprints', meetingId: 'meetings', targetedTrainingId: 'tasks',
};
const many = { dependencies: 'tasks', taskIds: 'tasks', storyIds: 'stories', agentIds: 'agents' };

function array(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20_000) throw new Error(`Некорректный список «${label}».`);
  return value;
}

function id(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\x00-\x1f]/.test(value)) throw new Error('Некорректный идентификатор при импорте.');
  return value;
}

export function normalizeImport(payload, studioSettings, agentSettings) {
  object(payload, 'импорт');
  const input = object(payload.studio, 'студия');
  const studioId = id(input.id);
  const agents = array(input.agents, 'agents').map((row) => {
    object(row, 'роль');
    return {
      id: id(row.id), ...agentSettings(row), ...(row.key ? { key: field(row.key, 'ключ роли', 256) } : {}),
      ...(row.systemRole === 'coach' ? { systemRole: 'coach', role: 'library' } : {}),
      ...(row.trainingTaskId === undefined ? {} : { trainingTaskId: id(row.trainingTaskId), skillIds: array(row.skillIds, 'навыки агента') }),
    };
  });
  if (agents.filter(({ systemRole }) => systemRole === 'coach').length > 1) throw new Error('При импорте обнаружены два коуча агентов.');
  const normalized = {
    trainRoster: payload.trainRoster === true && input.lifecycle === 'draft',
    studio: {
      ...studioSettings(input), id: studioId, agents,
      lifecycle: input.lifecycle === 'draft' ? 'draft' : 'paused',
      ...(input.lifecycle === 'draft' ? {} : { importedPaused: true }),
    },
  };
  const date = new Date().toISOString();
  for (const table of collections) {
    normalized[table] = array(payload[table], table).map((value) => {
      const item = object(value, table);
      if (item.studioId !== undefined && item.studioId !== studioId) throw new Error('Импорт содержит запись другой студии.');
      const row = { ...item, id: id(item.id), studioId };
      if (table === 'tasks') {
        delete row.workflowManaged;
        delete row.activeAgentId;
        if (row.legacyWorktreeReview !== undefined && typeof row.legacyWorktreeReview !== 'boolean') {
          throw new Error('Некорректная отметка сверки рабочего дерева.');
        }
        row.title = field(row.title, 'название задачи');
        row.prompt ??= row.title;
        if (!statuses.includes(row.status ??= 'queued')) throw new Error('Некорректный статус задачи.');
        if (!stages.includes(row.stage ??= row.status === 'completed' ? 'done' : 'ready')) throw new Error('Некорректный этап задачи.');
        if (['scheduled', 'running'].includes(row.status)) {
          row.status = 'interrupted';
          row.stage = 'blocked';
        }
        row.summary ??= '';
        row.artifact ??= '';
        row.error ??= '';
        row.dependencies ??= [];
        row.createdAt ??= date;
        row.updatedAt ??= date;
        if (row.artifactPath) row.artifactPath = relativeArtifactPath(row.artifactPath);
        if (row.artifactTarget) row.artifactTarget = relativeArtifactPath(row.artifactTarget);
        if (row.kind === 'train') {
          const training = object(row.training, 'обучение');
          row.workflowManaged = true;
          row.training = {
            ...training, targetAgentId: id(training.targetAgentId), objective: field(training.objective, 'цель обучения'),
            topics: trainingTopics(training.topics), selected: undefined,
          };
          if (row.stage !== 'done') {
            row.stage = row.dependencies.length ? 'backlog' : 'ready';
            row.status = 'queued';
            row.training.skillIds = undefined;
          } else {
            if (row.status !== 'completed') throw new Error('В импорте отсутствует подтверждение завершения обучения.');
            row.review = field(row.review, 'решение Директора');
            row.training.guide = field(training.guide, 'проверенное руководство', 16_000);
            if (!training.bootstrap) row.training.exercise = field(training.exercise, 'проверенное упражнение');
          }
        }
      }
      if (table === 'skills') {
        const path = relativeArtifactPath(row.path).split('/').map(encodeURIComponent).join('/');
        if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(row.repo) || !/^[a-f0-9]{40}$/i.test(row.commit)
          || !Number.isSafeInteger(row.stars) || row.stars < 0 || typeof row.content !== 'string' || row.content.length > 256_000
          || row.url !== `https://github.com/${row.repo}/blob/${row.commit}/${path}`) throw new Error('Некорректная закреплённая версия навыка.');
      }
      if (table === 'inbox') {
        row.createdAt ??= date;
        row.answer ??= '';
        if (!['open', 'resolved'].includes(row.status)) throw new Error('Некорректный статус сообщения.');
        if (!row.taskId && !['plan', 'error'].includes(row.kind)) throw new Error('Сообщение должно ссылаться на задачу.');
        if (row.kind === 'plan') {
          id(row.planId);
          if (row.status === 'open') row.status = 'resolved';
        }
      }
      if (table === 'plans' && row.status === 'pending') row.status = 'returned';
      return row;
    });
  }
  const byTable = { ...normalized, agents };
  const ids = Object.fromEntries([...collections, 'agents'].map((name) => {
    const set = new Set(byTable[name].map((row) => row.id));
    if (set.size !== byTable[name].length) throw new Error(`Повторяющийся идентификатор в разделе «${name}».`);
    return [name, set];
  }));
  for (const name of collections) {
    for (const row of normalized[name]) {
      for (const [key, target] of Object.entries(relations)) {
        if (row[key] != null && !ids[target].has(row[key])) throw new Error(`Некорректная связь «${key}» при импорте.`);
      }
      for (const [key, target] of Object.entries(many)) {
        if (array(row[key], key).some((value) => !ids[target].has(value))) throw new Error(`Некорректная связь «${key}» при импорте.`);
      }
      if (name === 'tasks' && row.kind === 'train' && (!ids.agents.has(row.training.targetAgentId)
        || array(row.training.skillIds, 'навыки обучения').some((skillId) => !ids.skills.has(skillId)))) throw new Error('Некорректная связь обучения при импорте.');
    }
  }
  const taskById = new Map(normalized.tasks.map((task) => [task.id, task]));
  const coach = agents.find(({ systemRole }) => systemRole === 'coach');
  const linkedSkills = new Set();
  for (const task of normalized.tasks) {
    if (task.kind !== 'train') continue;
    const bootstrap = task.training.bootstrap === true;
    if (!coach || task.agentId !== coach.id || task.reviewerId != null || bootstrap !== (task.training.targetAgentId === coach.id)
      || (bootstrap ? task.dependencies.length || coach.trainingTaskId !== task.id : task.dependencies.some((dependency) => dependency !== coach.trainingTaskId))) {
      throw new Error('Некорректный маршрут обучения при импорте.');
    }
    if (task.stage === 'done') for (const id of task.training.skillIds ?? []) linkedSkills.add(id);
  }
  if (normalized.skills.some(({ id }) => !linkedSkills.has(id))) throw new Error('В импорте отсутствует подтверждение закреплённой версии навыка.');
  for (const agent of agents) {
    if (!agent.trainingTaskId) continue;
    const task = taskById.get(agent.trainingTaskId);
    if (task?.kind !== 'train' || task.training.targetAgentId !== agent.id || agent.skillIds.some((skillId) => !ids.skills.has(skillId))) {
      throw new Error('Некорректная связь агента с обучением при импорте.');
    }
    agent.trainingStatus = task.stage === 'done' ? 'ready' : 'pending';
    const approvals = normalized.tasks.filter((candidate) => candidate.kind === 'train' && candidate.stage === 'done' && candidate.training.targetAgentId === agent.id);
    const approvedIds = new Set(approvals.flatMap(({ training }) => training.skillIds ?? []));
    if (agent.skillIds.some((skillId) => !approvedIds.has(skillId))) throw new Error('В импорте отсутствует подтверждение выбранного навыка.');
    const lastApproved = approvals.at(-1);
    if (lastApproved) agent.trainingGuide = lastApproved.training.guide;
  }
  return normalized;
}
