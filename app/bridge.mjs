import { access, mkdir, realpath, stat } from "node:fs/promises";
import { git } from "./git-worktrees.mjs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

const serviceCommands = new Set([
  "snapshot", "createStudio", "updateStudio", "assessDebtPolicy", "addAgent", "updateAgent", "createTask",
  "updateProviderPreference", "updatePlanTasks", "taskHistory",
  "startTask", "cancelTask", "answerInbox",
  "initializeStudio", "startNextSprint", "decidePlan", "setStudioRunning", "deleteStudio", "updateModelPolicy", "updatePlanAgents",
  "configureProject", "previewCleanup", "applyCleanup", "reviseBacklog", "closeSprint", "createPhase", "updatePhase",
  "proposePhaseTransition", "decidePhaseTransition", "updateGrooming", "requestGrooming", "resolveGrooming",
  "openMeeting", "resumeMeeting", "resolveMeeting", "replaceParticipant", "addPrerequisite", "waivePrerequisite",
  "proposeRosterChange", "decideRosterChange", "retirementPlan", "changeKnowledge", "publishLibraryEntry",
  "postStudioMessage", "applyConversationProposal", "studioUsage", "updateUsageTariff", "setEpicPriority", "diagnoseStudio", "updateNotifications", "resolveReconciliation",
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
  return validateLocation(root, protectedRoots);
}

async function validateLocation(root, protectedRoots) {
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

async function newProjectFolder(parentPath, requestedName, protectedRoots) {
  const name = typeof requestedName === 'string' && requestedName.trim();
  if (!name || name === '.' || name === '..' || name.toLowerCase() === '.git' ||
      /[<>:"/\\|?*\u0000-\u001f]|[. ]$/u.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(name)) {
    throw new Error('Укажите имя новой папки без пути.');
  }
  const parent = await directory(parentPath);
  const root = await validateLocation(join(parent, name), protectedRoots);
  for (let dir = parent; ; dir = dirname(dir)) {
    try {
      await access(join(dir, '.git'));
      throw new Error('Выберите место вне существующего Git-репозитория.');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (dirname(dir) === dir) break;
  }
  await mkdir(root); // Exclusive creation protects pre-existing directories, even empty ones.
  try {
    await git(root, ['init','--template=','--initial-branch=main','.']);
    await git(root, ['-c','user.name=Hearth Studio','-c','user.email=studio@hearth.invalid',
      'commit','--allow-empty','-m','Initialize Hearth project history']);
    const targetRef = 'refs/heads/hearth-studio/delivery';
    await git(root, ['branch',targetRef.slice('refs/heads/'.length),'HEAD']);
    return {root,targetRef};
  } catch (error) {
    throw new Error('Папка создана, но подготовить Git не удалось. Откройте её как существующую: '+root+' — '+error.message);
  }
}

function isRecord(value) {
  if (!value || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function createCommandRouter({ service, selectFolder, inspect, previewImport, openArtifact, revealArtifact, copyArtifactPath, openProject,
  openEvidence, revealEvidence, copyEvidencePath, saveEvidence, saveDiagnostics, pickAttachment, restart, findSkills, transfer, protectedRoots = [] }) {
  return async (command, payload = {}) => {
    if (!isRecord(payload)) throw new Error("Переданы некорректные данные.");
    if (command === "pickFolder") return selectFolder();
    const evidenceActions = { openEvidence, revealEvidence, copyEvidencePath, saveEvidence };
    if (Object.hasOwn(evidenceActions, command)) {
      const record = service.findEvidence(payload);
      return evidenceActions[command](record);
    }
    if (command === "pickAttachment") {
      const studio = service.snapshot().studios.find(({ id }) => id === payload.studioId);
      if (!studio) throw new Error("Студия не найдена.");
      const task = payload.taskId && service.snapshot().tasks.find(({ id }) => id === payload.taskId);
      if (payload.taskId && task?.studioId !== studio.id) throw new Error("Задача не найдена в студии.");
      const record = await pickAttachment({ studioId: studio.id, taskId: task?.id ?? studio.id });
      return record && service.recordEvidence(record);
    }
    if (command === "restartApp") return restart();
    if (command === "saveDiagnostics") return saveDiagnostics(service.diagnoseStudio(payload));
    if (command === "inspect") {
      if (!runtimeIds.has(payload.runtime)) throw new Error("Неизвестное подключение.");
      return inspect({ runtime: payload.runtime });
    }
    if (command === "previewImport") return previewImport({ root: await directory(payload.root) });
    if (command === "searchSkillRepositories") {
      const studio = service.snapshot().studios.find(entry => entry.id === payload.studioId);
      if (!studio) throw new Error("Студия не найдена.");
      const { candidates, warnings } = await findSkills({ topics: payload.topics, minStars: studio.skillMinStars ?? 10000 });
      return {
        candidates: candidates.map(({ id, repo, commit, path, title, stars, license, url }) =>
          ({ id, repo, commit, path, title, stars, license, url })),
        warnings,
      };
    }
    if (command === "openProject") {
      const studio = service.snapshot().studios.find(entry => entry.id === payload.studioId);
      if (!studio) throw new Error("Студия не найдена.");
      return openProject(await directory(studio.root));
    }
    const artifactActions = { openArtifact, revealArtifact, copyArtifactPath };
    if (Object.hasOwn(artifactActions, command)) {
      const state = service.snapshot();
      if (payload.planId) {
        const plan = state.plans?.find(entry => entry.id === payload.planId);
        const studio = plan && state.studios.find(entry => entry.id === plan.studioId);
        if (!studio || !plan.publishedFiles?.some(file => (typeof file === "string" ? file : file.path) === payload.path)) {
          throw new Error("Артефакт плана недоступен.");
        }
        return artifactActions[command]({ root: studio.root, path: payload.path });
      }
      const task = state.tasks.find(entry => entry.id === payload.taskId);
      const studio = task && state.studios.find(entry => entry.id === task.studioId);
      if (!task?.artifactPath || !studio) throw new Error("Артефакт для этой задачи недоступен.");
      return artifactActions[command]({ root: studio.root, path: task.artifactPath });
    }
    if (command === "exportStudio") return transfer.exportStudio(service.snapshot(), payload);
    if (command === "importBundle" || command === "importLegacy") {
      const root = await validateProjectRoot(payload.root, protectedRoots);
      const input = { ...payload, root };
      if (command === "importLegacy") input.source = await directory(payload.source);
      return transfer[command](input);
    }
    if (!serviceCommands.has(command)) throw new Error("Неизвестная команда приложения.");
    if (command === "snapshot") return service.snapshot();
    if (command === "createStudio" && payload.newFolderName !== undefined) {
      const {newFolderName, ...input} = payload;
      const {root,targetRef} = await newProjectFolder(input.root, newFolderName, protectedRoots);
      return service.createStudio({...input, root}, {targetRef});
    }
    if (command === "createStudio" || (command === "updateStudio" && Object.hasOwn(payload, "root"))) {
      payload = { ...payload, root: await validateProjectRoot(payload.root, protectedRoots) };
    }
    return service[command](payload);
  };
}
