import type { ModelSettings, SearchHit, WorkEvent } from "../shared/types";
import { XfyunRtasrClient } from "./xfyunRtasr";

type AssistantPayload = {
  detectedQuestion: string;
  translation: string;
  summary: string;
  suggestedAnswer: string;
  nextSteps: string[];
};

type AssistantDeltaHandler = (delta: string) => void;

export class AiClient {
  private xfyun = new XfyunRtasrClient();

  async generateAssistantFrame(input: {
    model: ModelSettings;
    transcript: string;
    screenText: string;
    screenshotDataUrl?: string;
    citations: SearchHit[];
    rollingSummary: string;
    hiddenContext?: string;
    bilingualRequired?: boolean;
  }): Promise<AssistantPayload | null> {
    const requestModel = resolveAssistantRequestModel(input.model, Boolean(input.screenshotDataUrl));
    if (!requestModel) return null;

    const response = await fetch(`${normalizeBaseUrl(requestModel.baseUrl)}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${requestModel.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: requestModel.model,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: buildAssistantSystemPrompt(prefersEnglishOutput(input), true)
          },
          {
            role: "system",
            content: "If hiddenContext asks for English output, use the required English-first bilingual format even when the user question is Chinese."
          },
          {
            role: "user",
            content: buildUserContent(input, requestModel.useImage)
          }
        ]
      })
    });

    if (!response.ok) {
      throw new Error(`LLM request failed: ${response.status} ${await response.text()}`);
    }

    const json = (await response.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
    const content = extractMessageContent(json.choices?.[0]?.message?.content);
    if (!content) return null;

    try {
      const parsed = JSON.parse(content) as Partial<AssistantPayload>;
      return {
        detectedQuestion: parsed.detectedQuestion?.trim() || input.transcript || "未检测到明确问题",
        translation: parsed.translation?.trim() || input.transcript,
        summary: parsed.summary?.trim() || input.rollingSummary,
        suggestedAnswer: parsed.suggestedAnswer?.trim() || "已读取上下文，但模型没有生成回答。",
        nextSteps: Array.isArray(parsed.nextSteps) && parsed.nextSteps.length > 0 ? parsed.nextSteps.slice(0, 4) : ["确认问题重点", "结合知识库回答", "补充结果和数据"]
      };
    } catch {
      return {
        detectedQuestion: input.transcript || "根据当前屏幕内容继续推进",
        translation: input.transcript,
        summary: input.rollingSummary,
        suggestedAnswer: content,
        nextSteps: ["提炼一句结论", "补充项目依据", "准备追问回答"]
      };
    }
  }

  async generateAssistantFrameStream(input: {
    model: ModelSettings;
    transcript: string;
    screenText: string;
    screenshotDataUrl?: string;
    citations: SearchHit[];
    rollingSummary: string;
    hiddenContext?: string;
    bilingualRequired?: boolean;
    onDelta: AssistantDeltaHandler;
  }): Promise<AssistantPayload | null> {
    const requestModel = resolveAssistantRequestModel(input.model, Boolean(input.screenshotDataUrl));
    if (!requestModel) return null;

    const response = await fetch(`${normalizeBaseUrl(requestModel.baseUrl)}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${requestModel.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: requestModel.model,
        temperature: 0.2,
        stream: true,
        messages: [
          {
            role: "system",
            content: buildAssistantSystemPrompt(prefersEnglishOutput(input), false)
          },
          {
            role: "system",
            content: "If hiddenContext asks for English output, use the required English-first bilingual format even when the user question is Chinese."
          },
          {
            role: "user",
            content: buildUserContent(
              {
                ...input,
                transcript:
                  `${input.transcript}\n\nReturn a direct spoken answer. If this is an interview question, answer as the candidate. Prefer facts from citations/hiddenContext over generic interview templates. Keep it concise, concrete, and natural.`
              },
              requestModel.useImage
            )
          }
        ]
      })
    });

    if (!response.ok) {
      throw new Error(`LLM request failed: ${response.status} ${await response.text()}`);
    }

    const suggestedAnswer = (await readChatCompletionStream(response, input.onDelta)).trim();
    if (!suggestedAnswer) return null;

    return {
      detectedQuestion: input.transcript || "未检测到明确问题",
      translation: input.transcript,
      summary: input.rollingSummary,
      suggestedAnswer,
      nextSteps: ["确认问题重点", "直接口述回答", "准备追问补充"]
    };
  }

  async generateAnswerFrame(input: {
    model: ModelSettings;
    screenText: string;
    screenshotDataUrl?: string;
    hiddenContext?: string;
    citations: SearchHit[];
  }): Promise<AssistantPayload | null> {
    const requestModel = resolveAnswerRequestModel(input.model, Boolean(input.screenshotDataUrl));

    const payload = {
      model: requestModel.model,
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "user",
          content: buildAnswerUserContent(input, requestModel.useImage)
        }
      ]
    };

    let response = await fetch(`${normalizeBaseUrl(requestModel.baseUrl)}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${requestModel.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const firstStatus = response.status;
      const firstError = await response.text();
      if (!shouldRetryWithoutResponseFormat(firstStatus, firstError)) {
        throw new Error(`视觉模型请求失败：${firstStatus} ${firstError}`);
      }

      const retryPayload = { ...payload, response_format: undefined };
      response = await fetch(`${normalizeBaseUrl(requestModel.baseUrl)}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${requestModel.apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(retryPayload)
      });
      if (!response.ok) {
        throw new Error(`视觉模型请求失败：${response.status} ${await response.text()}；首次 JSON 模式错误：${firstError}`);
      }
    }

    const json = (await response.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
    const content = extractMessageContent(json.choices?.[0]?.message?.content);
    if (!content) {
      throw new Error(`视觉模型没有返回 content：${JSON.stringify(json).slice(0, 1000)}`);
    }

    try {
      const parsed = parseJsonObject(content) as Partial<AssistantPayload>;
      return {
        detectedQuestion: parsed.detectedQuestion?.trim() || "未识别到题目",
        translation: parsed.translation?.trim() || parsed.summary?.trim() || "",
        summary: parsed.summary?.trim() || parsed.detectedQuestion?.trim() || "",
        suggestedAnswer: parsed.suggestedAnswer?.trim() || content,
        nextSteps: Array.isArray(parsed.nextSteps) && parsed.nextSteps.length > 0 ? parsed.nextSteps.slice(0, 4) : ["确认题目", "给出思路", "提交代码"]
      };
    } catch {
      return {
        detectedQuestion: "屏幕题目",
        translation: "",
        summary: "已生成答案",
        suggestedAnswer: content.trim(),
        nextSteps: ["确认题目", "提交代码", "运行测试"]
      };
    }
  }

  async transcribeAudio(input: { model: ModelSettings; data: ArrayBuffer; mimeType: string }) {
    if (!input.model.transcriptionEnabled) {
      throw new Error("语音转写已关闭，请在模型设置里开启后再录音。");
    }

    if (input.model.transcriptionProvider === "disabled") {
      throw new Error("语音转写已关闭。");
    }

    if (input.model.transcriptionProvider === "aliyun") {
      throw new Error(
        "当前已切到阿里云 LLM。阿里云 Paraformer 录音文件识别需要先把音频上传到可访问 URL，再提交 file_urls；实时识别需要接 WebSocket。请先使用 OpenAI-compatible 转写，或接入 OSS + Paraformer。"
      );
    }

    if (input.model.transcriptionProvider === "xfyun") {
      if (!input.mimeType.includes("pcm")) {
        throw new Error("科大讯飞实时转写需要前端传入 16k 单声道 PCM 音频。");
      }
      return this.xfyun.transcribePcm({ model: input.model, pcm: input.data });
    }

    if (!input.model.apiKey) {
      throw new Error("未配置 API Key，无法调用云端语音转写。");
    }

    const extension = mimeTypeToExtension(input.mimeType);
    const form = new FormData();
    form.append("model", input.model.transcriptionModel);
    form.append("file", new Blob([input.data], { type: input.mimeType }), `meeting.${extension}`);
    form.append("response_format", "json");

    const response = await fetch(`${normalizeBaseUrl(input.model.baseUrl)}/audio/transcriptions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.model.apiKey}`
      },
      body: form
    });

    if (!response.ok) {
      throw new Error(`Transcription request failed: ${response.status} ${await response.text()}`);
    }

    const json = (await response.json()) as { text?: string };
    return json.text?.trim() ?? "";
  }

  async generateDailySummary(input: { model: ModelSettings; events: WorkEvent[] }) {
    if (!input.model.apiKey || !input.model.baseUrl || !input.model.chatModel) {
      return composeLocalDailySummary(input.events);
    }

    try {
      const response = await fetch(`${normalizeBaseUrl(input.model.baseUrl)}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${input.model.apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: input.model.chatModel,
          temperature: 0.2,
          messages: [
            {
              role: "system",
              content:
                "你是工作日志总结助手。根据一天的桌面工作记录，判断用户实际做了哪些工作内容，而不是复述助手建议。输出中文 Markdown：1. 今日主要工作 2. 具体工作内容 3. 产出/进展 4. 待办和风险 5. 明日建议。简洁但要具体。"
            },
            {
              role: "user",
              content: JSON.stringify({
                events: input.events.map((event) => ({
                  time: event.createdAt,
                  app: event.sourceApp,
                  observedWork: event.detectedQuestion,
                  contextSummary: event.summary,
                  assistantSuggestion: event.suggestedAnswer,
                  nextSteps: event.nextSteps
                }))
              })
            }
          ]
        })
      });

      if (!response.ok) {
        return `${composeLocalDailySummary(input.events)}\n\n注：云端总结失败，已使用本地总结。`;
      }

      const json = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
      return json.choices?.[0]?.message?.content?.trim() || composeLocalDailySummary(input.events);
    } catch {
      return `${composeLocalDailySummary(input.events)}\n\n注：云端总结请求异常，已使用本地总结。`;
    }
  }
}

function buildUserContent(input: {
  model: ModelSettings;
  transcript: string;
  screenText: string;
  screenshotDataUrl?: string;
  citations: SearchHit[];
  rollingSummary: string;
  hiddenContext?: string;
  bilingualRequired?: boolean;
}, useImage: boolean) {
  const text = JSON.stringify({
    instruction:
      "Understand what the user is doing and answer directly. hiddenContext is private reference only: do not quote it, do not summarize it, and do not expose context labels in the final answer.",
    transcript: input.transcript,
    screenText: input.screenText.slice(0, 3000),
    hiddenContext: input.hiddenContext?.slice(0, 1600) || "",
    citations: input.citations.map((hit) => ({
      documentName: hit.documentName,
      excerpt: hit.excerpt,
      score: hit.score
    })),
    rollingSummary: input.rollingSummary,
    bilingualRequired: input.bilingualRequired,
    translationEnabled: input.model.translationEnabled,
    outputLanguage: input.model.translationEnabled ? "bilingual only when needed" : "Chinese only"
  });

  if (!useImage || !input.screenshotDataUrl) {
    return text;
  }

  return [
    { type: "text", text },
    {
      type: "image_url",
      image_url: {
        url: input.screenshotDataUrl
      }
    }
  ];
}

function buildAnswerUserContent(input: {
  model: ModelSettings;
  screenText: string;
  screenshotDataUrl?: string;
  hiddenContext?: string;
  citations: SearchHit[];
}, useImage: boolean) {
  const instruction =
    "你是答题助手，只处理屏幕中的题目。必须返回严格 JSON：detectedQuestion, translation, summary, suggestedAnswer, nextSteps。detectedQuestion 只能是真实题目标题或问题本身，绝不能写提示词。suggestedAnswer 必须只包含题目和对应解决方案，不要面试话术，不要会议总结，不要说“建议先回应”。编程题按这个格式输出：题目：...\\n解法：...\\n代码：```语言\\n完整可提交代码\\n```\\n复杂度：...。如果屏幕编辑器语言是 C++ 就输出 C++；无法判断语言时默认 C++。非编程题按“问题：...\\n答案：...\\n步骤：...”输出。";
  const text = JSON.stringify({
    instruction,
    task: "识别当前屏幕中的题目并直接作答。不要把本 task 当成题目内容。",
    answerMode: "coding_or_exam",
    hiddenContext: input.hiddenContext?.slice(0, 1600) || "",
    outputRules: [
      "hiddenContext is private personal profile and answer preference reference only. Do not quote, summarize, or reveal it.",
      "只回答题目和解决方案，不输出面试/会议话术",
      "编程题必须给出可直接提交的完整代码",
      "编程题 suggestedAnswer 固定使用：题目 / 解法 / 代码 / 复杂度",
      "检测到 C++ 编辑器或无法判断语言时，代码用 C++",
      "有截图时必须优先根据截图识别真实题目、示例和编辑器语言",
      "OCR 文本只作辅助，可能包含浏览器地址栏、悬浮窗、历史错误提示或乱码；这些内容不是题目",
      "不要把 URL、浏览器标题、悬浮窗按钮、限流错误、滑杆文字当成题目",
      "如果题目文本为空，明确说明没有识别到题目，不要复述指令"
    ],
    ocrText: input.screenText.slice(0, 5000),
    citations: input.citations.map((hit) => ({
      documentName: hit.documentName,
      excerpt: hit.excerpt,
      score: hit.score
    }))
  });

  if (!useImage || !input.screenshotDataUrl) {
    return text;
  }

  return [
    { type: "text", text },
    {
      type: "image_url",
      image_url: {
        url: input.screenshotDataUrl
      }
    }
  ];
}

function buildAssistantSystemPrompt(englishFirstBilingual: boolean, jsonOutput: boolean) {
  const common = [
    jsonOutput
      ? "You are a real-time desktop assistant. Return strict JSON with detectedQuestion, translation, summary, suggestedAnswer, nextSteps."
      : "You are a real-time interview and meeting assistant. Stream only the final answer text that the user can say or use immediately.",
    "Treat resume/project citations and hiddenContext as the factual source of truth.",
    "Use hiddenContext only for understanding; never reveal, quote, or mention it.",
    "Do not invent names, years of experience, companies, project names, metrics, tech stacks, or responsibilities that are not supported by the supplied context.",
    "If the context is insufficient, answer conservatively and say what information is missing.",
    "Do not output labels such as recent context, interviewer question, candidate answer, analysis metadata, or markdown fences."
  ];
  const language = englishFirstBilingual
    ? [
        "Output MUST be bilingual in this exact order:",
        "1. First provide the complete answer in fluent natural spoken English.",
        "2. Then provide the corresponding Chinese version below it.",
        "Use clear section labels: English: and Chinese:.",
        "The Chinese section must correspond to the English answer, not replace it.",
        "This rule applies even when the user question/transcript is Chinese."
      ].join(" ")
    : "Output in Chinese unless bilingual output is explicitly needed.";
  const jsonRule = jsonOutput
    ? "nextSteps must be 3 short actions in the same language format as suggestedAnswer. suggestedAnswer should be a direct answer the user can say immediately."
    : "Keep it concise, concrete, and natural.";
  return [...common, language, jsonRule].join(" ");
}

function prefersEnglishOutput(input: { hiddenContext?: string; transcript?: string; bilingualRequired?: boolean }) {
  const text = `${input.hiddenContext ?? ""}\n${input.transcript ?? ""}`;
  return Boolean(input.bilingualRequired) || /english\s+style|english[- ]first|spoken\s+english|answer\s+(?:entirely|primarily)\s+in\s+(?:fluent\s+)?english|output\s+in\s+(?:fluent\s+)?(?:natural\s+spoken\s+)?english|corresponding\s+chinese/i.test(text);
}

function resolveAssistantRequestModel(model: ModelSettings, hasScreenshot: boolean) {
  if (hasScreenshot && model.visionEnabled) {
    const visionBaseUrl = model.visionBaseUrl.trim();
    const visionApiKey = model.visionApiKey.trim();
    const visionModel = model.visionModel.trim();
    if (visionBaseUrl && visionApiKey && visionModel) {
      return { baseUrl: visionBaseUrl, apiKey: visionApiKey, model: visionModel, useImage: true };
    }
    if (model.apiKey && model.baseUrl && model.chatModel && isLikelyVisionModel(model.chatModel)) {
      return { baseUrl: model.baseUrl, apiKey: model.apiKey, model: model.chatModel, useImage: true };
    }
  }

  if (!model.apiKey || !model.baseUrl || !model.chatModel) return null;
  return { baseUrl: model.baseUrl, apiKey: model.apiKey, model: model.chatModel, useImage: false };
}

function resolveAnswerRequestModel(model: ModelSettings, hasScreenshot: boolean) {
  if (!hasScreenshot) {
    if (!model.apiKey || !model.baseUrl || !model.chatModel) {
      throw new Error("未配置通用模型 Base URL、API Key 或模型名，无法发送题目。");
    }
    return { baseUrl: model.baseUrl, apiKey: model.apiKey, model: model.chatModel, useImage: false };
  }

  const visionBaseUrl = model.visionBaseUrl.trim();
  const visionApiKey = model.visionApiKey.trim();
  const visionModel = model.visionModel.trim();
  if (visionBaseUrl && visionApiKey && visionModel) {
    if (isImageGenerationModel(visionModel) && isAliyunCompatibleBaseUrl(visionBaseUrl)) {
      return { baseUrl: visionBaseUrl, apiKey: visionApiKey, model: "qwen-vl-plus-latest", useImage: true };
    }
    if (isImageGenerationModel(visionModel)) {
      throw new Error(`当前配置的视觉模型 ${visionModel} 是图片生成模型，不能用于看图答题。请换成 VL/vision 模型。`);
    }
    return { baseUrl: visionBaseUrl, apiKey: visionApiKey, model: visionModel, useImage: true };
  }

  if (model.apiKey && model.baseUrl && model.chatModel && isLikelyVisionModel(model.chatModel)) {
    return { baseUrl: model.baseUrl, apiKey: model.apiKey, model: model.chatModel, useImage: true };
  }

  if (model.apiKey && isAliyunCompatibleBaseUrl(model.baseUrl)) {
    return {
      baseUrl: model.baseUrl,
      apiKey: model.apiKey,
      model: visionModel && !isImageGenerationModel(visionModel) ? visionModel : "qwen-vl-plus-latest",
      useImage: true
    };
  }

  throw new Error("答题模式需要视觉模型。请在模型设置里填写视觉模型 Base URL、API Key、模型名，或把通用模型改成支持图片输入的 VL/vision 模型。");
}

function isAliyunCompatibleBaseUrl(baseUrl: string) {
  return /dashscope\.aliyuncs\.com|bailian|aliyun/i.test(baseUrl);
}

function isLikelyVisionModel(model: string) {
  const normalized = model.toLowerCase();
  if (/deepseek|v3|v4|flash/.test(normalized) && !/vision|vl|omni|multimodal/.test(normalized)) {
    return false;
  }
  return /vision|vl|omni|multimodal|gpt-4o|gpt-4\.1|qwen.*vl|glm-4v|doubao.*vision/i.test(normalized);
}

function isImageGenerationModel(model: string) {
  const normalized = model.toLowerCase();
  return /(^|[-_/])(?:qwen-)?image(?:[-_/]|$)|wanx|stable-diffusion|dall-e|flux|midjourney|text-to-image|image-generation/.test(normalized);
}

function shouldRetryWithoutResponseFormat(status: number, body: string) {
  if (status === 429 || /rate.?limit|limit_requests|exceeded your current request limit/i.test(body)) {
    return false;
  }
  return status >= 400 && status < 500 && /response_format|json_object|json mode/i.test(body);
}

function parseJsonObject(content: string) {
  try {
    return JSON.parse(content);
  } catch {
    // Some providers wrap the JSON object in a fenced block; fall through to extract it.
  }

  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  if (fenced) {
    return JSON.parse(fenced);
  }
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return JSON.parse(content.slice(start, end + 1));
  }
  return JSON.parse(content);
}

async function readChatCompletionStream(response: Response, onDelta: AssistantDeltaHandler) {
  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) {
        continue;
      }
      const data = trimmed.slice(5).trim();
      if (!data || data === "[DONE]") {
        continue;
      }
      const delta = extractStreamDelta(data);
      if (!delta) {
        continue;
      }
      content += delta;
      onDelta(delta);
    }
  }

  return content;
}

function extractStreamDelta(data: string) {
  try {
    const json = JSON.parse(data) as { choices?: Array<{ delta?: { content?: unknown }; message?: { content?: unknown } }> };
    const content = json.choices?.[0]?.delta?.content ?? json.choices?.[0]?.message?.content;
    return extractMessageContent(content);
  } catch {
    return "";
  }
}

function extractMessageContent(content: unknown) {
  if (typeof content === "string") {
    return content.trim();
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part) {
          return String((part as { text?: unknown }).text ?? "");
        }
        return "";
      })
      .join("")
      .trim();
  }
  return "";
}

function composeLocalDailySummary(events: WorkEvent[]) {
  if (events.length === 0) {
    return "今天还没有记录到工作内容。请开启工作记录，或先让助手观察一次屏幕/语音后再生成今日总结。";
  }

  const apps = Array.from(new Set(events.map((event) => event.sourceApp))).slice(0, 6).join("、");
  const lastSteps = Array.from(new Set(events.flatMap((event) => event.nextSteps))).slice(-6);
  const workItems = events
    .slice(-8)
    .map((event) => {
      const time = new Date(event.createdAt).toLocaleTimeString();
      return `- ${time} [${event.sourceApp}] ${event.detectedQuestion}\n  ${event.summary}`;
    })
    .join("\n");
  return [
    "# 今日工作总结",
    "",
    `今日共记录 ${events.length} 条工作片段，主要涉及：${apps || "未识别应用"}。`,
    "",
    "## 具体工作内容",
    workItems,
    "",
    "## 待办和风险",
    ...lastSteps.map((step) => `- ${step}`)
  ].join("\n");
}

function normalizeBaseUrl(baseUrl: string) {
  return baseUrl.replace(/\/+$/, "");
}

function mimeTypeToExtension(mimeType: string) {
  if (mimeType.includes("webm")) return "webm";
  if (mimeType.includes("mp4")) return "mp4";
  if (mimeType.includes("mpeg")) return "mp3";
  if (mimeType.includes("wav")) return "wav";
  return "webm";
}
