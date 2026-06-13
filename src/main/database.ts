import { app } from "electron";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getRecordFilePath } from "./storage";
import type {
  AssistantFrame,
  ConversationSession,
  ConversationSessionWithTurns,
  ConversationTurn,
  DocumentRecord,
  AnswerStyle,
  KnowledgeChunk,
  ModelSettings,
  PrivacySettings,
  WorkEvent
} from "../shared/types";

type DatabaseShape = {
  documents: DocumentRecord[];
  chunks: KnowledgeChunk[];
  personalPrompt: string;
  answerStyle: AnswerStyle;
  privacy: PrivacySettings;
  model: ModelSettings;
  workEvents: WorkEvent[];
  conversationTurns: ConversationTurn[];
  conversationSessions: ConversationSession[];
  activeConversationSessionId?: string;
  assistant?: AssistantFrame;
};

const defaultPrivacy: PrivacySettings = {
  paused: false,
  monitorMode: "screen",
  screenCaptureIntervalSeconds: 15,
  smartObserveWindowChange: true,
  smartObserveIdleSeconds: 90,
  smartMinCaptureIntervalSeconds: 45,
  cloudEnabled: true,
  monitorActiveWindowOnly: true,
  appBlacklist: [],
  visionUnderstandingEnabled: true,
  localOcrEnabled: false,
  overlayOpacity: 0.12,
  overlayTextColor: "#f4fbfb",
  overlayAccentColor: "#2563eb"
};

const defaultModel: ModelSettings = {
  provider: "custom",
  apiKey: process.env.OPENAI_API_KEY ?? process.env.DASHSCOPE_API_KEY ?? process.env.ALIYUN_API_KEY ?? "",
  baseUrl:
    process.env.OPENAI_BASE_URL ??
    process.env.ALIYUN_BASE_URL ??
    (process.env.DASHSCOPE_API_KEY || process.env.ALIYUN_API_KEY
      ? "https://dashscope.aliyuncs.com/compatible-mode/v1"
      : "https://api.openai.com/v1"),
  chatModel: process.env.OPENAI_CHAT_MODEL ?? process.env.ALIYUN_CHAT_MODEL ?? "gpt-4o-mini",
  visionEnabled: true,
  visionBaseUrl: process.env.VISION_BASE_URL ?? "",
  visionApiKey: process.env.VISION_API_KEY ?? "",
  visionModel: process.env.VISION_MODEL ?? "",
  transcriptionEnabled: false,
  translationEnabled: false,
  transcriptionProvider: "openai",
  transcriptionAudioSource: "microphone",
  transcriptionModel: process.env.OPENAI_TRANSCRIBE_MODEL ?? "gpt-4o-mini-transcribe",
  xfyunAppId: process.env.XFYUN_APP_ID ?? "",
  xfyunApiKey: process.env.XFYUN_API_KEY ?? "",
  xfyunApiSecret: process.env.XFYUN_API_SECRET ?? "",
  xfyunServiceType: "iat-webapi",
  xfyunEndpoint: process.env.XFYUN_ENDPOINT ?? "wss://iat-api.xfyun.cn/v2/iat",
  xfyunLanguage: "cn",
  xfyunDomain: "iat",
  xfyunChunkSize: 1280
};

export class LocalDatabase {
  private filePath: string;
  private data: DatabaseShape;

  constructor() {
    this.filePath = getRecordFilePath("assistant-db.json");
    this.migrateLegacyDatabaseIfNeeded();
    this.data = this.load();
  }

  listDocuments() {
    return [...this.data.documents].sort((a, b) => b.importedAt.localeCompare(a.importedAt));
  }

  getChunks() {
    return this.data.chunks;
  }

  saveDocument(record: DocumentRecord, chunks: KnowledgeChunk[]) {
    this.data.documents = this.data.documents.filter((doc) => doc.id !== record.id);
    this.data.chunks = this.data.chunks.filter((chunk) => chunk.documentId !== record.id);
    this.data.documents.push(record);
    this.data.chunks.push(...chunks);
    this.persist();
  }

