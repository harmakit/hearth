import { randomUUID } from 'node:crypto';
import { isAbsolute, posix, win32 } from 'node:path';
import { prepareLegacySnapshot } from './legacy.mjs';

const format = 'hearth-studio';
const version = 1;
const collections = ['tasks', 'inbox', 'plans', 'epics', 'stories', 'sprints', 'meetings'];
const maxRecords = 20_000;
const maxArtifactBytes = 1024 * 1024;
const maxArtifactsBytes = 8 * maxArtifactBytes;
const maxArtifacts = 50;
const modes = ['template', 'snapshot'];
const stages = ['backlog', 'ready', 'in_progress', 'review', 'qa', 'done', 'blocked'];
const statuses = ['queued', 'scheduled', 'running', 'waiting', 'completed', 'failed', 'interrupted'];

const fields = {
  studio: ['name', 'brief', 'language'],
  agent: ['key', 'name', 'description', 'role', 'mode', 'runtime', 'model', 'effort'],
  director: ['runtime', 'model', 'effort'],
  tasks: ['key', 'title', 'prompt', 'summary', 'artifact', 'error', 'review', 'directorDecision', 'createdAt', 'updatedAt', 'legacyId', 'legacyStatus', 'legacyBranch', 'kind', 'type'],
  inbox: ['title', 'body', 'status', 'kind', 'answer', 'createdAt', 'updatedAt', 'legacyId'],
  plans: ['title', 'goal', 'status', 'kind', 'feedback', 'createdAt', 'updatedAt', 'decidedAt', 'legacyId'],
  epics: ['title', 'goal', 'description', 'status', 'createdAt', 'updatedAt', 'legacyId'],
  stories: ['title', 'goal', 'description', 'status', 'createdAt', 'updatedAt', 'legacyId'],
  sprints: ['title', 'goal', 'description', 'summary', 'status', 'createdAt', 'updatedAt', 'legacyId'],
  meetings: ['title', 'summary', 'body', 'description', 'status', 'kind', 'decision', 'createdAt', 'updatedAt', 'legacyId'],
};

const links = {
  agentId: 'agents', reviewerId: 'agents', taskId: 'tasks', parentTaskId: 'tasks', reviewTaskId: 'tasks',
  planId: 'plans', epicId: 'epics', storyId: 'stories', sprintId: 'sprints', meetingId: 'meetings',
  dependencies: 'tasks', taskIds: 'tasks', storyIds: 'stories', agentIds: 'agents',
};
const listLinks = new Set(['dependencies', 'taskIds', 'storyIds', 'agentIds']);

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

