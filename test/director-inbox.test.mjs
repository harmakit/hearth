import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createStudioService } from '../core/service.mjs';
import { directorInboxSuggestions, explicitInboxApproval, ownerSourceDirective, reconciliationDecision, reconciliationState } from '../core/director-inbox.mjs';
import { summarizeWebResearch } from '../core/web-research.mjs';
import { trainingReply } from './fixtures/training.mjs';

const plan = {
  title:'Outline sprint', goal:'A draft', epic:{title:'Book',description:'A story'}, story:{title:'Outline',acceptance:'Has an opening'},
  agents:[{key:'writer',role:'editor',description:'Write'},{key:'editor',role:'editor',description:'Verify'}],
  tasks:[{key:'outline',title:'Outline',prompt:'Draft',criteria:'Clear',agentKey:'writer',reviewerKey:'editor'}], files:[],
};

test('polite search requests and denied source options are recognized consistently', () => {
  const answer='Ищите официальный исторический источник и проверьте по нему дату.';
  assert.equal(ownerSourceDirective(answer),'search');
  assert.equal(ownerSourceDirective('Не ищите в интернете. Используйте материалы студии.'),'local');
  const item={kind:'question',title:'Источник не открылся',choices:[{label:'Разрешить поиск',answer}]};
  assert.equal(directorInboxSuggestions(item,'ru',{webSearch:'available'})[0].intent,'search');
  assert.ok(!directorInboxSuggestions(item,'ru',{webSearch:'unavailable'}).some(option=>option.text===answer));
});

test('a recorded page-opening attempt remains visible when its URL was also found in search', () => {
  const url='https://example.com/history';
  const result=summarizeWebResearch({search:'used',links:[url],pages:[{url,status:'attempted'}]},{sources:[{url,status:'read',note:'Date'}]});
  assert.equal(result.sources[0].status,'attempted');
  assert.deepEqual(result.unverified,['Date']);
});

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
  assert.equal(prompts.length,1);
});

test('a held write explains the recorded state and can be retried after the owner checks it', async t => {
  const root=await mkdtemp(join(tmpdir(),'hearth-reconcile-inbox-'));
  let writes=0;
  let modelReplies=0;
  const artifactPlan={...plan,tasks:[{...plan.tasks[0],artifactPath:'outline.md'}]};
  const service=createStudioService({dbPath:join(root,'studio.sqlite'),
    writeArtifact:async ({path})=>{
      if(++writes===1)throw new Error('QA: запись файла не подтверждена.');
      return {path};
    },
    run:async request=>{
      if(request.purpose==='director-inbox'){
        modelReplies++;
        return {text:'{"action":"explain","text":"Прежний процесс всё ещё работает."}'};
      }
      return trainingReply(request) ?? {text:JSON.stringify(request.purpose==='plan'?artifactPlan:
        request.purpose==='review'?{pass:true,summary:'Verified'}:
          request.purpose==='director'?{action:'finish'}:{summary:'Draft',artifact:'# QA',artifactPath:'outline.md'})};
    },
  });
  t.after(async()=>{await service.close();await rm(root,{recursive:true,force:true});});
  service.setAppLocale({locale:'ru'});
  const studio=service.createStudio({root,name:'Recovery QA'});
  service.initializeStudio({studioId:studio.id});
  const draft=await waiting(()=>service.snapshot().plans[0],'plan');
  service.decidePlan({planId:draft.id,decision:'approve'});
  const item=await waiting(()=>service.snapshot().inbox.find(row=>row.kind==='reconcile'),'write needs reconciliation');
  const attempt=service.snapshot().attempts.find(row=>row.id===item.attemptId);
  assert.equal(attempt.reason,'unknown-effect');
  assert.ok(!attempt.processActive && !attempt.processUnconfirmed);
  const send=async (operationId,text)=>{
    const message=service.postDirectorInboxReply({studioId:studio.id,inboxId:item.id,version:1,operationId,text});
    return waiting(()=>service.snapshot().conversationMessages.find(row=>row.replyTo===message.id),'director inbox reply');
  };
  const explanation=await send('reconcile-explain',item.directorSuggestions.find(option=>option.id==='explain').text);
  assert.equal(explanation.text,item.reconciliationDetail);
  assert.match(explanation.text,/сохранённые изменения/u);
  assert.equal(modelReplies,0);
  assert.equal(writes,1);
  const retry=item.directorSuggestions.find(option=>option.id==='retry');
  assert.ok(retry);
  assert.match(retry.text,/проверил.*изменения/iu);
  const receipt=await send('reconcile-retry',retry.text);
  assert.equal(receipt.outcome,'applied');
  assert.equal(modelReplies,0);
  assert.equal(service.snapshot().inbox.find(row=>row.id===item.id).status,'resolved');
  await waiting(()=>service.snapshot().sprints.some(row=>row.status==='completed'),'sprint finished after retry');
  assert.equal(writes,2);
});

