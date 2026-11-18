import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile, readFile, readdir, truncate } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { previewImport } from '../migration/preview.mjs';

const tmp = fileURLToPath(new URL('../.tmp/', import.meta.url));

async function fixture(t) {
  await mkdir(tmp, { recursive: true });
  const root = await mkdtemp(join(tmp, 'import-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const put = async (name, data) => {
    const path = join(root, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, typeof data === 'string' ? data : JSON.stringify(data));
  };
  return { root, put };
}

const preview = root => previewImport({ root });

test('summarizes the legacy layout without copying content or creating files', async t => {
  const { root, put } = await fixture(t);
  await put('studio/board.json', {
    schema: 2,
    tasks: [
      { id: 'T-1', title: 'private-task-title' },
      { id: 'T-2', type: 'question', status: 'backlog' },
      { id: 'T-3', type: 'question', status: 'done' },
    ],
  });
  await put('studio/archive/sprint-001.json', { tasks: [{ id: 'T-4' }] });
  await put('studio/archive/events-sprint-001.jsonl', 'private-event\n');
  await put('studio/inbox.md', '- [ ] private-owner-message\n');
  await put('.claude/agents/director.md', 'private-agent-prompt');
  await put('.claude/agents/settings.json', '{}');
  await put('.git/worktrees/feature/gitdir', join(await realpath(root), 'feature', '.git') + '\n');
  await put('feature/.git', 'gitdir: ../.git/worktrees/feature\n');
  await put('game/project.godot', 'private-project');
  await put('studio/artifacts/run/one.txt', '12345');
  await put('studio/artifacts/two.txt', '123');
  await put('studio/artifacts/.DS_Store', 'ignored bookkeeping');
  const filesBefore = await readdir(root, { recursive: true });
  const boardBefore = await readFile(join(root, 'studio/board.json'), 'utf8');

  const report = await preview(root + '/.');
  assert.deepEqual(report, {
    root: await realpath(root),
    valid: true,
    counts: { tasks: 3, archivedTasks: 1, roles: 1, openQuestions: 1, worktrees: 1, artifacts: 2 },
    artifactBytes: 8,
    projectCandidates: [join(await realpath(root), 'game')],
    worktreeStatus: { existing: 1, missing: 0, external: 0, unverified: 0 },
    warnings: [],
  });
  assert.deepEqual((await readdir(root, { recursive: true })).sort(), filesBefore.sort());
  assert.equal(await readFile(join(root, 'studio/board.json'), 'utf8'), boardBefore);
});

test('accepts a schema-1 board and identifies unrecognized source folders', async t => {
  const { root, put } = await fixture(t);
  assert.equal((await preview(root)).valid, false);
  await put('studio/board.json', { tasks: [] });
  const report = await preview(root);
  assert.equal(report.valid, true);
  assert.deepEqual(report.projectCandidates, []);
  assert.ok(report.warnings.some(warning => warning.includes('project.godot')));
});

test('reports corrupt archives and limits oversized metadata reads', async t => {
  const { root, put } = await fixture(t);
  await put('studio/board.json', { schema: 2, tasks: [null, { id: 'T-1' }] });
  await put('studio/archive/sprint-001.json', 'private-invalid-json');
  await put('studio/archive/sprint-002.json', '');
  await truncate(join(root, 'studio/archive/sprint-002.json'), 32 * 1024 * 1024);
  const report = await preview(root);
  assert.equal(report.valid, true);
  assert.equal(report.counts.tasks, 1);
  assert.equal(report.counts.archivedTasks, 0);
  assert.ok(report.warnings.some(warning => warning.includes('studio/board.json')));
  assert.ok(report.warnings.some(warning => warning.includes('архив')));
  assert.ok(report.warnings.some(warning => warning.includes('лимит')));
  assert.doesNotMatch(JSON.stringify(report), /private-invalid-json/);

  await put('studio/board.json', { schema: 99, tasks: [] });
  assert.equal((await preview(root)).valid, false);
});

test('ignores symbolic links in import data and hides their targets', async t => {
  const { root, put } = await fixture(t);
  const outside = await fixture(t);
  await outside.put('board.json', { schema: 2, tasks: [{ id: 'secret-id' }] });
  await outside.put('project.godot', 'private-project');
  await put('studio/artifacts/own.txt', '1234');
  await symlink(join(outside.root, 'board.json'), join(root, 'studio', 'board.json'));
  await symlink(outside.root, join(root, 'studio', 'artifacts', 'link'));
  await symlink(outside.root, join(root, 'game'));
  const report = await preview(root);
  assert.equal(report.valid, false);
  assert.equal(report.counts.tasks, 0);
  assert.equal(report.counts.artifacts, 1);
  assert.equal(report.artifactBytes, 4);
  assert.deepEqual(report.projectCandidates, []);
  assert.ok(report.warnings.some(warning => warning.includes('символическ')));
  assert.equal(JSON.stringify(report).includes(outside.root), false);
});

test('ignores an intermediate symbolic link and rejects unsafe root inputs', async t => {
  const { root } = await fixture(t);
  const outside = await fixture(t);
  await outside.put('board.json', { tasks: [{ id: 'private' }] });
  await symlink(outside.root, join(root, 'studio'));
  assert.equal((await preview(root)).counts.tasks, 0);
  assert.equal((await preview('.')).valid, false);
  assert.equal((await preview('file:///some/path')).valid, false);
  assert.equal((await preview(join(root, 'missing'))).valid, false);
});

test('reports a dangling studio link even when its board cannot be resolved', async t => {
  const { root } = await fixture(t);
  await symlink(join(root, 'missing'), join(root, 'studio'));
  const report = await preview(root);
  assert.equal(report.valid, false);
  assert.ok(report.warnings.some(warning => warning.includes('символическ')));
});

test('separates missing, external, and unverifiable worktree registrations', async t => {
  const { root, put } = await fixture(t);
  const outside = await fixture(t);
  const canonical = await realpath(root);
  await put('studio/board.json', { tasks: [] });
  await put('.git/worktrees/missing/gitdir', join(canonical, 'absent', '.git') + '\n');
  await put('.git/worktrees/external/gitdir', join(outside.root, 'private', '.git') + '\n');
  await put('.git/worktrees/malformed/gitdir', 'hidden-malformed-record\nextra\n');
  await put('.git/worktrees/incomplete/HEAD', 'ignored metadata');
  await put('.git/worktrees/linked/gitdir', join(canonical, 'alias', '.git') + '\n');
  await symlink(outside.root, join(root, 'alias'));
  const report = await preview(root);
  assert.equal(report.counts.worktrees, 5);
  assert.deepEqual(report.worktreeStatus, { existing: 0, missing: 1, external: 1, unverified: 3 });
  assert.ok(report.warnings.some(warning => warning.includes('вне выбранной папки')));
  assert.ok(report.warnings.some(warning => warning.includes('отсутствуют')));
  assert.ok(report.warnings.some(warning => warning.includes('проверить вручную')));
  assert.doesNotMatch(JSON.stringify(report), /hidden-malformed-record|private/);
  assert.equal(JSON.stringify(report).includes(outside.root), false);
});
