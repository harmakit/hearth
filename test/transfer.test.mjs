import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createStudioService } from '../core/service.mjs';
import { makeStudioBundle, prepareBundleImport, prepareLegacyImport } from '../migration/transfer.mjs';

const studio = {
  id: 'studio-native', root: '/old/project', name: 'Old studio',
  brief: 'Open /old/project for context. Also see /Users/alice/private.md and C:\\private\\file.txt.', language: 'English', approveSprints: false,
  lifecycle: 'active', director: { runtime: 'codex', model: 'gpt', apiKey: 'secret' },
  allowedMode: 'studio', allowed: [],
  agents: [{ id: 'agent-native', name: 'Builder', role: 'engineer', roleTitle: 'Build engineer', mode: 'inherit', sessionId: 'private-session' }],
};
const owned = record => ({ studioId: studio.id, ...record });
const task = owned({
  id: 'task-native', agentId: 'agent-native', title: 'Work', prompt: 'Do it',
  epicId: 'epic-native', storyId: 'story-native', sprintId: 'sprint-native',
  dependencies: ['before'], artifactPath: 'reports/result.md', artifactTarget: 'reports/result.md',
  requiresAcceptance: true, review: 'Peer review', directorDecision: 'Approved',
  status: 'running', stage: 'in_progress', threadId: 'private-session',
});
const snapshot = {
  studios: [studio],
  tasks: [task, owned({ id: 'before', title: 'Before', status: 'done', stage: 'done' }), { id: 'other', studioId: 'elsewhere' }],
  inbox: [
    owned({ id: 'q', taskId: 'task-native', kind: 'question', status: 'resolved', answer: 'decision' }),
    owned({ id: 'p', planId: 'plan-native', kind: 'plan', status: 'open' }),
  ],
  plans: [owned({
    id: 'plan-native', kind: 'sprint', status: 'pending', title: 'Next', files: [{ path: 'brief.md', content: 'draft' }],
    agents: [{ key: 'agent-native', roleTitle: 'Build engineer', mode: 'dynamic', recommendation: { runtime: 'codex', model: 'light', effort: '' } }],
    tasks: [{ key: 'draft', agentKey: 'agent-native', reviewerKey: 'reviewer', requiresAcceptance: true, dependsOn: ['prior'] }],
  })],
  epics: [owned({ id: 'epic-native', title: 'Epic' })],
  stories: [owned({ id: 'story-native', epicId: 'epic-native', title: 'Story', acceptance: 'Deliver the report' })],
  sprints: [owned({ id: 'sprint-native', epicId: 'epic-native', storyId: 'story-native', title: 'Sprint', summary: 'Sprint brief' })],
  meetings: [owned({ id: 'meet-native', taskId: 'task-native', sprintId: 'sprint-native', title: 'Meeting', decision: 'Send report' })],
};

test('a template preserves only role setup and drops local information', () => {
  const bundle = makeStudioBundle(snapshot, { studioId: studio.id, mode: 'template' });
  assert.equal(bundle.version, 2);
  assert.equal(bundle.mode, 'template');
  assert.equal(bundle.studio.agents[0].name, 'Builder');
  for (const key of ['tasks', 'inbox', 'plans', 'epics', 'stories', 'sprints', 'meetings']) assert.deepEqual(bundle[key], []);
  assert.doesNotMatch(JSON.stringify(bundle), /private-session|secret|\/old\/project|studio-native|agent-native/);
  assert.doesNotMatch(bundle.studio.brief, /alice|private/);
  const copy = prepareBundleImport(bundle, { root: '/new/project', name: 'New studio' });
  assert.equal(copy.studio.name, 'New studio');
  assert.equal(copy.studio.root, '/new/project');
  assert.equal(copy.studio.lifecycle, 'draft');
  assert.equal(copy.studio.allowedMode, 'studio');
  assert.deepEqual(copy.studio.allowed, []);
  assert.equal(copy.studio.agents[0].roleTitle, 'Build engineer');
  assert.notEqual(copy.studio.id, studio.id);
});

