import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { createGitWorktrees, git, nativeGitPath, verifyGitVersion } from '../app/git-worktrees.mjs';
import { createCommandRouter } from '../app/bridge.mjs';
import { createStudioService } from '../core/service.mjs';
import { createPortableStudioManager } from '../app/portable-studio.mjs';
import { createProjectStudioFiles } from '../app/project-studio-files.mjs';

test('Git version floor accepts platform builds and rejects the older Ubuntu worktree command', () => {
  assert.equal(verifyGitVersion('git version 2.43.0'), '2.43.0');
  assert.equal(verifyGitVersion('git version 2.56.1.windows.1'), '2.56.1');
  assert.throws(() => verifyGitVersion('git version 2.34.1'), { code: 'GIT_VERSION_UNSUPPORTED' });
  assert.throws(() => verifyGitVersion('git unavailable'), { code: 'GIT_VERSION_UNSUPPORTED' });
});

test('Git for Windows porcelain paths use the native separator when checking registrations', () => {
  assert.equal(nativeGitPath('C:/QA space/Книга/worktree', 'win32'), 'C:\\QA space\\Книга\\worktree');
  assert.equal(nativeGitPath('/work/file\\name', 'linux'), '/work/file\\name');
});

test('the existing folder wizard connects Git by default and preserves a repository checkout and index', async t => {
  const parent = await realpath(await mkdtemp(join(tmpdir(),'hearth-project-history-')));
  t.after(()=>rm(parent,{recursive:true,force:true}));
  const { prepareTarget } = createGitWorktrees({storageDir:join(parent,'storage'),validateRepository:async () => true});
  const service = createStudioService({dbPath:':memory:',run:async()=>({text:'ok'}),prepareTarget,projectPipeline:{}});
  t.after(()=>service.close());
  const request = createCommandRouter({service});
  const plainFolder = join(parent,'guys inc');
  await mkdir(plainFolder);
  await writeFile(join(plainFolder,'draft.md'),'Original draft');
  assert.equal((await request('inspectProjectFolder',{root:plainFolder})).state,'missing');
  const plain = await request('createStudio',{name:'Guys',root:plainFolder});
  assert.equal(plain.projectGit.enabled,true);
  assert.equal(plain.lifecycle,'draft');
  assert.equal(await git(plainFolder,['ls-files']), '');
  assert.equal(await readFile(join(plainFolder,'draft.md'),'utf8'),'Original draft');
  const initialized = await request('createStudio',{name:'New repo',root:parent,newFolderName:'Book'});
  const root=initialized.root;
  await git(root,['branch','other']);
  await writeFile(join(root,'staged.md'),'Staged text');
  await git(root,['add','staged.md']);
  await writeFile(join(root,'staged.md'),'Unstaged edit');
  await writeFile(join(root,'draft.md'),'Untracked text');
  const before=await git(root,['status','--porcelain']);
  const head=await git(root,['rev-parse','HEAD']);
  const inspected=await request('inspectProjectFolder',{root});
  assert.equal(inspected.state,'existing');
  assert.equal(inspected.defaultTargetRef,'refs/heads/main');
  assert.ok(inspected.branches.some(branch=>branch.ref==='refs/heads/main' && branch.checkedOutElsewhere===false));
  const existing=await request('createStudio',{name:'Existing repo',root});
  assert.equal(existing.projectGit.enabled,true);
  assert.equal(existing.projectGit.targetRef,'refs/heads/main');
  assert.equal(await git(root,['rev-parse',existing.projectGit.targetRef]),head);
  const selected=await request('createStudio',{name:'Selected branch',root,targetRef:'refs/heads/other'});
  assert.equal(selected.projectGit.targetRef,'refs/heads/other');
  assert.equal(await git(root,['status','--porcelain']),before);
  assert.equal(await git(root,['symbolic-ref','HEAD']),'refs/heads/main\n');
  assert.equal(await git(root,['rev-parse','HEAD']),head);

  const nested=join(root,'nested');
  await mkdir(nested);
  assert.equal((await request('inspectProjectFolder',{root:nested})).state,'nested');
  await assert.rejects(request('createStudio',{name:'Nested',root:nested}),/корневую папку/iu);
  assert.deepEqual(await readdir(nested),[]);
});

