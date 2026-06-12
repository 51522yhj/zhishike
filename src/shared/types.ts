export type KnowledgeSpace = "resume" | "projects" | "enterprise";

export type DocumentRecord = {
  id: string;
  name: string;
  path: string;
  space: KnowledgeSpace;
  importedAt: string;
  chunkCount: number;
  status: "indexed" | "failed";
  error?: string;
};

export type KnowledgeChunk = {
  id: string;
  documentId: string;
  documentName: string;
  space: KnowledgeSpace;
  text: string;
  index: number;
  vector: number[];
};

export type SearchHit = {
  chunkId: string;
  documentId: string;
  documentName: string;
  space: KnowledgeSpace;
  excerpt: string;
  score: number;
};

export type PrivacySettings = {
  paused: boolean;
  monitorMode: "smart" | "screen" | "meeting" | "interview";
  screenCaptureIntervalSeconds: number;
  smartObserveWindowChange: boolean;
  smartObserveIdleSeconds: number;
  smartMinCaptureIntervalSeconds: number;
  cloudEnabled: boolean;
  monitorActiveWindowOnly: boolean;
  appBlacklist: string[];
  visionUnderstandingEnabled: boolean;
  localOcrEnabled: boolean;
  overlayOpacity: number;
  overlayTextColor: string;
  overlayAccentColor: string;
};

export type ModelProvider =
  | "openai"
  | "aliyun"
  | "deepseek"
  | "siliconflow"
  | "zhipu"
  | "volcengine"
  | "openrouter"
  | "custom";

export type ModelSettings = {
  provider: ModelProvider;
  apiKey: string;
  baseUrl: string;
  chatModel: string;
  visionEnabled: boolean;
  visionBaseUrl: string;
  visionApiKey: string;
  visionModel: string;
  transcriptionEnabled: boolean;
  translationEnabled: boolean;
  transcriptionProvider: "openai" | "aliyun" | "xfyun" | "disabled";
  transcriptionAudioSource: "microphone" | "system";
  transcriptionModel: string;
  xfyunAppId: string;
  xfyunApiKey: string;
  xfyunApiSecret: string;
  xfyunServiceType: "iat-webapi" | "iat" | "standard" | "large-model";
  xfyunEndpoint: string;
  xfyunLanguage: "cn" | "en";
  xfyunDomain: string;
  xfyunChunkSize: number;
};

export type AssistantFrame = {
  id: string;
  createdAt: string;
  sourceApp: string;
  transcript: string;
  translation: string;
  summary: string;
  detectedQuestion: string;
  suggestedAnswer: string;
  nextSteps: string[];
  citations: SearchHit[];
};

export type WorkEvent = {
  id: string;
  createdAt: string;
  sourceApp: string;
  transcript: string;
  detectedQuestion: string;
  summary: string;
  suggestedAnswer: string;
  nextSteps: string[];
};

export type ConversationTurn = {
  id: string;
  createdAt: string;
  mode: "meeting" | "interview" | "combined";
  sourceApp: string;
  transcript: string;
  detectedQuestion: string;
  summary: string;
  suggestedAnswer: string;
  nextSteps: string[];
};

export type ConversationSession = {
  id: string;
  title: string;
  mode: "meeting" | "interview" | "combined";
  startedAt: string;
  endedAt?: string;
  turnIds: string[];
};

export type ConversationSessionWithTurns = ConversationSession & {
  turns: ConversationTurn[];
};

export type AppSnapshot = {
  documents: DocumentRecord[];
  personalPrompt: string;
  privacy: PrivacySettings;
  model: ModelSettings;
  conversationTurns: ConversationTurn[];
  conversationSessions: ConversationSessionWithTurns[];
  assistant: AssistantFrame;
};

export type AssistantStreamEvent = {
  id: string;
  phase: "start" | "delta" | "done" | "error";
  createdAt: string;
  mode: ConversationTurn["mode"];
  sourceApp: string;
  transcript: string;
  delta?: string;
  text?: string;
  frame?: AssistantFrame;
  error?: string;
};

export type ImportDocumentInput = {
  space: KnowledgeSpace;
};

export type AskInput = {
  question: string;
};
