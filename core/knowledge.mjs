import { randomUUID } from 'node:crypto';
import { field, object } from './protocol.mjs';

export const knowledgeNoteLimit = 3000;
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
  const key = field(skill.key, 'ключ навыка', 64);
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(key)) throw new Error('Некорректный ключ навыка.');
  return { key, title: field(skill.title, 'название навыка', 120), content: field(skill.content, 'содержание навыка', 4000) };
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
  return { materialWarnings, materialSearchOutcome, selectedMaterialIds, materials, knowledge, customSkills };
}

export function createKnowledge({ list, insert }) {
  const forAgent = (table, studioId, agentId) => list(table).filter(record => record.studioId === studioId && record.agentId === agentId);

  function approve(studio, task) {
    const { targetAgentId: agentId, materials, knowledge, customSkills, guide } = task.training;
    const sources = materials?.map(materialMetadata);
    const scope = { studioId: studio.id, agentId, trainingTaskId: task.id, createdAt: new Date().toISOString() };
    let knowledgeId;
    if (knowledge || sources?.length) {
      knowledgeId = randomUUID();
      insert('knowledge', { ...scope, id: knowledgeId, notes: knowledge ?? guide.slice(0, knowledgeNoteLimit), sources: sources ?? [] });
    }
    const customSkillIds = customSkills?.map(skill => {
      const id = randomUUID();
      const version = 1 + forAgent('customSkills', studio.id, agentId).reduce((latest, record) =>
        record.key === skill.key ? Math.max(latest, record.version) : latest, 0);
      insert('customSkills', { ...customSkillDraft(skill), ...scope, id, version });
      return id;
    });
    return { materials: sources, knowledgeId, customSkillIds, customSkills: undefined };
  }

  function context(studio, agent) {
    const knowledge = forAgent('knowledge', studio.id, agent.id).reverse()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 3)
      .map(({ notes, sources }) => ({ notes, sources }));
    const latestByKey = new Map();
    for (const skill of forAgent('customSkills', studio.id, agent.id).reverse()) {
      if (skill.version > (latestByKey.get(skill.key)?.version ?? 0)) latestByKey.set(skill.key, skill);
    }
    const customSkills = [...latestByKey.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 4)
      .map(({ key, title, version, content }) => ({ key, title, version, content }));
    return { knowledge, customSkills };
  }

  return { approve, context };
}
