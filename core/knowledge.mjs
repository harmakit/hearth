import { randomUUID } from 'node:crypto';
import { field, object } from './protocol.mjs';

export const knowledgeNoteLimit = 3000;
const defaultKey = 'role-notes';
const layers = ['decision', 'role', 'memory', 'reference'];
const materialSelectionLimit = 3;
const customSkillLimit = 3;

export function materialMetadata(input) {
  const material = object(input, 'учебный материал');
  const url = field(material.url, 'ссылка на материал', 2048);
  const parsed = URL.parse(url);
  if (parsed?.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('Некорректная ссылка на учебный материал.');
  return {
    id: field(material.id, 'идентификатор материала', 512),
    title: field(material.title, 'название материала', 240),
    source: field(material.source, 'источник материала', 120),
    url: parsed.href,
    revision: field(material.revision, 'ревизия материала', 240),
    license: field(material.license, 'лицензия материала', 240),
  };
}

export function customSkillDraft(input) {
  const skill = object(input, 'пользовательский навык');
  const key = stableKey(skill.key);
  return { key, title: field(skill.title, 'название навыка', 120), content: field(skill.content, 'содержание навыка', 4000) };
}

function stableKey(value) {
  const key = field(value, 'ключ знания или навыка', 64);
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(key)) throw new Error('Некорректный ключ знания или навыка.');
  return key;
}

export async function sourceMaterials(studio, topics, signal, findMaterials) {
  if (!findMaterials) return { materialCandidates: [], materialWarnings: [], materialSearchOutcome: 'unavailable' };
  try {
    const { candidates, warnings = [] } = await findMaterials({ topics, language: studio.language, signal });
    signal.throwIfAborted();
    if (!Array.isArray(candidates) || !Array.isArray(warnings)) throw new Error('Поиск материалов вернул некорректный ответ.');
    const materialWarnings = warnings.filter(value => typeof value === 'string' && value.trim()).slice(0, 8).map(value => value.trim().slice(0, 500));
    const candidatesById = new Map();
    for (const candidate of candidates.slice(0, 12)) {
      try {
        const source = materialMetadata(candidate);
        const excerpt = typeof candidate.excerpt === 'string' ? candidate.excerpt.trim().slice(0, 2500) : '';
        if (!candidatesById.has(source.id)) candidatesById.set(source.id, { ...source, excerpt });
      } catch {
        if (materialWarnings.length < 8 && !materialWarnings.includes('Материал с некорректными метаданными пропущен.')) {
          materialWarnings.push('Материал с некорректными метаданными пропущен.');
        }
      }
    }
    const materialCandidates = [...candidatesById.values()];
    return {
      materialCandidates, materialWarnings,
      materialSearchOutcome: materialCandidates.length ? 'matches' : materialWarnings.length ? 'error' : 'no-match',
    };
  } catch (error) {
    signal.throwIfAborted();
    const warning = error instanceof Error ? error.message.slice(0, 500) : 'Не удалось выполнить поиск учебных материалов.';
    return { materialCandidates: [], materialWarnings: [warning], materialSearchOutcome: 'error' };
  }
}

export function selectKnowledge(data, { materialCandidates = [], materialWarnings, materialSearchOutcome }) {
  const selectedMaterialIds = data.selectedMaterialIds === undefined ? [] : data.selectedMaterialIds;
  if (!Array.isArray(selectedMaterialIds) || selectedMaterialIds.length > materialSelectionLimit || new Set(selectedMaterialIds).size !== selectedMaterialIds.length) {
    throw new Error('Некорректный список выбранных материалов.');
  }
  const materials = selectedMaterialIds.map(id => {
    const candidate = materialCandidates.find(entry => entry.id === id);
    if (!candidate) throw new Error('Коуч агентов выбрал материал вне результатов поиска.');
    return candidate;
  });
  const knowledge = data.knowledge === undefined ? undefined : field(data.knowledge, 'заметки для роли', knowledgeNoteLimit);
  const proposals = data.customSkills === undefined ? [] : data.customSkills;
  if (!Array.isArray(proposals) || proposals.length > customSkillLimit) throw new Error('Некорректный список пользовательских навыков.');
  const customSkills = proposals.map(customSkillDraft);
  if (new Set(customSkills.map(({ key }) => key)).size !== customSkills.length) throw new Error('Ключи пользовательских навыков должны быть уникальны.');
  const knowledgeKey = data.knowledgeKey === undefined ? defaultKey : stableKey(data.knowledgeKey);
  const knowledgeReason = data.knowledgeReason === undefined ? undefined : field(data.knowledgeReason, 'причина изменения знаний', 500);
  return { materialWarnings, materialSearchOutcome, selectedMaterialIds, materials, knowledge, knowledgeKey, knowledgeReason, customSkills };
}

