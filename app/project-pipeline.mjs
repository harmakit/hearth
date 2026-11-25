import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { isReportFilePath } from '../renderer/report-link.mjs';

const eligible = checks => checks.every(check => !check.required || check.status === 'PASS');
const imagePath = /\.(?:png|jpe?g|webp)$/iu;
const otherBinary = /\.(?:gif|pdf)$/iu;

async function workspaceContents(root, paths, { images = false, signal, textBudget = 38_000 } = {}) {
  const files = [], imagePaths = [];
  let budget = textBudget, imageBudget = 24 * 1024 * 1024;
  for (const path of [...new Set(paths)].filter(isReportFilePath).slice(0, 40)) {
    signal?.throwIfAborted();
    const absolute = join(root, path);
    const info = await lstat(absolute).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (!info?.isFile() || await realpath(absolute) !== absolute) continue;
    if (imagePath.test(path)) {
      const attached=images && imagePaths.length<8 && info.size<=12*1024*1024 && info.size<=imageBudget;
      files.push({path,image:attached});
      if (attached) { imagePaths.push(absolute); imageBudget-=info.size; }
      continue;
    }
    if (otherBinary.test(path)) { files.push({path,binary:true}); continue; }
    const file = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile()) continue;
      const bytes = Buffer.alloc(Math.min(stat.size, budget, 16_000));
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      budget -= bytesRead;
      files.push({ path, text: bytes.toString('utf8', 0, bytesRead), truncated: bytesRead < stat.size });
    } finally { await file.close(); }
  }
  return { files, imagePaths };
}

