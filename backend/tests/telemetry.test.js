import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { createTelemetry } from "../src/telemetry.js";
import { createApp } from "../src/app.js";
import { AppError } from "../src/errors.js";
import { SAMPLE_REPORT } from "./fixtures/report.js";

function fixture(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "transcript-telemetry-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, "telemetry.json");
  const events = [];
  const telemetry = createTelemetry({ filename, log: event => events.push(JSON.parse(event)) });
  return { filename, events, telemetry, read: () => JSON.parse(readFileSync(filename, "utf8")) };
}

test("telemetry persists content-free counters across process initialization", (t) => {
  const state = fixture(t);
  state.telemetry.recordGeneration("failure");
  state.telemetry.recordGeneration("success");
  state.telemetry.recordGeneration("private transcript or credential");
  assert.deepEqual(state.read().counters, { success: 1, failure: 1, cancelled: 0, rejected: 0 });
  assert.equal(JSON.stringify(state.events).includes("private transcript"), false);
  const restored = createTelemetry({ filename: state.filename, log: () => {} });
  restored.recordGeneration("success");
  assert.equal(state.read().counters.success, 2);
  if (process.platform !== "win32") {
    assert.equal(statSync(state.filename).mode & 0o777, 0o600);
  }
});

test("corrupt snapshots and write failures do not throw or reveal raw errors", (t) => {
  const state = fixture(t);
  writeFileSync(state.filename, "private invalid snapshot");
  const recovered = createTelemetry({ filename: state.filename, log: event => state.events.push(JSON.parse(event)) });
  assert.equal(state.read().counters.failure, 0);
  const blocked = path.join(state.filename, "cannot-write.json");
  const unavailable = createTelemetry({ filename: blocked, log: event => state.events.push(JSON.parse(event)) });
  assert.doesNotThrow(() => unavailable.recordGeneration("failure"));
  assert.equal(JSON.stringify(state.events).includes("private invalid"), false);
  assert.ok(state.events.some(event => event.event === "telemetry_write_failed"));
  assert.doesNotThrow(() => recovered.heartbeat());
});

test("provider failures are counted without logging input, filename, key, or error message", async (t) => {
  const state = fixture(t);
  const app = createApp({
    apiKey: "private-key", staticDirectory: null, telemetry: state.telemetry,
    generate: async () => {
      throw new AppError(502, "PROVIDER_ERROR", "private provider response");
    },
  });
  await request(app).post("/api/reports").attach("transcript", Buffer.from("private transcript"), "private-name.txt").expect(502);
  assert.equal(state.read().counters.failure, 1);
  const log = JSON.stringify(state.events);
  for (const secret of ["private-key", "private transcript", "private-name", "private provider"]) {
    assert.equal(log.includes(secret), false);
  }
});

test("valid reports count success while invalid input does not count as generation failure", async (t) => {
  const state = fixture(t);
  const app = createApp({
    staticDirectory: null, telemetry: state.telemetry,
    generate: async () => structuredClone(SAMPLE_REPORT),
  });
  await request(app).post("/api/reports").attach("transcript", Buffer.from("Synthetic meeting"), "meeting.txt").expect(200);
  await request(app).post("/api/reports").attach("transcript", Buffer.from(""), "empty.txt").expect(400);
  assert.equal(state.read().counters.success, 1);
  assert.equal(state.read().counters.rejected, 1);
  assert.equal(state.read().counters.failure, 0);
  await request(app).get("/health").expect(200);
  assert.ok(Date.parse(state.read().updatedAt) > 0);
});
