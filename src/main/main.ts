import {
  BrowserWindow,
  Menu,
  Tray,
  app,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  nativeImage,
  session,
  shell
} from "electron";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AssistantEngine } from "./assistantEngine";
import { LocalDatabase } from "./database";
import { KnowledgeEngine } from "./knowledge";
import { ScreenCaptureService } from "./screenCapture";
import { getRecordFilePath } from "./storage";
import { getActiveWindowTitle } from "./windowContext";
import type { AnswerStyle, AssistantFrame, AssistantStreamEvent, ConversationTurn, KnowledgeSpace, ModelSettings, PrivacySettings } from "../shared/types";

let mainWindow: BrowserWindow | null = null;
let overlayWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let database: LocalDatabase;

const knowledge = new KnowledgeEngine();
const assistant = new AssistantEngine();
const screenCapture = new ScreenCaptureService();
const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);
let lastSmartWindowTitle = "";
let lastSmartCaptureAt = 0;
let lastSmartFingerprint = "";
let lastAnswerFingerprint = "";
let interviewQuestionBuffer = "";
let llmCooldownUntil = 0;
let llmCooldownMessage = "";
let recorderOwnerWebContentsId: number | null = null;

type ConversationStreamFactory = (transcript: string) => {
  onDelta: (delta: string) => void;
  done: (frame: AssistantFrame) => void;
  error: (error: unknown) => void;
};

function writeRuntimeLog(event: string, details: Record<string, unknown> = {}) {
  try {
    fs.appendFileSync(
      getRecordFilePath("runtime.log"),
      `${JSON.stringify({ at: new Date().toISOString(), event, ...details })}\n`,
      "utf-8"
    );
  } catch {
    // Logging must never break the assistant runtime.
  }
}

function findWebContents(id: number) {
  return BrowserWindow.getAllWindows()
    .map((window) => window.webContents)
    .find((webContents) => webContents.id === id);
}

function releaseRecorderOwnerForWebContentsId(webContentsId: number | null) {
  if (webContentsId !== null && recorderOwnerWebContentsId === webContentsId) {
    writeRuntimeLog("voice:release-window", { ownerId: recorderOwnerWebContentsId });
    recorderOwnerWebContentsId = null;
  }
}

function releaseRecorderOwnerForWindow(window: BrowserWindow | null) {
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
    return;
  }
  releaseRecorderOwnerForWebContentsId(window.webContents.id);
}

function getAssetPath(filename: string) {
  const candidates = [
    path.join(__dirname, "../assets", filename),
    path.join(__dirname, "../../src/assets", filename),
    path.join(process.cwd(), "src/assets", filename)
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
}

function getMenuIcon(filename: string) {
  const icon = nativeImage.createFromPath(getAssetPath(filename));
  return icon.isEmpty() ? undefined : icon.resize({ width: 18, height: 18 });
}

function createWindow() {
  const appIcon = nativeImage.createFromPath(getAssetPath("app-icon.png"));
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 840,
    icon: appIcon,
    minWidth: 1080,
    minHeight: 720,
    frame: false,
    title: "知时客",
    backgroundColor: "#f5f9ff",
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  loadRenderer(mainWindow);
  const mainWebContentsId = mainWindow.webContents.id;
  mainWindow.on("closed", () => {
    releaseRecorderOwnerForWebContentsId(mainWebContentsId);
    mainWindow = null;
  });
}

function createOverlayWindow() {
  if (overlayWindow) {
    overlayWindow.show();
    return;
  }

  const { width, height } = getWorkArea();
  const overlayWidth = Math.min(1120, width - 80);
  const overlayHeight = Math.min(560, height - 80);
  overlayWindow = new BrowserWindow({
    width: overlayWidth,
    height: overlayHeight,
    x: Math.max(24, Math.floor((width - overlayWidth) / 2)),
    y: Math.max(24, height - overlayHeight - 40),
    frame: false,
    transparent: true,
    resizable: true,
    movable: true,
    minWidth: 420,
    minHeight: 180,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: true,
    hasShadow: false,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  overlayWindow.setAlwaysOnTop(true, "screen-saver");
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });
  loadRenderer(overlayWindow, true);
  const overlayWebContentsId = overlayWindow.webContents.id;
  overlayWindow.on("closed", () => {
    releaseRecorderOwnerForWebContentsId(overlayWebContentsId);
    overlayWindow = null;
  });
}

function loadRenderer(window: BrowserWindow, overlay = false) {
  if (isDev) {
    const suffix = overlay ? "?overlay=1" : "";
    void window.loadURL(`${process.env.VITE_DEV_SERVER_URL!}${suffix}`);
    return;
  }

  const query = overlay ? { overlay: "1" } : undefined;
  if (process.env.ELECTRON_START_URL) {
    void window.loadFile(path.resolve(process.env.ELECTRON_START_URL), { query });
  } else {
    void window.loadFile(path.join(__dirname, "../renderer/index.html"), { query });
  }
}

function createTray() {
  const icon = nativeImage.createFromPath(getAssetPath("tray-icon.png"));
  tray = new Tray(icon);
  updateTrayMenu();
  return;
  tray!.setToolTip("知时客桌面助手");
  tray!.setContextMenu(
    Menu.buildFromTemplate([
      { label: "显示/隐藏助手", click: toggleWindow },
      { label: "显示悬浮建议条", click: createOverlayWindow },
      { label: "隐藏悬浮建议条", click: () => overlayWindow?.hide() },
      {
        label: "暂停/继续监控",
        click: () => {
          const next = database.updatePrivacy({ paused: !database.getPrivacy().paused });
          broadcastPrivacy(next);
        }
      },
      { type: "separator" },
      { label: "退出", click: () => app.quit() }
    ])
  );
}

function updateTrayMenu() {
  if (!tray) {
    return;
  }

  const privacy = database.getPrivacy();
  tray.setToolTip("知时客桌面助手");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "显示/隐藏助手", click: toggleWindow },
      { label: "显示悬浮建议条", click: createOverlayWindow },
      { label: "隐藏悬浮建议条", click: () => overlayWindow?.hide() },
      {
        label: privacy.paused ? "继续监控" : "暂停监控",
        icon: getMenuIcon(privacy.paused ? "menu-play.png" : "menu-pause.png"),
        click: () => updatePrivacyAndBroadcast({ paused: !database.getPrivacy().paused })
      },
      { type: "separator" },
      {
        label: "切换模式",
        submenu: [
          {
            label: "答题模式",
            type: "radio",
            checked: privacy.monitorMode === "screen",
            click: () => updatePrivacyAndBroadcast({ monitorMode: "screen" })
          },
          {
            label: "会议模式",
            type: "radio",
            checked: privacy.monitorMode === "meeting",
            click: () => updatePrivacyAndBroadcast({ monitorMode: "meeting" })
          },
          {
            label: "面试模式",
            type: "radio",
            checked: privacy.monitorMode === "interview",
            click: () => updatePrivacyAndBroadcast({ monitorMode: "interview" })
          },
        ]
      },
      { type: "separator" },
      { label: "退出", click: () => app.quit() }
    ])
  );
}

