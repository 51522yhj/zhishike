import { randomUUID } from "node:crypto";
import type { AssistantFrame, KnowledgeChunk, ModelSettings, SearchHit, WorkEvent } from "../shared/types";
import { AiClient } from "./aiClient";
import { KnowledgeEngine } from "./knowledge";

type ObservationInput = {
  sourceApp: string;
  screenText: string;
  screenshotDataUrl?: string;
  transcript?: string;
  hiddenContext?: string;
  model: ModelSettings;
};

export class AssistantEngine {
  private knowledge = new KnowledgeEngine();
  private ai = new AiClient();
  private rollingSummary: string[] = [];

  answer(question: string, chunks: KnowledgeChunk[], model: ModelSettings, sourceApp = "手动提问", transcript = question, screenText = "") {
    return this.composeFrame({ sourceApp, screenText, transcript, model }, chunks, question);
  }

  answerWithContext(
    question: string,
    hiddenContext: string,
    chunks: KnowledgeChunk[],
    model: ModelSettings,
    sourceApp = "手动提问",
    transcript = question,
    screenText = ""
  ) {
    return this.composeFrame({ sourceApp, screenText, transcript, hiddenContext, model }, chunks, question);
  }

  answerWithContextStream(
    question: string,
    hiddenContext: string,
    chunks: KnowledgeChunk[],
    model: ModelSettings,
    onDelta: (delta: string) => void,
    sourceApp = "鎵嬪姩鎻愰棶",
    transcript = question,
    screenText = ""
  ) {
    return this.composeFrame({ sourceApp, screenText, transcript, hiddenContext, model }, chunks, question, onDelta);
  }

  async observe(input: ObservationInput, chunks: KnowledgeChunk[]) {
    const combined = [input.transcript, input.screenText].filter(Boolean).join("\n").trim();
    const question = pickQuestion(combined) || combined.slice(0, 220) || "根据当前屏幕内容给出下一步建议";
    return this.composeFrame(input, chunks, question);
  }

  async answerScreenQuestion(input: Omit<ObservationInput, "sourceApp" | "transcript">, chunks: KnowledgeChunk[]) {
    const question = pickScreenQuestion(input.screenText) || "屏幕题目";
    const citations = this.knowledge.search([question, input.screenText, input.hiddenContext].filter(Boolean).join("\n"), chunks, 4);
    let llmResult = null;
    try {
      llmResult = await this.ai.generateAnswerFrame({
        model: input.model,
        screenText: input.screenText,
        screenshotDataUrl: input.screenshotDataUrl,
        hiddenContext: input.hiddenContext,
        citations
      });
    } catch (error) {
      if (isRateLimitError(error)) {
        throw error;
      }
      console.warn(error);
      const message = error instanceof Error ? error.message : String(error);
      return {
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        sourceApp: "答题模式",
        transcript: input.screenText.slice(0, 220) || question,
        translation: question,
        summary: "视觉模型请求失败",
        detectedQuestion: question,
        suggestedAnswer: [
          `题目：${question}`,
          "",
          "视觉模型请求失败，未能生成解答。",
          "",
          `错误：${message}`,
          "",
          "请检查视觉模型 Base URL、API Key、模型名是否支持 OpenAI-compatible 图片输入。"
        ].join("\n"),
        nextSteps: ["检查视觉模型配置", "确认模型支持图片输入", "重新发送题目"],
        citations
      };
    }

    if (!llmResult) {
      const message = input.screenshotDataUrl
        ? "视觉模型请求完成但没有返回可展示内容。"
        : "未捕获到截图，无法把题目发送给视觉模型。";
      return {
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        sourceApp: "答题模式",
        transcript: input.screenText.slice(0, 220) || question,
        translation: question,
        summary: message,
        detectedQuestion: question,
        suggestedAnswer: message,
        nextSteps: ["确认截图权限", "检查视觉模型配置", "重新发送题目"],
        citations
      };
    }

    const suggestedAnswer = cleanAnswerModeOutput(llmResult.suggestedAnswer);

    return {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      sourceApp: "答题模式",
      transcript: input.screenText.slice(0, 220) || question,
      translation: llmResult.translation || llmResult.summary || question,
      summary: llmResult.summary || llmResult.detectedQuestion || question,
      detectedQuestion: cleanAnswerModeOutput(llmResult.detectedQuestion || question),
      suggestedAnswer,
      nextSteps: llmResult.nextSteps,
      citations
    };
  }

  async transcribeAudio(data: ArrayBuffer, mimeType: string, model: ModelSettings) {
    return this.ai.transcribeAudio({ data, mimeType, model });
  }

  async summarizeDay(events: WorkEvent[], model: ModelSettings) {
    return this.ai.generateDailySummary({ events, model });
  }