test('a snapshot remaps the connected record graph and keeps interrupted work paused', () => {
  const bundle = makeStudioBundle(snapshot, {
    studioId: studio.id,
    mode: 'snapshot',
    artifacts: [{ path: 'reports/result.md', content: 'approved artifact' }],
  });
  assert.equal(bundle.tasks.length, 2);
  assert.doesNotMatch(JSON.stringify(bundle), /private-session|secret|\/old\/project|studio-native|task-native/);
  const payload = prepareBundleImport(JSON.parse(JSON.stringify(bundle)), { root: '/new/project' });
  const [work, before] = payload.tasks;
  assert.equal(payload.studio.lifecycle, 'paused');
  assert.equal(work.status, 'queued');
  assert.equal(work.stage, 'ready');
  assert.equal(work.studioId, payload.studio.id);
  assert.equal(work.agentId, payload.studio.agents[0].id);
  assert.equal(work.epicId, payload.epics[0].id);
  assert.equal(work.storyId, payload.stories[0].id);
  assert.equal(work.sprintId, payload.sprints[0].id);
  assert.equal(work.artifactPath, 'reports/result.md');
  assert.equal(work.artifactTarget, 'reports/result.md');
  assert.equal(work.requiresAcceptance, true);
  assert.equal(work.review, 'Peer review');
  assert.equal(work.directorDecision, 'Approved');
  assert.equal(payload.stories[0].epicId, work.epicId);
  assert.equal(payload.stories[0].acceptance, 'Deliver the report');
  assert.equal(payload.sprints[0].summary, 'Sprint brief');
  assert.deepEqual(work.dependencies, [before.id]);
  assert.equal(payload.inbox[0].taskId, work.id);
  assert.equal(payload.inbox[1].planId, payload.plans[0].id);
  assert.equal(payload.plans[0].tasks[0].agentKey, work.agentId);
  assert.deepEqual(payload.plans[0].agents[0], { key: work.agentId, roleTitle: 'Build engineer', mode: 'dynamic', recommendation: { runtime: 'codex', model: 'light', effort: '' } });
  assert.equal(payload.plans[0].tasks[0].reviewerKey, 'reviewer');
  assert.equal(payload.plans[0].tasks[0].requiresAcceptance, true);
  assert.deepEqual(payload.plans[0].tasks[0].dependsOn, ['prior']);
  assert.equal(payload.meetings[0].taskId, work.id);
  assert.equal(payload.meetings[0].sprintId, work.sprintId);
  assert.equal(payload.meetings[0].decision, 'Send report');
  assert.notEqual(prepareBundleImport(bundle, { root: '/new/project' }).tasks[0].id, work.id);
  assert.deepEqual(payload.artifacts, [{ path: 'reports/result.md', content: 'approved artifact' }]);
});

test('a bundle rejects invalid versions, malformed edges and nonportable paths', () => {
  const bundle = makeStudioBundle(snapshot, { studioId: studio.id, mode: 'snapshot' });
  const copy = patch => prepareBundleImport({ ...bundle, ...patch }, { root: '/new/project' });
  assert.throws(() => copy({ version: 3 }), /верси/i);
  assert.equal(copy({ version: 1 }).studio.lifecycle, 'paused');
  assert.throws(() => copy({ tasks: [{ ...bundle.tasks[0], dependencies: ['unknown'] }] }), /связ/i);
  assert.throws(() => copy({ tasks: [{ ...bundle.tasks[0], artifactPath: '../outside' }, bundle.tasks[1]] }), /путь/i);
  assert.throws(() => copy({ artifacts: [{ path: 'C:\\outside', content: 'unsafe' }] }), /путь/i);
  assert.throws(() => copy({ artifacts: [{ path: 'reports/.env', content: 'unsafe' }] }), /путь/i);
  assert.throws(() => copy({ plans: [{ ...bundle.plans[0], files: [{ path: '/outside', content: 'unsafe' }] }] }), /путь/i);
  assert.throws(() => copy({ epics: false }), /формат/i);
  assert.equal(copy({}).tasks[0].artifactPath ?? '', '');
});

