import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createEvidenceStore } from "../app/evidence.mjs";

const scratch = fileURLToPath(new URL("../.tmp", import.meta.url));

async function fixture(t) {
  await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(join(scratch, "evidence-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "worktree");
  const storageDir = join(directory, "studio");
  await mkdir(root);
  const store = createEvidenceStore({ storageDir });
  const request = {
    studioId: "studio", taskId: "task", attemptId: "attempt",
    revision: { digest: "first" }, sourcePath: "build.zip", kind: "build", root
  };
  return { directory, root, store, storageDir, request };
}

test("copies binary evidence and preserves separate revisions after the working copy is gone", async t => {
  const { root, store, storageDir, request } = await fixture(t);
  const bytes = Buffer.from([0, 255, 128, 2]);
  await writeFile(join(root, request.sourcePath), bytes);
  const first = await store.recordEvidence(request);
  await writeFile(join(root, request.sourcePath), Buffer.from([0, 254]));
  const second = await store.recordEvidence({ ...request, revision: { digest: "second" } });
  await rm(root, { recursive: true });
  assert.notEqual(first.storedRef, second.storedRef);
  assert.notEqual(first.digest, second.digest);
  assert.deepEqual(first.revision, { digest: "first" });
  assert.equal(first.size, bytes.length);
  assert.equal(first.contentType, "application/zip");
  assert.deepEqual(await createEvidenceStore({ storageDir }).readEvidence(first), bytes);
  assert.deepEqual(await readFile(await store.openEvidence(second)), Buffer.from([0, 254]));
});

test("rejects traversal, source and storage symlinks, and byte-identical replacement", async t => {
  const { directory, root, storageDir, store, request } = await fixture(t);
  const outside = join(directory, "outside.zip");
  await writeFile(outside, "same");
  await symlink(outside, join(root, "alias.zip"));
  await symlink(directory, join(root, "alias"), "dir");
  for (const sourcePath of ["../outside.zip", outside, "alias.zip", "alias/outside.zip"]) {
    await assert.rejects(store.recordEvidence({ ...request, sourcePath }));
  }
  await writeFile(join(root, request.sourcePath), "same");
  const record = await store.recordEvidence(request);
  await assert.rejects(store.openEvidence({ ...record, storedRef: "../outside.zip" }));
  const canonical = await store.openEvidence(record);
  await rename(canonical, join(storageDir, "old"));
  await writeFile(canonical, "same");
  await assert.rejects(store.readEvidence(record));
  await rm(canonical);
  await symlink(outside, canonical);
  await assert.rejects(store.openEvidence(record));
});

test("caps evidence before accepting it into studio storage", async t => {
  const { root, storageDir, request } = await fixture(t);
  await writeFile(join(root, request.sourcePath), Buffer.alloc(33));
  const store = createEvidenceStore({ storageDir, maxBytes: 32 });
  await assert.rejects(store.recordEvidence(request), /размер/i);
});

test("restores selected bytes by ID and rolls back only matching imported content", async t => {
  const { directory, root, store, request } = await fixture(t);
  const bytes = Buffer.from([0, 42, 255]);
  await writeFile(join(root, request.sourcePath), bytes);
  const original = await store.recordEvidence(request);
  const destination = createEvidenceStore({ storageDir: join(directory, "imported") });
  const importRequest = { ...original, id: randomUUID(), studioId: "imported" };
  await assert.rejects(destination.importEvidence(importRequest, Buffer.from([3, 42, 255])));
  const restored = await destination.importEvidence(importRequest, bytes);
  assert.equal(restored.id, importRequest.id);
  assert.equal(restored.studioId, "imported");
  assert.deepEqual(await destination.readEvidence(restored), bytes);
  assert.deepEqual(await destination.importEvidence(importRequest, bytes), restored);
  const { id, studioId, size, sourcePath, digest } = importRequest;
  await destination.discardImportedEvidence({ id, studioId, size, sourcePath, digest: "invalid" }).catch(() => {});
  assert.deepEqual(await destination.readEvidence(restored), bytes);
  await destination.discardImportedEvidence({ id, studioId, size, sourcePath, digest });
  await destination.discardImportedEvidence({ id, studioId, size, sourcePath, digest });
  await assert.rejects(destination.readEvidence(restored), { code: "ENOENT" });
  assert.deepEqual(await store.readEvidence(original), bytes);
});
