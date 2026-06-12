import crypto from "node:crypto";
import { randomUUID } from "node:crypto";
import tls from "node:tls";
import WebSocket from "ws";
import type { ModelSettings } from "../shared/types";

type XfyunRtasrMessage = {
  action?: string;
  code?: string;
  desc?: string;
  data?: string | LegacyAsrData | { desc?: string; detail?: unknown; normal?: boolean };
  sid?: string;
  msg_type?: string;
  res_type?: string;
};

type XfyunIatMessage = {
  header?: {
    code?: number;
    message?: string;
    sid?: string;
    status?: number;
  };
  payload?: {
    result?: {
      text?: string;
      status?: number;
      seq?: number;
    };
  };
};

type XfyunWebApiIatMessage = {
  code?: number;
  message?: string;
  sid?: string;
  data?: {
    status?: number;
    result?: IatResultText;
  };
};

type LegacyAsrData = {
  cn?: { st?: { rt?: Array<{ ws?: Array<{ cw?: Array<{ w?: string }> }> }> } };
  ls?: boolean;
  seg_id?: number;
};

type IatResultText = {
  sn?: number;
  ls?: boolean;
  pgs?: "apd" | "rpl";
  rg?: [number, number];
  ws?: Array<{ cw?: Array<{ w?: string }> }>;
};

export class XfyunRtasrClient {
  async transcribePcm(input: { model: ModelSettings; pcm: ArrayBuffer }) {
    const { model } = input;
    const appId = model.xfyunAppId.trim();
    const apiKey = model.xfyunApiKey.trim();
    const apiSecret = model.xfyunApiSecret.trim();
    const serviceType = model.xfyunServiceType || "iat";
    const endpoint = normalizeEndpoint((model.xfyunEndpoint || "").trim(), serviceType);

    if (!appId || !apiKey) {
      throw new Error("请先填写科大讯飞 APPID 和 APIKey。");
    }
    if ((serviceType === "iat-webapi" || serviceType === "iat" || serviceType === "large-model") && !apiSecret) {
      throw new Error("当前科大讯飞接口需要填写 APISecret。");
    }
    if (isMaasEndpoint(endpoint)) {
      throw new Error(
        "当前填写的是科大讯飞 MaaS/模型服务 Endpoint（maas-api.../chat），不是语音听写或实时转写 WebSocket 协议。本应用的科大讯飞转写请使用“语音听写流式版 WebApi（普通版）”服务页的 wss://iat-api.xfyun.cn/v2/iat，或切换到真正的实时语音转写/语音听写服务密钥。"
      );
    }

    const authModel = { ...model, xfyunAppId: appId, xfyunApiKey: apiKey, xfyunApiSecret: apiSecret };
    const sessionId = randomUUID().replace(/-/g, "");
    const url =
      serviceType === "iat"
        ? buildIatSignedUrl(endpoint, authModel)
        : serviceType === "iat-webapi"
          ? buildIatSignedUrl(endpoint, authModel)
          : serviceType === "large-model"
            ? buildLargeModelSignedUrl(endpoint, authModel, sessionId)
            : buildStandardSignedUrl(endpoint, authModel);

    console.info(`[xfyun] connecting mode=${serviceType} endpoint=${endpoint} appid=${appId} lang=${model.xfyunLanguage || "cn"}`);

    const chunks = chunkBuffer(Buffer.from(input.pcm), model.xfyunChunkSize || 1280);
    if (serviceType === "iat") {
      return transcribeIat({ url, model: authModel, chunks });
    }
    if (serviceType === "iat-webapi") {
      return transcribeWebApiIat({ url, model: authModel, chunks });
    }
    return transcribeLegacy({ url, chunks, useLargeModel: serviceType === "large-model", sessionId });
  }
}

