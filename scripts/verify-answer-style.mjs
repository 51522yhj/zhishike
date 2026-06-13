import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(rootDir, relativePath), "utf8");
}

function assertCheck(checks, name, ok) {
  checks.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
}

async function wait(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDebugTarget(port, timeoutMs = 15000) {
  const startedAt = Date.now();
  let lastError;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json`);
      const targets = await response.json();
      const target = targets.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
      if (target) {
        return target;
      }
    } catch (error) {
      lastError = error;
    }
    await wait(300);
  }
  throw new Error(`Timed out waiting for Electron debug target${lastError ? `: ${lastError.message}` : ""}`);
}

function connectToTarget(webSocketDebuggerUrl) {
  const socket = new WebSocket(webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();

  socket.on("message", (data) => {
    const message = JSON.parse(String(data));
    if (!message.id || !pending.has(message.id)) {
      return;
    }
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) {
      reject(new Error(message.error.message));
    } else {
      resolve(message.result);
    }
  });

  return new Promise((resolve, reject) => {
    socket.once("open", () => {
      resolve({
        send(method, params = {}) {
          const messageId = ++id;
          socket.send(JSON.stringify({ id: messageId, method, params }));
          return new Promise((messageResolve, messageReject) => {
            pending.set(messageId, { resolve: messageResolve, reject: messageReject });
          });
        },
        close() {
          socket.close();
        }
      });
    });
    socket.once("error", reject);
  });
}

function runStaticChecks() {
  const checks = [];
  const sourceApp = read("src/renderer/App.tsx");
  const sourceMain = read("src/main/main.ts");
  const distMain = read("dist/main/main.js");
  const distPreload = read("dist/preload/preload.js");
  const rendererAsset = fs.readdirSync(path.join(rootDir, "dist/renderer/assets")).find((file) => file.endsWith(".js"));
  const distRenderer = read(`dist/renderer/assets/${rendererAsset}`);

  assertCheck(checks, "source main logs and broadcasts answer-style update", sourceMain.includes('writeRuntimeLog("answer-style:update"') && sourceMain.includes("broadcastAnswerStyle(saved)"));
  assertCheck(checks, "dist main contains answer-style changed IPC", distMain.includes("assistant:answer-style-changed"));
  assertCheck(checks, "dist preload exposes answer-style listener", distPreload.includes("onAnswerStyleChanged") && distPreload.includes("assistant:answer-style-changed"));
  assertCheck(checks, "source renderer subscribes to answer-style broadcast", sourceApp.includes("onAnswerStyleChanged(applyAnswerStyleFromMain)"));
  assertCheck(checks, "source renderer clears pending answer style on broadcast", sourceApp.includes("pendingAnswerStyleRef.current = null"));
  assertCheck(checks, "source overlay mirrors answerStyle prop", sourceApp.includes("[props.answerStyle]"));
  assertCheck(checks, "dist renderer contains answer-style listener usage", distRenderer.includes("onAnswerStyleChanged"));
  assertCheck(checks, "answer-style buttons use pointerdown selection", sourceApp.includes("onPointerDown={(event) => chooseStyle(style.id, event)}"));
  assertCheck(checks, "privacy updates do not inject stale answerStyle refs", !sourceApp.includes("answerStyle: answerStyleRef.current") && !sourceApp.includes("answerStyle: overlayAnswerStyleRef.current"));

  const failed = checks.filter((check) => !check.ok);
  if (failed.length) {
    throw new Error(`Static answer-style checks failed: ${failed.map((check) => check.name).join(", ")}`);
  }
  console.log(`Renderer bundle: ${rendererAsset}`);
}

async function runRuntimeCheck() {
  const packagedAppPath = process.argv[2] ? path.resolve(rootDir, process.argv[2]) : process.env.ZHISHIK_VERIFY_EXE;
  const electronBin = packagedAppPath ?? (process.platform === "win32"
    ? path.join(rootDir, "node_modules/electron/dist/electron.exe")
    : path.join(rootDir, "node_modules/.bin/electron"));
  const port = 9400 + Math.floor(Math.random() * 400);
  const child = spawn(electronBin, packagedAppPath ? [`--remote-debugging-port=${port}`] : [".", `--remote-debugging-port=${port}`], {
    cwd: rootDir,
    env: packagedAppPath
      ? process.env
      : {
          ...process.env,
          ELECTRON_START_URL: path.join(rootDir, "dist/renderer/index.html")
        },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });

  let client;
  try {
    const target = await waitForDebugTarget(port);
    client = await connectToTarget(target.webSocketDebuggerUrl);
    await client.send("Runtime.enable");
    const expression = `
      (async () => {
        const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        for (let i = 0; i < 50 && !window.zhishik; i += 1) {
          await delay(100);
        }
        if (!window.zhishik) {
          throw new Error("zhishik preload API is unavailable");
        }
        const original = await window.zhishik.snapshot();
        const buttonIndex = () => Array.from(document.querySelectorAll(".answer-style-picker button")).findIndex((button) => button.classList.contains("selected"));
        try {
          await window.zhishik.updateModel({ transcriptionEnabled: false });
          await window.zhishik.updatePrivacy({ monitorMode: "interview", paused: true });
          await delay(300);
          await window.zhishik.updateAnswerStyle("english");
          await delay(400);
          const beforeResume = await window.zhishik.snapshot();
          const selectedBeforeResume = buttonIndex();
          await window.zhishik.updatePrivacy({ paused: false });
          await delay(600);
          const afterResume = await window.zhishik.snapshot();
          const selectedAfterResume = buttonIndex();
          return {
            beforeResume: beforeResume.answerStyle,
            afterResume: afterResume.answerStyle,
            selectedBeforeResume,
            selectedAfterResume
          };
        } finally {
          await window.zhishik.updateAnswerStyle(original.answerStyle);
          await window.zhishik.updateModel(original.model);
          await window.zhishik.updatePrivacy(original.privacy);
        }
      })()
    `;
    const result = await client.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || "Runtime evaluation failed");
    }
    const value = result.result.value;
    console.log(`Runtime before resume: ${value.beforeResume}, selected index: ${value.selectedBeforeResume}`);
    console.log(`Runtime after resume: ${value.afterResume}, selected index: ${value.selectedAfterResume}`);
    if (value.beforeResume !== "english" || value.afterResume !== "english" || value.selectedAfterResume !== 4) {
      throw new Error(`Runtime answer-style persistence failed: ${JSON.stringify(value)}`);
    }
    console.log("PASS runtime keeps English style after continue monitoring");
  } finally {
    client?.close();
    child.kill();
    await wait(500);
    if (!child.killed) {
      child.kill("SIGKILL");
    }
  }

  if (stderr.trim()) {
    console.log("Electron stderr:");
    console.log(stderr.trim().split(/\r?\n/).slice(-8).join("\n"));
  }
}

runStaticChecks();
await runRuntimeCheck();
