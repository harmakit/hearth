import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { git } from '../app/git-worktrees.mjs';
import { createCommandRouter } from '../app/bridge.mjs';
import { createStudioService } from '../core/service.mjs';

test('studio setup creates local history only for an explicitly new project folder', async t => {
  // The positive case must live outside a Git checkout. Only disposable project data is written here.
  const parent = await realpath(await mkdtemp(join(tmpdir(),'hearth-project-history-')));
  t.after(()=>rm(parent,{recursive:true,force:true}));
  const service = createStudioService({dbPath:':memory:',run:async()=>({text:'ok'})});
  t.after(()=>service.close());
  const request = createCommandRouter({service});
  const make = (name, extra={})=>request('createStudio',{name:'Книги', root:parent,newFolderName:name,...extra});
  const studio = await make('Рукопись');
  assert.equal(studio.root,join(parent,'Рукопись'));
  assert.equal(studio.projectGit.enabled,true);
  assert.equal((await git(studio.root,['rev-list','--count','HEAD'])).trim(),'1');
  assert.equal(await git(studio.root,['remote']), '');
  assert.equal((await git(studio.root,['rev-parse','HEAD'])).trim(),(await git(studio.root,['rev-parse',studio.projectGit.targetRef])).trim());
  await assert.rejects(make('Рукопись'));
  await assert.rejects(make('../outside'));
  await assert.rejects(make('Nested',{root:studio.root}));
  const existing = join(parent,'existing');
  await mkdir(existing);
  const plain = await request('createStudio',{name:'Архив',root:existing});
  assert.equal(plain.projectGit,undefined);
  assert.deepEqual(await readdir(existing),[]);
  await writeFile(join(existing,'notes.txt'),'original');
  await assert.rejects(make('existing'));
  assert.equal(await readFile(join(existing,'notes.txt'),'utf8'),'original');
  assert.equal(service.snapshot().studios.length,2);
});
