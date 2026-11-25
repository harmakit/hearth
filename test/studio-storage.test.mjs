import assert from 'node:assert/strict';
import { cp,mkdir,mkdtemp,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createStudioService } from '../core/service.mjs';

test('moving an opted-in studio into its folder preserves original IDs and restores a paused copy',async t=>{
  const base=fileURLToPath(new URL('../.tmp/',import.meta.url));
  await mkdir(base,{recursive:true});
  const root=await mkdtemp(join(base,'portable-state-'));
  let first;
  let second;
  t.after(async()=>{
    await first?.close();
    await second?.close();
    await rm(root,{recursive:true,force:true});
  });
  const source=join(root,'original');
  const copy=join(root,'a new location');
  await mkdir(source);
  first=createStudioService({dbPath:join(root,'profile.sqlite')});
  const studio=first.createStudio({root:source,name:'Port me'});
  const task=first.createTask({studioId:studio.id,title:'Keep' ,prompt:'Keep all records'});
  const conversation=first.postStudioMessage({studioId:studio.id,taskId:task.id,kind:'comment',text:'Portable history'});
  await first.migrateStudioStorage({studioId:studio.id,root:source});
  assert.equal(first.snapshot().studios[0].root,source);
  await first.close();
  const db=new DatabaseSync(join(source,'.hearth','state','studio.sqlite3'),{readOnly:true});
  assert.equal(db.prepare('SELECT id FROM tasks WHERE id=?').get(task.id).id,task.id);
  db.close();
  await cp(source,copy,{recursive:true});
  second=createStudioService({dbPath:join(root,'new-profile.sqlite')});
  await second.openStudioStorage({root:copy,studioId:studio.id});
  assert.equal(second.snapshot().tasks.find(entry=>entry.id===task.id).studioId,studio.id);
  const context=second.conversationView({studioId:studio.id,conversationId:conversation.conversationId});
  assert.equal(context.context[0].text,'Portable history');
  assert.equal(second.conversationPage({studioId:studio.id,conversationId:conversation.conversationId}).rows[0].id,conversation.id);
  assert.equal(second.snapshot().studios[0].root,copy);
  assert.equal(second.snapshot().studios[0].manualPaused,true);
  await assert.rejects(second.openStudioStorage({root:source,studioId:studio.id}),/другой папк/u);
  await second.openStudioStorage({root:source,studioId:studio.id,replaceRoot:true});
  assert.equal(second.snapshot().studios[0].root,source);
});

test('an unsent draft and a queued reply survive moving a paused studio',async t=>{
  const base=fileURLToPath(new URL('../.tmp/',import.meta.url));
  await mkdir(base,{recursive:true});
  const root=await mkdtemp(join(base,'portable-inbox-'));
  let first;
  let second;
  t.after(async()=>{
    await first?.close();
    await second?.close();
    await rm(root,{recursive:true,force:true});
  });
  const source=join(root,'original');
  const copy=join(root,'copy');
  await mkdir(source);
  const run=async request=>request.purpose==='director-inbox'?
    {text:'{"action":"explain","text":"The studio recorded the question."}'}:
    {text:'{"summary":"Evidence exists","question":"Which evidence should we prioritize?"}'};
  const wait=async fn=>{
    for(let i=0;i<100;i++){
      const result=fn();
      if(result)return result;
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.fail('Expected inbox state not reached.');
  };
  first=createStudioService({dbPath:join(root,'profile.sqlite'),run});
  const studio=first.createStudio({root:source,name:'Portable inbox'});
  await first.migrateStudioStorage({studioId:studio.id,root:source});
  const task=first.createTask({studioId:studio.id,title:'Review',prompt:'Find evidence'});
  first.startTask({taskId:task.id});
  const item=await wait(()=>first.snapshot().inbox.find(item=>item.taskId===task.id));
  first.pauseForStudioCopy({studioId:studio.id});
  first.saveInboxDraft({studioId:studio.id,inboxId:item.id,draft:{text:'Unsent draft'}});
  const message=first.postDirectorInboxReply({studioId:studio.id,inboxId:item.id,version:1,operationId:'pending',text:'Which evidence?'});
  await first.close();
  await cp(source,copy,{recursive:true});
  second=createStudioService({dbPath:join(root,'another.sqlite'),run});
  await second.openStudioStorage({studioId:studio.id,root:copy});
  assert.equal(second.snapshot().inboxDrafts.find(row=>row.inboxId===item.id).draft.text,'Unsent draft');
  assert.equal(second.snapshot().conversationMessages.find(row=>row.id===message.id).status,'queued');
  second.setStudioRunning({studioId:studio.id,action:'resume'});
  const reply=await wait(()=>second.snapshot().conversationMessages.find(row=>row.replyTo===message.id));
  assert.equal(reply.text,'The studio recorded the question.');
});