function registerShortcuts() {
  globalShortcut.register("CommandOrControl+Shift+Space", toggleWindow);
  globalShortcut.register("CommandOrControl+Shift+O", () => {
    if (!overlayWindow || !overlayWindow.isVisible()) {
      createOverlayWindow();
    } else {
      overlayWindow.hide();
    }
  });
  globalShortcut.register("CommandOrControl+Shift+P", () => {
    updatePrivacyAndBroadcast({ paused: !database.getPrivacy().paused });
  });
  globalShortcut.register("CommandOrControl+Shift+S", () => {
    mainWindow?.webContents.send("assistant:summary-requested");
  });
}

function toggleWindow() {
  if (!mainWindow) {
    createWindow();
    return;
  }
  if (mainWindow.isVisible()) {
    mainWindow.hide();
  } else {
    mainWindow.show();
    mainWindow.focus();
  }
}

function registerPermissions() {
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(["media", "display-capture"].includes(permission));
  });
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 1, height: 1 } });
      const primaryScreen = sources[0];
      if (!primaryScreen) {
        callback({});
        return;
      }
      callback({
        video: primaryScreen,
        audio: process.platform === "win32" ? "loopback" : undefined
      });
    } catch (error) {
      console.warn("[capture] display media request failed", error);
      callback({});
    }
  });
}