function transcribeWebApiIat(input: { url: string; model: ModelSettings; chunks: Buffer[] }) {
  return new Promise<string>((resolve, reject) => {
    const segments = new Map<number, string>();
    const ws = new WebSocket(input.url);
    let settled = false;

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      ws.close();
      reject(error);
    };

    const timeout = setTimeout(() => fail(new Error("科大讯飞语音听写 WebApi 超时。")), 30000);

    ws.on("open", async () => {
      for (let index = 0; index < input.chunks.length; index += 1) {
        if (ws.readyState !== WebSocket.OPEN) break;
        const status = index === 0 ? 0 : 1;
        ws.send(JSON.stringify(buildWebApiIatFrame(input.model, input.chunks[index], status)));
        await sleep(40);
      }
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(buildWebApiIatFrame(input.model, Buffer.alloc(0), 2)));
      }
    });

    ws.on("message", (raw) => {
      const message = parseMessage<XfyunWebApiIatMessage>(raw.toString());
      if (typeof message.code === "number" && message.code !== 0) {
        console.warn("[xfyun] webapi iat error response", safeLogResponse(raw.toString()));
        fail(new Error(formatWebApiIatError(message.code, message.message)));
        return;
      }

      const result = message.data?.result;
      if (result) {
        const text = extractWords(result);
        if (text) {
          if (result.pgs === "rpl" && result.rg) {
            for (let sn = result.rg[0]; sn <= result.rg[1]; sn += 1) {
              segments.delete(sn);
            }
          }
          segments.set(result.sn ?? segments.size + 1, text);
        }
      }

      if (message.data?.status === 2 || result?.ls) {
        ws.close();
      }
    });

    ws.on("close", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(
        Array.from(segments.entries())
          .sort((a, b) => a[0] - b[0])
          .map(([, value]) => value)
          .join("")
          .trim()
      );
    });

    ws.on("error", (error) => fail(error instanceof Error ? error : new Error(String(error))));
  });
}

function transcribeIat(input: { url: string; model: ModelSettings; chunks: Buffer[] }) {
  return new Promise<string>((resolve, reject) => {
    const segments = new Map<number, string>();
    const ws = new WebSocket(input.url);
    let settled = false;
    let finalSeen = false;
    let seq = 1;

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      ws.close();
      reject(error);
    };

    const timeout = setTimeout(() => fail(new Error("科大讯飞语音听写超时。")), 30000);

    ws.on("open", async () => {
      for (let index = 0; index < input.chunks.length; index += 1) {
        if (ws.readyState !== WebSocket.OPEN) break;
        const status = index === 0 ? 0 : 1;
        ws.send(JSON.stringify(buildIatFrame(input.model, input.chunks[index], seq, status)));
        seq += 1;
        await sleep(40);
      }
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(buildIatFrame(input.model, Buffer.alloc(0), seq, 2)));
      }
    });

    ws.on("message", (raw) => {
      const message = parseMessage<XfyunIatMessage>(raw.toString());
      const code = message.header?.code;
      if (typeof code === "number" && code !== 0) {
        console.warn("[xfyun] iat error response", safeLogResponse(raw.toString()));
        fail(new Error(formatIatError(code, message.header?.message)));
        return;
      }

      const result = extractIatText(message);
      if (result.text) {
        if (result.pgs === "rpl" && result.rg) {
          for (let sn = result.rg[0]; sn <= result.rg[1]; sn += 1) {
            segments.delete(sn);
          }
        }
        segments.set(result.sn ?? segments.size + 1, result.text);
      }

      if (message.header?.status === 2 || message.payload?.result?.status === 2 || result.ls) {
        finalSeen = true;
        ws.close();
      }
    });

    ws.on("close", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const text = Array.from(segments.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([, value]) => value)
        .join("");
      resolve(finalSeen ? text : text.trim());
    });

    ws.on("error", (error) => fail(error instanceof Error ? error : new Error(String(error))));
  });
}

