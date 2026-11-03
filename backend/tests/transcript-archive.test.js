import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { createTranscriptArchive, uploadArchiveKey, reportArchiveKey } from "../src/transcript-archive.js";

const config = { endpoint_url: "http://ministack:4566", region: "us-east-1", bucket: "ministack-lab-assets", upload_prefix: "transcript/uploads/", report_prefix: "transcript/reports/" };
const id = "93dcc979-e13b-44fb-889e-40b202a8cd6f";
const key = uploadArchiveKey(id, "text/plain");
const bytes = Buffer.from("Synthetic meeting transcript.");

const missing = () => Object.assign(new Error("synthetic missing"), { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } });

function fixture() {
  const objects = new Map();
  const calls = [];
  const client = {
    onGet: null, onPut: null,
    async send(command, options) {
      calls.push(command);
      assert.equal(command.input.Bucket, config.bucket);
      assert.ok(options.abortSignal instanceof AbortSignal);
      if (command instanceof GetObjectCommand) {
        if (client.onGet) {
          return client.onGet(command);
        }
        const object = objects.get(command.input.Key);
        if (!object) {
          throw missing();
        }
        return { Body: Readable.from([object.Body]), ContentType: object.ContentType, ContentLength: object.Body.length, Metadata: object.Metadata };
      }
      assert.ok(command instanceof PutObjectCommand);
      if (client.onPut) {
        return client.onPut(command);
      }
      if (objects.has(command.input.Key)) {
        throw Object.assign(new Error("synthetic precondition"), { $metadata: { httpStatusCode: 412 } });
      }
      objects.set(command.input.Key, { ...command.input, Body: Buffer.from(command.input.Body) });
      return {};
    },
  };
  return { archive: createTranscriptArchive(config, { client }), client, calls, objects };
}

test("uploads are conditional, encrypted and verified from the returned bytes", async () => {
  const f = fixture();
  const result = await f.archive.put(key, bytes);
  const command = f.calls.find(value => value instanceof PutObjectCommand);
  assert.equal(command.input.IfNoneMatch, "*");
  assert.equal(command.input.ServerSideEncryption, "AES256");
  assert.equal(command.input.ContentType, "text/plain");
  assert.equal(command.input.Metadata.sha256, result.sha256);
  assert.equal(command.input.ChecksumSHA256, Buffer.from(result.sha256, "hex").toString("base64"));
  assert.equal(result.bytes, bytes.length);
  assert.deepEqual(f.objects.get(key).Body, bytes);
  assert.equal(f.calls.filter(value => value instanceof GetObjectCommand).length, 2);
});

test("identical delivery retries do not issue another PUT", async () => {
  const f = fixture();
  await f.archive.put(key, bytes);
  await f.archive.put(key, bytes);
  assert.equal(f.calls.filter(value => value instanceof PutObjectCommand).length, 1);
});

test("uncertain upload acceptance is recovered by matching stored bytes", async () => {
  const f = fixture();
  f.client.onPut = async (command) => {
    f.objects.set(command.input.Key, { ...command.input, Body: Buffer.from(command.input.Body) });
    throw new Error("synthetic lost acknowledgement");
  };
  assert.equal((await f.archive.put(key, bytes)).bytes, bytes.length);
});

test("different existing contents cannot be overwritten", async () => {
  const f = fixture();
  f.objects.set(key, { Body: Buffer.from("Other content"), ContentType: "text/plain" });
  await assert.rejects(f.archive.put(key, bytes), error => error.code === "ARCHIVE_CONFLICT");
  assert.equal(f.calls.filter(value => value instanceof PutObjectCommand).length, 0);
  assert.equal(f.objects.get(key).Body.toString(), "Other content");
});

