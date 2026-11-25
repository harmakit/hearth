import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';

const maxBytes = 12 * 1024 * 1024;
const png = Buffer.from('89504e470d0a1a0a', 'hex');
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu;
export const imageDirectoryPattern = /^generated-images\/[a-z0-9-]{1,80}$/u;
const managedImage = /^image-(0[1-8])(?:-[a-f0-9]{16})?\.(?:png|jpg|webp)$/u;

async function imageBytes(item, options, threadId) {
  if (typeof item.result === 'string' && item.result.length && item.result.length <= Math.ceil(maxBytes / 3) * 4 &&
      /^[a-z\d+/]+={0,2}$/iu.test(item.result)) return Buffer.from(item.result, 'base64');
  if (!uuid.test(threadId) || typeof item.savedPath !== 'string' || !isAbsolute(item.savedPath)) return;
  const home = options.env.CODEX_HOME ?? join(options.env.HOME ?? homedir(), '.codex');
  const root = await realpath(join(home, 'generated_images', threadId));
  const path = await realpath(item.savedPath);
  const child = relative(root, path);
  if (path !== item.savedPath || !child || child === '..' || child.startsWith('..' + sep) || isAbsolute(child)) return;
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maxBytes) return;
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const data = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!data.bytesRead) return;
      offset += data.bytesRead;
    }
    return bytes;
  } finally {
    await file.close();
  }
}

function format(bytes) {
  if (!bytes || bytes.length > maxBytes || bytes.length < 12) return;
  if (bytes.subarray(0, 8).equals(png)) return 'png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp';
}

export async function stageCodexImages({ items, slots, threadId, root, outputDirectory, options }) {
  if (!items.length) return [];
  const numbers = slots ?? items.map((_, index) => index + 1);
  if (!Array.isArray(numbers) || numbers.length !== items.length || new Set(numbers).size !== numbers.length ||
      numbers.some(number => !Number.isInteger(number) || number < 1 || number > 8)) {
    throw new Error('Для каждого нового изображения укажите отдельный номер от 1 до 8.');
  }
  if (!imageDirectoryPattern.test(outputDirectory)) throw new Error('Папка для изображений не принадлежит задаче.');
  const prepared = [];
  for (const [index, item] of items.entries()) {
    options.signal?.throwIfAborted();
    const bytes = await imageBytes(item, options, threadId).catch(() => undefined);
    const extension = format(bytes);
    if (!extension) throw new Error('Codex создал изображение, но Hearth не получил доступный файл PNG, JPEG или WebP.');
    const slot = String(numbers[index]).padStart(2, '0');
    prepared.push({ slot, name: `image-${slot}.${extension}`, bytes });
  }
  const destination = join(root, outputDirectory);
  for (const directory of [dirname(destination), destination]) {
    await mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    if (!(await lstat(directory)).isDirectory() || await realpath(directory) !== directory) {
      throw new Error('Папка для изображений недоступна или является ссылкой.');
    }
  }
  const updatedSlots = new Map(prepared.map(entry => [entry.slot, entry.name]));
  const earlier = [];
  for (const entry of await readdir(destination, { withFileTypes: true })) {
    const slot = entry.name.match(managedImage)?.[1];
    const replacement = updatedSlots.get(slot);
    if (!replacement) continue;
    if (!entry.isFile()) throw new Error('Сохранённое изображение в рабочей копии не является обычным файлом.');
    if (entry.name !== replacement) earlier.push(join(destination, entry.name));
  }
  // Earlier accepted versions remain in Git. Each task publishes one object per image number.
  const temporary = [];
  try {
    for (const { name, bytes } of prepared) {
      options.signal?.throwIfAborted();
      const pending = join(destination, `.image-${randomUUID()}`);
      temporary.push({ pending, target: join(destination, name) });
      await writeFile(pending, bytes, { flag: 'wx', mode: 0o600 });
    }
    options.signal?.throwIfAborted();
    for (const { pending, target } of temporary) await rename(pending, target);
    for (const path of earlier) await rm(path, { force: true });
  } finally {
    for (const { pending } of temporary) await rm(pending, { force: true });
  }
  return prepared.map(({ name }) => `${outputDirectory}/${name}`);
}
