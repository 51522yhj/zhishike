import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createRoot } from "react-dom/client";
import { motion } from "framer-motion";
import {
  BookOpen,
  CalendarDays,
  Captions,
  ChevronRight,
  Copy,
  FileText,
  Mic,
  Minus,
  Network,
  Pause,
  Play,
  Plus,
  Radar,
  Search,
  Shield,
  Sparkles,
  Square,
  Trash2,
  X
} from "lucide-react";
import type {
  AppSnapshot,
  AssistantFrame,
  AssistantStreamEvent,
  AnswerStyle,
  ConversationSessionWithTurns,
  ConversationTurn,
  DocumentRecord,
  KnowledgeSpace,
  ModelProvider,
  ModelSettings,
  PrivacySettings,
} from "../shared/types";
import "./styles.css";

type Tab = "assistant" | "knowledge" | "privacy" | "sessions" | "model";

const spaces: Array<{ id: KnowledgeSpace; label: string }> = [
  { id: "resume", label: "我的简历" },
  { id: "projects", label: "我的项目" },
  { id: "enterprise", label: "企业/课程资料" }
];

const tabs: Array<{ id: Tab; label: string; icon: typeof Sparkles }> = [
  { id: "assistant", label: "助手", icon: Sparkles },
  { id: "knowledge", label: "知识库", icon: BookOpen },
  { id: "privacy", label: "隐私", icon: Shield },
  { id: "sessions", label: "会话", icon: CalendarDays },
  { id: "model", label: "模型", icon: Network }
];

const VAD_CHECK_MS = 120;
const VAD_SILENCE_MS = 1500;
const VAD_MIN_UTTERANCE_MS = 800;
const VAD_MAX_UTTERANCE_MS = 45000;
const VAD_RMS_THRESHOLD = 0.012;
const SYSTEM_VAD_RMS_THRESHOLD = 0.0025;
const SYSTEM_VAD_SILENCE_MS = 1000;
const SYSTEM_VAD_MIN_UTTERANCE_MS = 800;
const PCM_PREROLL_CHUNKS = 6;
const PCM_PARTIAL_FLUSH_MS = 1100;

