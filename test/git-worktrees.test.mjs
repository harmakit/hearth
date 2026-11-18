import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createGitWorktrees } from '../app/git-worktrees.mjs';

function run(repository, ...args) {
  return execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' }).trim();
}

async function fixture(t) {
  const tmp = resolve('.tmp');
  await mkdir(tmp, { recursive: true });
  const root = await realpath(await mkdtemp(join(tmp, 'git-worktrees-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = join(root, 'source');
  const storageDir = join(root, 'storage');
  await mkdir(repository);
  run(repository, 'init', '--quiet', '-b', 'main');
  run(repository, 'config', 'user.name', 'Hearth Test');
  run(repository, 'config', 'user.email', 'hearth@example.invalid');
  await writeFile(join(repository, 'project.txt'), 'tracked\n');
  run(repository, 'add', '--', 'project.txt');
  run(repository, 'commit', '--quiet', '-m', 'Base');
  const options = { storageDir, validateRepository: candidate => candidate === repository };
  const request = { repository, targetRef: 'main', studioId: 'studio-1', taskId: 'task-1' };
  return { root, repository, storageDir, options, request };
}

test('reuses a registered worktree across requests and app restarts', async t => {
  const { repository, options, request } = await fixture(t);
  const registry = createGitWorktrees(options);
  const originalOid = run(repository, 'rev-parse', 'HEAD');
  const [first, second] = await Promise.all([
    registry.ensureWorktree(request),
    registry.ensureWorktree(request),
  ]);
  assert.deepEqual(first, second);
  assert.equal(first.baseOid, originalOid);
  assert.equal(first.targetRef, 'refs/heads/main');
  assert.equal(run(first.path, 'symbolic-ref', 'HEAD'), first.branchRef);
  assert.equal(await readFile(join(first.path, 'project.txt'), 'utf8'), 'tracked\n');
  await writeFile(join(first.path, 'project.txt'), 'task change\n');
  run(repository, 'update-ref', 'refs/heads/release', originalOid);
  const restarted = createGitWorktrees(options);
  assert.deepEqual(await restarted.ensureWorktree({ ...request, targetRef: first.targetRef }), first);
  assert.deepEqual(await restarted.getWorktree(first.id), first);
  assert.deepEqual(await restarted.listWorktrees({ studioId: request.studioId }), [first]);
  await assert.rejects(restarted.ensureWorktree({ ...request, targetRef: 'release' }), /bound|registered/i);
  assert.equal(await readFile(join(repository, 'project.txt'), 'utf8'), 'tracked\n');
  assert.equal(run(repository, 'rev-parse', 'HEAD'), originalOid);
  assert.equal(run(repository, 'status', '--porcelain'), '');
});

test('validates canonical repository and accepts only a local target branch', async t => {
  const { root, repository, options, request } = await fixture(t);
  const registry = createGitWorktrees(options);
  const forged = join(root, 'forged');
  await symlink(root, forged);
  await assert.rejects(registry.ensureWorktree({ ...request, repository: forged }));
  await assert.rejects(registry.ensureWorktree({ ...request, targetRef: 'HEAD' }));
  await assert.rejects(registry.ensureWorktree({ ...request, targetRef: '--help' }));
  await assert.rejects(registry.ensureWorktree({ ...request, targetRef: 'main~1' }));
  const target = await registry.prepareTarget({ repository, targetRef: 'main', baseRef: 'HEAD' });
  assert.equal(target.baseOid, run(repository, 'rev-parse', 'HEAD'));
  assert.equal(target.targetOid, target.baseOid);
  assert.deepEqual(await registry.listWorktrees({ studioId: request.studioId }), []);
});

test('only an explicit create prepares an absent target, and later calls preserve its OID', async t => {
  const { repository, options } = await fixture(t);
  const registry = createGitWorktrees(options);
  const targetRef = 'refs/heads/hearth-studio/studio-1';
  await assert.rejects(registry.prepareTarget({ repository, targetRef }));
  assert.equal(run(repository, 'for-each-ref', '--format=%(refname)', targetRef), '');
  const first = await registry.prepareTarget({ repository, targetRef, baseRef: 'HEAD', create: true });
  assert.equal(first.baseOid, run(repository, 'rev-parse', 'HEAD'));
  assert.equal(first.targetOid, run(repository, 'rev-parse', targetRef));
  run(repository, 'commit', '--quiet', '--allow-empty', '-m', 'Move main');
  const later = await registry.prepareTarget({ repository, targetRef, baseRef: 'HEAD', create: true });
  assert.equal(later.targetOid, first.targetOid);
  assert.notEqual(later.baseOid, first.baseOid);
});

test('continues a pending registration by verifying the same checked-out worktree', async t => {
  const { storageDir, repository, options, request } = await fixture(t);
  const registry = createGitWorktrees(options);
  const record = await registry.ensureWorktree(request);
  const registration = join(storageDir, 'worktree-registry', `${record.id}.json`);
  await writeFile(registration, JSON.stringify({ ...record, status: 'pending' }));
  const restarted = createGitWorktrees(options);
  assert.deepEqual(await restarted.ensureWorktree(request), record);
  assert.deepEqual(run(repository, 'for-each-ref', '--format=%(refname)', 'refs/heads/hearth/'), record.branchRef);
});

test('recovers the registered base after interruption before checkout and target movement', async t => {
  const { storageDir, repository, options, request } = await fixture(t);
  const registry = createGitWorktrees(options);
  const record = await registry.ensureWorktree(request);
  run(repository, 'worktree', 'remove', record.path);
  run(repository, 'commit', '--quiet', '--allow-empty', '-m', 'Move target');
  await writeFile(join(storageDir, 'worktree-registry', `${record.id}.json`),
    JSON.stringify({ ...record, status: 'pending' }));
  const restarted = createGitWorktrees(options);
  assert.deepEqual(await restarted.ensureWorktree(request), record);
  assert.equal(run(record.path, 'rev-parse', 'HEAD'), record.baseOid);
  assert.notEqual(run(repository, 'rev-parse', 'HEAD'), record.baseOid);
});

test('does not adopt a branch that existed before its registration', async t => {
  const { repository, options, request } = await fixture(t);
  const id = createHash('sha256').update(JSON.stringify([request.studioId, request.taskId])).digest('hex');
  run(repository, 'branch', `hearth/${id}`);
  const registry = createGitWorktrees(options);
  await assert.rejects(registry.ensureWorktree(request), /already|registered/i);
  assert.deepEqual(await registry.listWorktrees({ studioId: request.studioId }), []);
});

test('retains a terminal registration after the managed checkout is removed', async t => {
  const { repository, options, request } = await fixture(t);
  const registry = createGitWorktrees(options);
  const record = await registry.ensureWorktree(request);
  await assert.rejects(registry.markCleaned(record.id), /present|exists/i);
  run(repository, 'worktree', 'remove', record.path);
  const cleaned = await registry.markCleaned(record.id);
  assert.equal(cleaned.status, 'cleaned');
  assert.ok(cleaned.cleanedAt);
  assert.deepEqual(await registry.getWorktree(record.id, false), cleaned);
  assert.deepEqual(await registry.markCleaned(record.id), cleaned);
  await assert.rejects(registry.getWorktree(record.id), /cleaned/i);
  await assert.rejects(registry.ensureWorktree(request), /cleaned/i);
});

test('refuses to use a replaced registered path', async t => {
  const { root, repository, options, request } = await fixture(t);
  const registry = createGitWorktrees(options);
  const record = await registry.ensureWorktree(request);
  run(repository, 'worktree', 'move', record.path, join(root, 'old-worktree'));
  await symlink(repository, record.path);
  await assert.rejects(registry.getWorktree(record.id), /path|worktree/i);
  await assert.rejects(registry.ensureWorktree(request), /path|worktree/i);
});

test('rejects a worktree Git pointer to metadata outside the registered repository', async t => {
  const { root, options, request } = await fixture(t);
  const registry = createGitWorktrees(options);
  const record = await registry.ensureWorktree(request);
  const pointer = join(record.path, '.git');
  const admin = run(record.path, 'rev-parse', '--absolute-git-dir');
  const outside = join(root, 'outside-git');
  await cp(admin, outside, { recursive: true });
  await writeFile(join(outside, 'commondir'), `${record.gitCommonDir}\n`);
  await writeFile(pointer, `gitdir: ${outside}\n`);
  await assert.rejects(registry.getWorktree(record.id), /metadata|registration/i);
});

test('creates a worktree with hooks and repository filters disabled', async t => {
  const { repository, options, request } = await fixture(t);
  await writeFile(join(repository, '.gitattributes'), 'project.txt filter=test-filter\n');
  run(repository, 'add', '--', '.gitattributes');
  run(repository, 'commit', '--quiet', '-m', 'Configure fixture');
  run(repository, 'config', 'filter.test-filter.smudge', 'false');
  run(repository, 'config', 'filter.test-filter.required', 'true');
  await writeFile(join(repository, '.git/hooks/post-checkout'), '#!/bin/sh\nexit 7\n', { mode: 0o755 });
  const created = await createGitWorktrees(options).ensureWorktree(request);
  assert.equal(await readFile(join(created.path, 'project.txt'), 'utf8'), 'tracked\n');
});