test('a snapshot transfers only selected evidence with exact bytes and fresh task links', () => {
  const bytes = Buffer.from([0, 255, 128, 7]);
  const original = owned({ id: 'one-video', taskId: task.id, attemptId: 'native-attempt',
    kind: 'video', sourcePath: 'runs/playtest.mp4', revision: { headOid: 'a'.repeat(40), digest: 'b'.repeat(64) },
    contentType: 'video/mp4', size: bytes.length, digest: createHash('sha256').update(bytes).digest('hex'),
    storedRef: 'private-storage', identity: { inode: 412 },
  });
  const bundle = makeStudioBundle({ ...snapshot, evidence: [original, { ...original, id: 'two-videos' }] }, {
    studioId: studio.id, mode: 'snapshot', evidenceFiles: [{ id: original.id, bytes }],
  });
  assert.equal(bundle.evidence.length, 1);
  assert.doesNotMatch(JSON.stringify(bundle), /two-videos|private-storage|native-attempt/);
  const payload = prepareBundleImport(bundle, { root: '/new/project' });
  assert.deepEqual(Buffer.from(payload.evidence[0].content, 'base64'), bytes);
  assert.deepEqual(payload.evidence[0].revision, original.revision);
  assert.equal(payload.evidence[0].taskId, payload.tasks[0].id);
  assert.notEqual(payload.evidence[0].id, original.id);
  assert.throws(() => prepareBundleImport({ ...bundle, evidence: [{ ...bundle.evidence[0], content: 'AAAAAA==' }] }, { root: '/new/project' }), /контрольн|содержим/i);
});

test('a snapshot remaps and stores the version chain and event history of owner library decisions', t => {
  const first = owned({ id: 'original', agentId: null, key: 'architecture', layer: 'decision', notes: 'First decision', version: 1,
    createdAt: '2026-11-18', replacesId: null });
  const second = { ...first, id: 'replacement', notes: 'Revised decision', version: 2, replacesId: first.id };
  const event = owned({ id: 'library-event', agentId: null, key: first.key, layer: first.layer, kind: 'knowledge', action: 'publish',
    previousId: first.id, versionId: second.id, reason: 'New evidence', operationId: 'private-op' });
  const bundle = makeStudioBundle({ ...snapshot, knowledge: [first, second], knowledgeEvents: [event] }, { studioId: studio.id, mode: 'snapshot' });
  const normalized = prepareBundleImport(bundle, { root: '/new/project' });
  assert.equal(normalized.knowledge[1].replacesId, normalized.knowledge[0].id);
  assert.equal(normalized.knowledgeEvents[0].previousId, normalized.knowledge[0].id);
  assert.equal(normalized.knowledgeEvents[0].versionId, normalized.knowledge[1].id);
  assert.doesNotMatch(JSON.stringify(bundle), /library-event|private-op/);
  const service = createStudioService({ dbPath: ':memory:', run: async () => {} });
  t.after(() => service.close());
  service.importStudio(normalized);
  const saved = service.snapshot();
  assert.equal(saved.knowledge[1].replacesId, saved.knowledge[0].id);
  assert.equal(saved.knowledgeEvents[0].versionId, saved.knowledge[1].id);
});

