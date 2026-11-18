import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";

const defaultMaxBytes = 128 * 1024 * 1024;
const contentTypes = {
  ".txt": "text/plain", ".log": "text/plain", ".md": "text/markdown",
  ".json": "application/json", ".csv": "text/csv", ".pdf": "application/pdf",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".mp4": "video/mp4",
  ".webm": "video/webm", ".mov": "video/quicktime", ".mp3": "audio/mpeg",
  ".wav": "audio/wav", ".ogg": "audio/ogg", ".zip": "application/zip",
};
const evidenceId = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const evidenceDigest = /^[0-9a-f]{64}$/;
const digestOf = bytes => createHash("sha256").update(bytes).digest("hex");
const fileIdentity = stat => [stat.dev, stat.ino, stat.birthtimeNs, stat.mtimeNs, stat.size].map(String).join(":");
const fingerprint = stat => `${fileIdentity(stat)}:${stat.ctimeNs}`;

async function checkedDirectory(path) {
  if (!(await lstat(path)).isDirectory() || await realpath(path) !== path) {
    throw new Error("Папка доказательства недоступна или является ссылкой.");
  }
  return path;
}

async function ensureDirectory(path) {
  try {
    return await checkedDirectory(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await ensureDirectory(dirname(path));
  await mkdir(path, { mode: 0o700 }).catch(error => {
    if (error.code !== "EEXIST") throw error;
  });
  return checkedDirectory(path);
}

async function checkedFile(path) {
  const stat = await lstat(path, { bigint: true });
  if (!stat.isFile() || stat.nlink !== 1n || await realpath(path) !== path) {
    throw new Error("Доказательство должно быть обычным файлом без ссылок.");
  }
  return stat;
}

async function readStable(path, maxBytes, expectedIdentity) {
  const initial = await checkedFile(path);
  const identity = fingerprint(initial);
  if (expectedIdentity !== undefined && expectedIdentity !== identity) {
    throw new Error("Файл доказательства был заменён.");
  }
  if (initial.size > maxBytes) throw new Error("Размер доказательства превышает лимит.");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (identity !== fingerprint(await handle.stat({ bigint: true }))) {
      throw new Error("Файл доказательства изменился перед копированием.");
    }
    const bytes = Buffer.alloc(Number(initial.size));
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== bytes.length || identity !== fingerprint(await handle.stat({ bigint: true })) ||
        identity !== fingerprint(await checkedFile(path))) {
      throw new Error("Файл доказательства изменился во время копирования.");
    }
    return { bytes, identity };
  } finally {
    await handle.close();
  }
}

function scopedPath(root, sourcePath) {
  if (typeof sourcePath !== "string" || sourcePath.length > 4096 || /[\\:\u0000-\u001f\u007f]/.test(sourcePath)) {
    throw new Error("Некорректный путь к доказательству.");
  }
  const rawParts = sourcePath.split("/");
  if (isAbsolute(sourcePath)) rawParts.shift();
  const relativePath = isAbsolute(sourcePath) ? relative(root, sourcePath) : sourcePath;
  const valid = part => part && ![".", "..", ".git"].includes(part.toLowerCase());
  if (!rawParts.every(valid) || !relativePath.split("/").every(valid)) {
    throw new Error("Доказательство должно находиться внутри рабочей папки.");
  }
  return { relativePath, path: join(root, relativePath) };
}

function storageInfo(id, sourcePath) {
  if (typeof id !== "string" || !evidenceId.test(id) || typeof sourcePath !== "string") {
    throw new Error("Некорректная запись доказательства.");
  }
  const extension = extname(sourcePath).toLowerCase();
  const contentType = contentTypes[extension] ?? "application/octet-stream";
  return { contentType, storedRef: `${id}${contentType === "application/octet-stream" ? ".bin" : extension}` };
}

function provenance(record) {
  const { studioId, taskId, attemptId, revision, kind } = record;
  if (![studioId, taskId, attemptId, kind].every(value => typeof value === "string" && value.trim()) ||
      !revision || typeof revision !== "object" || Array.isArray(revision) ||
      typeof revision.digest !== "string" || !revision.digest) {
    throw new Error("Доказательству нужны студия, задача, попытка, ревизия и тип.");
  }
  return { studioId, taskId, attemptId, kind, revision: structuredClone(revision) };
}

