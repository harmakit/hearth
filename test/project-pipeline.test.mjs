import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectPipeline } from '../app/project-pipeline.mjs';
import { git } from '../app/git-worktrees.mjs';

const worktree = { id: 'tree', path: '/work/tree' };
const revision = { headOid: 'work', targetOid: 'target', candidateOid: 'candidate', digest: 'content' };
const studio = { id: 'studio', root: '/repo', projectGit: { enabled: true, targetRef: 'refs/heads/delivery', profile: { id: 'profile', checks: [] } } };
const task = { id: 'task', studioId: 'studio' };

function fixture(status = 'PASS') {
  const calls = [];
  const pipeline = createProjectPipeline({
    storageDir: new URL('../.tmp/pipeline/', import.meta.url).pathname,
    worktrees: { ensureWorktree: async () => worktree, getWorktree: async () => worktree },
    delivery: {
      freezeWork: async () => ({ root: '/work/frozen', revision: { headOid: 'work' }, changedPaths: ['file'] }),
      prepareCandidate: async () => ({ root: '/work/candidate', revision, changedPaths: ['file'] }),
      releaseCandidate: async ({ root }) => calls.push(['release', root]),
      getCandidate: async () => ({ root: '/work/review', revision }),
      integrate: async value => { calls.push(['integrate', value.receipt.result]); return { status: 'merged' }; },
    },
    checks: { runChecks: async ({ root }) => [{ checkId: root, status, required: true, evidencePaths: ['report.png'] }] },
    evidence: { recordEvidence: async ({ sourcePath }) => { calls.push(['capture', sourcePath]); return { id: sourcePath }; } },
  });
  return { pipeline, calls };
}

test('pipeline captures checks before releasing exact candidate and reopens it for review', async () => {
  const { pipeline, calls } = fixture();
  const signal = new AbortController().signal;
  const evaluated = await pipeline.evaluate({ studio, task, attemptId: 'a', worktreeId: 'tree', signal });
  assert.deepEqual(evaluated.revision, revision);
  assert.equal(evaluated.checks.length, 2);
  assert.deepEqual(calls, [
    ['capture', 'report.png'], ['release', '/work/frozen'],
    ['capture', 'report.png'], ['release', '/work/candidate'],
  ]);
  const review = await pipeline.reviewScope({ studio, task: { ...task, gitDelivery: evaluated }, attemptId: 'b', signal });
  assert.equal(review.scope.root, '/work/review');
  assert.equal(review.scope.access, 'read');
  await review.release();
  assert.deepEqual(calls.at(-1), ['release', '/work/review']);
});

test('unassessed required verification cannot integrate the change', async () => {
  const { pipeline, calls } = fixture('NOT ASSESSED');
  const evaluated = await pipeline.evaluate({ studio, task, attemptId: 'a', worktreeId: 'tree' });
  assert.equal(evaluated.status, 'checks-blocked');
  assert.equal(evaluated.revision.candidateOid, undefined);
  assert.deepEqual(calls, [['capture', 'report.png'], ['release', '/work/frozen']]);
  await assert.rejects(pipeline.merge({ studio, task: { ...task, gitDelivery: evaluated } }), /приёмк|ревью|кандидат/i);
});

test('review gets the frozen text and image paths without relying on model file tools', async t => {
  const root=await mkdtemp(join(await realpath(tmpdir()),'hearth-review-files-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await git(root,['init','--initial-branch=main']);
  await writeFile(join(root,'dossier.md'),'# Reviewed person\n');
  await writeFile(join(root,'portrait.png'),Buffer.from('89504e470d0a1a0a','hex'));
  await writeFile(join(root,'accepted-background.md'),'The accepted dossier is available in the candidate checkout.');
  await writeFile(join(root,'entry.js'),'// Part of the submitted application\n');
  await writeFile(join(root,'.internal.txt'),'Project metadata');
  await git(root,['add','--','dossier.md','portrait.png','accepted-background.md','entry.js','.internal.txt']);
  await symlink('dossier.md',join(root,'alias.md'));
  const pipeline=createProjectPipeline({
    git, storageDir:join(root,'scratch'),worktrees:{getWorktree:async()=>worktree,ensureWorktree:async()=>({...worktree,path:root})},
    delivery:{getCandidate:async()=>({root,revision,changedPaths:['dossier.md','alias.md','portrait.png']}),releaseCandidate:async()=>{}},
  });
  const head=(await git(root,['write-tree'])).trim();
  const review=await pipeline.reviewScope({studio,task:{...task,gitDelivery:{worktreeId:'tree',revision:{targetOid:head,candidateOid:head}}},
    referencePaths:['accepted-background.md','dossier.md','alias.md','missing.md']});
  t.after(()=>review.release());
  assert.deepEqual(review.context.files,[{path:'dossier.md',text:'# Reviewed person\n',truncated:false},{path:'portrait.png',image:true}]);
  assert.deepEqual(review.context.referenceFiles,[{path:'accepted-background.md',text:'The accepted dossier is available in the candidate checkout.',truncated:false}]);
  assert.deepEqual(review.imagePaths,[join(root,'portrait.png')]);
  const tracked={paths:['accepted-background.md','dossier.md','entry.js','portrait.png'],truncated:false,hiddenPathsExcluded:true};
  assert.deepEqual(review.context.trackedPaths,tracked);
  const editable=await pipeline.workScope({studio,task});
  t.after(()=>editable.release());
  assert.deepEqual(editable.trackedPaths,tracked);
});

test('prior delivery comparison checks actual Git files and keeps more than three referenced portraits',async t=>{
  const root=await mkdtemp(join(await realpath(tmpdir()),'hearth-prior-delivery-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await git(root,['init','--initial-branch=main']);
  const paths=['one.png','two.png','three.png','four.png','five.png'];
  await Promise.all(paths.map(path=>writeFile(join(root,path),Buffer.from('89504e470d0a1a0a','hex'))));
  await writeFile(join(root,'old.md'),'Earlier result');
  await git(root,['add','--','old.md',...paths]);
  await git(root,['-c','user.name=QA','-c','user.email=qa@hearth.invalid','commit','-m','Earlier result']);
  const baseline=(await git(root,['rev-parse','HEAD'])).trim();
  const pipeline=createProjectPipeline({git});
  assert.equal((await pipeline.workspaceContents(root,paths,{images:true})).imagePaths.length,5);
  const compare=()=>pipeline.priorDeliveryStatus(root,{revision:baseline,paths:['old.md',...paths]});
  assert.equal((await compare()).status,'unchanged');
  await writeFile(join(root,'old.md'),'Changed');
  assert.deepEqual((await compare()).changedPaths,['old.md']);
});
