import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { sameDeliveryRevision } from '../core/delivery.mjs';
import { git as defaultGit, nativeGitPath } from './git-worktrees.mjs';

const oidPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const localBranch = /^refs\/heads\/[^\s]+$/u;
const checkoutName = /^(?:[a-f0-9]{64}-[a-f0-9-]{36}|[a-f0-9]{24}-[a-f0-9]{12})$/;
const targetCheckoutName = /^target-([1-9][0-9]{0,9})-[a-f0-9-]{36}$/;
const commitOptions = [
  '-c', 'user.name=Hearth Studio',
  '-c', 'user.email=hearth-studio@localhost',
  '-c', 'commit.gpgSign=false',
];

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function deliveryError(code, message, cause) {
  return Object.assign(new Error(message, { cause }), { code });
}

function processHasExited(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error.code === 'ESRCH';
  }
}

function worktreeKey(worktree) {
  if (!worktree || ![worktree.id, worktree.studioId, worktree.taskId].every((value) => typeof value === 'string' && value)
    || ![worktree.path, worktree.repository, worktree.gitCommonDir].every((value) => typeof value === 'string' && isAbsolute(value))
    || !localBranch.test(worktree.branchRef) || !localBranch.test(worktree.targetRef)
    || worktree.branchRef === worktree.targetRef || !oidPattern.test(worktree.baseOid)) {
    throw deliveryError('INVALID_WORKTREE', 'A registered managed task worktree is required');
  }
  return digest([
    worktree.studioId, worktree.taskId, worktree.id,
    worktree.branchRef, worktree.targetRef, worktree.baseOid,
  ]);
}