function registerIpc() {
  ipcMain.handle("voice:claim-recorder", (event, input: { preferOverlay?: boolean } | undefined) => {
    const requesterId = event.sender.id;
    const owner = recorderOwnerWebContentsId ? findWebContents(recorderOwnerWebContentsId) : undefined;

    if (!owner || owner.isDestroyed()) {
      recorderOwnerWebContentsId = requesterId;
      writeRuntimeLog("voice:claim", { requesterId, preferred: Boolean(input?.preferOverlay), result: "granted-empty" });
      return true;
    }

    if (recorderOwnerWebContentsId === requesterId) {
      return true;
    }

    if (input?.preferOverlay) {
      owner.send("voice:recorder-revoked");
      recorderOwnerWebContentsId = requesterId;
      writeRuntimeLog("voice:claim", { requesterId, previousOwnerId: owner.id, preferred: true, result: "granted-takeover" });
      return true;
    }

    writeRuntimeLog("voice:claim", { requesterId, ownerId: recorderOwnerWebContentsId, preferred: false, result: "denied-owned" });
    return false;
  });

  ipcMain.handle("voice:release-recorder", (event) => {
    if (recorderOwnerWebContentsId === event.sender.id) {
      writeRuntimeLog("voice:release", { ownerId: recorderOwnerWebContentsId });
      recorderOwnerWebContentsId = null;
      broadcastPrivacy(database.getPrivacy());
    }
  });

  ipcMain.handle("app:snapshot", async () => {
    const lastAssistant = database.getAssistant() ?? buildModePlaceholder(database.getPrivacy().monitorMode);
    database.saveAssistant(lastAssistant);
    return {
      documents: database.listDocuments(),
      privacy: database.getPrivacy(),
      model: database.getModel(),
      conversationTurns: database.listTodayConversationTurns(),
      conversationSessions: database.listConversationSessions(),
      assistant: lastAssistant
    };
  });

  ipcMain.handle("knowledge:import", async (_event, space: KnowledgeSpace) => {
    const result = await dialog.showOpenDialog({
      title: "导入知识库资料",
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "Knowledge files", extensions: ["pdf", "docx", "md", "txt"] }]
    });

    if (result.canceled) {
      return database.listDocuments();
    }

    for (const filePath of result.filePaths) {
      try {
        const indexed = await knowledge.indexFile(filePath, space);
        database.saveDocument(indexed.record, indexed.chunks);
      } catch (error) {
        const message = error instanceof Error ? error.message : "导入失败";
        database.saveDocument(
          {
            id: `${Date.now()}-${path.basename(filePath)}`,
            name: path.basename(filePath),
            path: filePath,
            space,
            importedAt: new Date().toISOString(),
            chunkCount: 0,
            status: "failed",
            error: message
          },
          []
        );
      }
    }

    return database.listDocuments();
  });

  ipcMain.handle("knowledge:list", () => database.listDocuments());
  ipcMain.handle("knowledge:remove", (_event, documentId: string) => {
    database.removeDocument(documentId);
    return database.listDocuments();
  });
  ipcMain.handle("knowledge:update-personal-prompt", (_event, personalPrompt: string) => {
    return database.updatePersonalPrompt(personalPrompt);
  });
  ipcMain.handle("assistant:update-answer-style", (_event, answerStyle: AnswerStyle) => {
    return database.updateAnswerStyle(answerStyle);
  });

  ipcMain.handle("assistant:ask", async (_event, question: string) => {
    const screenContext = screenCapture.getLastContext();
    const frame = await assistant.answerWithContext(
      question,
      buildPersonalHiddenContext(),
      database.getChunks(),
      database.getModel(),
      "手动提问",
      question,
      screenContext.text
    );
    database.saveAssistant(frame);
    return frame;
  });

  ipcMain.handle("assistant:tick", async () => {
    if (database.getPrivacy().paused) {
      return database.getAssistant();
    }

    const privacy = database.getPrivacy();
    if (privacy.monitorMode === "screen" || privacy.monitorMode === "meeting" || privacy.monitorMode === "interview") {
      return database.getAssistant();
    }

    const model = database.getModel();
    if (privacy.monitorMode === "smart") {
      const title = await getActiveWindowTitle();
      const now = Date.now();
      const probe = await screenCapture.captureProbe({ appBlacklist: privacy.appBlacklist });
      const titleChanged = privacy.smartObserveWindowChange && Boolean(title) && title !== lastSmartWindowTitle;
      const visualDistance = fingerprintDistance(lastSmartFingerprint, probe.fingerprint);
      const visualChanged = Boolean(probe.fingerprint) && (!lastSmartFingerprint || visualDistance >= 28);
      const debounced = now - lastSmartCaptureAt < 3000;

      if ((!titleChanged && !visualChanged) || debounced) {
        return database.getAssistant();
      }

      lastSmartWindowTitle = title || lastSmartWindowTitle;
      lastSmartFingerprint = probe.fingerprint || lastSmartFingerprint;
      lastSmartCaptureAt = now;
    }

    const screenContext = await screenCapture.captureContext({
      appBlacklist: privacy.appBlacklist,
      includeOcr: privacy.localOcrEnabled,
      includeImage: privacy.visionUnderstandingEnabled && model.visionEnabled
    });
    const frame =
      false
        ? await assistant.answerScreenQuestion(
            {
              screenText: screenContext.text,
              screenshotDataUrl: screenContext.imageDataUrl,
              hiddenContext: buildPersonalHiddenContext(),
              model
            },
            database.getChunks()
          )
        : await assistant.observe(
            {
              sourceApp: screenContext.sourceApp,
              screenText: screenContext.text,
              screenshotDataUrl: screenContext.imageDataUrl,
              hiddenContext: buildPersonalHiddenContext(),
              model
            },
            database.getChunks()
          );
    database.saveAssistant(frame);
    recordWorkEventIfNeeded(frame);
    return frame;
  });

  ipcMain.handle("assistant:regenerate-page-answer", async () => {
    if (database.getPrivacy().paused) {
      return database.getAssistant();
    }
    return regenerateAnswerForCurrentPage(true);
  });

  ipcMain.handle("assistant:transcribe-audio-only", async (_event, input: { data: ArrayBuffer; mimeType: string }) => {
    const privacy = database.getPrivacy();
    if (privacy.paused) {
      writeRuntimeLog("transcribe:skip-paused", { mode: privacy.monitorMode, bytes: input.data.byteLength, mimeType: input.mimeType });
      return "";
    }

    const model = database.getModel();
    if (!model.transcriptionEnabled || model.transcriptionProvider === "disabled") {
      writeRuntimeLog("transcribe:skip-disabled", {
        mode: privacy.monitorMode,
        provider: model.transcriptionProvider,
        enabled: model.transcriptionEnabled
      });
      return "";
    }

    try {
      const transcript = (await assistant.transcribeAudio(input.data, input.mimeType, model)).trim();
      writeRuntimeLog("transcribe:ok", {
        mode: privacy.monitorMode,
        source: model.transcriptionAudioSource,
        provider: model.transcriptionProvider,
        serviceType: model.xfyunServiceType,
        bytes: input.data.byteLength,
        transcriptLength: transcript.length
      });
      return transcript;
    } catch (error) {
      writeRuntimeLog("transcribe:error", {
        mode: privacy.monitorMode,
        source: model.transcriptionAudioSource,
        provider: model.transcriptionProvider,
        serviceType: model.xfyunServiceType,
        bytes: input.data.byteLength,
        message: error instanceof Error ? error.message : String(error)
      });
      console.warn("[transcribe-only]", error);
      return "";
    }
  });

  ipcMain.handle("assistant:analyze-transcript", async (event, transcript: string) => {
    const privacy = database.getPrivacy();
    if (privacy.paused || !transcript.trim()) {
      writeRuntimeLog("analyze:skip", { mode: privacy.monitorMode, paused: privacy.paused, transcriptLength: transcript.trim().length });
      return database.getAssistant();
    }
    writeRuntimeLog("analyze:start", { mode: privacy.monitorMode, transcriptLength: transcript.trim().length });
    return processTranscribedText(transcript.trim(), database.getModel(), createAssistantStreamFactory(event.sender));
  });

  ipcMain.handle("assistant:transcribe-audio", async (_event, input: { data: ArrayBuffer; mimeType: string }) => {
    const privacy = database.getPrivacy();
    if (privacy.paused) {
      writeRuntimeLog("transcribe-full:skip-paused", { mode: privacy.monitorMode, bytes: input.data.byteLength, mimeType: input.mimeType });
      return database.getAssistant();
    }

    const model = database.getModel();
    if (!model.transcriptionEnabled || model.transcriptionProvider === "disabled") {
      writeRuntimeLog("transcribe-full:skip-disabled", {
        mode: privacy.monitorMode,
        provider: model.transcriptionProvider,
        enabled: model.transcriptionEnabled
      });
      return database.getAssistant();
    }

    let transcript = "";
    try {
      transcript = (await assistant.transcribeAudio(input.data, input.mimeType, model)).trim();
      writeRuntimeLog("transcribe-full:ok", {
        mode: privacy.monitorMode,
        source: model.transcriptionAudioSource,
        provider: model.transcriptionProvider,
        serviceType: model.xfyunServiceType,
        bytes: input.data.byteLength,
        transcriptLength: transcript.length
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "语音转写失败，请检查配置。";
      const frame = await assistant.observe(
        {
          sourceApp: "语音转写",
          transcript: `语音转写失败：${message}`,
          screenText: "",
          model
        },
        database.getChunks()
      );
      database.saveAssistant(frame);
      recordConversationTurn(frame);
      return frame;
    }

    if (!transcript) {
      const frame = await assistant.observe(
        {
          sourceApp: "语音转写",
          transcript: "未收到有效语音转写结果。请确认正在说话、音频来源正确，并检查转写服务版本和授权是否可用。",
          screenText: "",
          model
        },
        database.getChunks()
      );
      database.saveAssistant(frame);
      recordConversationTurn(frame);
      return frame;
    }

    return processTranscribedText(transcript, model);
  });

  ipcMain.handle("capture:sources", async () => {
    const sources = await desktopCapturer.getSources({ types: ["window", "screen"], thumbnailSize: { width: 240, height: 140 } });
    return sources.slice(0, 12).map((source) => ({ id: source.id, name: source.name }));
  });

  ipcMain.handle("privacy:update", (_event, next: Partial<PrivacySettings>) => updatePrivacyAndBroadcast(next));

  ipcMain.handle("model:update", (_event, next: Partial<ModelSettings>) => updateModelSafely(next));

  ipcMain.handle("conversation:update-title", (_event, input: { sessionId: string; title: string }) =>
    database.updateConversationSessionTitle(input.sessionId, input.title)
  );
  ipcMain.handle("conversation:end-session", () => {
    database.endActiveConversationSession();
    interviewQuestionBuffer = "";
    return database.listConversationSessions();
  });

  ipcMain.handle("shell:open-path", (_event, filePath: string) => shell.showItemInFolder(filePath));
  ipcMain.handle("window:control", (event, action: "minimize" | "maximize" | "close") => {
    const target = BrowserWindow.fromWebContents(event.sender);
    if (!target) return;
    if (action === "minimize") {
      target.minimize();
      return;
    }
    if (action === "maximize") {
      target.isMaximized() ? target.unmaximize() : target.maximize();
      return;
    }
    target.close();
  });
  ipcMain.handle("overlay:set-ignore-mouse-events", (event, ignore: boolean) => {
    const target = BrowserWindow.fromWebContents(event.sender);
    if (!target || target !== overlayWindow || target.isDestroyed()) {
      return;
    }
    target.setIgnoreMouseEvents(ignore, { forward: true });
  });
  ipcMain.on("overlay:move-by", (event, delta: { x: number; y: number }) => {
    const target = BrowserWindow.fromWebContents(event.sender);
    if (!target || target !== overlayWindow || target.isDestroyed()) {
      return;
    }
    const x = Number(delta?.x);
    const y = Number(delta?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y) || (x === 0 && y === 0)) {
      return;
    }
    const [left, top] = target.getPosition();
    target.setPosition(Math.round(left + x), Math.round(top + y), false);
  });
}

