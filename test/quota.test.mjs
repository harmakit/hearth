import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { codexWeeklyQuota } from '../core/quota.mjs';
import { createStudioService } from '../core/service.mjs';

test('Codex weekly quota uses window duration, not primary/secondary position or a model bucket',()=>{
  const weekly={usedPercent:65,windowDurationMins:10080,resetsAt:2000000000};
  const short={usedPercent:99,windowDurationMins:300};
  const expected={status:'known',remainingPercent:35,resetAt:new Date(2000000000*1000).toISOString()};
  assert.deepEqual(codexWeeklyQuota({rateLimits:{primary:weekly,secondary:short}}),expected);
  assert.deepEqual(codexWeeklyQuota({rateLimits:{primary:short,secondary:weekly}}),expected);
  assert.deepEqual(codexWeeklyQuota({rateLimits:{limitId:'other',primary:short},rateLimitsByLimitId:{codex:{primary:weekly}}}),expected);
  assert.equal(codexWeeklyQuota({rateLimits:{limitId:'other',primary:weekly}}).status,'unknown');
  assert.equal(codexWeeklyQuota({rateLimits:{primary:short}}).status,'unknown');
  assert.equal(codexWeeklyQuota({rateLimits:{primary:{...weekly,usedPercent:101}}}).remainingPercent,0);
  assert.equal(codexWeeklyQuota({accountId:'test-account',rateLimits:{primary:weekly}}).accountKey.length,64);
});

async function until(select) {
  for(let i=0;i<100;i++){
    const value=select();
    if(value)return value;
    await delay(5);
  }
  assert.fail('Expected quota state did not arrive');
}

test('global and studio weekly pauses do not interrupt runs, and require a fresh observation to resume after restart',async t=>{
  const folder=await mkdtemp(join(tmpdir(),'hearth-quota-'));
  const dbPath=join(folder,'profile.sqlite');
  let service;
  const hold=Promise.withResolvers();
  t.after(async()=>{hold.resolve();await service?.close();await rm(folder,{recursive:true,force:true});});
  let clock=new Date('2026-11-25T00:00:00Z');
  let remaining=30;
  const started=[];
  const options={dbPath,now:()=>clock,inspectRuntime:async({runtime})=>({
    available:true,authenticated:true,
    ...(runtime==='codex'?{weeklyQuota:remaining===null?{status:'unknown'}:{status:'known',remainingPercent:remaining,resetAt:'2026-11-25T01:00:00Z'}}:{}),
  }),run:async req=>{
    started.push(req);
    if(started.length<=2)await hold.promise;
    return {text:'{"summary":"Finished"}'};
  }};
  service=createStudioService(options);
  await service.inspectProvider({runtime:'codex'});
  const one=service.createStudio({root:'/one',name:'One',director:{runtime:'codex'}});
  const two=service.createStudio({root:'/two',name:'Two',director:{runtime:'claude'}});
  service.updateQuotaPolicy({scope:'studio',studioId:one.id,threshold:20});
  service.updateQuotaPolicy({scope:'app',threshold:10});
  const task=(studio,title)=>{
    const row=service.createTask({studioId:studio.id,title,prompt:title});
    service.startTask({taskId:row.id});
    return row;
  };
  const first=task(one,'Active one'),second=task(two,'Active two');
  await until(()=>started.length===2);
  // The provider reaches the exact threshold in a live notification.
  started[0].onEvent({type:'weekly-quota',weeklyQuota:{status:'known',remainingPercent:10,resetAt:'2026-11-25T01:00:00Z'}});
  assert.ok(service.snapshot().studios.every(studio=>studio.quotaPause?.scope==='app'));
  const queuedOne=task(one,'Queued one'),queuedTwo=task(two,'Queued two');
  hold.resolve();
  await until(()=>service.snapshot().tasks.filter(row=>[first.id,second.id].includes(row.id)).every(row=>row.stage==='done'));
  await delay(20);
  assert.equal(started.length,2);
  // The studio threshold is independent, and the app threshold stops even
  // work configured for a different provider.
  service.updateQuotaPolicy({scope:'app',threshold:null});
  await until(()=>service.snapshot().tasks.find(row=>row.id===queuedTwo.id).stage==='done');
  assert.equal(service.snapshot().studios.find(row=>row.id===one.id).quotaPause.scope,'studio');
  assert.equal(service.snapshot().studios.find(row=>row.id===two.id).quotaPause,undefined);
  assert.equal(started.length,3);
  remaining=21;
  await service.inspectProvider({runtime:'codex'});
  await until(()=>service.snapshot().tasks.find(row=>row.id===queuedOne.id).stage==='done');
  assert.equal(started.length,4);
  remaining=5;
  await service.inspectProvider({runtime:'codex'});
  service.updateQuotaPolicy({scope:'app',threshold:10});
  remaining=null;
  await service.inspectProvider({runtime:'codex'});
  assert.equal(service.snapshot().providers.codex.weeklyQuota.status,'unknown');
  assert.equal(service.snapshot().providers.claude.weeklyQuota.status,'unsupported');
  assert.equal(service.snapshot().quotaPolicy.pause.remainingPercent,5);
  await service.close();
  clock=new Date('2026-11-25T02:00:00Z');
  service=createStudioService(options);
  assert.equal(service.snapshot().quotaPolicy.pause.stale,true);
  const after=task(two,'After restart');
  await delay(20);
  assert.equal(started.length,4);
  assert.equal(service.snapshot().tasks.find(row=>row.id===after.id).stage,'ready');
  remaining=50;
  await service.inspectProvider({runtime:'codex'});
  await until(()=>service.snapshot().tasks.find(row=>row.id===after.id).stage==='done');
  assert.equal(service.snapshot().quotaPolicy.pause,undefined);
  assert.equal(started.length,5);
});

test('a never-observed weekly quota is unknown, not an exhausted quota',async t=>{
  let runs=0;
  const service=createStudioService({dbPath:':memory:',inspectRuntime:async()=>({available:true,weeklyQuota:{status:'unknown'}}),
    run:async()=>{runs++;return {text:'{"summary":"Finished"}'};}});
  t.after(()=>service.close());
  const studio=service.createStudio({root:'/unknown',name:'Unknown'});
  service.updateQuotaPolicy({scope:'app',threshold:10});
  await service.inspectProvider({runtime:'codex'});
  assert.equal(service.snapshot().quotaPolicy.pause,undefined);
  assert.equal(service.snapshot().providers.codex.weeklyQuota.status,'unknown');
  assert.throws(()=>service.updateQuotaPolicy({scope:'app',threshold:101}),/0 до 100/);
  const task=service.createTask({studioId:studio.id,title:'Work',prompt:'Work'});
  service.startTask({taskId:task.id});
  await until(()=>service.snapshot().tasks.find(row=>row.id===task.id).stage==='done');
  assert.equal(runs,1);
});
