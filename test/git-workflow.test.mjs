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
      if(request.purpose==='task'){
        assert.match(request.prompt,/Do not ask the owner to run Git status or a configured check/);
        assert.match(request.prompt,/"command":"node"/);
      }
      if(request.purpose==='review')assert.match(request.prompt,/actual results instead of demanding another run/);
      const results = { plan, task: { summary: 'Правка' }, review: { pass: true, summary: 'Проверено' }, director: { action: 'finish' } };
      return { text: JSON.stringify(results[request.purpose]) };
    },
  });
  t.after(() => { cleanupRelease.resolve(); return service.close(); });
  const { id: studioId } = service.createStudio({ name: 'Git', root: '/test', groomingPolicy: { enabled: false } });
  await service.configureProject({ studioId, enabled: true, targetRef: 'delivery', profile: { id: 'project', checks: [{id:'tests',command:'node',args:['--test'],required:true}] } });
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

test('a moving delivery target starts a fresh review without an obsolete error or owner approval', async t => {
  let evaluations = 0;
  let merges = 0;
  const service = createStudioService({
    dbPath: ':memory:',
    prepareTarget: async () => ({ targetRef: 'refs/heads/delivery' }),
    projectPipeline: {
      workScope: async () => ({ worktreeId: 'tree', scope: { root: '/task', access: 'worktree-write' }, release: async () => {} }),
      evaluate: async () => {
        const candidate = String(++evaluations);
        return { worktreeId: 'tree', revision: { candidateOid: candidate, digest: candidate }, status: 'review', checks: [], evidence: [] };
      },
      reviewScope: async () => ({ scope: { root: '/candidate', access: 'read' }, release: async () => {} }),
      merge: async ({ task }) => {
        if (++merges === 1) throw Object.assign(new Error('The delivery target has changed'), { code: 'TARGET_CHANGED' });
        assert.equal(task.gitDelivery.receipt.revision.candidateOid, '2');
        return { status: 'merged', targetOid: '2' };
      },
    },
    run: async request => {
      const training = trainingReply(request);
      if (training) return training;
      return { text: JSON.stringify({ plan, task: { summary: 'Ready' }, review: { pass: true, summary: 'Checked' }, director: { action: 'finish' } }[request.purpose]) };
    },
  });
  t.after(() => service.close());
  const { id: studioId } = service.createStudio({ name: 'Changing Git target', root: '/test', wipLimit: 1, groomingPolicy: { enabled: false } });
  await service.configureProject({ studioId, enabled: true, targetRef: 'delivery' });
  service.initializeStudio({ studioId });
  const draft = await until(service, state => state.plans[0]);
  service.decidePlan({ planId: draft.id, decision: 'approve' });
  const first = await until(service, state => state.inbox.find(item => item.kind === 'acceptance' && item.status === 'open'));
  service.answerInbox({ studioId, inboxId: first.id, decision: 'approve', expectedResult: first.review.key, operationId: 'first-approval' });
  const second = await until(service, state => state.inbox.find(item => item.kind === 'acceptance' && item.status === 'open' && item.id !== first.id));
  assert.equal(second.review.delivery.revision.candidateOid, '2');
  assert.equal(merges, 1);
  assert.equal(service.snapshot().inbox.some(item => item.kind === 'error' && item.status === 'open'), false);
  service.answerInbox({ studioId, inboxId: second.id, decision: 'approve', expectedResult: second.review.key, operationId: 'second-approval' });
  await until(service, state => state.sprints[0].status === 'completed');
  assert.equal(merges, 2);
});

