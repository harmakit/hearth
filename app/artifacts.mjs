import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, realpath, unlink } from "node:fs/promises";
import { dirname, extname, join } from "node:path";

const maxBytes = 1024 * 1024;
const textFormats = new Set([".md", ".txt", ".json", ".csv", ".rst", ".yaml", ".yml", ".toml"]);
const hash = data => createHash("sha256").update(data).digest("hex");

function partsFor(path) {
  if (typeof path !== "string" || path.length > 480 || /[\\:\u0000-\u001f\u007f]/.test(path)) {
    throw new Error("Артефакту нужен относительный путь в папке проекта.");
  }
  const parts = path.split("/");
  if (parts.some(part => !part || part.startsWith(".") || part.trim() !== part) || !textFormats.has(extname(path).toLowerCase())) {
    throw new Error("Разрешены текстовые артефакты в обычных папках проекта.");
  }
  return parts;
}

async function metadata(path) {
  try { return await lstat(path); } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return null;
  }
}

async function fileInProject(project, path, createDirectories, allowMissing = false) {
  const parts = partsFor(path);
  let directory = project;
  for (const part of parts.slice(0, -1)) {
    directory = join(directory, part);
    if (!await metadata(directory) && createDirectories) {
      await mkdir(directory).catch(error => {
        if (error.code !== "EEXIST") throw error;
      });
    }
    const entry = await metadata(directory);
    if (allowMissing && !entry) return null;
    if (!entry?.isDirectory() || await realpath(directory) !== directory) {
      throw new Error("Папка артефакта недоступна или является ссылкой.");
    }
  }
  return join(directory, parts.at(-1));
}

function sameFile(stat, identity) {
  return stat?.isFile() && identity && stat.dev.toString() === identity.device &&
    stat.ino.toString() === identity.inode && stat.birthtimeNs.toString() === identity.birthtime;
}

async function readText(path, identity) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat({ bigint: true });
    if (identity && !sameFile(stat, identity)) return null;
    if (!stat.isFile() || stat.size > maxBytes) {
      if (identity) return null;
      throw new Error("Артефакт недоступен или превышает 1 МБ.");
    }
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maxBytes) {
      if (identity) return null;
      throw new Error("Артефакт превышает 1 МБ.");
    }
    return buffer.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}

async function unlinkIfPresent(path) {
  await unlink(path).catch(error => {
    if (error.code !== "ENOENT") throw error;
  });
}

async function stageFile(temp, data) {
  const file = await open(temp, "wx", 0o600);
  try {
    try {
      await file.writeFile(data);
      await file.sync();
      return await file.stat({ bigint: true });
    } finally {
      await file.close();
    }
  } catch (error) {
    await unlinkIfPresent(temp);
    throw error;
  }
}

async function createReceipt(path, record) {
  const temp = join(dirname(path), ".hearth-write-" + randomUUID());
  await stageFile(temp, JSON.stringify(record));
  try {
    await link(temp, path);
  } finally {
    await unlinkIfPresent(temp).catch(() => {});
  }
}

async function getReceipt(path) {
  if (!await metadata(path)) return null;
  return JSON.parse((await readText(path)).toString("utf8"));
}

function matches(left, right) {
  return left.root === right.root && left.path === right.path && left.digest === right.digest;
}

function stagedPath(file, receipt) {
  return /^\.hearth-write-[\da-f-]{36}$/.test(receipt.stage) ? join(dirname(file), receipt.stage) : null;
}

async function ownsFile(path, receipt, checkDigest = true) {
  if (!receipt.identity) return false;
  try {
    if (checkDigest) {
      const data = await readText(path, receipt.identity);
      if (!data || hash(data) !== receipt.digest) return false;
    }
    return sameFile(await lstat(path, { bigint: true }), receipt.identity);
  } catch (error) {
    if (["ENOENT", "ELOOP", "ENOTDIR"].includes(error.code)) return false;
    throw error;
  }
}