test('modern snapshot preserves typed history and holds imported Git work for review', () => {
  const revision = { headOid: 'a'.repeat(40), targetOid: 'b'.repeat(40), digest: 'c'.repeat(64) };
  const current = { ...task, points: 3, links: [{ type: 'origin', taskId: 'before' }],
    carryoverHistory: [{ taskId: task.id, fromSprintId: 'sprint-native', sprintId: null, stage: 'backlog', reason: 'Wait for input' }],
    gitDelivery: { worktreeId: 'private-worktree', status: 'candidate', revision, checks: [] } };
  const workspace = { ...snapshot, tasks: [current, snapshot.tasks[1]],
    sprints: [{ ...snapshot.sprints[0], closedTasks: [{ taskId: task.id, stage: 'backlog', title: 'Earlier work' }],
      retrospective: { methodVersion: 1, sprintId: snapshot.sprints[0].id,
        planned: { count: 2, taskIds: [task.id, 'before'], points: null, knownPoints: 3, missingPointTaskIds: ['before'] } } }],
    conversations: [owned({ id: 'chat', taskId: task.id, agentId: studio.agents[0].id })],
    conversationMessages: [owned({ id: 'msg', conversationId: 'chat', kind: 'note', status: 'queued', author: 'owner', text: 'Original note', operationId: 'private-operation' })],
    phases: [owned({ id: 'phase', title: 'Release', goal: 'Launch', epicIds: ['epic-native'],
      sprintIds: ['sprint-native'], criteria: [{ id: 'criterion', description: 'Check', evidenceIds: ['before'] }] })],
  };
  const bundle = makeStudioBundle(workspace, { studioId: studio.id, mode: 'snapshot' });
  assert.doesNotMatch(JSON.stringify(bundle), /private-worktree|private-operation/);
  const copy = prepareBundleImport(bundle, { root: '/new/project' });
  assert.deepEqual(copy.tasks[0].links, [{ type: 'origin', taskId: copy.tasks[1].id }]);
  assert.equal(copy.tasks[0].points, 3);
  assert.equal(copy.tasks[0].carryoverHistory[0].fromSprintId, copy.sprints[0].id);
  assert.equal(copy.tasks[0].carryoverHistory[0].taskId, copy.tasks[0].id);
  assert.equal(copy.sprints[0].closedTasks[0].taskId, copy.tasks[0].id);
  assert.deepEqual(copy.sprints[0].retrospective.planned.missingPointTaskIds, [copy.tasks[1].id]);
  assert.equal(copy.tasks[0].legacyWorktreeReview, true);
  assert.equal(copy.tasks[0].stage, 'blocked');
  assert.deepEqual(copy.tasks[0].gitDelivery.revision, revision);
  assert.equal(copy.conversationMessages[0].conversationId, copy.conversations[0].id);
  assert.equal(copy.conversationMessages[0].status, 'held');
  assert.deepEqual(copy.phases[0].criteria[0].evidenceIds, [copy.tasks[1].id]);
  assert.throws(() => prepareBundleImport({ ...bundle, phases: [{ ...bundle.phases[0], studioId: 'elsewhere' }] }, { root: '/new/project' }), /другой студии/i);
});

test('only explicitly selected published file bytes appear anywhere in the snapshot', () => {
  const workspace = {
    ...snapshot,
    tasks: [
      { ...task, artifact: 'unselected task file bytes' },
      { ...snapshot.tasks[1], artifact: 'portable inline result' },
    ],
    plans: [
      { ...snapshot.plans[0], status: 'approved', files: [
        { path: 'brief.md', content: 'original plan draft bytes' },
        { path: 'private.md', content: 'unselected plan file bytes' },
      ], publishedFiles: ['brief.md', 'private.md'] },
    ],
  };
  const selected = [{ path: 'brief.md', content: 'selected starter file bytes' }];
  const bundle = makeStudioBundle(workspace, { studioId: studio.id, mode: 'snapshot', artifacts: selected });
  const raw = JSON.stringify(bundle);
  assert.doesNotMatch(raw, /unselected|original plan draft bytes/);
  assert.equal(raw.split('selected starter file bytes').length, 2);
  const payload = prepareBundleImport(JSON.parse(raw), { root: '/new/workspace' });
  assert.deepEqual(payload.artifacts, selected);
  assert.deepEqual(payload.plans[0].files, [{ path: 'brief.md' }, { path: 'private.md' }]);
  assert.deepEqual(payload.plans[0].publishedFiles, ['brief.md']);
  assert.equal(payload.tasks[0].artifactPath, undefined);
  assert.equal(payload.tasks[1].artifact, 'portable inline result');
});