test('a rejected sprint package reopens a member and reviews the new integrated Git snapshot', async t => {
  const revisions = ['a'.repeat(40), 'b'.repeat(40)];
  const checks = [{ checkId:'verify', phase:'candidate', status:'PASS', required:true }];
  let evaluations = 0;
  let summaryReviews = 0;
  let assembled;
  const service = createStudioService({ dbPath: ':memory:', prepareTarget: async () => ({ targetRef: 'refs/heads/delivery' }),
    projectPipeline: {
      workScope: async () => ({ worktreeId: 'tree', scope: { root: '/work', access: 'worktree-write' }, release: async () => {} }),
      evaluate: async () => ({ worktreeId: 'tree', revision: {candidateOid:revisions[evaluations++]}, artifactPaths: ['character.md'], status: 'review', checks, evidence: [] }),
      reviewScope: async () => ({ scope: {root:'/candidate',access:'read'}, release: async () => {} }),
      workspaceContents: async (root, paths) => {
        assert.equal(root,'/work');
        assert.deepEqual(paths,['character.md']);
        return { files:[{path:'character.md',text:'Current working draft with the previous date.'}] };
      },
      merge: async ({task}) => ({status:'merged',targetOid:task.gitDelivery.revision.candidateOid}),
      packageReviewScope: async ({members,referencePaths}) => {
        assembled = members;
        assert.deepEqual(referencePaths, ['character.md']);
        return {scope:{root:'/delivered',access:'read'},context:{revision:{candidateOid:members[0].gitDelivery.targetOid},referenceFiles:[{path:'character.md',text:'# Character'}]},release:async()=>{}};
      },
    },
    run: async request => {
      const training=trainingReply(request); if(training)return training;
      if(request.purpose==='plan')return {text:JSON.stringify({...plan,tasks:[{...plan.tasks[0],requiresAcceptance:false}]})};
      if(request.purpose==='task' && evaluations===1) {
        assert.match(request.prompt,/Current draft files from this task’s working copy/);
        assert.match(request.prompt,/Current working draft with the previous date/);
      }
      if(request.purpose==='review' && request.prompt.startsWith('Review the assembled sprint package')) {
        assert.equal(request.scope.root,'/delivered');
        assert.match(request.prompt,/character\.md/);
        assert.match(request.prompt,/A pre-merge report documents the state when it was written/);
        const context=JSON.parse(request.prompt.split('\n\n')[1]);
        assert.equal(context.targetRef,'refs/heads/delivery');
        assert.equal(context.integratedDeliveries[0].targetOid,revisions[summaryReviews]);
        assert.equal(context.integratedDeliveries[0].status,'merged');
        assert.equal(context.integratedDeliveries[0].reviewResult,'PASS');
        assert.deepEqual(context.integratedDeliveries[0].checks,checks);
        if (++summaryReviews === 1) return {text:JSON.stringify({pass:false,summary:'The released character needs one factual correction.'})};
      }
      return {text:JSON.stringify({task:{summary:'Created'},review:{pass:true,summary:'Checked'},director:{action:'finish'}}[request.purpose])};
    },
  });
  t.after(()=>service.close());
  const {id: studioId}=service.createStudio({name:'Summary review',root:'/project',sprintReview:'summary',groomingPolicy:{enabled:false}});
  await service.configureProject({studioId,enabled:true,targetRef:'delivery'});
  service.initializeStudio({studioId});
  const draft=await until(service,state=>state.plans[0]);
  service.decidePlan({planId:draft.id,decision:'approve'});
  const rejected=await until(service,state=>state.inbox.find(row=>row.kind==='acceptance' && row.review?.reworkRequired));
  assert.equal(summaryReviews,1);
  assert.equal(rejected.review.packageRevision,revisions[0]);
  assert.ok(rejected.directorSuggestions.some(choice=>choice.id==='revise'));
  assert.ok(!rejected.directorSuggestions.some(choice=>choice.id==='approve'));
  assert.throws(()=>service.answerInbox({inboxId:rejected.id,decision:'approve',expectedResult:rejected.review.key}),/верните работу на доработку/);
  service.answerInbox({inboxId:rejected.id,decision:'revise',answer:'Correct the character’s date.',
    reworkTaskId:rejected.review.members[0].taskId,expectedResult:rejected.review.key});
  const item=await until(service,state=>state.inbox.find(row=>row.kind==='acceptance' && row.id!==rejected.id && row.review?.members));
  assert.equal(summaryReviews,2);
  assert.equal(assembled.length,1);
  assert.deepEqual(item.review.members[0].artifactPaths,['character.md']);
  assert.equal(item.review.packageRevision,revisions[1]);
  assert.deepEqual(item.review.artifactPaths,['character.md']);
  service.answerInbox({inboxId:item.id,decision:'approve',expectedResult:item.review.key,operationId:'accept-summary'});
  await until(service,state=>state.sprints[0].status==='completed');
});