  removeDocument(documentId: string) {
    this.data.documents = this.data.documents.filter((doc) => doc.id !== documentId);
    this.data.chunks = this.data.chunks.filter((chunk) => chunk.documentId !== documentId);
    this.persist();
  }

  getPersonalPrompt() {
    return this.data.personalPrompt ?? "";
  }

  updatePersonalPrompt(personalPrompt: string) {
    this.data.personalPrompt = personalPrompt.slice(0, 6000);
    this.persist();
    return this.data.personalPrompt;
  }

  getAnswerStyle() {
    return normalizeAnswerStyle(this.data.answerStyle);
  }

  updateAnswerStyle(answerStyle: AnswerStyle) {
    this.data.answerStyle = normalizeAnswerStyle(answerStyle);
    this.persist();
    return this.data.answerStyle;
  }

  getPrivacy() {
    return this.data.privacy;
  }

  updatePrivacy(next: Partial<PrivacySettings>) {
    this.data.privacy = { ...this.data.privacy, ...next };
    this.persist();
    return this.data.privacy;
  }

  getModel() {
    return this.data.model;
  }

  updateModel(next: Partial<ModelSettings>) {
    this.data.model = { ...this.data.model, ...next };
    this.persist();
    return this.data.model;
  }

  getAssistant() {
    return this.data.assistant ? sanitizeAssistantFrame(this.data.assistant) : undefined;
  }

  saveAssistant(frame: AssistantFrame) {
    this.data.assistant = sanitizeAssistantFrame(frame);
    this.persist();
  }

  addWorkEvent(frame: AssistantFrame) {
    const event = frameToWorkEvent(frame);
    this.data.workEvents = [...this.data.workEvents, event].slice(-5000);
    this.persist();
    return event;
  }

  addConversationTurn(frame: AssistantFrame, mode: ConversationTurn["mode"]) {
    const session = this.ensureConversationSession(mode);
    const turn = frameToConversationTurn(frame, mode);
    this.data.conversationTurns = [...this.data.conversationTurns, turn].slice(-5000);
    session.turnIds = [...session.turnIds, turn.id];
    this.persist();
    return turn;
  }

  endActiveConversationSession() {
    const session = this.getActiveConversationSession();
    if (!session || session.endedAt) {
      return;
    }
    session.endedAt = new Date().toISOString();
    this.data.activeConversationSessionId = undefined;
    this.persist();
  }

  updateConversationSessionTitle(sessionId: string, title: string) {
    const nextTitle = title.trim();
    if (!nextTitle) {
      return this.listConversationSessions();
    }
    this.data.conversationSessions = this.data.conversationSessions.map((session) =>
      session.id === sessionId ? { ...session, title: nextTitle } : session
    );
    this.persist();
    return this.listConversationSessions();
  }

