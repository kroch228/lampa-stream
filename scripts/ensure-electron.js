#!/usr/bin/env node
// Force-download and extract the Electron binary into node_modules/electron/dist.
//
// The stock electron postinstall (node_modules/electron/install.js) sometimes
// exits 0 without extracting on certain networks/mirrors, and the extract-zip
// npm module can silently hang on the ~200MB Electron zip. Both leave no binary
// and a confusing "Electron failed to install correctly" at launch time. This
// script is a belt-and-suspenders fallback: download via @electron/get (npmmirror
// CDN), then extract with the system unzip/PowerShell (fast, reliable) and write
// path.txt. Idempotent: skips if the binary already exists and matches version.

const { downloadArtifact } = require("@electron/get");
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const electronPkg = require("../node_modules/electron/package.json");
const version = electronPkg.version;
const electronDir = path.resolve(__dirname, "..", "node_modules", "electron");
const distDir = path.join(electronDir, "dist");

const platformPath =
  process.platform === "win32"
    ? "electron.exe"
    : process.platform === "darwin"
      ? "Electron.app/Contents/MacOS/Electron"
      : "electron";

function isInstalled() {
  try {
    const ver = fs.readFileSync(path.join(distDir, "version"), "utf-8").replace(/^v/, "");
    if (ver !== version) return false;
    if (fs.readFileSync(path.join(electronDir, "path.txt"), "utf-8") !== platformPath) return false;
    return fs.existsSync(path.join(distDir, platformPath));
  } catch {
    return false;
  }
}

function extractZip(zipPath) {
  // Prefer the system unzip (handles the large Electron zip reliably). Fall back
  // to PowerShell Expand-Archive on Windows, then Python's zipfile.
  fs.rmSync(distDir, { recursive: true, force: true });
  fs.mkdirSync(distDir, { recursive: true });
  if (process.platform === "win32") {
    const cmd =
      "Expand-Archive -LiteralPath '" + zipPath + "' -DestinationPath '" + distDir + "' -Force";
    execFileSync("powershell.exe", ["-NoProfile", "-Command", cmd], { stdio: "inherit" });
    return;
  }
  try {
    execFileSync("unzip", ["-o", "-q", zipPath, "-d", distDir], { stdio: "inherit" });
    return;
  } catch {}
  execFileSync(
    "python3",
    ["-c", "from zipfile import ZipFile; import sys; ZipFile(sys.argv[1]).extractall(sys.argv[2])", zipPath, distDir],
    { stdio: "inherit" },
  );
}

(async () => {
  if (isInstalled()) {
    console.log("[ensure-electron] v" + version + " already installed, skipping.");
    return;
  }
  const platform = process.env.npm_config_platform || process.platform;
  const arch = process.env.npm_config_arch || process.arch;
  const mirror = process.env.ELECTRON_MIRROR || "https://npmmirror.com/mirrors/electron/";
  console.log("[ensure-electron] downloading v" + version + " " + platform + "-" + arch + " from " + mirror + " ...");
  try {
    const zipPath = await downloadArtifact({
      version,
      artifactName: "electron",
      platform,
      arch,
      mirrorOptions: { mirror },
    });
    extractZip(zipPath);
    fs.writeFileSync(path.join(electronDir, "path.txt"), platformPath);
    console.log("[ensure-electron] OK -> node_modules/electron/dist/" + platformPath);
  } catch (e) {
    console.error("[ensure-electron] FAILED:", e && e.message ? e.message : e);
    console.error(
      "[ensure-electron] Manual fix: download electron-v" + version + "-" + platform + "-" + arch + ".zip from\n" +
        "  https://github.com/electron/electron/releases, extract into node_modules/electron/dist/,\n" +
        "  and write '" + platformPath + "' into node_modules/electron/path.txt.",
    );
    // Non-fatal: don't break npm install. npm start surfaces the issue.
    process.exit(0);
  }
})();
