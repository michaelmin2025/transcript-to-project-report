import express from "express";
import multer from "multer";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_FILE_BYTES, MAX_TRANSCRIPT_CHARACTERS, ReportSchema } from "../../shared/report.js";
import { DocumentExportSchema, DOWNLOAD_FORMATS } from "../../shared/document.js";
import { AppError } from "./errors.js";
import { exportDocument } from "./export.js";
import { DEFAULT_MODEL, generateReport } from "./generate.js";
import { extractTranscript } from "./transcript.js";

const frontendDirectory = fileURLToPath(new URL("../../frontend/dist/", import.meta.url));

export function createApp({
  apiKey = process.env.DEEPSEEK_API_KEY || "",
  model = process.env.DEEPSEEK_MODEL || DEFAULT_MODEL,
  generate = generateReport,
  staticDirectory = frontendDirectory,
} = {}) {
  const app = express();
  let activeGenerations = 0;
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_FILE_BYTES, files: 1, fields: 0, parts: 1 },
  });
  app.disable("x-powered-by");
  app.use((request, response, next) => {
    response.set("X-Content-Type-Options", "nosniff");
    response.set("Referrer-Policy", "same-origin");
    if (request.path.startsWith("/api/") || request.path === "/health") {
      response.set("Cache-Control", "no-store");
    }
    next();
  });
  app.use(express.json({ limit: "1mb" }));
  app.get("/health", (_request, response) => response.json({ status: "ok" }));
  app.get("/api/config", (_request, response) =>
    response.json({
      provider: "DeepSeek",
      model,
      configured: Boolean(apiKey.trim()),
      maxFileBytes: MAX_FILE_BYTES,
      maxTranscriptCharacters: MAX_TRANSCRIPT_CHARACTERS,
    }),
  );
  app.post("/api/reports", upload.single("transcript"), async (request, response) => {
    if (activeGenerations >= 3) {
      throw new AppError(
        429,
        "SERVER_BUSY",
        "Three reports are already processing. Please try again shortly.",
      );
    }
    const controller = new AbortController();

    const cancel = () => {
      if (!response.writableEnded) {
        controller.abort();
      }
    };

    response.on("close", cancel);
    activeGenerations += 1;
    try {
      const transcript = await extractTranscript(request.file, { signal: controller.signal });
      const report = ReportSchema.parse(
        await generate(transcript, { apiKey, model, signal: controller.signal }),
      );
      response.json({
        report,
        sourceName: path.basename(request.file.originalname).slice(0, 255),
        generatedAt: new Date().toISOString(),
      });
    }
    finally {
      activeGenerations -= 1;
      response.off("close", cancel);
    }
  });
  app.post("/api/reports/export", async (request, response) => {
    const parsed = DocumentExportSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError(
        400,
        "INVALID_EXPORT",
        "The document is empty, too large, or contains unsupported formatting. Review your edits before downloading.",
      );
    }
    const document = await exportDocument(parsed.data.document, parsed.data.format);
    const format = DOWNLOAD_FORMATS[parsed.data.format];
    response.type(format.mime).attachment(`project-report.${format.extension}`).send(document);
  });
  app.use("/api", (_request, _response, next) =>
    next(new AppError(404, "NOT_FOUND", "This API endpoint does not exist.")),
  );
  if (staticDirectory && existsSync(path.join(staticDirectory, "index.html"))) {
    app.use(express.static(staticDirectory));
    app.get(/.*/, (request, response, next) => {
      if (path.extname(request.path)) {
        return next();
      }
      response.sendFile(path.join(staticDirectory, "index.html"));
    });
  }
  app.use((_request, _response, next) =>
    next(
      new AppError(404, "NOT_FOUND", "Page not found. Run npm run build before starting the app."),
    ),
  );
  app.use((error, _request, response, _next) => {
    if (response.headersSent) {
      return _next(error);
    }
    let failure = error;
    if (error instanceof multer.MulterError) {
      failure
        = error.code === "LIMIT_FILE_SIZE"
          ? new AppError(413, "FILE_TOO_LARGE", "The transcript must be 1 MB or smaller.")
          : new AppError(
              400,
              "INVALID_UPLOAD",
              "Upload one .txt or .pdf file in the transcript field.",
            );
    }
    else if (error.type === "entity.too.large") {
      failure = new AppError(413, "REPORT_TOO_LARGE", "The edited report is too large to export.");
    }
    else if (error instanceof SyntaxError && error.status === 400) {
      failure = new AppError(400, "INVALID_JSON", "The request contains invalid JSON.");
    }
    if (!(failure instanceof AppError)) {
      // Never log transcripts, provider responses, report contents, or credentials.
      failure = new AppError(
        500,
        "SERVER_ERROR",
        "The report could not be processed. Please try again.",
      );
    }
    response
      .status(failure.status)
      .json({ error: { code: failure.code, message: failure.message } });
  });
  return app;
}