test('reconciliation options track process confirmation and require the matching visible text',()=>{
  const options=attempt=>directorInboxSuggestions({kind:'reconcile'},'ru',{reconciliation:reconciliationState(attempt)});
  const attempt={status:'reconcile',reason:'restart'};
  const active={...attempt,processActive:true};
  const confirmed={...attempt,reason:'stopped',processActive:false,processUnconfirmed:false};
  const retry=options(attempt).find(option=>option.id==='retry');
  const discard=options(attempt).find(option=>option.id==='discard');
  assert.deepEqual(options(active).map(({id})=>id),['explain']);
  assert.equal(reconciliationDecision(reconciliationState(active),retry.text),undefined);
  assert.equal(reconciliationDecision(reconciliationState(attempt),options(confirmed)[0].text),undefined);
  assert.deepEqual(reconciliationDecision(reconciliationState(attempt),retry.text),{decision:'retry',confirmProcessExited:true});
  assert.deepEqual(reconciliationDecision(reconciliationState(attempt),discard.text),{decision:'discard',confirmProcessExited:true});
});

test('a queued explicit decision becomes stale if the owner edits the plan', async t => {
  const service=createStudioService({dbPath:':memory:',run:async request=>{
    if(request.purpose==='director-inbox')assert.fail('An explicit approval needs no model reply.');
    return {text:JSON.stringify(plan)};
  }});
  t.after(()=>service.close());
  const studio=service.createStudio({root:'/project',name:'Plan edit'});
  service.initializeStudio({studioId:studio.id});
  const item=await waiting(()=>service.snapshot().inbox.find(i=>i.kind==='plan'),'pending plan');
  const request=service.postDirectorInboxReply({studioId:studio.id,inboxId:item.id,version:1,expectedEditVersion:0,
    operationId:'stale-test',text:'Подтверди план и запусти спринт.'});
  service.updatePlanTasks({planId:item.planId,expectedEditVersion:0,tasks:[{key:'outline',title:'Edited outline',agentKey:'writer',reviewerKey:'editor',requiresAcceptance:false}]});
  const reply=await waiting(()=>service.snapshot().conversationMessages.find(m=>m.replyTo===request.id),'stale reply');
  assert.match(reply.text,/Версия входящего изменилась/);
  assert.equal(service.snapshot().plans[0].status,'pending');
  assert.equal(service.snapshot().sprints.length,0);
});