test('a copy commits to the real studio service and keeps historical approvals inert', async t => {
  let runs = 0;
  const service = createStudioService({ dbPath: ':memory:', run: async () => { runs++; } });
  t.after(() => service.close());
  const bundle = makeStudioBundle(snapshot, { studioId: studio.id, mode: 'snapshot' });
  const first = service.importStudio(prepareBundleImport(bundle, { root: '/first/project' }));
  const second = service.importStudio(prepareBundleImport(bundle, { root: '/second/project' }));
  assert.notEqual(first.id, second.id);
  const result = service.snapshot();
  assert.equal(result.studios.length, 2);
  assert.equal(result.tasks.filter(({ kind }) => kind !== 'train').length, 4);
  const [plan] = result.plans.filter(item => item.studioId === first.id);
  const [approval] = result.inbox.filter(item => item.planId === plan.id);
  assert.equal(plan.status, 'returned');
  assert.equal(approval.status, 'resolved');
  assert.equal(runs, 0);
});

test('approved role knowledge and debt planning survive a studio snapshot round trip', t => {
  const service = createStudioService({ dbPath: ':memory:', run: async () => {} });
  t.after(() => service.close());
  const policy = { enabled: true, every: 4, minShare: 50, minOpenTasks: 2, measure: 'taskCount' };
  const assessment = { reason: 'Many debt tasks', assessedAt: '2026-11-18T00:00:00.000Z' };
  const coach = { id: 'coach', name: 'Coach', role: 'library', mode: 'inherit', systemRole: 'coach', trainingTaskId: 'bootstrap' };
  const trainee = { ...studio.agents[0], trainingTaskId: 'lesson' };
  const approved = { stage: 'done', status: 'completed', review: 'Approved', kind: 'train', agentId: coach.id };
  const source = { id: 'manual', title: 'Manual', source: 'Library', url: 'https://example.org/manual', revision: 'v1', license: 'CC BY', excerpt: 'See /Users/alice/private.md' };
  const lesson = owned({ ...approved, id: 'lesson', title: 'Lesson', dependencies: ['bootstrap'], training: {
    targetAgentId: trainee.id, objective: 'Practise', guide: 'Guide', exercise: 'Exercise',
    knowledgeId: 'note', customSkillIds: ['outline-v1'], selectedMaterialIds: ['manual'], materials: [source],
  } });
  const note = owned({ id: 'note', agentId: trainee.id, trainingTaskId: lesson.id, notes: 'See /old/project/private.md', sources: [source], createdAt: assessment.assessedAt });
  const skill = owned({ id: 'outline-v1', agentId: trainee.id, trainingTaskId: lesson.id, key: 'outline', title: 'Outline', version: 1, content: 'Read /Users/alice/private.md', createdAt: assessment.assessedAt });
  const workspace = {
    ...snapshot,
    studios: [{ ...studio, debtPolicy: policy, debtAssessment: assessment, agents: [trainee, coach] }],
    tasks: [{ ...task, kind: 'debt' }, snapshot.tasks[1], lesson, owned({ ...approved, id: 'draft-lesson', title: 'Draft lesson',
      status: 'queued', stage: 'review', review: '', dependencies: ['bootstrap'], training: {
        targetAgentId: trainee.id, objective: 'Practise again', knowledge: 'Draft note',
        selectedMaterialIds: ['manual'], materials: [{ ...source, excerpt: '' }],
        customSkills: [{ key: 'outline', title: 'Revised outline', content: 'Draft content' }],
      },
    }), owned({ ...approved, id: 'bootstrap', title: 'Bootstrap', training: {
      targetAgentId: coach.id, objective: 'Coach', guide: 'Guide', bootstrap: true,
    } })],
    plans: [{ ...snapshot.plans[0], debtSprint: true, tasks: [{ ...snapshot.plans[0].tasks[0], kind: 'debt', debtTaskId: task.id }] }],
    sprints: [{ ...snapshot.sprints[0], debtSprint: true }],
    knowledge: [note, { ...note, id: 'orphan' }, { ...note, id: 'foreign', studioId: 'another' }],
    customSkills: [skill, { ...skill, id: 'orphan' }],
  };
  const bundle = makeStudioBundle(workspace, { studioId: studio.id, mode: 'snapshot' });
  assert.equal(bundle.knowledge.length, 1);
  assert.equal(bundle.customSkills.length, 1);
  assert.doesNotMatch(JSON.stringify(bundle), /\/old\/project|\/Users\/alice|orphan/);
  const prepared = prepareBundleImport(bundle, { root: '/imported/studio' });
  const copy = service.importStudio(prepared);
  const saved = service.snapshot();
  const importedLesson = saved.tasks.find(({ title }) => title === 'Lesson');
  const importedDebtTask = saved.tasks.find(({ title }) => title === 'Work');
  assert.deepEqual(copy.debtPolicy, policy);
  assert.deepEqual(copy.debtAssessment, assessment);
  assert.equal(importedDebtTask.kind, 'debt');
  assert.equal(saved.plans[0].tasks[0].debtTaskId, importedDebtTask.id);
  assert.equal(saved.plans[0].tasks[0].kind, 'debt');
  assert.equal(saved.plans[0].debtSprint, true);
  assert.equal(saved.sprints[0].debtSprint, true);
  assert.equal(saved.knowledge[0].studioId, copy.id);
  assert.equal(saved.knowledge[0].agentId, copy.agents[0].id);
  assert.equal(saved.knowledge[0].trainingTaskId, importedLesson.id);
  assert.equal(saved.knowledge[0].id, importedLesson.training.knowledgeId);
  assert.deepEqual(importedLesson.training.customSkillIds, [saved.customSkills[0].id]);
  assert.equal(saved.knowledge[0].sources[0].url, source.url);
  assert.equal(saved.customSkills[0].version, 1);
  const draft = saved.tasks.find(({ title }) => title === 'Draft lesson');
  assert.equal(draft.training.knowledge, 'Draft note');
  assert.equal(draft.training.materials[0].excerpt, '');
  assert.equal(draft.training.customSkills[0].content, 'Draft content');
  assert.equal(draft.training.knowledgeId, undefined);

  const badUrl = structuredClone(bundle);
  badUrl.knowledge[0].sources[0].url = 'file:///private/manual';
  assert.throws(() => prepareBundleImport(badUrl, { root: '/imported/invalid' }), /ссылка/);
  const forged = prepareBundleImport(bundle, { root: '/imported/invalid' });
  forged.knowledge[0].agentId = forged.studio.agents.find(({ systemRole }) => systemRole === 'coach').id;
  assert.throws(() => service.importStudio(forged), /связь утверждённых материалов/);
  const unapproved = prepareBundleImport(bundle, { root: '/imported/invalid' });
  Object.assign(unapproved.tasks.find(({ title }) => title === 'Lesson'), { status: 'queued', stage: 'review' });
  assert.throws(() => service.importStudio(unapproved), /отсутствует подтверждение знаний/);
  assert.equal(service.snapshot().studios.length, 1);

  const template = makeStudioBundle(workspace, { studioId: studio.id, mode: 'template' });
  assert.deepEqual(template.knowledge, []);
  assert.deepEqual(template.customSkills, []);
  assert.deepEqual(template.studio.debtPolicy, policy);
  assert.equal(template.studio.debtAssessment, undefined);
  assert.equal(prepareBundleImport(template, { root: '/imported/template' }).trainRoster, true);
});

