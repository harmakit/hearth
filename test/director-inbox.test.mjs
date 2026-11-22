import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createStudioService } from '../core/service.mjs';
import { explicitInboxApproval } from '../core/director-inbox.mjs';
import { trainingReply } from './fixtures/training.mjs';

const plan = {
  title:'Outline sprint', goal:'A draft', epic:{title:'Book',description:'A story'}, story:{title:'Outline',acceptance:'Has an opening'},
  agents:[{key:'writer',role:'editor',description:'Write'},{key:'editor',role:'editor',description:'Verify'}],
  tasks:[{key:'outline',title:'Outline',prompt:'Draft',criteria:'Clear',agentKey:'writer',reviewerKey:'editor'}], files:[],
};

async function waiting(read, label) {
  for (let i=0; i<200; i++) {
    const result=read();
    if(result)return result;
    await delay(5);
  }
  assert.fail(label);
}

test('reply wording is never inferred from a quoted, negative or conditional merge request', () => {
  assert.equal(explicitInboxApproval('merge','Прими результат и слей в ветку main.','main'),true);
  assert.equal(explicitInboxApproval('merge','Не сливай в ветку main.','main'),false);
  assert.equal(explicitInboxApproval('merge','Прими результат и слей в ветку other.','main'),false);
  assert.equal(explicitInboxApproval('merge','Объясни «Прими результат и слей в ветку main».','main'),false);
});

test('only a submitted reply reaches the director and the same operation does not act twice', async t => {
  const prompts=[];
  const service=createStudioService({ dbPath:':memory:', run:async request=>{
    if(request.purpose==='director-inbox'){
      prompts.push(request.prompt);
      return {text:JSON.stringify({action:'approve',text:'Model recommends approval'})};
    }
    return trainingReply(request) ?? {text:JSON.stringify(request.purpose==='plan'?plan:
      request.purpose==='review'?{pass:true,summary:'Verified'}:
      request.purpose==='director'?{action:'finish'}:{summary:'Draft'})};
  }});
  t.after(()=>service.close());
  const studio=service.createStudio({root:'/project',name:'Director answers'});
  service.initializeStudio({studioId:studio.id});
  const item=await waiting(()=>service.snapshot().inbox.find(i=>i.kind==='plan'),'plan question');
  const input={studioId:studio.id,inboxId:item.id,version:1,expectedEditVersion:0,operationId:'note-1',text:'Поясни, зачем нужна проверка. Не стартуй.'};
  assert.equal(prompts.length,0);
  const first=service.postDirectorInboxReply(input);
  assert.equal(service.postDirectorInboxReply(input).id,first.id);
  assert.throws(()=>service.postDirectorInboxReply({...input,text:'Другое'}));
  await waiting(()=>service.snapshot().conversationMessages.find(m=>m.replyTo===first.id),'director reply');
  assert.match(prompts[0], /Поясни, зачем нужна проверка/);
  assert.equal(service.snapshot().plans[0].status,'pending');
  const second=service.postDirectorInboxReply({...input,operationId:'note-2',text:'Подтверди план и запусти спринт.'});
  await waiting(()=>service.snapshot().conversationMessages.find(m=>m.replyTo===second.id),'approval reply');
  assert.equal(service.snapshot().plans[0].status,'approved');
  assert.equal(service.snapshot().sprints.length,1);
  assert.equal(prompts.length,2);
});

test('a director decision becomes stale if the owner edits the plan while the model runs', async t => {
  const result=Promise.withResolvers();
  const service=createStudioService({dbPath:':memory:',run:async request=>{
    if(request.purpose==='director-inbox')return result.promise;
    return {text:JSON.stringify(plan)};
  }});
  t.after(()=>{result.resolve({text:'{}'});return service.close();});
  const studio=service.createStudio({root:'/project',name:'Plan edit'});
  service.initializeStudio({studioId:studio.id});
  const item=await waiting(()=>service.snapshot().inbox.find(i=>i.kind==='plan'),'pending plan');
  const request=service.postDirectorInboxReply({studioId:studio.id,inboxId:item.id,version:1,expectedEditVersion:0,
    operationId:'stale-test',text:'Подтверди план и запусти спринт.'});
  await waiting(()=>service.snapshot().attempts.find(a=>a.purpose==='director-inbox'),'model started');
  service.updatePlanTasks({planId:item.planId,expectedEditVersion:0,tasks:[{key:'outline',title:'Edited outline',agentKey:'writer',reviewerKey:'editor',requiresAcceptance:false}]});
  result.resolve({text:JSON.stringify({action:'approve',text:'Approve'})});
  const reply=await waiting(()=>service.snapshot().conversationMessages.find(m=>m.replyTo===request.id),'stale reply');
  assert.match(reply.text,/Версия входящего изменилась/);
  assert.equal(service.snapshot().plans[0].status,'pending');
  assert.equal(service.snapshot().sprints.length,0);
});

