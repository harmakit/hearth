import { field, object, relativeArtifactPath, trainingTopics } from './protocol.mjs';
import { materialMetadata, customSkillDraft, knowledgeNoteLimit } from './knowledge.mjs';

const learningCollections = ['knowledge', 'customSkills'];
const collections = ['tasks', 'inbox', 'plans', 'epics', 'stories', 'sprints', 'meetings', 'skills', ...learningCollections];
const statuses = ['queued', 'scheduled', 'running', 'waiting', 'completed', 'failed', 'interrupted'];
const stages = ['backlog', 'ready', 'in_progress', 'review', 'qa', 'done', 'blocked'];
const relations = {
  agentId: 'agents', reviewerId: 'agents', taskId: 'tasks', parentTaskId: 'tasks', reviewTaskId: 'tasks',
  planId: 'plans', epicId: 'epics', storyId: 'stories', sprintId: 'sprints', meetingId: 'meetings', targetedTrainingId: 'tasks',
  trainingTaskId: 'tasks', debtTaskId: 'tasks',
};
const many = { dependencies: 'tasks', taskIds: 'tasks', storyIds: 'stories', agentIds: 'agents' };

function array(value, label, max = 20_000) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) throw new Error(`Некорректный список «${label}».`);
  return value;
}

function id(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\x00-\x1f]/.test(value)) throw new Error('Некорректный идентификатор при импорте.');
  return value;
}

const preserveText = value => value;

function copyMaterial(value, text, draft) {
  const metadata = materialMetadata(value);
  for (const [key, max] of [['title', 240], ['source', 120], ['revision', 240], ['license', 240]]) {
    metadata[key] = text(metadata[key]).slice(0, max);
  }
  if (draft && value.excerpt !== undefined) {
    if (typeof value.excerpt !== 'string' || value.excerpt.length > 2_500) throw new Error('Некорректная выдержка из материала.');
    metadata.excerpt = text(value.excerpt).slice(0, 2_500);
  }
  return metadata;
}

function copyCustomSkill(value, text) {
  const skill = customSkillDraft(value);
  return { ...skill, title: text(skill.title).slice(0, 120), content: text(skill.content).slice(0, 4000) };
}

export function copyKnowledgeRecord(kind, item, text = preserveText) {
  const createdAt = text(field(item.createdAt, 'дата подтверждения', 64)).slice(0, 64);
  if (kind === 'knowledge') {
    return {
      notes: text(field(item.notes, 'знания агента', knowledgeNoteLimit)).slice(0, knowledgeNoteLimit),
      sources: array(item.sources, 'источники знаний', 3).map(source => copyMaterial(source, text, false)),
      createdAt,
    };
  }
  if (!Number.isSafeInteger(item.version) || item.version < 1) throw new Error('Некорректная версия авторского навыка.');
  return { ...copyCustomSkill(item, text), version: item.version, createdAt };
}

