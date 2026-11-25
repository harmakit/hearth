import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createCommandRouter } from "../app/bridge.mjs";
import { createGitWorktrees, git } from "../app/git-worktrees.mjs";
import { createStudioService } from "../core/service.mjs";
import * as gitReport from "../app/git-worktrees.mjs";

const temp = fileURLToPath(new URL("../.tmp", import.meta.url));

test("initializes Git in the stored studio folder without staging existing files", async t => {
  // This fixture represents a standalone project. The checkout's .tmp is itself inside Git.
  const fixture=await mkdtemp(join(await realpath(tmpdir()),"bridge-local-git-"));
  const project=join(fixture,"existing studio");
  await mkdir(project);
  const trees=createGitWorktrees({storageDir:join(fixture,"trees"),validateRepository:root=>root===project});
  const service=createStudioService({dbPath:":memory:",prepareTarget:trees.prepareTarget,projectPipeline:{}});
  t.after(async()=>{await service.close();await rm(fixture,{recursive:true,force:true});});
  const studio=service.createStudio({name:"Local project",root:project});
  await writeFile(join(project,"draft.md"),"Owner draft\n");
  const dispatch=router(service);
  assert.deepEqual(await dispatch("inspectProjectRepository",{studioId:studio.id}),{state:"missing",root:project});
  await assert.rejects(dispatch("initializeProjectRepository",{studioId:studio.id,root:fixture}),/папка/i);
  const connected=await dispatch("initializeProjectRepository",{studioId:studio.id,root:project});
  assert.equal(connected.projectGit.enabled,true);
  assert.equal(await git(project,["ls-files"]), "");
  assert.equal(await readFile(join(project,"draft.md"),"utf8"),"Owner draft\n");
  const latest=await git(project,["rev-parse","HEAD"]);
  assert.equal(await git(project,["rev-parse",connected.projectGit.targetRef]),latest);
  await assert.rejects(dispatch("initializeProjectRepository",{studioId:studio.id,root:project}),/репозиторий/i);
  const nested=join(project,"notes");
  await mkdir(nested);
  const another=service.createStudio({name:"Nested project",root:nested});
  assert.equal((await dispatch("inspectProjectRepository",{studioId:another.id})).state,"nested");
  await assert.rejects(dispatch("initializeProjectRepository",{studioId:another.id,root:nested}),/репозиторий/i);
});

function router(service, options = {}) {
  return createCommandRouter({ service, ...options });
}

test('conversation context and history commands are available only for the selected studio',async t=>{
  const service=createStudioService({dbPath:':memory:'});
  t.after(()=>service.close());
  const studio=service.createStudio({root:temp,name:'Conversation QA'});
  const task=service.createTask({studioId:studio.id,title:'History',prompt:'Review'});
  const message=service.postStudioMessage({studioId:studio.id,taskId:task.id,kind:'comment',text:'Saved history'});
  const dispatch=router(service);
  const input={studioId:studio.id,conversationId:message.conversationId};
  const view=await dispatch('conversationView',input);
  assert.deepEqual(view.context.map(row=>row.id),[message.id]);
  const page=await dispatch('conversationPage',input);
  assert.deepEqual(page.rows.map(row=>row.id),[message.id]);
  await assert.rejects(dispatch('conversationView',{...input,studioId:'unrelated'}),/студии/iu);
});

test("routes explicit service commands and hides lifecycle internals", async () => {
  let closed = false;
  const dispatch = router({
    snapshot: () => ({ studios: [] }),
    close: () => { closed = true; },
    startTask: ({ taskId }) => taskId,
  });
  assert.deepEqual(await dispatch("snapshot"), { studios: [] });
  assert.equal(await dispatch("startTask", { taskId: "t1" }), "t1");
  for (const command of ["close", "__proto__", "constructor"]) {
    await assert.rejects(dispatch(command), /команда/i);
  }
  assert.equal(closed, false);
});

