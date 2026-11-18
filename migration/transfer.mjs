import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, posix, win32 } from 'node:path';
import { prepareLegacySnapshot } from './legacy.mjs';
import { copyKnowledgeRecord, copyLegacyContract, copyReferences, copyTaskLinks, copyTrainingMaterials, historicalCollections, isIndependentKnowledge } from '../core/import.mjs';
import { hasPoints, normalizeDebtPolicy } from '../core/debt.mjs';
import { field } from '../core/protocol.mjs';

const format = 'hearth-studio';
const version = 2;
const learningCollections = ['knowledge', 'customSkills'];
const collections = ['tasks', 'inbox', 'plans', 'epics', 'stories', 'sprints', 'meetings', 'skills', ...learningCollections, ...historicalCollections];
const maxRecords = 20_000;
const maxArtifactBytes = 1024 * 1024;
const maxArtifactsBytes = 8 * maxArtifactBytes;
const maxArtifacts = 50;
export const maxEvidenceBytes = 16 * 1024 * 1024;
const modes = ['template', 'snapshot'];
const stages = ['backlog', 'ready', 'in_progress', 'review', 'qa', 'done', 'blocked', 'replaced'];
const statuses = ['queued', 'scheduled', 'running', 'waiting', 'completed', 'failed', 'interrupted'];

const fields = {
  studio: ['name', 'brief', 'language', 'projectLanguage', 'allowedMode'],
  agent: ['key', 'name', 'description', 'role', 'roleTitle', 'mode', 'runtime', 'model', 'effort', 'systemRole'],
  director: ['runtime', 'model', 'effort'],
  tasks: ['key', 'title', 'prompt', 'summary', 'artifact', 'error', 'review', 'directorDecision', 'createdAt', 'updatedAt', 'legacyId', 'legacyStatus', 'legacyBranch', 'kind', 'type', 'debtCategory'],
  inbox: ['title', 'body', 'status', 'kind', 'answer', 'createdAt', 'updatedAt', 'legacyId'],
  plans: ['title', 'goal', 'status', 'kind', 'feedback', 'createdAt', 'updatedAt', 'decidedAt', 'legacyId'],
  epics: ['title', 'goal', 'description', 'status', 'createdAt', 'updatedAt', 'legacyId'],
  stories: ['title', 'goal', 'description', 'status', 'createdAt', 'updatedAt', 'legacyId'],
  sprints: ['title', 'goal', 'description', 'summary', 'status', 'createdAt', 'updatedAt', 'closedAt', 'legacyId'],
  meetings: ['title', 'summary', 'body', 'description', 'status', 'kind', 'decision', 'createdAt', 'updatedAt', 'legacyId', 'agenda', 'ownerReason'],
  skills: ['repo', 'commit', 'path', 'title', 'license', 'url', 'content'],
  phases: ['title', 'goal', 'status', 'createdAt', 'updatedAt'],
  prerequisites: ['consumerType', 'skillRef', 'reason', 'criterion', 'createdAt'],
  meeting_actions: ['kind', 'title', 'prompt', 'criteria', 'createdAt'],
  conversations: ['createdAt'],
  conversationMessages: ['author', 'kind', 'status', 'text', 'createdAt', 'processedAt', 'receivedAt'],
  usageEvents: ['runtime', 'provider', 'model', 'role', 'capturedAt'],
  rosterProposals: ['kind', 'reason', 'firstResult', 'initiator', 'status', 'createdAt', 'decidedAt', 'decidedBy'],
  knowledgeEvents: ['kind', 'key', 'layer', 'action', 'reason', 'createdAt'],
};