export function createProjectPipeline({ storageDir, worktrees, delivery, checks, evidence, git, lookupEvidence }) {
  async function trackedProjectPaths(root, signal) {
    if (!git) return;
    try {
      const result = await git(root, ['ls-files', '--cached', '-z'], { signal, maxBuffer: 512 * 1024 });
      const paths = result.split('\0').filter(path => path && path.split('/').every(part => !part.startsWith('.')));
      return { paths: paths.slice(0, 200), truncated: paths.length > 200, hiddenPathsExcluded: true };
    } catch {
      signal?.throwIfAborted();
    }
  }

  async function scratch() {
    await mkdir(storageDir, { recursive: true, mode: 0o700 });
    return mkdtemp(join(storageDir, 'run-'));
  }

  async function boundWorktree(studio, task, worktreeId) {
    const tree = await worktrees.getWorktree(worktreeId,true,studio.id);
    if (!tree || (tree.studioId && tree.studioId !== studio.id) || (tree.taskId && tree.taskId !== task.id) ||
        (tree.repository && tree.repository !== studio.root) || (tree.targetRef && tree.targetRef !== studio.projectGit?.targetRef)) {
      throw new Error('Рабочее дерево нужно заново сверить с задачей и проектом.');
    }
    return tree;
  }

  async function workScope({ studio, task, signal }) {
    if (!studio.projectGit?.enabled) throw new Error('Разрешите работу с Git в настройках студии.');
    if (task.packageTargetRef) await worktrees.prepareTarget({repository:studio.root,targetRef:task.packageTargetRef,baseRef:task.packageFinalRef,create:true});
    const tree = await worktrees.ensureWorktree({
      studioId: studio.id, taskId: task.id, repository: studio.root, targetRef: studio.projectGit.targetRef,
    });
    const trackedPaths = await trackedProjectPaths(tree.path, signal);
    const workspace = await scratch();
    return {
      worktreeId: tree.id,
      scope: { root: tree.path, scratch: workspace, access: 'worktree-write' },
      trackedPaths,
      release: () => rm(workspace, { recursive: true, force: true }),
    };
  }

  async function checkRevision({ studio, task, attemptId, worktree, capture, phase, signal }) {
    let workspace;
    try {
      workspace = await scratch();
      const records = [];
      const published = [];
      const verify = () => delivery.verifyCheckout?.({ worktree,root: capture.root, revision: capture.revision, signal });
      const readResult = async check => {
        signal?.throwIfAborted();
        const evidenceIds = [];
        for (const sourcePath of check.evidencePaths ?? []) {
          const record = await evidence.recordEvidence({
            studioId: studio.id, taskId: task.id, attemptId, revision: capture.revision,
            root: capture.root, sourcePath, kind: 'qa',
          });
          published.push(record);
          evidenceIds.push(record.id);
        }
        if (check.logRef) {
          const record = await evidence.recordEvidence({
            studioId: studio.id, taskId: task.id, attemptId, revision: capture.revision,
            root: dirname(check.logRef), sourcePath: basename(check.logRef), kind: 'qa-log',
          });
          published.push(record);
          evidenceIds.push(record.id);
        }
        const { evidencePaths, logRef, ...visible } = check;
        records.push({ ...visible, phase, evidenceIds });
      };
      const results = await checks.runChecks({
        root: capture.root, scratch: workspace, revision: capture.revision, profile: studio.projectGit.profile,
        changedPaths: capture.changedPaths, signal, network: studio.projectGit.profile.network === true, verify, onCheck: readResult,
      });
      await verify();
      if (!records.length && results.length) {
        for (const check of results) await readResult(check);
      }
      return { records, published };
    } finally {
      if (workspace) await rm(workspace, { recursive: true, force: true });
      await delivery.releaseCandidate({ worktree, root: capture.root });
    }
  }

  async function evaluate({ studio, task, attemptId, worktreeId, signal }) {
    const worktree = await boundWorktree(studio, task, worktreeId);
    const work = await delivery.freezeWork({ worktree, signal });
    const first = await checkRevision({ studio, task, attemptId, worktree, capture: work, phase: 'work', signal });
    if (!eligible(first.records)) {
      return { worktreeId, revision: work.revision, checks: first.records, evidence: first.published, status: 'checks-blocked' };
    }
    const candidate = await delivery.prepareCandidate({ worktree, revision: work.revision, signal });
    const artifactPaths=[];
    try {
      for (const path of (candidate.changedPaths ?? []).filter(isReportFilePath).slice(0,100)) {
        const file=await lstat(join(candidate.root,path)).catch(error=>{if (error.code!=='ENOENT') throw error;});
        if (file?.isFile()) artifactPaths.push(path);
      }
    } catch (error) {
      await delivery.releaseCandidate({ worktree, root: candidate.root });
      throw error;
    }
    const last = await checkRevision({ studio, task, attemptId, worktree, capture: candidate, phase: 'candidate', signal });
    if (git) {
      const folder=await scratch();
      try {
        const refs=[candidate.revision.targetOid,candidate.revision.candidateOid];
        let filename='reviewed-changes.diff.txt';
        let contents;
        try {
          contents=await git(studio.root,['diff','--no-ext-diff','--no-textconv',...refs,'--'],{signal,maxBuffer:4*1024*1024});
        } catch (error) {
          if(error.code!=='ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw error;
          filename='reviewed-changes.stat.txt';
          contents=await git(studio.root,['diff','--stat','--no-ext-diff','--no-textconv',...refs,'--'],{signal});
        }
        await writeFile(join(folder,filename),contents);
        last.published.push(await evidence.recordEvidence({studioId:studio.id,taskId:task.id,attemptId,revision:candidate.revision,
          kind:'review-diff',root:folder,sourcePath:filename}));
      } finally { await rm(folder,{recursive:true,force:true}); }
    }
    return {
      worktreeId, revision: candidate.revision, artifactPaths, checks: [...first.records, ...last.records],
      evidence: [...first.published, ...last.published], status: eligible(last.records) ? 'review' : 'checks-blocked',
    };
  }

  async function reviewScope({ studio, task, referencePaths = [], signal, delivered = false }) {
    const result = task.gitDelivery;
    const worktree = await boundWorktree(studio, task, result.worktreeId);
    const workspace = await scratch();
    let candidate;
    try {
      candidate = await delivery[delivered ? 'getIntegratedCandidate' : 'getCandidate']({ worktree, revision: result.revision, signal });
      const { revision } = result;
      const diff = await git?.(candidate.root, ['diff', '--no-ext-diff', '--stat', revision.targetOid, revision.candidateOid, '--'], { signal });
      const changedPaths = new Set(candidate.changedPaths ?? result.artifactPaths ?? []);
      const textBudget = delivered || task.packageMembers || referencePaths.length>12 ? 96_000 : 38_000;
      const { files: captured, imagePaths } = await workspaceContents(candidate.root, [...changedPaths, ...referencePaths], { images: true, signal, textBudget });
      const trackedPaths = await trackedProjectPaths(candidate.root, signal);
      const files = captured.filter(file => changedPaths.has(file.path));
      const referenceFiles = captured.filter(file => !changedPaths.has(file.path));
      const checked = [];
      for (const { phase, checkId, status, required, evidenceIds } of result.checks ?? []) {
        const output = [];
        for (const id of evidenceIds ?? []) {
          const record = lookupEvidence?.({ studioId: studio.id, evidenceId: id });
          if (record?.kind === 'qa-log') output.push((await evidence.readEvidence(record)).toString('utf8').slice(0, 1_200));
        }
        checked.push({ phase, checkId, status, required, output });
      }
      return {
        scope: { root: candidate.root, scratch: workspace, access: 'read' },
        context: { revision, diff: diff?.slice(0, 8_000), checks: checked, trackedPaths, files, referenceFiles, implementationSummary: task.summary?.slice(0, 2_000) },
        imagePaths,
        async release() {
          try { await delivery.releaseCandidate({ worktree, root: candidate.root }); }
          finally { await rm(workspace, { recursive: true, force: true }); }
        },
      };
    } catch (error) {
      if (candidate) await delivery.releaseCandidate({ worktree, root: candidate.root });
      await rm(workspace, { recursive: true, force: true });
      throw error;
    }
  }

  async function merge({ studio, task, operationId, signal }) {
    const result = task.gitDelivery;
    if (result?.receipt?.result !== 'PASS' || !result.revision?.candidateOid || !eligible(result.checks ?? [])) {
      throw new Error('Для слияния нужны проверки и принятое ревью кандидата.');
    }
    const worktree = await boundWorktree(studio, task, result.worktreeId);
    return delivery.integrate({ worktree, revision: result.revision, receipt: result.receipt, operationId, signal });
  }

  async function packageHead(studio, ref, members, signal) {
    const head = (await git(studio.root, ['rev-parse', '--verify', ref + '^{commit}'], { signal })).trim();
    const versions = members.filter(member => member.deliveryMode === 'git').map(member => member.gitDelivery?.targetOid);
    if (!versions.includes(head)) throw new Error('Версия пакета изменилась после ревью.');
    for (const oid of versions) {
      if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid)) throw new Error('Нет принятой версии задачи.');
      await git(studio.root, ['merge-base', '--is-ancestor', oid, head], { signal });
    }
    return head;
  }

  async function packageReviewScope({ studio, members, referencePaths, signal }) {
    const head = await packageHead(studio, studio.projectGit.targetRef, members, signal);
    const newest = members.findLast(member => member.gitDelivery?.status === 'merged' && member.gitDelivery.targetOid === head &&
      member.gitDelivery.revision?.candidateOid === head);
    if (!newest) throw new Error('Не найдена проверенная Git-версия выпуска.');
    const scoped = await reviewScope({ studio, task: newest, referencePaths, signal, delivered: true });
    try {
      const packagePaths = [];
      for (const path of [...new Set(referencePaths)].filter(isReportFilePath)) {
        signal?.throwIfAborted();
        const absolute = join(scoped.scope.root, path);
        const info = await lstat(absolute).catch(error => { if (error.code !== 'ENOENT') throw error; });
        if (info?.isFile() && await realpath(absolute) === absolute) packagePaths.push(path);
      }
      return { ...scoped, packagePaths };
    } catch (error) {
      await scoped.release();
      throw error;
    }
  }

  async function priorDeliveryStatus(root, {revision,paths}, signal) {
    if(!git || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision??'')) return undefined;
    const checkedPaths=[...new Set(paths)].filter(isReportFilePath);
    if(!checkedPaths.length) return undefined;
    try {
      const listed=await git(root,['--literal-pathspecs','ls-tree','-r','--name-only','-z',revision,'--',...checkedPaths],{signal});
      const baselinePaths=new Set(listed.split('\0').filter(Boolean));
      const missing=checkedPaths.filter(path=>!baselinePaths.has(path));
      const diff=await git(root,['--literal-pathspecs','diff','--name-only','--no-renames','--no-ext-diff','--no-textconv','-z',revision,'--',...checkedPaths],{signal});
      const changedPaths=diff.split('\0').filter(Boolean);
      return {revision,checkedPaths,changedPaths,missingBaselinePaths:missing,
        status:missing.length?'incomplete':changedPaths.length?'changed':'unchanged'};
    } catch(error) {
      signal?.throwIfAborted();
      return {revision,status:'unavailable',message:String(error.message).slice(0,500)};
    }
  }

  async function preparePackage({studio,task,members,signal}) {
    const stage = task.packageSourceRef;
    if (stage !== 'refs/heads/hearth-packages/'+task.sprintId) throw new Error('Неизвестная ветка пакета.');
    const head = await packageHead(studio, stage, members, signal);
    const scoped=await workScope({studio,task});
    try {
      if ((await git(scoped.scope.root,['status','--porcelain'],{signal})).trim()) throw new Error('Рабочая копия пакета содержит несохранённые правки.');
      const base=(await git(scoped.scope.root,['rev-parse','HEAD'],{signal})).trim();
      const common=(await git(scoped.scope.root,['merge-base',base,head],{signal})).trim();
      let candidate=head;
      if (common===head) candidate=base;
      else if (common!==base) {
        const tree=(await git(scoped.scope.root,['merge-tree','--write-tree','--no-messages',base,head],{signal})).trim();
        candidate=(await git(scoped.scope.root,['-c','user.name=Hearth Studio','-c','user.email=studio@hearth.invalid',
          'commit-tree',tree,'-p',base,'-p',head,'-m','Prepare reviewed sprint package'],{signal})).trim();
      }
      await git(scoped.scope.root,['merge','--ff-only',candidate],{signal});
      return {worktreeId:scoped.worktreeId};
    } finally {await scoped.release();}
  }
  return { workScope, evaluate, reviewScope, packageReviewScope, merge, preparePackage, workspaceContents, priorDeliveryStatus };
}
