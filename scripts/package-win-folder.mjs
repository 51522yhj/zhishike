import { execFileSync, execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const releaseDir = path.join(root, "release", "zhishike-win32-x64");
const appDir = path.join(releaseDir, "resources", "app");
const tessDir = path.join(releaseDir, "resources", "tessdata");
const electronDist = path.join(root, "node_modules", "electron", "dist");
const electronExe = path.join(electronDist, "electron.exe");

if (!existsSync(electronExe)) {
  execFileSync(process.execPath, [path.join(root, "node_modules", "electron", "install.js")], {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      ELECTRON_INSTALL_PLATFORM: "win32",
      ELECTRON_INSTALL_ARCH: "x64",
      ELECTRON_MIRROR: process.env.ELECTRON_MIRROR || "https://npmmirror.com/mirrors/electron/"
    }
  });
}

rmSync(releaseDir, { recursive: true, force: true });
mkdirSync(releaseDir, { recursive: true });
cpSync(electronDist, releaseDir, { recursive: true });
renameSync(path.join(releaseDir, "electron.exe"), path.join(releaseDir, "知时客.exe"));
rmSync(path.join(releaseDir, "resources", "default_app.asar"), { force: true });

mkdirSync(appDir, { recursive: true });
mkdirSync(tessDir, { recursive: true });
cpSync(path.join(root, "dist"), path.join(appDir, "dist"), { recursive: true });
cpSync(path.join(root, "package.json"), path.join(appDir, "package.json"));
cpSync(path.join(root, "eng.traineddata"), path.join(tessDir, "eng.traineddata"));
cpSync(path.join(root, "chi_sim.traineddata"), path.join(tessDir, "chi_sim.traineddata"));

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
execSync(`${npmCommand} install --omit=dev --ignore-scripts --prefix "${appDir}"`, {
  cwd: root,
  stdio: "inherit"
});

console.log(`Windows exe created: ${path.join(releaseDir, "知时客.exe")}`);
