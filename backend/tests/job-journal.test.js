import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createReportStore } from "../src/store.js";
import { createJobSync } from "../src/job-sync.js";
import { createJobJournal } from "../src/job-journal.js";
import { SAMPLE_REPORT } from "./fixtures/report.js";

function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), "job-journal-"));
  const filename = path.join(directory, "reports.sqlite");
  let store = createReportStore(filename);
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const upload = store.saveUpload({ originalname: "synthetic.txt", buffer: Buffer.from("Synthetic meeting"), mimetype: "text/plain" });
  const envelope = { report: structuredClone(SAMPLE_REPORT), sourceName: "synthetic.txt", generatedAt: new Date().toISOString() };
  return { get store() {
    return store;
  }, filename, upload, envelope, reopen() {
    store.close();
    store = createReportStore(filename);
  } };
}

test("report and completed metadata persist together across reopening SQLite", (t) => {
  const f = fixture(t);
  const job = f.store.jobs.start(f.upload.id);
  const report = f.store.create(f.envelope, f.upload.id, job.job_id);
  f.reopen();
  assert.equal(f.store.list().length, 1);
  const saved = f.store.jobs.get(job.job_id);
  assert.equal(saved.metadata.status, "COMPLETED");
  assert.equal(saved.metadata.report_id, report.id);
  assert.equal(saved.synced, false);
  assert.equal(f.store.jobs.pending().length, 1);
});

test("completion write failure rolls back the inserted report", (t) => {
  const f = fixture(t);
  const job = f.store.jobs.start(f.upload.id);
  const db = new DatabaseSync(f.filename);
  db.exec("CREATE TRIGGER refuse_completion BEFORE UPDATE ON transcript_job_outbox BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END;");
  db.close();
  assert.throws(() => f.store.create(f.envelope, f.upload.id, job.job_id));
  assert.equal(f.store.list().length, 0);
  assert.equal(f.store.jobs.get(job.job_id).metadata.status, "PROCESSING");
});

test("a job from another upload cannot be attached to the report", (t) => {
  const f = fixture(t);
  const job = f.store.jobs.start("5fdb8cec-cd88-4500-8eeb-72d0d77f0dc5");
  assert.throws(() => f.store.create(f.envelope, f.upload.id, job.job_id), error => error.code === "JOB_STATE_CONFLICT");
  assert.equal(f.store.list().length, 0);
});

test("an unavailable remote leaves completed metadata durable for later retry", async (t) => {
  const f = fixture(t);
  const job = f.store.jobs.start(f.upload.id);
  f.store.create(f.envelope, f.upload.id, job.job_id);
  const unavailable = createJobSync(f.store.jobs, { write: async () => {
    throw new Error("synthetic unavailable");
  } });
  assert.equal((await unavailable.flush()).failed, 1);
  f.reopen();
  assert.equal(f.store.list().length, 1);
  let delivered = 0;
  const recovered = createJobSync(f.store.jobs, { write: async () => {
    delivered += 1;
  } });
  assert.equal((await recovered.flush()).delivered, 1);
  assert.equal((await recovered.flush()).delivered, 0);
  assert.equal(delivered, 1);
  assert.equal(f.store.jobs.get(job.job_id).synced, true);
});

test("acknowledging an in-flight processing snapshot cannot lose a newer completion", async (t) => {
  const f = fixture(t);
  const job = f.store.jobs.start(f.upload.id);
  const sync = createJobSync(f.store.jobs, { write: async () => {
    f.store.create(f.envelope, f.upload.id, job.job_id);
  } });
  assert.equal((await sync.flush()).delivered, 0);
  assert.equal(f.store.jobs.pending()[0].revision, 2);
  assert.equal(f.store.jobs.get(job.job_id).synced, false);
});

test("failed and cancelled jobs keep safe metadata and cannot become completed", (t) => {
  const f = fixture(t);
  for (const status of ["FAILED", "CANCELLED"]) {
    const job = f.store.jobs.start(f.upload.id);
    f.store.jobs.finish(job.job_id, status);
    const metadata = f.store.jobs.get(job.job_id).metadata;
    assert.equal(metadata.status, status);
    assert.equal("report_id" in metadata, false);
    assert.equal(JSON.stringify(metadata).includes("synthetic.txt"), false);
    assert.throws(() => f.store.create(f.envelope, f.upload.id, job.job_id), error => error.code === "JOB_STATE_CONFLICT");
  }
});

test("legacy report creation and editing storage remain usable without a job", (t) => {
  const f = fixture(t);
  const record = f.store.create(f.envelope, f.upload.id);
  assert.equal(f.store.get(record.id).id, record.id);
  assert.deepEqual(f.store.jobs.pending(), []);
});

test("invalid journal inputs fail before writes", (t) => {
  const f = fixture(t);
  assert.throws(() => f.store.jobs.start("invalid"));
  assert.throws(() => f.store.jobs.start(f.upload.id, 0));
  assert.throws(() => f.store.jobs.pending(1000));
  assert.throws(() => f.store.jobs.acknowledge(f.upload.id, 9));
  assert.deepEqual(f.store.jobs.pending(), []);
});

test("expired pending records do not block unexpired deliveries", () => {
  const database = new DatabaseSync(":memory:");
  let clock = 100;
  try {
    const journal = createJobJournal(database, { now: () => clock });
    const old = journal.start("5fdb8cec-cd88-4500-8eeb-72d0d77f0dc5", 7);
    clock = old.expires_at + 1;
    const current = journal.start("5fdb8cec-cd88-4500-8eeb-72d0d77f0dc5", 7);
    assert.deepEqual(journal.pending().map(row => row.job_id), [current.job_id]);
    assert.equal(journal.get(old.job_id).synced, false);
  }
  finally {
    database.close();
  }
});