export function copyTrainingMaterials(training, approved, text = preserveText) {
  const fields = {};
  if (training.materialWarnings !== undefined) {
    fields.materialWarnings = array(training.materialWarnings, 'предупреждения поиска материалов', 8)
      .map(warning => text(field(warning, 'предупреждение поиска материалов', 500)).slice(0, 500));
  }
  if (training.materialSearchOutcome !== undefined) {
    fields.materialSearchOutcome = text(field(training.materialSearchOutcome, 'статус поиска материалов', 80)).slice(0, 80);
  }
  if (training.selectedMaterialIds !== undefined) {
    fields.selectedMaterialIds = array(training.selectedMaterialIds, 'выбранные материалы', 3).map(value => field(value, 'идентификатор материала', 512));
  }
  if (training.materials !== undefined) {
    fields.materials = array(training.materials, 'материалы', 3).map(value => copyMaterial(value, text, !approved));
  }
  if (!approved) {
    if (training.knowledge !== undefined) fields.knowledge = text(field(training.knowledge, 'знания агента', knowledgeNoteLimit)).slice(0, knowledgeNoteLimit);
    if (training.customSkills !== undefined) {
      fields.customSkills = array(training.customSkills, 'предложения навыков', 3).map(value => copyCustomSkill(value, text));
    }
  }
  return fields;
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
      ...(input.debtAssessment !== undefined && input.lifecycle !== 'draft' ? { debtAssessment: {
        reason: field(object(input.debtAssessment, 'оценка долга').reason, 'причина оценки долга', 2_000),
        assessedAt: field(input.debtAssessment.assessedAt, 'дата оценки долга', 64),
      } } : {}),
      lifecycle: input.lifecycle === 'draft' ? 'draft' : 'paused',
      ...(input.lifecycle === 'draft' ? {} : { importedPaused: true }),
    },
  };
  const date = new Date().toISOString();
  for (const table of collections) {
    normalized[table] = array(payload[table], table).map((value) => {
      const item = object(value, table);
      if (item.studioId !== undefined && item.studioId !== studioId) throw new Error('Импорт содержит запись другой студии.');
      if (learningCollections.includes(table)) {
        return { id: id(item.id), studioId, agentId: id(item.agentId), trainingTaskId: id(item.trainingTaskId), ...copyKnowledgeRecord(table, item) };
      }
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
          const { knowledgeId, customSkillIds, ...storedTraining } = training;
          delete storedTraining.knowledge;
          delete storedTraining.customSkills;
          row.workflowManaged = true;
          row.training = {
            ...storedTraining, ...copyTrainingMaterials(training, row.stage === 'done'),
            targetAgentId: id(training.targetAgentId), objective: field(training.objective, 'цель обучения'),
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
            if (knowledgeId !== undefined) row.training.knowledgeId = id(knowledgeId);
            if (customSkillIds !== undefined) row.training.customSkillIds = array(customSkillIds, 'авторские навыки', 3).map(id);
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
  for (const plan of normalized.plans) {
    for (const entry of [plan, ...array(plan.tasks, 'задачи плана')]) {
      if (entry.debtTaskId != null && taskById.get(entry.debtTaskId)?.kind !== 'debt') {
        throw new Error('Некорректная связь с задачей техдолга при импорте.');
      }
    }
  }
  const knowledgeById = new Map(normalized.knowledge.map(row => [row.id, row]));
  const customSkillsById = new Map(normalized.customSkills.map(row => [row.id, row]));
  const coach = agents.find(({ systemRole }) => systemRole === 'coach');
  const linkedSkills = new Set();
  const linkedKnowledge = new Set();
  const linkedCustomSkills = new Set();
  function linkMaterial(record, task, linked) {
    if (!record || record.agentId !== task.training.targetAgentId || record.trainingTaskId !== task.id || linked.has(record.id)) {
      throw new Error('Некорректная связь утверждённых материалов обучения при импорте.');
    }
    linked.add(record.id);
  }
  for (const task of normalized.tasks) {
    if (task.kind !== 'train') continue;
    const bootstrap = task.training.bootstrap === true;
    if (!coach || task.agentId !== coach.id || task.reviewerId != null || bootstrap !== (task.training.targetAgentId === coach.id)
      || (bootstrap ? task.dependencies.length || coach.trainingTaskId !== task.id : task.dependencies.some((dependency) => dependency !== coach.trainingTaskId))) {
      throw new Error('Некорректный маршрут обучения при импорте.');
    }
    if (task.stage === 'done') {
      for (const id of task.training.skillIds ?? []) linkedSkills.add(id);
      if (task.training.knowledgeId !== undefined) linkMaterial(knowledgeById.get(task.training.knowledgeId), task, linkedKnowledge);
      for (const id of task.training.customSkillIds ?? []) linkMaterial(customSkillsById.get(id), task, linkedCustomSkills);
    }
  }
  if (normalized.skills.some(({ id }) => !linkedSkills.has(id))) throw new Error('В импорте отсутствует подтверждение закреплённой версии навыка.');
  if (linkedKnowledge.size !== normalized.knowledge.length || linkedCustomSkills.size !== normalized.customSkills.length) {
    throw new Error('В импорте отсутствует подтверждение знаний или авторского навыка.');
  }
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