  private async composeFrame(
    input: ObservationInput,
    chunks: KnowledgeChunk[],
    question: string,
    onDelta?: (delta: string) => void
  ): Promise<AssistantFrame> {
    const searchText = [question, input.transcript, input.screenText, input.hiddenContext].filter(Boolean).join("\n");
    const citations = this.knowledge.search(searchText, chunks, 4);
    const bilingualRequired =
      wantsEnglishFirstBilingual(input.hiddenContext) ||
      (Boolean(input.model.translationEnabled) && looksEnglish([input.transcript, question, input.screenText].filter(Boolean).join("\n")));
    this.rollingSummary = [...this.rollingSummary, question].slice(-4);
    const rollingSummary = `最近重点：${this.rollingSummary.join(" / ")}`;

    let llmResult = null;
    try {
      const request = {
        model: input.model,
        transcript: input.transcript || question,
        screenText: input.screenText,
        screenshotDataUrl: input.screenshotDataUrl,
        citations,
        rollingSummary,
        hiddenContext: input.hiddenContext,
        bilingualRequired
      };
      llmResult = onDelta
        ? await this.ai.generateAssistantFrameStream({ ...request, onDelta })
        : await this.ai.generateAssistantFrame(request);
    } catch (error) {
      if (isRateLimitError(error)) {
        throw error;
      }
      console.warn(error);
    }

    const fallback = composeLocalAnswer(question, input.screenText, citations, rollingSummary, bilingualRequired, Boolean(input.screenshotDataUrl));
    const suggestedAnswer = cleanSuggestedAnswer(llmResult?.suggestedAnswer || fallback.suggestedAnswer);

    return {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      sourceApp: input.sourceApp,
      transcript: input.transcript || input.screenText.slice(0, 220) || question,
      translation: input.model.translationEnabled ? llmResult?.translation || input.transcript || question : input.transcript || question,
      summary: llmResult?.summary || fallback.summary,
      detectedQuestion: llmResult?.detectedQuestion || question,
      suggestedAnswer,
      nextSteps: llmResult?.nextSteps || fallback.nextSteps,
      citations
    };
  }
}

function cleanSuggestedAnswer(answer: string) {
  const blockedLine =
    /^(?:\s*(?:面试官刚才的问题|最近面试上下文|最近会议上下文|面试官|候选回答|recent\s+context|context|question)\s*[:：])/i;
  const cleaned = answer
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line && !blockedLine.test(line))
    .join("\n")
    .replace(/建议先直接回应\s*[:：]\s*[“"]?面试官刚才的问题\s*[:：]?/g, "建议回答：")
    .trim();
  return cleaned || answer.trim();
}

function wantsEnglishFirstBilingual(hiddenContext = "") {
  return /english\s+style|english[- ]first|corresponding\s+chinese|natural spoken english/i.test(hiddenContext);
}

function isRateLimitError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /429|rate.?limit|limit_requests|exceeded your current request limit/i.test(message);
}

function cleanAnswerModeOutput(answer: string) {
  return answer
    .replace(/请识别当前屏幕中的题目，?直接给出答案、?解题步骤和最终结论。?/g, "")
    .replace(/如果屏幕不是题目，?请说明需要补充哪些题目信息。?/g, "")
    .replace(/建议先直接回应[:：]?\s*/g, "")
    .trim();
}

function pickQuestion(text: string) {
  const lines = text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  return (
    lines.find((line) => /[?？]$/.test(line)) ??
    lines.find((line) => /(请|怎么|如何|为什么|能否|介绍|解释|改进|question|explain|introduce|why|how)/i.test(line))
  );
}

function pickScreenQuestion(text: string) {
  const lines = text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  return (
    lines.find((line) => /^\d+\.\s*\S+/.test(line)) ??
    lines.find((line) => /(leetcode|题目|输入|输出|示例|给定|数组|字符串|整数|class Solution|function)/i.test(line)) ??
    lines[0]
  );
}

function composeLocalAnswer(question: string, screenText: string, citations: SearchHit[], summary: string, bilingualRequired: boolean, hasScreenshot: boolean) {
  const sourceHint = citations[0] ? `结合《${citations[0].documentName}》中的资料，` : "";
  const screenHint = hasScreenshot
    ? "我已捕获当前屏幕截图，但当前模型没有返回视觉分析，建议确认模型是否支持图片输入。"
    : screenText
      ? `我已读取当前屏幕文字，重点是：${screenText.slice(0, 110)}。`
      : "当前没有识别到足够的屏幕上下文。";
  const chineseAnswer = [
    `${sourceHint}建议先直接回应：“${question}”。`,
    screenHint,
    "回答结构可以按“结论 -> 项目背景 -> 我的贡献 -> 结果/复盘”展开，避免只描述团队工作。"
  ].join("\n");
  const suggestedAnswer = bilingualRequired
    ? [
        "【English】",
        `I suggest answering this directly first, then supporting it with one concrete project example. Focus on the goal, your personal contribution, the technical challenge, and the measurable outcome.`,
        "",
        "【中文】",
        chineseAnswer
      ].join("\n")
    : chineseAnswer;

  return {
    summary,
    suggestedAnswer,
    nextSteps: [
      citations.length > 0 ? "引用知识库里最相关的项目资料。" : "先导入简历或项目资料，提高回答依据。",
      "先给一句明确结论，再讲技术细节。",
      "补充可量化结果、难点或下一版改进。"
    ]
  };
}

function looksEnglish(text: string) {
  const asciiWords = text.match(/[A-Za-z]{2,}/g)?.length ?? 0;
  const chineseChars = text.match(/[\u4e00-\u9fa5]/g)?.length ?? 0;
  return asciiWords >= 5 && asciiWords > chineseChars;
}
