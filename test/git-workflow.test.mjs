import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createStudioService } from '../core/service.mjs';
import { trainingReply } from './fixtures/training.mjs';

const plan = {
  title: 'Изменить проект', goal: 'Новый файл',
  epic: { title: 'Эпик', description: 'Проект' },
  story: { title: 'История', acceptance: 'Файл проверен' },
  agents: [{ key: 'maker', role: 'engineer', description: 'Правит файлы' }, { key: 'reader', role: 'other', description: 'Проверяет изменения' }],
  tasks: [{ key: 'git-file', title: 'Изменить файл', prompt: 'Обновить README', criteria: 'Изменения проверены', agentKey: 'maker', reviewerKey: 'reader', deliveryMode: 'git', requiresAcceptance: true }],
};

async function until(service, select) {
  for (let i = 0; i < 100; i++) {
    const value = select(service.snapshot());
    if (value) return value;
    await delay(5);
  }
  assert.fail(JSON.stringify(service.snapshot().inbox));
}

test('Git work goes through scoped implementation, checks, exact review, owner acceptance and merge', async t => {
  const calls = [];
  const cleanupStarted = Promise.withResolvers();
  const cleanupRelease = Promise.withResolvers();
  const revision = { headOid: 'work', targetOid: 'base', candidateOid: 'candidate', digest: 'digest' };
  const service = createStudioService({
    dbPath: ':memory:',
    manageCleanup: { async apply() { cleanupStarted.resolve(); await cleanupRelease.promise; } },
    prepareTarget: async () => ({ targetRef: 'refs/heads/delivery' }),
    projectPipeline: {
      workScope: async () => ({ scope: { root: '/task', access: 'worktree-write' }, worktreeId: 'tree', release: async () => {} }),
      evaluate: async () => ({ worktreeId: 'tree', revision, status: 'review', checks: [], evidence: [] }),
      reviewScope: async () => ({ scope: { root: '/candidate', access: 'read' }, release: async () => {} }),
      merge: async ({ task }) => { calls.push('merge'); assert.deepEqual(task.gitDelivery.receipt.revision, revision); return { status: 'merged', targetOid: 'candidate' }; },
    },
    run: async request => {
      const training = trainingReply(request);
      if (training) return training;
      calls.push(request.scope?.access ?? request.purpose);
      const results = { plan, task: { summary: 'Правка' }, review: { pass: true, summary: 'Проверено' }, director: { action: 'finish' } };
      return { text: JSON.stringify(results[request.purpose]) };
    },
  });
  t.after(() => { cleanupRelease.resolve(); return service.close(); });
  const { id: studioId } = service.createStudio({ name: 'Git', root: '/test', groomingPolicy: { enabled: false } });
  await service.configureProject({ studioId, enabled: true, targetRef: 'delivery', profile: { id: 'project', checks: [] } });
  service.initializeStudio({ studioId });
  const draft = await until(service, state => state.plans[0]);
  service.decidePlan({ planId: draft.id, decision: 'approve' });
  const inbox = await until(service, state => state.inbox.find(({ kind }) => kind === 'acceptance'));
  assert.deepEqual(calls, ['plan', 'worktree-write', 'read']);
  assert.deepEqual(inbox.review.delivery.revision, revision);
  assert.equal(inbox.review.targetRef,'refs/heads/delivery');
  const decision = { studioId,inboxId:inbox.id,operationId:'owner-accept-1',decision:'approve',expectedResult:inbox.review.key };
  assert.throws(()=>service.answerInbox({...decision,expectedResult:'stale'}),/измен/);
  assert.throws(()=>service.answerInbox({...decision,studioId:'other'}),/студии/);
  const receipt = service.answerInbox(decision);
  assert.deepEqual(service.answerInbox(decision),receipt);
  const task = await until(service, state => state.tasks.find(task => task.deliveryMode === 'git' && task.stage === 'done'));
  assert.equal(task.gitDelivery.status, 'merged');
  assert.deepEqual(calls, ['plan', 'worktree-write', 'read', 'merge', 'director']);
  await cleanupStarted.promise;
  let closed = false;
  const closing = service.close().then(() => { closed = true; });
  await delay(1);
  assert.equal(closed, false);
  assert.equal(service.cleanupState({ studioId, taskId: task.id }).task.stage, 'done');
  cleanupRelease.resolve();
  await closing;
});
test('a held sprint stages both reviewed changes and requires one pinned release decision', async t => {
  const merged=[];
  let director=0;
  const service=createStudioService({dbPath:':memory:',
    prepareTarget:async()=>({targetRef:'refs/heads/delivery'}),
    projectPipeline:{
      workScope:async({task})=>({worktreeId:task.id,scope:{root:'/work',access:'worktree-write'},release:async()=>{}}),
      preparePackage:async({task,members})=>{assert.equal(members.length,2);return {worktreeId:task.id};},
      evaluate:async({task})=>({worktreeId:task.id,revision:{candidateOid:task.id,digest:task.id},status:'review',checks:[],evidence:[]}),
      reviewScope:async()=>({scope:{root:'/review',access:'read'},release:async()=>{}}),
      merge:async({studio,task})=>{merged.push(studio.projectGit.targetRef);return {status:'merged',targetOid:task.id};}
    },
    run:async req=>{
      const training=trainingReply(req);if(training)return training;
      const first={...plan.tasks[0],requiresAcceptance:false};
      const answer={plan:{...plan,tasks:[first,{...first,key:'second',title:'Second',dependsOn:[first.key]}]},
        task:{summary:'Ready'},review:{pass:true,summary:'Checked'},director:{action:director===2?'finish':'next'}};
      if(req.purpose==='director')director++;
      return {text:JSON.stringify(answer[req.purpose])};
    }});
  t.after(()=>service.close());
  const s=service.createStudio({name:'Studio',root:'/project',wipLimit:1,sprintReview:'hold'});
  await service.configureProject({studioId:s.id,enabled:true,targetRef:'delivery'});
  service.initializeStudio({studioId:s.id});
  const draft=await until(service,state=>state.plans[0]);
  service.decidePlan({planId:draft.id,decision:'approve'});
  const item=await until(service,state=>state.inbox.find(row=>row.kind==='acceptance' && row.review?.members?.length===2));
  assert.equal(merged.length,2);
  assert.ok(merged.every(ref=>ref.startsWith('refs/heads/hearth-packages/')));
  service.answerInbox({inboxId:item.id,decision:'approve',expectedResult:item.review.key,operationId:'accept-package'});
  await until(service,state=>state.sprints[0].status==='completed');
  assert.equal(merged.filter(r=>r==='refs/heads/delivery').length,1);
});
