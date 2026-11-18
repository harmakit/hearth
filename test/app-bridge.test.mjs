import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createCommandRouter } from "../app/bridge.mjs";

const temp = fileURLToPath(new URL("../.tmp", import.meta.url));

function router(service, options = {}) {
  return createCommandRouter({ service, ...options });
}

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

test("checks canonical project roots before studio writes and still allows inspection", async (t) => {
  await mkdir(temp, { recursive: true });
  const root = await mkdtemp(join(temp, "bridge-"));
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
