import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createGitDelivery } from '../app/git-delivery.mjs';
import { createGitWorktrees, git } from '../app/git-worktrees.mjs';

async function fixture(t) {
  const temporaryRoot = fileURLToPath(new URL('../.tmp/', import.meta.url));
  await mkdir(temporaryRoot, { recursive: true });
  const root = await realpath(await mkdtemp(join(temporaryRoot, 'git-delivery-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = join(root, 'repository');
  await mkdir(repository);
  await git(repository, ['init', '--initial-branch=main']);
  await git(repository, ['config', 'user.name', 'Fixture']);
  await git(repository, ['config', 'user.email', 'fixture@example.invalid']);
  await writeFile(join(repository, 'project.txt'), 'original\n');
  await git(repository, ['add', 'project.txt']);
  await git(repository, ['commit', '-m', 'Initial']);
  const baseOid = (await git(repository, ['rev-parse', 'HEAD'])).trim();
  const targetRef = 'refs/heads/delivery';
  await git(repository, ['branch', 'delivery', baseOid]);
  const storageDir = join(root, 'storage');
  const worktrees = createGitWorktrees({ storageDir, validateRepository: (path) => path === repository });
  const worktree = await worktrees.ensureWorktree({ studioId: 'studio', taskId: 'task', repository, targetRef });
  const delivery = createGitDelivery({ storageDir });
  const readRef = async (ref) => (await git(repository, ['rev-parse', '--verify', ref])).trim();
  const changeTask = (text = 'task version\n') => writeFile(join(worktree.path, 'project.txt'), text);
  const checkoutTarget = async () => {
    const targetPath = join(root, 'target');
    await git(repository, ['worktree', 'add', targetPath, 'delivery']);
    return targetPath;
  };
  const advanceTarget = async (filename, text) => {
    const targetPath = await checkoutTarget();
    await writeFile(join(targetPath, filename), text);
    await git(targetPath, ['add', '--', filename]);
    await git(targetPath, ['commit', '-m', 'Independent target update']);
    await git(repository, ['worktree', 'remove', targetPath]);
    return readRef(targetRef);
  };
  const candidate = async () => {
    const frozen = await delivery.freezeWork({ worktree });
    await delivery.releaseCandidate({ worktree, root: frozen.root });
    return delivery.prepareCandidate({ worktree, revision: frozen.revision });
  };
  const approval = (revision, operationId = 'integration') => ({
    worktree, revision, operationId,
    receipt: { id: 'receipt', taskId: worktree.taskId, revision, reviewerId: 'reviewer', checkIds: ['candidate-check'], result: 'PASS' },
  });
  return { root, worktree, storageDir, delivery, readRef, changeTask, checkoutTarget, advanceTarget, candidate, approval };
}

test('freezes managed edits, merges the checked candidate, and opens an uncontaminated review checkout', async (t) => {
  const f = await fixture(t);
  await f.changeTask();
  await writeFile(join(f.worktree.path, 'created\nfile.txt'), 'new file\n');
  const frozen = await f.delivery.freezeWork({ worktree: f.worktree });
  assert.deepEqual(frozen.changedPaths, ['created\nfile.txt', 'project.txt']);
  assert.notEqual(frozen.root, f.worktree.path);
  assert.equal(frozen.revision.headOid, await f.readRef(f.worktree.branchRef));
  await writeFile(join(frozen.root, 'check-output.txt'), 'written by a check\n');
  await f.delivery.releaseCandidate({ worktree: f.worktree, root: frozen.root });
  await f.delivery.releaseCandidate({ worktree: f.worktree, root: frozen.root });
  await assert.rejects(readFile(join(frozen.root, 'check-output.txt')), { code: 'ENOENT' });
  await assert.rejects(f.delivery.releaseCandidate({ worktree: f.worktree, root: f.worktree.path }));
  assert.equal(await readFile(join(f.worktree.path, 'project.txt'), 'utf8'), 'task version\n');

  const candidate = await f.delivery.prepareCandidate({ worktree: f.worktree, revision: frozen.revision });
  await writeFile(join(candidate.root, 'project.txt'), 'changed during checks\n');
  const review = await f.delivery.getCandidate({ worktree: f.worktree, revision: candidate.revision });
  assert.notEqual(review.root, candidate.root);
  assert.equal(await readFile(join(review.root, 'project.txt'), 'utf8'), 'task version\n');
  assert.equal(await f.delivery.isMerged(f.worktree), false);
  const result = await f.delivery.integrate(f.approval(candidate.revision));
  assert.deepEqual(result, { status: 'merged', targetOid: candidate.revision.candidateOid });
  assert.equal(await f.readRef(f.worktree.targetRef), result.targetOid);
  assert.equal(await f.delivery.isMerged(f.worktree), true);
  assert.equal(await readFile(join(f.worktree.repository, 'project.txt'), 'utf8'), 'original\n');
  assert.equal(await f.readRef('refs/heads/main'), f.worktree.baseOid);
  const integrated = await f.delivery.getIntegratedCandidate({ worktree: f.worktree, revision: candidate.revision });
  assert.equal(await readFile(join(integrated.root, 'project.txt'), 'utf8'), 'task version\n');
  assert.equal(integrated.revision.candidateOid, result.targetOid);
  await f.delivery.releaseCandidate({ worktree: f.worktree, root: integrated.root });
  await assert.rejects(f.delivery.getIntegratedCandidate({ worktree: f.worktree, revision: { ...candidate.revision, digest: 'invalid' } }), {code:'STALE_REVISION'});
  await f.delivery.releaseCandidate({ worktree: f.worktree, root: candidate.root });
  await f.delivery.releaseCandidate({ worktree: f.worktree, root: review.root });
});

test('rejects a receipt for another task, revision, or result and detects dirty managed work', async (t) => {
  const f = await fixture(t);
  await f.changeTask();
  const { revision } = await f.candidate();
  const approved = f.approval(revision);
  for (const fields of [{ taskId: 'another task' }, { revision: { ...revision, digest: 'bad' } }, { result: 'FAIL' }]) {
    await assert.rejects(f.delivery.integrate({ ...approved, receipt: { ...approved.receipt, ...fields } }), { code: 'INVALID_RECEIPT' });
  }
  await f.changeTask('from a later edit\n');
  await assert.rejects(f.delivery.integrate(approved), { code: 'STALE_REVISION' });
  assert.equal(await f.readRef(f.worktree.targetRef), f.worktree.baseOid);
});

test('blocks a checked-out target, a changed target, and a conflicting candidate', async (t) => {
  const f = await fixture(t);
  await f.changeTask();
  const { revision } = await f.candidate();
  const targetPath = await f.checkoutTarget();
  await assert.rejects(f.delivery.integrate(f.approval(revision)), { code: 'TARGET_CHECKED_OUT' });
  assert.equal(await f.readRef(f.worktree.targetRef), f.worktree.baseOid);
  await git(f.worktree.repository, ['worktree', 'remove', targetPath]);
  const changedTarget = await f.advanceTarget('project.txt', 'conflicting target version\n');
  await assert.rejects(f.delivery.integrate(f.approval(revision)), { code: 'TARGET_CHANGED' });
  const frozen = await f.delivery.freezeWork({ worktree: f.worktree });
  await assert.rejects(f.delivery.prepareCandidate({ worktree: f.worktree, revision: frozen.revision }), { code: 'MERGE_CONFLICT' });
  assert.equal(await f.readRef(f.worktree.targetRef), changedTarget);
  assert.equal(await readFile(join(f.worktree.path, 'project.txt'), 'utf8'), 'task version\n');
});

test('promotes a clean divergent candidate that includes the independent target update', async (t) => {
  const f = await fixture(t);
  await f.changeTask();
  const independentTarget = await f.advanceTarget('independent.txt', 'target version\n');
  const { revision, root } = await f.candidate();
  assert.equal(revision.targetOid, independentTarget);
  assert.deepEqual((await git(root, ['show', '-s', '--format=%P', 'HEAD'])).trim().split(' '), [revision.targetOid, revision.headOid]);
  assert.equal(await readFile(join(root, 'independent.txt'), 'utf8'), 'target version\n');
  assert.equal(await readFile(join(root, 'project.txt'), 'utf8'), 'task version\n');
  await f.delivery.integrate(f.approval(revision));
  assert.equal(await f.readRef(f.worktree.targetRef), revision.candidateOid);
});

test('recovers an operation when the process lost the result after updating refs', async (t) => {
  const f = await fixture(t);
  await f.changeTask();
  const { revision } = await f.candidate();
  const approving = f.approval(revision, 'operation-with-lost-reply');
  const unreliableGit = async (repository, args, options) => {
    const output = await git(repository, args, options);
    if (args.includes('update-ref') && args.includes('--stdin')) throw new Error('Lost response after Git updated refs');
    return output;
  };
  const interrupted = createGitDelivery({ storageDir: f.storageDir, git: unreliableGit });
  await assert.rejects(interrupted.integrate(approving), /Lost response/);
  assert.equal(await f.readRef(f.worktree.targetRef), revision.candidateOid);
  await f.advanceTarget('later.txt', 'target advanced again\n');
  const restarted = createGitDelivery({ storageDir: f.storageDir, git });
  assert.deepEqual(await restarted.integrate(approving), { status: 'merged', targetOid: revision.candidateOid });
  await assert.rejects(restarted.integrate({ ...approving, receipt: { ...approving.receipt, id: 'other-receipt' } }), { code: 'OPERATION_MISMATCH' });
  assert.equal(await restarted.isMerged(f.worktree), true);
});

test('verifies the checked-out HEAD and tracked files while allowing untracked evidence', async (t) => {
  const f = await fixture(t);
  await f.changeTask();
  const { root, revision } = await f.candidate();
  await writeFile(join(root, 'check-output.txt'), 'untracked evidence\n');
  await f.delivery.verifyCheckout({ root, revision });
  await writeFile(join(root, 'project.txt'), 'modified tracked file\n');
  await assert.rejects(f.delivery.verifyCheckout({ root, revision }), { code: 'CHECKOUT_CHANGED' });
  await git(root, ['reset', '--hard', revision.baseOid]);
  await assert.rejects(f.delivery.verifyCheckout({ root, revision }), { code: 'CHECKOUT_CHANGED' });
});

test('conditional integration preserves a target change made immediately before the ref transaction', async (t) => {
  const f = await fixture(t);
  await f.changeTask();
  const { revision } = await f.candidate();
  await git(f.worktree.repository, ['commit', '--allow-empty', '-m', 'Concurrent branch advance']);
  const unrelatedUpdate = await f.readRef('refs/heads/main');
  const concurrentGit = async (repository, args, options) => {
    if (args.includes('update-ref') && args.includes('--stdin')) {
      await git(repository, ['update-ref', f.worktree.targetRef, unrelatedUpdate, revision.targetOid]);
    }
    return git(repository, args, options);
  };
  const delivery = createGitDelivery({ storageDir: f.storageDir, git: concurrentGit });
  await assert.rejects(delivery.integrate(f.approval(revision)), { code: 'TARGET_CHANGED' });
  assert.equal(await f.readRef(f.worktree.targetRef), unrelatedUpdate);
  assert.equal(await f.delivery.isMerged(f.worktree), false);
});

test('owns the target checkout through the ref transaction and releases it afterwards', async (t) => {
  const f = await fixture(t);
  await f.changeTask();
  const { revision } = await f.candidate();
  const concurrentGit = async (repository, args, options) => {
    if (args.includes('update-ref') && args.includes('--stdin')) {
      await assert.rejects(f.checkoutTarget(), /already (?:used by worktree|checked out)/i);
      await assert.rejects(git(f.worktree.repository, ['switch', 'delivery']), /already (?:used by worktree|checked out)/i);
      assert.equal(await f.readRef(f.worktree.targetRef), revision.targetOid);
    }
    return git(repository, args, options);
  };
  const delivery = createGitDelivery({ storageDir: f.storageDir, git: concurrentGit });
  assert.deepEqual(await delivery.integrate(f.approval(revision)), { status: 'merged', targetOid: revision.candidateOid });
  const targetPath = await f.checkoutTarget();
  assert.equal(await readFile(join(targetPath, 'project.txt'), 'utf8'), 'task version\n');
});

test('preserves a user worktree created just before Hearth acquires the target', async (t) => {
  const f = await fixture(t);
  await f.changeTask();
  const { revision } = await f.candidate();
  let targetPath;
  const concurrentGit = async (repository, args, options) => {
    if (args[0] === 'worktree' && args[1] === 'add' && args.includes('--no-checkout')) {
      targetPath = await f.checkoutTarget();
    }
    return git(repository, args, options);
  };
  const delivery = createGitDelivery({ storageDir: f.storageDir, git: concurrentGit });
  await assert.rejects(delivery.integrate(f.approval(revision)), { code: 'TARGET_CHECKED_OUT' });
  assert.equal(await f.readRef(f.worktree.targetRef), revision.targetOid);
  assert.equal(await readFile(join(targetPath, 'project.txt'), 'utf8'), 'original\n');
  assert.equal(await f.delivery.isMerged(f.worktree), false);
});

test('releases an empty target checkout after its owning process has exited', async (t) => {
  const f = await fixture(t);
  await f.changeTask();
  const { revision } = await f.candidate();
  const parent = join(f.storageDir, 'delivery-targets');
  const staleRoot = join(parent, 'target-2147483647-7ca8a44c-425d-4cbd-b7ec-34c3c9369017');
  await mkdir(parent);
  await git(f.worktree.repository, ['worktree', 'add', '--no-checkout', '--', staleRoot, 'delivery']);
  await f.delivery.integrate(f.approval(revision));
  assert.doesNotMatch(await git(f.worktree.repository, ['worktree', 'list', '--porcelain']), /delivery-targets/);
  assert.equal(await f.readRef(f.worktree.targetRef), revision.candidateOid);
});

test('freezing refuses a managed worktree that already has unmerged files', async (t) => {
  const f = await fixture(t);
  await f.changeTask();
  await git(f.worktree.path, ['add', 'project.txt']);
  await git(f.worktree.path, ['commit', '-m', 'Work in progress']);
  const pendingHead = await f.readRef(f.worktree.branchRef);
  const changedTarget = await f.advanceTarget('project.txt', 'conflicting target version\n');
  await assert.rejects(git(f.worktree.path, ['merge', '--no-edit', changedTarget]), { code: 1 });
  await assert.rejects(f.delivery.freezeWork({ worktree: f.worktree }), { code: 'WORKTREE_OPERATION' });
  assert.equal(await f.readRef(f.worktree.branchRef), pendingHead);
  assert.match(await git(f.worktree.path, ['status', '--porcelain']), /^UU project\.txt/m);
});

test('an external branch update to the candidate does not prove Hearth integration for cleanup', async (t) => {
  const f = await fixture(t);
  await f.changeTask();
  const { revision } = await f.candidate();
  await git(f.worktree.repository, ['update-ref', f.worktree.targetRef, revision.candidateOid, revision.targetOid]);
  assert.equal(await f.delivery.isMerged(f.worktree), false);
});

test('releases a temporary checkout when Git creates it before reporting failure', async (t) => {
  const f = await fixture(t);
  await f.changeTask();
  const interruptedGit = async (repository, args, options) => {
    const output = await git(repository, args, options);
    if (args[0] === 'worktree' && args[1] === 'add') throw new Error('Checkout result was interrupted');
    return output;
  };
  const delivery = createGitDelivery({ storageDir: f.storageDir, git: interruptedGit });
  await assert.rejects(delivery.freezeWork({ worktree: f.worktree }), /Checkout result was interrupted/);
  assert.doesNotMatch(await git(f.worktree.repository, ['worktree', 'list', '--porcelain']), /delivery-checkouts/);
  const originalHead = await f.readRef(f.worktree.branchRef);
  const recovered = await f.delivery.freezeWork({ worktree: f.worktree });
  assert.equal(recovered.revision.headOid, originalHead);
});