test('legacy import preserves structure, scopes explicit artifacts and leaves the source alone', async t => {
  const tmp = fileURLToPath(new URL('../.tmp/', import.meta.url));
  await mkdir(tmp, { recursive: true });
  const workspace = await mkdtemp(join(tmp, 'transfer-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const source = join(workspace, 'old');
  const root = join(workspace, 'new');
  const put = async (path, content) => {
    const file = join(source, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, typeof content === 'string' || Buffer.isBuffer(content) ? content : JSON.stringify(content));
  };
  await mkdir(root);
  await put('studio/config.json', { owner_language: 'English', project_language: 'Français', token: 'private-token' });
  await put('studio/board.json', {
    schema: 2, tasks: [
      { id: 'T-1', title: 'First', status: 'in-progress', epic: 'E-1', story: 'US-1', sprint: 4, assignee: 'engineer',
        deps: [{ type: 'task', id: 'T-0' }, { type: 'story', id: 'US-1' }], links: [{ type: 'origin', task_id: 'T-0' }], acceptance: ['A report exists'], branch: 'feature/game-work', outputs: ['studio/artifacts/report.md', 'studio/artifacts/clip.mp4', 'studio/artifacts/unselected.bin'] },
      { id: 'Q-1', title: 'Question', status: 'done', type: 'question', answer: 'Approved' },
      { id: 'T-2', title: 'Registered', status: 'review' },
    ],
    epics: [{ id: 'E-1', title: 'Epic' }], stories: [{ id: 'US-1', epic: 'E-1', title: 'Story' }],
    meetings: [{ id: 'M-1', title: 'Review', task: 'T-1', sprint: 4, decision: 'Review again' }],
  });
  await put('studio/archive/sprint-004.json', { tasks: [{ id: 'T-0', title: 'Before', status: 'done' }] });
  await put('studio/meetings.jsonl', JSON.stringify({
    id: 'M-2', type: 'grooming', sprint: 4, agenda: 'Plan review', decisions_md: 'Accept the report',
    participants: ['engineer'], positions: [{ role: 'engineer', text: 'Ready to share', ts: '2026-11-18' }], actions: ['T-1'],
  }) + '\n');
  await put('.claude/agents/engineer.md', '---\nname: engineer\ndescription: Builds things\ntools: Read, Bash\nskills: game-build\nmemory: project\n---\nLegacy role instructions');
  await put('.claude/agents/librarian.md', '---\nname: librarian\ndescription: Maintains knowledge\n---\nprivate librarian prompt');
  await put('.git/worktrees/feature/gitdir', join(workspace, 'external', '.git') + '\n');
  await put('.git/worktrees/review/gitdir', join(workspace, 'external-review', '.git') + '\n');
  await put('.git/worktrees/review/HEAD', 'ref: refs/heads/feature/T-2-revision\n');
  await put('studio/artifacts/report.md', 'report');
  const clip = Buffer.from([1, 0, 255, 128]);
  await put('studio/artifacts/clip.mp4', clip);
  await put('studio/artifacts/unselected.bin', Buffer.from([2, 0]));
  await symlink(join(source, 'studio/artifacts/report.md'), join(source, 'studio/artifacts/link.md'));
  await writeFile(join(workspace, 'outside.md'), 'outside');
  await link(join(workspace, 'outside.md'), join(source, 'studio/artifacts/hardlink.md'));
  const paths = (await readdir(source, { recursive: true })).sort();
  const board = await readFile(join(source, 'studio/board.json'), 'utf8');

  const payload = await prepareLegacyImport({ source, root, name: 'New', artifactPaths: ['studio/artifacts/report.md', 'studio/artifacts/clip.mp4'] });
  const [work, question, registered, before] = payload.tasks;
  assert.equal(payload.studio.root, root);
  assert.equal(payload.studio.lifecycle, 'paused');
  assert.equal(payload.studio.language, 'English');
  assert.equal(payload.studio.projectLanguage, 'Français');
  assert.equal((await prepareLegacyImport({ source, root, language: 'Deutsch' })).studio.language, 'Deutsch');
  assert.equal(payload.studio.agents.find(({ name }) => name === 'librarian')?.role, 'library');
  assert.equal(work.legacyId, 'T-1');
  assert.equal(work.stage, 'blocked');
  assert.equal(work.legacyWorktreeReview, true);
  assert.equal(registered.legacyWorktreeReview, true);
  assert.equal(registered.legacyBranch, 'feature/T-2-revision');
  assert.equal(work.agentId, payload.studio.agents[0].id);
  assert.equal(work.epicId, payload.epics[0].id);
  assert.equal(work.storyId, payload.stories[0].id);
  assert.equal(work.sprintId, payload.sprints[0].id);
  assert.equal(payload.inbox[0].taskId, question.id);
  assert.equal(payload.inbox[0].answer, 'Approved');
  assert.deepEqual(work.dependencies, [before.id]);
  assert.deepEqual(work.links, [{ type: 'origin', taskId: before.id }]);
  assert.deepEqual(work.references, [{ kind: 'story', id: payload.stories[0].id }]);
  assert.deepEqual(work.criteria, ['A report exists']);
  assert.equal(work.artifactPath, 'studio/artifacts/report.md');
  assert.equal(payload.meetings[0].taskId, work.id);
  assert.equal(payload.meetings[0].sprintId, work.sprintId);
  assert.equal(payload.meetings[0].decision, 'Review again');
  assert.equal(payload.meetings[1].decision, 'Accept the report');
  assert.equal(payload.meetings[1].sprintId, work.sprintId);
  assert.deepEqual(payload.meetings[1].taskIds, [work.id]);
  assert.deepEqual(payload.meetings[1].messages, [{ role: 'engineer', text: 'Ready to share', createdAt: '2026-11-18' }]);
  assert.match(payload.warnings.join('\n'), /feature\/game-work/);
  assert.match(payload.warnings.join('\n'), /вне выбранной папки/);
  assert.deepEqual(payload.artifacts, [{ path: 'studio/artifacts/report.md', content: 'report' }]);
  assert.equal(payload.evidence.length, 1);
  assert.deepEqual(Buffer.from(payload.evidence[0].content, 'base64'), clip);
  assert.equal(payload.evidence[0].taskId, work.id);
  assert.doesNotMatch(JSON.stringify(payload), /unselected/);
  assert.deepEqual(payload.studio.agents[0].legacyContract, {
    instructions: 'Legacy role instructions', tools: 'Read, Bash', skills: 'game-build', memory: 'project',
  });
  assert.doesNotMatch(JSON.stringify(payload), /private-token/);
  assert.deepEqual((await readdir(source, { recursive: true })).sort(), paths);
  assert.equal(await readFile(join(source, 'studio/board.json'), 'utf8'), board);
  assert.deepEqual(await readdir(root), []);
  await assert.rejects(prepareLegacyImport({ source, root, artifactPaths: ['studio/artifacts/link.md'] }), /артефакт/i);
  await assert.rejects(prepareLegacyImport({ source, root, artifactPaths: ['studio/artifacts/hardlink.md'] }), /артефакт/i);
  await assert.rejects(prepareLegacyImport({ source, root: source }), /отдельн/i);
  await assert.rejects(prepareLegacyImport({ source, root: workspace }), /отдельн/i);
  await assert.rejects(prepareLegacyImport({ source, root, artifactPaths: ['studio/artifacts/../../outside'] }), /путь/i);
});