test('the confirmed Git approval is recorded without asking a model to reinterpret it', async t => {
  const gitPlan={...plan,tasks:[{...plan.tasks[0],deliveryMode:'git',requiresAcceptance:true}]};
  let merges=0;
  const service=createStudioService({
    dbPath:':memory:',
    prepareTarget:async()=>({targetRef:'refs/heads/delivery'}),
    projectPipeline:{
      workScope:async()=>({worktreeId:'tree',scope:{root:'/work',access:'worktree-write'},release:async()=>{}}),
      evaluate:async()=>({worktreeId:'tree',revision:{candidateOid:'candidate'},checks:[],evidence:[],status:'review'}),
      reviewScope:async()=>({scope:{root:'/review',access:'read'},release:async()=>{}}),
      merge:async()=>{merges++;return {status:'merged',targetOid:'candidate'};},
    },
    run:async request=>{
      if(request.purpose==='director-inbox')return {text:'{"action":"clarify","text":"Do you really want to approve?"}'};
      return trainingReply(request)??{text:JSON.stringify({plan:gitPlan,task:{summary:'Ready'},review:{pass:true,summary:'Checked'},director:{action:'finish'}}[request.purpose])};
    }
  });
  t.after(()=>service.close());
  const studio=service.createStudio({root:'/project',name:'Git approval'});
  await service.configureProject({studioId:studio.id,enabled:true,targetRef:'delivery'});
  service.initializeStudio({studioId:studio.id});
  const draft=await waiting(()=>service.snapshot().plans[0],'plan draft');
  service.decidePlan({planId:draft.id,decision:'approve'});
  const item=await waiting(()=>service.snapshot().inbox.find(row=>row.kind==='acceptance'),'Git acceptance');
  const message=service.postDirectorInboxReply({studioId:studio.id,inboxId:item.id,version:item.version??1,
    expectedResult:item.review.key,operationId:'accept-git',text:'Прими результат и слей в ветку delivery'});
  const reply=await waiting(()=>service.snapshot().conversationMessages.find(row=>row.replyTo===message.id),'acceptance reply');
  assert.equal(reply.outcome,'applied');
  await waiting(()=>service.snapshot().sprints.some(row=>row.status==='completed'),'sprint completed');
  assert.equal(merges,1);
  assert.equal(service.snapshot().attempts.find(row=>row.purpose==='director-inbox').calls?.length??0,0);
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

const archive = 'https://archive.example/record';
const missing = 'https://archive.example/missing';
const other = 'https://archive.example/index';
const webCapabilities = {search:'available',read:'available'};
const availableProvider = async () => ({available:true,authenticated:true,webCapabilities});
const sourceQuestion = {text:JSON.stringify({summary:'Missing footnote',question:'Не открывается исторический источник.'})};
const researchReply = (search, pages=[], {action='answer',links=[other]}={}) => ({
  text:JSON.stringify({action,text:'Сверка источников обработана.',researchIntent:'search',webResearch:{
    sources:[{url:archive,note:'Дата указана в записи.'},{url:missing,note:'Страница не открылась.'},
      {url:other,note:'Имя требует проверки.'},{url:'file:///private/reference',note:'Private'}],
    unverified:['Имя владельца записи'],
  }}),
  web:{capabilities:webCapabilities,search,pages,links},
});

async function openSourceQuestion(service) {
  service.setAppLocale({locale:'ru'});
  await service.inspectProvider({runtime:'codex'});
  const studio=service.createStudio({root:'/project',name:'Archive research'});
  const task=service.createTask({studioId:studio.id,title:'Verify the date',prompt:'Read the historical sources.'});
  service.startTask({taskId:task.id});
  const item=await waiting(()=>service.snapshot().inbox.find(row=>row.taskId===task.id && row.status==='open'),'source question');
  return {studio,task,item};
}

test('search starts only after sending and preserves reviewed sources and one continuation across restart', async t => {
  const folder=await mkdtemp(join(tmpdir(),'hearth-web-inbox-'));
  const dbPath=join(folder,'studio.sqlite');
  let service;
  t.after(async()=>{await service?.close();await rm(folder,{recursive:true,force:true});});
  const calls=[];
  const run=async request=>{
    calls.push(request);
    if(request.purpose==='director-inbox'){
      return researchReply('used',[{url:archive,status:'read'},{url:missing,status:'failed',reason:'HTTP 404'},
        {url:other,status:'attempted'}]);
    }
    return calls.filter(call=>call.purpose!=='director-inbox').length===1?sourceQuestion:{text:'{"summary":"Checked the archive"}'};
  };
  service=createStudioService({dbPath,inspectRuntime:availableProvider,run});
  const {studio,task,item}=await openSourceQuestion(service);
  const option=item.directorSuggestions.find(choice=>choice.label==='Найти другие источники');
  assert.ok(option);
  service.saveInboxDraft({studioId:studio.id,inboxId:item.id,draft:{text:option.text}});
  assert.equal(calls.filter(call=>call.purpose==='director-inbox').length,0);
  const input={studioId:studio.id,inboxId:item.id,version:1,operationId:'web-search',text:option.text};
  const sent=service.postDirectorInboxReply(input);
  assert.equal(service.postDirectorInboxReply(input).id,sent.id);
  const reply=await waiting(()=>service.snapshot().conversationMessages.find(row=>row.replyTo===sent.id),'web report');
  assert.equal(reply.outcome,'applied');
  assert.equal(reply.webResearch.status,'completed');
  assert.deepEqual(reply.webResearch.sources.map(({url,status})=>[url,status]),[[archive,'read'],[missing,'failed'],[other,'attempted']]);
  assert.deepEqual(reply.webResearch.unverified,['Имя владельца записи']);
  assert.equal(service.snapshot().inbox.find(row=>row.id===item.id).status,'resolved');
  await waiting(()=>service.snapshot().tasks.find(row=>row.id===task.id && row.status==='completed'),'resumed task');
  assert.match(calls.at(-1).prompt,/archive\.example\/record/);
  assert.match(calls.at(-1).prompt,/Имя владельца записи/);
  assert.match(calls.find(call=>call.purpose==='director-inbox').prompt,/must use.*web search/i);
  await service.close();
  service=createStudioService({dbPath,inspectRuntime:availableProvider,run});
  assert.equal(service.postDirectorInboxReply(input).id,sent.id);
  assert.deepEqual(service.snapshot().conversationMessages.find(row=>row.replyTo===sent.id).webResearch,reply.webResearch);
  assert.equal(calls.length,3);
});

test('a confirmed research request retries once if the tool was ignored and keeps its question open', async t => {
  const calls=[];
  const service=createStudioService({dbPath:':memory:',inspectRuntime:availableProvider,run:async request=>{
    if(request.purpose!=='director-inbox')return sourceQuestion;
    calls.push(request);
    return researchReply('not-used');
  }});
  t.after(()=>service.close());
  const {studio,task,item}=await openSourceQuestion(service);
  const sent=service.postDirectorInboxReply({studioId:studio.id,inboxId:item.id,version:1,
    operationId:'paraphrased',text:'Поищи в интернете другие архивы, где можно сверить дату.'});
  const reply=await waiting(()=>service.snapshot().conversationMessages.find(row=>row.replyTo===sent.id),'missed search');
  assert.equal(calls.length,2);
  assert.equal(reply.webResearch.status,'not-run');
  assert.deepEqual(reply.webResearch.sources,[]);
  assert.equal(service.snapshot().inbox.find(row=>row.id===item.id).status,'open');
  assert.equal(service.snapshot().tasks.find(row=>row.id===task.id).status,'waiting');
});

test('a disabled web connection invalidates the search option without losing a submitted reply', async t => {
  let directorCalls=0;
  const service=createStudioService({dbPath:':memory:',inspectRuntime:availableProvider,run:async request=>{
    if(request.purpose==='director-inbox')directorCalls++;
    return sourceQuestion;
  }});
  t.after(()=>service.close());
  const {studio,item}=await openSourceQuestion(service);
  const option=item.directorSuggestions.find(choice=>choice.label==='Найти другие источники');
  assert.ok(option);
  service.updateProviderPreference({runtime:'codex',enabled:false});
  assert.ok(!service.snapshot().inbox.find(row=>row.id===item.id).directorSuggestions.some(choice=>choice.label===option.label));
  const sent=service.postDirectorInboxReply({studioId:studio.id,inboxId:item.id,version:1,operationId:'connection-changed',text:option.text});
  const reply=await waiting(()=>service.snapshot().conversationMessages.find(row=>row.replyTo===sent.id),'disabled search');
  assert.equal(directorCalls,0);
  assert.equal(reply.webResearch.status,'unavailable');
  assert.equal(service.snapshot().inbox.find(row=>row.id===item.id).status,'open');
});

test('editing the search suggestion to continue locally forwards the visible text without a search retry', async t => {
  let directorCalls=0;
  let executorPrompt;
  const service=createStudioService({dbPath:':memory:',inspectRuntime:availableProvider,run:async request=>{
    if(request.purpose==='director-inbox'){
      directorCalls++;
      assert.equal(request.webEnabled,false);
      return researchReply('not-used');
    }
    if(!executorPrompt){executorPrompt=request.prompt;return sourceQuestion;}
    assert.equal(request.webEnabled,false);
    executorPrompt=request.prompt;
    return {text:'{"summary":"Local evidence only"}'};
  }});
  t.after(()=>service.close());
  const {studio,task,item}=await openSourceQuestion(service);
  const option=item.directorSuggestions.find(choice=>choice.label==='Найти другие источники');
  assert.ok(option);
  service.saveInboxDraft({studioId:studio.id,inboxId:item.id,draft:{text:option.text}});
  const text='Найди источники в материалах студии, не ищи в интернете.';
  const sent=service.postDirectorInboxReply({studioId:studio.id,inboxId:item.id,version:1,operationId:'local-only',text});
  const reply=await waiting(()=>service.snapshot().conversationMessages.find(row=>row.replyTo===sent.id),'local continuation');
  await waiting(()=>service.snapshot().tasks.find(row=>row.id===task.id && row.status==='completed'),'locally resumed task');
  assert.equal(directorCalls,1);
  assert.equal(reply.webResearch,undefined);
  assert.ok(executorPrompt.includes(text));
  assert.ok(!executorPrompt.includes(option.text));
});

test('search does not resolve the question for unverified URLs or when the owner asks to keep it open', async t => {
  let mode;
  const service=createStudioService({dbPath:':memory:',inspectRuntime:availableProvider,run:async request=>{
    if(request.purpose!=='director-inbox')return sourceQuestion;
    return mode === 'keep-open' ? researchReply('used',[{url:archive,status:'read'}],{action:'answer',links:[]})
      : researchReply('used',[],{links:[]});
  }});
  t.after(()=>service.close());
  const {studio,task,item}=await openSourceQuestion(service);
  for (const [operationId,text] of [['ungrounded','Найди другие источники.'],['keep-open','Найди другие источники, но оставь вопрос открытым.']]) {
    mode=operationId;
    const sent=service.postDirectorInboxReply({studioId:studio.id,inboxId:item.id,version:1,operationId,text});
    const reply=await waiting(()=>service.snapshot().conversationMessages.find(row=>row.replyTo===sent.id),'research without a continuation');
    assert.equal(service.snapshot().inbox.find(row=>row.id===item.id).status,'open');
    assert.equal(service.snapshot().tasks.find(row=>row.id===task.id).status,'waiting');
    assert.equal(reply.webResearch.sources.find(source=>source.url===archive).status,mode==='keep-open'?'read':'unverified');
  }
});

test('a new provider denial replaces previously observed search availability', async t => {
  let denied=false;
  const service=createStudioService({dbPath:':memory:',inspectRuntime:async()=>({available:true,authenticated:true,
    webCapabilities:denied?{search:'unavailable',read:'available'}:webCapabilities}),run:async()=>({
      ...sourceQuestion,web:{capabilities:webCapabilities,search:'not-used',pages:[]},
    })});
  t.after(()=>service.close());
  const {item}=await openSourceQuestion(service);
  assert.ok(item.directorSuggestions.some(option=>option.label==='Найти другие источники'));
  denied=true;
  await service.inspectProvider({runtime:'codex'});
  assert.ok(!service.snapshot().inbox.find(row=>row.id===item.id).directorSuggestions.some(option=>option.label==='Найти другие источники'));
});

test('a manual research continuation saved just before shutdown runs once after restart', async t => {
  const folder=await mkdtemp(join(tmpdir(),'hearth-web-recover-'));
  const dbPath=join(folder,'studio.sqlite');
  let service;
  t.after(async()=>{await service?.close();await rm(folder,{recursive:true,force:true});});
  let closing;
  let executorCalls=0;
  const run=async request=>{
    if(request.purpose==='director-inbox')return researchReply('used',[{url:archive,status:'read'}]);
    if(++executorCalls===1)return sourceQuestion;
    assert.match(request.prompt,/"sourceResearch"/);
    return {text:'{"summary":"Archive checked"}'};
  };
  service=createStudioService({dbPath,inspectRuntime:availableProvider,run,onChange:state=>{
    if(!closing && state.conversationMessages.some(row=>row.webResearch?.status==='completed'))closing=service.close();
  }});
  const {studio,task,item}=await openSourceQuestion(service);
  const input={studioId:studio.id,inboxId:item.id,version:1,operationId:'shutdown-research',text:'Найди другие источники.'};
  const sent=service.postDirectorInboxReply(input);
  await waiting(()=>Boolean(closing),'shutdown after settling the inbox');
  await closing;
  assert.equal(executorCalls,1);
  service=createStudioService({dbPath,inspectRuntime:availableProvider,run});
  assert.equal(service.postDirectorInboxReply(input).id,sent.id);
  await waiting(()=>service.snapshot().tasks.find(row=>row.id===task.id && row.status==='completed'),'recovered continuation');
  assert.equal(executorCalls,2);
  assert.equal(service.snapshot().conversationMessages.filter(row=>row.replyTo===sent.id).length,1);
});

test('a sprint task resumes through its dispatcher and sees the saved research', async t => {
  let workerCalls=0;
  const service=createStudioService({dbPath:':memory:',inspectRuntime:availableProvider,run:async request=>{
    if(request.purpose==='director-inbox')return researchReply('used',[{url:archive,status:'attempted'}],{links:[]});
    if(request.purpose==='task' && !trainingReply(request)){
      if(++workerCalls===1)return sourceQuestion;
      assert.match(request.prompt,/"sourceResearch"/);
      assert.match(request.prompt,/"status":\s*"attempted"/);
      return {text:'{"summary":"Continued with an unverified archive"}'};
    }
    return trainingReply(request) ?? {text:JSON.stringify(request.purpose==='plan'?plan:
      request.purpose==='review'?{pass:true,summary:'Checked'}:{action:'finish'})};
  }});
  t.after(()=>service.close());
  service.setAppLocale({locale:'ru'});
  await service.inspectProvider({runtime:'codex'});
  const studio=service.createStudio({root:'/project',name:'Archive sprint'});
  service.initializeStudio({studioId:studio.id});
  const draft=await waiting(()=>service.snapshot().plans[0],'sprint plan');
  service.decidePlan({planId:draft.id,decision:'approve'});
  const item=await waiting(()=>service.snapshot().inbox.find(row=>row.kind==='question' && row.status==='open'),'sprint source question');
  const sent=service.postDirectorInboxReply({studioId:studio.id,inboxId:item.id,version:1,operationId:'sprint-search',text:'Найди другие источники.'});
  const reply=await waiting(()=>service.snapshot().conversationMessages.find(row=>row.replyTo===sent.id),'sprint research reply');
  assert.equal(reply.outcome,'applied');
  assert.equal(reply.webResearch.sources.find(source=>source.url===archive).status,'attempted');
  await waiting(()=>service.snapshot().sprints.some(row=>row.status==='completed'),'sprint completed');
  assert.equal(workerCalls,2);
});