function transcribeLegacy(input: { url: string; chunks: Buffer[]; useLargeModel: boolean; sessionId: string }) {
  return new Promise<string>((resolve, reject) => {
    const transcript: string[] = [];
    let serverSessionId = input.sessionId;
    let settled = false;
    const ws = new WebSocket(input.url);

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      ws.close();
      reject(error);
    };

    const timeout = setTimeout(() => fail(new Error("科大讯飞实时转写超时。")), 30000);

    ws.on("open", async () => {
      for (const chunk of input.chunks) {
        if (ws.readyState !== WebSocket.OPEN) break;
        ws.send(chunk);
        await sleep(40);
      }
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(Buffer.from(input.useLargeModel ? JSON.stringify({ end: true, sessionId: serverSessionId }) : '{"end": true}'));
      }
    });

    ws.on("message", (data) => {
      const message = parseMessage<XfyunRtasrMessage>(data.toString());
      if (message.code && message.code !== "0") {
        fail(new Error(message.desc || `科大讯飞转写失败：${message.code}`));
        return;
      }

      if (message.sid) {
        serverSessionId = message.sid;
      }

      const text = extractLegacyText(message);
      if (text) transcript.push(text);

      const errorData = getErrorData(message.data);
      if (message.action === "error" || errorData?.normal === false) {
        fail(new Error(message.desc || errorData?.desc || "科大讯飞转写错误。"));
      }
    });

    ws.on("close", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(dedupeTranscript(transcript));
    });

    ws.on("error", async (error) => {
      if (input.useLargeModel && /Invalid response status/i.test(error instanceof Error ? error.message : String(error))) {
        fail(new Error(await diagnoseLargeModelHandshake(input.url)));
        return;
      }
      fail(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

function buildIatSignedUrl(endpoint: string, model: ModelSettings) {
  const url = new URL(endpoint);
  const host = url.host;
  const date = new Date().toUTCString();
  const requestLine = `GET ${url.pathname || "/v1"} HTTP/1.1`;
  const signatureOrigin = `host: ${host}\ndate: ${date}\n${requestLine}`;
  const signature = crypto.createHmac("sha256", model.xfyunApiSecret).update(signatureOrigin).digest("base64");
  const authorizationOrigin = `api_key="${model.xfyunApiKey}", algorithm="hmac-sha256", headers="host date request-line", signature="${signature}"`;
  url.searchParams.set("authorization", Buffer.from(authorizationOrigin).toString("base64"));
  url.searchParams.set("date", date);
  url.searchParams.set("host", host);
  return url.toString();
}

function buildIatFrame(model: ModelSettings, chunk: Buffer, seq: number, status: 0 | 1 | 2) {
  const frame: Record<string, unknown> = {
    header: {
      app_id: model.xfyunAppId,
      status
    },
    payload: {
      audio: {
        encoding: "raw",
        sample_rate: 16000,
        channels: 1,
        bit_depth: 16,
        seq,
        status,
        audio: chunk.toString("base64")
      }
    }
  };

  if (status === 0) {
    frame.parameter = {
      iat: {
        domain: model.xfyunDomain || "slm",
        language: "zh_cn",
        accent: "mandarin",
        eos: 6000,
        dwa: "wpgs",
        ...(model.xfyunLanguage === "en" ? { ltc: 3 } : {}),
        result: {
          encoding: "utf8",
          compress: "raw",
          format: "json"
        }
      }
    };
  }

  return frame;
}

function buildWebApiIatFrame(model: ModelSettings, chunk: Buffer, status: 0 | 1 | 2) {
  const data = {
    status,
    format: "audio/L16;rate=16000",
    encoding: "raw",
    audio: chunk.toString("base64")
  };

  if (status !== 0) {
    return { data };
  }

  return {
    common: {
      app_id: model.xfyunAppId
    },
    business: {
      language: model.xfyunLanguage === "en" ? "en_us" : "zh_cn",
      domain: model.xfyunDomain || "iat",
      accent: "mandarin",
      vad_eos: 6000,
      dwa: "wpgs"
    },
    data
  };
}

function buildStandardSignedUrl(endpoint: string, model: ModelSettings) {
  const ts = Math.floor(Date.now() / 1000).toString();
  const md5 = crypto.createHash("md5").update(model.xfyunAppId + ts).digest("hex");
  const signa = crypto.createHmac("sha1", model.xfyunApiKey).update(md5).digest("base64");
  const baseUrl = endpoint.replace(/\?.*$/, "").replace(/\/+$/, "/ws").replace(/\/ws\/ws$/, "/ws");
  const params = [
    ["appid", model.xfyunAppId],
    ["ts", ts],
    ["signa", signa],
    ["lang", model.xfyunLanguage || "cn"]
  ];

  if (model.xfyunDomain) {
    params.push(["pd", model.xfyunDomain]);
  }

  return `${baseUrl}?${params.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join("&")}`;
}

function buildLargeModelSignedUrl(endpoint: string, model: ModelSettings, uuid: string) {
  const params: Record<string, string> = {
    accessKeyId: model.xfyunApiKey,
    appId: model.xfyunAppId,
    audio_encode: "pcm_s16le",
    lang: model.xfyunLanguage === "en" ? "autominor" : "autodialect",
    samplerate: "16000",
    utc: formatXfyunUtc(),
    uuid
  };

  if (model.xfyunLanguage === "en") {
    params.recognized_language = "en";
  }
  if (model.xfyunDomain && model.xfyunDomain !== "general") {
    params.pd = model.xfyunDomain;
  }

  const baseString = Object.keys(params)
    .sort()
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`)
    .join("&");
  const signature = crypto.createHmac("sha1", model.xfyunApiSecret).update(baseString).digest("base64");
  return `${endpoint}?${baseString}&signature=${encodeURIComponent(signature)}`;
}

function diagnoseLargeModelHandshake(signedUrl: string) {
  return new Promise<string>((resolve) => {
    const url = new URL(signedUrl);
    const socket = tls.connect(
      {
        host: url.hostname,
        port: url.port ? Number(url.port) : 443,
        servername: url.hostname
      },
      () => {
        const path = `${url.pathname}${url.search}`;
        socket.write(
          [
            `GET ${path} HTTP/1.1`,
            `Host: ${url.host}`,
            "Upgrade: websocket",
            "Connection: Upgrade",
            "Sec-WebSocket-Version: 13",
            `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString("base64")}`,
            "",
            ""
          ].join("\r\n")
        );
      }
    );

    let raw = "";
    const timer = setTimeout(() => {
      socket.destroy();
      resolve("科大讯飞实时语音转写大模型连接失败：服务端返回了非标准握手状态，且诊断超时。请确认该服务的 accessKeyId/APIKey 是否已开通实时语音转写大模型。");
    }, 5000);

    socket.on("data", (chunk) => {
      raw += chunk.toString("utf8");
      clearTimeout(timer);
      socket.destroy();
      resolve(formatLargeModelHandshakeError(raw));
    });
    socket.on("error", () => {
      clearTimeout(timer);
      resolve("科大讯飞实时语音转写大模型连接失败：无法完成握手诊断。请检查 Endpoint 和网络。");
    });
  });
}

function formatLargeModelHandshakeError(raw: string) {
  const status = raw.match(/^HTTP\/1\.\d\s+(\d+)/)?.[1];
  const body = raw.split(/\r?\n\r?\n/).slice(1).join("\n").trim();
  const message = body || (status ? `HTTP ${status}` : raw.slice(0, 200));
  if (status === "35010" || /AccessKeyId Not Exists/i.test(message)) {
    return "科大讯飞实时语音转写大模型鉴权失败：accessKeyId 不存在。当前填入的 APIKey 没有被该接口识别为实时语音转写大模型的 accessKeyId。请换用该服务页对应的 APIKey/APISecret，或服务版本改选“中英识别大模型 / 语音听写流式版”。";
  }
  if (status === "35017") {
    return "科大讯飞实时语音转写大模型鉴权失败：accessKeyId 与 appId 不匹配。请确认 APPID、APIKey、APISecret 来自同一个服务页面。";
  }
  if (status === "35002") {
    return "科大讯飞实时语音转写大模型用量不足：请在控制台领取免费额度或购买套餐。";
  }
  return `科大讯飞实时语音转写大模型握手失败：${message}`;
}

function formatIatError(code: number, message = "") {
  const lower = message.toLowerCase();
  if (code === 10005 || lower.includes("licc")) {
    return `科大讯飞授权/额度校验失败：${message || code}。请先看控制台该服务的“剩余服务量”，如果为 0，需要购买服务量或领取试用额度；如果有额度，再确认 APPID、APIKey、APISecret 是否来自同一个“中英识别大模型 / 语音听写（流式版）”服务页。`;
  }
  return `科大讯飞语音听写失败：${message || code}`;
}

function formatWebApiIatError(code: number, message = "") {
  const lower = message.toLowerCase();
  if (lower.includes("appid") || lower.includes("illegal access")) {
    return `科大讯飞语音听写 WebApi 鉴权失败：${message || code}。请确认服务版本选择“语音听写流式版 WebApi（普通版）”，Endpoint 为 wss://iat-api.xfyun.cn/v2/iat，且 APPID、APIKey、APISecret 来自当前这个有剩余额度的服务页。`;
  }
  if (lower.includes("licc")) {
    return `科大讯飞语音听写 WebApi 授权/额度校验失败：${message || code}。你截图里的“语音识别 Qwen3-1.7B / maas-api.../chat”属于 MaaS 推理服务，不是语音听写 WebApi 的服务量，不能用于 wss://iat-api.xfyun.cn/v2/iat。请在讯飞控制台开通“语音听写（流式版）/ WebApi”或“大模型多语种语音识别”，并使用对应服务页的 APPID、APIKey、APISecret。`;
  }
  return `科大讯飞语音听写 WebApi 失败：${message || code}`;
}

function safeLogResponse(raw: string) {
  return raw.length > 1000 ? `${raw.slice(0, 1000)}...` : raw;
}

function parseMessage<T>(raw: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return {} as T;
  }
}

