import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import mammoth from "mammoth";
import type { DocumentRecord, KnowledgeChunk, KnowledgeSpace, SearchHit } from "../shared/types";
import { cosineSimilarity, embedText } from "./vector";

type PdfParseConstructor = new (input: { data: Buffer }) => {
  getText: () => Promise<{ text: string }>;
  destroy: () => Promise<void>;
};
const requirePdfParse = () => require("pdf-parse") as { PDFParse: PdfParseConstructor };

export class KnowledgeEngine {
  async indexFile(filePath: string, space: KnowledgeSpace) {
    const text = await extractText(filePath);
    const documentId = stableId(filePath);
    const name = path.basename(filePath);
    const chunks = chunkText(text).map<KnowledgeChunk>((chunk, index) => ({
      id: `${documentId}:${index}`,
      documentId,
      documentName: name,
      space,
      text: chunk,
      index,
      vector: embedText(chunk)
    }));

    const record: DocumentRecord = {
      id: documentId,
      name,
      path: filePath,
      space,
      importedAt: new Date().toISOString(),
      chunkCount: chunks.length,
      status: "indexed"
    };

    return { record, chunks };
  }

  search(question: string, chunks: KnowledgeChunk[], limit = 5): SearchHit[] {
    const queryVector = embedText(question);
    return chunks
      .map((chunk) => ({
        chunkId: chunk.id,
        documentId: chunk.documentId,
        documentName: chunk.documentName,
        space: chunk.space,
        excerpt: trimExcerpt(chunk.text),
        score: cosineSimilarity(queryVector, chunk.vector)
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}

async function extractText(filePath: string) {
  const extension = path.extname(filePath).toLowerCase();
  const buffer = readFileSync(filePath);

  if (extension === ".docx") {
    const result = await mammoth.extractRawText({ buffer });
    return normalizeText(result.value);
  }

  if (extension === ".pdf") {
    const { PDFParse } = requirePdfParse();
    const parser = new PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      const text = normalizeText(result.text);
      if (!text || looksLikePdfBinary(text)) {
        throw new Error("PDF text extraction returned empty or binary-like content.");
      }
      return text;
    } finally {
      await parser.destroy().catch(() => undefined);
    }
  }

  return normalizeText(buffer.toString("utf-8"));
}

function chunkText(text: string) {
  const sentences = text.split(/(?<=[。！？.!?])\s+|\n{2,}/u).map((item) => item.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = "";

  for (const sentence of sentences) {
    if ((current + sentence).length > 900 && current.length > 0) {
      chunks.push(current.trim());
      current = "";
    }
    current += `${sentence}\n`;
  }

  if (current.trim()) {
    chunks.push(current.trim());
  }

  if (chunks.length === 0 && text.trim()) {
    chunks.push(text.trim().slice(0, 1200));
  }

  return chunks;
}

function normalizeText(text: string) {
  return text.replace(/\u0000/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function looksLikePdfBinary(text: string) {
  const sample = text.slice(0, 2000);
  if (/^%PDF-\d\.\d/.test(sample) || /\/Type\s*\/Page|endobj|stream/i.test(sample)) {
    return true;
  }
  const replacementChars = (sample.match(/�/g) ?? []).length;
  return sample.length > 0 && replacementChars / sample.length > 0.03;
}

function trimExcerpt(text: string) {
  return text.length > 260 ? `${text.slice(0, 260)}...` : text;
}

function stableId(filePath: string) {
  return createHash("sha1").update(`${filePath}:${randomUUID()}`).digest("hex").slice(0, 16);
}
