import express from "express";
import multer from "multer";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_FILE_BYTES, MAX_TRANSCRIPT_CHARACTERS, ReportSchema } from "../../shared/report.js";
import { DocumentExportSchema, DOWNLOAD_FORMATS } from "../../shared/document.js";
import { AppError } from "./errors.js";
import { ReportUpdateSchema } from "../../shared/saved-report.js";
import { exportDocument } from "./export.js";
import { DEFAULT_MODEL, generateReport } from "./generate.js";
import { extractTranscript } from "./transcript.js";

const frontendDirectory = fileURLToPath(new URL("../../frontend/dist/", import.meta.url));

export function createApp({
  apiKey = process.env.DEEPSEEK_API_KEY || "",
  model = process.env.DEEPSEEK_MODEL || DEFAULT_MODEL,
  generate = generateReport,
  staticDirectory = frontendDirectory,
  store = null,
  telemetry = null,
  accessControl = null,
  jobTracking = null,
} = {}) {
  const app = express();
  if (jobTracking && (!store?.jobs || !Number.isInteger(jobTracking.retentionDays)
    || jobTracking.retentionDays < 7 || jobTracking.retentionDays > 365)) {
    throw new Error("Job tracking requires durable storage and valid retention.");
  }
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
  if (accessControl) {
    app.use(accessControl);
  }
  app.use(express.json({ limit: "1mb" }));
  app.get("/health", (_request, response) => {
    telemetry?.heartbeat();
    response.json({ status: "ok" });
  });
  app.get("/api/config", (_request, response) =>
    response.json({
      provider: "DeepSeek",
      model,
      configured: Boolean(apiKey.trim()),
      persistence: Boolean(store),
      maxFileBytes: MAX_FILE_BYTES,
      maxTranscriptCharacters: MAX_TRANSCRIPT_CHARACTERS,
    }),
  );

  function reportStore() {
    if (!store) {
      throw new AppError(503, "STORAGE_UNAVAILABLE", "Local report storage is not configured.");
    }
    return store;
  }

  app.get("/api/reports", (_request, response) => response.json(reportStore().list()));
  app.get("/api/reports/:id", (request, response) =>
    response.json(reportStore().get(request.params.id)),
  );
  app.delete("/api/reports/:id", (request, response) => {
    reportStore().remove(request.params.id);
    response.json({ deleted: true });
  });
  app.put("/api/reports/:id", (request, response) => {
    const parsed = ReportUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError(
        400,
        "INVALID_REPORT_UPDATE",
        "The edited document or saved version is invalid. Review your edits before saving.",
      );
    }
    response.json(reportStore().save(request.params.id, parsed.data));
  });

  async function createGeneratedReport(request, response, uploadId = null) {
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
    let generationStarted = false;
    let jobId = null;
    try {
      const savedUpload = uploadId ? reportStore().getUpload(uploadId) : null;
      const file = savedUpload
        ? { originalname: savedUpload.name, mimetype: savedUpload.mime, buffer: savedUpload.buffer }
        : request.file;
      const transcript = await extractTranscript(file, { signal: controller.signal });
      const source = savedUpload || (store ? store.saveUpload(file) : null);
      if (jobTracking) {
        jobId = store.jobs.start(source.id, jobTracking.retentionDays).job_id;
        response.set("X-Job-Id", jobId);
      }
      generationStarted = true;
      const report = ReportSchema.parse(
        await generate(transcript, { apiKey, model, signal: controller.signal }),
      );
      const envelope = {
        report,
        sourceName: source?.name || path.basename(file.originalname).slice(0, 255),
        generatedAt: new Date().toISOString(),
      };
      response.json(store ? store.create(envelope, source.id, jobId) : envelope);
      telemetry?.recordGeneration("success");
    }
    catch (error) {
      const outcome = controller.signal.aborted || error?.status === 499
        ? "cancelled"
        : generationStarted || !(error instanceof AppError) || error.status >= 500
          ? "failure"
          : "rejected";
      if (jobId) {
        try {
          store.jobs.finish(jobId, outcome === "cancelled" ? "CANCELLED" : "FAILED");
        }
        catch {
          // Report/SDK errors and request content must not enter routine logs.
          console.error("{\"event\":\"job_outcome_write_failed\"}");
        }
      }
      telemetry?.recordGeneration(outcome);
      throw error;
    }
    finally {
      activeGenerations -= 1;
      response.off("close", cancel);
    }
  }

  app.get("/api/jobs/:id", (request, response) => {
    if (!jobTracking) {
      throw new AppError(404, "JOB_TRACKING_DISABLED", "Job tracking is not enabled.");
    }
    const state = store.jobs.get(request.params.id);
    response.json({
      ...state.metadata,
      sync_state: state.metadata.expires_at <= Math.floor(Date.now() / 1000)
        ? "expired"
        : state.synced ? "synced" : "pending",
    });
  });

  app.post("/api/reports", upload.single("transcript"), (request, response) =>
    createGeneratedReport(request, response),
  );
  app.get("/api/uploads", (_request, response) => response.json(reportStore().listUploads()));
  app.get("/api/uploads/:id/file", (request, response) => {
    const file = reportStore().getUpload(request.params.id);
    response.type(file.mime).attachment(file.name).send(file.buffer);
  });
  app.post("/api/uploads/:id/reports", (request, response) =>
    createGeneratedReport(request, response, request.params.id),
  );
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