export function createEvidenceStore({ storageDir, maxBytes = defaultMaxBytes }) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > defaultMaxBytes) {
    throw new Error("Некорректный лимит размера доказательства.");
  }
  const directory = resolve(storageDir);

  async function publishBytes(storedRef, bytes) {
    await ensureDirectory(directory);
    const path = join(directory, storedRef);
    const stagedPath = join(directory, `.${randomUUID()}.tmp`);
    const staged = await open(stagedPath, "wx", 0o400);
    let stagedStat;
    try {
      try {
        await staged.writeFile(bytes);
        await staged.sync();
        stagedStat = await staged.stat({ bigint: true });
      } finally {
        await staged.close();
      }
      if (fingerprint(stagedStat) !== fingerprint(await checkedFile(stagedPath))) {
        throw new Error("Временный файл доказательства был заменён.");
      }
      await link(stagedPath, path);
    } finally {
      await unlink(stagedPath);
    }
    const published = await checkedFile(path);
    if (fileIdentity(published) !== fileIdentity(stagedStat)) {
      throw new Error("Записанный файл доказательства был заменён.");
    }
    return fingerprint(published);
  }

  async function recordEvidence(request) {
    const origin = provenance(request);
    const projectRoot = await checkedDirectory(resolve(request.root));
    const source = scopedPath(projectRoot, request.sourcePath);
    const { bytes } = await readStable(source.path, maxBytes);
    const id = randomUUID();
    const { contentType, storedRef } = storageInfo(id, source.relativePath);
    const identity = await publishBytes(storedRef, bytes);
    return {
      id, ...origin,
      sourcePath: source.relativePath, contentType, size: bytes.length,
      digest: digestOf(bytes), storedRef, identity, recordedAt: new Date().toISOString(),
    };
  }

  function verifyPayload(record) {
    if (!record || typeof record.digest !== "string" || !evidenceDigest.test(record.digest) ||
        !Number.isSafeInteger(record.size) || record.size < 0 || record.size > maxBytes) {
      throw new Error("Некорректная запись доказательства.");
    }
  }

  function matchPayload(record, bytes) {
    if (!Buffer.isBuffer(bytes) || bytes.length !== record.size || digestOf(bytes) !== record.digest) {
      throw new Error("Содержимое доказательства изменилось.");
    }
  }

  async function verifiedEvidence(record, { imported = false } = {}) {
    verifyPayload(record);
    const { storedRef } = storageInfo(record.id, record.sourcePath);
    if (!imported && (record.storedRef !== storedRef || typeof record.identity !== "string")) {
      throw new Error("Некорректная ссылка на доказательство.");
    }
    await checkedDirectory(directory);
    const path = join(directory, storedRef);
    const { bytes, identity } = await readStable(path, maxBytes, imported ? undefined : record.identity);
    matchPayload(record, bytes);
    return { path, bytes, identity };
  }

  async function importEvidence(record, bytes) {
    const origin = provenance(record);
    verifyPayload(record);
    const { relativePath: sourcePath } = scopedPath(directory, record.sourcePath);
    const { id, digest, size, recordedAt } = record;
    const { contentType, storedRef } = storageInfo(id, sourcePath);
    if (!Buffer.isBuffer(bytes) || bytes.length !== size) throw new Error("Некорректный размер доказательства.");
    const copy = Buffer.from(bytes);
    matchPayload(record, copy);
    let identity;
    try {
      identity = await publishBytes(storedRef, copy);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      ({ identity } = await verifiedEvidence({ ...record, sourcePath }, { imported: true }));
    }
    return { id, ...origin, sourcePath, contentType, size, digest, storedRef, identity, recordedAt };
  }

  async function discardImportedEvidence(record) {
    try {
      const { path, identity } = await verifiedEvidence(record, { imported: !record.identity });
      if (fingerprint(await checkedFile(path)) !== identity) throw new Error("Импортированное доказательство было заменено.");
      await unlink(path);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  return {
    recordEvidence,
    readEvidence: async record => (await verifiedEvidence(record)).bytes,
    openEvidence: async record => (await verifiedEvidence(record)).path,
    importEvidence,
    discardImportedEvidence,
  };
}