async function repairKnowledgeIndexIfNeeded() {
  const documents = database.listDocuments();
  for (const document of documents) {
    const chunks = database.getChunks().filter((chunk) => chunk.documentId === document.id);
    if (!shouldRepairDocumentIndex(document, chunks)) {
      continue;
    }

    try {
      writeRuntimeLog("knowledge:repair-start", { documentId: document.id, name: document.name, chunkCount: chunks.length });
      const indexed = await knowledge.indexFile(document.path, document.space);
      database.saveDocument({ ...indexed.record, id: document.id, importedAt: new Date().toISOString() }, indexed.chunks.map((chunk) => ({
        ...chunk,
        id: `${document.id}:${chunk.index}`,
        documentId: document.id
      })));
      writeRuntimeLog("knowledge:repair-ok", { documentId: document.id, name: document.name, chunkCount: indexed.chunks.length });
    } catch (error) {
      writeRuntimeLog("knowledge:repair-error", {
        documentId: document.id,
        name: document.name,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }
}

function shouldRepairDocumentIndex(document: { name: string; chunkCount: number }, chunks: Array<{ text: string }>) {
  if (chunks.length === 0 || document.chunkCount !== chunks.length) {
    return true;
  }
  if (!/\.pdf$/i.test(document.name)) {
    return false;
  }
  return chunks.slice(0, 5).some((chunk) => looksLikePdfBinaryChunk(chunk.text));
}

function looksLikePdfBinaryChunk(text: string) {
  const sample = text.slice(0, 1200);
  if (/^%PDF-\d\.\d/.test(sample) || /\/Type\s*\/Page|endobj|stream/i.test(sample)) {
    return true;
  }
  const replacementChars = (sample.match(/�/g) ?? []).length;
  return sample.length > 0 && replacementChars / sample.length > 0.03;
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  database = new LocalDatabase();
  registerPermissions();
  registerIpc();
  void repairKnowledgeIndexIfNeeded();
  createWindow();
  createOverlayWindow();
  createTray();
  registerShortcuts();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
      createOverlayWindow();
    }
  });
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});

