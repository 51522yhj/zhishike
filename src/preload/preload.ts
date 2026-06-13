import { contextBridge, ipcRenderer } from "electron";
import type {
  AppSnapshot,
  AssistantFrame,
  AssistantStreamEvent,
  AnswerStyle,
  ConversationSessionWithTurns,
  DocumentRecord,
  KnowledgeSpace,
  ModelSettings,
  PrivacySettings
} from "../shared/types";

const api = {
  snapshot: () => ipcRenderer.invoke("app:snapshot") as Promise<AppSnapshot>,
  importDocuments: (space: KnowledgeSpace) => ipcRenderer.invoke("knowledge:import", space) as Promise<DocumentRecord[]>,
  listDocuments: () => ipcRenderer.invoke("knowledge:list") as Promise<DocumentRecord[]>,
  removeDocument: (documentId: string) => ipcRenderer.invoke("knowledge:remove", documentId) as Promise<DocumentRecord[]>,
  updatePersonalPrompt: (personalPrompt: string) =>
    ipcRenderer.invoke("knowledge:update-personal-prompt", personalPrompt) as Promise<string>,
  updateAnswerStyle: (answerStyle: AnswerStyle) =>
    ipcRenderer.invoke("assistant:update-answer-style", answerStyle) as Promise<AnswerStyle>,
  ask: (question: string) => ipcRenderer.invoke("assistant:ask", question) as Promise<AssistantFrame>,
  tick: () => ipcRenderer.invoke("assistant:tick") as Promise<AssistantFrame | undefined>,
  regeneratePageAnswer: () => ipcRenderer.invoke("assistant:regenerate-page-answer") as Promise<AssistantFrame | undefined>,
  transcribeAudio: (input: { data: ArrayBuffer; mimeType: string }) =>
    ipcRenderer.invoke("assistant:transcribe-audio", input) as Promise<AssistantFrame | undefined>,
  transcribeAudioOnly: (input: { data: ArrayBuffer; mimeType: string }) =>
    ipcRenderer.invoke("assistant:transcribe-audio-only", input) as Promise<string>,
  analyzeTranscript: (transcript: string) => ipcRenderer.invoke("assistant:analyze-transcript", transcript) as Promise<AssistantFrame | undefined>,
  claimRecorder: (input: { preferOverlay: boolean }) => ipcRenderer.invoke("voice:claim-recorder", input) as Promise<boolean>,
  releaseRecorder: () => ipcRenderer.invoke("voice:release-recorder") as Promise<void>,
  onRecorderRevoked: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on("voice:recorder-revoked", listener);
    return () => ipcRenderer.removeListener("voice:recorder-revoked", listener);
  },
  onAssistantStream: (callback: (event: AssistantStreamEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: AssistantStreamEvent) => callback(payload);
    ipcRenderer.on("assistant:stream", listener);
    return () => ipcRenderer.removeListener("assistant:stream", listener);
  },
  listCaptureSources: () => ipcRenderer.invoke("capture:sources") as Promise<Array<{ id: string; name: string }>>,
  updatePrivacy: (next: Partial<PrivacySettings> & { answerStyle?: AnswerStyle }) =>
    ipcRenderer.invoke("privacy:update", next) as Promise<PrivacySettings>,
  updateModel: (next: Partial<ModelSettings>) => ipcRenderer.invoke("model:update", next) as Promise<ModelSettings>,
  updateConversationTitle: (input: { sessionId: string; title: string }) =>
    ipcRenderer.invoke("conversation:update-title", input) as Promise<ConversationSessionWithTurns[]>,
  endConversationSession: () => ipcRenderer.invoke("conversation:end-session") as Promise<ConversationSessionWithTurns[]>,
  openPath: (filePath: string) => ipcRenderer.invoke("shell:open-path", filePath) as Promise<void>,
  windowControl: (action: "minimize" | "maximize" | "close") => ipcRenderer.invoke("window:control", action) as Promise<void>,
  setOverlayIgnoreMouseEvents: (ignore: boolean) => ipcRenderer.invoke("overlay:set-ignore-mouse-events", ignore) as Promise<void>,
  moveOverlayBy: (delta: { x: number; y: number }) => ipcRenderer.send("overlay:move-by", delta),
  onPrivacyChanged: (callback: (settings: PrivacySettings) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, settings: PrivacySettings) => callback(settings);
    ipcRenderer.on("privacy:changed", listener);
    return () => ipcRenderer.removeListener("privacy:changed", listener);
  },
  onAnswerStyleChanged: (callback: (answerStyle: AnswerStyle) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, answerStyle: AnswerStyle) => callback(answerStyle);
    ipcRenderer.on("assistant:answer-style-changed", listener);
    return () => ipcRenderer.removeListener("assistant:answer-style-changed", listener);
  },
  onSummaryRequested: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on("assistant:summary-requested", listener);
    return () => ipcRenderer.removeListener("assistant:summary-requested", listener);
  }
};

contextBridge.exposeInMainWorld("zhishik", api);

export type ZhishikApi = typeof api;