  listConversationSessions(date = new Date()): ConversationSessionWithTurns[] {
    const day = date.toISOString().slice(0, 10);
    return this.data.conversationSessions
      .filter((session) => session.startedAt.slice(0, 10) === day)
      .map((session) => ({
        ...session,
        turns: session.turnIds
          .map((turnId) => this.data.conversationTurns.find((turn) => turn.id === turnId))
          .filter((turn): turn is ConversationTurn => Boolean(turn))
      }))
      .filter((session) => session.turns.length > 0 || !session.endedAt)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  listTodayConversationTurns(date = new Date()) {
    const day = date.toISOString().slice(0, 10);
    return this.data.conversationTurns.filter((turn) => turn.createdAt.slice(0, 10) === day);
  }

  listActiveConversationTurns() {
    const session = this.getActiveConversationSession();
    if (!session || session.endedAt) {
      return [];
    }
    return session.turnIds
      .map((turnId) => this.data.conversationTurns.find((turn) => turn.id === turnId))
      .filter((turn): turn is ConversationTurn => Boolean(turn));
  }

  clearTodayConversationTurns(date = new Date()) {
    const day = date.toISOString().slice(0, 10);
    this.data.conversationTurns = this.data.conversationTurns.filter((turn) => turn.createdAt.slice(0, 10) !== day);
    this.persist();
    return this.listTodayConversationTurns(date);
  }

  getCurrentAssistantAsWorkEvent() {
    return this.data.assistant ? frameToWorkEvent(this.data.assistant) : undefined;
  }

  listTodayEvents(date = new Date()) {
    const day = date.toISOString().slice(0, 10);
    return this.data.workEvents.filter((event) => event.createdAt.slice(0, 10) === day);
  }

  clearTodayEvents(date = new Date()) {
    const day = date.toISOString().slice(0, 10);
    this.data.workEvents = this.data.workEvents.filter((event) => event.createdAt.slice(0, 10) !== day);
    this.persist();
    return this.listTodayEvents(date);
  }

  snapshot() {
    return {
      documents: this.listDocuments(),
      personalPrompt: this.getPersonalPrompt(),
      answerStyle: this.getAnswerStyle(),
      privacy: this.getPrivacy(),
      model: this.getModel(),
      conversationTurns: this.listActiveConversationTurns(),
      conversationSessions: this.listConversationSessions(),
      assistant: this.getAssistant()
    };
  }

  private load(): DatabaseShape {
    if (!existsSync(this.filePath)) {
      return { documents: [], chunks: [], personalPrompt: "", answerStyle: "concise", privacy: defaultPrivacy, model: defaultModel, workEvents: [], conversationTurns: [], conversationSessions: [] };
    }

    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf-8")) as Partial<DatabaseShape>;
      const migratedWorkEvents = migrateWorkEvents(parsed.workEvents);
      const legacyConversationTurns = migratedWorkEvents.filter(isConversationWorkEvent).map(workEventToConversationTurn);
      return {
        documents: parsed.documents ?? [],
        chunks: parsed.chunks ?? [],
        personalPrompt: typeof parsed.personalPrompt === "string" ? parsed.personalPrompt : "",
        answerStyle: normalizeAnswerStyle(parsed.answerStyle),
        privacy: migratePrivacy(parsed.privacy),
        model: migrateModel(parsed.model),
        workEvents: migratedWorkEvents.filter((event) => !isConversationWorkEvent(event)),
        conversationTurns: mergeConversationTurns(migrateConversationTurns(parsed.conversationTurns), legacyConversationTurns),
        conversationSessions: migrateConversationSessions(parsed.conversationSessions, mergeConversationTurns(migrateConversationTurns(parsed.conversationTurns), legacyConversationTurns)),
        activeConversationSessionId: parsed.activeConversationSessionId,
        assistant: parsed.assistant
      };
    } catch {
      return { documents: [], chunks: [], personalPrompt: "", answerStyle: "concise", privacy: defaultPrivacy, model: defaultModel, workEvents: [], conversationTurns: [], conversationSessions: [] };
    }
  }

  private persist() {
    writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), "utf-8");
  }

  private getActiveConversationSession() {
    const id = this.data.activeConversationSessionId;
    return id ? this.data.conversationSessions.find((session) => session.id === id) : undefined;
  }

  private ensureConversationSession(mode: ConversationTurn["mode"]) {
    const active = this.getActiveConversationSession();
    if (active && !active.endedAt && active.mode === mode) {
      return active;
    }
    if (active && !active.endedAt) {
      active.endedAt = new Date().toISOString();
    }

    const now = new Date();
    const session: ConversationSession = {
      id: `session-${now.getTime()}-${Math.random().toString(16).slice(2)}`,
      title: `${conversationSessionModeLabel(mode)} ${now.toLocaleString("zh-CN", { hour12: false })}`,
      mode,
      startedAt: now.toISOString(),
      turnIds: []
    };
    this.data.conversationSessions.push(session);
    this.data.activeConversationSessionId = session.id;
    return session;
  }

  private migrateLegacyDatabaseIfNeeded() {
    if (existsSync(this.filePath)) {
      return;
    }

    const legacyPath = path.join(app.getPath("userData"), "local-data", "assistant-db.json");
    if (existsSync(legacyPath)) {
      copyFileSync(legacyPath, this.filePath);
    }
  }
}

function normalizeAnswerStyle(style: unknown): AnswerStyle {
  return style === "interviewer" || style === "technical" || style === "project_review" || style === "english" || style === "concise"
    ? style
    : "concise";
}

