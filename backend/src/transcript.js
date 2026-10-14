import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { createRequire } from "node:module";
import path from "node:path";
import {
  isSupportedTranscript,
  MAX_PDF_PAGES,
  MAX_TRANSCRIPT_CHARACTERS,
} from "../../shared/report.js";
import { AppError } from "./errors.js";

const require = createRequire(import.meta.url);
const pdfDirectory = path.dirname(require.resolve("pdfjs-dist/package.json")).replace(/\\/g, "/");

async function extractPdf(buffer, signal) {
  if (!buffer.subarray(0, 1024).includes(Buffer.from("%PDF-"))) {
    throw new AppError(
      400,
      "INVALID_PDF",
      "The file is not a readable PDF. Upload a valid PDF or a .txt transcript.",
    );
  }
  const loading = getDocument({
    data: new Uint8Array(buffer),
    verbosity: 0,
    stopAtErrors: true,
    useSystemFonts: false,
    useWorkerFetch: false,
    standardFontDataUrl: pdfDirectory + "/standard_fonts/",
    cMapUrl: pdfDirectory + "/cmaps/",
    cMapPacked: true,
  });

  const abort = () => {
    void loading.destroy().catch(() => {});
  };

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    abort();
  }, 20000);
  signal?.addEventListener("abort", abort, { once: true });
  try {
    if (signal?.aborted) {
      throw new AppError(499, "CANCELLED", "Report generation was cancelled.");
    }
    const pdf = await loading.promise;
    if (pdf.numPages > MAX_PDF_PAGES) {
      throw new AppError(413, "PDF_TOO_LONG", "PDF transcripts must be 100 pages or fewer.");
    }
    const pages = [];
    let characters = 0;
    for (let number = 1; number <= pdf.numPages; number += 1) {
      if (signal?.aborted) {
        throw new AppError(499, "CANCELLED", "Report generation was cancelled.");
      }
      const page = await pdf.getPage(number);
      const reader = page.streamTextContent().getReader();
      let pageText = "";
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) {
            break;
          }
          for (const item of chunk.value.items) {
            if (typeof item.str !== "string") {
              continue;
            }
            const text = item.str + (item.hasEOL ? "\n" : " ");
            characters += text.length;
            if (characters > MAX_TRANSCRIPT_CHARACTERS) {
              throw new AppError(
                413,
                "TRANSCRIPT_TOO_LONG",
                "The extracted transcript must be 120,000 characters or fewer.",
              );
            }
            pageText += text;
          }
        }
      }
      finally {
        await reader.cancel().catch(() => {});
        page.cleanup();
      }
      pages.push(pageText.trim());
    }
    const transcript = pages.join("\n\n").trim();
    if (!transcript) {
      throw new AppError(
        422,
        "PDF_NO_TEXT",
        "The PDF has no selectable text. Use a text-based PDF or save the transcript as .txt. Scanned PDFs need OCR first.",
      );
    }
    return transcript;
  }
  catch (error) {
    if (signal?.aborted) {
      throw new AppError(499, "CANCELLED", "Report generation was cancelled.");
    }
    if (timedOut) {
      throw new AppError(
        408,
        "PDF_TIMEOUT",
        "The PDF took too long to read. Try a smaller PDF or a .txt transcript.",
      );
    }
    if (error instanceof AppError) {
      throw error;
    }
    if (error.name === "PasswordException") {
      throw new AppError(
        400,
        "PDF_PASSWORD",
        "The PDF is password-protected. Upload a copy without password protection.",
      );
    }
    throw new AppError(
      400,
      "INVALID_PDF",
      "The PDF could not be read. Upload a valid text-based PDF or a .txt transcript.",
    );
  }
  finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
    await loading.destroy().catch(() => {});
  }
}

export async function extractTranscript(file, { signal } = {}) {
  if (!file) {
    throw new AppError(400, "FILE_REQUIRED", "Choose a .txt or .pdf transcript file.");
  }
  if (!isSupportedTranscript(file.originalname)) {
    throw new AppError(
      400,
      "INVALID_FILE_TYPE",
      "Only .txt and .pdf transcript files are supported.",
    );
  }
  if (!file.buffer.length) {
    throw new AppError(400, "EMPTY_FILE", "The transcript is empty.");
  }
  if (file.originalname.toLowerCase().endsWith(".pdf")) {
    return extractPdf(file.buffer, signal);
  }
  let transcript;
  try {
    transcript = new TextDecoder("utf-8", { fatal: true }).decode(file.buffer);
  }
  catch {
    throw new AppError(400, "INVALID_TEXT", "Save the transcript as UTF-8 text and try again.");
  }
  transcript = transcript.replace(/\r\n?/g, "\n").trim();
  if (!transcript) {
    throw new AppError(400, "EMPTY_FILE", "The transcript is empty.");
  }
  // eslint-disable-next-line no-control-regex -- Reject binary control bytes in uploaded text.
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(transcript)) {
    throw new AppError(400, "INVALID_TEXT", "The file contains binary or unreadable text.");
  }
  if (transcript.length > MAX_TRANSCRIPT_CHARACTERS) {
    throw new AppError(
      413,
      "TRANSCRIPT_TOO_LONG",
      "The transcript must be 120,000 characters or fewer.",
    );
  }
  return transcript;
}
