import { app } from "electron";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

export function getStorageRoot() {
  if (process.platform === "win32") {
    return "C:\\zhishike";
  }
  if (process.platform === "darwin") {
    return path.join(app.getPath("documents"), "zhishike");
  }
  return path.join(app.getPath("home"), "zhishike");
}

export function ensureStorageDir(...segments: string[]) {
  const dir = path.join(getStorageRoot(), ...segments);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function getRecordFilePath(filename: string) {
  return path.join(ensureStorageDir("records"), filename);
}

export function getScreenshotFilePath(filename: string, date = new Date()) {
  const day = date.toISOString().slice(0, 10);
  return path.join(ensureStorageDir("screenshots", day), filename);
}
