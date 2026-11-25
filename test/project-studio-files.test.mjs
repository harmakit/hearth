import assert from 'node:assert/strict';
import { mkdtemp,mkdir,readFile,readlink,rm,symlink,writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createProjectStudioFiles } from '../app/project-studio-files.mjs';
import { git } from '../app/git-worktrees.mjs';

const skill={name:'chronology',description:'Use when checking a date.',instructions:'Check the source.',files:{'references/notes.md':'Notes.'}};
const role={name:'researcher',description:'Investigates sources.',instructions:'Use evidence.',requiredSkills:['chronology']};
const model={settings:{id:'fixture',name:'A test studio'},roles:[role],skills:[skill]};
const base=fileURLToPath(new URL('../.tmp/',import.meta.url));
async function setup(t,options={}){
  await mkdir(base,{recursive:true});
  const root=await mkdtemp(join(base,'portable-files-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  return {root,files:createProjectStudioFiles(options)};
}

test('publishes provider role files and a shared skill with an intact supporting file',async t=>{
  if(process.platform==='win32'){t.skip('Windows without Developer Mode uses ordinary directories.');return;}
  const {root,files}=await setup(t,{useSymlinks:true});
  await writeFile(join(root,'.gitignore'),'personal.txt\n');
  await files.publish(root,model);
  assert.equal(await readlink(join(root,'.claude/skills/chronology')),'../../.agents/skills/chronology');
  assert.match(await readFile(join(root,'.claude/agents/researcher.md'),'utf8'),/skills: \["chronology"\]/u);
  assert.match(await readFile(join(root,'.codex/agents/researcher.toml'),'utf8'),/developer_instructions = /u);
  assert.equal(await readFile(join(root,'.agents/skills/chronology/references/notes.md'),'utf8'),'Notes.');
  assert.match(await readFile(join(root,'.gitignore'),'utf8'),/^personal\.txt\n[\s\S]*\.hearth\/state\//u);
  assert.equal((await files.resolveRole(root,'researcher','codex')).requiredSkills[0].path,'.agents/skills/chronology/SKILL.md');
});

test('supports regular skill directories and preserves external edits on conflict',async t=>{
  const {root,files}=await setup(t,{useSymlinks:false});
  await files.publish(root,model);
  assert.equal(await readFile(join(root,'.claude/skills/chronology/references/notes.md'),'utf8'),'Notes.');
  const changed=join(root,'.codex/agents/researcher.toml');
  await writeFile(changed,'owner edit');
  await assert.rejects(files.publish(root,{...model,roles:[{...role,instructions:'next'}]}),/researcher\.toml/u);
  assert.equal(await readFile(changed,'utf8'),'owner edit');
  assert.match(await readFile(join(root,'.claude/agents/researcher.md'),'utf8'),/Use evidence/u);
});

test('keeps the tracked ignore file and index clean when attaching a Git project',async t=>{
  const {root,files}=await setup(t,{useSymlinks:false});
  await git(root,['init','--initial-branch=main']);
  await writeFile(join(root,'.gitignore'),'personal.txt\n');
  await git(root,['add','.gitignore']);
  await git(root,['-c','user.name=QA','-c','user.email=qa@example.invalid','commit','-m','Initial']);
  await files.publish(root,model);
  assert.equal(await readFile(join(root,'.gitignore'),'utf8'),'personal.txt\n');
  assert.equal(await git(root,['status','--porcelain','--untracked-files=no']),'');
  assert.equal((await git(root,['check-ignore','.hearth/state/studio.sqlite3'])).trim(),'.hearth/state/studio.sqlite3');
});

test('cannot publish through an outside directory link',async t=>{
  const {root,files}=await setup(t);
  if(process.platform==='win32')return;
  await mkdir(join(root,'outside'));
  await mkdir(join(root,'project'));
  await symlink(join(root,'outside'),join(root,'project','.hearth'),'dir');
  await assert.rejects(files.publish(join(root,'project'),model),/\.hearth/u);
});
