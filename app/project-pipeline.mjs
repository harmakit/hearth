import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

const eligible = checks => checks.every(check => !check.required || check.status === 'PASS');

export function createProjectPipeline({ storageDir, worktrees, delivery, checks, evidence, git, lookupEvidence }) {
  async function scratch() {
    await mkdir(storageDir, { recursive: true, mode: 0o700 });
    return mkdtemp(join(storageDir, 'run-'));
  }

  async function boundWorktree(studio, task, worktreeId) {
    const tree = await worktrees.getWorktree(worktreeId);
    if (!tree || (tree.studioId && tree.studioId !== studio.id) || (tree.taskId && tree.taskId !== task.id) ||
        (tree.repository && tree.repository !== studio.root) || (tree.targetRef && tree.targetRef !== studio.projectGit?.targetRef)) {
      throw new Error('Рабочее дерево нужно заново сверить с задачей и проектом.');
    }
    return tree;
  }

  async function workScope({ studio, task }) {
    if (!studio.projectGit?.enabled) throw new Error('Разрешите работу с Git в настройках студии.');
    if (task.packageTargetRef) await worktrees.prepareTarget({repository:studio.root,targetRef:task.packageTargetRef,baseRef:task.packageFinalRef,create:true});
    const tree = await worktrees.ensureWorktree({
      studioId: studio.id, taskId: task.id, repository: studio.root, targetRef: studio.projectGit.targetRef,
    });
    const workspace = await scratch();
    return {
      worktreeId: tree.id,
      scope: { root: tree.path, scratch: workspace, access: 'worktree-write' },
      release: () => rm(workspace, { recursive: true, force: true }),
    };
  }

  async function checkRevision({ studio, task, attemptId, worktree, capture, phase, signal }) {
    let workspace;
    try {
      workspace = await scratch();
      const records = [];
      const published = [];
      const verify = () => delivery.verifyCheckout?.({ root: capture.root, revision: capture.revision, signal });
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
      worktreeId, revision: candidate.revision, checks: [...first.records, ...last.records],
      evidence: [...first.published, ...last.published], status: eligible(last.records) ? 'review' : 'checks-blocked',
    };
  }

  async function reviewScope({ studio, task, signal }) {
    const result = task.gitDelivery;
    const worktree = await boundWorktree(studio, task, result.worktreeId);
    const workspace = await scratch();
    let candidate;
    try {
      candidate = await delivery.getCandidate({ worktree, revision: result.revision, signal });
      const { revision } = result;
      const diff = await git?.(candidate.root, ['diff', '--no-ext-diff', '--stat', revision.targetOid, revision.candidateOid, '--'], { signal });
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
        context: { revision, diff: diff?.slice(0, 8_000), checks: checked, implementationSummary: task.summary?.slice(0, 2_000) },
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

  async function preparePackage({studio,task,members,signal}) {
    const stage = task.packageSourceRef;
    if (stage !== 'refs/heads/hearth-packages/'+task.sprintId) throw new Error('Неизвестная ветка пакета.');
    const head=(await git(studio.root,['rev-parse','--verify',stage+'^{commit}'],{signal})).trim();
    const versions=members.filter(m=>m.deliveryMode==='git').map(m=>m.gitDelivery?.targetOid);
    if (!versions.includes(head)) throw new Error('Версия пакета изменилась после ревью.');
    for(const oid of versions) {
      if(!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid)) throw new Error('Нет принятой версии задачи.');
      await git(studio.root,['merge-base','--is-ancestor',oid,head],{signal});
    }
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
  return { workScope, evaluate, reviewScope, merge, preparePackage };
}