function artifactRecords(value) {
  let bytes = 0;
  const paths = new Set();
  return list(value, 'артефакты', maxArtifacts).map(record => {
    const { path, content } = object(record, 'артефакт');
    portablePath(path);
    if (path.split('/').some(part => part.startsWith('.') || part !== part.trim())) {
      throw new Error('Укажите путь к текстовому файлу в открытой папке проекта.');
    }
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

function planFields(record, text, agentIds, selectedPaths) {
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
      for (const detail of ['criteria', 'dependencies', 'dependsOn']) {
        const value = textList(item[detail], detail, text);
        if (value !== undefined) copy[detail] = value;
      }
      if (key === 'tasks') {
        for (const field of ['agentKey', 'reviewerKey']) if (agentIds.has(item[field])) copy[field] = agentIds.get(item[field]);
        if (item.artifactPath !== undefined) copy.artifactPath = portablePath(item.artifactPath);
        if (typeof item.requiresAcceptance === 'boolean') copy.requiresAcceptance = item.requiresAcceptance;
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

function copyPayload(source, { mode, toBundle, root, name }) {
  const input = object(source.studio, 'студия');
  const text = value => filterText(value, typeof input.root === 'string' && input.root.length > 1 ? input.root : '');
  const studioId = toBundle ? 'studio' : randomUUID();
  const rows = Object.fromEntries(collections.map(key => [key, mode === 'snapshot' ? list(source[key], key) : []]));
  const artifacts = mode === 'snapshot' ? artifactRecords(source.artifacts) : [];
  const selectedPaths = new Set(artifacts.map(({ path }) => path));
  const agents = list(input.agents, 'агенты');
  const ids = {};
  for (const [kind, records] of Object.entries({ ...rows, agents })) {
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

  const studio = {
    ...copyFields(input, fields.studio, text),
    id: studioId,
    director: copyFields(object(input.director ?? {}, 'подключение директора'), fields.director, text),
    allowed: list(input.allowed, 'доступные модели').map(entry => ({
      ...copyFields(object(entry, 'модель'), fields.director, text),
      efforts: list(entry.efforts, 'уровни усилий').filter(effort => typeof effort === 'string').map(text),
    })),
    agents: agents.map(agent => ({
      ...copyFields(agent, fields.agent, text),
      id: ids.agents.get(agent.id),
    })),
    approveSprints: input.approveSprints !== false,
    lifecycle: mode === 'template' ? 'draft' : 'paused',
  };
  if (!studio.name?.trim()) throw new Error('Укажите название студии.');
  if (!toBundle) {
    studio.root = destinationRoot(root);
    if (name !== undefined && (typeof name !== 'string' || !name.trim())) throw new Error('Укажите название студии.');
    studio.name = name?.trim() ?? studio.name;
  }

  const payload = { studio, artifacts };
  for (const [kind, records] of Object.entries(rows)) {
    payload[kind] = records.map(record => {
      const copy = { ...copyFields(record, fields[kind], text), id: ids[kind].get(record.id), studioId };
      for (const [key, target] of Object.entries(links)) {
        const value = record[key];
        if (value === undefined) continue;
        copy[key] = listLinks.has(key) ? list(value, key).map(id => link(target, id)).filter(Boolean)
          : value === null ? null : link(target, value) ?? null;
      }
      for (const label of ['criteria', 'acceptance', 'decisions', 'participants']) {
        const value = textList(record[label], label, text);
        if (value !== undefined) copy[label] = value;
      }
      if (kind === 'meetings' && record.messages !== undefined) {
        copy.messages = list(record.messages, 'реплики встречи').map(message =>
          copyFields(object(message, 'реплика встречи'), ['role', 'text', 'createdAt'], text));
      }
      if (kind === 'plans') Object.assign(copy, planFields(record, text, ids.agents, selectedPaths));
      if (kind === 'tasks') {
        const interrupted = ['running', 'scheduled'].includes(record.status);
        copy.status = statuses.includes(record.status) && !interrupted ? record.status : 'queued';
        copy.stage = interrupted && record.stage === 'in_progress' ? 'ready'
          : stages.includes(record.stage) ? record.stage : copy.status === 'completed' ? 'done' : 'ready';
        if (typeof record.requiresAcceptance === 'boolean') copy.requiresAcceptance = record.requiresAcceptance;
        if (record.legacyWorktreeReview === true) copy.legacyWorktreeReview = true;
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

export function makeStudioBundle(snapshot, { studioId, mode, artifacts } = {}) {
  if (!modes.includes(mode)) throw new Error('Укажите формат экспорта студии.');
  const studio = snapshot.studios.find(entry => entry.id === studioId);
  if (!studio) throw new Error('Студия не найдена.');
  const taskIds = new Set(list(snapshot.tasks, 'задачи').filter(record => record.studioId === studioId).map(record => record.id));
  const source = { studio, artifacts };
  for (const key of collections) {
    source[key] = list(snapshot[key], key).filter(record =>
      record.studioId === studioId || (key === 'inbox' && !record.studioId && taskIds.has(record.taskId)));
  }
  return { format, version, mode, ...copyPayload(source, { mode, toBundle: true }) };
}

export function prepareBundleImport(bundle, { name, root } = {}) {
  if (bundle?.format !== format || bundle.version !== version) throw new Error('Версия или формат пакета студии не поддерживается.');
  if (!modes.includes(bundle.mode)) throw new Error('Неверный формат режима экспорта.');
  return copyPayload(bundle, { mode: bundle.mode, root, name });
}

export async function prepareLegacyImport({ source, root, name, artifactPaths } = {}) {
  destinationRoot(root);
  const paths = list(artifactPaths, 'артефакты', maxArtifacts).map(portablePath);
  const { snapshot, artifacts, warnings } = await prepareLegacySnapshot({ source, root, paths, maxArtifactBytes });
  const bundle = makeStudioBundle(snapshot, { studioId: snapshot.studios[0].id, mode: 'snapshot', artifacts });
  return { ...prepareBundleImport(bundle, { root, name }), warnings };
}
