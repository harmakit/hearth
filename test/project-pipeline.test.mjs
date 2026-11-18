import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectPipeline } from '../app/project-pipeline.mjs';

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
