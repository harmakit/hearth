import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeStudioBundle, maxEvidenceBytes, prepareBundleImport, prepareLegacyImport } from "../migration/transfer.mjs";

const bundleLimit = 32 * 1024 * 1024;
const journalEntry = /^([\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})\.(json|pending)$/;

async function readBundle(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > bundleLimit) throw new Error("Файл студии должен быть JSON размером до 32 МБ.");
    const buffer = Buffer.allocUnsafe(stat.size + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > stat.size) throw new Error("Файл студии изменился во время чтения. Повтори импорт.");
    try { return JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")); }
    catch { throw new Error("Файл студии содержит некорректный JSON."); }
  } finally {
    await handle.close();
  }
}

function operationFor(journal, artifact) {
  return { ...artifact, root: journal.root, operationId: journal.importId + ":" + artifact.path };
}

async function removeJournal(path) {
  await unlink(path).catch(error => {
    if (error.code !== "ENOENT") throw error;
  });
}

export function createTransferController({ service, artifacts, evidenceStore, pickBundle, saveBundle, journalDir }) {
  async function clearImport(path, journal) {
    const committed = service.wasStudioDeleted?.(journal.studioId) ||
      service.snapshot().studios.some(studio => studio.id === journal.studioId);
    if (!committed) {
      const results = await Promise.allSettled([
        ...journal.artifacts.map(artifact => artifacts.discard(operationFor(journal, artifact))),
        ...(journal.evidence ?? []).map(async entry => evidenceStore.discardImportedEvidence(entry)),
      ]);
      const failure = results.find(result => result.status === "rejected");
      if (failure) throw failure.reason;
    }
    await removeJournal(path);
  }

  async function recover() {
    const entries = await readdir(journalDir).catch(error => {
      if (error.code !== "ENOENT") throw error;
      return [];
    });
    const results = await Promise.allSettled(entries.filter(name => journalEntry.test(name)).map(async name => {
      const path = join(journalDir, name);
      const [, importId, extension] = name.match(journalEntry);
      if (extension === "pending") return removeJournal(path);
      const journal = await readBundle(path);
      if (journal?.importId !== importId || typeof journal.studioId !== "string" || typeof journal.root !== "string" ||
          !Array.isArray(journal.artifacts) || journal.artifacts.some(artifact => typeof artifact?.path !== "string" ||
          typeof artifact.digest !== "string" || !/^[\da-f]{64}$/.test(artifact.digest))) {
        throw new Error("Журнал импорта студии повреждён.");
      }
      if (journal.evidence !== undefined && (!Array.isArray(journal.evidence) || journal.evidence.some(entry =>
        entry?.studioId !== journal.studioId || typeof entry.id !== "string" || typeof entry.sourcePath !== "string" ||
        !Number.isSafeInteger(entry.size) || entry.size < 0 || typeof entry.digest !== "string" || !/^[\da-f]{64}$/.test(entry.digest)))) {
        throw new Error("Журнал импорта доказательств повреждён.");
      }
      await clearImport(path, journal);
    }));
    return results.filter(result => result.status === "rejected").map(result => result.reason);
  }

  async function apply(payload) {
    const files = payload.artifacts ?? [];
    const evidence = payload.evidence ?? [];
    const result = studio => ({ ...studio, warnings: payload.warnings ?? [], artifactCount: files.length,
      ...(evidence.length && { evidenceCount: evidence.length }) });
    if (!files.length && !evidence.length) return result(await service.importStudio(payload));
    if (evidence.length && (!evidenceStore?.importEvidence || !evidenceStore?.discardImportedEvidence)) {
      throw new Error("Хранилище доказательств недоступно для импорта.");
    }

    const journal = {
      importId: randomUUID(),
      studioId: payload.studio.id,
      root: payload.studio.root,
      artifacts: files.map(({ path, content }) => ({ path, digest: createHash("sha256").update(content).digest("hex") })),
      evidence: evidence.map(({ id, studioId, sourcePath, size, digest }) => ({ id, studioId, sourcePath, size, digest })),
    };
    await mkdir(journalDir, { recursive: true, mode: 0o700 });
    const path = join(journalDir, journal.importId + ".json");
    const pending = join(journalDir, journal.importId + ".pending");
    try {
      await writeFile(pending, JSON.stringify(journal), { flag: "wx", mode: 0o600, flush: true });
      await rename(pending, path);
    } finally {
      await removeJournal(pending);
    }

    let studio;
    try {
      for (const artifact of files) await artifacts.write(operationFor(journal, artifact));
      const restoredEvidence = [];
      for (const { content, ...record } of evidence) {
        restoredEvidence.push(await evidenceStore.importEvidence(record, Buffer.from(content, "base64")));
      }
      studio = await service.importStudio({ ...payload, evidence: restoredEvidence });
    } catch (error) {
      await clearImport(path, journal).catch(() => {});
      throw error;
    }
    await removeJournal(path).catch(() => {});
    return result(studio);
  }

  async function exportStudio(snapshot, { studioId, mode, includeArtifacts = false, artifactPaths, evidenceIds }) {
    const studio = snapshot.studios.find(entry => entry.id === studioId);
    if (!studio) throw new Error("Студия не найдена.");
    const selectedFiles = [];
    if (mode === "snapshot" && (includeArtifacts || Array.isArray(artifactPaths))) {
      const candidates = snapshot.tasks.filter(task => task.studioId === studioId && task.artifactPath).map(task => task.artifactPath);
      for (const plan of snapshot.plans ?? []) {
        if (plan.studioId !== studioId) continue;
        for (const file of plan.publishedFiles ?? []) candidates.push(typeof file === "string" ? file : file.path);
      }
      const paths = new Set(candidates.filter(path => path && (!Array.isArray(artifactPaths) || artifactPaths.includes(path))));
      let total = 0;
      for (const path of paths) {
        const content = await artifacts.read(studio.root, path);
        total += Buffer.byteLength(content);
        if (total > bundleLimit / 2) throw new Error("Артефакты превышают лимит снимка в 16 МБ.");
        selectedFiles.push({ path, content });
      }
    }
    const evidenceFiles = [];
    if (mode === "snapshot" && evidenceIds !== undefined) {
      if (!Array.isArray(evidenceIds) || evidenceIds.length > 50 || new Set(evidenceIds).size !== evidenceIds.length) {
        throw new Error("Выберите до 50 отдельных доказательств.");
      }
      const available = new Map((snapshot.evidence ?? []).filter(record => record.studioId === studioId).map(record => [record.id, record]));
      let total = 0;
      for (const id of evidenceIds) {
        const record = available.get(id);
        if (!record || !evidenceStore?.readEvidence) throw new Error("Выбранное доказательство недоступно для экспорта.");
        total += record.size;
        if (total > maxEvidenceBytes) throw new Error("Превышен допустимый размер выбранных доказательств.");
        evidenceFiles.push({ id, bytes: await evidenceStore.readEvidence(record) });
      }
    }
    const bundle = makeStudioBundle(snapshot, { studioId, mode, artifacts: selectedFiles, evidenceFiles });
    const encoded = JSON.stringify(bundle, null, 2);
    if (Buffer.byteLength(encoded) > bundleLimit) throw new Error("Размер снимка превышает 32 МБ.");
    const path = await saveBundle(studio.name, mode);
    if (!path) return null;
    await writeFile(path, encoded, { flag: "wx", mode: 0o600 });
    return { path, mode, artifactCount: selectedFiles.length, ...(evidenceFiles.length && { evidenceCount: evidenceFiles.length }) };
  }

  async function importBundle(input) {
    const path = await pickBundle();
    return path ? apply(prepareBundleImport(await readBundle(path), input)) : null;
  }

  async function importLegacy(input) {
    return apply(await prepareLegacyImport(input));
  }

  return { exportStudio, importBundle, importLegacy, recover };
}