function extractIatText(message: XfyunIatMessage) {
  const encoded = message.payload?.result?.text;
  if (!encoded) return { text: "" };
  try {
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    const parsed = JSON.parse(decoded) as IatResultText;
    return {
      sn: parsed.sn,
      ls: parsed.ls,
      pgs: parsed.pgs,
      rg: parsed.rg,
      text: extractWords(parsed)
    };
  } catch {
    return { text: "" };
  }
}

function extractWords(result: IatResultText) {
  return (
    result.ws
      ?.flatMap((ws) => ws.cw ?? [])
      .map((cw) => cw.w ?? "")
      .join("") ?? ""
  );
}

function extractLegacyText(message: XfyunRtasrMessage) {
  if (!message.data) return "";
  try {
    const parsed = typeof message.data === "string" ? (JSON.parse(message.data) as LegacyAsrData) : isLegacyAsrData(message.data) ? message.data : undefined;
    return (
      parsed?.cn?.st?.rt
        ?.flatMap((rt) => rt.ws ?? [])
        .flatMap((ws) => ws.cw ?? [])
        .map((cw) => cw.w ?? "")
        .join("") ?? ""
    );
  } catch {
    return "";
  }
}

function normalizeEndpoint(endpoint: string, serviceType: ModelSettings["xfyunServiceType"]) {
  if (serviceType === "iat-webapi") {
    if (
      !endpoint ||
      endpoint.includes("rtasr.xfyun.cn") ||
      endpoint.includes("office-api-ast-dx.iflyaisol.com") ||
      endpoint.includes("iat.xf-yun.com")
    ) {
      return "wss://iat-api.xfyun.cn/v2/iat";
    }
    return endpoint.replace(/\?.*$/, "");
  }
  if (serviceType === "iat") {
    if (!endpoint || endpoint.includes("rtasr.xfyun.cn") || endpoint.includes("office-api-ast-dx.iflyaisol.com")) {
      return "wss://iat.xf-yun.com/v1";
    }
    return endpoint.replace(/\?.*$/, "");
  }
  if (serviceType === "large-model" && (!endpoint || endpoint.includes("rtasr.xfyun.cn"))) {
    return "wss://office-api-ast-dx.iflyaisol.com/ast/communicate/v1";
  }
  if (serviceType === "large-model" && /^wss:\/\/office-api-ast-dx\.iflyaisol\.com\/?$/i.test(endpoint)) {
    return "wss://office-api-ast-dx.iflyaisol.com/ast/communicate/v1";
  }
  if (!endpoint) {
    return "wss://rtasr.xfyun.cn/v1/ws";
  }
  return endpoint.replace(/\?.*$/, "");
}

