import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createArtifactStore } from "../app/artifacts.mjs";

const scratch = fileURLToPath(new URL("../.tmp", import.meta.url));

async function fixture(t) {
  await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(join(scratch, "artifacts-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "workspace");
  const other = join(directory, "other");
  const receipts = join(directory, "receipts");
  await Promise.all([mkdir(root), mkdir(other)]);
  return { root, other, store: createArtifactStore({ receipts, validateRoot: async value => value }), receipts };
}

test("writes a scoped text artifact and reuses only the same completed operation", async t => {
  const { root, store, receipts } = await fixture(t);
  const request = { root, path: "result/draft.md", content: "# Story\n", operationId: "a:1" };
  assert.deepEqual(await store.write(request), { path: "result/draft.md" });
  assert.equal(await readFile(join(root, "result", "draft.md"), "utf8"), request.content);
  assert.deepEqual(await createArtifactStore({ receipts, validateRoot: async value => value }).write(request), { path: request.path });
  await assert.rejects(store.write({ ...request, operationId: "a:2" }), /уже существует/i);
  await assert.rejects(store.write({ ...request, content: "modified" }), /операц/i);
  assert.equal(await store.openable(root, request.path), join(root, "result", "draft.md"));
});

test("preserves existing files and rejects escape and symlinks", async t => {
  const { root, other, store } = await fixture(t);
  await writeFile(join(root, "keep.md"), "already here");
  await symlink(other, join(root, "alias"), "dir");
  for (const path of ["../other/bad.md", "alias/bad.md", "keep.md", ".git/info.md", "tool.command"]) {
    await assert.rejects(store.write({ root, path, content: "new", operationId: path }));
  }
  await assert.rejects(store.openable(root, "alias/bad.md"));
  assert.equal(await readFile(join(root, "keep.md"), "utf8"), "already here");
  await assert.rejects(readFile(join(other, "bad.md")), { code: "ENOENT" });
});

test("checks current contents before replay and supports disposal of a failed transfer", async t => {
  const { root, store } = await fixture(t);
  const request = { root, path: "a.md", content: "tracked", operationId: "publish-a" };
  const second = { root, path: "b.md", content: "untouched", operationId: "publish-b" };
  await store.write(request);
  await store.write(second);
  await writeFile(join(root, "a.md"), "user edit");
  await assert.rejects(store.write(request), /измен|существует/i);
  await store.discard(request);
  assert.equal(await readFile(join(root, "a.md"), "utf8"), "user edit");
  await store.discard(second);
  await assert.rejects(readFile(join(root, "b.md")), { code: "ENOENT" });
});

test("a replacement with identical bytes is neither replayed nor discarded", async t => {
  const { root, store } = await fixture(t);
  const request = { root, path: "a.md", content: "same bytes", operationId: "replace-a" };
  await store.write(request);
  await writeFile(join(root, "replacement.md"), request.content);
  await rename(join(root, "replacement.md"), join(root, request.path));
  const replay = store.write(request);
  await assert.rejects(replay, /измен|существует/i);
  await store.discard(request);
  assert.equal(await readFile(join(root, request.path), "utf8"), request.content);
});

test("disposal preserves files that predate identity tracking", async t => {
  const { root, receipts, store } = await fixture(t);
  const request = { root, path: "legacy.md", content: "legacy bytes", operationId: "legacy" };
  const digest = value => createHash("sha256").update(value).digest("hex");
  await mkdir(receipts);
  await writeFile(join(receipts, digest(request.operationId) + ".json"), JSON.stringify({
    root, path: request.path, digest: digest(request.content),
  }));
  await writeFile(join(root, request.path), request.content);
  await store.discard(request);
  assert.equal(await readFile(join(root, request.path), "utf8"), request.content);
});
