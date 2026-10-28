import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { ReportEnvelopeSchema } from "../../shared/report.js";
import { reportToDocument } from "../../shared/document.js";
import {
  ReportListSchema,
  ReportUpdateSchema,
  SavedReportSchema,
  UploadListSchema,
  UploadSchema,
} from "../../shared/saved-report.js";
import { AppError } from "./errors.js";
import { createJobJournal } from "./job-journal.js";

export function createReportStore(filename) {
  if (filename !== ":memory:") {
    mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
  }
  const database = new DatabaseSync(filename);
  database.exec(
    "PRAGMA busy_timeout = 5000; CREATE TABLE IF NOT EXISTS reports (id TEXT PRIMARY KEY, title TEXT NOT NULL, source_name TEXT NOT NULL, generated_at TEXT NOT NULL, updated_at TEXT NOT NULL, version INTEGER NOT NULL, report_json TEXT NOT NULL, document_json TEXT NOT NULL) STRICT;",
  );
  database.exec(
    "CREATE TABLE IF NOT EXISTS uploads (id TEXT PRIMARY KEY, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, uploaded_at TEXT NOT NULL, content BLOB NOT NULL) STRICT;",
  );
  if (
    !database
      .prepare("PRAGMA table_info(reports)")
      .all()
      .some(column => column.name === "upload_id")
  ) {
    database.exec("ALTER TABLE reports ADD COLUMN upload_id TEXT REFERENCES uploads(id)");
  }
  database.exec("PRAGMA foreign_keys = ON");
  const jobs = createJobJournal(database);
  const insertUpload = database.prepare("INSERT INTO uploads VALUES (?, ?, ?, ?, ?, ?)");
  const selectUpload = database.prepare("SELECT * FROM uploads WHERE id = ?");
  const uploadListing = database.prepare(
    "SELECT id, name, mime, size, uploaded_at AS uploadedAt FROM uploads ORDER BY uploaded_at DESC, rowid DESC",
  );
  const select = database.prepare("SELECT * FROM reports WHERE id = ?");
  const insert = database.prepare(
    "INSERT INTO reports (id, title, source_name, generated_at, updated_at, version, report_json, document_json, upload_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const update = database.prepare(
    "UPDATE reports SET title = ?, document_json = ?, updated_at = ?, version = version + 1 WHERE id = ? AND version = ?",
  );
  const listing = database.prepare(
    "SELECT id, title, source_name AS sourceName, generated_at AS generatedAt, updated_at AS updatedAt, version FROM reports ORDER BY updated_at DESC, rowid DESC",
  );

  function safely(action) {
    try {
      return action();
    }
    catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError(
        503,
        "STORAGE_UNAVAILABLE",
        "Could not save or open the report. Check the local data folder and try again.",
      );
    }
  }

  function get(id) {
    return safely(() => {
      const row = select.get(id);
      if (!row) {
        throw new AppError(404, "REPORT_NOT_FOUND", "The saved report was not found.");
      }
      return SavedReportSchema.parse({
        id: row.id,
        report: JSON.parse(row.report_json),
        document: JSON.parse(row.document_json),
        uploadId: row.upload_id,
        sourceName: row.source_name,
        generatedAt: row.generated_at,
        updatedAt: row.updated_at,
        version: row.version,
      });
    });
  }

  function create(envelope, uploadId = null, jobId = null) {
    return safely(() => {
      const original = ReportEnvelopeSchema.parse(envelope);
      const record = SavedReportSchema.parse({
        ...original,
        uploadId,
        id: randomUUID(),
        updatedAt: original.generatedAt,
        version: 1,
        document: reportToDocument(original),
      });
      if (jobId) {
        const job = jobs.get(jobId).metadata;
        if (job.status !== "PROCESSING" || job.upload_id !== uploadId) {
          throw new AppError(409, "JOB_STATE_CONFLICT", "The job does not match this report.");
        }
        database.exec("BEGIN IMMEDIATE");
      }
      try {
        insert.run(
          record.id,
          record.report.title,
          record.sourceName,
          record.generatedAt,
          record.updatedAt,
          record.version,
          JSON.stringify(record.report),
          JSON.stringify(record.document),
          record.uploadId,
        );
        if (jobId) {
          jobs.finish(jobId, "COMPLETED", record.id);
          database.exec("COMMIT");
        }
      }
      catch (error) {
        if (jobId) {
          database.exec("ROLLBACK");
        }
        throw error;
      }
      return record;
    });
  }

  function save(id, payload) {
    return safely(() => {
      const { document, version } = ReportUpdateSchema.parse(payload);
      const titleNode = document.content.find(
        node => node.type === "heading" && node.attrs.level === 1,
      );
      const title
        = titleNode?.content
          ?.map(node => node.text || "")
          .join("")
          .trim()
          .slice(0, 160) || get(id).report.title;
      const result = update.run(
        title,
        JSON.stringify(document),
        new Date().toISOString(),
        id,
        version,
      );
      if (!result.changes) {
        get(id);
        throw new AppError(
          409,
          "REPORT_CONFLICT",
          "This report was changed in another window. Reopen it to load the latest saved version.",
        );
      }
      return get(id);
    });
  }

  function list() {
    return safely(() => ReportListSchema.parse(listing.all()));
  }

  function remove(id) {
    return safely(() => {
      const result = database.prepare("DELETE FROM reports WHERE id = ?").run(id);
      if (!result.changes) {
        throw new AppError(404, "REPORT_NOT_FOUND", "The saved report was not found.");
      }
    });
  }

  function saveUpload(file) {
    return safely(() => {
      const name = path.basename(file.originalname.replaceAll("\\", "/")).slice(0, 255);
      const record = UploadSchema.parse({
        id: randomUUID(),
        name,
        mime: name.toLowerCase().endsWith(".pdf") ? "application/pdf" : "text/plain",
        size: file.buffer.length,
        uploadedAt: new Date().toISOString(),
      });
      insertUpload.run(
        record.id,
        record.name,
        record.mime,
        record.size,
        record.uploadedAt,
        file.buffer,
      );
      return record;
    });
  }

  function getUpload(id) {
    return safely(() => {
      const row = selectUpload.get(id);
      if (!row) {
        throw new AppError(404, "UPLOAD_NOT_FOUND", "The saved upload was not found.");
      }
      const metadata = UploadSchema.parse({
        id: row.id,
        name: row.name,
        mime: row.mime,
        size: row.size,
        uploadedAt: row.uploaded_at,
      });
      return { ...metadata, buffer: Buffer.from(row.content) };
    });
  }

  function listUploads() {
    return safely(() => UploadListSchema.parse(uploadListing.all()));
  }

  function close() {
    database.close();
  }

  return { create, get, save, list, remove, saveUpload, getUpload, listUploads, jobs, close };
}