test("a conflicting object racing the conditional PUT is detected", async () => {
  const f = fixture();
  f.client.onPut = async (command) => {
    f.objects.set(command.input.Key, { Body: Buffer.from("Conflicting data"), ContentType: "text/plain" });
    throw Object.assign(new Error("synthetic precondition"), { $metadata: { httpStatusCode: 412 } });
  };
  await assert.rejects(f.archive.put(key, bytes), error => error.code === "ARCHIVE_CONFLICT");
});

test("SDK failures expose no private error text and permit retry", async () => {
  const f = fixture();
  f.client.onGet = async () => {
    throw new Error("private SDK URL and response");
  };
  await assert.rejects(f.archive.put(key, bytes), error => error.code === "ARCHIVE_UNAVAILABLE" && !error.message.includes("private"));
  assert.equal(f.calls.filter(value => value instanceof PutObjectCommand).length, 0);
  f.client.onGet = null;
  await f.archive.put(key, bytes);
});

test("a failed PUT with no stored object stays unavailable", async () => {
  const f = fixture();
  f.client.onPut = async () => {
    throw new Error("synthetic outage");
  };
  await assert.rejects(f.archive.put(key, bytes), error => error.code === "ARCHIVE_UNAVAILABLE");
  assert.equal(f.objects.size, 0);
});

test("lying object lengths cannot cause unbounded reads", async () => {
  const f = fixture();
  const body = Readable.from([Buffer.alloc(bytes.length + 1)]);
  f.client.onGet = async () => ({ Body: body, ContentType: "text/plain", ContentLength: bytes.length });
  await assert.rejects(f.archive.put(key, bytes), error => error.code === "ARCHIVE_CONFLICT");
  assert.equal(body.destroyed, true);
});

test("path traversal, unsupported types, empty and oversized payloads are rejected locally", async () => {
  const f = fixture();
  for (const candidate of ["inputs/secret.txt", "transcript/uploads/../secret.txt", "transcript/uploads/name.txt"]) {
    await assert.rejects(f.archive.put(candidate, bytes), error => error.code === "INVALID_ARCHIVE_OBJECT");
  }
  for (const body of [Buffer.alloc(0), Buffer.alloc(1024 * 1024 + 1), "not bytes"]) {
    await assert.rejects(f.archive.put(key, body), error => error.code === "INVALID_ARCHIVE_OBJECT");
  }
  assert.throws(() => uploadArchiveKey(id, "image/png"));
  assert.throws(() => reportArchiveKey(id, 0));
  assert.equal(f.calls.length, 0);
});

test("report edits use distinct version keys and require JSON objects", async () => {
  const f = fixture();
  const first = reportArchiveKey(id, 1);
  const second = reportArchiveKey(id, 2);
  await f.archive.put(first, Buffer.from("{\"version\":1}"));
  await f.archive.put(second, Buffer.from("{\"version\":2}"));
  assert.equal(f.objects.size, 2);
  for (const body of ["broken json", "[]", "null"]) {
    await assert.rejects(f.archive.put(reportArchiveKey(id, 3), Buffer.from(body)), error => error.code === "INVALID_ARCHIVE_OBJECT");
  }
});

test("real endpoints and unintended buckets/prefixes are rejected", () => {
  for (const update of [{ endpoint_url: undefined }, { endpoint_url: "https://s3.amazonaws.com" }, { bucket: "other-bucket" }, { upload_prefix: "inputs/" }, { report_prefix: "results/" }]) {
    assert.throws(() => createTranscriptArchive({ ...config, ...update }));
  }
});

test("the adapter takes its own copy before asynchronous SDK work", async () => {
  const f = fixture();
  const input = Buffer.from(bytes);
  let initial = true;
  f.client.onGet = async () => {
    input.fill(0);
    if (initial) {
      initial = false;
      throw missing();
    }
    const stored = f.objects.get(key);
    return { Body: Readable.from([stored.Body]), ContentType: stored.ContentType, Metadata: stored.Metadata };
  };
  await f.archive.put(key, input);
  assert.deepEqual(f.objects.get(key).Body, bytes);
});
