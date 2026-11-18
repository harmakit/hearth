import assert from 'node:assert/strict';
import test from 'node:test';
import { createRoster } from '../core/roster.mjs';
import { createStudioService } from '../core/service.mjs';

function setup() {
  const studio = {
    id: 'studio', staffing: { maxAgents: 2, maxBudget: 50, permissions: ['project-read'] },
    director: { runtime: 'codex', model: 'director' },
    agents: [
      { id: 'coach', systemRole: 'coach' },
      { id: 'author', name: 'Author', description: 'Draft the text', trainingStatus: 'ready', estimatedBudget: 0 },
      { id: 'editor', trainingStatus: 'pending', trainingTaskId: 'lesson', estimatedBudget: 0 },
    ],
  };
  const task = { id: 'article', studioId: studio.id, agentId: 'author', stage: 'ready', status: 'queued', dependencies: [] };
  const rows = { studios: [studio], tasks: [task], rosterProposals: [] };
  const read = (table, id) => {
    const row = rows[table].find(entry => entry.id === id);
    if (!row) throw new Error('Missing record');
    return structuredClone(row);
  };
  const insert = (table, value) => {
    rows[table].push(structuredClone(value));
    return value;
  };
  const roster = createRoster({
    read, list: table => structuredClone(rows[table]), insert,
    update(table, value) {
      rows[table][rows[table].findIndex(row => row.id === value.id)] = structuredClone(value);
      return value;
    },
    transaction: fn => fn(), changed: value => value,
    training: {
      add(current, agent) {
        const lesson = insert('tasks', { id: 'new-lesson', studioId: current.id, kind: 'train', training: { targetAgentId: agent.id } });
        Object.assign(agent, { trainingStatus: 'pending', trainingTaskId: lesson.id });
        return lesson;
      },
      withDependencies(current, assigned) {
        const agent = current.agents.find(({ id }) => id === assigned.agentId);
        return agent.trainingStatus === 'pending'
          ? { ...assigned, stage: 'backlog', dependencies: [...assigned.dependencies, agent.trainingTaskId] }
          : assigned;
      },
    },
    agentSettings: (patch, existing) => ({ ...existing, ...patch }),
    validateFixed: (_, agent) => {
      if (agent.model !== 'allowed') throw new Error('Модель вне каталога.');
    },
  });
  return { roster, rows, read, studio, task };
}

test('owner veto, retirement handoff and return preserve history and gate assignments', () => {
  const { roster, read, studio } = setup();
  const proposal = { studioId: studio.id, agentId: 'author', kind: 'retire', reason: 'Shift work to editor' };
  assert.throws(() => roster.proposeRosterChange({ ...proposal, agentId: 'coach', operationId: 'coach' }), /системн/i);
  const rejected = roster.proposeRosterChange({ ...proposal, operationId: 'veto' });
  assert.equal(roster.decideRosterChange({ proposalId: rejected.id, expectedVersion: 1, decision: 'reject' }).status, 'rejected');
  assert.equal(read('tasks', 'article').agentId, 'author');
  const next = roster.proposeRosterChange({ ...proposal, operationId: 'retire' });
  assert.throws(() => roster.decideRosterChange({ proposalId: next.id, expectedVersion: 2, decision: 'approve' }), /верси/i);
  assert.throws(() => roster.decideRosterChange({ proposalId: next.id, expectedVersion: 1, decision: 'approve' }), /переда/i);
  const retired = roster.decideRosterChange({ proposalId: next.id, expectedVersion: 1, decision: 'approve', transferAgentId: 'editor' });
  assert.equal(retired.status, 'approved');
  assert.equal(read('tasks', 'article').agentId, 'editor');
  assert.deepEqual(read('tasks', 'article').dependencies, ['lesson']);
  assert.throws(() => roster.assertAssignable(read('studios', studio.id), 'author'), /выведена/);
  const returning = roster.proposeRosterChange({
    studioId: studio.id, agentId: 'author', firstResult: 'Recheck style guides', estimatedBudget: 0,
    kind: 'return', reason: 'Resume work', operationId: 'return',
  });
  roster.decideRosterChange({ proposalId: returning.id, expectedVersion: 1, decision: 'approve' });
  const returned = roster.assertAssignable(read('studios', studio.id), 'author');
  assert.equal(returned.trainingStatus, 'pending');
  assert.equal(returned.trainingTaskId, 'new-lesson');
});

