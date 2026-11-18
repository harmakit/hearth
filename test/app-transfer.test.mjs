import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createArtifactStore } from "../app/artifacts.mjs";
import { createEvidenceStore } from "../app/evidence.mjs";
import { createTransferController } from "../app/transfer.mjs";
import { createStudioService } from "../core/service.mjs";
import { makeStudioBundle } from "../migration/transfer.mjs";

test("studio notices and chat-only attachments survive import through the service", async t => {
  const options = await fixture(t, []);
  const directory = join(options.root, '..');
  const evidenceStore = createEvidenceStore({ storageDir: join(directory, 'notice-evidence') });
  const service = createStudioService({ dbPath: ':memory:', run: async () => {} });
  t.after(() => service.close());
  const origin = service.createStudio({ name: 'Studio', root: options.root });
  const task = service.createTask({ studioId: origin.id, title: 'Question task', prompt: 'Question task' });
  const bytes = Buffer.from([221, 0, 128]);
  const attemptId = 'da2c2686-e772-42b1-af27-f46adccba264';
  await writeFile(join(options.root, 'chat.zip'), bytes);
  const attachment = service.recordEvidence(await evidenceStore.recordEvidence({ studioId: origin.id, taskId: origin.id,
    attemptId, revision: { digest: attemptId }, root: options.root, sourcePath: 'chat.zip', kind: 'attachment' }));
  service.postStudioMessage({ studioId: origin.id, kind: 'note', text: 'Owner note', attachmentIds: [attachment.id], operationId: 'note-op' });
  const owned = value => ({ studioId: origin.id, ...value });
  const state = { ...service.snapshot(),
    meetings: [owned({ id: 'meeting', stage: 'resolved', title: 'Meeting', version: 2 })],
    rosterProposals: [owned({ id: 'role', status: 'approved', version: 2 })],
    inbox: [owned({ id: 'meeting-notice', kind: 'meeting', status: 'resolved', meetingId: 'meeting', version: 2 }),
      owned({ id: 'roster-notice', kind: 'roster', status: 'open', proposalId: 'role' }),
      owned({ id: 'reconcile-notice', kind: 'reconcile', status: 'open', attemptId }),
      owned({ id: 'question', taskId: task.id, kind: 'question', status: 'resolved', version: 3, answerVersion: 3,
        choices: [{ id: 'accept', label: 'Accept', decision: 'approve' }], choiceId: 'accept', answerDecision: 'approve',
        attachmentIds: [attachment.id], answerAttachmentIds: [attachment.id], answer: 'Accept' })],
  };
  const bundlePath = join(directory, 'notices.json');
  const controller = createTransferController({ ...options, service, evidenceStore, pickBundle: async () => bundlePath, saveBundle: async () => bundlePath });
  await controller.exportStudio(state, { studioId: origin.id, mode: 'snapshot', evidenceIds: [attachment.id] });
  const imported = await controller.importBundle({ root: options.root });
  const result = service.snapshot();
  const find = (table, filter = () => true) => result[table].find(row => row.studioId === imported.id && filter(row));
  const notice = kind => find('inbox', row => row.kind === kind);
  const restored = find('evidence');
  assert.deepEqual(await evidenceStore.readEvidence(restored), bytes);
  assert.equal(restored.taskId, imported.id);
  assert.deepEqual(find('conversationMessages').attachmentIds, [restored.id]);
  assert.equal(notice('meeting').meetingId, find('meetings').id);
  assert.equal(notice('roster').proposalId, find('rosterProposals').id);
  assert.equal(notice('roster').status, 'resolved');
  assert.equal(notice('reconcile').status, 'resolved');
  assert.equal(notice('reconcile').attemptId, undefined);
  const question = notice('question');
  assert.equal(question.version, 3);
  assert.equal(question.answerVersion, 3);
  assert.equal(question.choiceId, 'accept');
  assert.equal(question.choices[0].decision, 'approve');
  assert.equal(question.answerDecision, 'approve');
  assert.deepEqual(question.attachmentIds, [restored.id]);
  assert.deepEqual(question.answerAttachmentIds, [restored.id]);
});

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

for (const outcome of ["uncommitted", "committed", "deleted"]) {
  test(`startup recovery handles a ${outcome} studio after interrupted import cleanup`, async t => {
    const committed = outcome !== "uncommitted";
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
      snapshot: () => ({ studios: outcome === "committed" ? [imported] : [] }),
      wasStudioDeleted: id => outcome === "deleted" && id === imported?.id,
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

test("selected binary evidence commits with fresh links and is removed if studio import fails", async t => {
  const options = await fixture(t, []);
  const directory = join(options.root, '..');
  const evidenceStore = createEvidenceStore({ storageDir: join(directory, 'evidence') });
  const bytes = Buffer.from([0, 255, 128, 7]);
  const task = { id: 'task', studioId: 'source', title: 'Test build' };
  await writeFile(join(options.root, 'build.zip'), bytes);
  const record = await evidenceStore.recordEvidence({ studioId: 'source', taskId: task.id, attemptId: 'attempt',
    revision: { digest: 'a'.repeat(64) }, root: options.root, sourcePath: 'build.zip', kind: 'build' });
  const state = { studios: [{ id: 'source', root: options.root, name: 'Studio' }], tasks: [task], evidence: [record] };
  let imported;
  let fail = true;
  const service = { snapshot: () => state, importStudio(payload) {
    imported = payload;
    if (fail) throw new Error('DB write failed');
    return payload.studio;
  } };
  const bundlePath = join(directory, 'evidence.json');
  const controller = createTransferController({ ...options, service, evidenceStore,
    pickBundle: async () => bundlePath, saveBundle: async () => bundlePath });
  await controller.exportStudio(state, { studioId: 'source', mode: 'snapshot', evidenceIds: [record.id] });
  await assert.rejects(controller.importBundle({ root: options.root }), /DB write failed/);
  assert.equal(imported.evidence.length, 1);
  await assert.rejects(evidenceStore.readEvidence(imported.evidence[0]));
  assert.deepEqual(await readdir(options.journalDir), []);
  fail = false;
  await controller.importBundle({ root: options.root });
  assert.deepEqual(await evidenceStore.readEvidence(imported.evidence[0]), bytes);
  assert.equal(imported.evidence[0].taskId, imported.tasks[0].id);
  assert.deepEqual(await evidenceStore.readEvidence(record), bytes);
});