function migratePrivacy(privacy: Partial<PrivacySettings> | undefined): PrivacySettings {
  const legacy = privacy as Partial<PrivacySettings> & { whitelist?: string[]; monitorMode?: PrivacySettings["monitorMode"] | "voice" };
  const migrated = { ...defaultPrivacy, ...(privacy ?? {}) };
  migrated.appBlacklist = legacy.appBlacklist ?? [];
  if (String(legacy.monitorMode ?? "") === "voice") {
    migrated.monitorMode = "meeting";
  }
  if (String(legacy.monitorMode ?? "") === "smart") {
    migrated.monitorMode = "screen";
  }
  if (String(legacy.monitorMode ?? "") === "combined") {
    migrated.monitorMode = "meeting";
  }
  return migrated;
}

function migrateModel(model: Partial<ModelSettings> | undefined): ModelSettings {
  const migrated = { ...defaultModel, ...(model ?? {}) };
  const legacy = model as Partial<ModelSettings> | undefined;
  migrated.transcriptionEnabled = legacy?.transcriptionEnabled ?? false;
  migrated.translationEnabled = legacy?.translationEnabled ?? false;
  if (
    migrated.transcriptionProvider === "xfyun" &&
    (migrated.xfyunEndpoint.includes("office-api-ast-dx.iflyaisol.com") || migrated.xfyunEndpoint.includes("rtasr.xfyun.cn"))
  ) {
    migrated.xfyunServiceType = "iat-webapi";
    migrated.xfyunEndpoint = "wss://iat-api.xfyun.cn/v2/iat";
    migrated.xfyunDomain = "iat";
  }
  if (migrated.transcriptionProvider === "xfyun" && !migrated.xfyunServiceType) {
    migrated.xfyunServiceType = "iat-webapi";
  }
  if (migrated.transcriptionProvider === "xfyun" && migrated.xfyunServiceType === "iat-webapi") {
    if (!migrated.xfyunEndpoint || migrated.xfyunEndpoint.includes("rtasr.xfyun.cn") || migrated.xfyunEndpoint.includes("office-api-ast-dx.iflyaisol.com") || migrated.xfyunEndpoint.includes("iat.xf-yun.com")) {
      migrated.xfyunEndpoint = "wss://iat-api.xfyun.cn/v2/iat";
    }
    if (!migrated.xfyunDomain || migrated.xfyunDomain === "general" || migrated.xfyunDomain === "slm") {
      migrated.xfyunDomain = "iat";
    }
  }
  if (migrated.transcriptionProvider === "xfyun" && migrated.xfyunServiceType === "iat") {
    if (!migrated.xfyunEndpoint || migrated.xfyunEndpoint.includes("rtasr.xfyun.cn") || migrated.xfyunEndpoint.includes("office-api-ast-dx.iflyaisol.com")) {
      migrated.xfyunEndpoint = "wss://iat.xf-yun.com/v1";
    }
    if (!migrated.xfyunDomain || migrated.xfyunDomain === "general") {
      migrated.xfyunDomain = "slm";
    }
  }
  return migrated;
}

function migrateWorkEvents(events: WorkEvent[] | undefined): WorkEvent[] {
  return (events ?? []).map((event) => ({
    ...event,
    transcript: event.transcript ?? event.detectedQuestion ?? ""
  }));
}

function migrateConversationTurns(events: ConversationTurn[] | undefined): ConversationTurn[] {
  return (events ?? []).map((event) => ({
    ...event,
    mode: event.mode ?? "meeting",
    transcript: event.transcript ?? event.detectedQuestion ?? ""
  }));
}

function sanitizeAssistantFrame(frame: AssistantFrame): AssistantFrame {
  if (frame.sourceApp !== "答题模式") {
    return frame;
  }

  const detectedQuestion = cleanAnswerText(frame.detectedQuestion) || cleanAnswerText(frame.transcript) || "识别题目中";
  const suggestedAnswer = isLegacyAnswerFallback(frame.suggestedAnswer) ? "" : cleanAnswerText(frame.suggestedAnswer);
  return {
    ...frame,
    detectedQuestion,
    translation: detectedQuestion,
    summary: cleanAnswerText(frame.summary) || detectedQuestion,
    suggestedAnswer: suggestedAnswer || "答题模式不会自动请求 AI，请点击发送题目。",
    transcript: cleanAnswerText(frame.transcript) || detectedQuestion
  };
}