app.on("window-all-closed", () => {
  mainWindow?.hide();
});

function getWorkArea() {
  const { screen } = require("electron") as typeof import("electron");
  return screen.getPrimaryDisplay().workArea;
}

function broadcastPrivacy(settings: PrivacySettings) {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send("privacy:changed", settings);
  }
}

function updatePrivacyAndBroadcast(next: Partial<PrivacySettings>) {
  const previous = database.getPrivacy();
  const normalizedNext = { ...next };
  if (normalizedNext.monitorMode === "smart") {
    normalizedNext.monitorMode = "screen";
  }
  if ((normalizedNext.monitorMode as string | undefined) === "combined") {
    normalizedNext.monitorMode = "meeting";
  }
  const modeChanged = Boolean(normalizedNext.monitorMode && normalizedNext.monitorMode !== previous.monitorMode);
  if (modeChanged && normalizedNext.paused === undefined) {
    normalizedNext.paused = false;
  }
  if (
    (normalizedNext.paused === true && !previous.paused) ||
    modeChanged
  ) {
    database.endActiveConversationSession();
    interviewQuestionBuffer = "";
  }
  const settings = database.updatePrivacy(normalizedNext);
  writeRuntimeLog("privacy:update", {
    previousMode: previous.monitorMode,
    nextMode: settings.monitorMode,
    previousPaused: previous.paused,
    nextPaused: settings.paused,
    requested: Object.keys(next)
  });
  if (modeChanged) {
    lastAnswerFingerprint = "";
    lastSmartFingerprint = "";
    database.saveAssistant(buildModePlaceholder(settings.monitorMode));
  }
  broadcastPrivacy(settings);
  updateTrayMenu();
  return settings;
}

function updateModelSafely(next: Partial<ModelSettings>) {
  const merged = { ...database.getModel(), ...next };
  if (merged.transcriptionProvider === "xfyun" && isXfyunMaasEndpoint(merged.xfyunEndpoint)) {
    database.endActiveConversationSession();
    interviewQuestionBuffer = "";
    return database.updateModel({
      ...next,
      transcriptionEnabled: false,
      transcriptionProvider: "disabled"
    });
  }
  return database.updateModel(next);
}

function isXfyunMaasEndpoint(endpoint = "") {
  return /(^|\/\/)maas-api\./i.test(endpoint) || /\/v1(?:\.\d+)?\/chat(?:$|\?)/i.test(endpoint);
}

function recordWorkEventIfNeeded(frame: Awaited<ReturnType<AssistantEngine["answer"]>>) {
  return frame;
}

function isLlmCoolingDown() {
  return Date.now() < llmCooldownUntil;
}

function setLlmCooldown(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  llmCooldownUntil = Date.now() + 90_000;
  llmCooldownMessage = message;
  console.warn("[llm] rate limited, cooling down for 90s", message);
}

function isRateLimitError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /429|rate.?limit|limit_requests|exceeded your current request limit/i.test(message);
}