test('hire checks owner limits, model catalog and allowed permission changes', () => {
  const { roster, read, studio } = setup();
  const input = { studioId: studio.id, kind: 'hire', reason: 'Need illustrations', firstResult: 'Sketch an illustration', operationId: 'hire' };
  assert.throws(() => roster.proposeRosterChange({ ...input, agent: { model: 'forbidden', mode: 'fixed' } }), /каталог/);
  assert.throws(() => roster.proposeRosterChange({ ...input, agent: { permissions: ['project-write'] } }), /владел/);
  const proposal = roster.proposeRosterChange({ ...input, agent: { name: 'Illustrator' }, estimatedBudget: 70 });
  assert.equal(proposal.status, 'pending');
  assert.deepEqual(proposal.limitReasons, ['headcount', 'budget']);
  assert.equal(read('studios', studio.id).agents.length, 3);
  assert.throws(() => roster.decideRosterChange({ proposalId: proposal.id, expectedVersion: 1, decision: 'approve' }), /лимит/);
  const decision = roster.decideRosterChange({
    proposalId: proposal.id, expectedVersion: 1, decision: 'approve', overrideLimits: true,
  });
  assert.equal(decision.status, 'approved');
  assert.equal(read('studios', studio.id).agents.at(-1).trainingStatus, 'pending');
});

test('role revision approval binds to the reviewed version and rollback retains the proposal trail', () => {
  const { roster, read, rows, studio } = setup();
  const base = { studioId: studio.id, agentId: 'author', kind: 'update', reason: 'Change the role scope' };
  const stale = roster.proposeRosterChange({ ...base, operationId: 'older', agent: { description: 'Add source references' } });
  const update = roster.proposeRosterChange({ ...base, operationId: 'update', agent: { description: 'Edit the source' } });
  const approval = { proposalId: update.id, expectedVersion: 1, decision: 'approve' };
  assert.deepEqual(roster.decideRosterChange(approval), roster.decideRosterChange(approval));
  assert.throws(() => roster.decideRosterChange({ ...approval, proposalId: stale.id }), /верси/i);
  assert.equal(read('studios', studio.id).agents[1].description, 'Edit the source');
  const lesson = rows.tasks.find(({ kind }) => kind === 'train');
  lesson.stage = 'done';
  const rollback = roster.proposeRosterChange({ ...base, operationId: 'rollback', kind: 'rollback', rollbackProposalId: update.id });
  roster.decideRosterChange({ ...approval, proposalId: rollback.id });
  assert.equal(read('studios', studio.id).agents[1].description, 'Draft the text');
  assert.equal(read('rosterProposals', update.id).previousSettings.description, 'Draft the text');
  assert.equal(read('rosterProposals', rollback.id).rollbackProposalId, update.id);
});

test('service stores roster decisions and rejects a new assignment to a retired role', async t => {
  const service = createStudioService({ dbPath: ':memory:', run: async () => assert.fail('Work has not been started') });
  t.after(() => service.close());
  const { id: studioId } = service.createStudio({ name: 'Roster records', root: '/project' });
  const author = service.addAgent({ studioId, role: 'editor', name: 'Author' });
  const editor = service.addAgent({ studioId, role: 'editor', name: 'Editor' });
  const task = service.createTask({ studioId, agentId: author.id, title: 'Draft', prompt: 'Write a draft' });
  const proposal = service.proposeRosterChange({
    studioId, agentId: author.id, kind: 'retire', reason: 'Transfer the draft', operationId: 'transfer-author',
  });
  service.decideRosterChange({ proposalId: proposal.id, decision: 'approve', expectedVersion: proposal.version, transferAgentId: editor.id });
  const snapshot = service.snapshot();
  assert.equal(snapshot.rosterProposals.find(({ id }) => id === proposal.id).status, 'approved');
  assert.equal(snapshot.tasks.find(({ id }) => id === task.id).agentId, editor.id);
  assert.deepEqual(snapshot.tasks.find(({ id }) => id === task.id).dependencies, [editor.trainingTaskId]);
  assert.throws(() => service.createTask({ studioId, agentId: author.id, title: 'New', prompt: 'New assignment' }), /выведена/);
});