test('report links can open a web URL or a safe path in the resolved studio', async () => {
  const calls = [];
  const dispatch = router({ snapshot: () => ({ studios: [{ id: 'live', root: temp }] }) }, {
    openExternal: url => calls.push(url),
    openArtifact: file => calls.push(file),
  });
  await dispatch('openReportLink', { destination: 'https://example.org/a?b=2' });
  await dispatch('openReportLink', { studioId: 'live', destination: './docs/family%20tree.md#chapter' });
  assert.deepEqual(calls, ['https://example.org/a?b=2', { root: temp, path: 'docs/family tree.md' }]);
  for (const destination of ['javascript:alert(1)', 'file:///tmp/record.md', '%2e%2e/record.md', '.hearth/state/a.txt', '//example.org/a.md', 'https://hidden@example.org/a']) {
    await assert.rejects(dispatch('openReportLink', { studioId: 'live', destination }), /ссылк/iu);
  }
  await assert.rejects(dispatch('openReportLink', { studioId: 'other', destination: 'family.md' }), /студи/iu);
  assert.equal(calls.length, 2);
});

test('a Git report resolves the reviewed blob even when the checkout has a newer file', async t => {
  const root=await mkdtemp(join(await realpath(tmpdir()),'hearth-report-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await git(root,['init','--initial-branch=main']);
  await writeFile(join(root,'family notes.md'),'Reviewed text\n');
  await symlink('family notes.md',join(root,'alias.md'));
  await git(root,['add','--','family notes.md','alias.md']);
  await git(root,['-c','user.name=QA','-c','user.email=qa@hearth.invalid','commit','-qm','Reviewed']);
  const revision=(await git(root,['rev-parse','HEAD'])).trim();
  await writeFile(join(root,'family notes.md'),'New work in progress\n');
  const file=await gitReport.readGitReportFile({repository:root,revision,path:'family notes.md'});
  assert.equal(file.bytes.toString(),'Reviewed text\n');
  assert.equal(await gitReport.readGitReportFile({repository:root,revision,path:'alias.md'}),null);
  await assert.rejects(gitReport.readGitReportFile({repository:root,revision,path:'../family notes.md'}),/файл/iu);
});

test("checks canonical project roots before studio writes and still allows inspection", async (t) => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "bridge-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const blocked = join(root, "protected");
  const same = join(root, "symlink");
  const project = join(root, "new-project");
  await mkdir(blocked);
  await mkdir(project);
  await symlink(blocked, same);
  const calls = [];
  const dispatch = router(
    { createStudio(input) { calls.push(input); return input; } },
    { protectedRoots: [blocked], previewImport: ({ root }) => ({ root, valid: true }) }
  );
  await assert.rejects(dispatch("createStudio", { root: same }), /папк/i);
  await assert.rejects(dispatch("createStudio", { root }), /папк/i);
  await assert.rejects(dispatch("createStudio", { root: "relative" }), /папк/i);
  assert.equal((await dispatch("createStudio", { root: project })).root, project);
  assert.equal(calls.length, 1);
  assert.deepEqual(await dispatch("previewImport", { root: same }), { root: blocked, valid: true });
});

test("only exposes supported runtime availability probes", async () => {
  const dispatch = router({}, { inspect: ({ runtime }) => ({ runtime }) });
  assert.deepEqual(await dispatch("inspect", { runtime: "claude" }), { runtime: "claude" });
  await assert.rejects(dispatch("inspect", { runtime: "arbitrary-binary" }), /подключени/i);
  await assert.rejects(dispatch("inspect", []), /данны/i);
});

test("copies only the stored task ID from the selected studio through the native clipboard", async () => {
  const copied = [];
  const dispatch = router({
    snapshot: () => ({studios: [{id:"a"}, {id:"b"}], tasks: [{id:"full-id-123", studioId:"a"}]}),
  }, {copyTaskId:id=>copied.push(id)});
  await assert.rejects(dispatch("copyTaskId",{studioId:"b",taskId:"full-id-123"}),/задач/i);
  await assert.rejects(dispatch("copyTaskId",{studioId:"a",taskId:"missing"}),/задач/i);
  assert.equal(await dispatch("copyTaskId",{studioId:"a",taskId:"full-id-123",text:"ignored"}),true);
  assert.deepEqual(copied,["full-id-123"]);
});

test("routes approved workflow commands and only opens a studio's recorded artifact", async (t) => {
  await mkdir(temp, { recursive: true });
  const root = await mkdtemp(join(temp, "bridge-workflow-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dispatch = router({
    initializeStudio: input => input.studioId,
    decidePlan: ({ planId }) => planId,
    setStudioRunning: ({ action }) => action,
    snapshot: () => ({ studios: [{ id: "s1", root }], tasks: [{ id: "t1", studioId: "s1", artifactPath: "files/a.md" }] }),
  }, { openArtifact: input => input });
  assert.equal(await dispatch("initializeStudio", { studioId: "s1" }), "s1");
  assert.equal(await dispatch("decidePlan", { planId: "p1", decision: "approve" }), "p1");
  assert.equal(await dispatch("setStudioRunning", { studioId: "s1", action: "resume" }), "resume");
  assert.deepEqual(await dispatch("openArtifact", { taskId: "t1", path: "/etc/passwd" }), { root, path: "files/a.md" });
  await assert.rejects(dispatch("openArtifact", { taskId: "unknown" }), /артефакт/i);
});

test("opens only a studio's saved project folder and delegates confirmed deletion", async (t) => {
  await mkdir(temp, { recursive: true });
  const root = await mkdtemp(join(temp, "bridge-project-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dispatch = router({
    snapshot: () => ({ studios: [{ id: "s1", root }], tasks: [] }),
    deleteStudio: input => input,
  }, { openProject: input => input });
  assert.equal(await dispatch("openProject", { studioId: "s1", root: "/" }), root);
  await assert.rejects(dispatch("openProject", { studioId: "wrong", root }), /студия/i);
  assert.deepEqual(await dispatch("deleteStudio", { studioId: "s1", confirmation: "Тест" }), { studioId: "s1", confirmation: "Тест" });
});

test("routes model policy and pending-team edits without granting arbitrary service access", async () => {
  const updateModelPolicy = input => input.allowed;
  const updatePlanAgents = input => input;
  const dispatch = router({ updateModelPolicy, updatePlanAgents });
  const allowed = [{ runtime: "codex", model: "fixture-fast", efforts: ["low"] }];
  const edit = { planId: "p1", agents: [{ key: "writer", roleTitle: "Автор" }] };
  assert.deepEqual(await dispatch("updateModelPolicy", { allowed }), allowed);
  assert.deepEqual(await dispatch("updatePlanAgents", edit), edit);
  await assert.rejects(dispatch("setModelPolicyUnsafe", { allowed }), /команда/i);
});

test("owner skill previews use the studio threshold and return metadata only", async () => {
  const calls = [];
  const dispatch = router({ snapshot: () => ({ studios: [{ id: "s1", skillMinStars: 10000 }] }) }, {
    findSkills(input) {
      calls.push(input);
      return { candidates: [{ id: "skill", repo: "example/agent-skills", title: "Skill", stars: 12345,
        content: "# Source Markdown", authorization: "excluded" }], warnings: [] };
    },
  });
  const result = await dispatch("searchSkillRepositories", { studioId: "s1", topics: ["react"], minStars: 0 });
  assert.deepEqual(calls, [{ topics: ["react"], minStars: 10000 }]);
  assert.equal(result.candidates[0].repo, "example/agent-skills");
  assert.equal(Object.hasOwn(result.candidates[0], "content"), false);
  assert.equal(Object.hasOwn(result.candidates[0], "authorization"), false);
  await assert.rejects(dispatch("searchSkillRepositories", { studioId: "s2", topics: ["react"] }), /студия/i);
});
