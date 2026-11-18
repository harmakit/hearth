import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { promisify } from "node:util";
import { createWorktreeCleanup } from "../app/worktree-cleanup.mjs";

const execFileAsync = promisify(execFile);
const scratch = fileURLToPath(new URL("../.tmp", import.meta.url));
async function git(cwd, args) {
  return (await execFileAsync("git", args, { cwd })).stdout;
}

async function fixture(t) {
  await mkdir(scratch, { recursive: true });
  const directory = await realpath(await mkdtemp(join(scratch, "cleanup-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repository = join(directory, "repository");
  const path = join(directory, "managed tree");
  const outside = join(directory, "unmanaged tree");
  await mkdir(repository);
  await git(repository, ["init", "-q", "-b", "main"]);
  await writeFile(join(repository, ".gitignore"), "build/\n");
  await git(repository, ["add", ".gitignore"]);
  await git(repository, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "init"]);
  await git(repository, ["worktree", "add", "-qb", "studio-task", path]);
  await git(repository, ["worktree", "add", "-qb", "externally-managed", outside]);
  const item = {
    id: "tree", studioId: "studio", taskId: "task", status: "ready", path,
    repository, branchRef: "refs/heads/studio-task", targetRef: "refs/heads/main",
    gitCommonDir: join(repository, ".git")
  };
  const usage = { activeLease: false, openTask: false, evidenceSaved: true };
  const records = [];
  const worktrees = {
    listWorktrees: async () => [structuredClone(item)],
    getWorktree: async id => id === item.id ? structuredClone(item) : undefined,
    markCleaned: async () => { item.status = "cleaned"; }
  };
  const options = {
    git, worktrees, delivery: { isMerged: async () => true },
    inspectUsage: async () => ({ ...usage }),
    storageDir: join(directory, "journal"),
    record: async value => { records.push(value); }
  };
  const cleanup = createWorktreeCleanup(options);
  const request = { studioId: item.studioId, candidateIds: [item.id], operationId: "cleanup-1" };
  return { cleanup, item, outside, records, request, usage, options };
}

test("removes only a merged registered worktree and replays a durable receipt", async t => {
  const { cleanup, item, outside, records, request, options } = await fixture(t);
  const preview = await cleanup.previewCleanup({ studioId: item.studioId });
  assert.deepEqual(preview[0].reasons, []);
  assert.deepEqual(preview.map(candidate => [candidate.id, candidate.eligible]), [["tree", true]]);
  const first = await cleanup.applyCleanup(request);
  assert.deepEqual(first.results.map(result => result.status), ["removed"]);
  const second = await createWorktreeCleanup(options).applyCleanup(request);
  assert.deepEqual(second, first);
  assert.equal(item.status, "cleaned");
  assert.equal(records.length, 1);
  const registered = await git(item.repository, ["worktree", "list", "--porcelain"]);
  assert.ok(registered.includes(outside));
  assert.ok(!registered.includes(item.path));
});

test("rechecks ignored and untracked files, leases, open tasks, and saved evidence after preview", async t => {
  const { cleanup, item, request, usage } = await fixture(t);
  assert.equal((await cleanup.previewCleanup(request))[0].eligible, true);
  await mkdir(join(item.path, "build"));
  await writeFile(join(item.path, "build", "ignored.bin"), "keep");
  await writeFile(join(item.path, "untracked.txt"), "keep");
  Object.assign(usage, { activeLease: true, openTask: true, evidenceSaved: false });
  const result = await cleanup.applyCleanup(request);
  assert.equal(result.results[0].status, "skipped");
  assert.deepEqual(new Set(result.results[0].reasons), new Set(["active-lease", "open-task", "evidence-not-saved", "ignored-files", "untracked-files"]));
  assert.equal(item.status, "ready");
});

test("refuses a ref that changed after preview even if delivery reports it merged", async t => {
  const { cleanup, item, request } = await fixture(t);
  assert.equal((await cleanup.previewCleanup(request))[0].eligible, true);
  await git(item.path, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "new head"]);
  const result = await cleanup.applyCleanup(request);
  assert.equal(result.results[0].status, "skipped");
  assert.ok(result.results[0].reasons.includes("refs-changed"));
});

test("preserves an ignored file written immediately before moving a worktree out of use", async t => {
  const { item, request, options } = await fixture(t);
  let injected = false;
  const cleanup = createWorktreeCleanup({
    ...options,
    git: async (cwd, args) => {
      const operation = args[args.indexOf("worktree") + 1];
      if (!injected && ["move", "remove"].includes(operation)) {
        injected = true;
        await mkdir(join(item.path, "build"));
        await writeFile(join(item.path, "build", "late.bin"), "preserved");
      }
      return git(cwd, args);
    },
  });
  const result = await cleanup.applyCleanup(request);
  assert.equal(injected, true);
  assert.equal(result.results[0].status, "skipped");
  assert.ok(result.results[0].reasons.includes("ignored-files"));
  assert.equal(await readFile(join(item.path, "build", "late.bin"), "utf8"), "preserved");
});

test("resumes after the worktree was removed but its registry update was interrupted", async t => {
  const { item, request, options } = await fixture(t);
  const interrupted = createWorktreeCleanup({
    ...options,
    worktrees: {
      ...options.worktrees,
      markCleaned: async () => { throw new Error("interrupted"); }
    }
  });
  await assert.rejects(interrupted.applyCleanup(request), /interrupted/);
  assert.equal(item.status, "ready");
  const recovered = await createWorktreeCleanup(options).applyCleanup(request);
  assert.equal(recovered.results[0].status, "removed");
  assert.equal(item.status, "cleaned");
});
