import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createStudioService } from '../core/service.mjs';
import { createTraining } from '../core/training.mjs';

const material = {
  id: 'manual@v1', title: 'Outline manual', source: 'Library',
  url: 'https://example.org/manual', revision: 'v1', license: 'CC BY 4.0', excerpt: 'Use one heading per step.',
};
const response = {
  summary: 'Prepared', guide: 'Practise the change', selectedSkillIds: [],
  knowledge: 'Keep one heading per step.',
  selectedMaterialIds: [material.id],
  customSkills: [{ key: 'outline', title: 'Outline', content: 'Organize the steps by heading.' }],
};

function setup(findMaterials = async () => ({ candidates: [material], warnings: ['Another source is unavailable'] })) {
  const rows = Object.fromEntries(['skills', 'studios', 'knowledge', 'customSkills'].map(table => [table, []]));
  const training = createTraining({
    read: (table, id) => rows[table].find(row => row.id === id),
    list: table => rows[table],
    insert: (table, row) => rows[table].push(row),
    update: () => {},
    findSkills: async () => ({ candidates: [], warnings: [] }),
    findMaterials,
  });
  const trainee = { id: 'trainee', name: 'Editor', role: 'editor', skillIds: [] };
  const studio = { id: 'studio', language: 'English', agents: [trainee] };
  const task = { id: 'training', training: { topics: ['outlining'], objective: 'Write an outline', targetAgentId: trainee.id } };
  return { rows, training, trainee, studio, task };
}

test('material lookup exposes partial failures and an independent outcome', async () => {
  const signal = new AbortController().signal;
  const { training, studio, task } = setup(async request => {
    assert.deepEqual(request, { topics: task.training.topics, language: studio.language, signal });
    return { candidates: [material], warnings: ['Another source is unavailable'] };
  });
  const sources = await training.source(studio, task, signal);
  const result = training.selection(task, response, sources);
  assert.equal(result.training.searchOutcome, 'no-match');
  assert.equal(result.training.materialSearchOutcome, 'matches');
  assert.deepEqual(result.training.materialWarnings, ['Another source is unavailable']);
  for (const prompt of [training.selectionPrompt(studio, task, sources), training.exercisePrompt(studio, { ...task, ...result }), training.reviewPrompt(studio, { ...task, ...result })]) {
    assert.match(prompt, /Outline manual/);
  }
});

test('material finder failure preserves the GitHub outcome', async () => {
  const { training, studio, task } = setup(async () => { throw new Error('Material service timeout'); });
  const sources = await training.source(studio, task, new AbortController().signal);
  assert.equal(sources.searchOutcome, 'no-match');
  assert.equal(sources.materialSearchOutcome, 'error');
  assert.deepEqual(sources.materialWarnings, ['Material service timeout']);
});

test('unknown material IDs and invalid or duplicate custom skill keys are rejected', async () => {
  const { training, studio, task } = setup();
  const sources = await training.source(studio, task, new AbortController().signal);
  assert.throws(() => training.selection(task, { ...response, selectedMaterialIds: ['unknown'] }, sources), /вне результатов поиска/);
  assert.throws(() => training.selection(task, { ...response, customSkills: [response.customSkills[0], response.customSkills[0]] }, sources), /навык|навыков/);
  assert.throws(() => training.selection(task, { ...response, customSkills: [{ ...response.customSkills[0], key: '../outline' }] }, sources), /ключ/);
});

test('coach bootstrap rejects knowledge and skill proposals that cannot enter a trainee exercise', async () => {
  const { rows, training, studio, task } = setup();
  const bootstrap = { ...task, training: { ...task.training, bootstrap: true } };
  const sources = await training.source(studio, bootstrap, new AbortController().signal);
  assert.throws(() => training.selection(bootstrap, { ...response, selectedMaterialIds: [] }, sources), /начальной подготовке/);
  assert.equal(rows.customSkills.length, 0);
  assert.equal(rows.knowledge.length, 0);
});

