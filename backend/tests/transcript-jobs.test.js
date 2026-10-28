import assert from "node:assert/strict";
import test from "node:test";
import { GetItemCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { createTranscriptJobs } from "../src/transcript-jobs.js";

const config = { endpoint_url: "http://ministack:4566", region: "us-east-1", table: "ministack-lab-transcript-jobs" };
const initial = {
  job_id: "50bb02a4-d062-4cc2-9abd-cfc0f878e535", workflow: "transcript-report", schema_version: 1,
  revision: 1, status: "PROCESSING", created_at: 100, updated_at: 100, expires_at: 500,
};
const completed = { ...initial, status: "COMPLETED", revision: 2, updated_at: 110, report_id: "461ee80a-2cc2-4fb5-b1e7-d2da8e361bda" };

function fixture() {
  let stored = null;
  const commands = [];
  const client = {
    async send(command) {
      commands.push(command);
      assert.equal(command.input.TableName, config.table);
      if (command instanceof GetItemCommand) {
        return stored ? { Item: structuredClone(stored) } : {};
      }
      assert.ok(command instanceof PutItemCommand);
      const next = command.input.Item;
      // Model the conditional write so ordering/retries are tested independently.
      const advance = stored && stored.workflow.S === next.workflow.S && stored.created_at.N === next.created_at.N
        && stored.expires_at.N === next.expires_at.N && stored.status.S === "PROCESSING"
        && Number(stored.revision.N) < Number(next.revision.N);
      if (stored && !advance) {
        throw Object.assign(new Error("synthetic conditional conflict"), { name: "ConditionalCheckFailedException" });
      }
      stored = structuredClone(next);
      return {};
    },
  };
  return { store: createTranscriptJobs(config, { client, now: () => 120 }), commands, client };
}

test("configuration rejects real endpoints and the unrelated legacy table", () => {
  for (const update of [{ endpoint_url: undefined }, { endpoint_url: "https://dynamodb.us-east-1.amazonaws.com" }, { table: "ministack-lab-jobs" }, { region: "us-west-2" }]) {
    assert.throws(() => createTranscriptJobs({ ...config, ...update }));
  }
});

test("processing advances to completed and round-trips through typed DynamoDB fields", async () => {
  const { store, commands } = fixture();
  await store.write(initial);
  await store.write(completed);
  assert.deepEqual(await store.get(initial.job_id), completed);
  assert.match(commands[0].input.ConditionExpression, /attribute_not_exists/);
  assert.match(commands[0].input.ConditionExpression, /#status = :processing/);
  assert.equal(commands.at(-1).input.ConsistentRead, true);
});

test("identical retries are accepted without rewriting stored state", async () => {
  const { store } = fixture();
  await store.write(initial);
  assert.deepEqual(await store.write(initial), initial);
  await store.write(completed);
  assert.deepEqual(await store.write(completed), completed);
});

test("terminal-first replay is allowed but stale processing and conflicting terminals fail", async () => {
  const { store } = fixture();
  await store.write(completed);
  await assert.rejects(store.write(initial), error => error.code === "JOB_STATE_CONFLICT");
  await assert.rejects(store.write({ ...initial, revision: 2, updated_at: 110, status: "FAILED", error_code: "GENERATION_FAILED" }), error => error.code === "JOB_STATE_CONFLICT");
  assert.deepEqual(await store.get(initial.job_id), completed);
});

test("expired metadata cannot be written or read as active", async () => {
  const { store } = fixture();
  await assert.rejects(store.write({ ...initial, expires_at: 119 }), error => error.code === "JOB_EXPIRED");
  assert.equal(await store.get(initial.job_id), null);
});

test("malformed status, identifiers and private content fields are rejected before SDK calls", async () => {
  const { store, commands } = fixture();
  for (const update of [{ status: "COMPLETED" }, { revision: 2 }, { transcript: "private content" }, { job_id: "invalid" }, { updated_at: 99 }, { status: "FAILED", revision: 2 }, { status: "PROCESSING", error_code: "GENERATION_FAILED" }]) {
    await assert.rejects(store.write({ ...initial, ...update }), error => error.code === "INVALID_JOB_METADATA");
  }
  assert.equal(commands.length, 0);
});

test("transport failure exposes no SDK details and leaves a retry possible", async () => {
  const { store, client } = fixture();
  const original = client.send;
  client.send = async () => {
    throw new Error("private SDK details");
  };
  await assert.rejects(store.write(initial), error => error.code === "JOB_STORAGE_UNAVAILABLE" && !error.message.includes("private"));
  await assert.rejects(store.get(initial.job_id), error => error.code === "JOB_STORAGE_UNAVAILABLE");
  client.send = original;
  assert.deepEqual(await store.write(initial), initial);
});

test("invalid stored values are reported as unavailable without leaking them", async () => {
  const client = { send: async () => ({ Item: { job_id: { S: "private corrupted value" } } }) };
  const store = createTranscriptJobs(config, { client, now: () => 120 });
  await assert.rejects(store.get(initial.job_id), error => error.code === "JOB_STORAGE_UNAVAILABLE" && !error.message.includes("private"));
});
