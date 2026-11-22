const { app, BrowserWindow, clipboard, dialog, ipcMain, net, Notification, powerMonitor, powerSaveBlocker, protocol, shell } = require("electron");
const { existsSync, mkdirSync } = require("node:fs");
const { access, writeFile } = require("node:fs/promises");
const { X_OK } = require("node:fs").constants;
const { randomUUID } = require("node:crypto");
const { homedir } = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { createLaunchRequests } = require("./launch-lifecycle.cjs");

const appUrl = "hearth://app/index.html";
const rendererPath = path.resolve(__dirname, "../renderer");
const schemePrivileges = { standard: true, secure: true, supportFetchAPI: true };
const policy = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

app.setName("Hearth Studio");
protocol.registerSchemesAsPrivileged([{ scheme: "hearth", privileges: schemePrivileges }]);
app.commandLine.appendSwitch("disable-background-networking");
if (process.platform === "darwin") {
  const locations = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const standardLocations = [path.join(homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
  process.env.PATH = [...new Set([...locations, ...standardLocations])].join(path.delimiter);
}

const profileOverride = process.env.HEARTH_DATA_DIR;
if (profileOverride) {
  const profile = path.resolve(profileOverride);
  for (const folder of [profile, path.join(profile, "chromium"), path.join(profile, "logs")]) {
    mkdirSync(folder, { recursive: true });
  }
  app.setPath("userData", profile);
  app.setPath("sessionData", path.join(profile, "chromium"));
  app.setAppLogsPath(path.join(profile, "logs"));
}

let window;
let service;
let nativeText = value => value;
let nativeInbox = item => item.title;
const {revealFile}=require('./reveal-file.cjs');
let shuttingDown = false;
let scheduleTimer;
let power;
const notifications = new Set();
const launchRequests = createLaunchRequests({
  isShuttingDown: () => shuttingDown,
  openWindow,
  relaunch: () => app.relaunch(),
});

if (!app.requestSingleInstanceLock()) app.quit();
else {
  const requestWindow = () => { launchRequests.open().catch(console.error); };
  app.on("second-instance", requestWindow);
  app.on("activate", requestWindow);
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app.on("before-quit", event => {
    if (!service) return;
    event.preventDefault();
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(scheduleTimer);
    power?.close();
    // Finish outside the current native quit event, after Hearth's own shutdown.
    Promise.resolve().then(() => service.close()).catch(console.error).finally(() => {
      setImmediate(() => app.exit(0));
    });
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => app.quit());
  }
  app.whenReady().then(start).catch(error => {
    dialog.showErrorBox("Hearth Studio", error instanceof Error ? error.message : String(error));
    app.exit(1);
  });
}

async function openWindow() {
  if (shuttingDown || !service) return;
  if (window && !window.isDestroyed()) {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    return window;
  }
  const next = new BrowserWindow({
    width: 1180, height: 820, minWidth: 590, minHeight: 470,
    title: "Hearth Studio",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  window = next;
  next.webContents.on("will-navigate", event => event.preventDefault());
  next.webContents.on("will-attach-webview", event => event.preventDefault());
  next.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  next.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  next.webContents.session.setPermissionCheckHandler(() => false);
  next.on("closed", () => { if (window === next) window = undefined; });
  next.once("ready-to-show", () => { if (!next.isDestroyed()) next.show(); });
  await next.loadURL(appUrl);
  return next;
}

function broadcast(snapshot = service?.snapshot()) {
  if (!snapshot) return;
  power?.refresh(snapshot.studios);
  if (window && !window.isDestroyed() && window.webContents.getURL() === appUrl) {
    window.webContents.send("hearth:snapshot", snapshot);
  }
}

function notify({ title, kind,studioId, inboxId }) {
  if (shuttingDown || !Notification.isSupported()) return;
  const notice = new Notification({
    title: "Hearth Studio",
    body: nativeInbox({title,kind}) || nativeText("В студии новое сообщение"),
  });
  notifications.add(notice);
  notice.once("close", () => notifications.delete(notice));
  notice.once("click", async () => {
    notifications.delete(notice);
    try {
      const target = await openWindow();
      if (target && !target.isDestroyed()) target.webContents.send("hearth:open-inbox", { studioId, inboxId });
    } catch (error) {
      console.error(error);
    }
  });
  notice.show();
}

async function pickFolder() {
  const options = { properties: ["openDirectory", "createDirectory"], title: nativeText("Выбрать или создать папку проекта") };
  const result = window && !window.isDestroyed()
    ? await dialog.showOpenDialog(window, options)
    : await dialog.showOpenDialog(options);
  return result.canceled ? null : result.filePaths[0] ?? null;
}

async function pickBundle() {
  const options = {
    properties: ["openFile"],
    title: nativeText("Открыть снимок Hearth Studio"),
    filters: [{ name: "Шаблон или снимок Hearth Studio", extensions: ["json"] }],
  };
  const result = window && !window.isDestroyed() ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
  return result.canceled ? null : result.filePaths[0] ?? null;
}

async function saveBundle(studioName, mode) {
  const filename = studioName.replace(/[/\\:\u0000-\u001f]/g, "-").slice(0, 100) || "Hearth";
  const options = {
    title: nativeText("Экспорт студии"),
    defaultPath: filename + (mode === "template" ? "-template" : "-snapshot") + ".hearth.json",
    filters: [{ name: "Экспорт Hearth Studio", extensions: ["json"] }],
  };
  const result = window && !window.isDestroyed() ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
  return result.canceled ? null : result.filePath ?? null;
}

async function start() {
  const {copy,setCopyLocale,inboxLabel} = await import('../renderer/copy.mjs');
  nativeText = value => { setCopyLocale(service?.readAppLocale() ?? 'en'); return copy(value); };
  nativeInbox = item => inboxLabel(item,nativeText);
  const [
    { createCommandRouter, isWithin, validateProjectRoot },
    { createStudioService },
    { run, inspect },
    { previewImport },
    { createArtifactStore },
    { createTransferController },
    { createGitHubSkillFinder },
    { createMaterialFinder },
    { createGitWorktrees, git },
    { createGitDelivery },
    { createProjectChecks },
    { createProjectPipeline },
    { createEvidenceStore },
    { createWorktreeCleanup },
    { scopedCommand },
    { createPowerController },
  ] = await Promise.all([
    import("./bridge.mjs"),
    import("../core/service.mjs"),
    import("../runtimes/index.mjs"),
    import("../migration/preview.mjs"),
    import("./artifacts.mjs"),
    import("./transfer.mjs"),
    import("./github-skills.mjs"),
    import("./materials.mjs"),
    import("./git-worktrees.mjs"),
    import("./git-delivery.mjs"),
    import("./project-checks.mjs"),
    import("./project-pipeline.mjs"),
    import("./evidence.mjs"),
    import("./worktree-cleanup.mjs"),
    import("../runtimes/scope.mjs"),
    import("./power.mjs"),
  ]);
  protocol.handle("hearth", async ({ url }) => {
    try {
      const request = new URL(url);
      const file = path.resolve(rendererPath, "." + decodeURIComponent(request.pathname));
      if (request.host !== "app" || !isWithin(rendererPath, file)) {
        return new Response(null, { status: 404 });
      }
      const response = await net.fetch(pathToFileURL(file).href);
      const headers = new Headers(response.headers);
      headers.set("Content-Security-Policy", policy);
      headers.set("X-Content-Type-Options", "nosniff");
      return new Response(response.body, { status: response.status, headers });
    } catch {
      return new Response(null, { status: 404 });
    }
  });
  const dataDir = app.getPath("userData");
  mkdirSync(dataDir, { recursive: true });
  const protectedRoots = app.isPackaged
    ? [app.getAppPath(), dataDir]
    : ["app", "core", "runtimes", "migration", "renderer"].map(name => path.join(app.getAppPath(), name)).concat(dataDir);
  const legacyHome = path.join(homedir(), "projects", "hearth");
  if (existsSync(path.join(legacyHome, "studio", "board.json")) &&
      existsSync(path.join(legacyHome, "studio", "bin", "studio"))) {
    protectedRoots.push(legacyHome);
  }
  if (path.isAbsolute(process.env.HEARTH_LEGACY_ROOT || "")) {
    protectedRoots.push(process.env.HEARTH_LEGACY_ROOT);
  }
  const validateRoot = root => validateProjectRoot(root, protectedRoots);
  const artifacts = createArtifactStore({ receipts: path.join(dataDir, "artifact-receipts"), validateRoot });
  const evidence = createEvidenceStore({ storageDir: path.join(dataDir, "evidence") });
  const worktrees = createGitWorktrees({ storageDir: path.join(dataDir, "worktrees"), validateRepository: validateRoot });
  const delivery = createGitDelivery({ storageDir: path.join(dataDir, "candidates") });
  const workerHost = process.env.HEARTH_CHECK_WORKER_SSH;
  const externalCheck = workerHost ? (await import("./isolated-check-executor.mjs")).createSshCheckExecutor(workerHost, {
    config: process.env.HEARTH_CHECK_WORKER_SSH_CONFIG,
  }) : undefined;
  const checks = createProjectChecks({
    storageDir: path.join(dataDir, "check-logs"),
    externalCheck,
    async prepareCommand({ command, args, root, scratch, network }) {
      const directories = (process.env.PATH ?? "").split(path.delimiter).filter(directory => path.isAbsolute(directory));
      for (const directory of directories) {
        const executable = path.join(directory, command);
        if (await access(executable, X_OK).then(() => true, () => false)) {
          const env = { PATH: directories.join(path.delimiter), HOME: scratch, LANG: process.env.LANG ?? "en_US.UTF-8" };
          return scopedCommand(executable, args, { root, scratch, access: "worktree-write", network, env });
        }
      }
    },
  });
  const projectPipeline = createProjectPipeline({
    storageDir: path.join(dataDir, "attempt-scratch"), worktrees, delivery, checks, evidence, git,
    lookupEvidence: args => service.findEvidence(args),
  });
  const cleanup = createWorktreeCleanup({
    git, worktrees, delivery, storageDir: path.join(dataDir, "cleanup-journal"),
    async inspectUsage(worktree) {
      const { task, activeLease, evidence: savedEvidence } = service.cleanupState(worktree);
      const evidenceIds = task?.gitDelivery?.checks?.flatMap(({ evidenceIds = [] }) => evidenceIds) ?? [];
      const openTask = !task || task.stage !== "done";
      const evidenceSaved = task?.gitDelivery?.status === "merged" && (await Promise.all(evidenceIds.map(async id => {
        const record = savedEvidence.find(value => value.id === id);
        return Boolean(record && await evidence.openEvidence(record).catch(() => null));
      }))).every(Boolean);
      return { activeLease, openTask, evidenceSaved };
    },
  });
  power = createPowerController(powerSaveBlocker);
  const { findSkills } = createGitHubSkillFinder();
  service = createStudioService({
    dbPath: path.join(dataDir, "studio.sqlite3"),
    inspectRuntime: inspect,
    run: async request => run({ ...request, projectRoot: await validateRoot(request.projectRoot) }),
    writeArtifact: artifacts.write,
    readArtifact: artifacts.read,
    findSkills,
    findMaterials: createMaterialFinder(),
    projectPipeline,
    prepareTarget: worktrees.prepareTarget,
    async verifyGitHistory({ repository, revision, targetOid }) {
      const ids = [...new Set([revision.baseOid, revision.headOid, revision.targetOid, revision.candidateOid].filter(Boolean))];
      const missing = (await Promise.all(ids.map(async oid => {
        const valid = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(oid);
        const found = valid && await git(repository, ["cat-file", "-e", oid + "^{commit}"]).then(() => true, () => false);
        return found ? null : oid;
      }))).filter(Boolean);
      return { checkedAt: new Date().toISOString(), targetStillMatches: revision.targetOid === targetOid, missing };
    },
    manageCleanup: { preview: cleanup.previewCleanup, apply: cleanup.applyCleanup },
    async describeAttachment(record) {
      if (record.size > 120_000 || !(/^(text\/|application\/json)/).test(record.contentType)) return undefined;
      return (await evidence.readEvidence(record)).toString("utf8").slice(0, 8_000);
    },
    onChange: broadcast,
    notify,
  });
  void service.refreshProviders();
  const transfer = createTransferController({
    service, artifacts, evidenceStore: evidence, pickBundle, saveBundle, journalDir: path.join(dataDir, "import-journal"),
  });
  const failedImports = await transfer.recover();
  if (failedImports.length) console.warn("Hearth Studio: часть импортов ожидает восстановления.", failedImports.length);
  function refreshSchedules() {
    if (shuttingDown) return;
    try {
      service.refreshSchedules();
      power.refresh(service.snapshot().studios);
    } catch (error) { console.error(error); }
  }
  refreshSchedules();
  scheduleTimer = setInterval(refreshSchedules, 15000);
  scheduleTimer.unref();
  powerMonitor.on("resume", refreshSchedules);
  const dispatch = createCommandRouter({
    service, selectFolder: pickFolder, inspect: service.inspectProvider, previewImport, findSkills, transfer, protectedRoots,readArtifact:artifacts.read,
    copyTaskId: id => clipboard.writeText(id),
    restart() {
      launchRequests.relaunch();
      app.quit();
      return true;
    },
    async pickAttachment({ studioId, taskId }) {
      const result = await dialog.showOpenDialog(window, { title: nativeText("Добавить вложение"), properties: ["openFile"] });
      if (result.canceled || !result.filePaths[0]) return null;
      const chosen = result.filePaths[0];
      const attemptId = randomUUID();
      return evidence.recordEvidence({ studioId, taskId, attemptId, root: path.dirname(chosen), sourcePath: path.basename(chosen),
        revision: { digest: attemptId }, kind: "attachment" });
    },
    async openEvidence(record) {
      if (!/^(?:text\/|image\/(?:jpeg|png|webp|gif)$|video\/|audio\/|application\/(?:json|pdf)$)/.test(record.contentType)) {
        throw new Error("Этот тип файла доступен через «Сохранить как».");
      }
      const error = await shell.openPath(await evidence.openEvidence(record));
      if (error) throw new Error("Не удалось открыть файл.");
      return true;
    },
    async revealEvidence(record) {
      return revealFile(shell,await evidence.openEvidence(record));
    },
    async copyEvidencePath(record) {
      require("electron").clipboard.writeText(await evidence.openEvidence(record));
      return true;
    },
    async saveEvidence(record) {
      const result = await dialog.showSaveDialog(window, { title: nativeText("Сохранить доказательство"), defaultPath: path.basename(record.sourcePath) });
      if (result.canceled || !result.filePath) return false;
      await writeFile(result.filePath, await evidence.readEvidence(record), { flag: "wx" });
      return true;
    },
    async saveDiagnostics(report) {
      const result = await dialog.showSaveDialog(window, { title: nativeText("Сохранить диагностику"), defaultPath: "hearth-diagnostics.json" });
      if (result.canceled || !result.filePath) return false;
      await writeFile(result.filePath, JSON.stringify(report, null, 2), { flag: "wx" });
      return true;
    },
    async openProject(root) {
      const error = await shell.openPath(root);
      if (error) throw new Error("Не удалось открыть папку проекта: " + error);
      return true;
    },
    async openArtifact({ root, path }) {
      const error = await shell.openPath(await artifacts.openable(root, path));
      if (error) throw new Error("Не удалось открыть артефакт: " + error);
      return true;
    },
    async revealArtifact({ root, path }) {
      return revealFile(shell,await artifacts.openable(root, path));
    },
    async copyArtifactPath({ root, path }) {
      require("electron").clipboard.writeText(await artifacts.openable(root, path));
      return true;
    },
  });
  ipcMain.handle("hearth:request", async (event, command, payload) => {
    try {
      if (!window || event.sender !== window.webContents ||
          event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== appUrl) {
        throw new Error("Команда доступна из окна Hearth Studio.");
      }
      if (shuttingDown) throw new Error("Hearth Studio завершает работу.");
      return { ok: true, value: await dispatch(command, payload) };
    } catch (error) {
      return { ok: false, error: nativeText(error instanceof Error ? error.message : "Не удалось выполнить команду.") };
    }
  });
  await openWindow();
}
