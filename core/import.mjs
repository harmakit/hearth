import { field, object, relativeArtifactPath } from './protocol.mjs';

const collections = ['tasks', 'inbox', 'plans', 'epics', 'stories', 'sprints', 'meetings'];
const statuses = ['queued', 'scheduled', 'running', 'waiting', 'completed', 'failed', 'interrupted'];
const stages = ['backlog', 'ready', 'in_progress', 'review', 'qa', 'done', 'blocked'];
const relations = {
  agentId: 'agents', reviewerId: 'agents', taskId: 'tasks', parentTaskId: 'tasks', reviewTaskId: 'tasks',
  planId: 'plans', epicId: 'epics', storyId: 'stories', sprintId: 'sprints', meetingId: 'meetings',
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
    return { id: id(row.id), ...agentSettings(row), ...(row.key ? { key: field(row.key, 'ключ роли', 256) } : {}) };
  });
  const normalized = {
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
    }
  }
  return normalized;
}
