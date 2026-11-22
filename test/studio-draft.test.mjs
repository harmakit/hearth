import test from 'node:test';
import assert from 'node:assert/strict';
import { readStudioDraft,writeStudioDraft,clearStudioDraft } from '../renderer/studio-draft.mjs';

const storage = () => {
  const map=new Map();
  return {getItem:k=>map.get(k),setItem:(k,value)=>map.set(k,value),removeItem:k=>map.delete(k)};
};

test('wizard draft retains input, step and uncertain submission across instances', ()=>{
  const store=storage();
  writeStudioDraft(store,{step:2,pending:true,existingIds:['old'],fields:{name:'Новая',brief:'Работа',folderMode:'existing',root:'/qa/folder',runtime:'claude',secret:'not allowed'}});
  assert.deepEqual(readStudioDraft(store),{version:1,step:2,pending:true,existingIds:['old'],fields:{name:'Новая',brief:'Работа',folderMode:'existing',root:'/qa/folder',runtime:'claude'}});
  clearStudioDraft(store);
  assert.equal(readStudioDraft(store),null);
});

test('draft storage tolerates a corrupt or unavailable profile', ()=>{
  assert.equal(readStudioDraft({getItem:()=>'{'}),null);
  assert.equal(readStudioDraft({getItem:()=>'{ "version": 99 }'}),null);
  assert.equal(writeStudioDraft({setItem(){throw Error('disk');}},{step:0,fields:{name:'Draft'}}),false);
});

test('normal field changes cannot erase an uncertain creation until explicitly reconciled', ()=>{
  const store=storage();
  const draft={step:2,pending:true,existingIds:['initial'],fields:{name:'Archive'}};
  assert.equal(writeStudioDraft(store,draft),true);
  assert.equal(writeStudioDraft(store,{...draft,pending:false,fields:{name:'Other'}}),false);
  assert.equal(readStudioDraft(store).pending,true);
  assert.deepEqual(readStudioDraft(store).existingIds,['initial']);
  assert.equal(writeStudioDraft(store,{...draft,step:1,pending:false},{afterReview:true}),true);
  assert.equal(readStudioDraft(store).pending,false);
});
