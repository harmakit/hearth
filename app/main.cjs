const { app, BrowserWindow, dialog, ipcMain, net, Notification, powerMonitor, protocol, shell } = require("electron");
const { existsSync, mkdirSync } = require("node:fs");
const { homedir } = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

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
let shuttingDown = false;
let scheduleTimer;
const notifications = new Set();

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => { openWindow().catch(console.error); });
  app.on("activate", () => { openWindow().catch(console.error); });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app.on("before-quit", event => {
    if (!service || shuttingDown) return;
    event.preventDefault();
    shuttingDown = true;
    clearInterval(scheduleTimer);
    Promise.resolve().then(() => service.close()).catch(console.error).finally(() => app.quit());
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

function broadcast() {
  if (window && !window.isDestroyed() && window.webContents.getURL() === appUrl) {
    window.webContents.send("hearth:snapshot", service.snapshot());
  }
}

function notify({ title, studioId, inboxId }) {
  if (shuttingDown || !Notification.isSupported()) return;
  const notice = new Notification({
    title: "Hearth Studio",
    body: title || "В студии новое сообщение",
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
  const options = { properties: ["openDirectory", "createDirectory"], title: "Выбрать или создать папку проекта" };
  const result = window && !window.isDestroyed()
    ? await dialog.showOpenDialog(window, options)
    : await dialog.showOpenDialog(options);
  return result.canceled ? null : result.filePaths[0] ?? null;
}

async function pickBundle() {
  const options = {
    properties: ["openFile"],
    title: "Открыть снимок Hearth Studio",
    filters: [{ name: "Шаблон или снимок Hearth Studio", extensions: ["json"] }],
  };
  const result = window && !window.isDestroyed() ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
  return result.canceled ? null : result.filePaths[0] ?? null;
}

async function saveBundle(studioName, mode) {
  const filename = studioName.replace(/[/\\:\u0000-\u001f]/g, "-").slice(0, 100) || "Hearth";
  const options = {
    title: "Экспорт студии",
    defaultPath: filename + (mode === "template" ? "-template" : "-snapshot") + ".hearth.json",
    filters: [{ name: "Экспорт Hearth Studio", extensions: ["json"] }],
  };
  const result = window && !window.isDestroyed() ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
  return result.canceled ? null : result.filePath ?? null;
}

async function start() {
  const [
    { createCommandRouter, isWithin, validateProjectRoot },
    { createStudioService },
    { run, inspect },
    { previewImport },
    { createArtifactStore },
    { createTransferController },
    { createGitHubSkillFinder },
  ] = await Promise.all([
    import("./bridge.mjs"),
    import("../core/service.mjs"),
    import("../runtimes/index.mjs"),
    import("../migration/preview.mjs"),
    import("./artifacts.mjs"),
    import("./transfer.mjs"),
    import("./github-skills.mjs"),
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
  const { findSkills } = createGitHubSkillFinder();
  service = createStudioService({
    dbPath: path.join(dataDir, "studio.sqlite3"),
    run: async request => run({ ...request, projectRoot: await validateRoot(request.projectRoot) }),
    writeArtifact: artifacts.write,
    findSkills,
    onChange: broadcast,
    notify,
  });
  const transfer = createTransferController({
    service, artifacts, pickBundle, saveBundle, journalDir: path.join(dataDir, "import-journal"),
  });
  const failedImports = await transfer.recover();
  if (failedImports.length) console.warn("Hearth Studio: часть импортов ожидает восстановления.", failedImports.length);
  function refreshSchedules() {
    if (shuttingDown) return;
    try { service.refreshSchedules(); } catch (error) { console.error(error); }
  }
  refreshSchedules();
  scheduleTimer = setInterval(refreshSchedules, 15000);
  scheduleTimer.unref();
  powerMonitor.on("resume", refreshSchedules);
  const dispatch = createCommandRouter({
    service, selectFolder: pickFolder, inspect, previewImport, findSkills, transfer, protectedRoots,
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
      return { ok: false, error: error instanceof Error ? error.message : "Не удалось выполнить команду." };
    }
  });
  await openWindow();
}