function buildModePlaceholder(mode: PrivacySettings["monitorMode"]): AssistantFrame {
  const labels: Record<PrivacySettings["monitorMode"], { sourceApp: string; title: string; answer: string; steps: string[] }> = {
    smart: {
      sourceApp: "答题模式",
      title: "等待识别题目",
      answer: "答题模式已就绪。点击发送题目后才会截屏并生成题目、解法、代码和复杂度。",
      steps: ["打开题目页面", "点击发送题目", "查看解答"]
    },
    screen: {
      sourceApp: "答题模式",
      title: "等待识别题目",
      answer: "答题模式已就绪。不会自动请求 AI，点击发送题目后才会截屏并生成题目、解法、代码和复杂度。",
      steps: ["打开题目页面", "点击发送题目", "查看解答"]
    },
    meeting: {
      sourceApp: "会议模式",
      title: "等待会议语音",
      answer: "会议模式已就绪。识别到语音后会显示转写内容并流式生成纪要/建议。",
      steps: ["确认音频来源", "开始讲话", "等待实时转写"]
    },
    interview: {
      sourceApp: "面试模式",
      title: "等待面试官提问",
      answer: "面试模式已就绪。识别到提问后会显示输入，并生成可直接口述的回答。",
      steps: ["确认音频来源", "等待提问", "生成候选回答"]
    }
  };
  const label = labels[mode];
  return {
    id: `placeholder-${mode}-${Date.now()}-${randomUUID()}`,
    createdAt: new Date().toISOString(),
    sourceApp: label.sourceApp,
    transcript: "",
    detectedQuestion: label.title,
    translation: label.title,
    summary: label.answer,
    suggestedAnswer: label.answer,
    nextSteps: label.steps,
    citations: []
  };
}

function buildListeningFrame(sourceApp: string, transcript: string): AssistantFrame {
  const text = transcript.trim();
  return {
    id: `listening-${Date.now()}-${randomUUID()}`,
    createdAt: new Date().toISOString(),
    sourceApp,
    transcript: text,
    detectedQuestion: text || "正在听取问题",
    translation: text || "正在听取问题",
    summary: "已收到语音片段，等待完整问题。",
    suggestedAnswer: "已识别到输入，正在等待一句完整问题后再生成回答。",
    nextSteps: ["继续听取", "问题说完后分析", "生成候选回答"],
    citations: []
  };
}

function buildCooldownFrame(sourceApp: string, transcript = "") {
  const waitSeconds = Math.max(1, Math.ceil((llmCooldownUntil - Date.now()) / 1000));
  const text = `云端模型触发 429 限流，已暂停自动分析约 ${waitSeconds} 秒。`;
  return {
    id: `cooldown-${Date.now()}-${randomUUID()}`,
    createdAt: new Date().toISOString(),
    sourceApp,
    transcript,
    detectedQuestion: transcript || "模型限流中",
    translation: text,
    summary: text,
    suggestedAnswer: `${text}\n\n这不是视觉模型 Base URL 或模型名错误，而是供应商当前请求频率超限。冷却结束前不会继续自动请求。\n\n${llmCooldownMessage}`,
    nextSteps: ["等待冷却结束", "降低自动监控频率", "稍后重新生成"],
    citations: []
  };
}

async function regenerateAnswerForCurrentPage(force: boolean) {
  if (!force && isLlmCoolingDown()) {
    const frame = buildCooldownFrame("答题模式");
    return database.getAssistant() ?? frame;
  }
  const privacy = database.getPrivacy();
  const model = database.getModel();
  const probe = await withOverlayHidden(() => screenCapture.captureProbe({ appBlacklist: privacy.appBlacklist }));
  const changed = Boolean(probe.fingerprint) && (!lastAnswerFingerprint || fingerprintDistance(lastAnswerFingerprint, probe.fingerprint) >= 18);

  if (!force && !changed) {
    return database.getAssistant();
  }

  const screenContext = await withOverlayHidden(() =>
    screenCapture.captureContext({
      appBlacklist: privacy.appBlacklist,
      includeOcr: true,
      includeImage: true
    })
  );
  let frame;
  try {
    frame = await assistant.answerScreenQuestion(
      {
        screenText: screenContext.text,
        screenshotDataUrl: screenContext.imageDataUrl,
        hiddenContext: buildPersonalHiddenContext(),
        model
      },
      database.getChunks()
    );
  } catch (error) {
    if (isRateLimitError(error)) {
      setLlmCooldown(error);
      const frame = buildCooldownFrame("答题模式", screenContext.text.slice(0, 220));
      database.saveAssistant(frame);
      return frame;
    }
    throw error;
  }
  lastAnswerFingerprint = probe.fingerprint || lastAnswerFingerprint;
  database.saveAssistant(frame);
  recordWorkEventIfNeeded(frame);
  return frame;
}

async function withOverlayHidden<T>(work: () => Promise<T>): Promise<T> {
  const shouldRestore = Boolean(overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible());
  if (!shouldRestore) {
    return work();
  }

  overlayWindow?.hide();
  await delay(120);
  try {
    return await work();
  } finally {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.showInactive();
      overlayWindow.setAlwaysOnTop(true, "screen-saver");
    }
  }
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildPersonalHiddenContext(extra = "") {
  const personalPrompt = database.getPersonalPrompt().trim();
  const monitorMode = database.getPrivacy().monitorMode;
  const shouldUseAnswerStyle = monitorMode === "meeting" || monitorMode === "interview";
  return [
    personalPrompt ? `Personal profile and answer preferences:\n${personalPrompt}` : "",
    shouldUseAnswerStyle ? `Answer style:\n${answerStyleInstruction(database.getAnswerStyle())}` : "",
    extra.trim()
  ]
    .filter(Boolean)
    .join("\n\n");
}

