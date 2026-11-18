import { access, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

const serviceCommands = new Set([
  "snapshot", "createStudio", "updateStudio", "addAgent", "updateAgent", "createTask",
  "startTask", "cancelTask", "answerInbox",
]);
const runtimeIds = new Set(["codex", "claude"]);

export function isWithin(parent, target) {
  const distance = relative(parent, target);
  return distance !== ".." && !distance.startsWith(".." + sep) && !isAbsolute(distance);
}

async function directory(candidate) {
  if (typeof candidate !== "string" || !isAbsolute(candidate)) {
    throw new Error("Выберите папку проекта с абсолютным путём.");
  }
  try {
    const resolved = await realpath(candidate);
    if (!(await stat(resolved)).isDirectory()) throw new Error("not a directory");
    return resolved;
  } catch {
    throw new Error("Папка недоступна. Выберите существующий каталог.");
  }
}

async function hasLegacyStudio(root) {
  let current = root;
  while (true) {
    const markers = [join(current, "studio", "board.json"), join(current, "studio", "bin", "studio")];
    if ((await Promise.all(markers.map(marker => access(marker).then(() => true, () => false)))).every(Boolean)) {
      return true;
    }
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

export async function validateProjectRoot(candidate, protectedRoots = []) {
  const root = await directory(candidate);
  for (const candidate of protectedRoots) {
    const protectedRoot = await realpath(candidate).catch(() => candidate);
    if (isWithin(protectedRoot, root) || isWithin(root, protectedRoot)) {
      throw new Error("Эта папка пересекается с данными приложения. Выберите отдельную рабочую папку.");
    }
  }
  if (await hasLegacyStudio(root)) {
    throw new Error("В этой папке работает прежняя версия Hearth. Для неё доступен предварительный просмотр импорта.");
  }
  return root;
}

function isRecord(value) {
  if (!value || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function createCommandRouter({ service, selectFolder, inspect, previewImport, protectedRoots = [] }) {
  return async (command, payload = {}) => {
    if (!isRecord(payload)) throw new Error("Переданы некорректные данные.");
    if (command === "pickFolder") return selectFolder();
    if (command === "inspect") {
      if (!runtimeIds.has(payload.runtime)) throw new Error("Неизвестное подключение.");
      return inspect({ runtime: payload.runtime });
    }
    if (command === "previewImport") return previewImport({ root: await directory(payload.root) });
    if (!serviceCommands.has(command)) throw new Error("Неизвестная команда приложения.");
    if (command === "snapshot") return service.snapshot();
    if (command === "createStudio" || (command === "updateStudio" && Object.hasOwn(payload, "root"))) {
      payload = { ...payload, root: await validateProjectRoot(payload.root, protectedRoots) };
    }
    return service[command](payload);
  };
}
