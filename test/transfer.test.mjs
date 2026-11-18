import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createStudioService } from '../core/service.mjs';
import { makeStudioBundle, prepareBundleImport, prepareLegacyImport } from '../migration/transfer.mjs';

const studio = {
  id: 'studio-native', root: '/old/project', name: 'Old studio',
  brief: 'Open /old/project for context. Also see /Users/alice/private.md and C:\\private\\file.txt.', language: 'English', approveSprints: false,
  lifecycle: 'active', director: { runtime: 'codex', model: 'gpt', apiKey: 'secret' },
  agents: [{ id: 'agent-native', name: 'Builder', role: 'engineer', mode: 'inherit', sessionId: 'private-session' }],
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
    tasks: [{ key: 'draft', agentKey: 'agent-native', reviewerKey: 'reviewer', requiresAcceptance: true, dependsOn: ['prior'] }],
  })],
  epics: [owned({ id: 'epic-native', title: 'Epic' })],
  stories: [owned({ id: 'story-native', epicId: 'epic-native', title: 'Story', acceptance: 'Deliver the report' })],
  sprints: [owned({ id: 'sprint-native', epicId: 'epic-native', storyId: 'story-native', title: 'Sprint', summary: 'Sprint brief' })],
  meetings: [owned({ id: 'meet-native', taskId: 'task-native', sprintId: 'sprint-native', title: 'Meeting', decision: 'Send report' })],
};

test('a template preserves only role setup and drops local information', () => {
  const bundle = makeStudioBundle(snapshot, { studioId: studio.id, mode: 'template' });
  assert.equal(bundle.version, 1);
  assert.equal(bundle.mode, 'template');
  assert.equal(bundle.studio.agents[0].name, 'Builder');
  for (const key of ['tasks', 'inbox', 'plans', 'epics', 'stories', 'sprints', 'meetings']) assert.deepEqual(bundle[key], []);
  assert.doesNotMatch(JSON.stringify(bundle), /private-session|secret|\/old\/project|studio-native|agent-native/);
  assert.doesNotMatch(bundle.studio.brief, /alice|private/);
  const copy = prepareBundleImport(bundle, { root: '/new/project', name: 'New studio' });
  assert.equal(copy.studio.name, 'New studio');
  assert.equal(copy.studio.root, '/new/project');
  assert.equal(copy.studio.lifecycle, 'draft');
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
  assert.throws(() => copy({ version: 2 }), /верси/i);
  assert.throws(() => copy({ tasks: [{ ...bundle.tasks[0], dependencies: ['unknown'] }] }), /связ/i);
  assert.throws(() => copy({ tasks: [{ ...bundle.tasks[0], artifactPath: '../outside' }, bundle.tasks[1]] }), /путь/i);
  assert.throws(() => copy({ artifacts: [{ path: 'C:\\outside', content: 'unsafe' }] }), /путь/i);
  assert.throws(() => copy({ artifacts: [{ path: 'reports/.env', content: 'unsafe' }] }), /путь/i);
  assert.throws(() => copy({ plans: [{ ...bundle.plans[0], files: [{ path: '/outside', content: 'unsafe' }] }] }), /путь/i);
  assert.throws(() => copy({ epics: false }), /формат/i);
  assert.equal(copy({}).tasks[0].artifactPath ?? '', '');
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
  assert.equal(result.tasks.length, 4);
  const [plan] = result.plans.filter(item => item.studioId === first.id);
  const [approval] = result.inbox.filter(item => item.planId === plan.id);
  assert.equal(plan.status, 'returned');
  assert.equal(approval.status, 'resolved');
  assert.equal(runs, 0);
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
    await writeFile(file, typeof content === 'string' ? content : JSON.stringify(content));
  };
  await mkdir(root);
  await put('studio/board.json', {
    schema: 2, tasks: [
      { id: 'T-1', title: 'First', status: 'in-progress', epic: 'E-1', story: 'US-1', sprint: 4, assignee: 'engineer',
        deps: ['T-0'], acceptance: ['A report exists'], branch: 'feature/game-work', outputs: ['studio/artifacts/report.md'] },
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
  await put('.claude/agents/engineer.md', '---\nname: engineer\ndescription: Builds things\n---\nprivate system prompt');
  await put('.git/worktrees/feature/gitdir', join(workspace, 'external', '.git') + '\n');
  await put('.git/worktrees/review/gitdir', join(workspace, 'external-review', '.git') + '\n');
  await put('.git/worktrees/review/HEAD', 'ref: refs/heads/feature/T-2-revision\n');
  await put('studio/artifacts/report.md', 'report');
  await symlink(join(source, 'studio/artifacts/report.md'), join(source, 'studio/artifacts/link.md'));
  const paths = (await readdir(source, { recursive: true })).sort();
  const board = await readFile(join(source, 'studio/board.json'), 'utf8');

  const payload = await prepareLegacyImport({ source, root, name: 'New', artifactPaths: ['studio/artifacts/report.md'] });
  const [work, question, registered, before] = payload.tasks;
  assert.equal(payload.studio.root, root);
  assert.equal(payload.studio.lifecycle, 'paused');
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
  assert.doesNotMatch(JSON.stringify(payload), /private system prompt/);
  assert.deepEqual((await readdir(source, { recursive: true })).sort(), paths);
  assert.equal(await readFile(join(source, 'studio/board.json'), 'utf8'), board);
  assert.deepEqual(await readdir(root), []);
  await assert.rejects(prepareLegacyImport({ source, root, artifactPaths: ['studio/artifacts/link.md'] }), /артефакт/i);
  await assert.rejects(prepareLegacyImport({ source, root: source }), /отдельн/i);
  await assert.rejects(prepareLegacyImport({ source, root: workspace }), /отдельн/i);
  await assert.rejects(prepareLegacyImport({ source, root, artifactPaths: ['studio/artifacts/../../outside'] }), /путь/i);
});
