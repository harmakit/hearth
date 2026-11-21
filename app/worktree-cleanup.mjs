import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, rmdir, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { nativeGitPath } from "./git-worktrees.mjs";

const oidPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const gitOptions = ["-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false"];
const sameRefs = (first, second) => first?.head === second?.head && first?.target === second?.target;
const matchesRegistration = (first, second) => first && second &&
  ["id", "studioId", "taskId", "path", "repository", "gitCommonDir", "branchRef", "targetRef", "baseOid"]
    .every(property => first[property] === second[property]);

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export function createWorktreeCleanup({ git, worktrees, delivery, inspectUsage, record, storageDir }) {
  const previews = new Map();
  const inMemoryJournal = new Map();
  let previousOperation = Promise.resolve();

  async function journalPath(key) {
    if (!storageDir) return null;
    await mkdir(storageDir, { recursive: true, mode: 0o700 });
    if (await realpath(storageDir) !== storageDir) throw new Error("Папка журнала уборки недоступна.");
    const digest = createHash("sha256").update(key).digest("hex");
    return join(storageDir, `${digest}.json`);
  }

  async function loadJournal(key) {
    const path = await journalPath(key);
    if (!path) return inMemoryJournal.get(key);
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return null;
    }
  }

  async function saveJournal(key, entry) {
    const path = await journalPath(key);
    if (!path) {
      inMemoryJournal.set(key, structuredClone(entry));
      return;
    }
    const temp = `${path}.${randomUUID()}.tmp`;
    const file = await open(temp, "wx", 0o600);
    try {
      try {
        await file.writeFile(JSON.stringify(entry));
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temp, path);
    } finally {
      if (await pathExists(temp)) await unlink(temp);
    }
  }

  async function gitWorktrees(item) {
    const text = await git(item.repository, ["worktree", "list", "--porcelain", "-z"]);
    return text.split("\0\0").filter(Boolean).map(block => {
      const [entry, ...metadata] = block.split("\0");
      return [entry.startsWith("worktree ") ? "worktree " + nativeGitPath(entry.slice(9)) : entry, ...metadata];
    });
  }

  async function gitState(item) {
    if (![item.path, item.repository, item.gitCommonDir].every(value => typeof value === "string" && isAbsolute(value)) ||
        ![item.branchRef, item.targetRef].every(value => typeof value === "string" && value.startsWith("refs/heads/")) ||
        item.branchRef === item.targetRef) {
      return { reasons: ["registration-mismatch"] };
    }
    const trees = await gitWorktrees(item);
    const registered = trees.find((lines, index) => index > 0 && lines[0] === `worktree ${item.path}`);
    if (!registered || !registered.includes(`branch ${item.branchRef}`) ||
        await realpath(item.path) !== item.path || await realpath(item.repository) !== item.repository ||
        nativeGitPath((await git(item.path, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).replace(/\r?\n$/u,"")) !== item.gitCommonDir) {
      return { reasons: ["registration-mismatch"] };
    }
    const reasons = [];
    if (registered.some(line => /^(locked|prunable)( |$)/.test(line))) reasons.push("worktree-unavailable");
    const [head, branch, target] = (await git(item.path, [
      "rev-parse", "--revs-only", "HEAD", item.branchRef, item.targetRef, "--",
    ])).trim().split("\n");
    if (![head, branch, target].every(oid => oidPattern.test(oid)) ||
        head !== branch || !registered.includes(`HEAD ${head}`)) reasons.push("refs-changed");
    const status = await git(item.path, [...gitOptions, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored", "--ignore-submodules=none"]);
    const changes = status.split("\0").filter(Boolean);
    if (changes.some(line => line.startsWith("?? "))) reasons.push("untracked-files");
    if (changes.some(line => line.startsWith("!! "))) reasons.push("ignored-files");
    if (changes.some(line => !line.startsWith("?? ") && !line.startsWith("!! "))) reasons.push("dirty-worktree");
    const tracked = await git(item.path, ["ls-files", "-v", "-z"]);
    if (tracked.split("\0").some(line => /^[a-zS] /.test(line))) reasons.push("hidden-index-files");
    return { reasons, refs: { head, target } };
  }

  async function assess(item, studioId, expected, checkout = item) {
    if (!item || item.studioId !== studioId) {
      return { reasons: ["unregistered-worktree"] };
    }
    if (item.status !== "ready") return { reasons: ["worktree-unavailable"] };
    try {
      const state = await gitState(checkout);
      const reasons = [...state.reasons];
      if (expected && !sameRefs(expected, state.refs) && !reasons.includes("refs-changed")) reasons.push("refs-changed");
      const usage = await inspectUsage(item);
      if (typeof usage?.activeLease !== "boolean" || typeof usage?.openTask !== "boolean") reasons.push("unknown-usage");
      if (usage?.activeLease) reasons.push("active-lease");
      if (usage?.openTask) reasons.push("open-task");
      if (usage?.evidenceSaved !== true) reasons.push("evidence-not-saved");
      if (state.refs && await delivery.isMerged(checkout) !== true) reasons.push("not-merged");
      return { reasons, refs: state.refs };
    } catch {
      return { reasons: ["verification-failed"] };
    }
  }

  async function previewCleanup({ studioId }) {
    const result = [];
    const snapshots = new Map();
    for (const item of await worktrees.listWorktrees({ studioId })) {
      if (item.studioId !== studioId || item.status === "cleaned") continue;
      const { reasons, refs } = await assess(item, studioId);
      if (!reasons.length) snapshots.set(item.id, refs);
      result.push({ id: item.id, path: item.path, taskId: item.taskId, eligible: !reasons.length, reasons });
    }
    previews.set(studioId, snapshots);
    return result;
  }

  async function finishRemoval(item, id) {
    await worktrees.markCleaned(id);
    return { id, path: item.path, taskId: item.taskId, status: "removed", reasons: [] };
  }

  async function removeEmptyDirectory(path) {
    await rmdir(path).catch(error => {
      if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) throw error;
    });
  }

  async function restore(item, parked, reasons) {
    try {
      if (await pathExists(item.path)) throw new Error("Исходный путь рабочего дерева занят.");
      await git(item.repository, ["worktree", "move", "--", parked.path, item.path]);
    } catch {
      return { id: item.id, status: "skipped", reasons: [...reasons, "worktree-restore-required"], recoveryPath: parked.path };
    }
    await removeEmptyDirectory(dirname(parked.path));
    return { id: item.id, status: "skipped", reasons };
  }

  async function removeParked(item, parked, journal, key) {
    const paths = await gitWorktrees(item);
    if (await pathExists(item.path) || paths.some(lines => lines[0] === `worktree ${item.path}`)) {
      return restore(item, parked, ["registration-mismatch"]);
    }
    const state = await assess(item, item.studioId, journal.pending.refs, parked);
    if (state.reasons.length) return restore(item, parked, state.reasons);
    journal.pending.readyToRemove = true;
    await saveJournal(key, journal);
    const final = await gitState(parked).catch(() => ({ reasons: ["verification-failed"] }));
    if (final.reasons.length) return restore(item, parked, final.reasons);
    if (!sameRefs(state.refs, final.refs)) return restore(item, parked, ["refs-changed"]);
    try {
      await git(item.repository, [...gitOptions, "worktree", "remove", "--", parked.path]);
    } catch {
      if (await pathExists(parked.path) || (await gitWorktrees(item)).some(lines => lines[0] === `worktree ${parked.path}`)) {
        return restore(item, parked, ["git-removal-refused"]);
      }
    }
    await removeEmptyDirectory(dirname(parked.path));
    return finishRemoval(item, item.id);
  }

  async function removeCandidate({ studioId, id, journal, key }) {
    const item = await worktrees.getWorktree(id, false);
    const pending = journal.pending;
    if (pending && !matchesRegistration(pending.registration, item)) {
      return { id, status: "skipped", reasons: ["registration-mismatch"] };
    }
    const parkedPath = tag => join(dirname(item.path), `.hearth-cleanup-${tag}`, "worktree");
    if (pending && /^[0-9a-f-]{36}$/.test(pending.tag)) {
      const path = parkedPath(pending.tag);
      if (await pathExists(path)) return removeParked(item, { ...item, path }, journal, key);
      if (pending.readyToRemove && !await pathExists(item.path) &&
          !(await gitWorktrees(item)).some(lines => [item.path, path].some(entry => lines[0] === `worktree ${entry}`))) {
        await removeEmptyDirectory(dirname(path));
        return finishRemoval(item, id);
      }
    }
    const state = await assess(item, studioId, pending?.refs ?? previews.get(studioId)?.get(id));
    if (state.reasons.length) return { id, status: "skipped", reasons: state.reasons };
    const tag = randomUUID();
    const path = parkedPath(tag);
    journal.pending = { registration: item, tag, refs: state.refs };
    await saveJournal(key, journal);
    const current = await worktrees.getWorktree(id).catch(() => null);
    if (!matchesRegistration(item, current)) {
      return { id, status: "skipped", reasons: ["registration-mismatch"] };
    }
    const confirmed = await assess(current, studioId, state.refs);
    if (confirmed.reasons.length) return { id, status: "skipped", reasons: confirmed.reasons };
    if (pending?.tag && /^[0-9a-f-]{36}$/.test(pending.tag)) await removeEmptyDirectory(dirname(parkedPath(pending.tag)));
    await mkdir(dirname(path), { mode: 0o700 });
    try {
      await git(item.repository, ["worktree", "move", "--", item.path, path]);
    } catch {
      if (!await pathExists(path)) {
        await removeEmptyDirectory(dirname(path));
        return { id, status: "skipped", reasons: ["git-move-refused"] };
      }
    }
    return removeParked(item, { ...item, path }, journal, key);
  }

  async function apply({ studioId, candidateIds, operationId }) {
    const valid = value => typeof value === "string" && value.trim().length > 0 && value.length <= 512;
    if (!valid(studioId) || !valid(operationId) || !Array.isArray(candidateIds) ||
        candidateIds.length > 1000 || !candidateIds.every(valid)) {
      throw new Error("Некорректный запрос уборки.");
    }
    const ids = [...new Set(candidateIds)];
    const key = JSON.stringify([studioId, operationId]);
    const journal = await loadJournal(key) ?? { ids, results: [] };
    if (JSON.stringify(journal.ids) !== JSON.stringify(ids)) {
      throw new Error("Идентификатор операции уборки уже использован с другим набором.");
    }
    if (journal.receipt) return journal.receipt;
    for (const id of ids.slice(journal.results.length)) {
      journal.results.push(await removeCandidate({ studioId, id, journal, key }));
      delete journal.pending;
      await saveJournal(key, journal);
    }
    journal.receipt = { studioId, operationId, results: journal.results, finishedAt: new Date().toISOString() };
    await saveJournal(key, journal);
    if (record) await record(journal.receipt);
    return journal.receipt;
  }

  return {
    previewCleanup,
    applyCleanup(request) {
      const next = previousOperation.then(() => apply(request));
      previousOperation = next.catch(() => {});
      return next;
    },
  };
}