const providerPresets: Array<{ id: ModelProvider; label: string; baseUrl: string; model: string }> = [
  { id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  { id: "aliyun", label: "阿里云百炼", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus" },
  { id: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com", model: "deepseek-chat" },
  { id: "siliconflow", label: "硅基流动", baseUrl: "https://api.siliconflow.cn/v1", model: "Qwen/Qwen3-32B" },
  { id: "zhipu", label: "智谱 GLM", baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4.5" },
  { id: "volcengine", label: "火山方舟", baseUrl: "https://ark.cn-beijing.volces.com/api/v3", model: "doubao-seed-1-6" },
  { id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", model: "openai/gpt-4o-mini" },
  { id: "custom", label: "自定义", baseUrl: "https://example.com/v1", model: "your-model-name" }
];

const answerStyles: Array<{ id: AnswerStyle; label: string; hint: string }> = [
  { id: "concise", label: "简洁版", hint: "先结论，少铺垫" },
  { id: "interviewer", label: "面试官友好版", hint: "自然口吻，突出贡献" },
  { id: "technical", label: "技术深入版", hint: "细节、权衡、边界" },
  { id: "project_review", label: "项目复盘版", hint: "背景、行动、结果" },
  { id: "english", label: "英文版", hint: "English output" }
];

export default function App() {
  const isOverlay = new URLSearchParams(window.location.search).get("overlay") === "1";
  const [tab, setTab] = useState<Tab>("assistant");
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [personalPrompt, setPersonalPrompt] = useState("");
  const [answerStyle, setAnswerStyle] = useState<AnswerStyle>("concise");
  const [privacy, setPrivacy] = useState<PrivacySettings | null>(null);
  const [model, setModel] = useState<ModelSettings | null>(null);
  const [conversationTurns, setConversationTurns] = useState<ConversationTurn[]>([]);
  const [streamingTurns, setStreamingTurns] = useState<ConversationTurn[]>([]);
  const [conversationSessions, setConversationSessions] = useState<ConversationSessionWithTurns[]>([]);
  const [assistant, setAssistant] = useState<AssistantFrame | null>(null);
  const [selectedSpace, setSelectedSpace] = useState<KnowledgeSpace>("resume");
  const [question, setQuestion] = useState("请根据我的项目经历，帮我回答这个问题");
  const [sources, setSources] = useState<Array<{ id: string; name: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [recording, setRecording] = useState(false);
  const [liveTranscript, setLiveTranscript] = useState("");
  const [recognizedTranscript, setRecognizedTranscript] = useState("");
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [streamedAnswer, setStreamedAnswer] = useState("");
  const answerStyleRef = useRef<AnswerStyle>("concise");
  const pendingAnswerStyleRef = useRef<AnswerStyle | null>(null);
  const answerStyleSavePromiseRef = useRef<Promise<AnswerStyle | void> | null>(null);
  const liveTranscriptRef = useRef("");
  const answerStreamTimerRef = useRef<number | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const pcmChunksRef = useRef<Int16Array[]>([]);
  const pcmPrerollRef = useRef<Int16Array[]>([]);
  const pcmTimerRef = useRef<number | null>(null);
  const webmChunksRef = useRef<Blob[]>([]);
  const vadTimerRef = useRef<number | null>(null);
  const speechStartedAtRef = useRef(0);
  const lastVoiceAtRef = useRef(0);
  const flushingAudioRef = useRef(false);
  const lastPartialFlushAtRef = useRef(0);
  const recordingRef = useRef(false);
  const privacyRef = useRef<PrivacySettings | null>(null);
  const modelRef = useRef<ModelSettings | null>(null);
  const transcriptionBlockedRef = useRef<string | null>(null);
  const previousMonitorModeRef = useRef<PrivacySettings["monitorMode"] | null>(null);
  const activeAnalysisCountRef = useRef(0);
  const recorderClaimedRef = useRef(false);

  useEffect(() => {
    document.documentElement.classList.toggle("overlay-mode", isOverlay);
    document.body.classList.toggle("overlay-mode", isOverlay);
    return () => {
      document.documentElement.classList.remove("overlay-mode");
      document.body.classList.remove("overlay-mode");
    };
  }, [isOverlay]);

  useEffect(() => {
    void loadSnapshot();
    const clearPrivacy = window.zhishik.onPrivacyChanged((settings) => {
      setPrivacy(settings);
      void refreshRuntimeSnapshot();
    });
    const clearSummary = window.zhishik.onSummaryRequested(() => setTab("assistant"));
    const clearRecorderRevoked = window.zhishik.onRecorderRevoked(() => {
      recorderClaimedRef.current = false;
      void stopRecordingSession(false);
    });
    const clearAssistantStream = window.zhishik.onAssistantStream(handleAssistantStreamEvent);
    const releaseOnUnload = () => {
      void window.zhishik.releaseRecorder();
    };
    window.addEventListener("beforeunload", releaseOnUnload);

    return () => {
      clearPrivacy();
      clearSummary();
      clearRecorderRevoked();
      clearAssistantStream();
      window.removeEventListener("beforeunload", releaseOnUnload);
      void window.zhishik.releaseRecorder();
    };
  }, []);

  useEffect(() => {
    if (!privacy) return;
    const intervalMs = ["meeting", "interview"].includes(privacy.monitorMode)
      ? 2000
      : privacy.monitorMode === "smart"
        ? 5000
        : Math.max(5, privacy.screenCaptureIntervalSeconds) * 1000;
    const interval = window.setInterval(async () => {
      if (!privacy.paused && !["screen", "meeting", "interview"].includes(privacy.monitorMode)) {
        const frame = await window.zhishik.tick();
        if (frame) {
          setAssistant(frame);
        }
      }
      const snapshot = await window.zhishik.snapshot();
      setConversationTurns(snapshot.conversationTurns);
      setConversationSessions(snapshot.conversationSessions);
    }, intervalMs);

    return () => {
      window.clearInterval(interval);
    };
  }, [privacy?.screenCaptureIntervalSeconds, privacy?.monitorMode, privacy?.paused]);

  useEffect(() => {
    if (!privacy) return;
    privacyRef.current = privacy;
    modelRef.current = model;
    const wantsVoice = privacy.monitorMode === "meeting" || privacy.monitorMode === "interview";
    const blocked = transcriptionBlockedRef.current === transcriptionConfigKey(model);
    if (wantsVoice && !recordingRef.current && !privacy.paused && model?.transcriptionEnabled && !blocked) {
      void startRecording();
    }
    if ((!wantsVoice || privacy.paused || !model?.transcriptionEnabled) && recordingRef.current) {
      void stopRecordingSession(true);
    }
  }, [
    privacy?.monitorMode,
    privacy?.paused,
    recording,
    model?.transcriptionEnabled,
    model?.transcriptionProvider,
    model?.transcriptionAudioSource,
    model?.xfyunServiceType,
    model?.xfyunEndpoint,
    model?.xfyunAppId,
    model?.xfyunApiKey,
    model?.xfyunApiSecret
  ]);

  useEffect(() => {
    privacyRef.current = privacy;
  }, [privacy]);

  useEffect(() => {
    if (!privacy) return;
    const previousMode = previousMonitorModeRef.current;
    if (previousMode && previousMode !== privacy.monitorMode) {
      setLiveTranscript("");
      liveTranscriptRef.current = "";
      setRecognizedTranscript("");
      setStreamedAnswer("");
      setAnalysisLoading(false);
      if (answerStreamTimerRef.current) {
        window.clearInterval(answerStreamTimerRef.current);
        answerStreamTimerRef.current = null;
      }
    }
    previousMonitorModeRef.current = privacy.monitorMode;
  }, [privacy?.monitorMode]);

  useEffect(() => {
    modelRef.current = model;
  }, [model]);

  const activeDocs = useMemo(() => documents.filter((doc) => doc.status === "indexed"), [documents]);
  const groupedDocs = useMemo(() => {
    return spaces.map((space) => ({
      ...space,
      docs: documents.filter((doc) => doc.space === space.id)
    }));
  }, [documents]);

  async function loadSnapshot() {
    const snapshot: AppSnapshot = await window.zhishik.snapshot();
    setDocuments(snapshot.documents);
    setPersonalPrompt(snapshot.personalPrompt ?? "");
    answerStyleRef.current = snapshot.answerStyle ?? "concise";
    setAnswerStyle(snapshot.answerStyle ?? "concise");
    setPrivacy(snapshot.privacy);
    setModel(snapshot.model);
    setConversationTurns(snapshot.conversationTurns);
    setConversationSessions(snapshot.conversationSessions);
    setAssistant(snapshot.assistant);
    const captureSources = await window.zhishik.listCaptureSources();
    setSources(captureSources);
  }

  async function refreshRuntimeSnapshot() {
    const snapshot = await window.zhishik.snapshot();
    setPersonalPrompt(snapshot.personalPrompt ?? "");
    if (!pendingAnswerStyleRef.current) {
      answerStyleRef.current = snapshot.answerStyle ?? "concise";
      setAnswerStyle(snapshot.answerStyle ?? "concise");
    }
    setPrivacy(snapshot.privacy);
    setConversationTurns(snapshot.conversationTurns);
    setConversationSessions(snapshot.conversationSessions);
    setAssistant(snapshot.assistant);
  }

  async function importDocuments() {
    setBusy(true);
    setError("");
    try {
      const next = await window.zhishik.importDocuments(selectedSpace);
      setDocuments(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "导入失败");
    } finally {
      setBusy(false);
    }
  }

  async function askAssistant() {
    if (!question.trim()) return;
    setBusy(true);
    setError("");
    try {
      const frame = await window.zhishik.ask(question);
      setAssistant(frame);
      const snapshot = await window.zhishik.snapshot();
      setConversationTurns(snapshot.conversationTurns);
      setConversationSessions(snapshot.conversationSessions);
    } catch (err) {
      setError(err instanceof Error ? err.message : "生成失败");
    } finally {
      setBusy(false);
    }
  }

  function resetSpeechState() {
    speechStartedAtRef.current = 0;
    lastVoiceAtRef.current = 0;
  }

  function presentAssistantFrame(frame: AssistantFrame, options: { streamAnswer?: boolean } = {}) {
    setAssistant(frame);
    if (!options.streamAnswer) {
      setStreamedAnswer("");
      return;
    }

    if (answerStreamTimerRef.current) {
      window.clearInterval(answerStreamTimerRef.current);
    }
    const answer = frame.suggestedAnswer || "";
    let index = 0;
    setStreamedAnswer("");
    answerStreamTimerRef.current = window.setInterval(() => {
      index = Math.min(answer.length, index + 3);
      setStreamedAnswer(answer.slice(0, index));
      if (index >= answer.length && answerStreamTimerRef.current) {
        window.clearInterval(answerStreamTimerRef.current);
        answerStreamTimerRef.current = null;
      }
    }, 38);
  }

  function setAnalysisBusy(delta: number) {
    activeAnalysisCountRef.current = Math.max(0, activeAnalysisCountRef.current + delta);
    setAnalysisLoading(activeAnalysisCountRef.current > 0);
  }

  function handleAssistantStreamEvent(event: AssistantStreamEvent) {
    if (event.phase === "start") {
      setStreamingTurns((current) => upsertStreamingTurn(current, streamEventToTurn(event, "")));
      return;
    }

    if (event.phase === "delta") {
      setStreamingTurns((current) =>
        upsertStreamingTurn(
          current,
          streamEventToTurn(event, event.text ?? `${current.find((turn) => turn.id === event.id)?.suggestedAnswer ?? ""}${event.delta ?? ""}`)
        )
      );
      setStreamedAnswer(event.text ?? "");
      return;
    }

    if (event.phase === "done") {
      if (event.frame) {
        const frame = event.frame;
        setAssistant(frame);
        setStreamingTurns((current) =>
          upsertStreamingTurn(current, { ...frameToStreamingTurn(frame, event.mode), id: event.id, createdAt: event.createdAt })
        );
      }
      window.setTimeout(() => {
        setStreamingTurns((current) => current.filter((turn) => turn.id !== event.id));
        void refreshRuntimeSnapshot();
      }, 800);
      return;
    }

    if (event.phase === "error") {
      setError(event.error || "AI 流式生成失败");
      setStreamingTurns((current) => current.filter((turn) => turn.id !== event.id));
    }
  }

  async function analyzeTranscriptInBackground(transcript: string) {
    const text = transcript.trim();
    if (!text) return;
    setAnalysisBusy(1);
    try {
      const frame = await window.zhishik.analyzeTranscript(text);
      if (frame) {
        presentAssistantFrame(frame);
      }
      const snapshot = await window.zhishik.snapshot();
      setConversationTurns(snapshot.conversationTurns);
      setConversationSessions(snapshot.conversationSessions);
    } catch (err) {
      setError(err instanceof Error ? err.message : "语音分析失败，请检查配置。");
    } finally {
      setAnalysisBusy(-1);
    }
  }

  function appendLiveTranscript(text: string) {
    const merged = mergeLiveTranscript(liveTranscriptRef.current, text);
    liveTranscriptRef.current = merged;
    if (merged) {
      setRecognizedTranscript("");
    }
    setLiveTranscript(merged);
    return merged;
  }

  async function submitTranscriptionAudio(data: ArrayBuffer, mimeType: string) {
    if (privacyRef.current?.paused || !recordingRef.current || !modelRef.current?.transcriptionEnabled) {
      return;
    }
    try {
      setAnalysisLoading(true);
      const frame = await window.zhishik.transcribeAudio({ data, mimeType });
      if (frame) {
        const transcript = (frame.transcript || frame.detectedQuestion || "").trim();
        if (transcript) {
          appendLiveTranscript(transcript);
        }
        presentAssistantFrame(frame, { streamAnswer: true });
        if (isFatalTranscriptionFrame(frame)) {
          transcriptionBlockedRef.current = transcriptionConfigKey(modelRef.current);
          setError(frame.transcript || frame.suggestedAnswer);
          await stopRecordingSession(true);
        }
      }
      const snapshot = await window.zhishik.snapshot();
      setConversationTurns(snapshot.conversationTurns);
      setConversationSessions(snapshot.conversationSessions);
    } catch (err) {
      setError(err instanceof Error ? err.message : "语音转写失败，请检查配置。");
    } finally {
      setAnalysisLoading(false);
    }
  }

  async function submitPartialTranscriptionAudio(data: ArrayBuffer, mimeType: string) {
    if (privacyRef.current?.paused || !recordingRef.current || !modelRef.current?.transcriptionEnabled) {
      return;
    }
    try {
      const transcript = await window.zhishik.transcribeAudioOnly({ data, mimeType });
      if (transcript.trim()) {
        appendLiveTranscript(transcript);
      }
    } catch {
      // Partial transcription is best-effort; final utterance still reports errors.
    }
  }

  async function submitFinalTranscriptionAudio(data: ArrayBuffer, mimeType: string) {
    if (privacyRef.current?.paused || !recordingRef.current || !modelRef.current?.transcriptionEnabled) {
      return;
    }
    const baseTranscript = liveTranscriptRef.current;
    liveTranscriptRef.current = "";
    setLiveTranscript("");
    try {
      const transcript = await window.zhishik.transcribeAudioOnly({ data, mimeType });
      const fullTranscript = transcript.trim() ? mergeLiveTranscript(baseTranscript, transcript) : baseTranscript;
      if (!fullTranscript.trim()) {
        return;
      }
      setRecognizedTranscript(fullTranscript);
      void analyzeTranscriptInBackground(fullTranscript);
    } catch (err) {
      setError(err instanceof Error ? err.message : "语音分析失败，请检查配置。");
    }
  }

  async function analyzeCurrentLiveTranscript() {
    const fullTranscript = liveTranscriptRef.current.trim();
    if (!fullTranscript) return;
    liveTranscriptRef.current = "";
    setLiveTranscript("");
    setRecognizedTranscript(fullTranscript);
    void analyzeTranscriptInBackground(fullTranscript);
  }

  function markVoice(rms: number, threshold = VAD_RMS_THRESHOLD) {
    if (rms < threshold) return;
    const now = Date.now();
    if (!speechStartedAtRef.current) {
      speechStartedAtRef.current = now;
      lastPartialFlushAtRef.current = now;
    }
    lastVoiceAtRef.current = now;
  }

  function shouldFlushVoice(options: { minUtteranceMs?: number; silenceMs?: number; maxUtteranceMs?: number } = {}) {
    const startedAt = speechStartedAtRef.current;
    if (!startedAt) return false;
    const now = Date.now();
    const silenceMs = now - lastVoiceAtRef.current;
    const utteranceMs = now - startedAt;
    const minUtteranceMs = options.minUtteranceMs ?? VAD_MIN_UTTERANCE_MS;
    const silenceLimitMs = options.silenceMs ?? VAD_SILENCE_MS;
    const maxUtteranceMs = options.maxUtteranceMs ?? VAD_MAX_UTTERANCE_MS;
    return (utteranceMs >= minUtteranceMs && silenceMs >= silenceLimitMs) || utteranceMs >= maxUtteranceMs;
  }

  function startWebmVad(stream: MediaStream, recorder: MediaRecorder, mimeType: string) {
    const audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    const samples = new Float32Array(analyser.fftSize);
    source.connect(analyser);
    audioContextRef.current = audioContext;

    vadTimerRef.current = window.setInterval(() => {
      if (privacyRef.current?.paused || !recordingRef.current) return;
      analyser.getFloatTimeDomainData(samples);
      markVoice(calculateRms(samples));
      if (!shouldFlushVoice() || flushingAudioRef.current) return;

      flushingAudioRef.current = true;
      recorder.requestData();
      window.setTimeout(async () => {
        const chunks = webmChunksRef.current;
        webmChunksRef.current = [];
        resetSpeechState();
        flushingAudioRef.current = false;
        const blob = new Blob(chunks, { type: mimeType });
        if (blob.size < 1024) return;
        await submitTranscriptionAudio(await blob.arrayBuffer(), mimeType);
      }, 120);
    }, VAD_CHECK_MS);
  }

  async function flushPcmUtterance(final = true) {
    if (privacyRef.current?.paused || !recordingRef.current) return;
    if (flushingAudioRef.current) return;
    flushingAudioRef.current = true;
    const chunks = pcmChunksRef.current;
    pcmChunksRef.current = [];
    if (final) {
      resetSpeechState();
      pcmPrerollRef.current = [];
    }
    const pcm = concatInt16(chunks);
    try {
      if (pcm.byteLength < 3200) {
        if (final) {
          await analyzeCurrentLiveTranscript();
        }
        return;
      }
      lastPartialFlushAtRef.current = Date.now();
      if (final) {
        await submitFinalTranscriptionAudio(pcm.buffer, "audio/pcm;rate=16000");
      } else {
        await submitPartialTranscriptionAudio(pcm.buffer, "audio/pcm;rate=16000");
      }
    } finally {
      flushingAudioRef.current = false;
    }
  }

  async function stopRecordingSession(endSession: boolean) {
    recordingRef.current = false;
    setRecording(false);
    if (pcmTimerRef.current) window.clearInterval(pcmTimerRef.current);
    if (vadTimerRef.current) window.clearInterval(vadTimerRef.current);
    pcmTimerRef.current = null;
    vadTimerRef.current = null;
    try {
      if (recorderRef.current && recorderRef.current.state !== "inactive") {
        recorderRef.current.stop();
      }
    } catch {
      // Recorder can already be inactive when pause and cleanup race.
    }
    processorRef.current?.disconnect();
    void audioContextRef.current?.close().catch(() => undefined);
    streamRef.current?.getTracks().forEach((track) => track.stop());
    recorderRef.current = null;
    processorRef.current = null;
    audioContextRef.current = null;
    streamRef.current = null;
    pcmChunksRef.current = [];
    pcmPrerollRef.current = [];
    webmChunksRef.current = [];
    flushingAudioRef.current = false;
    lastPartialFlushAtRef.current = 0;
    activeAnalysisCountRef.current = 0;
    setAnalysisLoading(false);
    setLiveTranscript("");
    liveTranscriptRef.current = "";
    setRecognizedTranscript("");
    setStreamedAnswer("");
    if (answerStreamTimerRef.current) {
      window.clearInterval(answerStreamTimerRef.current);
      answerStreamTimerRef.current = null;
    }
    resetSpeechState();
    if (recorderClaimedRef.current) {
      recorderClaimedRef.current = false;
      await window.zhishik.releaseRecorder().catch(() => undefined);
    }
    if (endSession) {
      setConversationSessions(await window.zhishik.endConversationSession());
    }
  }

  async function toggleRecording() {
    if (recordingRef.current) {
      await stopRecordingSession(true);
      return;
    }

    await startRecording();
  }

  async function startRecording() {
    if (!model?.transcriptionEnabled || model.transcriptionProvider === "disabled") {
      setError("语音转写已关闭，请在模型设置里开启后再录音。");
      return;
    }

    if (privacyRef.current?.paused) {
      return;
    }

    setError("");
    setLiveTranscript("");
    liveTranscriptRef.current = "";
    setRecognizedTranscript("");
    setStreamedAnswer("");
    setAnalysisLoading(false);
    lastPartialFlushAtRef.current = 0;
    try {
      const claimed = await window.zhishik.claimRecorder({ preferOverlay: isOverlay });
      if (!claimed) {
        return;
      }
      recorderClaimedRef.current = true;
      const stream = await getTranscriptionAudioStream(model?.transcriptionAudioSource ?? "microphone");
      if (privacyRef.current?.paused) {
        stream.getTracks().forEach((track) => track.stop());
        recorderClaimedRef.current = false;
        await window.zhishik.releaseRecorder().catch(() => undefined);
        return;
      }
      streamRef.current = stream;
      recordingRef.current = true;

      if (model?.transcriptionProvider === "xfyun") {
        await startXfyunPcmRecording(stream);
        setRecording(true);
        return;
      }

      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
      const recorder = new MediaRecorder(stream, { mimeType });
      recorderRef.current = recorder;

      recorder.addEventListener("dataavailable", async (event) => {
        if (event.data.size < 1024) return;
        if (!recordingRef.current || privacyRef.current?.paused) return;
        if (speechStartedAtRef.current || flushingAudioRef.current) {
          webmChunksRef.current.push(event.data);
        }
      });

      recorder.start(500);
      startWebmVad(stream, recorder, mimeType);
      setRecording(true);
    } catch (err) {
      recordingRef.current = false;
      if (recorderClaimedRef.current) {
        recorderClaimedRef.current = false;
        await window.zhishik.releaseRecorder().catch(() => undefined);
      }
      setError(formatAudioError(err));
    }
  }

  async function startXfyunPcmRecording(stream: MediaStream) {
    const audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(stream);
    const processor = audioContext.createScriptProcessor(4096, 1, 1);
    const silentOutput = audioContext.createGain();
    silentOutput.gain.value = 0;
    audioContextRef.current = audioContext;
    processorRef.current = processor;
    pcmChunksRef.current = [];
    pcmPrerollRef.current = [];
    const isSystemAudio = modelRef.current?.transcriptionAudioSource === "system";

    processor.onaudioprocess = (event) => {
      if (privacyRef.current?.paused || !recordingRef.current) return;
      const input = event.inputBuffer.getChannelData(0);
      const pcm = floatTo16kPcm(input, audioContext.sampleRate);
      if (isSystemAudio) {
        const wasSpeaking = Boolean(speechStartedAtRef.current);
        if (!wasSpeaking) {
          pcmPrerollRef.current.push(pcm);
          if (pcmPrerollRef.current.length > PCM_PREROLL_CHUNKS) {
            pcmPrerollRef.current.shift();
          }
        }

        markVoice(calculateRms(input), SYSTEM_VAD_RMS_THRESHOLD);
        if (speechStartedAtRef.current) {
          if (!wasSpeaking && pcmPrerollRef.current.length > 0) {
            pcmChunksRef.current.push(...pcmPrerollRef.current);
            pcmPrerollRef.current = [];
          } else {
            pcmChunksRef.current.push(pcm);
          }
        }

        if (
          shouldFlushVoice({
            minUtteranceMs: SYSTEM_VAD_MIN_UTTERANCE_MS,
            silenceMs: SYSTEM_VAD_SILENCE_MS,
            maxUtteranceMs: Number.POSITIVE_INFINITY
          })
        ) {
          void flushPcmUtterance(true);
        } else if (speechStartedAtRef.current && Date.now() - lastPartialFlushAtRef.current >= PCM_PARTIAL_FLUSH_MS) {
          void flushPcmUtterance(false);
        }
        return;
      }

      markVoice(calculateRms(input));
      if (speechStartedAtRef.current) {
        pcmChunksRef.current.push(pcm);
      }
      if (shouldFlushVoice()) {
        void flushPcmUtterance(true);
      } else if (speechStartedAtRef.current && Date.now() - lastPartialFlushAtRef.current >= PCM_PARTIAL_FLUSH_MS) {
        void flushPcmUtterance(false);
      }
    };

    source.connect(processor);
    processor.connect(silentOutput);
    silentOutput.connect(audioContext.destination);
  }

  async function updatePrivacy(next: Partial<PrivacySettings> & { answerStyle?: AnswerStyle }) {
    if (next.paused === false || next.monitorMode) {
      await answerStyleSavePromiseRef.current?.catch(() => undefined);
      next = { ...next, answerStyle: answerStyleRef.current };
      if (window.zhishik.updateAnswerStyle) {
        await window.zhishik.updateAnswerStyle(answerStyleRef.current).catch(() => undefined);
      }
    }
    const settings = await window.zhishik.updatePrivacy(next);
    setPrivacy(settings);
    const snapshot = await window.zhishik.snapshot();
    if (!pendingAnswerStyleRef.current) {
      answerStyleRef.current = snapshot.answerStyle ?? "concise";
      setAnswerStyle(snapshot.answerStyle ?? "concise");
    }
    setAssistant(snapshot.assistant);
    setConversationTurns(snapshot.conversationTurns);
    setConversationSessions(snapshot.conversationSessions);
  }

  async function endCurrentVoiceSession() {
    if (recordingRef.current) {
      await stopRecordingSession(true);
    } else {
      setConversationSessions(await window.zhishik.endConversationSession());
    }
    await updatePrivacy({ paused: true });
  }

  async function updateModel(next: Partial<ModelSettings>) {
    const settings = await window.zhishik.updateModel(next);
    setModel(settings);
  }

  async function updatePersonalPrompt(next: string) {
    if (!window.zhishik.updatePersonalPrompt) {
      setPersonalPrompt(next);
      return;
    }
    const saved = await window.zhishik.updatePersonalPrompt(next);
    setPersonalPrompt(saved ?? "");
  }

  async function updateAnswerStyle(next: AnswerStyle) {
    answerStyleRef.current = next;
    pendingAnswerStyleRef.current = next;
    setAnswerStyle(next);
    if (!window.zhishik.updateAnswerStyle) {
      pendingAnswerStyleRef.current = null;
      return;
    }
    const savePromise = window.zhishik.updateAnswerStyle(next);
    answerStyleSavePromiseRef.current = savePromise;
    try {
      const saved = await savePromise;
      answerStyleRef.current = saved ?? next;
      setAnswerStyle(saved ?? next);
    } finally {
      if (answerStyleSavePromiseRef.current === savePromise) {
        answerStyleSavePromiseRef.current = null;
        pendingAnswerStyleRef.current = null;
      }
    }
  }

  if (!privacy || !model || !assistant) {
    return <div className="boot">正在启动知时客...</div>;
  }

  if (isOverlay) {
    return (
      <OverlayAssistant
        assistant={assistant}
        privacy={privacy}
        answerStyle={answerStyle}
        conversationTurns={conversationTurns}
        streamingTurns={streamingTurns}
        liveTranscript={liveTranscript}
        recognizedTranscript={recognizedTranscript}
        analysisLoading={analysisLoading}
      />
    );
  }

  return (
    <main className="shell">
      <header className="app-titlebar">
        <div className="titlebar-brand">
          <span className="titlebar-mark" />
          <strong>知时客</strong>
        </div>
        <div className="titlebar-drag" />
        <div className="window-controls">
          <button aria-label="最小化" title="最小化" onClick={() => window.zhishik.windowControl("minimize")}>
            <Minus size={16} />
          </button>
          <button aria-label="最大化" title="最大化" onClick={() => window.zhishik.windowControl("maximize")}>
            <Square size={13} />
          </button>
          <button className="close" aria-label="关闭" title="关闭" onClick={() => window.zhishik.windowControl("close")}>
            <X size={16} />
          </button>
        </div>
      </header>
      <aside className="nav">
        <div className="brand">
          <div className="brand-mark">知</div>
          <div>
            <strong>知时客</strong>
            <span>实时知识桌面助手</span>
          </div>
        </div>
        <nav>
          {tabs.map((item) => {
            const Icon = item.icon;
            return (
              <button className={tab === item.id ? "nav-item active" : "nav-item"} key={item.id} onClick={() => setTab(item.id)}>
                <Icon size={18} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>
        <div className="nav-status">
          <span className={privacy.paused ? "status-dot paused" : "status-dot"} />
          {privacy.paused ? "监控已暂停" : "活动窗口监控中"}
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <h1>{tabTitle(tab)}</h1>
            <p>{tabSubtitle(tab)}</p>
          </div>
          <div className="top-actions">
            {(privacy.monitorMode === "meeting" || privacy.monitorMode === "interview") && (
              <button className="ghost compact end-session" onClick={endCurrentVoiceSession}>
                <Square size={14} />
                {privacy.monitorMode === "meeting" ? "结束会议" : "结束面试"}
              </button>
            )}
            <button className="icon-button" title={privacy.paused ? "继续监控" : "暂停监控"} onClick={() => updatePrivacy({ paused: !privacy.paused })}>
              {privacy.paused ? <Play size={18} /> : <Pause size={18} />}
            </button>
            <button className="primary" onClick={askAssistant} disabled={busy}>
              <Sparkles size={17} />
              生成建议
            </button>
          </div>
        </header>

        {error && <div className="error">{error}</div>}

        {tab === "assistant" && (
          <AssistantView
            assistant={assistant}
            question={question}
            setQuestion={setQuestion}
            askAssistant={askAssistant}
            answerStyle={answerStyle}
            updateAnswerStyle={updateAnswerStyle}
            privacy={privacy}
            documents={activeDocs}
            sources={sources}
            conversationTurns={conversationTurns}
            streamingTurns={streamingTurns}
            busy={busy}
            liveTranscript={liveTranscript}
            recognizedTranscript={recognizedTranscript}
            analysisLoading={analysisLoading}
            streamedAnswer={streamedAnswer}
          />
        )}
        {tab === "knowledge" && (
          <KnowledgeView
            groupedDocs={groupedDocs}
            selectedSpace={selectedSpace}
            setSelectedSpace={setSelectedSpace}
            importDocuments={importDocuments}
            removeDocument={async (id) => setDocuments(await window.zhishik.removeDocument(id))}
            personalPrompt={personalPrompt}
            updatePersonalPrompt={updatePersonalPrompt}
            busy={busy}
          />
        )}
        {tab === "privacy" && <PrivacyView privacy={privacy} sources={sources} updatePrivacy={updatePrivacy} />}
        {tab === "sessions" && (
          <SessionsView
            sessions={conversationSessions}
            updateTitle={async (sessionId, title) => setConversationSessions(await window.zhishik.updateConversationTitle({ sessionId, title }))}
          />
        )}
        {tab === "model" && <ModelView model={model} updateModel={updateModel} />}
      </section>

      <motion.div
        className="subtitle"
        initial={{ y: 24, opacity: 0 }}
        animate={{ y: 0, opacity: privacy.paused ? 0.58 : 1 }}
        transition={{ duration: 0.35 }}
      >
        <Captions size={18} />
        <div>
          <span>{assistant.transcript}</span>
          <strong>{assistant.translation}</strong>
        </div>
      </motion.div>
      <button className="monitor-fab" onClick={() => updatePrivacy({ paused: !privacy.paused })}>
        {privacy.paused ? <Play size={16} /> : <Pause size={16} />}
        {privacy.paused ? "继续监控" : "暂停监控"}
      </button>
    </main>
  );
}

function OverlayAssistant(props: {
  assistant: AssistantFrame;
  privacy: PrivacySettings;
  answerStyle: AnswerStyle;
  conversationTurns: ConversationTurn[];
  streamingTurns: ConversationTurn[];
  liveTranscript: string;
  recognizedTranscript: string;
  analysisLoading: boolean;
}) {
  const [assistant, setAssistant] = useState(props.assistant);
  const [privacy, setPrivacy] = useState(props.privacy);
  const [answerStyle, setAnswerStyle] = useState<AnswerStyle>(props.answerStyle);
  const [conversationTurns, setConversationTurns] = useState(props.conversationTurns);
  const [regenerating, setRegenerating] = useState(false);
  const { liveTranscript, recognizedTranscript, analysisLoading, streamingTurns } = props;
  const overlayDragRef = useRef<{ x: number; y: number; pointerId: number } | null>(null);
  const overlayAnswerStyleRef = useRef<AnswerStyle>(props.answerStyle);
  const pendingOverlayAnswerStyleRef = useRef<AnswerStyle | null>(null);
  const overlayAnswerStyleSavePromiseRef = useRef<Promise<AnswerStyle | void> | null>(null);

  useEffect(() => {
    const clearPrivacy = window.zhishik.onPrivacyChanged((settings) => {
      setPrivacy(settings);
      void refreshOverlaySnapshot();
    });
    void window.zhishik.setOverlayIgnoreMouseEvents(true);
    return () => {
      clearPrivacy();
      void window.zhishik.setOverlayIgnoreMouseEvents(false);
    };
  }, []);

  async function refreshOverlaySnapshot() {
    const snapshot = await window.zhishik.snapshot();
    setAssistant(snapshot.assistant);
    setPrivacy(snapshot.privacy);
    if (!pendingOverlayAnswerStyleRef.current) {
      overlayAnswerStyleRef.current = snapshot.answerStyle ?? "concise";
      setAnswerStyle(snapshot.answerStyle ?? "concise");
    }
    setConversationTurns(snapshot.conversationTurns);
  }

  useEffect(() => {
    const intervalMs = ["meeting", "interview"].includes(privacy.monitorMode)
      ? 2000
      : privacy.monitorMode === "smart"
        ? 5000
        : Math.max(5, privacy.screenCaptureIntervalSeconds) * 1000;
    const interval = window.setInterval(async () => {
      if (!privacy.paused && !["screen", "meeting", "interview"].includes(privacy.monitorMode)) {
        const frame = await window.zhishik.tick();
        if (frame) {
          setAssistant(frame);
        }
      }
      const snapshot = await window.zhishik.snapshot();
      setAssistant(snapshot.assistant);
      setPrivacy(snapshot.privacy);
      if (!pendingOverlayAnswerStyleRef.current) {
        overlayAnswerStyleRef.current = snapshot.answerStyle ?? "concise";
        setAnswerStyle(snapshot.answerStyle ?? "concise");
      }
      setConversationTurns(snapshot.conversationTurns);
    }, intervalMs);

    return () => {
      window.clearInterval(interval);
    };
  }, [privacy.screenCaptureIntervalSeconds, privacy.monitorMode, privacy.paused]);

  const activeConversationMode = conversationModeForMonitorMode(privacy.monitorMode);
  const displayedConversationTurns = mergeStreamingTurns(conversationTurns, streamingTurns)
    .filter((turn) => !activeConversationMode || turn.mode === activeConversationMode)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const streamingTurnIds = new Set(streamingTurns.map((turn) => turn.id));
  const streamedTurnAnswers = useStreamingConversationAnswers(displayedConversationTurns);
  const showConversation = Boolean(activeConversationMode) && displayedConversationTurns.length > 0;
  const isAnswerMode = privacy.monitorMode === "screen";

  async function updateOverlayPrivacy(next: Partial<PrivacySettings> & { answerStyle?: AnswerStyle }) {
    if (next.paused === false || next.monitorMode) {
      await overlayAnswerStyleSavePromiseRef.current?.catch(() => undefined);
      next = { ...next, answerStyle: overlayAnswerStyleRef.current };
      if (window.zhishik.updateAnswerStyle) {
        await window.zhishik.updateAnswerStyle(overlayAnswerStyleRef.current).catch(() => undefined);
      }
    }
    const settings = await window.zhishik.updatePrivacy(next);
    setPrivacy(settings);
    await refreshOverlaySnapshot();
  }

  async function updateOverlayAnswerStyle(next: AnswerStyle) {
    overlayAnswerStyleRef.current = next;
    pendingOverlayAnswerStyleRef.current = next;
    setAnswerStyle(next);
    if (!window.zhishik.updateAnswerStyle) {
      pendingOverlayAnswerStyleRef.current = null;
      return;
    }
    const savePromise = window.zhishik.updateAnswerStyle(next);
    overlayAnswerStyleSavePromiseRef.current = savePromise;
    try {
      const saved = await savePromise;
      overlayAnswerStyleRef.current = saved ?? next;
      setAnswerStyle(saved ?? next);
    } finally {
      if (overlayAnswerStyleSavePromiseRef.current === savePromise) {
        overlayAnswerStyleSavePromiseRef.current = null;
        pendingOverlayAnswerStyleRef.current = null;
      }
    }
  }

  async function endOverlayVoiceSession() {
    setConversationTurns([]);
    await window.zhishik.endConversationSession();
    await updateOverlayPrivacy({ paused: true });
  }

  function startOverlayDrag(event: ReactPointerEvent<HTMLElement>) {
    if (event.button !== 0 || isOverlayControlTarget(event.target)) {
      return;
    }
    overlayDragRef.current = { x: event.screenX, y: event.screenY, pointerId: event.pointerId };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  function moveOverlayDrag(event: ReactPointerEvent<HTMLElement>) {
    const drag = overlayDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    const x = event.screenX - drag.x;
    const y = event.screenY - drag.y;
    if (x || y) {
      window.zhishik.moveOverlayBy({ x, y });
      overlayDragRef.current = { ...drag, x: event.screenX, y: event.screenY };
    }
  }

  function stopOverlayDrag(event: ReactPointerEvent<HTMLElement>) {
    const drag = overlayDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    overlayDragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  async function regeneratePageAnswer() {
    setRegenerating(true);
    setAssistant({
      id: `sending-${Date.now()}`,
      createdAt: new Date().toISOString(),
      sourceApp: "答题模式",
      transcript: "",
      detectedQuestion: "正在截图并发送题目",
      translation: "正在截图并发送题目",
      summary: "正在截图并发送给视觉模型。",
      suggestedAnswer: "正在截图并发送给视觉模型，请稍等。",
      nextSteps: ["隐藏悬浮窗", "截取题目页面", "调用视觉模型"],
      citations: []
    });
    try {
      const frame = await window.zhishik.regeneratePageAnswer();
      if (frame) {
        setAssistant(frame);
      }
    } finally {
      setRegenerating(false);
    }
  }

  return (
    <main
      className="overlay-shell"
      style={
        {
          "--overlay-alpha": privacy.overlayOpacity,
          "--overlay-text": privacy.overlayTextColor,
          "--overlay-accent": privacy.overlayAccentColor
        } as React.CSSProperties
      }
    >
      <motion.section
        className={["overlay-panel", privacy.paused ? "paused" : "", isAnswerMode ? "answer-mode" : ""].filter(Boolean).join(" ")}
        onMouseEnter={() => window.zhishik.setOverlayIgnoreMouseEvents(false)}
        onMouseLeave={() => window.zhishik.setOverlayIgnoreMouseEvents(true)}
        onPointerDown={startOverlayDrag}
        onPointerMove={moveOverlayDrag}
        onPointerUp={stopOverlayDrag}
        onPointerCancel={stopOverlayDrag}
        initial={{ y: 20, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.28 }}
      >
        <div className="overlay-top">
          <span>{privacy.paused ? "已暂停" : assistant.sourceApp}</span>
          <strong>{isAnswerMode ? cleanOverlayQuestion(assistant.detectedQuestion || assistant.transcript) : assistant.translation}</strong>
        </div>
        <div className="overlay-controls">
          <label>
            <span>透明度</span>
            <input
              type="range"
              min="0"
              max="0.85"
              step="0.01"
              value={privacy.overlayOpacity}
              onChange={(event) => updateOverlayPrivacy({ overlayOpacity: Number(event.target.value) })}
            />
          </label>
          <label className="overlay-color-control">
            <span>字体</span>
            <input type="color" value={privacy.overlayTextColor} onChange={(event) => updateOverlayPrivacy({ overlayTextColor: event.target.value })} />
          </label>
          <button className="overlay-monitor-toggle" onClick={() => updateOverlayPrivacy({ paused: !privacy.paused })}>
            {privacy.paused ? <Play size={14} /> : <Pause size={14} />}
            {privacy.paused ? "继续监控" : "暂停监控"}
          </button>
          {activeConversationMode && (
            <button className="overlay-monitor-toggle end-session" onClick={endOverlayVoiceSession}>
              <Square size={13} />
              {privacy.monitorMode === "meeting" ? "结束会议" : "结束面试"}
            </button>
          )}
          {isAnswerMode && (
            <button className="overlay-regenerate" onClick={regeneratePageAnswer} disabled={regenerating}>
              {regenerating ? "发送中" : "发送题目"}
            </button>
          )}
        </div>
        {activeConversationMode && (
          <AnswerStylePicker answerStyle={answerStyle} updateAnswerStyle={updateOverlayAnswerStyle} compact />
        )}
        {!isAnswerMode && (
          <RecognitionStatus liveTranscript={liveTranscript} recognizedTranscript={recognizedTranscript} analysisLoading={analysisLoading} compact />
        )}
        {showConversation ? (
          <div className="overlay-thread" onWheel={(event) => event.stopPropagation()}>
            {displayedConversationTurns.map((turn) => (
              <article className="overlay-turn" key={turn.id}>
                <header>
                  <span>{new Date(turn.createdAt).toLocaleTimeString()}</span>
                  <strong>{turn.mode === "interview" ? "面试官问题" : "会议记录"}</strong>
                </header>
                <div className="overlay-question">{turn.transcript || turn.detectedQuestion}</div>
                <div className="overlay-reply">{streamingTurnIds.has(turn.id) ? turn.suggestedAnswer : streamedTurnAnswers[turn.id] ?? turn.suggestedAnswer}</div>
              </article>
            ))}
          </div>
        ) : (
          <>
            <div className="overlay-answer" onWheel={(event) => event.stopPropagation()}>
              {assistant.suggestedAnswer}
            </div>
            <div className="overlay-steps">
              {assistant.nextSteps.slice(0, 2).map((step) => (
                <span key={step}>
                  <ChevronRight size={14} />
                  {step}
                </span>
              ))}
            </div>
          </>
        )}
      </motion.section>
    </main>
  );
}

function RecognitionStatus(props: { liveTranscript: string; recognizedTranscript: string; analysisLoading: boolean; compact?: boolean }) {
  const { liveTranscript, recognizedTranscript, analysisLoading, compact } = props;
  if (!liveTranscript && !recognizedTranscript && !analysisLoading) {
    return null;
  }

  return (
    <div className={compact ? "recognition-flow compact" : "recognition-flow"}>
      {liveTranscript && (
        <div className="recognition-line listening">
          <span>正在听</span>
          <strong>{liveTranscript}</strong>
        </div>
      )}
      {recognizedTranscript && !liveTranscript && (
        <div className="recognition-line recognized">
          <span>已识别</span>
          <strong>{recognizedTranscript}</strong>
        </div>
      )}
      {analysisLoading && (
        <div className="recognition-line analyzing">
          <span>AI 分析中</span>
          <strong>正在生成可直接口述的回答...</strong>
        </div>
      )}
    </div>
  );
}

function isOverlayControlTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return Boolean(target.closest("button, input, select, textarea, a, [data-overlay-no-drag]"));
}

function upsertStreamingTurn(turns: ConversationTurn[], next: ConversationTurn) {
  const existing = turns.find((turn) => turn.id === next.id);
  if (!existing) {
    return [next, ...turns].slice(0, 12);
  }
  return turns.map((turn) => (turn.id === next.id ? { ...turn, ...next } : turn));
}

function streamEventToTurn(event: AssistantStreamEvent, answer: string): ConversationTurn {
  return {
    id: event.id,
    createdAt: event.createdAt,
    mode: event.mode,
    sourceApp: event.sourceApp,
    transcript: event.transcript,
    detectedQuestion: event.transcript,
    summary: event.phase === "start" ? "AI 分析中" : "",
    suggestedAnswer: answer || (event.phase === "start" ? "AI 分析中..." : ""),
    nextSteps: []
  };
}

function frameToStreamingTurn(frame: AssistantFrame, mode: ConversationTurn["mode"]): ConversationTurn {
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

function mergeStreamingTurns(conversationTurns: ConversationTurn[], streamingTurns: ConversationTurn[]) {
  if (streamingTurns.length === 0) {
    return conversationTurns;
  }
  const streamingIds = new Set(streamingTurns.map((turn) => turn.id));
  return [...streamingTurns, ...conversationTurns.filter((turn) => !streamingIds.has(turn.id))];
}

function AnswerStylePicker(props: {
  answerStyle: AnswerStyle;
  updateAnswerStyle: (style: AnswerStyle) => void;
  compact?: boolean;
}) {
  return (
    <div className={props.compact ? "answer-style-picker compact" : "answer-style-picker"}>
      {answerStyles.map((style) => (
        <button
          key={style.id}
          className={props.answerStyle === style.id ? "selected" : ""}
          onClick={() => props.updateAnswerStyle(style.id)}
          title={style.hint}
          type="button"
        >
          <span>{style.label}</span>
          <small>{style.hint}</small>
        </button>
      ))}
    </div>
  );
}

function AssistantView(props: {
  assistant: AssistantFrame;
  question: string;
  setQuestion: (value: string) => void;
  askAssistant: () => void;
  answerStyle: AnswerStyle;
  updateAnswerStyle: (style: AnswerStyle) => void;
  privacy: PrivacySettings;
  documents: DocumentRecord[];
  sources: Array<{ id: string; name: string }>;
  conversationTurns: ConversationTurn[];
  streamingTurns: ConversationTurn[];
  busy: boolean;
  liveTranscript: string;
  recognizedTranscript: string;
  analysisLoading: boolean;
  streamedAnswer: string;
}) {
  const {
    assistant,
    question,
    setQuestion,
    askAssistant,
    answerStyle,
    updateAnswerStyle,
    privacy,
    documents,
    sources,
    conversationTurns,
    streamingTurns,
    busy,
    liveTranscript,
    recognizedTranscript,
    analysisLoading,
    streamedAnswer
  } = props;
  const activeConversationMode = conversationModeForMonitorMode(privacy.monitorMode);
  const showAnswerStylePicker = privacy.monitorMode === "meeting" || privacy.monitorMode === "interview";
  const displayedConversationTurns = mergeStreamingTurns(conversationTurns, streamingTurns)
    .filter((turn) => !activeConversationMode || turn.mode === activeConversationMode)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const streamingTurnIds = new Set(streamingTurns.map((turn) => turn.id));
  const streamedTurnAnswers = useStreamingConversationAnswers(displayedConversationTurns);
  const answerText = streamedAnswer || assistant.suggestedAnswer;

  return (
    <div className="assistant-grid">
      <section className="answer-pane">
        <div className="section-label">
          <Radar size={17} />
          当前问题
        </div>
        <textarea value={question} onChange={(event) => setQuestion(event.target.value)} />
        {showAnswerStylePicker && <AnswerStylePicker answerStyle={answerStyle} updateAnswerStyle={updateAnswerStyle} />}
        <button className="primary wide" onClick={askAssistant} disabled={busy}>
          <Sparkles size={17} />
          {busy ? "生成中..." : "结合知识库回答"}
        </button>
        <div className="section-label spaced">
          <Mic size={17} />
          实时识别
        </div>
        <RecognitionStatus liveTranscript={liveTranscript} recognizedTranscript={recognizedTranscript} analysisLoading={analysisLoading} />
        <div className="live-line">
          <span>{liveTranscript ? "实时转写中" : assistant.sourceApp}</span>
          <strong>{liveTranscript || assistant.detectedQuestion}</strong>
        </div>

        <div className="section-label spaced">
          <FileText size={17} />
          推荐回答
        </div>
        <div className={analysisLoading && !streamedAnswer ? "answer-text loading" : "answer-text"}>
          {analysisLoading && !streamedAnswer ? "AI 正在分析..." : answerText}
        </div>
        <button className="ghost" onClick={() => navigator.clipboard.writeText(answerText)}>
          <Copy size={16} />
          复制回答
        </button>
        <div className="section-label spaced">
          <Captions size={17} />
          会议/面试问答记录
        </div>
        <div className="voice-thread">
          {conversationTurns.length === 0 && <p>开启会议模式或面试模式后，所有转写内容和对应回答会保留在这里。</p>}
          {displayedConversationTurns.map((turn) => (
            <article className="voice-turn" key={turn.id}>
              <header>
                <span>{new Date(turn.createdAt).toLocaleTimeString()}</span>
                <strong>{turn.mode === "interview" ? "面试官问题" : "会议记录"}</strong>
              </header>
              <div className="voice-transcript">{turn.transcript || turn.detectedQuestion}</div>
              <div className="voice-answer">{streamingTurnIds.has(turn.id) ? turn.suggestedAnswer : streamedTurnAnswers[turn.id] ?? turn.suggestedAnswer}</div>
            </article>
          ))}
        </div>
      </section>

      <aside className="inspector">
        <Metric label="知识资料" value={`${documents.length} 份`} icon={BookOpen} />
        <Metric label="监控模式" value={monitorModeLabel(privacy.monitorMode)} icon={Radar} />

        <div className="plain-panel">
          <h2>知识依据</h2>
          <div className="citations">
            {assistant.citations.length === 0 && <p>还没有可引用资料。</p>}
            {assistant.citations.map((hit) => (
              <div className="citation" key={hit.chunkId}>
                <strong>{hit.documentName}</strong>
                <span>{hit.excerpt}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="plain-panel">
          <h2>可见窗口</h2>
          <div className="source-list">
            {sources.slice(0, 6).map((source) => (
              <span key={source.id}>{source.name}</span>
            ))}
          </div>
        </div>
      </aside>
    </div>
  );
}

function KnowledgeView(props: {
  groupedDocs: Array<{ id: KnowledgeSpace; label: string; docs: DocumentRecord[] }>;
  selectedSpace: KnowledgeSpace;
  setSelectedSpace: (space: KnowledgeSpace) => void;
  importDocuments: () => void;
  removeDocument: (id: string) => void;
  personalPrompt: string;
  updatePersonalPrompt: (prompt: string) => Promise<void>;
  busy: boolean;
}) {
  const [draftPrompt, setDraftPrompt] = useState(props.personalPrompt ?? "");
  const [savingPrompt, setSavingPrompt] = useState(false);

  useEffect(() => {
    setDraftPrompt(props.personalPrompt ?? "");
  }, [props.personalPrompt]);

  async function savePersonalPrompt() {
    setSavingPrompt(true);
    try {
      await props.updatePersonalPrompt(draftPrompt);
    } finally {
      setSavingPrompt(false);
    }
  }

  return (
    <div className="knowledge-layout">
      <div className="knowledge-side">
      <section className="import-panel">
        <div className="section-label">
          <Plus size={17} />
          导入资料
        </div>
        <div className="segmented">
          {spaces.map((space) => (
            <button className={props.selectedSpace === space.id ? "selected" : ""} key={space.id} onClick={() => props.setSelectedSpace(space.id)}>
              {space.label}
            </button>
          ))}
        </div>
        <button className="primary wide" onClick={props.importDocuments} disabled={props.busy}>
          <Plus size={17} />
          选择 PDF / DOCX / MD / TXT
        </button>
      </section>

        <section className="import-panel personal-prompt-panel">
          <div className="section-label">
            <Sparkles size={17} />
            个人资料提示词
          </div>
          <textarea
            value={draftPrompt}
            maxLength={6000}
            onChange={(event) => setDraftPrompt(event.target.value)}
            placeholder="例如：我是 3 年前端工程师，主做 React/Electron；回答面试问题时突出项目经验、数据结果和我负责的部分。"
          />
          <div className="prompt-actions">
            <span>{draftPrompt.length}/6000</span>
            <button className="primary compact" onClick={savePersonalPrompt} disabled={savingPrompt || draftPrompt === props.personalPrompt}>
              <Sparkles size={15} />
              {savingPrompt ? "保存中" : draftPrompt === props.personalPrompt ? "已保存" : "保存"}
            </button>
          </div>
        </section>
      </div>

      <section className="doc-table">
        {props.groupedDocs.map((group) => (
          <div className="doc-group" key={group.id}>
            <h2>{group.label}</h2>
            {group.docs.length === 0 && <p className="empty">暂无资料</p>}
            {group.docs.map((doc) => (
              <div className="doc-row" key={doc.id}>
                <FileText size={18} />
                <div>
                  <strong>{doc.name}</strong>
                  <span>{doc.status === "indexed" ? `${doc.chunkCount} 个片段` : doc.error}</span>
                </div>
                <button className="icon-button" title="在文件夹中显示" onClick={() => window.zhishik.openPath(doc.path)}>
                  <Search size={16} />
                </button>
                <button className="icon-button danger" title="删除" onClick={() => props.removeDocument(doc.id)}>
                  <Trash2 size={16} />
                </button>
              </div>
            ))}
          </div>
        ))}
      </section>
    </div>
  );
}

function PrivacyView(props: {
  privacy: PrivacySettings;
  sources: Array<{ id: string; name: string }>;
  updatePrivacy: (next: Partial<PrivacySettings>) => void;
}) {
  const { privacy, updatePrivacy, sources } = props;
  const selectMonitorMode = (monitorMode: PrivacySettings["monitorMode"]) => updatePrivacy({ monitorMode, paused: false });
  return (
    <div className="settings-layout">
      <section className="plain-panel monitor-mode-panel">
        <h2>监控模式</h2>
        <div className="mode-options">
          <button className={privacy.monitorMode === "screen" ? "selected" : ""} onClick={() => selectMonitorMode("screen")}>
            答题模式
          </button>
          <button className={privacy.monitorMode === "meeting" ? "selected" : ""} onClick={() => selectMonitorMode("meeting")}>
            会议模式
          </button>
          <button className={privacy.monitorMode === "interview" ? "selected" : ""} onClick={() => selectMonitorMode("interview")}>
            面试模式
          </button>
        </div>
      </section>

      <ToggleRow
        title="暂停实时监控"
        description="暂停后不再读取活动窗口，也不会生成新的实时建议。"
        checked={privacy.paused}
        onChange={(checked) => updatePrivacy({ paused: checked })}
      />
      <ToggleRow
        title="仅监控当前活动窗口"
        description="默认只读取你正在使用的窗口，避免全屏无差别采集。"
        checked={privacy.monitorActiveWindowOnly}
        onChange={(checked) => updatePrivacy({ monitorActiveWindowOnly: checked })}
      />
      <ToggleRow
        title="允许云端 AI"
        description="关闭后保留本地检索和隐私控制，不调用云端总结与问答。"
        checked={privacy.cloudEnabled}
        onChange={(checked) => updatePrivacy({ cloudEnabled: checked })}
      />
      <ToggleRow
        title="AI 视觉理解屏幕"
        description="开启后发送屏幕截图给支持图片输入的模型，让 AI 判断你正在做什么工作。"
        checked={privacy.visionUnderstandingEnabled}
        onChange={(checked) => updatePrivacy({ visionUnderstandingEnabled: checked })}
      />
      <ToggleRow
        title="本地 OCR 降级"
        description="仅在需要文字检索时开启；它可能产生乱码，默认关闭。"
        checked={privacy.localOcrEnabled}
        onChange={(checked) => updatePrivacy({ localOcrEnabled: checked })}
      />

      <section className="plain-panel overlay-settings">
        <h2>悬浮条样式</h2>
        <label>
          <span>背景透明度 {Math.round((1 - privacy.overlayOpacity) * 100)}%</span>
          <input
            type="range"
            min="0"
            max="0.85"
            step="0.01"
            value={privacy.overlayOpacity}
            onChange={(event) => updatePrivacy({ overlayOpacity: Number(event.target.value) })}
          />
        </label>
        <div className="color-controls">
          <label>
            <span>字体颜色</span>
            <input type="color" value={privacy.overlayTextColor} onChange={(event) => updatePrivacy({ overlayTextColor: event.target.value })} />
          </label>
          <label>
            <span>强调色</span>
            <input type="color" value={privacy.overlayAccentColor} onChange={(event) => updatePrivacy({ overlayAccentColor: event.target.value })} />
          </label>
        </div>
      </section>

      <section className="plain-panel">
        <h2>应用黑名单</h2>
        <div className="app-list">
          {privacy.appBlacklist.length === 0 && <p className="empty">未设置黑名单，默认允许观察可见工作窗口。</p>}
          {privacy.appBlacklist.map((appName) => (
            <button
              className="app-chip blocked"
              key={appName}
              onClick={() => updatePrivacy({ appBlacklist: privacy.appBlacklist.filter((item) => item !== appName) })}
              title="点击移除"
            >
              {appName}
            </button>
          ))}
        </div>
      </section>

      <section className="plain-panel">
        <h2>从本机可见应用中选择</h2>
        <div className="source-list app-picker">
          {uniqueSourceNames(sources).map((name) => {
            const blocked = privacy.appBlacklist.some((item) => item === name);
            return (
              <button
                className={blocked ? "app-chip blocked" : "app-chip"}
                key={name}
                onClick={() =>
                  updatePrivacy({
                    appBlacklist: blocked ? privacy.appBlacklist.filter((item) => item !== name) : [...privacy.appBlacklist, name]
                  })
                }
                title={blocked ? "点击移出黑名单" : "点击加入黑名单"}
              >
                {name}
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function SessionsView(props: {
  sessions: ConversationSessionWithTurns[];
  updateTitle: (sessionId: string, title: string) => Promise<void>;
}) {
  const groups: Array<{ mode: ConversationSessionWithTurns["mode"]; title: string }> = [
    { mode: "meeting", title: "会议记录" },
    { mode: "interview", title: "面试记录" }
  ];

  return (
    <div className="settings-layout">
      {groups.map((group) => {
        const sessions = props.sessions.filter((session) => session.mode === group.mode);
        return (
          <section className="plain-panel session-group" key={group.mode}>
            <h2>{group.title}</h2>
            {sessions.length === 0 && <p className="empty">暂无{group.title}。停止语音转写、暂停监控或切换模式后，会自动结算为一场记录。</p>}
            <div className="session-list">
              {sessions.map((session) => (
                <article className="session-card" key={session.id}>
                  <header>
                    <input
                      value={session.title}
                      onChange={(event) => props.updateTitle(session.id, event.target.value)}
                      aria-label="会话标题"
                    />
                    <span>
                      {new Date(session.startedAt).toLocaleString()}
                      {session.endedAt ? ` - ${new Date(session.endedAt).toLocaleTimeString()}` : " - 进行中"}
                    </span>
                  </header>
                  <div className="voice-thread compact-thread">
                    {session.turns.map((turn) => (
                      <article className="voice-turn" key={turn.id}>
                        <header>
                          <span>{new Date(turn.createdAt).toLocaleTimeString()}</span>
                          <strong>{turn.mode === "interview" ? "面试官问题" : "会议发言"}</strong>
                        </header>
                        <div className="voice-transcript">{turn.transcript || turn.detectedQuestion}</div>
                        <div className="voice-answer">{turn.suggestedAnswer}</div>
                      </article>
                    ))}
                  </div>
                </article>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function ModelView(props: { model: ModelSettings; updateModel: (next: Partial<ModelSettings>) => void }) {
  const { model, updateModel } = props;

  function chooseProvider(provider: ModelProvider) {
    const preset = providerPresets.find((item) => item.id === provider);
    if (!preset) return;
    updateModel({
      provider,
      baseUrl: provider === "custom" ? model.baseUrl : preset.baseUrl,
      chatModel: provider === "custom" ? model.chatModel : preset.model
    });
  }

  return (
    <div className="settings-layout">
      <section className="plain-panel model-settings">
        <h2>通用模型接口</h2>
        <label>
          <span>供应商预设</span>
          <select value={model.provider} onChange={(event) => chooseProvider(event.target.value as ModelProvider)}>
            {providerPresets.map((preset) => (
              <option value={preset.id} key={preset.id}>
                {preset.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Base URL</span>
          <input value={model.baseUrl} onChange={(event) => updateModel({ provider: "custom", baseUrl: event.target.value })} placeholder="https://api.example.com/v1" />
        </label>
        <label>
          <span>API Key</span>
          <input type="password" value={model.apiKey} onChange={(event) => updateModel({ apiKey: event.target.value })} placeholder="sk-..." />
        </label>
        <label>
          <span>Chat Model</span>
          <input value={model.chatModel} onChange={(event) => updateModel({ chatModel: event.target.value })} placeholder="model-name" />
        </label>
        <ToggleRow
          title="模型支持图片输入"
          description="开启后会把屏幕截图随请求发送给模型；关闭则只发送文字上下文。"
          checked={model.visionEnabled}
          onChange={(checked) => updateModel({ visionEnabled: checked })}
        />
        {model.visionEnabled && !hasSeparateVisionModel(model) && !isLikelyVisionChatModel(model.chatModel) && (
          <p className="model-note warning">
            当前 Chat Model 看起来不是看图答题模型。阿里云接口会自动改用 qwen-vl-plus-latest；其他供应商请单独填写支持图片输入的 VL/vision 模型。
          </p>
        )}
      </section>

      <section className="plain-panel model-settings">
        <h2>视觉模型接口</h2>
        <p className="model-note">用于答题模式识别截图、图表和页面结构；要填图片输入、文本输出的 VL/vision 模型，不是生图/生视频模型。</p>
        <label>
          <span>Vision Base URL</span>
          <input value={model.visionBaseUrl} onChange={(event) => updateModel({ visionBaseUrl: event.target.value })} placeholder="https://dashscope.aliyuncs.com/compatible-mode/v1" />
        </label>
        <label>
          <span>Vision API Key</span>
          <input type="password" value={model.visionApiKey} onChange={(event) => updateModel({ visionApiKey: event.target.value })} placeholder="sk-..." />
        </label>
        <label>
          <span>Vision Model</span>
          <input value={model.visionModel} onChange={(event) => updateModel({ visionModel: event.target.value })} placeholder="qwen-vl-max / gpt-4o / glm-4v-plus" />
        </label>
        {isImageGenerationModelName(model.visionModel) && (
          <p className="model-note warning">
            当前填写的是图片生成模型，不是看图答题模型。阿里云答题会自动改用 qwen-vl-plus-latest；建议直接把视觉模型名改成 qwen-vl-plus-latest。
          </p>
        )}
        <button
          className="ghost compact"
          onClick={() => updateModel({ visionBaseUrl: model.baseUrl, visionApiKey: model.apiKey, visionModel: model.chatModel })}
        >
          沿用通用模型配置
        </button>
      </section>

      <section className="plain-panel model-settings">
        <h2>语音转写</h2>
        <label>
          <span>转写接口</span>
          <select
            value={model.transcriptionProvider}
            onChange={(event) => {
              const provider = event.target.value as ModelSettings["transcriptionProvider"];
              updateModel({ transcriptionProvider: provider, transcriptionEnabled: provider === "disabled" ? false : model.transcriptionEnabled });
            }}
          >
            <option value="openai">OpenAI-compatible /audio/transcriptions</option>
            <option value="aliyun">阿里云 Paraformer</option>
            <option value="xfyun">科大讯飞实时转写</option>
            <option value="disabled">关闭</option>
          </select>
        </label>
        <ToggleRow
          title="启用语音转写"
          description="关闭后不会调用任何语音转写服务，也不会自动打开麦克风或系统声音采集。"
          checked={model.transcriptionEnabled}
          onChange={(checked) =>
            updateModel({
              transcriptionEnabled: checked,
              transcriptionProvider: checked && model.transcriptionProvider === "disabled" ? "xfyun" : model.transcriptionProvider
            })
          }
        />
        <ToggleRow
          title="启用中英翻译 / 双语回答"
          description="关闭后即使识别到英文，也只生成中文摘要、中文建议和中文回答。"
          checked={model.translationEnabled}
          onChange={(checked) => updateModel({ translationEnabled: checked })}
        />
        <label>
          <span>音频来源</span>
          <select
            value={model.transcriptionAudioSource}
            onChange={(event) => updateModel({ transcriptionAudioSource: event.target.value as ModelSettings["transcriptionAudioSource"] })}
          >
            <option value="microphone">麦克风</option>
            <option value="system">系统声音 / 会议声音</option>
          </select>
        </label>
        {model.transcriptionProvider === "xfyun" ? (
          <div className="xfyun-grid">
            <label>
              <span>服务版本</span>
              <select
                value={model.xfyunServiceType}
                onChange={(event) => {
                  const serviceType = event.target.value as ModelSettings["xfyunServiceType"];
                  updateModel({
                    xfyunServiceType: serviceType,
                    xfyunEndpoint:
                      serviceType === "iat-webapi"
                        ? "wss://iat-api.xfyun.cn/v2/iat"
                        : serviceType === "iat"
                          ? "wss://iat.xf-yun.com/v1"
                          : serviceType === "large-model"
                            ? "wss://office-api-ast-dx.iflyaisol.com/ast/communicate/v1"
                            : "wss://rtasr.xfyun.cn/v1/ws",
                    xfyunDomain: serviceType === "iat-webapi" ? "iat" : serviceType === "iat" ? "slm" : serviceType === "large-model" ? "general" : model.xfyunDomain
                  });
                }}
              >
                <option value="iat-webapi">语音听写流式版 WebApi（普通版）</option>
                <option value="iat">中英识别大模型 / 语音听写流式版 Spark</option>
                <option value="large-model">实时语音转写大模型（需单独 accessKey 授权）</option>
                <option value="standard">实时语音转写标准版</option>
              </select>
            </label>
            <label>
              <span>APPID</span>
              <input value={model.xfyunAppId} onChange={(event) => updateModel({ xfyunAppId: event.target.value.trim() })} placeholder="讯飞 APPID" />
            </label>
            <label>
              <span>APIKey</span>
              <input type="password" value={model.xfyunApiKey} onChange={(event) => updateModel({ xfyunApiKey: event.target.value.trim() })} placeholder="讯飞 APIKey" />
            </label>
            <label>
              <span>APISecret</span>
              <input type="password" value={model.xfyunApiSecret} onChange={(event) => updateModel({ xfyunApiSecret: event.target.value.trim() })} placeholder="讯飞 APISecret" />
            </label>
            <label>
              <span>Endpoint</span>
              <input value={model.xfyunEndpoint} onChange={(event) => updateModel({ xfyunEndpoint: event.target.value.trim() })} placeholder="wss://iat-api.xfyun.cn/v2/iat" />
            </label>
            <label>
              <span>语言</span>
              <select value={model.xfyunLanguage} onChange={(event) => updateModel({ xfyunLanguage: event.target.value as ModelSettings["xfyunLanguage"] })}>
                <option value="cn">中文 / 中英混合</option>
                <option value="en">英文</option>
              </select>
            </label>
            <label>
              <span>领域</span>
              <input value={model.xfyunDomain} onChange={(event) => updateModel({ xfyunDomain: event.target.value })} placeholder="iat" />
            </label>
            <label>
              <span>音频分片字节</span>
              <input type="number" min="320" step="320" value={model.xfyunChunkSize} onChange={(event) => updateModel({ xfyunChunkSize: Number(event.target.value) })} />
            </label>
          </div>
        ) : (
          <label>
            <span>转写模型</span>
            <input value={model.transcriptionModel} onChange={(event) => updateModel({ transcriptionModel: event.target.value })} placeholder="gpt-4o-mini-transcribe" />
          </label>
        )}
        {model.transcriptionProvider === "xfyun" && isXfyunMaasEndpoint(model.xfyunEndpoint) && (
          <p className="model-note warning">
            当前 Endpoint 是 MaaS/模型服务地址（maas-api.../chat），不是语音听写 WebApi。请改用语音听写服务页的密钥，或切到本应用已支持的实时转写服务。
          </p>
        )}
        {model.transcriptionProvider === "xfyun" && (
          <button className="ghost compact" onClick={() => updateModel({ transcriptionEnabled: false, transcriptionProvider: "disabled" })}>
            关闭讯飞语音转写
          </button>
        )}
        <p className="model-note">文本回答使用通用 OpenAI-compatible Chat Completions：只要模型商支持 /chat/completions，就填 Base URL、API Key 和模型名即可。</p>
        {model.transcriptionProvider === "xfyun" && (
          <p className="model-note">
            你当前控制台显示“开放能力 WebApi”时，请选“语音听写流式版 WebApi（普通版）”，Endpoint 为 wss://iat-api.xfyun.cn/v2/iat，领域为 iat。Spark 版和实时转写大模型是另外的服务，不能混用密钥。
          </p>
        )}
      </section>
    </div>
  );
}

function Metric(props: { label: string; value: string; icon: typeof Sparkles }) {
  const Icon = props.icon;
  return (
    <div className="metric">
      <Icon size={18} />
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  );
}

function ToggleRow(props: { title: string; description: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <section className="toggle-row">
      <div>
        <h2>{props.title}</h2>
        <p>{props.description}</p>
      </div>
      <button className={props.checked ? "switch on" : "switch"} onClick={() => props.onChange(!props.checked)} aria-label={props.title}>
        <span />
      </button>
    </section>
  );
}

function tabTitle(tab: Tab) {
  return {
    assistant: "实时辅助",
    knowledge: "知识库",
    privacy: "隐私控制",
    sessions: "会话记录",
    model: "模型设置"
  }[tab];
}

function monitorModeLabel(mode: PrivacySettings["monitorMode"]) {
  return {
    smart: "答题",
    screen: "答题",
    meeting: "会议",
    interview: "面试"
  }[mode];
}

function useStreamingConversationAnswers(turns: ConversationTurn[]) {
  const mountedAtRef = useRef(Date.now());
  const fullAnswersRef = useRef<Record<string, string>>({});
  const timersRef = useRef<Record<string, number>>({});
  const [streamed, setStreamed] = useState<Record<string, string>>({});

  useEffect(() => {
    const activeIds = new Set(turns.map((turn) => turn.id));
    for (const id of Object.keys(timersRef.current)) {
      if (!activeIds.has(id)) {
        window.clearInterval(timersRef.current[id]);
        delete timersRef.current[id];
      }
    }

    for (const turn of turns) {
      const answer = turn.suggestedAnswer || "";
      if (!answer || fullAnswersRef.current[turn.id] === answer) {
        continue;
      }

      fullAnswersRef.current[turn.id] = answer;
      const createdAt = new Date(turn.createdAt).getTime();
      const shouldStream = Number.isFinite(createdAt) && createdAt >= mountedAtRef.current - 1200;
      if (!shouldStream) {
        setStreamed((current) => ({ ...current, [turn.id]: answer }));
        continue;
      }

      if (timersRef.current[turn.id]) {
        window.clearInterval(timersRef.current[turn.id]);
      }
      let index = 0;
      setStreamed((current) => ({ ...current, [turn.id]: "" }));
      timersRef.current[turn.id] = window.setInterval(() => {
        index = Math.min(answer.length, index + 3);
        setStreamed((current) => ({ ...current, [turn.id]: answer.slice(0, index) }));
        if (index >= answer.length) {
          window.clearInterval(timersRef.current[turn.id]);
          delete timersRef.current[turn.id];
        }
      }, 38);
    }
  }, [turns]);

  useEffect(() => {
    return () => {
      for (const timer of Object.values(timersRef.current)) {
        window.clearInterval(timer);
      }
      timersRef.current = {};
    };
  }, []);

  return streamed;
}

function conversationModeForMonitorMode(mode: PrivacySettings["monitorMode"]): ConversationTurn["mode"] | null {
  if (mode === "interview") return "interview";
  if (mode === "meeting") return "meeting";
  return null;
}

function uniqueSourceNames(sources: Array<{ id: string; name: string }>) {
  return Array.from(new Set(sources.map((source) => source.name.trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b, "zh-CN"));
}

function isFatalTranscriptionFrame(frame: AssistantFrame) {
  const text = [frame.transcript, frame.detectedQuestion, frame.suggestedAnswer].filter(Boolean).join("\n").toLowerCase();
  return text.includes("licc") || text.includes("鉴权") || text.includes("授权/额度") || text.includes("授权或额度");
}

function transcriptionConfigKey(model: ModelSettings | null | undefined) {
  if (!model) return "";
  return [
    model.transcriptionProvider,
    model.xfyunServiceType,
    model.xfyunEndpoint,
    model.xfyunAppId,
    model.xfyunApiKey,
    model.xfyunApiSecret
  ].join("|");
}

function mergeLiveTranscript(previous: string, next: string) {
  const cleanNext = next.replace(/\s+/g, " ").trim();
  if (!cleanNext) return previous;
  if (!previous) return cleanNext;
  if (previous.endsWith(cleanNext) || previous.includes(cleanNext)) return previous;

  const maxOverlap = Math.min(previous.length, cleanNext.length);
  for (let length = maxOverlap; length > 4; length -= 1) {
    if (previous.slice(-length) === cleanNext.slice(0, length)) {
      return `${previous}${cleanNext.slice(length)}`;
    }
  }
  return `${previous} ${cleanNext}`.trim();
}

function cleanOverlayQuestion(text: string) {
  const cleaned = text
    .replace(/最近重点[:：]?/g, "")
    .replace(/请识别当前屏幕中的题目，?直接给出答案、?解题步骤和最终结论。?/g, "")
    .replace(/如果屏幕不是题目，?请说明需要补充哪些题目信息。?/g, "")
    .replace(/[\/\s]+/g, " ")
    .trim();
  return cleaned || "识别题目中";
}

function isXfyunMaasEndpoint(endpoint: string) {
  return /(^|\/\/)maas-api\./i.test(endpoint) || /\/v1(?:\.\d+)?\/chat(?:$|\?)/i.test(endpoint);
}

function hasSeparateVisionModel(model: ModelSettings) {
  return Boolean(model.visionBaseUrl.trim() && model.visionApiKey.trim() && model.visionModel.trim());
}

function isLikelyVisionChatModel(model: string) {
  const normalized = model.toLowerCase();
  if (/deepseek|v3|v4|flash/.test(normalized) && !/vision|vl|omni|multimodal/.test(normalized)) {
    return false;
  }
  return /vision|vl|omni|multimodal|gpt-4o|gpt-4\.1|qwen.*vl|glm-4v|doubao.*vision/i.test(normalized);
}

function isImageGenerationModelName(model: string) {
  const normalized = model.toLowerCase();
  return /(^|[-_/])(?:qwen-)?image(?:[-_/]|$)|wanx|stable-diffusion|dall-e|flux|midjourney|text-to-image|image-generation/.test(normalized);
}

function floatTo16kPcm(input: Float32Array, sourceRate: number) {
  const targetRate = 16000;
  const ratio = sourceRate / targetRate;
  const length = Math.floor(input.length / ratio);
  const output = new Int16Array(length);

  for (let i = 0; i < length; i += 1) {
    const sourceIndex = Math.floor(i * ratio);
    const sample = Math.max(-1, Math.min(1, input[sourceIndex] ?? 0));
    output[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }

  return output;
}

function concatInt16(chunks: Int16Array[]) {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const output = new Int16Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function calculateRms(input: Float32Array) {
  if (input.length === 0) return 0;
  let sum = 0;
  for (let index = 0; index < input.length; index += 1) {
    sum += input[index] * input[index];
  }
  return Math.sqrt(sum / input.length);
}

async function getTranscriptionAudioStream(source: ModelSettings["transcriptionAudioSource"]) {
  if (source === "microphone") {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("当前环境不支持麦克风采集。");
    }
    return navigator.mediaDevices.getUserMedia({ audio: true });
  }

  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new Error("当前 Electron 环境不支持系统声音采集，请改用麦克风模式。");
  }

  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: true
  });
  const audioTracks = stream.getAudioTracks();
  if (audioTracks.length === 0) {
    stream.getTracks().forEach((track) => track.stop());
    throw new Error("没有捕获到系统声音。请选择支持共享系统音频的屏幕/窗口，并勾选共享音频。");
  }

  // Keep the capture session alive, but we do not render the video track.
  stream.getVideoTracks().forEach((track) => {
    track.enabled = false;
  });
  return stream;
}

function formatAudioError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "");
  if (/not supported/i.test(message)) {
    return "当前环境暂不支持系统声音采集。请切到“麦克风”音频来源，或重启应用后再试系统声音。";
  }
  if (/permission|denied|notallowed/i.test(message)) {
    return "音频权限被拒绝。请允许麦克风/屏幕音频权限后再开启语音转写。";
  }
  return message || "无法访问音频输入。";
}

function tabSubtitle(tab: Tab) {
  return {
    assistant: "根据当前窗口、会议字幕和资料给出回答与下一步。",
    knowledge: "导入简历、项目和企业资料，建立本地索引。",
    privacy: "控制监控范围、应用黑名单和云端 AI 开关。",
    sessions: "按会议和面试分开保存语音、问题和对应回答。",
    model: "配置任意 OpenAI-compatible 模型供应商。"
  }[tab];
}

createRoot(document.getElementById("root")!).render(<App />);
