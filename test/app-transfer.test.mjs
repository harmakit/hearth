import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createArtifactStore } from "../app/artifacts.mjs";
import { createTransferController } from "../app/transfer.mjs";
import { makeStudioBundle } from "../migration/transfer.mjs";

const scratch = fileURLToPath(new URL("../.tmp", import.meta.url));

async function fixture(t, files) {
  await mkdir(scratch, { recursive: true });
  const profile = await mkdtemp(join(scratch, "import-"));
  t.after(() => rm(profile, { recursive: true, force: true }));
  const root = join(profile, "project");
  const journalDir = join(profile, "journal");
  const bundlePath = join(profile, "studio.json");
  const artifacts = createArtifactStore({ receipts: join(profile, "receipts"), validateRoot: async value => value });
  await mkdir(root);
  const studio = { id: "source", name: "Studio", root: "/source", agents: [] };
  const bundle = makeStudioBundle({ studios: [studio], tasks: [], inbox: [] }, {
    studioId: studio.id,
    mode: "snapshot",
    artifacts: files,
  });
  await writeFile(bundlePath, JSON.stringify(bundle));
  return { root, artifacts, journalDir, pickBundle: async () => bundlePath };
}

for (const committed of [false, true]) {
  test(`startup recovery ${committed ? "keeps committed" : "rolls back uncommitted"} imports`, async t => {
    const options = await fixture(t, [{ path: "artifact.md", content: "imported text" }]);
    const { root, journalDir, artifacts } = options;
    let imported;
    let interrupt;
    const paused = new Promise(resolve => { interrupt = resolve; });
    function crash() {
      interrupt();
      return new Promise(() => {});
    }
    const service = {
      async importStudio(payload) {
        imported = payload.studio;
        return crash();
      },
      snapshot: () => ({ studios: committed ? [imported] : [] }),
    };
    const interruptedArtifacts = committed ? artifacts : {
      ...artifacts,
      async write(operation) {
        await artifacts.write(operation);
        return crash();
      },
    };
    createTransferController({ ...options, service, artifacts: interruptedArtifacts }).importBundle({ root }).catch(interrupt);
    const before = await paused;
    assert.equal(before, undefined);
    assert.equal(await readFile(join(root, "artifact.md"), "utf8"), "imported text");
    assert.equal((await readdir(journalDir)).length, 1);

    assert.deepEqual(await createTransferController({ ...options, service }).recover(), []);
    assert.deepEqual(await readdir(journalDir), []);
    if (committed) assert.equal(await readFile(join(root, "artifact.md"), "utf8"), "imported text");
    else await assert.rejects(readFile(join(root, "artifact.md")), { code: "ENOENT" });
  });
}

test("a collision preserves ambient files and a fresh import can proceed after it is resolved", async t => {
  const options = await fixture(t, [
    { path: "first.md", content: "published before collision" },
    { path: "collision.md", content: "same bytes" },
  ]);
  const { root, journalDir } = options;
  const studioFile = join(root, "collision.md");
  await writeFile(studioFile, "same bytes");
  const studioIds = [];
  const service = {
    importStudio({ studio }) { studioIds.push(studio); return studio; },
    snapshot: () => ({ studios: studioIds }),
  };
  const controller = createTransferController({ ...options, service });
  await assert.rejects(controller.importBundle({ root }), /уже существует/i);
  assert.equal(studioIds.length, 0);
  assert.deepEqual(await readdir(journalDir), []);
  assert.equal(await readFile(studioFile, "utf8"), "same bytes");
  await assert.rejects(readFile(join(root, "first.md")), { code: "ENOENT" });

  await rm(studioFile);
  assert.equal((await controller.importBundle({ root })).artifactCount, 2);
  assert.equal(studioIds.length, 1);
  assert.deepEqual(await readdir(journalDir), []);
});
