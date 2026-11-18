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