export function createKnowledge({ list, insert, read, transaction = write => write(), changed = value => value }) {
  const table = kind => kind === 'knowledge' ? 'knowledge' : 'customSkills';
  const identity = ({ studioId, agentId, key, layer }) => ({ studioId, agentId: agentId ?? null, key: key ?? defaultKey, layer: layer ?? 'role' });
  const sameScope = (a, b) => JSON.stringify(identity(a)) === JSON.stringify(identity(b));
  const events = () => list('knowledgeEvents') ?? [];
  const versions = scope => list(table(scope.kind)).filter(entry => sameScope(entry, scope));

  function current(scope, records) {
    const event = events().findLast(entry => entry.kind === scope.kind && sameScope(entry, scope));
    if (event) return records.find(({ id }) => id === event.versionId);
    return [...records].reverse().sort((a, b) => (b.version ?? 0) - (a.version ?? 0))[0];
  }

  function recordEvent(scope, details) {
    const event = { ...scope, id: randomUUID(), initiator: details.trainingTaskId ? 'coach' : 'owner', createdAt: new Date().toISOString(), ...details };
    insert('knowledgeEvents', event);
    return event;
  }

  function publish(scope, content, { reason, trainingTaskId, topics, ...operation }) {
    const entries = versions(scope);
    const previous = current(scope, entries);
    if (trainingTaskId && previous
      && JSON.stringify(previous.topics ?? []) === JSON.stringify(topics ?? [])
      && Object.entries(content).every(([key, value]) => JSON.stringify(previous[key]) === JSON.stringify(value))) return previous;
    const version = 1 + entries.reduce((max, record) => Math.max(max, record.version ?? 0), 0);
    const replacesId = previous?.id ?? null;
    const record = {
      ...content, ...identity(scope), id: randomUUID(), version, reason, replacesId,
      topics, trainingTaskId, createdAt: new Date().toISOString(),
    };
    insert(table(scope.kind), record);
    recordEvent(scope, { action: 'publish', versionId: record.id, previousId: replacesId, reason, trainingTaskId, ...operation });
    return record;
  }

  function approve(studio, task) {
    const { targetAgentId: agentId, materials, knowledge, knowledgeKey, knowledgeReason, customSkills, guide, topics } = task.training;
    const sources = materials?.map(materialMetadata);
    const scope = { studioId: studio.id, agentId, layer: 'role' };
    const details = { reason: knowledgeReason ?? task.training.objective, trainingTaskId: task.id, topics };
    let knowledgeId;
    if (knowledge || sources?.length) {
      knowledgeId = publish({ ...scope, kind: 'knowledge', key: knowledgeKey ?? defaultKey },
        { notes: knowledge ?? guide.slice(0, knowledgeNoteLimit), sources: sources ?? [] }, details).id;
    }
    const customSkillIds = customSkills?.map(skill => {
      return publish({ ...scope, kind: 'customSkill', key: skill.key }, customSkillDraft(skill), details).id;
    });
    return { materials: sources, knowledgeId, customSkillIds, customSkills: undefined };
  }

  function ownerScope({ studioId, agentId, key, layer }, kind) {
    const studio = read('studios', studioId, 'Студия');
    if (!layers.includes(layer) || (kind === 'customSkill' && layer !== 'role')) throw new Error('Неизвестный слой библиотеки.');
    if (layer === 'role' || layer === 'memory') {
      if (!studio.agents.some(({ id }) => id === agentId)) throw new Error('Роль не найдена в этой студии.');
    } else if (agentId != null) {
      throw new Error('Для общего слоя библиотеки не указывают роль.');
    }
    return { ...identity({ studioId, agentId, key: stableKey(key), layer }), kind };
  }

  function ownerChange(scope, input, payload, apply, replay = value => value) {
    const reason = field(input.reason, 'причина изменения знаний', 500);
    const operationId = field(input.operationId, 'идентификатор операции', 200);
    const { expectedVersion } = input;
    if (expectedVersion !== undefined && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0)) throw new Error('Некорректная версия записи библиотеки.');
    const signature = JSON.stringify({ scope, reason, payload, expectedVersion });
    return changed(transaction(() => {
      const prior = events().find(event => event.studioId === scope.studioId && event.operationId === operationId);
      if (prior) {
        if (prior.signature !== signature) throw new Error('Операция библиотеки уже использована.');
        return replay(prior);
      }
      const active = current(scope, versions(scope));
      if (expectedVersion !== undefined && expectedVersion !== (active ? active.version ?? 1 : 0)) throw new Error('Версия записи библиотеки изменилась.');
      return apply({ reason, operationId, signature });
    }));
  }

  function publishLibraryEntry(input) {
    const scope = ownerScope(input, 'knowledge');
    if (scope.layer === 'role') throw new Error('Знания роли утверждаются через обучение.');
    const notes = field(input.notes, 'заметки библиотеки', knowledgeNoteLimit);
    if (!Array.isArray(input.sources ?? []) || input.sources?.length > materialSelectionLimit) throw new Error('Некорректные источники библиотеки.');
    const sources = input.sources?.map(materialMetadata) ?? [];
    return ownerChange(scope, input, { notes, sources }, op => publish(scope, { notes, sources }, op),
      event => read('knowledge', event.versionId, 'Запись библиотеки'));
  }

  function changeKnowledge(input) {
    const { kind, action } = input;
    if (!['knowledge', 'customSkill'].includes(kind) || !['rollback', 'revoke'].includes(action)) throw new Error('Неизвестное действие с библиотекой.');
    const scope = ownerScope({ layer: 'role', ...input }, kind);
    const versionId = action === 'rollback' ? field(input.versionId, 'версия знания или навыка', 200) : null;
    return ownerChange(scope, input, { action, versionId }, op => {
      const entries = versions(scope);
      const active = current(scope, entries);
      if (action === 'rollback' && !entries.some(({ id }) => id === versionId)) throw new Error('Версия отсутствует в этой записи библиотеки.');
      if (action === 'revoke' && !active) throw new Error('В записи библиотеки нет действующей версии.');
      if (versionId === active?.id) throw new Error('Эта версия уже действует.');
      return recordEvent(scope, { action, previousId: active?.id ?? null, versionId, ...op });
    });
  }

  function activeRecords(studio, agent, kind) {
    const groups = new Map();
    for (const record of list(table(kind))) {
      const scope = identity(record);
      if (scope.studioId !== studio.id || (scope.agentId !== null && scope.agentId !== agent.id)) continue;
      const key = JSON.stringify(scope);
      if (!groups.has(key)) groups.set(key, { scope: { ...scope, kind }, records: [] });
      groups.get(key).records.push(record);
    }
    return [...groups.values()].map(({ scope, records }) => current(scope, records)).filter(Boolean);
  }

  function context(studio, agent, task) {
    const rank = record => layers.indexOf(identity(record).layer);
    const recency = (a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '');
    const taskText = [task?.title, task?.prompt, task?.criteria].filter(Boolean).join(' ').toLowerCase();
    const relevant = record => !taskText || !record.topics?.length || record.topics.some(topic =>
      topic.toLowerCase().split(/[^\p{L}\p{N}]+/u).some(word => word.length >= 3 && taskText.includes(word)));
    const byKey = new Map();
    for (const record of activeRecords(studio, agent, 'knowledge').sort((a, b) => rank(a) - rank(b) || recency(a, b))) {
      const { key } = identity(record);
      if (!byKey.has(key)) byKey.set(key, record);
    }
    const knowledge = [...byKey.values()].filter(relevant).slice(0, 6).map(record => {
      const { id, notes, sources, version } = record;
      const { layer, key } = identity(record);
      return { id, notes, sources, layer, key, version: version ?? 1 };
    });
    const customSkills = activeRecords(studio, agent, 'customSkill').filter(relevant).sort(recency).slice(0, 4)
      .map(({ key, title, version, content }) => ({ key, title, version, content }));
    return { knowledge, customSkills };
  }

  return { approve, context, changeKnowledge, publishLibraryEntry };
}
