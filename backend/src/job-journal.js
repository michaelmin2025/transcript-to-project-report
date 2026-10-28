import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AppError } from "./errors.js";

// Shares the report store's connection so completion can commit with the report.
export function createJobJournal(database, { now = () => Math.floor(Date.now() / 1000) } = {}) {
  database.exec(`CREATE TABLE IF NOT EXISTS transcript_job_outbox (
    job_id TEXT PRIMARY KEY, revision INTEGER NOT NULL,
    synced_revision INTEGER NOT NULL DEFAULT 0, metadata_json TEXT NOT NULL
  ) STRICT;`);
  const select = database.prepare("SELECT * FROM transcript_job_outbox WHERE job_id = ?");

  function get(id) {
    if (!z.string().uuid().safeParse(id).success) {
      throw new AppError(400, "INVALID_JOB_ID", "Job identifier is invalid.");
    }
    const row = select.get(id);
    if (!row) {
      throw new AppError(404, "JOB_NOT_FOUND", "The job was not found.");
    }
    return { metadata: JSON.parse(row.metadata_json), synced: row.synced_revision === row.revision };
  }

  function start(uploadId, retentionDays = 30) {
    if (!z.string().uuid().safeParse(uploadId).success || !Number.isInteger(retentionDays) || retentionDays < 7 || retentionDays > 365) {
      throw new AppError(400, "INVALID_JOB_METADATA", "Job metadata is invalid.");
    }
    const timestamp = now();
    const metadata = {
      job_id: randomUUID(), workflow: "transcript-report", schema_version: 1,
      revision: 1, status: "PROCESSING", created_at: timestamp, updated_at: timestamp,
      expires_at: timestamp + retentionDays * 86400, upload_id: uploadId,
    };
    database.prepare("INSERT INTO transcript_job_outbox (job_id, revision, metadata_json) VALUES (?, 1, ?)")
      .run(metadata.job_id, JSON.stringify(metadata));
    return metadata;
  }

  function finish(id, status, reportId = null) {
    if (!["COMPLETED", "FAILED", "CANCELLED"].includes(status)
      || (status === "COMPLETED" ? !z.string().uuid().safeParse(reportId).success : reportId !== null)) {
      throw new AppError(400, "INVALID_JOB_METADATA", "Job outcome is invalid.");
    }
    const { metadata } = get(id);
    if (metadata.status !== "PROCESSING") {
      if (metadata.status === status && (metadata.report_id || null) === reportId) {
        return metadata;
      }
      throw new AppError(409, "JOB_STATE_CONFLICT", "Job status has already changed.");
    }
    const timestamp = Math.max(metadata.created_at, now());
    if (timestamp >= metadata.expires_at) {
      throw new AppError(410, "JOB_EXPIRED", "Job metadata has expired.");
    }
    const terminal = { ...metadata, revision: 2, status, updated_at: timestamp };
    if (reportId) {
      terminal.report_id = reportId;
    }
    else {
      terminal.error_code = status === "CANCELLED" ? "CANCELLED" : "GENERATION_FAILED";
    }
    const result = database.prepare("UPDATE transcript_job_outbox SET revision = 2, metadata_json = ? WHERE job_id = ? AND revision = 1")
      .run(JSON.stringify(terminal), id);
    if (result.changes !== 1) {
      throw new AppError(409, "JOB_STATE_CONFLICT", "Job status has already changed.");
    }
    return terminal;
  }

  function pending(limit = 10) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new AppError(400, "INVALID_JOB_LIMIT", "Job batch limit is invalid.");
    }
    return database.prepare("SELECT metadata_json FROM transcript_job_outbox WHERE synced_revision < revision AND json_extract(metadata_json, '$.expires_at') > ? ORDER BY rowid LIMIT ?")
      .all(now(), limit).map(row => JSON.parse(row.metadata_json));
  }

  function acknowledge(id, revision) {
    if (!z.string().uuid().safeParse(id).success || ![1, 2].includes(revision)) {
      throw new AppError(400, "INVALID_JOB_METADATA", "Job acknowledgement is invalid.");
    }
    return database.prepare("UPDATE transcript_job_outbox SET synced_revision = ? WHERE job_id = ? AND revision = ?")
      .run(revision, id, revision).changes === 1;
  }

  function recoverInterrupted() {
    const records = database.prepare("SELECT job_id FROM transcript_job_outbox WHERE json_extract(metadata_json, '$.status') = 'PROCESSING' AND json_extract(metadata_json, '$.expires_at') > ?").all(now());
    for (const row of records) {
      finish(row.job_id, "FAILED");
    }
    return records.length;
  }

  return { start, finish, get, pending, acknowledge, recoverInterrupted };
}