function answerStyleInstruction(style: AnswerStyle) {
  const instructions: Record<AnswerStyle, string> = {
    concise: "简洁版：先给结论，控制篇幅，少铺垫，回答适合直接复制或口述。",
    interviewer: "面试官友好版：用自然候选人口吻回答，突出动机、个人贡献、协作和结果，避免像背稿。",
    technical: "技术深入版：补充关键技术细节、方案权衡、边界条件、性能/稳定性考虑和可落地实现。",
    project_review: "项目复盘版：按背景、目标、行动、结果、复盘展开，突出问题、取舍、数据结果和改进。",
    english: "英文版：answer primarily in fluent English. Keep the same factual constraints, and only add Chinese when the user explicitly asks."
  };
  return instructions[style];
}

function createAssistantStreamFactory(sender: Electron.WebContents): ConversationStreamFactory {
  return (transcript: string) => {
    const mode = conversationModeForPrivacy(database.getPrivacy().monitorMode);
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const sourceApp = conversationSourceForPrivacy(database.getPrivacy().monitorMode);
    let text = "";

    const send = (payload: Omit<AssistantStreamEvent, "id" | "createdAt" | "mode" | "sourceApp" | "transcript">) => {
      if (sender.isDestroyed()) {
        return;
      }
      sender.send("assistant:stream", {
        id,
        createdAt,
        mode,
        sourceApp,
        transcript,
        ...payload
      } satisfies AssistantStreamEvent);
    };

    send({ phase: "start", text: "" });
    return {
      onDelta: (delta: string) => {
        text += delta;
        send({ phase: "delta", delta, text });
      },
      done: (frame: AssistantFrame) => {
        send({ phase: "done", text: frame.suggestedAnswer, frame });
      },
      error: (error: unknown) => {
        send({ phase: "error", error: error instanceof Error ? error.message : String(error), text });
      }
    };
  };
}

async function processTranscribedText(transcript: string, model: ModelSettings, streamFactory?: ConversationStreamFactory) {
  if (isLlmCoolingDown()) {
    const frame = buildCooldownFrame(conversationSourceForPrivacy(database.getPrivacy().monitorMode), transcript);
    database.saveAssistant(frame);
    if (transcript.trim()) {
      recordConversationTurn(frame);
    }
    return frame;
  }
  const privacy = database.getPrivacy();
  if (privacy.monitorMode === "interview") {
    const question = transcript.trim();
    if (!shouldAnswerInterviewQuestion(question)) {
      const frame = buildListeningFrame(conversationSourceForPrivacy(privacy.monitorMode), question);
      database.saveAssistant(frame);
      return frame;
    }

    const frame = await createConversationFrameWithCooldown(question, model, streamFactory);
    database.saveAssistant(frame);
    recordConversationTurn(frame);
    return frame;
  }

  const speechSentences = splitSpeechSentences(transcript);
  if (speechSentences.length > 1) {
    let latestFrame = database.getAssistant();
    for (const sentence of speechSentences) {
      const frame = await createConversationFrameWithCooldown(sentence, model, streamFactory);
      latestFrame = frame;
      database.saveAssistant(frame);
      recordConversationTurn(frame);
    }
    return latestFrame;
  }

  const frame = await createConversationFrameWithCooldown(transcript, model, streamFactory);
  database.saveAssistant(frame);
  recordConversationTurn(frame);
  return frame;
}

async function createConversationFrameWithCooldown(transcript: string, model: ModelSettings, streamFactory?: ConversationStreamFactory) {
  const stream = streamFactory?.(transcript);
  try {
    const frame = stream?.onDelta
      ? await createStreamingConversationFrame(transcript, model, stream.onDelta)
      : await createConversationFrame(transcript, model);
    stream?.done(frame);
    return frame;
  } catch (error) {
    if (isRateLimitError(error)) {
      setLlmCooldown(error);
      const frame = buildCooldownFrame(conversationSourceForPrivacy(database.getPrivacy().monitorMode), transcript);
      stream?.done(frame);
      return frame;
    }
    stream?.error(error);
    throw error;
  }
}

async function createStreamingConversationFrame(transcript: string, model: ModelSettings, onDelta: (delta: string) => void) {
  const privacy = database.getPrivacy();
  const sourceApp = conversationSourceForPrivacy(privacy.monitorMode);

  if (privacy.monitorMode === "interview") {
    const recentContext = database
      .listTodayConversationTurns()
      .filter((turn) => turn.mode === "interview")
      .slice(-2)
      .map((turn) => `Interviewer: ${turn.transcript}`)
      .join("\n\n");
    const prompt = [
      transcript,
      "",
      "Please answer as the candidate in natural spoken Chinese.",
      "Do not repeat the question. Do not mention recent context.",
      "Structure: conclusion + concrete example/action + result."
    ].join("\n");
    return assistant.answerWithContextStream(
      prompt,
      buildPersonalHiddenContext(recentContext),
      database.getChunks(),
      model,
      onDelta,
      sourceApp,
      transcript,
      ""
    );
  }

  const prompt = [
    transcript,
    "",
    "Please produce a concise Chinese answer or meeting note that can be used immediately.",
    "Do not output JSON."
  ].join("\n");
  return assistant.answerWithContextStream(prompt, buildPersonalHiddenContext(), database.getChunks(), model, onDelta, sourceApp, transcript, "");
}