const links = {
  agentId: 'agents', reviewerId: 'agents', taskId: 'tasks', parentTaskId: 'tasks', reviewTaskId: 'tasks',
  planId: 'plans', epicId: 'epics', storyId: 'stories', sprintId: 'sprints', meetingId: 'meetings', targetedTrainingId: 'tasks',
  trainingTaskId: 'tasks', debtTaskId: 'tasks',
  conversationId: 'conversations', replyTo: 'conversationMessages', replyId: 'conversationMessages', phaseId: 'phases',
  facilitatorId: 'agents', transferAgentId: 'agents', firstTaskId: 'tasks', rosterProposalId: 'rosterProposals',
  rollbackProposalId: 'rosterProposals', proposalId: 'rosterProposals', trainTaskId: 'tasks',
  dependencies: 'tasks', taskIds: 'tasks', storyIds: 'stories', agentIds: 'agents',
  epicIds: 'epics', sprintIds: 'sprints', actionIds: 'meeting_actions', originalTaskIds: 'tasks', attachmentIds: 'evidence',
  answerAttachmentIds: 'evidence', blockedTaskIds: 'tasks',
};
const listLinks = new Set(['dependencies', 'taskIds', 'storyIds', 'agentIds', 'epicIds', 'sprintIds', 'actionIds', 'originalTaskIds',
  'attachmentIds', 'answerAttachmentIds', 'blockedTaskIds']);

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Неверный формат раздела «${label}».`);
  return value;
}

function list(value, label, max = maxRecords) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) throw new Error(`Неверный формат списка «${label}».`);
  return value;
}

function identifier(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\x00-\x1f]/.test(value)) {
    throw new Error('Неверный формат идентификатора записи.');
  }
  return value;
}

export function portablePath(path) {
  if (typeof path !== 'string' || path.length > 512 || path !== path.trim() || posix.isAbsolute(path) || win32.isAbsolute(path) ||
      /[\\:\x00-\x1f\x7f]/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) {
    throw new Error('Укажите безопасный относительный путь.');
  }
  return path;
}

function destinationRoot(root) {
  if (typeof root !== 'string' || !isAbsolute(root) || root.includes('\0')) throw new Error('Укажите абсолютный путь к новой папке проекта.');
  return root;
}

function filterText(value, oldRoot) {
  if (typeof value !== 'string') return undefined;
  const result = oldRoot ? value.replaceAll(oldRoot, '[папка проекта]') : value;
  return result
    .replace(/["'](?:\/[^/]|[A-Za-z]:[\\/]|\\\\)[^"'\r\n]*["']/g, '[локальный путь]')
    .replace(/(^|[\s'"\x60(<[{=])(?:\/(?!\/)[^\s'"\x60<>()[\]{},;]+|[A-Za-z]:[\\/][^\s'"\x60<>()[\]{},;]+|\\\\[^\s'"\x60<>()[\]{},;]+)/g, '$1[локальный путь]');
}

function copyFields(source, names, text) {
  const output = {};
  for (const key of names) if (typeof source[key] === 'string') output[key] = text(source[key]);
  return output;
}

function textList(value, label, text) {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return text(value);
  return list(value, label).map(entry => {
    if (typeof entry !== 'string') throw new Error(`Неверный формат списка «${label}».`);
    return text(entry);
  });
}

function selectedPath(path) {
  portablePath(path);
  if (path.split('/').some(part => part.startsWith('.') || part !== part.trim())) throw new Error('Укажите путь к файлу в открытой папке проекта.');
  return path;
}

function artifactRecords(value) {
  let bytes = 0;
  const paths = new Set();
  return list(value, 'артефакты', maxArtifacts).map(record => {
    const { path, content } = object(record, 'артефакт');
    selectedPath(path);
    const key = path.normalize('NFC').toLowerCase();
    if (paths.has(key)) throw new Error('Путь к артефакту повторяется.');
    paths.add(key);
    if (typeof content !== 'string' || content.includes('\0')) throw new Error('Можно перенести только текстовый артефакт.');
    const size = Buffer.byteLength(content);
    bytes += size;
    if (size > maxArtifactBytes || bytes > maxArtifactsBytes) throw new Error('Превышен допустимый размер артефактов.');
    return { path, content };
  });
}

function copyRevision(value) {
  const revision = object(value, 'версия результата');
  const result = {};
  for (const key of ['baseOid', 'headOid', 'targetOid', 'candidateOid', 'digest']) {
    if (revision[key] === undefined) continue;
    const pattern = key === 'digest' ? /^[a-f0-9]{64}$/i : /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
    if (typeof revision[key] !== 'string' || !pattern.test(revision[key])) throw new Error('Неверный идентификатор версии результата.');
    result[key] = revision[key];
  }
  if (!result.digest) throw new Error('Отсутствует контрольная сумма версии результата.');
  return result;
}

function evidenceRecords(records, options) {
  const { link, sourceStudioId, studioId, opaque, text } = options;
  let totalBytes = 0;
  const ids = new Set();
  return list(records, 'файлы доказательств', maxArtifacts).map(entry => {
    const { id, taskId, attemptId = id, revision, sourcePath, size, digest, contentType, kind, recordedAt, content } = object(entry, 'доказательство');
    identifier(id);
    identifier(attemptId);
    if (ids.has(id)) throw new Error('Идентификатор доказательства повторяется.');
    ids.add(id);
    if (typeof content !== 'string' || content.length > 4 * Math.ceil(maxEvidenceBytes / 3)) {
      throw new Error('Недопустимый размер содержимого доказательства.');
    }
    const bytes = Buffer.from(content, 'base64');
    totalBytes += bytes.length;
    if (totalBytes > maxEvidenceBytes) throw new Error('Превышен допустимый размер выбранных доказательств.');
    if (content !== bytes.toString('base64') || size !== bytes.length || digest !== createHash('sha256').update(bytes).digest('hex')) {
      throw new Error('Контрольная сумма или содержимое доказательства изменилось.');
    }
    if (typeof contentType !== 'string' || !/^[\w.+-]{1,64}\/[\w.+-]{1,64}$/.test(contentType)) throw new Error('Недопустимый тип содержимого доказательства.');
    const mappedTaskId = kind === 'attachment' && taskId === sourceStudioId ? studioId : link('tasks', taskId);
    if (!mappedTaskId) throw new Error('Доказательство не связано с задачей студии.');
    const attachmentRevision = kind === 'attachment' && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(revision?.digest);
    return {
      id: link('evidence', id), studioId, taskId: mappedTaskId, attemptId: opaque('attempt', attemptId),
      revision: attachmentRevision ? { digest } : copyRevision(revision),
      sourcePath: selectedPath(sourcePath), size, digest, contentType, content,
      kind: text(field(kind, 'вид доказательства', 64)),
      ...(typeof recordedAt === 'string' && { recordedAt: text(field(recordedAt, 'дата доказательства', 64)) }),
    };
  });
}

function inboxFields(record, text, link) {
  function questionVersion(value) {
    const row = object(value, 'версия вопроса');
    const result = copyFields(row, ['title', 'body', 'context', 'status', 'answer', 'answerDecision', 'createdAt', 'answeredAt'], text);
    for (const key of ['version', 'answerVersion']) {
      if (row[key] === undefined) continue;
      if (!Number.isSafeInteger(row[key]) || row[key] < 1) throw new Error('Некорректная версия вопроса.');
      result[key] = row[key];
    }
    for (const key of ['choiceId', 'answerChoiceId']) {
      if (row[key] != null) result[key] = identifier(row[key]);
    }
    for (const key of ['choices', 'options']) {
      if (row[key] === undefined) continue;
      result[key] = list(row[key], 'варианты ответа', 50).map(entry => {
        const choice = object(entry, 'вариант ответа');
        return { ...copyFields(choice, ['label', 'title', 'text', 'description', 'answer', 'decision'], text), id: identifier(choice.id) };
      });
    }
    for (const [key, target] of [['attachmentIds', 'evidence'], ['answerAttachmentIds', 'evidence'], ['blockedTaskIds', 'tasks']]) {
      if (row[key] !== undefined) result[key] = list(row[key], key).map(id => link(target, id)).filter(Boolean);
    }
    return result;
  }
  const result = questionVersion(record);
  for (const key of ['versions', 'history']) {
    if (record[key] !== undefined) result[key] = list(record[key], 'история вопроса').map(questionVersion);
  }
  if (record.kind === 'reconcile' && record.status === 'open') {
    result.status = 'resolved';
    result.answer ||= 'Сохранено в истории импорта.';
  }
  return result;
}

function copyGitHistory(value, text, link, opaque) {
  const git = object(value, 'история Git-задачи');
  const result = { ...copyFields(git, ['status'], text), ...(git.revision && { revision: copyRevision(git.revision) }) };
  result.checks = list(git.checks, 'проверки Git-задачи').map(entry => {
    const check = object(entry, 'проверка Git-задачи');
    return {
      ...copyFields(check, ['label', 'status', 'detail', 'reason', 'stdout', 'stderr', 'output', 'startedAt', 'finishedAt'], text),
      ...(check.checkId && { checkId: opaque('check', check.checkId) }),
      ...(check.id && { id: opaque('check', check.id) }),
      ...(check.revision && { revision: copyRevision(check.revision) }),
      ...(typeof check.required === 'boolean' && { required: check.required }),
      ...(check.phase === 'work' || check.phase === 'candidate' ? { phase: check.phase } : {}),
      ...(check.evidenceIds !== undefined && { evidenceIds: list(check.evidenceIds, 'материалы проверки').map(id => link('evidence', id)).filter(Boolean) }),
    };
  });
  if (git.receipt !== undefined && git.receipt !== null) {
    const receipt = object(git.receipt, 'историческая квитанция');
    result.receipt = {
      ...copyFields(receipt, ['result', 'summary', 'createdAt', 'reviewedAt'], text),
      ...(receipt.id && { id: opaque('receipt', receipt.id) }),
      ...(receipt.taskId && { taskId: link('tasks', receipt.taskId) }),
      ...(receipt.reviewerId && { reviewerId: link('agents', receipt.reviewerId) }),
      ...(receipt.revision && { revision: copyRevision(receipt.revision) }),
      checkIds: list(receipt.checkIds, 'проверки квитанции').map(id => opaque('check', id)),
    };
  }
  return result;
}

function planFields(record, text, agentIds, selectedPaths, link) {
  const output = {};
  for (const key of ['epic', 'story']) {
    if (record[key] === undefined) continue;
    const item = object(record[key], key);
    output[key] = copyFields(item, ['title', 'description', 'goal'], text);
    if (item.acceptance !== undefined) output[key].acceptance = textList(item.acceptance, 'приёмка', text);
  }
  const draftFields = {
    agents: fields.agent,
    tasks: ['title', 'prompt', 'description', 'agent', 'agentKey', 'reviewerKey', 'key', 'role'],
  };
  for (const key of ['agents', 'tasks']) {
    if (record[key] === undefined) continue;
    output[key] = list(record[key], key).map(entry => {
      const item = object(entry, key);
      const copy = copyFields(item, draftFields[key], text);
      for (const detail of ['criteria', 'dependencies', 'dependsOn', 'trainingTopics']) {
        const value = textList(item[detail], detail, text);
        if (value !== undefined) copy[detail] = value;
      }
      if (key === 'tasks') {
        for (const field of ['agentKey', 'reviewerKey']) if (agentIds.has(item[field])) copy[field] = agentIds.get(item[field]);
        if (item.artifactPath !== undefined) copy.artifactPath = portablePath(item.artifactPath);
        if (typeof item.requiresAcceptance === 'boolean') copy.requiresAcceptance = item.requiresAcceptance;
        if (item.kind === 'debt') copy.kind = 'debt';
        if (item.debtTaskId !== undefined) copy.debtTaskId = link('tasks', item.debtTaskId);
        if (item.backlogTaskId !== undefined) copy.backlogTaskId = link('tasks', item.backlogTaskId);
        if (hasPoints(item.points)) copy.points = item.points;
      } else {
        if (agentIds.has(item.key)) copy.key = agentIds.get(item.key);
        if (item.recommendation !== undefined) {
          copy.recommendation = copyFields(object(item.recommendation, 'рекомендация модели'), fields.director, text);
        }
      }
      return copy;
    });
  }
  if (record.files !== undefined) {
    output.files = list(record.files, 'файлы плана').map(entry => {
      const file = object(entry, 'файл плана');
      return { path: portablePath(file.path) };
    });
  }
  if (record.publishedFiles !== undefined) {
    const paths = list(record.publishedFiles, 'опубликованные файлы плана')
      .map(entry => portablePath(typeof entry === 'string' ? entry : object(entry, 'файл плана').path));
    output.publishedFiles = [...new Set(paths.filter(path => selectedPaths.has(path)))];
  }
  return output;
}

function meetingFields(record, text, link, opaque) {
  const result = {};
  const phaseStages = ['positions', 'facilitation', 'objections', 'owner_review'];
  const action = item => {
    const value = object(item, 'действие встречи');
    const fields = copyFields(value, ['kind', 'title', 'prompt', 'criteria'], text);
    const agentId = value.agentId && link('agents', value.agentId);
    return { ...fields, ...(agentId && { agentId }) };
  };
  const decisions = value => typeof value === 'string' ? text(value) : list(value, 'решения встречи').map(item =>
    typeof item === 'string' ? text(item) : copyFields(object(item, 'решение встречи'), ['text', 'rationale', 'verification'], text));
  const outcome = value => ({ ...copyFields(object(value, 'итог встречи'), ['summary'], text),
    decisions: decisions(value.decisions), actionItems: list(value.actionItems, 'действия встречи').map(action) });
  if (record.decisions !== undefined) result.decisions = decisions(record.decisions);
  if (record.participants !== undefined) {
    result.participants = record.version === undefined ? textList(record.participants, 'участники', text)
      : list(record.participants, 'участники').map(id => link('agents', id)).filter(Boolean);
  }
  if (record.positions !== undefined) result.positions = list(record.positions, 'позиции участников').flatMap(item => {
    const position = object(item, 'позиция участника');
    const agentId = link('agents', position.agentId);
    return agentId ? [{ ...copyFields(position, ['purpose', 'text', 'createdAt'], text), agentId,
      ...(position.attemptId && { attemptId: opaque('attempt', position.attemptId) }),
      ...(Number.isSafeInteger(position.version) && { version: position.version }),
      ...(position.superseded === true && { superseded: true }) }] : [];
  });
  if (record.actionItems !== undefined) result.actionItems = list(record.actionItems, 'действия встречи').map(action);
  if (record.resolution) {
    result.resolution = { ...copyFields(object(record.resolution, 'результат встречи'), ['source', 'createdAt'], text),
      version: record.resolution.version, outcome: outcome(record.resolution.outcome) };
  }
  if (record.proposedOutcome) result.proposedOutcome = outcome(record.proposedOutcome);
  if (record.stage === 'resolved') result.stage = 'resolved';
  if (phaseStages.includes(record.stage) || record.stage === 'held') {
    result.stage = 'held';
    result.heldFrom = phaseStages.includes(record.heldFrom) ? record.heldFrom : phaseStages.includes(record.stage) ? record.stage : 'positions';
  }
  if (record.objectionRound) result.objectionRound = {
    ...copyFields(object(record.objectionRound, 'обсуждение возражений'), ['question', 'createdAt'], text),
    agentIds: list(record.objectionRound.agentIds, 'участники обсуждения').map(id => link('agents', id)).filter(Boolean),
  };
  const materialTargets = { artifact: 'tasks', evidence: 'evidence', skill: 'skills', task: 'tasks' };
  if (record.materialRefs !== undefined) result.materialRefs = list(record.materialRefs, 'материалы встречи').flatMap(value => {
    const entry = object(value, 'материал встречи');
    if (!Object.hasOwn(materialTargets, entry.type)) throw new Error('Неизвестный тип материала встречи.');
    const id = link(materialTargets[entry.type], entry.id);
    return id ? [{ ...copyFields(entry, ['type', 'digest', 'revisionDigest'], text), id }] : [];
  });
  return result;
}

function linkedFields(value, text, link, { string = [], number = [], refs = {} }) {
  const row = object(value, 'историческая запись');
  const output = copyFields(row, string, text);
  for (const key of number) {
    if (row[key] === null || Number.isFinite(row[key]) && row[key] >= 0) output[key] = row[key];
  }
  for (const [key, target] of Object.entries(refs)) {
    if (row[key] !== undefined) output[key] = row[key] === null ? null : link(target, row[key]) ?? null;
  }
  return output;
}

function carryover(value, text, link) {
  return linkedFields(value, text, link, { string: ['stage', 'fromStage', 'reason', 'at'], number: ['revision', 'failedReviews'],
    refs: { taskId: 'tasks', fromSprintId: 'sprints', sprintId: 'sprints' } });
}

function retrospective(value, text, link, studioId) {
  const taskIds = value => list(value, 'задачи ретроспективы').map(id => link('tasks', id)).filter(Boolean);
  const report = { ...linkedFields(value, text, link, { number: ['methodVersion'], refs: { sprintId: 'sprints' } }), studioId };
  for (const key of ['planned', 'accepted', 'carried', 'blocked', 'replaced', 'debt']) {
    if (value[key] === undefined) continue;
    report[key] = { ...linkedFields(value[key], text, link, { number: ['count', 'points', 'knownPoints'] }),
      taskIds: taskIds(value[key].taskIds), missingPointTaskIds: taskIds(value[key].missingPointTaskIds) };
  }
  if (value.training) report.training = linkedFields(value.training, text, link, { number: ['count', 'accepted'] });
  if (value.rework) report.rework = linkedFields(value.rework, text, link, { number: ['cycles'] });
  if (value.qa) report.qa = {
    ...linkedFields(value.qa, text, link, { number: ['reviewAttempts', 'completedReviewAttempts', 'failedReviewAttempts', 'rejectedReviews'] }),
    missingReviewTaskIds: taskIds(value.qa.missingReviewTaskIds), missingCheckTaskIds: taskIds(value.qa.missingCheckTaskIds),
    checks: value.qa.checks ? linkedFields(value.qa.checks, text, link, { number: ['total', 'passed', 'failed', 'notAssessed'] }) : null,
  };
  report.missingTaskIds = taskIds(value.missingTaskIds);
  return report;
}

function copyPayload(source, { mode, toBundle, root, name }) {
  const input = object(source.studio, 'студия');
  const text = value => filterText(value, typeof input.root === 'string' && input.root.length > 1 ? input.root : '');
  const studioId = toBundle ? 'studio' : randomUUID();
  const rows = Object.fromEntries(collections.map(key => [key, mode === 'snapshot' ? list(source[key], key) : []]));
  if (toBundle) {
    const trainings = new Map(rows.tasks.filter(isApprovedTraining).map(task => [task.id, task.training]));
    for (const kind of learningCollections) rows[kind] = rows[kind].filter(record => {
      if (isIndependentKnowledge(kind, record)) return true;
      const training = trainings.get(record.trainingTaskId);
      return training?.targetAgentId === record.agentId && (kind === 'knowledge'
        ? training.knowledgeId === record.id : training.customSkillIds?.includes(record.id));
    });
    const tracked = Object.fromEntries(learningCollections.map(kind => [kind, new Set(rows[kind].map(({ id }) => id))]));
    rows.knowledgeEvents = rows.knowledgeEvents.filter(event => {
      const available = tracked[event.kind === 'knowledge' ? 'knowledge' : 'customSkills'];
      return available.has(event.versionId) || available.has(event.previousId);
    });
  } else {
    for (const [kind, records] of Object.entries(rows)) {
      if (records.some(record => object(record, kind).studioId !== input.id)) {
        throw new Error('Пакет содержит запись другой студии.');
      }
    }
  }
  const artifacts = mode === 'snapshot' ? artifactRecords(source.artifacts) : [];
  const selectedPaths = new Set(artifacts.map(({ path }) => path));
  const agents = list(input.agents, 'агенты');
  const evidenceInput = mode === 'snapshot' ? list(source.evidence, 'файлы доказательств', maxArtifacts) : [];
  const ids = {};
  for (const [kind, records] of Object.entries({ ...rows, agents, evidence: evidenceInput })) {
    ids[kind] = new Map();
    for (const [index, value] of records.entries()) {
      const id = identifier(object(value, kind).id);
      if (ids[kind].has(id)) throw new Error(`Идентификатор повторяется в разделе «${kind}».`);
      ids[kind].set(id, toBundle ? `${kind}-${index + 1}` : randomUUID());
    }
  }

  function link(kind, from) {
    const id = ids[kind].get(identifier(from));
    if (!id && !toBundle) throw new Error(`Повреждена связь с записью в разделе «${kind}».`);
    return id;
  }
  const historicalIds = new Map();
  function opaque(kind, value) {
    const key = `${kind}:${identifier(value)}`;
    if (!historicalIds.has(key)) historicalIds.set(key, toBundle ? `${kind}-${historicalIds.size + 1}` : randomUUID());
    return historicalIds.get(key);
  }
  function linkMixed(kinds, value) {
    const key = identifier(value);
    const target = kinds.find(kind => ids[kind].has(key));
    if (target) return link(target, key);
    if (!toBundle) throw new Error('Повреждена связь с исторической записью.');
  }

  const studio = {
    ...copyFields(input, fields.studio, text),
    id: studioId,
    director: copyFields(object(input.director ?? {}, 'подключение директора'), fields.director, text),
    allowed: list(input.allowed, 'доступные модели').map(entry => ({
      ...copyFields(object(entry, 'модель'), fields.director, text),
      efforts: list(entry.efforts, 'уровни усилий').filter(effort => typeof effort === 'string').map(text),
    })),
    agents: agents.map(agent => {
      const trainingTaskId = mode === 'snapshot' && agent.trainingTaskId && link('tasks', agent.trainingTaskId);
      const proposalId = mode === 'snapshot' && agent.rosterProposalId && link('rosterProposals', agent.rosterProposalId);
      return {
        ...copyFields(agent, fields.agent, text), id: ids.agents.get(agent.id),
        ...(agent.legacyContract === undefined ? {} : { legacyContract: copyLegacyContract(agent.legacyContract, text) }),
        ...(trainingTaskId ? { trainingTaskId, skillIds: list(agent.skillIds, 'навыки').map(id => link('skills', id)).filter(Boolean) } : {}),
        ...(mode === 'snapshot' && agent.rosterStatus === 'retired' && { rosterStatus: 'retired' }),
        ...(mode === 'snapshot' && Number.isSafeInteger(agent.rosterVersion) && agent.rosterVersion >= 0 && { rosterVersion: agent.rosterVersion }),
        ...(proposalId && { rosterProposalId: proposalId }),
        ...(mode === 'snapshot' && typeof agent.firstResult === 'string' && { firstResult: text(agent.firstResult) }),
        ...(mode === 'snapshot' && Number.isFinite(agent.estimatedBudget) && agent.estimatedBudget >= 0 && { estimatedBudget: agent.estimatedBudget }),
      };
    }),
    approveSprints: input.approveSprints !== false,
    ...(Number.isSafeInteger(input.skillMinStars) && input.skillMinStars >= 0 ? { skillMinStars: input.skillMinStars } : {}),
    lifecycle: mode === 'template' ? 'draft' : 'paused',
  };
  if (input.debtPolicy !== undefined) {
    studio.debtPolicy = normalizeDebtPolicy(input.debtPolicy);
  }
  if (mode === 'snapshot' && input.debtAssessment !== undefined) {
    const { reason, assessedAt } = object(input.debtAssessment, 'оценка долга');
    studio.debtAssessment = {
      reason: text(field(reason, 'причина оценки долга', 2_000)).slice(0, 2_000),
      assessedAt: text(field(assessedAt, 'дата оценки долга', 64)).slice(0, 64),
    };
  }
  if (!studio.name?.trim()) throw new Error('Укажите название студии.');
  if (!toBundle) {
    studio.root = destinationRoot(root);
    if (name !== undefined && (typeof name !== 'string' || !name.trim())) throw new Error('Укажите название студии.');
    studio.name = name?.trim() ?? studio.name;
  }

  if (!toBundle && list(source.evidence, 'доказательства').some(record => object(record, 'доказательство').studioId !== input.id)) {
    throw new Error('Пакет содержит доказательство другой студии.');
  }
  const evidence = evidenceRecords(evidenceInput, { link, sourceStudioId: input.id, studioId, opaque, text });
  const payload = { studio, artifacts, evidence };
  for (const [kind, records] of Object.entries(rows)) {
    payload[kind] = records.map(record => {
      const identity = { id: ids[kind].get(record.id), studioId };
      if (learningCollections.includes(kind)) {
        const { replacesId, ...material } = copyKnowledgeRecord(kind, record, text);
        const independent = isIndependentKnowledge(kind, record);
        return { ...identity, ...material, agentId: independent && record.agentId == null ? null : link('agents', record.agentId),
          ...(!independent && { trainingTaskId: link('tasks', record.trainingTaskId) }),
          ...(replacesId !== undefined && { replacesId: replacesId === null ? null : link(kind, replacesId) ?? null }) };
      }
      const copy = { ...copyFields(record, fields[kind], kind === 'skills' ? value => value : text), ...identity };
      if (kind === 'skills') copy.stars = record.stars;
      for (const [key, target] of Object.entries(links)) {
        const value = record[key];
        if (value === undefined) continue;
        copy[key] = listLinks.has(key) ? list(value, key).map(id => link(target, id)).filter(Boolean)
          : value === null ? null : link(target, value) ?? null;
      }
      if (record.references !== undefined) copy.references = copyReferences(record.references, link);
      if (kind === 'inbox') Object.assign(copy, inboxFields(record, text, link));
      for (const label of ['criteria', 'acceptance']) {
        if (kind === 'phases') continue;
        const value = textList(record[label], label, text);
        if (value !== undefined) copy[label] = value;
      }
      for (const key of ['version', 'roleVersion', 'priority']) {
        if (Number.isSafeInteger(record[key]) && record[key] >= 0) copy[key] = record[key];
      }
      if (hasPoints(record.points)) copy.points = record.points;
      if (Number.isFinite(record.estimatedBudget) && record.estimatedBudget >= 0) copy.estimatedBudget = record.estimatedBudget;
      if (kind === 'phases') {
        const evidenceIds = value => list(value, 'связанные результаты').map(id => linkMixed(['tasks', 'sprints'], id)).filter(Boolean);
        copy.criteria = list(record.criteria, 'критерии фазы', 30).map(value => {
          const criterion = object(value, 'критерий фазы');
          return { id: opaque('criterion', criterion.id), description: text(field(criterion.description, 'описание критерия')),
            evidenceIds: evidenceIds(criterion.evidenceIds) };
        });
        const transition = value => {
          const item = object(value, 'переход фазы');
          return { ...copyFields(item, ['status', 'proposedAt', 'decidedAt'], text), id: opaque('transition', item.id),
            evidenceIds: evidenceIds(item.evidenceIds) };
        };
        if (record.transition) copy.transition = transition(record.transition);
        copy.transitionHistory = list(record.transitionHistory, 'история фазы').map(transition);
      }
      function consumer(value) {
        const item = object(value, 'потребитель обучения');
        const target = { task: 'tasks', meeting: 'meetings' }[item.consumerType];
        if (!['tasks', 'meetings'].includes(target)) throw new Error('Неверный потребитель обучения.');
        const consumerId = link(target, item.consumerId);
        if (!consumerId) throw new Error('Потребитель обучения не связан со студией.');
        return { ...copyFields(item, ['consumerType', 'skillRef', 'reason', 'criterion'], text), consumerId };
      }
      if (kind === 'prerequisites') {
        Object.assign(copy, consumer(record));
        if (record.exception) copy.exception = copyFields(object(record.exception, 'исключение'), ['author', 'reason', 'createdAt'], text);
        if (record.retired) {
          const retired = object(record.retired, 'прекращённый допуск');
          copy.retired = { ...copyFields(retired, ['reason', 'createdAt'], text),
            ...(retired.replacementAgentId && { replacementAgentId: link('agents', retired.replacementAgentId) }) };
        }
      }
      if (kind === 'meeting_actions' && record.futureConsumer) copy.futureConsumer = consumer(record.futureConsumer);
      if (kind === 'conversationMessages') {
        copy.status = record.status === 'processed' ? 'processed' : 'held';
        if (record.attemptId) copy.attemptId = opaque('attempt', record.attemptId);
        if (typeof record.outcome === 'string') copy.outcome = text(record.outcome);
      }
      if (kind === 'usageEvents') {
        copy.attemptId = opaque('attempt', record.attemptId);
        copy.eventId = opaque('usage-event', record.eventId);
        for (const key of ['input', 'output', 'cacheRead', 'cacheWrite']) {
          copy[key] = Number.isSafeInteger(record[key]) && record[key] >= 0 ? record[key] : null;
        }
      }
      if (kind === 'rosterProposals') {
        if (record.status === 'pending') copy.status = 'held';
        for (const key of ['settings', 'previousSettings']) {
          if (record[key]) copy[key] = copyFields(object(record[key], 'настройки роли'), fields.agent, text);
        }
        for (const key of ['topics', 'limitReasons']) {
          if (record[key] !== undefined) copy[key] = textList(record[key], key, text);
        }
      }
      if (kind === 'knowledgeEvents') {
        const target = { knowledge: 'knowledge', customSkill: 'customSkills' }[record.kind];
        if (!learningCollections.includes(target)) throw new Error('Неверный тип записи библиотеки.');
        for (const key of ['versionId', 'previousId']) {
          if (record[key] !== undefined) copy[key] = record[key] === null ? null : link(target, record[key]) ?? null;
        }
      }
      if (kind === 'meetings' && record.messages !== undefined) {
        copy.messages = list(record.messages, 'реплики встречи').map(message =>
          copyFields(object(message, 'реплика встречи'), ['role', 'text', 'createdAt'], text));
      }
      if (kind === 'meetings') Object.assign(copy, meetingFields(record, text, link, opaque));
      if (kind === 'plans') Object.assign(copy, planFields(record, text, ids.agents, selectedPaths, link));
      if (['plans', 'sprints'].includes(kind) && record.debtSprint === true) copy.debtSprint = true;
      if (['sprints', 'meetings'].includes(kind) && record.retrospective) copy.retrospective = retrospective(record.retrospective, text, link, studioId);
      if (kind === 'sprints') {
        if (record.carryovers !== undefined) copy.carryovers = list(record.carryovers, 'решения о переносе').map(item => carryover(item, text, link));
        if (record.closedTasks !== undefined) copy.closedTasks = list(record.closedTasks, 'задачи закрытого спринта').map(item =>
          linkedFields(item, text, link, { string: ['title', 'kind', 'stage', 'status', 'summary'], number: ['points'], refs: { taskId: 'tasks' } }));
        if (record.plannedWork !== undefined) copy.plannedWork = list(record.plannedWork, 'план работ спринта').map(item =>
          linkedFields(item, text, link, { number: ['points'], refs: { id: 'tasks' } }));
      }
      if (kind === 'tasks') {
        if (record.deliveryMode === 'git') copy.deliveryMode = 'git';
        if (record.carryoverHistory !== undefined) copy.carryoverHistory = list(record.carryoverHistory, 'история переноса').map(item => carryover(item, text, link));
        if (record.assignmentHistory !== undefined) copy.assignmentHistory = list(record.assignmentHistory, 'история назначений').map(item =>
          linkedFields(item, text, link, { string: ['date'], refs: { agentId: 'agents', reviewerId: 'agents', proposalId: 'rosterProposals' } }));
        if (record.links !== undefined) copy.links = copyTaskLinks(record.links, link);
        if (record.phaseCriterionIds !== undefined) {
          copy.phaseCriterionIds = list(record.phaseCriterionIds, 'критерии задачи').map(id => opaque('criterion', id));
        }
        if (record.gitDelivery !== undefined) copy.gitDelivery = copyGitHistory(record.gitDelivery, text, link, opaque);
        if (record.kind === 'train' && record.training) {
          const training = object(record.training, 'обучение');
          copy.training = {
            ...copyFields(training, ['objective', 'guide', 'exercise', 'searchOutcome', 'knowledgeKey', 'knowledgeReason'], text),
            ...copyTrainingMaterials(training, isApprovedTraining(record), text),
            targetAgentId: link('agents', training.targetAgentId),
            topics: list(training.topics, 'темы обучения', 12).map(text),
            warnings: list(training.warnings, 'результат поиска').map(text),
            skillIds: list(training.skillIds, 'навыки').map(id => link('skills', id)).filter(Boolean),
            ...(training.bootstrap === true ? { bootstrap: true } : {}),
            ...(training.scoped === true ? { scoped: true } : {}),
          };
          if (isApprovedTraining(record)) {
            if (training.knowledgeId !== undefined) copy.training.knowledgeId = link('knowledge', training.knowledgeId);
            if (training.customSkillIds !== undefined) {
              copy.training.customSkillIds = list(training.customSkillIds, 'авторские навыки').map(id => link('customSkills', id)).filter(Boolean);
            }
          }
        }
        const interrupted = ['running', 'scheduled'].includes(record.status);
        copy.status = statuses.includes(record.status) && !interrupted ? record.status : 'queued';
        copy.stage = interrupted && record.stage === 'in_progress' ? 'ready'
          : stages.includes(record.stage) ? record.stage : copy.status === 'completed' ? 'done' : 'ready';
        if (typeof record.requiresAcceptance === 'boolean') copy.requiresAcceptance = record.requiresAcceptance;
        if (record.legacyWorktreeReview === true || record.gitDelivery && !['done', 'replaced'].includes(copy.stage)) {
          copy.legacyWorktreeReview = true;
          copy.stage = 'blocked';
        }
        if (Number.isSafeInteger(record.failedReviews) && record.failedReviews >= 0) copy.failedReviews = record.failedReviews;
        if (record.artifactPath || record.artifactTarget || record.previousArtifactPath || record.artifactVersions?.length) {
          delete copy.artifact;
        }
        if (record.artifactTarget !== undefined) copy.artifactTarget = portablePath(record.artifactTarget);
        if (record.artifactPath) {
          const path = toBundle && !selectedPaths.has(record.artifactPath) ? null : portablePath(record.artifactPath);
          if (path && selectedPaths.has(path)) copy.artifactPath = path;
        }
      }
      return copy;
    });
  }
  return payload;
}

function isApprovedTraining(task) {
  return task.kind === 'train' && task.stage === 'done' && task.status === 'completed' && typeof task.review === 'string' && !!task.review.trim() && !!task.training;
}

export function makeStudioBundle(snapshot, { studioId, mode, artifacts, evidenceFiles } = {}) {
  if (!modes.includes(mode)) throw new Error('Укажите формат экспорта студии.');
  const studio = snapshot.studios.find(entry => entry.id === studioId);
  if (!studio) throw new Error('Студия не найдена.');
  const taskIds = new Set(list(snapshot.tasks, 'задачи').filter(record => record.studioId === studioId).map(record => record.id));
  const source = { studio, artifacts };
  if (mode === 'snapshot' && evidenceFiles !== undefined) {
    const entries = new Map(list(snapshot.evidence, 'доказательства').filter(record => record.studioId === studioId).map(record => [record.id, record]));
    source.evidence = list(evidenceFiles, 'выбранные доказательства', maxArtifacts).map(({ id, bytes }) => {
      const record = entries.get(identifier(id));
      if (!record || !Buffer.isBuffer(bytes) || bytes.length > maxEvidenceBytes) throw new Error('Выбранное доказательство недоступно для переноса.');
      return { ...record, content: bytes.toString('base64') };
    });
  }
  for (const key of collections) {
    source[key] = list(snapshot[key], key).filter(record =>
      record.studioId === studioId || (key === 'inbox' && !record.studioId && taskIds.has(record.taskId)));
  }
  return { format, version, mode, ...copyPayload(source, { mode, toBundle: true }) };
}

export function prepareBundleImport(bundle, { name, root } = {}) {
  if (bundle?.format !== format || ![1, version].includes(bundle.version)) throw new Error('Версия или формат пакета студии не поддерживается.');
  if (!modes.includes(bundle.mode)) throw new Error('Неверный формат режима экспорта.');
  const payload = copyPayload(bundle, { mode: bundle.mode, root, name });
  return bundle.mode === 'template' ? { ...payload, trainRoster: true } : payload;
}

export async function prepareLegacyImport({ source, root, name, artifactPaths, language } = {}) {
  destinationRoot(root);
  const paths = list(artifactPaths, 'артефакты', maxArtifacts).map(selectedPath);
  if (new Set(paths.map(path => path.normalize('NFC').toLowerCase())).size !== paths.length) throw new Error('Путь к артефакту повторяется.');
  const { snapshot, artifacts, evidenceFiles, warnings } = await prepareLegacySnapshot({ source, root, paths, maxArtifactBytes, maxEvidenceBytes, language });
  const bundle = makeStudioBundle(snapshot, { studioId: snapshot.studios[0].id, mode: 'snapshot', artifacts, evidenceFiles });
  return { ...prepareBundleImport(bundle, { root, name }), warnings };
}
