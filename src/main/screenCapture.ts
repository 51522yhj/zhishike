import { desktopCapturer } from "electron";
import { writeFileSync } from "node:fs";
import { createWorker } from "tesseract.js";
import { getScreenshotFilePath } from "./storage";

export type ScreenContext = {
  sourceApp: string;
  text: string;
  imageDataUrl?: string;
  screenshotPath?: string;
};

export type ScreenProbe = {
  sourceApp: string;
  fingerprint: string;
};

export class ScreenCaptureService {
  private lastContext: ScreenContext = { sourceApp: "屏幕", text: "" };
  private running: Promise<ScreenContext> | null = null;

  async captureContext(input: { appBlacklist: string[]; includeOcr: boolean; includeImage: boolean }): Promise<ScreenContext> {
    if (this.running) return this.running;
    this.running = this.captureContextUnsafe(input).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  getLastContext(): ScreenContext {
    return this.lastContext;
  }

  async captureProbe(input: { appBlacklist: string[] }): Promise<ScreenProbe> {
    const sources = await desktopCapturer.getSources({
      types: ["window", "screen"],
      thumbnailSize: { width: 96, height: 60 }
    });
    const source = pickSource(sources, input.appBlacklist, false);
    if (!source) {
      return { sourceApp: this.lastContext.sourceApp, fingerprint: "" };
    }
    return {
      sourceApp: source.name || "屏幕",
      fingerprint: imageFingerprint(source.thumbnail.toBitmap())
    };
  }

  private async captureContextUnsafe(input: { appBlacklist: string[]; includeOcr: boolean; includeImage: boolean }): Promise<ScreenContext> {
    const sources = await desktopCapturer.getSources({
      types: ["window", "screen"],
      thumbnailSize: { width: input.includeOcr ? 2560 : 1440, height: input.includeOcr ? 1600 : 900 }
    });

    const source = pickSource(sources, input.appBlacklist, input.includeOcr);

    if (!source) {
      return this.lastContext;
    }

    const png = source.thumbnail.toPNG();
    const imageDataUrl = input.includeImage ? source.thumbnail.toDataURL() : undefined;
    const screenshotPath = input.includeImage ? saveScreenshot(png) : undefined;
    const text = input.includeOcr ? await recognizeText(png) : "";

    this.lastContext = {
      sourceApp: source.name || "屏幕",
      text,
      imageDataUrl,
      screenshotPath
    };
    return this.lastContext;
  }
}

function pickSource<T extends { id: string; name: string }>(sources: T[], appBlacklist: string[], preferWindow: boolean) {
  const blacklist = appBlacklist.map((item) => item.toLowerCase());
  const allowedSources = sources.filter((item) => {
    const name = item.name.toLowerCase();
    return (
      (!item.name || !blacklist.some((blocked) => name.includes(blocked))) &&
      !name.includes("知时客") &&
      !name.includes("zhishik")
    );
  });
  if (preferWindow) {
    return allowedSources.find((item) => item.id.startsWith("window:")) ?? allowedSources.find((item) => item.id.startsWith("screen:")) ?? allowedSources[0] ?? sources[0];
  }
  return allowedSources.find((item) => item.id.startsWith("screen:")) ?? allowedSources[0] ?? sources[0];
}

function imageFingerprint(bitmap: Buffer) {
  if (bitmap.length === 0) {
    return "";
  }

  const pixels: number[] = [];
  for (let index = 0; index + 3 < bitmap.length; index += 4) {
    const blue = bitmap[index] ?? 0;
    const green = bitmap[index + 1] ?? 0;
    const red = bitmap[index + 2] ?? 0;
    pixels.push((red + green + blue) / 3);
  }

  if (pixels.length === 0) {
    return "";
  }

  const average = pixels.reduce((sum, value) => sum + value, 0) / pixels.length;
  const step = Math.max(1, Math.floor(pixels.length / 256));
  let bits = "";
  for (let index = 0; index < pixels.length && bits.length < 256; index += step) {
    bits += pixels[index] >= average ? "1" : "0";
  }
  return bits;
}

function saveScreenshot(png: Buffer) {
  const filename = `${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
  const filePath = getScreenshotFilePath(filename);
  writeFileSync(filePath, png);
  return filePath;
}

async function recognizeText(png: Buffer) {
  const worker = await createWorker("eng+chi_sim");
  const result = await worker.recognize(png);
  await worker.terminate();
  return result.data.text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}