async function createConversationFrame(transcript: string, model: ModelSettings, onDelta?: (delta: string) => void) {
  const privacy = database.getPrivacy();
  if (privacy.monitorMode === "interview") {
    const recentContext = database
      .listTodayConversationTurns()
      .filter((turn) => turn.mode === "interview")
      .slice(-2)
      .map((turn) => `面试官：${turn.transcript}`)
      .join("\n\n");
    const question = `${transcript}\n\n请给出可直接口述的中文候选回答。不要复述问题，不要输出最近上下文或历史回答。结构：一句结论 + 具体例子/做法 + 结果。`;
    return assistant.answerWithContext(question, buildPersonalHiddenContext(recentContext), database.getChunks(), model, "面试官提问", transcript, "");
  }

  const sourceApp = conversationSourceForPrivacy(privacy.monitorMode);
  return assistant.observe(
    {
      sourceApp,
      transcript,
      screenText: "",
      hiddenContext: buildPersonalHiddenContext(),
      model
    },
    database.getChunks()
  );
}

function conversationSourceForPrivacy(mode: PrivacySettings["monitorMode"]) {
  if (mode === "interview") {
    return "面试官提问";
  }
  return "会议模式";
}

function recordConversationTurn(frame: Awaited<ReturnType<AssistantEngine["answer"]>>) {
  const mode = conversationModeForPrivacy(database.getPrivacy().monitorMode);
  if (isDuplicateConversationTurn(frame, mode)) {
    writeRuntimeLog("conversation:skip-duplicate", {
      mode,
      transcriptLength: frame.transcript.length,
      questionLength: frame.detectedQuestion.length
    });
    return;
  }
  database.addConversationTurn(frame, mode);
}

function isDuplicateConversationTurn(frame: AssistantFrame, mode: ConversationTurn["mode"]) {
  const text = normalizeConversationText(frame.transcript || frame.detectedQuestion);
  if (text.length < 10) {
    return false;
  }

  const now = new Date(frame.createdAt).getTime();
  return database
    .listTodayConversationTurns()
    .filter((turn) => turn.mode === mode)
    .slice(-6)
    .some((turn) => {
      const previousAt = new Date(turn.createdAt).getTime();
      if (!Number.isFinite(previousAt) || Math.abs(now - previousAt) > 10000) {
        return false;
      }
      const previous = normalizeConversationText(turn.transcript || turn.detectedQuestion);
      if (previous.length < 10) {
        return false;
      }
      const shorter = text.length < previous.length ? text : previous;
      const longer = text.length < previous.length ? previous : text;
      if (longer.includes(shorter) && shorter.length / longer.length >= 0.72) {
        return true;
      }
      return tokenOverlapRatio(text, previous) >= 0.82;
    });
}

function normalizeConversationText(text: string) {
  return text
    .toLowerCase()
    .replace(/[\s，。,.？！?!、；;："“”'‘’（）()【】\[\]{}]+/g, "");
}

function tokenOverlapRatio(left: string, right: string) {
  const leftTokens = toCharBigrams(left);
  const rightTokens = toCharBigrams(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0;
  }
  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      overlap += 1;
    }
  }
  return overlap / Math.min(leftTokens.size, rightTokens.size);
}

function toCharBigrams(text: string) {
  const tokens = new Set<string>();
  for (let index = 0; index < text.length - 1; index += 1) {
    tokens.add(text.slice(index, index + 2));
  }
  return tokens;
}

function conversationModeForPrivacy(mode: PrivacySettings["monitorMode"]): ConversationTurn["mode"] {
  if (mode === "interview") {
    return "interview";
  }
  return "meeting";
}

function fingerprintDistance(previous: string, next: string) {
  if (!previous || !next) {
    return Number.POSITIVE_INFINITY;
  }

  const length = Math.min(previous.length, next.length);
  let distance = Math.abs(previous.length - next.length);
  for (let index = 0; index < length; index += 1) {
    if (previous[index] !== next[index]) {
      distance += 1;
    }
  }
  return distance;
}

function mergeSpeechText(previous: string, next: string) {
  const merged = [previous, next]
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(" ");
  return merged.length > 500 ? merged.slice(-500) : merged;
}

function shouldAnswerInterviewQuestion(text: string) {
  const normalized = text.replace(/\s+/g, "").trim();
  if (normalized.length < 4) {
    return false;
  }
  if (/^(嗯|啊|好的|好|可以|收到|继续|然后)$/i.test(normalized)) {
    return false;
  }
  if (/[\uff1f?\u3002.!\uff01]$/.test(normalized) && normalized.length >= 4) {
    return true;
  }
  if (normalized.length >= 6) {
    return true;
  }
  return /(介绍|讲一下|说一下|聊一下|解释|怎么|如何|为什么|什么|哪些|能不能|是否|区别|原理|难点|项目|经历|优势|缺点|规划|离职|薪资|期望)/.test(normalized);
}

function splitSpeechSentences(text: string) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return [];
  }

  const sentences = normalized.match(/[^\u3002\uff01\uff1f!?\uff1b;]+[\u3002\uff01\uff1f!?\uff1b;]?/g) ?? [normalized];
  return sentences.map((sentence) => sentence.trim()).filter(Boolean);
}