function isMaasEndpoint(endpoint: string) {
  return /(^|\/\/)maas-api\./i.test(endpoint) || /\/v1(?:\.\d+)?\/chat(?:$|\?)/i.test(endpoint);
}

function isLegacyAsrData(data: unknown): data is LegacyAsrData {
  return Boolean(data && typeof data === "object" && "cn" in data);
}

function getErrorData(data: XfyunRtasrMessage["data"]) {
  if (!data || typeof data !== "object" || isLegacyAsrData(data)) {
    return undefined;
  }
  return data;
}

function formatXfyunUtc() {
  const date = new Date();
  const chinaOffsetMs = 8 * 60 * 60 * 1000;
  const china = new Date(date.getTime() + chinaOffsetMs);
  const yyyy = china.getUTCFullYear();
  const mm = String(china.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(china.getUTCDate()).padStart(2, "0");
  const hh = String(china.getUTCHours()).padStart(2, "0");
  const mi = String(china.getUTCMinutes()).padStart(2, "0");
  const ss = String(china.getUTCSeconds()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}+0800`;
}

function chunkBuffer(buffer: Buffer, chunkSize: number) {
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < buffer.length; offset += chunkSize) {
    chunks.push(buffer.subarray(offset, offset + chunkSize));
  }
  return chunks;
}

function dedupeTranscript(parts: string[]) {
  return Array.from(new Set(parts.map((part) => part.trim()).filter(Boolean))).join("");
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
