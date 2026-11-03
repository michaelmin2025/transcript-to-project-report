import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createReportStore } from "../src/store.js";
import { createArchiveSync } from "../src/archive-sync.js";
import { createArchiveJournal } from "../src/archive-journal.js";
import { reportArchiveKey, uploadArchiveKey } from "../src/transcript-archive.js";
import { SAMPLE_REPORT } from "./fixtures/report.js";

function fixture(t, enabled = true) {
  const directory = mkdtempSync(path.join(tmpdir(), "archive-journal-"));
  const filename = path.join(directory, "reports.sqlite");
  let store = createReportStore(filename, { archiveEnabled: enabled });
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const file = { originalname: "synthetic.txt", mimetype: "text/plain", buffer: Buffer.from("Synthetic meeting text") };
  const envelope = { report: structuredClone(SAMPLE_REPORT), sourceName: file.originalname, generatedAt: new Date().toISOString() };
  return { get store() {
    return store;
  }, filename, file, envelope, reopen() {
    store.close();
    store = createReportStore(filename, { archiveEnabled: enabled });
  } };
}

function refuseArchive(filename) {
  const db = new DatabaseSync(filename);
  db.exec("CREATE TRIGGER refuse_archive BEFORE INSERT ON transcript_archive_outbox BEGIN SELECT RAISE(ABORT, 'synthetic queue failure'); END;");
  db.close();
}

function receipt(key, body) {
  return { key, bytes: body.length, sha256: createHash("sha256").update(body).digest("hex") };
}

test("upload bytes and immutable report versions survive reopening", (t) => {
  const f = fixture(t);
  const upload = f.store.saveUpload(f.file);
  const original = f.store.create(f.envelope, upload.id);
  const edited = f.store.save(original.id, { document: original.document, version: original.version });
  f.reopen();
  const records = f.store.archives.pending();
  assert.equal(records.length, 3);
  assert.deepEqual(records.find(row => row.key === uploadArchiveKey(upload.id, upload.mime)).body, f.file.buffer);
  assert.equal(JSON.parse(records.find(row => row.key === reportArchiveKey(original.id, 1)).body).report.version, 1);
  assert.equal(JSON.parse(records.find(row => row.key === reportArchiveKey(original.id, 2)).body).report.version, edited.version);
});

test("upload insertion rolls back if its archive enqueue fails", (t) => {
  const f = fixture(t);
  refuseArchive(f.filename);
  assert.throws(() => f.store.saveUpload(f.file));
  assert.deepEqual(f.store.listUploads(), []);
});

test("report, job completion and archive enqueue roll back together", (t) => {
  const f = fixture(t);
  const upload = f.store.saveUpload(f.file);
  const job = f.store.jobs.start(upload.id);
  refuseArchive(f.filename);
  assert.throws(() => f.store.create(f.envelope, upload.id, job.job_id));
  assert.deepEqual(f.store.list(), []);
  assert.equal(f.store.jobs.get(job.job_id).metadata.status, "PROCESSING");
});

test("an edit rolls back when its archive version cannot be queued", (t) => {
  const f = fixture(t);
  const upload = f.store.saveUpload(f.file);
  const original = f.store.create(f.envelope, upload.id);
  refuseArchive(f.filename);
  assert.throws(() => f.store.save(original.id, { document: original.document, version: 1 }));
  assert.equal(f.store.get(original.id).version, 1);
});

test("an S3 outage preserves content and pending copies until successful retry", async (t) => {
  const f = fixture(t);
  const upload = f.store.saveUpload(f.file);
  f.store.create(f.envelope, upload.id);
  const failed = createArchiveSync(f.store.archives, { put: async () => {
    throw new Error("private SDK failure");
  } });
  assert.equal((await failed.flush()).failed, 2);
  f.reopen();
  assert.equal(f.store.list().length, 1);
  const success = createArchiveSync(f.store.archives, { put: async (key, body) => receipt(key, body) });
  assert.equal((await success.flush()).delivered, 2);
  assert.equal((await success.flush()).delivered, 0);
  const key = uploadArchiveKey(upload.id, upload.mime);
  assert.equal(f.store.archives.get(key).state, "delivered");
  assert.deepEqual(f.store.getUpload(upload.id).buffer, f.file.buffer);
  const db = new DatabaseSync(f.filename, { readOnly: true });
  assert.equal(db.prepare("SELECT payload FROM transcript_archive_outbox WHERE object_key = ?").get(key).payload, null);
  db.close();
});

test("conflicts are held without blocking newer copies or overwriting objects", async (t) => {
  const f = fixture(t);
  const first = f.store.saveUpload(f.file);
  const conflictKey = uploadArchiveKey(first.id, first.mime);
  const sync = createArchiveSync(f.store.archives, { put: async (key, body) => {
    if (key === conflictKey) {
      throw Object.assign(new Error("synthetic conflict"), { code: "ARCHIVE_CONFLICT" });
    }
    return receipt(key, body);
  } });
  await sync.flush();
  f.store.saveUpload(f.file);
  assert.equal((await sync.flush()).delivered, 1);
  assert.equal(f.store.archives.get(conflictKey).state, "conflict");
});

test("a receipt with the wrong hash cannot mark a copy delivered", async (t) => {
  const f = fixture(t);
  const upload = f.store.saveUpload(f.file);
  const sync = createArchiveSync(f.store.archives, { put: async (key, body) => ({ ...receipt(key, body), sha256: "wrong" }) });
  assert.equal((await sync.flush()).failed, 1);
  assert.equal(f.store.archives.get(uploadArchiveKey(upload.id, upload.mime)).state, "pending");
});

test("existing upload reuse is idempotent and local report deletion removes queued snapshots", (t) => {
  const f = fixture(t);
  const upload = f.store.saveUpload(f.file);
  f.store.ensureUploadArchive(upload.id);
  f.store.ensureUploadArchive(upload.id);
  const report = f.store.create(f.envelope, upload.id);
  f.store.remove(report.id);
  const rows = f.store.archives.pending();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].key, uploadArchiveKey(upload.id, upload.mime));
});

test("archive storage is opt-in and does not automatically backfill existing content", (t) => {
  const f = fixture(t, false);
  const upload = f.store.saveUpload(f.file);
  f.store.create(f.envelope, upload.id);
  assert.deepEqual(f.store.archives.pending(), []);
  assert.equal(f.store.ensureUploadArchive(upload.id), null);
});

test("expired pending copies are retained locally without being re-uploaded", () => {
  const db = new DatabaseSync(":memory:");
  let clock = 100;
  try {
    const journal = createArchiveJournal(db, { retentionDays: 7, now: () => clock });
    const upload = { id: "497a5742-5e37-471e-bf03-d63697a3f1a3", mime: "text/plain" };
    const key = journal.enqueueUpload(upload, Buffer.from("Synthetic text"));
    clock += 7 * 86400;
    assert.deepEqual(journal.pending(), []);
    assert.equal(journal.get(key).state, "expired");
  }
  finally {
    db.close();
  }
});