test('a final Git task receives transitive delivered files and the approved sprint task bindings', async t => {
  const captures=[];
  let director=0;
  const first={...plan.tasks[0],key:'first',requiresAcceptance:false};
  const second={...first,key:'second',dependsOn:['first']};
  const third={...first,key:'final',dependsOn:['second']};
  const service=createStudioService({dbPath:':memory:',prepareTarget:async()=>({targetRef:'refs/heads/delivery'}),
    projectPipeline:{
      workScope:async({task})=>({worktreeId:task.id,scope:{root:'/'+task.key,access:'worktree-write'},release:async()=>{}}),
      workspaceContents:async(root,paths)=>{captures.push({root,paths});return {files:paths.map(path=>({path,text:'Delivered'})),imagePaths:[]};},
      evaluate:async({task})=>({worktreeId:task.id,revision:{candidateOid:task.id},artifactPaths:[task.key+'.md'],status:'review',checks:[],evidence:[]}),
      reviewScope:async()=>({scope:{root:'/candidate',access:'read'},release:async()=>{}}),
      merge:async({task})=>({status:'merged',targetOid:task.id}),
    },
    run:async request=>{
      const training=trainingReply(request);if(training)return training;
      if(request.purpose==='plan')return {text:JSON.stringify({...plan,tasks:[first,second,third]})};
      if(request.purpose==='task' && request.scope.root==='/final'){
        assert.match(request.prompt,/approved sprint task bindings/i);
        assert.match(request.prompt,/"key":"second"/);
      }
      if(request.purpose==='director')return {text:JSON.stringify({action:++director===3?'finish':'next'})};
      return {text:JSON.stringify({task:{summary:'Ready'},review:{pass:true,summary:'Verified'}}[request.purpose])};
    },
  });
  t.after(()=>service.close());
  const s=service.createStudio({name:'References',root:'/project',wipLimit:1,groomingPolicy:{enabled:false}});
  await service.configureProject({studioId:s.id,enabled:true,targetRef:'delivery'});
  service.initializeStudio({studioId:s.id});
  const draft=await until(service,state=>state.plans[0]);
  service.decidePlan({planId:draft.id,decision:'approve'});
  const capture=await until(service,()=>captures.find(row=>row.root==='/final'));
  assert.deepEqual(capture.paths,['second.md','first.md']);
});

