import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import PDFDocument from "pdfkit";
import request from "supertest";
import { createApp } from "../src/app.js";
import { createReportStore } from "../src/store.js";
import { AppError } from "../src/errors.js";
import { SAMPLE_REPORT, SAMPLE_TRANSCRIPT } from "./fixtures/report.js";
import { reportToDocument } from "../../shared/document.js";

function pdfFile() {
  return new Promise((resolve) => {
    const pdf = new PDFDocument();
    const chunks = [];
    pdf.on("data", chunk => chunks.push(chunk));
    pdf.on("end", () => resolve(Buffer.concat(chunks)));
    pdf.text("Maya: The customer portal project includes invoice viewing and receipt downloads.");
    pdf.end();
  });
}

function binary(response, done) {
  const chunks = [];
  response.on("data", chunk => chunks.push(chunk));
  response.on("end", () => done(null, Buffer.concat(chunks)));
}

test("PDF uploads retain exact bytes and regeneration creates separate linked reports", async (t) => {
  const store = createReportStore(":memory:");
  t.after(() => store.close());
  let generations = 0;
  const app = createApp({
    store,
    apiKey: "test",
    staticDirectory: null,
    generate: async (transcript) => {
      assert.match(transcript, /Maya: The customer portal project/);
      const report = structuredClone(SAMPLE_REPORT);
      report.title = "Generated report " + ++generations;
      return report;
    },
  });
  const bytes = await pdfFile();
  const first = (
    await request(app).post("/api/reports").attach("transcript", bytes, "interview.pdf").expect(200)
  ).body;
  const uploads = (await request(app).get("/api/uploads").expect(200)).body;
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].id, first.uploadId);
  assert.equal(uploads[0].size, bytes.length);
  assert.ok(!uploads[0].buffer);
  const download = await request(app)
    .get("/api/uploads/" + first.uploadId + "/file")
    .buffer(true)
    .parse(binary)
    .expect(200);
  assert.deepEqual(download.body, bytes);
  assert.match(download.headers["content-type"], /application\/pdf/);
  assert.match(download.headers["content-disposition"], /interview.pdf/);
  const edited = structuredClone(first.document);
  edited.content.push({
    type: "paragraph",
    content: [{ type: "text", text: "Keep this earlier edit" }],
  });
  await request(app)
    .put("/api/reports/" + first.id)
    .send({ document: edited, version: 1 })
    .expect(200);
  for (let count = 0; count < 2; count += 1) {
    const regenerated = (
      await request(app)
        .post("/api/uploads/" + first.uploadId + "/reports")
        .expect(200)
    ).body;
    assert.notEqual(regenerated.id, first.id);
    assert.equal(regenerated.uploadId, first.uploadId);
    assert.equal(regenerated.sourceName, "interview.pdf");
  }
  assert.equal(store.listUploads().length, 1);
  assert.equal(store.list().length, 3);
  assert.equal(generations, 3);
  assert.deepEqual(store.get(first.id).document, edited);
});

test("existing report databases migrate safely and uploaded bytes survive reopening", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "upload-storage-test-"));
  const filename = path.join(directory, "reports.sqlite");
  const id = "f03c80f3-3fc4-4149-b1f0-3176dccf0287";
  const original = {
    report: structuredClone(SAMPLE_REPORT),
    sourceName: "legacy.txt",
    generatedAt: new Date().toISOString(),
  };
  const document = reportToDocument(original);
  let database;
  let store;
  try {
    database = new DatabaseSync(filename);
    database.exec(
      "CREATE TABLE reports (id TEXT PRIMARY KEY, title TEXT NOT NULL, source_name TEXT NOT NULL, generated_at TEXT NOT NULL, updated_at TEXT NOT NULL, version INTEGER NOT NULL, report_json TEXT NOT NULL, document_json TEXT NOT NULL) STRICT",
    );
    database
      .prepare("INSERT INTO reports VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        id,
        original.report.title,
        original.sourceName,
        original.generatedAt,
        original.generatedAt,
        1,
        JSON.stringify(original.report),
        JSON.stringify(document),
      );
    database.close();
    database = null;
    store = createReportStore(filename);
    assert.deepEqual(store.get(id).document, document);
    assert.equal(store.get(id).uploadId, null);
    const bytes = Buffer.from(SAMPLE_TRANSCRIPT.replaceAll("\n", "\r\n"));
    const upload = store.saveUpload({ originalname: "meeting.txt", buffer: bytes });
    store.close();
    store = createReportStore(filename);
    assert.deepEqual(store.getUpload(upload.id).buffer, bytes);
    assert.equal(store.getUpload(upload.id).mime, "text/plain");
    assert.equal(store.list().length, 1);
    assert.equal(store.listUploads().length, 1);
  }
  finally {
    database?.close();
    store?.close();
    unlinkSync(filename);
    rmdirSync(directory);
  }
});

test("valid uploads survive provider failure and can generate later; invalid files are never retained", async (t) => {
  const store = createReportStore(":memory:");
  t.after(() => store.close());
  let failing = true;
  const app = createApp({
    store,
    apiKey: "test",
    staticDirectory: null,
    generate: async () => {
      if (failing) {
        throw new AppError(503, "PROVIDER_BUSY", "DeepSeek is busy.");
      }
      return structuredClone(SAMPLE_REPORT);
    },
  });
  await request(app)
    .post("/api/reports")
    .attach("transcript", Buffer.from("corrupt"), "bad.pdf")
    .expect(400);
  await request(app)
    .post("/api/reports")
    .attach("transcript", Buffer.alloc(1048577), "large.txt")
    .expect(413);
  assert.equal(store.listUploads().length, 0);
  const bytes = Buffer.from(SAMPLE_TRANSCRIPT);
  await request(app).post("/api/reports").attach("transcript", bytes, "retry.txt").expect(503);
  assert.equal(store.list().length, 0);
  const upload = store.listUploads()[0];
  const download = await request(app)
    .get("/api/uploads/" + upload.id + "/file")
    .buffer(true)
    .parse(binary)
    .expect(200);
  assert.deepEqual(download.body, bytes);
  failing = false;
  const generated = (
    await request(app)
      .post("/api/uploads/" + upload.id + "/reports")
      .expect(200)
  ).body;
  assert.equal(generated.uploadId, upload.id);
  assert.equal(store.listUploads().length, 1);
  assert.equal(store.list().length, 1);
});

test("unknown uploads fail before any provider request", async (t) => {
  const store = createReportStore(":memory:");
  t.after(() => store.close());
  let calls = 0;
  const app = createApp({
    store,
    staticDirectory: null,
    generate: async () => {
      calls += 1;
      return structuredClone(SAMPLE_REPORT);
    },
  });
  await request(app).get("/api/uploads/missing/file").expect(404);
  await request(app).post("/api/uploads/missing/reports").expect(404);
  assert.equal(calls, 0);
});