export function createGitDelivery({ storageDir, git = defaultGit }) {
  if (typeof storageDir !== 'string' || !isAbsolute(storageDir) || typeof git !== 'function') {
    throw new TypeError('Git delivery requires an absolute storage directory and Git adapter');
  }
  const workingDirectory = join(storageDir, 'delivery-checkouts');
  const targetDirectory = join(storageDir, 'delivery-targets');
  const run = git;

  async function gitPath(root, args, signal) {
    const path = (await run(root, ['rev-parse', '--path-format=absolute', ...args], { signal })).replace(/\n$/, '');
    return realpath(path);
  }

  async function refOid(repository, ref, signal) {
    const oid = (await run(repository, ['rev-parse', '--verify', '--quiet', '--end-of-options', ref], {
      signal, allowExitCodes: [1],
    })).trim();
    if (oid && !oidPattern.test(oid)) throw deliveryError('INVALID_REF', 'Git returned an invalid object ID');
    return oid || null;
  }

  async function listWorktrees(repository, signal) {
    const records = [];
    const fields = (await run(repository, ['worktree', 'list', '--porcelain', '-z'], { signal })).split('\0');
    for (const field of fields) {
      if (field.startsWith('worktree ')) records.push({ path: nativeGitPath(field.slice(9)) });
      else if (field.startsWith('branch ')) records.at(-1).branchRef = field.slice(7);
      else if (field === 'detached') records.at(-1).detached = true;
    }
    return records;
  }

  async function registeredTargets(worktree, signal) {
    return (await listWorktrees(worktree.repository, signal)).filter(({ branchRef }) => branchRef === worktree.targetRef);
  }

  async function targetStorage({ create = false } = {}) {
    if (create) await mkdir(targetDirectory, { recursive: true, mode: 0o700 });
    const parent = await realpath(targetDirectory).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (parent && parent !== join(await realpath(storageDir), basename(targetDirectory))) {
      throw deliveryError('INVALID_CHECKOUT', 'The target checkout storage has moved');
    }
    return parent;
  }

  async function releaseTarget(worktree, parent, root) {
    const record = (await listWorktrees(worktree.repository)).find(({ path }) => path === root);
    if (!record) return;
    if (dirname(root) !== parent || !targetCheckoutName.test(basename(root)) || record.branchRef !== worktree.targetRef) {
      throw deliveryError('INVALID_CHECKOUT', 'The target checkout does not match its Hearth registration');
    }
    const currentRoot = await realpath(root).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (currentRoot) {
      if (currentRoot !== root) throw deliveryError('INVALID_CHECKOUT', 'The target checkout path has moved');
      const entries = await readdir(root, { withFileTypes: true });
      if (entries.length !== 1 || entries[0].name !== '.git' || !entries[0].isFile()
        || await gitPath(root, ['--git-common-dir']) !== worktree.gitCommonDir) {
        throw deliveryError('INVALID_CHECKOUT', 'The target checkout contains data outside its Hearth registration');
      }
    }
    try {
      await run(worktree.repository, ['worktree', 'remove', '--force', '--', root]);
    } catch (error) {
      if ((await listWorktrees(worktree.repository)).some(({ path }) => path === root)) throw error;
    }
  }

  async function releaseAbandonedTargets(worktree, parent, signal) {
    for (const { path } of await registeredTargets(worktree, signal)) {
      const match = targetCheckoutName.exec(basename(path));
      if (dirname(path) === parent && match && processHasExited(Number(match[1]))) {
        await releaseTarget(worktree, parent, path);
      }
    }
  }

  async function withTargetCheckout(worktree, signal, operation) {
    const parent = await targetStorage({ create: true });
    await releaseAbandonedTargets(worktree, parent, signal);
    const root = join(parent, `target-${process.pid}-${randomUUID()}`);
    const target = worktree.targetRef.slice('refs/heads/'.length);
    const checkedOut = (cause) => deliveryError('TARGET_CHECKED_OUT', 'The delivery target is checked out in a Git worktree', cause);
    try {
      try {
        await run(worktree.repository, ['worktree', 'add', '--no-checkout', '--no-guess-remote', '--', root, target], { signal });
      } catch (error) {
        if ((await registeredTargets(worktree)).some(({ path }) => path !== root)) throw checkedOut(error);
        throw error;
      }
      const records = await registeredTargets(worktree, signal);
      if (records.length !== 1 || records[0].path !== root) throw checkedOut();
      return await operation();
    } finally {
      await releaseTarget(worktree, parent, root);
    }
  }

  async function validateWorktree(worktree, signal) {
    const key = worktreeKey(worktree);
    const [workspace, repository, commonDir, workCommonDir, repoCommonDir, topLevel, headRef, records] = await Promise.all([
      realpath(worktree.path), realpath(worktree.repository), realpath(worktree.gitCommonDir),
      gitPath(worktree.path, ['--git-common-dir'], signal),
      gitPath(worktree.repository, ['--git-common-dir'], signal),
      gitPath(worktree.path, ['--show-toplevel'], signal),
      run(worktree.path, ['symbolic-ref', '--quiet', 'HEAD'], { signal, allowExitCodes: [1] }),
      listWorktrees(worktree.repository, signal),
    ]);
    const registrations = records.filter((record) => record.branchRef === worktree.branchRef);
    if (worktree.status !== 'ready' || workspace !== worktree.path || workspace === repository
      || workspace !== topLevel || commonDir !== workCommonDir
      || commonDir !== repoCommonDir || headRef.trim() !== worktree.branchRef || registrations.length !== 1
      || await realpath(registrations[0].path) !== workspace) {
      throw deliveryError('INVALID_WORKTREE', 'The registered task branch is unavailable in its managed worktree');
    }
    return key;
  }

  async function ancestor(repository, earlier, later, signal) {
    try {
      await run(repository, ['merge-base', '--is-ancestor', earlier, later], { signal });
      return true;
    } catch (error) {
      if (error.code === 1) return false;
      throw error;
    }
  }

  async function readHeads(worktree, signal) {
    const [headOid, targetOid, targetAlias] = await Promise.all([
      refOid(worktree.repository, worktree.branchRef, signal),
      refOid(worktree.repository, worktree.targetRef, signal),
      run(worktree.repository, ['symbolic-ref', '--quiet', worktree.targetRef], { signal, allowExitCodes: [1] }),
    ]);
    if (!headOid || !targetOid || targetAlias) throw deliveryError('INVALID_REF', 'A registered direct Git branch is unavailable');
    return { headOid, targetOid };
  }

  async function commitTree(repository, treeOid, parents, message, signal) {
    const args = [...commitOptions, 'commit-tree', treeOid, ...parents.flatMap((parent) => ['-p', parent])];
    return (await run(repository, args, { input: `${message}\n`, signal })).trim();
  }

  async function makeRevision(worktree, key, { headOid, targetOid }, candidateOid, signal) {
    const revision = { baseOid: worktree.baseOid, headOid, targetOid };
    if (candidateOid) revision.candidateOid = candidateOid;
    const commitOid = candidateOid || headOid;
    const treeOid = (await run(worktree.repository, ['rev-parse', '--verify', `${commitOid}^{tree}`], { signal })).trim();
    return { ...revision, digest: digest([key, revision.baseOid, headOid, targetOid, candidateOid ?? null, treeOid]) };
  }

  function candidateRef(key, workRevision) {
    return `refs/hearth/delivery-candidates/${key}/${workRevision.digest}`;
  }

  async function changedPaths(worktree, revision, signal) {
    const from = revision.candidateOid ? revision.targetOid : revision.baseOid;
    const to = revision.candidateOid ?? revision.headOid;
    const changes = await run(worktree.repository, [
      'diff', '--name-only', '--no-renames', '--no-ext-diff', '--no-textconv', '-z', from, to, '--',
    ], { signal });
    return changes.split('\0').filter(Boolean);
  }

  async function openRevision(worktree, key, revision, signal) {
    const paths = await changedPaths(worktree, revision, signal);
    await mkdir(workingDirectory, { recursive: true, mode: 0o700 });
    const parent = await realpath(workingDirectory);
    // Git for Windows also embeds this basename under the repository's .git/worktrees.
    const id = randomUUID();
    const name = process.platform==='win32' ? `${key.slice(0,24)}-${id.replaceAll('-','').slice(0,12)}` : `${key}-${id}`;
    const root = join(parent, name);
    const commitOid = revision.candidateOid ?? revision.headOid;
    try {
      await run(worktree.repository, ['worktree', 'add', '--detach', '--', root, commitOid], { signal });
    } catch (error) {
      try {
        await releaseCandidate({ worktree, root });
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'The interrupted delivery checkout could not be released');
      }
      throw error;
    }
    return { revision, root, changedPaths: paths };
  }

  async function releaseCandidate({ worktree, root }) {
    const key = worktreeKey(worktree);
    if (typeof root !== 'string' || !isAbsolute(root)
      || !new RegExp(`^(?:${key}-[a-f0-9-]{36}|${key.slice(0,24)}-[a-f0-9]{12})$`).test(basename(root))) {
      throw deliveryError('INVALID_CHECKOUT', 'Only a disposable delivery checkout can be released');
    }
    const parent = await realpath(workingDirectory).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!parent) return;
    if (dirname(root) !== parent) throw deliveryError('INVALID_CHECKOUT', 'The delivery checkout is outside its storage directory');
    const registration = async () => (await listWorktrees(worktree.repository)).find(({ path }) => path === root);
    const record = await registration();
    if (!record) return;
    if (!record.detached) throw deliveryError('INVALID_CHECKOUT', 'The delivery checkout is no longer detached');
    try {
      await run(worktree.repository, ['worktree', 'remove', '--force', '--', root]);
    } catch (error) {
      if (await registration()) throw error;
    }
  }

  async function verifyCheckout({ root, revision, signal }) {
    if (typeof root !== 'string' || !checkoutName.test(basename(root))
      || dirname(root) !== await realpath(workingDirectory).catch(() => null)
      || await realpath(root).catch(() => null) !== root
      || await gitPath(root, ['--show-toplevel'], signal) !== root) {
      throw deliveryError('CHECKOUT_CHANGED', 'The delivery checkout is unavailable');
    }
    const [head, branch, dirty] = await Promise.all([
      refOid(root, 'HEAD', signal),
      run(root, ['symbolic-ref', '--quiet', 'HEAD'], { signal, allowExitCodes: [1] }),
      run(root, ['status', '--porcelain=v1', '-z', '--untracked-files=no', '--ignore-submodules=none'], { signal }),
    ]);
    if (!head || head !== (revision?.candidateOid ?? revision?.headOid) || branch || dirty) {
      throw deliveryError('CHECKOUT_CHANGED', 'A check modified the tracked delivery checkout or its HEAD');
    }
  }

  async function assertNoGitOperation(worktree, signal) {
    const gitDir = await gitPath(worktree.path, ['--git-dir'], signal);
    const markers = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer'];
    const inProgress = await Promise.all(markers.map((marker) => lstat(join(gitDir, marker)).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    })));
    if (inProgress.some(Boolean) || await run(worktree.path, ['ls-files', '--unmerged', '-z'], { signal })) {
      throw deliveryError('WORKTREE_OPERATION', 'Resolve the unfinished Git operation in the managed task worktree');
    }
  }

  async function freezeWork({ worktree, signal }) {
    const key = await validateWorktree(worktree, signal);
    await assertNoGitOperation(worktree, signal);
    const { headOid, targetOid } = await readHeads(worktree, signal);
    if (!await ancestor(worktree.repository, worktree.baseOid, headOid, signal)) {
      throw deliveryError('STALE_REVISION', 'The task branch no longer contains its registered base');
    }
    await run(worktree.path, ['add', '-A', '--', '.'], { signal });
    const treeOid = (await run(worktree.path, ['write-tree'], { signal })).trim();
    const previousTree = (await run(worktree.repository, ['rev-parse', '--verify', `${headOid}^{tree}`], { signal })).trim();
    let frozenHead = headOid;
    if (treeOid !== previousTree) {
      frozenHead = await commitTree(worktree.repository, treeOid, [headOid], 'Freeze Hearth task result', signal);
      await run(worktree.repository, ['update-ref', '--no-deref', worktree.branchRef, frozenHead, headOid], { signal });
    }
    const revision = await makeRevision(worktree, key, { headOid: frozenHead, targetOid }, null, signal);
    return openRevision(worktree, key, revision, signal);
  }

  async function currentWorkRevision(worktree, key, revision, signal) {
    const { headOid, targetOid } = await readHeads(worktree, signal);
    if (targetOid !== revision?.targetOid) throw deliveryError('TARGET_CHANGED', 'The delivery target has changed');
    if (headOid !== revision?.headOid || revision.baseOid !== worktree.baseOid) {
      throw deliveryError('STALE_REVISION', 'The managed task branch has changed');
    }
    await assertNoGitOperation(worktree, signal);
    const dirty = await run(worktree.path, [
      'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none',
    ], { signal });
    if (dirty) throw deliveryError('STALE_REVISION', 'The managed task worktree contains new changes');
    return makeRevision(worktree, key, { headOid, targetOid }, null, signal);
  }

  async function buildCandidate(worktree, key, workRevision, signal) {
    const repository = worktree.repository;
    const { headOid, targetOid } = workRevision;
    const ref = candidateRef(key, workRevision);
    const saved = await refOid(repository, ref, signal);
    if (saved) return saved;

    let candidateOid = headOid;
    if (!await ancestor(repository, targetOid, headOid, signal)) {
      let mergedTree;
      try {
        mergedTree = (await run(repository, ['merge-tree', '--write-tree', '--no-messages', targetOid, headOid], { signal })).trim();
      } catch (error) {
        if (error.code === 1) throw deliveryError('MERGE_CONFLICT', 'Git could not merge the task into the delivery target', error);
        throw error;
      }
      candidateOid = await commitTree(repository, mergedTree, [targetOid, headOid], 'Merge Hearth task result', signal);
    }
    try {
      await run(repository, ['update-ref', '--no-deref', ref, candidateOid, '0'.repeat(candidateOid.length)], { signal });
      return candidateOid;
    } catch (error) {
      const competing = await refOid(repository, ref, signal);
      if (competing) return competing;
      throw error;
    }
  }

  async function prepareCandidate({ worktree, revision, signal }) {
    const key = await validateWorktree(worktree, signal);
    const current = await currentWorkRevision(worktree, key, revision, signal);
    if (!sameDeliveryRevision(current, revision)) throw deliveryError('STALE_REVISION', 'The work revision digest has changed');
    const candidateOid = await buildCandidate(worktree, key, current, signal);
    const candidate = await makeRevision(worktree, key, current, candidateOid, signal);
    return openRevision(worktree, key, candidate, signal);
  }

  async function validateCandidate(worktree, key, revision, signal) {
    const current = await currentWorkRevision(worktree, key, revision, signal);
    const storedCandidate = await refOid(worktree.repository, candidateRef(key, current), signal);
    if (!storedCandidate || storedCandidate !== revision.candidateOid) {
      throw deliveryError('STALE_REVISION', 'The revision does not identify a stored merge candidate');
    }
    const candidate = await makeRevision(worktree, key, current, storedCandidate, signal);
    if (!sameDeliveryRevision(candidate, revision)) throw deliveryError('STALE_REVISION', 'The candidate digest has changed');
    return candidateRef(key, current);
  }

  async function getCandidate({ worktree, revision, signal }) {
    const key = await validateWorktree(worktree, signal);
    await validateCandidate(worktree, key, revision, signal);
    return openRevision(worktree, key, revision, signal);
  }

  async function getIntegratedCandidate({ worktree, revision, signal }) {
    const key = await validateWorktree(worktree, signal);
    if (![revision?.headOid, revision?.targetOid, revision?.candidateOid].every(oid => oidPattern.test(oid ?? ''))) {
      throw deliveryError('STALE_REVISION', 'The delivered candidate has no complete revision');
    }
    const workRevision = await makeRevision(worktree, key, revision, null, signal);
    const saved = await refOid(worktree.repository, candidateRef(key, workRevision), signal);
    const checked = await makeRevision(worktree, key, revision, revision.candidateOid, signal);
    if (saved !== revision.candidateOid || !sameDeliveryRevision(checked, revision)) {
      throw deliveryError('STALE_REVISION', 'The delivered candidate no longer matches its saved revision');
    }
    if (await refOid(worktree.repository, worktree.targetRef, signal) !== revision.candidateOid) {
      throw deliveryError('TARGET_CHANGED', 'The package target has changed since its reviewed deliveries');
    }
    return openRevision(worktree, key, revision, signal);
  }

  function operationDirectory(key) {
    return `refs/hearth/delivery-operations/${key}`;
  }

  async function readOperation(repository, object, signal) {
    return JSON.parse(await run(repository, ['cat-file', 'blob', object], { signal }));
  }

  async function integrate({ worktree, revision, receipt, operationId, signal }) {
    const key = worktreeKey(worktree);
    if (typeof operationId !== 'string' || !operationId) throw deliveryError('INVALID_OPERATION', 'An integration operation ID is required');
    if (!receipt || receipt.taskId !== worktree.taskId || receipt.result !== 'PASS'
      || !receipt.id || !receipt.reviewerId || !Array.isArray(receipt.checkIds)
      || !receipt.checkIds.every((id) => typeof id === 'string' && id)
      || !oidPattern.test(revision?.candidateOid) || !sameDeliveryRevision(receipt.revision, revision)) {
      throw deliveryError('INVALID_RECEIPT', 'An approved review receipt for this task and candidate is required');
    }
    const repository = worktree.repository;
    const operationRef = `${operationDirectory(key)}/${digest(operationId)}`;
    const receiptDigest = digest([receipt.id, receipt.reviewerId, receipt.checkIds, receipt.result]);
    const operation = {
      revisionDigest: revision.digest, headOid: revision.headOid, candidateOid: revision.candidateOid, receiptDigest,
    };
    const result = { status: 'merged', targetOid: revision.candidateOid };
    const recoverOperation = async () => {
      const saved = await refOid(repository, operationRef, signal);
      if (!saved) return false;
      const recorded = await readOperation(repository, saved, signal);
      if (digest(recorded) !== digest(operation)) {
        throw deliveryError('OPERATION_MISMATCH', 'This integration operation ID has a different receipt or revision');
      }
      return true;
    };
    if (await recoverOperation()) {
      const targetRoot = await targetStorage();
      if (targetRoot) await releaseAbandonedTargets(worktree, targetRoot, signal);
      return result;
    }

    await validateWorktree(worktree, signal);
    const pin = await validateCandidate(worktree, key, revision, signal);
    const markerOid = (await run(repository, ['hash-object', '-w', '--stdin'], { input: JSON.stringify(operation), signal })).trim();
    const transaction = [
      'start',
      'option no-deref',
      `verify ${worktree.branchRef} ${revision.headOid}`,
      'option no-deref',
      `verify ${pin} ${revision.candidateOid}`,
      'option no-deref',
      `update ${worktree.targetRef} ${revision.candidateOid} ${revision.targetOid}`,
      `create ${operationRef} ${markerOid}`,
      'prepare',
      'commit',
      '',
    ].join('\n');
    try {
      await withTargetCheckout(worktree, signal, () =>
        run(repository, ['update-ref', '-m', 'Hearth Studio integration', '--stdin'], { signal, input: transaction }));
    } catch (error) {
      if (typeof error.code !== 'number') throw error;
      if (await recoverOperation()) return result;
      const current = await readHeads(worktree, signal);
      if (current.targetOid !== revision.targetOid) throw deliveryError('TARGET_CHANGED', 'The delivery target has changed', error);
      if (current.headOid !== revision.headOid) throw deliveryError('STALE_REVISION', 'The managed task branch has changed', error);
      throw error;
    }
    return result;
  }

  async function isMerged(worktree) {
    const key = worktreeKey(worktree);
    const { headOid, targetOid } = await readHeads(worktree);
    const objects = (await run(worktree.repository, ['for-each-ref', '--format=%(objectname)', operationDirectory(key)])).trim().split('\n').filter(Boolean);
    for (const object of objects) {
      const operation = await readOperation(worktree.repository, object);
      if (headOid === operation.headOid && oidPattern.test(operation.candidateOid)
        && await ancestor(worktree.repository, operation.candidateOid, targetOid)) return true;
    }
    return false;
  }

  return { freezeWork, prepareCandidate, getCandidate, getIntegratedCandidate, releaseCandidate, verifyCheckout, integrate, isMerged };
}

export function createProjectDelivery(legacy,git=defaultGit){
  const projects=new Map();
  const forWorktree=worktree=>{
    if(worktree?.layout!=='project')return legacy;
    if(!projects.has(worktree.repository)){
      projects.set(worktree.repository,createGitDelivery({
        storageDir:join(worktree.repository,'.hearth','worktrees','.delivery'),git,
      }));
    }
    return projects.get(worktree.repository);
  };
  const methods=Object.fromEntries(['freezeWork','prepareCandidate','getCandidate','getIntegratedCandidate','releaseCandidate','verifyCheckout','integrate']
    .map(method=>[method,request=>forWorktree(request.worktree)[method](request)]));
  return {...methods,isMerged:worktree=>forWorktree(worktree).isMerged(worktree)};
}
