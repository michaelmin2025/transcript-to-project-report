import assert from "node:assert/strict";
import test from "node:test";
import request from "supertest";
import { scryptSync } from "node:crypto";
import { createApp } from "../src/app.js";
import { createReportStore } from "../src/store.js";
import { loadAccessControl } from "../src/auth.js";
import { AppError } from "../src/errors.js";
import { loadJobConfiguration, startJobSynchronization } from "../src/job-runtime.js";
import { SAMPLE_REPORT } from "./fixtures/report.js";

const origin = "http://private.example:4567";
const salt = Buffer.alloc(16, 3);
const password = "synthetic-owner-password";
const configuration = { endpoint_url: "http://ministack:4566", region: "us-east-1", table: "ministack-lab-transcript-jobs", retention_days: 30 };
const environment = {
  TRANSCRIPT_JOBS_ENDPOINT_URL: configuration.endpoint_url, TRANSCRIPT_JOBS_REGION: configuration.region,
  TRANSCRIPT_JOBS_TABLE: configuration.table, TRANSCRIPT_JOBS_RETENTION_DAYS: "30",
};

function fixture(t, generate = async () => structuredClone(SAMPLE_REPORT)) {
  const store = createReportStore(":memory:");
  t.after(() => store.close());
  const accessControl = loadAccessControl({
    APP_AUTH_USERNAME: "owner", APP_AUTH_PASSWORD_HASH: `${salt.toString("hex")}:${scryptSync(password, salt, 64).toString("hex")}`, APP_AUTH_ORIGIN: origin,
  });
  const app = createApp({ store, staticDirectory: null, generate, apiKey: "synthetic-only", accessControl, jobTracking: { retentionDays: 30 } });
  return { app, store };
}

function authorized(app, method, path) {
  return request(app)[method](path).set("Origin", origin).auth("owner", password);
}

function upload(app) {
  return authorized(app, "post", "/api/reports").attach("transcript", Buffer.from("Synthetic project meeting"), "synthetic.txt");
}

test("generation returns a job ID and authenticated status links to the saved report", async (t) => {
  const { app, store } = fixture(t);
  const result = await upload(app).expect(200);
  const id = result.headers["x-job-id"];
  assert.ok(id);
  const status = await authorized(app, "get", `/api/jobs/${id}`).expect(200);
  assert.equal(status.body.status, "COMPLETED");
  assert.equal(status.body.report_id, result.body.id);
  assert.equal(status.body.sync_state, "pending");
  assert.equal(store.list().length, 1);
  assert.equal(JSON.stringify(status.body).includes("synthetic.txt"), false);
});

test("status is protected and invalid/unknown IDs are handled safely", async (t) => {
  const { app } = fixture(t);
  await request(app).get("/api/jobs/invalid").expect(401);
  await authorized(app, "get", "/api/jobs/invalid").expect(400);
  await authorized(app, "get", "/api/jobs/ea5821c9-f15a-4dd0-9df9-8364097127c6").expect(404);
});

test("provider failure creates a failed job without exposing raw provider errors", async (t) => {
  const { app, store } = fixture(t, async () => {
    throw new AppError(502, "PROVIDER_AUTH", "synthetic provider details");
  });
  const result = await upload(app).expect(502);
  const status = await authorized(app, "get", `/api/jobs/${result.headers["x-job-id"]}`).expect(200);
  assert.equal(status.body.status, "FAILED");
  assert.equal(status.body.error_code, "GENERATION_FAILED");
  assert.equal(JSON.stringify(status.body).includes("synthetic provider details"), false);
  assert.equal(store.list().length, 0);
});

test("cancelled generation records CANCELLED", async (t) => {
  const { app } = fixture(t, async () => {
    throw new AppError(499, "CANCELLED", "Cancelled");
  });
  const result = await upload(app).expect(499);
  const status = await authorized(app, "get", `/api/jobs/${result.headers["x-job-id"]}`).expect(200);
  assert.equal(status.body.status, "CANCELLED");
});

test("invalid uploads create no jobs or provider requests", async (t) => {
  let calls = 0;
  const { app, store } = fixture(t, async () => {
    calls += 1;
    return structuredClone(SAMPLE_REPORT);
  });
  const result = await authorized(app, "post", "/api/reports").attach("transcript", Buffer.from(""), "empty.txt").expect(400);
  assert.equal(result.headers["x-job-id"], undefined);
  assert.equal(calls, 0);
  assert.deepEqual(store.jobs.pending(), []);
});

test("regeneration creates distinct jobs while preserving one original upload", async (t) => {
  const { app, store } = fixture(t);
  const first = await upload(app).expect(200);
  const id = store.listUploads()[0].id;
  const second = await authorized(app, "post", `/api/uploads/${id}/reports`).expect(200);
  assert.notEqual(first.headers["x-job-id"], second.headers["x-job-id"]);
  assert.equal(store.list().length, 2);
  assert.equal(store.listUploads().length, 1);
});

test("configuration is opt-in and partial, real-AWS and invalid retention settings fail closed", () => {
  assert.equal(loadJobConfiguration({}), null);
  assert.deepEqual(loadJobConfiguration(environment), configuration);
  for (const values of [{ TRANSCRIPT_JOBS_TABLE: configuration.table }, { ...environment, TRANSCRIPT_JOBS_ENDPOINT_URL: "https://dynamodb.us-east-1.amazonaws.com" }, { ...environment, TRANSCRIPT_JOBS_RETENTION_DAYS: "0" }]) {
    assert.throws(() => loadJobConfiguration(values));
  }
});

test("startup marks interrupted jobs failed while preserving completed reports", async (t) => {
  const { store, app } = fixture(t);
  const complete = await upload(app).expect(200);
  const interrupted = store.jobs.start(store.listUploads()[0].id);
  const adapter = { write: async () => {} };
  const runtime = startJobSynchronization(store, configuration, { adapter });
  try {
    await runtime.flush();
    assert.equal(store.jobs.get(interrupted.job_id).metadata.status, "FAILED");
    assert.equal(store.jobs.get(complete.headers["x-job-id"]).metadata.status, "COMPLETED");
    assert.equal(store.jobs.get(interrupted.job_id).synced, true);
    assert.equal(store.list().length, 1);
  }
  finally {
    await runtime.stop();
  }
});

test("outage recovery synchronizes metadata without generating another report", async (t) => {
  let calls = 0;
  const { store, app } = fixture(t, async () => {
    calls += 1;
    return structuredClone(SAMPLE_REPORT);
  });
  const result = await upload(app).expect(200);
  let offline = true;
  const runtime = startJobSynchronization(store, configuration, { adapter: { write: async () => {
    if (offline) {
      throw new Error("synthetic outage");
    }
  } } });
  try {
    await runtime.flush();
    assert.equal(store.jobs.get(result.headers["x-job-id"]).synced, false);
    offline = false;
    await runtime.flush();
    const status = await authorized(app, "get", `/api/jobs/${result.headers["x-job-id"]}`).expect(200);
    assert.equal(status.body.sync_state, "synced");
    assert.equal(calls, 1);
    assert.equal(store.list().length, 1);
  }
  finally {
    await runtime.stop();
  }
});