test('only approval publishes role knowledge and the latest custom skill version enters task context', async () => {
  const { rows, training, trainee, studio, task } = setup();
  const sources = await training.source(studio, task, new AbortController().signal);
  const rejected = training.selection(task, { ...response, knowledge: 'Unapproved note' }, sources);
  assert.match(training.exercisePrompt(studio, { ...task, ...rejected }), /Unapproved note/);
  assert.equal(training.context(studio, trainee), undefined);
  assert.equal(rows.knowledge.length, 0);
  assert.equal(rows.customSkills.length, 0);
  const first = training.selection(task, response, sources);
  const approved = training.approve(studio, { ...task, ...first });
  assert.deepEqual(approved.customSkillIds, [rows.customSkills[0].id]);
  assert.equal(approved.knowledgeId, rows.knowledge[0].id);
  assert.equal(rows.knowledge[0].notes, response.knowledge);
  const { excerpt, ...source } = material;
  assert.deepEqual(rows.knowledge[0].sources, [source]);
  const next = { ...task, id: 'follow-up' };
  const second = training.selection(next, {
    ...response, knowledge: 'Use a checklist as well.', customSkills: [{ ...response.customSkills[0], content: 'Update the outline.' }],
  }, sources);
  training.approve(studio, { ...next, ...second });
  assert.deepEqual(rows.customSkills.map(({ version }) => version), [1, 2]);
  assert.equal(rows.knowledge.length, 2);
  const context = training.context(studio, trainee);
  assert.deepEqual(context.customSkills.map(({ version, content }) => [version, content]), [[2, 'Update the outline.']]);
  assert.equal(training.context({ ...studio, id: 'another' }, trainee).customSkills.length, 0);
  assert.equal(training.context(studio, { ...trainee, id: 'another' }).knowledge.length, 0);
});

test('training review retries exercise the new draft before releasing work with approved knowledge', async t => {
  let service;
  let drafts = 0;
  let exercised = 0;
  let reviewed = 0;
  let workContext;
  const json = value => ({ text: JSON.stringify(value) });
  service = createStudioService({
    dbPath: ':memory:',
    findSkills: async () => ({ candidates: [], warnings: [] }),
    findMaterials: async () => ({ candidates: [material], warnings: [] }),
    run: async ({ purpose, prompt }) => {
      const context = JSON.parse(prompt.split('\n\n').at(-1));
      if (prompt.startsWith('Prepare a studio agent')) {
        if (context.training.bootstrap) return json({ summary: 'Ready', selectedSkillIds: [], guide: 'Verify pinned sources.' });
        assert.deepEqual(context.materialCandidates, [material]);
        drafts += 1;
        if (drafts === 2) assert.equal(context.previousReview, 'Exercise needs stronger evidence');
        const knowledge = drafts === 1 ? 'Rejected notes' : 'Verified notes';
        return json({ ...response, knowledge });
      }
      if (purpose === 'training-exercise') {
        exercised += 1;
        assert.equal(context.knowledge, exercised === 1 ? 'Rejected notes' : 'Verified notes');
        assert.deepEqual(context.materials, [material]);
        assert.deepEqual(context.customSkills, response.customSkills);
        return json({ summary: 'Tried the outline on a one-page example.' });
      }
      if (purpose === 'review') {
        if (context.training.bootstrap) return json({ pass: true, summary: 'Prepared' });
        reviewed += 1;
        assert.equal(exercised, reviewed);
        const snapshot = service.snapshot();
        assert.equal(snapshot.knowledge.length, 0);
        assert.equal(snapshot.customSkills.length, 0);
        return reviewed === 1
          ? json({ pass: false, summary: 'Exercise needs stronger evidence' })
          : json({ pass: true, summary: 'Evidence checked' });
      }
      workContext = context;
      return json({ summary: 'Completed' });
    },
  });
  t.after(() => service.close());
  const { id: studioId } = service.createStudio({ name: 'Role knowledge', root: '/project' });
  const trainee = service.addAgent({ studioId, name: 'Editor', role: 'editor', trainingTopics: ['outline'] });
  const task = service.createTask({ studioId, agentId: trainee.id, title: 'Outline', prompt: 'Write an outline.' });
  service.startTask({ taskId: task.id });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (service.snapshot().tasks.some(record => record.id === task.id && record.stage === 'done')) break;
    await delay(10);
  }
  const result = service.snapshot();
  assert.equal(result.tasks.find(record => record.id === task.id).stage, 'done', JSON.stringify(result.inbox));
  assert.equal(reviewed, 2);
  assert.deepEqual(result.knowledge.map(({ notes }) => notes), ['Verified notes']);
  assert.deepEqual(result.customSkills.map(({ version }) => version), [1]);
  assert.equal(workContext.training.knowledge[0].notes, 'Verified notes');
  assert.equal(workContext.training.customSkills[0].version, 1);
});
