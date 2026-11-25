import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,readFile,readdir,realpath,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createCodeGraph} from '../app/codegraph.mjs';
import {git} from '../app/git-worktrees.mjs';
import {createStudioService} from '../core/service.mjs';

test('CodeGraph copies the exact current Git workspace, excludes private paths and removes its index after use',async t=>{
  if(process.platform==='win32'){t.skip('Executable fixture uses a POSIX path');return;}
  const folder=await realpath(await mkdtemp(join(tmpdir(),'hearth-graph-')));
  t.after(()=>rm(folder,{recursive:true,force:true}));
  const project=join(folder,'project'),worktree=join(folder,'worktree'),storage=join(folder,'indexes');
  await mkdir(join(project,'src'),{recursive:true});
  await mkdir(join(project,'.hearth','state'),{recursive:true});
  await writeFile(join(project,'src','main.mjs'),'export const value = "main";');
  await writeFile(join(project,'.hearth','state','private.mjs'),'Fixture should not be indexed');
  await symlink('main.mjs',join(project,'src','alias.mjs'));
  await git(project,['init','--initial-branch=main']);
  await git(project,['add','src','.hearth']);
  await git(project,['-c','user.name=QA','-c','user.email=qa@hearth.invalid','commit','-m','Fixture']);
  await git(project,['worktree','add','-b','other','--',worktree]);
  await writeFile(join(worktree,'src','main.mjs'),'export const value = "worktree";');
  const executable=join(folder,'codegraph');
  await writeFile(executable,'#!/bin/sh\n', {mode:0o700});
  const graph=createCodeGraph({storageDir:storage,git,executable,run:async(_cmd,args,options)=>{
    assert.equal(options.env.CODEGRAPH_TELEMETRY,'0');
    assert.equal(options.env.DO_NOT_TRACK,'1');
    assert.equal(options.env.OPENAI_API_KEY,undefined);
    assert.deepEqual(await readdir(options.cwd),['src']);
    assert.deepEqual(await readdir(join(options.cwd,'src')),['main.mjs']);
    if(args[0]==='status')return {stdout:JSON.stringify({nodeCount:2,languages:['javascript']})};
    if(args[0]==='context')return {stdout:await readFile(join(options.cwd,'src','main.mjs'),'utf8')};
    assert.equal(args[0],'init');
    return {stdout:''};
  }});
  const first=await graph.context({root:project,query:'value'});
  const second=await graph.context({root:worktree,query:'value'});
  assert.match(first.text,/"main"/);
  assert.match(second.text,/"worktree"/);
  assert.equal(second.files,1);
  assert.deepEqual(await readdir(storage),[]);
  assert.deepEqual(await readdir(project),['.git','.hearth','src']);
  assert.equal((await graph.context({root:join(project,'src'),query:'value'})).status,'unsupported');
});

test('CodeGraph application policy and studio overrides apply to subsequent attempts and record tool stats',async t=>{
  const queries=[];
  const service=createStudioService({dbPath:':memory:',run:async request=>{
    queries.push(request.codeGraphQuery);
    if(request.codeGraphQuery)request.onEvent({type:'codegraph',status:'used',durationMs:25,files:2,nodes:4,characters:100});
    return {text:'{"summary":"Done"}'};
  }});
  t.after(()=>service.close());
  const inherited=service.createStudio({root:'/one',name:'One'});
  const override=service.createStudio({root:'/two',name:'Two'});
  const task=async studio=>{
    const created=service.createTask({studioId:studio.id,title:'Locate source',prompt:'Find symbol'});
    service.startTask({taskId:created.id});
    for(let i=0;i<100;i++){
      if(service.snapshot().tasks.find(row=>row.id===created.id).stage==='done')return created;
      await delay(5);
    }
    assert.fail('Task did not finish');
  };
  await task(inherited);
  service.updateCodeGraphPolicy({scope:'app',enabled:true});
  service.updateCodeGraphPolicy({scope:'studio',studioId:override.id,mode:'off'});
  const graphTask=await task(inherited);
  await task(override);
  service.updateCodeGraphPolicy({scope:'app',enabled:false});
  service.updateCodeGraphPolicy({scope:'studio',studioId:override.id,mode:'on'});
  await task(override);
  assert.deepEqual(queries,[undefined,'Locate source\nFind symbol',undefined,'Locate source\nFind symbol']);
  assert.equal(service.snapshot().attempts.find(row=>row.taskId===graphTask.id).calls[0].codeGraph.status,'used');
});
