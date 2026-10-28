import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

const OUTCOMES = ["success", "failure", "cancelled", "rejected"];

export function createTelemetry({ filename = null, log = console.log } = {}) {
  if (!filename) {
    return { recordGeneration() {}, heartbeat() {} };
  }
  const counters = Object.fromEntries(OUTCOMES.map(outcome => [outcome, 0]));
  const target = path.resolve(filename);
  let writeFailed = false;

  function emit(event) {
    try {
      log(JSON.stringify(event));
    }
    catch {
      // Monitoring must not fail a report request.
    }
  }

  try {
    const saved = JSON.parse(readFileSync(target, "utf8"));
    if (saved.schemaVersion !== 1 || !OUTCOMES.every(name =>
      Number.isSafeInteger(saved.counters?.[name]) && saved.counters[name] >= 0,
    )) {
      throw new Error("Invalid telemetry snapshot");
    }
    for (const name of OUTCOMES) {
      counters[name] = saved.counters[name];
    }
  }
  catch (error) {
    if (error.code !== "ENOENT") {
      emit({ event: "telemetry_counter_reset" });
    }
  }

  function heartbeat() {
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(temporary, JSON.stringify({
        schemaVersion: 1,
        updatedAt: new Date().toISOString(),
        counters,
      }), { mode: 0o600, flag: "wx" });
      renameSync(temporary, target);
      writeFailed = false;
    }
    catch {
      try {
        unlinkSync(temporary);
      }
      catch {
        // Nothing to clean up if creating the temporary snapshot failed.
      }
      if (!writeFailed) {
        emit({ event: "telemetry_write_failed" });
      }
      writeFailed = true;
    }
  }

  function recordGeneration(outcome) {
    if (!OUTCOMES.includes(outcome)) {
      return;
    }
    if (counters[outcome] < Number.MAX_SAFE_INTEGER) {
      counters[outcome] += 1;
    }
    heartbeat();
    emit({ event: "report_generation", outcome });
  }

  heartbeat();
  return { recordGeneration, heartbeat };
}