function isLegacyAnswerFallback(text = "") {
  return /当前模型没有返回结构化解答|当前仅完成题目识别|需要模型根据完整题目生成代码|已读取到屏幕题目文本/.test(text);
}

function cleanAnswerText(text = "") {
  return text
    .replace(/最近重点[:：]?/g, "")
    .replace(/请识别当前屏幕中的题目，?直接给出答案、?解题步骤和最终结论。?/g, "")
    .replace(/如果屏幕不是题目，?请说明需要补充哪些题目信息。?/g, "")
    .replace(/建议先直接回应[:：]?\s*/g, "")
    .replace(/[\/\s]+/g, " ")
    .trim();
}

function mergeConversationTurns(current: ConversationTurn[], legacy: ConversationTurn[]) {
  const seen = new Set<string>();
  return [...current, ...legacy]
    .filter((turn) => {
      if (seen.has(turn.id)) {
        return false;
      }
      seen.add(turn.id);
      return true;
    })
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(-5000);
}

function migrateConversationSessions(sessions: ConversationSession[] | undefined, turns: ConversationTurn[]): ConversationSession[] {
  const current = (sessions ?? []).map((session) => ({
    ...session,
    title: session.title || `${conversationSessionModeLabel(session.mode)} ${new Date(session.startedAt).toLocaleString("zh-CN", { hour12: false })}`,
    turnIds: session.turnIds ?? []
  }));
  if (current.length > 0) {
    return current;
  }

  const grouped = new Map<string, ConversationTurn[]>();
  for (const turn of turns) {
    const day = turn.createdAt.slice(0, 10);
    const key = `${turn.mode}-${day}`;
    grouped.set(key, [...(grouped.get(key) ?? []), turn]);
  }

  return Array.from(grouped.values()).map((items) => {
    const first = items[0];
    const last = items[items.length - 1];
    return {
      id: `session-${first.id}`,
      title: `${conversationSessionModeLabel(first.mode)} ${new Date(first.createdAt).toLocaleString("zh-CN", { hour12: false })}`,
      mode: first.mode,
      startedAt: first.createdAt,
      endedAt: last.createdAt,
      turnIds: items.map((item) => item.id)
    };
  });
}

function conversationSessionModeLabel(mode: ConversationTurn["mode"]) {
  return mode === "interview" ? "面试" : mode === "combined" ? "同步监控" : "会议";
}

function isConversationWorkEvent(event: WorkEvent) {
  return event.sourceApp.includes("转写") || event.sourceApp.includes("会议") || event.sourceApp.includes("面试");
}

function workEventToConversationTurn(event: WorkEvent): ConversationTurn {
  const mode = event.sourceApp.includes("面试") ? "interview" : event.sourceApp.includes("同时") ? "combined" : "meeting";
  return {
    id: event.id,
    createdAt: event.createdAt,
    mode,
    sourceApp: event.sourceApp,
    transcript: event.transcript || event.detectedQuestion,
    detectedQuestion: event.detectedQuestion,
    summary: event.summary,
    suggestedAnswer: event.suggestedAnswer,
    nextSteps: event.nextSteps
  };
}

function frameToWorkEvent(frame: AssistantFrame): WorkEvent {
  return {
    id: frame.id,
    createdAt: frame.createdAt,
    sourceApp: frame.sourceApp,
    transcript: frame.transcript,
    detectedQuestion: frame.detectedQuestion,
    summary: frame.summary,
    suggestedAnswer: frame.suggestedAnswer,
    nextSteps: frame.nextSteps
  };
}

function frameToConversationTurn(frame: AssistantFrame, mode: ConversationTurn["mode"]): ConversationTurn {
  return {
    id: frame.id,
    createdAt: frame.createdAt,
    mode,
    sourceApp: frame.sourceApp,
    transcript: frame.transcript,
    detectedQuestion: frame.detectedQuestion,
    summary: frame.summary,
    suggestedAnswer: frame.suggestedAnswer,
    nextSteps: frame.nextSteps
  };
}
