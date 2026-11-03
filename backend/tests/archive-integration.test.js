import assert from "node:assert/strict";
import { createHash, scryptSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import request from "supertest";
import { createApp } from "../src/app.js";
import { createReportStore } from "../src/store.js";
import { loadAccessControl } from "../src/auth.js";
import { loadArchiveConfiguration, startArchiveSynchronization } from "../src/archive-runtime.js";
import { SAMPLE_REPORT } from "./fixtures/report.js";

const origin = "http://private.example:4567";
const password = "synthetic-owner-password";
const salt = Buffer.alloc(16, 19);
const configuration = { endpoint_url: "http://ministack:4566", region: "us-east-1", bucket: "ministack-lab-assets", upload_prefix: "transcript/uploads/", report_prefix: "transcript/reports/", retention_days: 30 };
const environment = Object.fromEntries(Object.entries(configuration).map(([key, value]) => [`TRANSCRIPT_ARCHIVE_${key.toUpperCase()}`, String(value)]));

function fixture(t, seedExisting = false) {
  const directory = mkdtempSync(path.join(tmpdir(), "archive-integration-"));
  const filename = path.join(directory, "reports.sqlite");
  let oldUpload = null;
  const file = { originalname: "synthetic.txt", mimetype: "text/plain", buffer: Buffer.from("Synthetic project meeting") };
  if (seedExisting) {
    const old = createReportStore(filename);
    oldUpload = old.saveUpload(file);
    old.close();
  }
  const store = createReportStore(filename, { archiveEnabled: true });
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const accessControl = loadAccessControl({ APP_AUTH_USERNAME: "owner", APP_AUTH_PASSWORD_HASH: `${salt.toString("hex")}:${scryptSync(password, salt, 64).toString("hex")}`, APP_AUTH_ORIGIN: origin });
  let generations = 0;
  const app = createApp({ store, staticDirectory: null, apiKey: "synthetic-only", accessControl,
    jobTracking: { retentionDays: 30 }, archiveTracking: true,
    generate: async () => {
      generations += 1;
      return structuredClone(SAMPLE_REPORT);
    } });
  return { app, store, file, oldUpload, get generations() {
    return generations;
  } };
}

function authorized(app, method, path) {
  return request(app)[method](path).auth("owner", password).set("Origin", origin);
}

function upload(app) {
  return authorized(app, "post", "/api/reports").attach("transcript", Buffer.from("Synthetic project meeting"), "synthetic.txt");
}

function adapter() {
  const objects = new Map();
  return { objects, async put(key, bytes) {
    objects.set(key, Buffer.from(bytes));
    return { key, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  } };
}

test("generation queues originals/reports, exposes a report key and protected pending status", async (t) => {
  const f = fixture(t);
  const result = await upload(f.app).expect(200);
  assert.match(result.headers["x-archive-report-key"], /\/v1\.json$/);
  const source = f.store.listUploads()[0];
  const original = await authorized(f.app, "get", `/api/archives/uploads/${source.id}`).expect(200);
  const report = await authorized(f.app, "get", `/api/archives/reports/${result.body.id}/versions/1`).expect(200);
  assert.equal(original.body.state, "pending");
  assert.equal(report.body.state, "pending");
  assert.equal(JSON.stringify(original.body).includes("synthetic.txt"), false);
  assert.equal(f.store.jobs.pending()[0].status, "COMPLETED");
});

test("archive status rejects anonymous callers and handles invalid/unknown keys", async (t) => {
  const f = fixture(t);
  await request(f.app).get("/api/archives/uploads/invalid").expect(401);
  await request(f.app).get("/api/archives/reports/invalid/versions/1").expect(401);
  await authorized(f.app, "get", "/api/archives/reports/invalid/versions/1").expect(400);
  await authorized(f.app, "get", "/api/archives/reports/497a5742-5e37-471e-bf03-d63697a3f1a3/versions/0").expect(400);
  await authorized(f.app, "get", "/api/archives/reports/497a5742-5e37-471e-bf03-d63697a3f1a3/versions/1").expect(404);
});

test("background delivery changes status without generating or altering local files", async (t) => {
  const f = fixture(t);
  const generated = await upload(f.app).expect(200);
  const remote = adapter();
  const runtime = startArchiveSynchronization(f.store, configuration, { adapter: remote });
  try {
    await runtime.flush();
    const status = await authorized(f.app, "get", `/api/archives/reports/${generated.body.id}/versions/1`).expect(200);
    assert.equal(status.body.state, "delivered");
    assert.equal(remote.objects.size, 2);
    assert.equal(f.generations, 1);
    assert.equal(f.store.list().length, 1);
    assert.deepEqual(f.store.getUpload(f.store.listUploads()[0].id).buffer, f.file.buffer);
  }
  finally {
    await runtime.stop();
  }
});

test("saved edits queue a separate immutable version through the existing API", async (t) => {
  const f = fixture(t);
  const generated = await upload(f.app).expect(200);
  const record = f.store.get(generated.body.id);
  await authorized(f.app, "put", `/api/reports/${record.id}`).send({ document: record.document, version: record.version }).expect(200);
  const first = await authorized(f.app, "get", `/api/archives/reports/${record.id}/versions/1`).expect(200);
  const second = await authorized(f.app, "get", `/api/archives/reports/${record.id}/versions/2`).expect(200);
  assert.notEqual(first.body.key, second.body.key);
  assert.equal(f.store.archives.pending().length, 3);
});

test("a saved upload from before enablement is queued once on active reuse", async (t) => {
  const f = fixture(t, true);
  assert.deepEqual(f.store.archives.pending(), []);
  await authorized(f.app, "post", `/api/uploads/${f.oldUpload.id}/reports`).expect(200);
  await authorized(f.app, "post", `/api/uploads/${f.oldUpload.id}/reports`).expect(200);
  assert.equal(f.store.listUploads().length, 1);
  assert.equal(f.store.archives.pending().length, 3);
});

test("an S3 outage leaves saved results pending and recovery never repeats generation", async (t) => {
  const f = fixture(t);
  const generated = await upload(f.app).expect(200);
  let offline = true;
  const remote = adapter();
  const runtime = startArchiveSynchronization(f.store, configuration, { adapter: { put: async (key, body) => {
    if (offline) {
      throw new Error("synthetic outage");
    }
    return remote.put(key, body);
  } } });
  try {
    await runtime.flush();
    assert.equal(f.store.archives.pending().length, 2);
    offline = false;
    await runtime.flush();
    const status = await authorized(f.app, "get", `/api/archives/reports/${generated.body.id}/versions/1`).expect(200);
    assert.equal(status.body.state, "delivered");
    assert.equal(f.generations, 1);
  }
  finally {
    await runtime.stop();
  }
});

test("configuration is opt-in and rejects partial, real-AWS and invalid retention settings", () => {
  assert.equal(loadArchiveConfiguration({}), null);
  assert.deepEqual(loadArchiveConfiguration(environment), configuration);
  for (const update of [{ TRANSCRIPT_ARCHIVE_BUCKET: "other" }, { TRANSCRIPT_ARCHIVE_ENDPOINT_URL: "https://s3.amazonaws.com" }, { TRANSCRIPT_ARCHIVE_RETENTION_DAYS: "0" }]) {
    assert.throws(() => loadArchiveConfiguration({ ...environment, ...update }));
  }
  assert.throws(() => loadArchiveConfiguration({ TRANSCRIPT_ARCHIVE_BUCKET: configuration.bucket }));
});

test("disabled archive storage cannot silently accept tracking or background delivery", () => {
  const store = createReportStore(":memory:");
  try {
    assert.throws(() => createApp({ store, archiveTracking: true }));
    assert.throws(() => startArchiveSynchronization(store, configuration, { adapter: adapter() }));
  }
  finally {
    store.close();
  }
});