export function createArtifactStore({ receipts, validateRoot, portable = false }) {
  function receiptKey(operationId) {
    if (typeof operationId !== "string" || !operationId.trim() || operationId.length > 600) {
      throw new Error("Некорректная операция записи артефакта.");
    }
    return join(receipts, hash(operationId) + ".json");
  }

  async function write({ root, path, content, operationId }) {
    if (typeof content !== "string" || Buffer.byteLength(content) > maxBytes) {
      throw new Error("Некорректная операция записи артефакта.");
    }
    const recordFile = receiptKey(operationId);
    const project = await validateRoot(root);
    const file = await fileInProject(project, path, true);
    const record = { root: portable ? "." : project, path, digest: hash(content) };
    await mkdir(receipts, { recursive: true, mode: 0o700 });
    if(await realpath(receipts)!==receipts)throw new Error("Папка квитанций артефактов недоступна.");
    let previous = await getReceipt(recordFile);
    if (!previous) {
      if (await metadata(file)) throw new Error(`Файл «${record.path}» уже существует.`);
      const stage = ".hearth-write-" + randomUUID();
      const temp = join(dirname(file), stage);
      const stat = await stageFile(temp, content);
      const identity = { device: stat.dev.toString(), inode: stat.ino.toString(), birthtime: stat.birthtimeNs.toString() };
      try {
        previous = { ...record, stage, identity };
        // Persist the identity of the staged inode before linking it into the workspace.
        await createReceipt(recordFile, previous);
      } catch (error) {
        await unlinkIfPresent(temp);
        if (error.code !== "EEXIST") throw error;
        previous = await getReceipt(recordFile);
      }
    }
    if (!previous || !matches(previous, record)) throw new Error("Операция записи уже связана с другим артефактом.");
    const temp = stagedPath(file, previous);
    if (temp && await ownsFile(temp, previous)) {
      try { await link(temp, file); } catch (error) {
        if (!["EEXIST", "ENOENT"].includes(error.code)) throw error;
      }
    }
    if (!await ownsFile(file, previous)) {
      if (portable && await metadata(file) && hash(await readText(file))===previous.digest) return {path:record.path};
      throw new Error(`Файл «${record.path}» уже существует или был изменён.`);
    }
    if (temp && await ownsFile(temp, previous, false)) await unlinkIfPresent(temp);
    return { path: record.path };
  }

  async function openable(root, path) {
    const project = await validateRoot(root);
    const file = await fileInProject(project, path, false);
    const stat = await metadata(file);
    if (!stat?.isFile() || await realpath(file) !== file) throw new Error("Файл артефакта недоступен.");
    return file;
  }

  async function read(root, path) {
    return (await readText(await openable(root, path))).toString("utf8");
  }

  async function discard({ root, path, content, digest = typeof content === "string" ? hash(content) : undefined, operationId }) {
    const recordFile = receiptKey(operationId);
    const previous = await getReceipt(recordFile);
    if (!previous || previous.path !== path || previous.digest !== digest) return;
    if (!previous.identity) {
      await unlinkIfPresent(recordFile);
      return;
    }
    const project = await validateRoot(root);
    if (previous.root !== (portable ? "." : project)) return;
    const file = await fileInProject(project, path, false, true);
    if (file) {
      const temp = stagedPath(file, previous);
      if (await ownsFile(file, previous)) await unlinkIfPresent(file);
      if (temp && await ownsFile(temp, previous, false)) await unlinkIfPresent(temp);
    }
    await unlinkIfPresent(recordFile);
  }

  async function migrateReceipts(root,destination){
    const project=await validateRoot(root);
    const filenames=await readdir(receipts).catch(error=>{if(error.code==='ENOENT')return [];throw error;});
    for(const name of filenames.filter(value=>/^[a-f0-9]{64}\.json$/u.test(value))){
      const record=await getReceipt(join(receipts,name));
      if(record?.root!==project)continue;
      await mkdir(destination,{recursive:true,mode:0o700});
      if(await realpath(destination)!==destination)throw new Error('Папка квитанций артефактов недоступна.');
      const target=join(destination,name);
      const next={...record,root:'.'};
      try {await createReceipt(target,next);}
      catch(error){
        if(error.code!=='EEXIST' || !matches(await getReceipt(target),next))throw error;
      }
    }
  }
  return { write, openable, read, discard,migrateReceipts };
}