test('the director cannot accept a saved result whose file changed after review', async t => {
  const checkedPlan={...plan,tasks:[{...plan.tasks[0],artifactPath:'outline.md',requiresAcceptance:true}]};
  const service=createStudioService({dbPath:':memory:',writeArtifact:async ({path})=>({path}),readArtifact:async ()=>'Different file',
    run:async request=>trainingReply(request)??{text:JSON.stringify(
      request.purpose==='plan'?checkedPlan:request.purpose==='task'?{summary:'Draft',artifact:'Reviewed file'}:
      request.purpose==='review'?{pass:true,summary:'Verified'}:{action:'approve',text:'Accept'})},
  });
  t.after(()=>service.close());
  const studio=service.createStudio({root:'/project',name:'Changed file'});
  service.initializeStudio({studioId:studio.id});
  const draft=await waiting(()=>service.snapshot().plans[0],'plan draft');
  service.decidePlan({planId:draft.id,decision:'approve'});
  const item=await waiting(()=>service.snapshot().inbox.find(i=>i.kind==='acceptance'),'file acceptance');
  const request=service.postDirectorInboxReply({studioId:studio.id,inboxId:item.id,version:item.version??1,
    expectedResult:item.review.key,operationId:'changed-file',text:'Прими этот результат.'});
  const reply=await waiting(()=>service.snapshot().conversationMessages.find(m=>m.replyTo===request.id),'file rejection');
  assert.match(reply.text,/Файл изменился после ревью/);
  assert.equal(service.snapshot().inbox.find(i=>i.id===item.id).status,'open');
});

test('the director can name sources from the blocked task and keeps a clarification open', async t => {
  let prompt;
  const service=createStudioService({dbPath:':memory:',run:async request=>{
    if(request.purpose==='director-inbox'){
      prompt=request.prompt;
      return {text:'{"action":"explain","text":"The researcher supplied the links."}'};
    }
    return {text:JSON.stringify({summary:'The studio could not resolve the source host.',
      artifact:'See [Chronology](https://reference.example/chronology).',
      question:'Do you have a copy?'})};
  }});
  t.after(()=>service.close());
  const studio=service.createStudio({root:'/project',name:'Sources'});
  const task=service.createTask({studioId:studio.id,title:'Verify the dates',prompt:'Confirm the historical setting.'});
  service.startTask({taskId:task.id});
  const item=await waiting(()=>service.snapshot().inbox.find(i=>i.taskId===task.id&&i.kind==='question'),'open question');
  const request=service.postDirectorInboxReply({studioId:studio.id,inboxId:item.id,version:item.version??1,
    operationId:'sources',text:'Какие именно источники?'});
  await waiting(()=>service.snapshot().conversationMessages.find(m=>m.replyTo===request.id),'director reply');
  assert.match(prompt,/https:\/\/reference\.example\/chronology/);
  assert.match(prompt,/The studio could not resolve the source host/);
  assert.equal(service.snapshot().inbox.find(i=>i.id===item.id).status,'open');
  const options=service.snapshot().inbox.find(i=>i.id===item.id).directorSuggestions;
  assert.ok(options.some(option=>option.id==='continue'));
  const alternative=options.find(option=>option.id==='alternative');
  assert.ok(alternative);
  const next=service.postDirectorInboxReply({studioId:studio.id,inboxId:item.id,version:item.version??1,
    operationId:'another-way',text:alternative.text});
  await waiting(()=>service.snapshot().conversationMessages.find(m=>m.replyTo===next.id),'director passes the chosen route');
  assert.equal(service.snapshot().inbox.find(i=>i.id===item.id).status,'resolved');
});

test('manually assigned work also gets a safe technical recovery before a question is shown', async t => {
  let work=0;
  let director=0;
  const service=createStudioService({dbPath:':memory:',run:async request=>{
    if(request.purpose==='resolve-blocker'){
      director++;
      return {text:'{"nextStep":"Use the recorded evidence."}'};
    }
    if(++work===1)return {text:'{"summary":"Origin unavailable","question":{"kind":"technical","body":"Source cannot be reached"}}'};
    assert.match(request.prompt,/Use the recorded evidence/);
    return {text:'{"summary":"Recovered"}'};
  }});
  t.after(()=>service.close());
  const studio=service.createStudio({root:'/project',name:'Manual recovery'});
  const task=service.createTask({studioId:studio.id,title:'Check',prompt:'Use the evidence.'});
  service.startTask({taskId:task.id});
  const final=await waiting(()=>service.snapshot().tasks.find(row=>row.id===task.id&&['completed','waiting'].includes(row.status)),
    'manual task outcome');
  assert.equal(final.status,'completed');
  assert.equal(director,1);
  assert.equal(work,2);
  assert.equal(service.snapshot().inbox.some(row=>row.taskId===task.id&&row.status==='open'),false);
});