test('a later Git comparison uses delivered paths and still receives standalone artifacts as context', async t => {
  const gitRevision = 'a'.repeat(40);
  const nextRevision = 'b'.repeat(40);
  const firstPlan = { ...plan, tasks: [
    { ...plan.tasks[0], key:'outline', title:'Draft outline', deliveryMode:undefined, artifactPath:'outline.md', requiresAcceptance:false },
    { ...plan.tasks[0], key:'tracked', title:'Deliver file', dependsOn:['outline'], requiresAcceptance:false },
  ] };
  const nextPlan = { ...plan, title:'Next sprint', tasks:[{ ...plan.tasks[0], key:'next', title:'Continue project', requiresAcceptance:false }] };
  const thirdPlan = { ...plan, title:'Third sprint', tasks:[{ ...plan.tasks[0], key:'third', title:'Use both releases', requiresAcceptance:false }] };
  let plans = 0;
  let directions = 0;
  const comparisons = [];
  const service = createStudioService({
    dbPath:':memory:',
    prepareTarget:async()=>({targetRef:'refs/heads/delivery'}),
    writeArtifact:async({path})=>({path}),
    projectPipeline:{
      workScope:async({task})=>({worktreeId:task.id,scope:{root:'/work',access:'worktree-write'},
        trackedPaths:{paths:['next.md','tracked.md'],truncated:false},release:async()=>{}}),
      workspaceContents:async(_root,paths)=>({files:paths.map(path=>({path,text:`Read ${path}`}))}),
      evaluate:async({task,worktreeId})=>({ worktreeId, status:'review',
        revision:{candidateOid:task.key==='tracked'?gitRevision:task.key==='next'?nextRevision:'c'.repeat(40)},
        artifactPaths:[task.key+'.md'], checks:[], evidence:[] }),
      reviewScope:async()=>({scope:{root:'/candidate',access:'read'},release:async()=>{}}),
      merge:async({task})=>({status:'merged',targetOid:task.gitDelivery.revision.candidateOid}),
      priorDeliveryStatus:async(_root,comparison)=>{
        comparisons.push(comparison);
        return {status:'unchanged'};
      },
    },
    run:async request=>{
      const training = trainingReply(request);
      if(training)return training;
      if(request.purpose==='plan')return {text:JSON.stringify([firstPlan,nextPlan,thirdPlan][plans++])};
      if(request.purpose==='director')return {text:JSON.stringify({action:['next','nextSprint','nextSprint','finish'][directions++]})};
      if(request.purpose==='review')return {text:'{"pass":true,"summary":"Checked"}'};
      if(!request.scope)return {text:'{"summary":"Draft ready","artifact":"Standalone outline","artifactPath":"outline.md"}'};
      if(plans===2)assert.match(request.prompt,/Standalone outline/);
      if(plans===3) {
        assert.match(request.prompt,/Tracked files in the working copy at launch/);
        assert.match(request.prompt,/Read next\.md/);
        assert.match(request.prompt,/Read tracked\.md/);
      }
      return {text:'{"summary":"Work ready"}'};
    },
  });
  t.after(()=>service.close());
  const studio=service.createStudio({name:'Mixed delivery',root:'/project',wipLimit:1,approveSprints:true,groomingPolicy:{enabled:false}});
  await service.configureProject({studioId:studio.id,enabled:true,targetRef:'delivery'});
  service.initializeStudio({studioId:studio.id});
  const first=await until(service,state=>state.plans[0]);
  service.decidePlan({planId:first.id,decision:'approve'});
  const next=await until(service,state=>state.plans.find(item=>item.title==='Next sprint'));
  service.decidePlan({planId:next.id,decision:'approve'});
  const third=await until(service,state=>state.plans.find(item=>item.title==='Third sprint'));
  service.decidePlan({planId:third.id,decision:'approve'});
  await until(service,state=>state.sprints.length===3&&state.sprints.every(sprint=>sprint.status==='completed'));
  assert.deepEqual(comparisons,[
    {revision:gitRevision,paths:['tracked.md']},{revision:gitRevision,paths:['tracked.md']},
    {revision:nextRevision,paths:['next.md']},{revision:nextRevision,paths:['next.md']},
  ]);
});