test('studio setup creates local history in new and existing project folders', async t => {
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
  assert.equal(plain.projectGit.enabled,true);
  assert.deepEqual(await readdir(existing),['.git']);
  await writeFile(join(existing,'notes.txt'),'original');
  await assert.rejects(make('existing'));
  assert.equal(await readFile(join(existing,'notes.txt'),'utf8'),'original');
  assert.equal(service.snapshot().studios.length,2);
});

test('an existing unborn repository receives a delivery branch without committing its staged files or moving HEAD',async t=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),'hearth-unborn-')));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const {prepareTarget}=createGitWorktrees({storageDir:join(root,'unused'),validateRepository:async()=>true});
  const service=createStudioService({dbPath:':memory:',prepareTarget,projectPipeline:{}});
  t.after(()=>service.close());
  const dispatch=createCommandRouter({service});
  await git(root,['init','--initial-branch=main']);
  await writeFile(join(root,'not-yet.md'),'Do not commit me');
  await git(root,['add','not-yet.md']);
  const staged=await git(root,['ls-files','--stage']);
  await assert.rejects(dispatch('createStudio',{root,name:'Unborn repository'}),/Выберите целевую ветку/u);
  const created=await dispatch('createStudio',{root,name:'Unborn repository',targetRef:'hearth:managed'});
  assert.equal(created.projectGit.enabled,true);
  assert.equal(await git(root,['ls-tree','-r','--name-only',created.projectGit.targetRef]),'');
  assert.equal(await git(root,['ls-files','--stage']),staged);
  assert.equal(await git(root,['symbolic-ref','HEAD']),'refs/heads/main\n');
  await assert.rejects(git(root,['rev-parse','--verify','HEAD']));
});

test('portable opening and migration connect legacy Git once but respect a deliberate disable',async t=>{
  const parent=await realpath(await mkdtemp(join(tmpdir(),'hearth-default-portable-')));
  let first,second;
  t.after(async()=>{await first?.close();await second?.close();await rm(parent,{recursive:true,force:true});});
  const makeService=profile=>{
    const {prepareTarget}=createGitWorktrees({storageDir:join(parent,'unused'),validateRepository:async()=>true});
    const service=createStudioService({dbPath:join(parent,profile),prepareTarget,projectPipeline:{}});
    const portable=createPortableStudioManager({service,files:createProjectStudioFiles(),validateRoot:async root=>root});
    return {service,portable,dispatch:createCommandRouter({service,portable})};
  };
  const openedRoot=join(parent,'existing-portable');
  const migratedRoot=join(parent,'existing-profile');
  const repo=join(parent,'outer');
  const nested=join(repo,'project');
  await mkdir(openedRoot);await mkdir(migratedRoot);await mkdir(nested,{recursive:true});
  await git(repo,['init','--initial-branch=main']);
  const old=makeService('old.sqlite');
  first=old.service;
  const opened=first.createStudio({root:openedRoot,name:'Portable without Git'});
  await old.portable.create(opened);
  const migrating=first.createStudio({root:migratedRoot,name:'Profile without Git'});
  const migrated=await old.dispatch('migrateStudioFolder',{studioId:migrating.id});
  assert.equal(migrated.projectGit.enabled,true);
  assert.equal(migrated.portable,true);
  await first.configureProject({studioId:migrated.id,enabled:false});
  await old.portable.publish(first.snapshot().studios.find(row=>row.id===migrated.id));
  const nestedStudio=first.createStudio({root:nested,name:'Nested old studio'});
  await old.portable.create(nestedStudio);
  const parentRefs=await git(repo,['show-ref'],{allowExitCodes:[1]});
  await first.close();

  const next=makeService('new.sqlite');
  second=next.service;
  const result=await next.dispatch('openStudioFolder',{root:openedRoot});
  assert.equal(result.projectGit.enabled,true);
  assert.equal(result.manualPaused,true);
  assert.equal(await git(openedRoot,['ls-files']),'');
  const disabled=await next.dispatch('openStudioFolder',{root:migratedRoot});
  assert.deepEqual(disabled.projectGit,{enabled:false});
  const skipped=await next.dispatch('openStudioFolder',{root:nested});
  assert.match(skipped.gitSetupWarning,/корневую папку/iu);
  assert.equal(skipped.projectGit,undefined);
  assert.equal(await git(repo,['show-ref'],{allowExitCodes:[1]}),parentRefs);
  assert.equal((await readdir(nested)).includes('.git'),false);
});
