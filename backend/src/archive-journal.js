import { createHash } from "node:crypto";
import { AppError } from "./errors.js";
import { uploadArchiveKey, reportArchiveKey } from "./transcript-archive.js";

export function createArchiveJournal(database, { retentionDays = 30, now = () => Math.floor(Date.now() / 1000) } = {}) {
  if (!Number.isInteger(retentionDays) || retentionDays < 7 || retentionDays > 365) {
    throw new Error("Archive retention must be 7-365 whole days.");
  }
  database.exec(`CREATE TABLE IF NOT EXISTS transcript_archive_outbox (
    object_key TEXT PRIMARY KEY, payload BLOB, sha256 TEXT NOT NULL,
    byte_count INTEGER NOT NULL, delivered INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT,
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
  ) STRICT;`);
  const select = database.prepare("SELECT object_key, sha256, byte_count, delivered, attempts, last_error, expires_at FROM transcript_archive_outbox WHERE object_key = ?");

  function enqueue(key, payload, maximum) {
    if (!Buffer.isBuffer(payload) || payload.length < 1 || payload.length > maximum) {
      throw new AppError(400, "INVALID_ARCHIVE_OBJECT", "Archive payload is empty or exceeds its size limit.");
    }
    const hash = createHash("sha256").update(payload).digest("hex");
    const existing = select.get(key);
    if (existing) {
      if (existing.sha256 !== hash || existing.byte_count !== payload.length) {
        throw new AppError(409, "ARCHIVE_LOCAL_CONFLICT", "Archive content for this version has already been recorded.");
      }
      return key;
    }
    const timestamp = now();
    database.prepare("INSERT INTO transcript_archive_outbox (object_key, payload, sha256, byte_count, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(key, payload, hash, payload.length, timestamp, timestamp + retentionDays * 86400);
    return key;
  }

  function enqueueUpload(upload, bytes) {
    return enqueue(uploadArchiveKey(upload.id, upload.mime), bytes, 1024 * 1024);
  }

  function enqueueReport(report) {
    const body = Buffer.from(JSON.stringify({ schemaVersion: 1, report }));
    return enqueue(reportArchiveKey(report.id, report.version), body, 4 * 1024 * 1024);
  }

  function get(key) {
    const row = select.get(key);
    if (!row) {
      throw new AppError(404, "ARCHIVE_NOT_FOUND", "The archive record was not found.");
    }
    return {
      key: row.object_key, sha256: row.sha256, bytes: row.byte_count,
      state: row.expires_at <= now() ? "expired" : row.delivered ? "delivered" : row.last_error === "ARCHIVE_CONFLICT" ? "conflict" : "pending",
      attempts: row.attempts,
    };
  }

  function pending(limit = 5) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
      throw new AppError(400, "INVALID_ARCHIVE_LIMIT", "Archive batch limit is invalid.");
    }
    // Attempt ordering prevents a permanently unavailable item starving new copies.
    return database.prepare("SELECT object_key, payload, sha256 FROM transcript_archive_outbox WHERE delivered = 0 AND expires_at > ? AND COALESCE(last_error, '') != 'ARCHIVE_CONFLICT' ORDER BY attempts, created_at, rowid LIMIT ?")
      .all(now(), limit).map(row => ({ key: row.object_key, body: Buffer.from(row.payload), sha256: row.sha256 }));
  }

  function attempted(key, hash) {
    return database.prepare("UPDATE transcript_archive_outbox SET attempts = attempts + 1 WHERE object_key = ? AND sha256 = ? AND delivered = 0")
      .run(key, hash).changes === 1;
  }

  function acknowledge(key, hash) {
    // Free duplicate payload bytes only after verified remote acceptance.
    return database.prepare("UPDATE transcript_archive_outbox SET delivered = 1, payload = NULL, last_error = NULL WHERE object_key = ? AND sha256 = ? AND delivered = 0")
      .run(key, hash).changes === 1;
  }

  function failed(key, hash, code) {
    const safeCode = code === "ARCHIVE_CONFLICT" ? code : "ARCHIVE_UNAVAILABLE";
    database.prepare("UPDATE transcript_archive_outbox SET last_error = ? WHERE object_key = ? AND sha256 = ? AND delivered = 0")
      .run(safeCode, key, hash);
  }

  function removeReport(id) {
    // Validate UUID via the key helper before using the derived prefix.
    const prefix = reportArchiveKey(id, 1).replace(/v1\.json$/, "");
    database.prepare("DELETE FROM transcript_archive_outbox WHERE object_key LIKE ?").run(prefix + "%");
  }

  return { enqueueUpload, enqueueReport, get, pending, attempted, acknowledge, failed, removeReport };
}