test('an owner-approved retry carries its error context to the implementer and reviewer', async t => {
  const feedback='Перезапусти задачу сейчас. Проверка точного кандидата выполнена владельцем.';
  let checks=0;
  const attempts=[];
  const reviews=[];
  const service=createStudioService({dbPath:':memory:',
    prepareTarget:async()=>({targetRef:'refs/heads/main'}),
    projectPipeline:{
      workScope:async()=>({worktreeId:'tree',scope:{root:'/work',access:'worktree-write'},release:async()=>{}}),
      evaluate:async()=>({worktreeId:'tree',revision:{candidateOid:'candidate',digest:'digest'},
        status:++checks===1?'checks-blocked':'review',checks:[],evidence:[]}),
      reviewScope:async()=>({scope:{root:'/review',access:'read'},release:async()=>{}}),
    },
    run:async request=>{
      const training=trainingReply(request);if(training)return training;
      if(request.purpose==='task')attempts.push(request.prompt);
      if(request.purpose==='review')reviews.push(request.prompt);
      const answers={plan,task:{summary:'Result'},review:{pass:true,summary:'Reviewed'},
        'director-inbox':{action:'retry',text:'Уточнения переданы.'}};
      return {text:JSON.stringify(answers[request.purpose])};
    }});
  t.after(()=>service.close());
  const {id:studioId}=service.createStudio({name:'Retry',root:'/project',wipLimit:2});
  await service.configureProject({studioId,enabled:true,targetRef:'main'});
  service.initializeStudio({studioId});
  const draft=await until(service,state=>state.plans[0]);
  service.decidePlan({planId:draft.id,decision:'approve'});
  const failure=await until(service,state=>state.inbox.find(item=>item.kind==='error'&&item.status==='open'));
  service.postDirectorInboxReply({studioId,inboxId:failure.id,version:1,operationId:'retry-check',text:feedback});
  await until(service,state=>state.inbox.find(item=>item.kind==='acceptance'));
  assert.equal(attempts.length,2);
  assert.ok(attempts[1].includes(feedback));
  assert.ok(reviews[0].includes(feedback));
});

test('a text follow-up and its reviewer read an integrated Git dependency instead of the project checkout', async t => {
  const revision={candidateOid:'accepted',digest:'digest'};
  const scopedCalls=[];
  const report={key:'report',title:'Проверить итог',prompt:'Проверить готовый проект',criteria:'Привести итоги проверки',
    agentKey:'maker',reviewerKey:'reader',dependsOn:['git-file']};
  const service=createStudioService({dbPath:':memory:',
    prepareTarget:async()=>({targetRef:'refs/heads/delivery'}),
    projectPipeline:{
      workScope:async()=>({worktreeId:'tree',scope:{root:'/work',access:'worktree-write'},release:async()=>{}}),
      evaluate:async()=>({worktreeId:'tree',revision,artifactPaths:['video/main.tsx'],status:'review',checks:[],evidence:[]}),
      reviewScope:async()=>({scope:{root:'/candidate',access:'read'},release:async()=>{}}),
      merge:async()=>({status:'merged',targetOid:'accepted'}),
      packageReviewScope:async({studio,members,referencePaths})=>{
        assert.equal(studio.projectGit.targetRef,'refs/heads/delivery');
        assert.equal(members.length,1);
        assert.equal(members[0].gitDelivery.targetOid,'accepted');
        assert.deepEqual(referencePaths,['video/main.tsx']);
        return {scope:{root:'/integrated',access:'read'},context:{revision,files:[{path:'video/main.tsx',text:'Delivered file'}],
          checks:[{checkId:'render',status:'PASS'}]},release:async()=>{}};
      },
    },
    run:async request=>{
      const training=trainingReply(request);if(training)return training;
      if(request.scope?.root==='/integrated'){
        assert.equal(request.scope.access,'read');
        assert.match(request.prompt,/Delivered file/);
        assert.match(request.prompt,/"status":"PASS"/);
        assert.match(request.prompt,/already recorded passing check/);
        scopedCalls.push(request.purpose);
      }
      const options={plan:{...plan,tasks:[{...plan.tasks[0],requiresAcceptance:false},report]},task:{summary:'Ready'},
        review:{pass:true,summary:'Reviewed'},director:{action:scopedCalls.length?'finish':'next'}};
      return {text:JSON.stringify(options[request.purpose])};
    },
  });
  t.after(()=>service.close());
  const {id:studioId}=service.createStudio({name:'Report',root:'/project',wipLimit:2});
  await service.configureProject({studioId,enabled:true,targetRef:'delivery'});
  service.initializeStudio({studioId});
  const draft=await until(service,state=>state.plans[0]);
  service.decidePlan({planId:draft.id,decision:'approve'});
  await until(service,state=>state.sprints[0]?.status==='completed');
  assert.deepEqual(scopedCalls,['task','review']);
});
