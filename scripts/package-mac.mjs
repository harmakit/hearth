import { packager } from "@electron/packager";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") throw new Error("The macOS build must run on macOS.");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const scratch = resolve(root, ".tmp");
await mkdir(scratch, { recursive: true });
const shipped = /^\/(?:app|core|runtimes|migration|renderer|package\.json)(?:\/|$)/;
const bundles = await packager({
  dir: root,
  out: resolve(root, "dist", version),
  name: "Hearth Studio",
  appBundleId: "local.hearth.studio",
  platform: "darwin",
  arch: process.arch,
  asar: true,
  prune: false,
  osxSign: {
    identity: "-",
    identityValidation: false,
    preAutoEntitlements: false,
    optionsForFile: () => ({ hardenedRuntime: false }),
  },
  overwrite: true,
  tmpdir: scratch,
  download: { cacheRoot: resolve(scratch, "electron-cache") },
  ...(process.env.HEARTH_ELECTRON_ZIP_DIR ? { electronZipDir: process.env.HEARTH_ELECTRON_ZIP_DIR } : {}),
  ignore: file => !shipped.test(file),
});
for (const bundle of bundles) console.log(bundle);
