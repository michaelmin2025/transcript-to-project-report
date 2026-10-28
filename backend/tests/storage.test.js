import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";
import AdmZip from "adm-zip";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { createReportStore } from "../src/store.js";
import { createApp } from "../src/app.js";
import { SAMPLE_REPORT, SAMPLE_TRANSCRIPT } from "./fixtures/report.js";
import { documentText } from "../../shared/document.js";

function original(name = "meeting.txt") {
  return {
    report: structuredClone(SAMPLE_REPORT),
    sourceName: name,
    generatedAt: new Date().toISOString(),
  };
}

function edit(document) {
  const updated = structuredClone(document);
  updated.content.push({
    type: "paragraph",
    content: [
      {
        type: "text",
        text: "Saved edit",
        marks: [{ type: "bold" }, { type: "textStyle", attrs: { fontSize: "18pt" } }],
      },
    ],
  });
  return updated;
}

function binary(response, done) {
  const chunks = [];
  response.on("data", chunk => chunks.push(chunk));
  response.on("end", () => done(null, Buffer.concat(chunks)));
}

test("reports and formatted edits survive closing and reopening SQLite", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "report-storage-test-"));
  const filename = path.join(directory, "reports.sqlite");
  let store;
  try {
    store = createReportStore(filename);
    const first = store.create(original("first.txt"));
    const second = store.create(original("second.txt"));
    const edited = edit(first.document);
    const saved = store.save(first.id, { document: edited, version: first.version });
    store.close();
    store = createReportStore(filename);
    assert.equal(store.list().length, 2);
    assert.equal(store.list()[0].id, first.id);
    assert.deepEqual(store.get(first.id).document, edited);
    assert.deepEqual(store.get(first.id).report, first.report);
    assert.equal(store.get(first.id).version, saved.version);
    assert.equal(store.get(second.id).sourceName, "second.txt");
  }
  finally {
    store?.close();
    unlinkSync(filename);
    rmdirSync(directory);
  }
});

test("generation saves reports; reopening and downloading uses saved edits without AI calls", async (t) => {
  const store = createReportStore(":memory:");
  t.after(() => store.close());
  let generations = 0;
  const app = createApp({
    store,
    apiKey: "test-key",
    staticDirectory: null,
    generate: async () => {
      generations += 1;
      return structuredClone(SAMPLE_REPORT);
    },
  });
  const generated = await request(app)
    .post("/api/reports")
    .attach("transcript", Buffer.from(SAMPLE_TRANSCRIPT), "meeting.txt")
    .expect(200);
  const record = generated.body;
  assert.ok(record.id);
  assert.equal((await request(app).get("/api/config")).body.persistence, true);
  const listing = await request(app).get("/api/reports").expect(200);
  assert.equal(listing.body[0].id, record.id);
  assert.ok(!listing.body[0].document);
  const updated = edit(record.document);
  await request(app)
    .put("/api/reports/" + record.id)
    .send({ document: updated, version: 1 })
    .expect(200);
  const reopened = await request(app)
    .get("/api/reports/" + record.id)
    .expect(200);
  assert.deepEqual(reopened.body.document, updated);
  assert.equal(reopened.body.version, 2);
  for (const format of ["md", "docx", "pdf"]) {
    const response = await request(app)
      .post("/api/reports/export")
      .send({ document: reopened.body.document, format })
      .buffer(true)
      .parse(binary)
      .expect(200);
    if (format === "md") {
      assert.match(response.body.toString(), /Saved edit/);
    }
    else if (format === "docx") {
      const xml = new AdmZip(response.body).readAsText("word/document.xml");
      assert.match(xml, /Saved edit/);
      assert.match(xml, /w:sz w:val="36"/);
    }
    else {
      const loading = getDocument({ data: new Uint8Array(response.body), useSystemFonts: false });
      const pdf = await loading.promise;
      let text = "";
      for (let page = 1; page <= pdf.numPages; page += 1) {
        text += (await (await pdf.getPage(page)).getTextContent()).items
          .map(item => item.str)
          .join(" ");
      }
      assert.match(text, /Saved edit/);
      await loading.destroy();
    }
  }
  assert.equal(generations, 1);
});

test("invalid and conflicting saves cannot overwrite a saved document", async (t) => {
  const store = createReportStore(":memory:");
  t.after(() => store.close());
  const record = store.create(original());
  const app = createApp({ store, staticDirectory: null });
  await request(app)
    .put("/api/reports/" + record.id)
    .send({ document: { type: "doc", content: [] }, version: 1 })
    .expect(400);
  const document = edit(record.document);
  await request(app)
    .put("/api/reports/" + record.id)
    .send({ document, version: 1 })
    .expect(200);
  const stale = await request(app)
    .put("/api/reports/" + record.id)
    .send({ document: record.document, version: 1 })
    .expect(409);
  assert.equal(stale.body.error.code, "REPORT_CONFLICT");
  assert.deepEqual(store.get(record.id).document, document);
  await request(app).get("/api/reports/unknown").expect(404);
  await request(app).get("/api/reports/' OR 1=1 --").expect(404);
});

test("a failed storage operation reports failure instead of claiming a successful save", async () => {
  const store = createReportStore(":memory:");
  const record = store.create(original());
  store.close();
  const app = createApp({ store, staticDirectory: null });
  const failed = await request(app)
    .put("/api/reports/" + record.id)
    .send({ document: edit(record.document), version: 1 })
    .expect(503);
  assert.equal(failed.body.error.code, "STORAGE_UNAVAILABLE");
  assert.ok(!JSON.stringify(failed.body).includes("Saved edit"));
  assert.ok(documentText(record.document).includes(SAMPLE_REPORT.title));
});

test("deleting one report persists across restart and keeps its upload and other reports", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "report-deletion-test-"));
  const filename = path.join(directory, "reports.sqlite");
  let store;
  try {
    store = createReportStore(filename);
    const bytes = Buffer.from(SAMPLE_TRANSCRIPT);
    const upload = store.saveUpload({ originalname: "meeting.txt", buffer: bytes });
    const first = store.create(original(), upload.id);
    const other = store.create(original(), upload.id);
    const app = createApp({
      store,
      apiKey: "test",
      staticDirectory: null,
      generate: async () => structuredClone(SAMPLE_REPORT),
    });
    const deleted = await request(app)
      .delete("/api/reports/" + first.id)
      .expect(200);
    assert.equal(deleted.body.deleted, true);
    await request(app)
      .get("/api/reports/" + first.id)
      .expect(404);
    await request(app)
      .delete("/api/reports/" + first.id)
      .expect(404);
    assert.deepEqual(store.get(other.id).document, other.document);
    assert.deepEqual(store.getUpload(upload.id).buffer, bytes);
    const regenerated = await request(app)
      .post("/api/uploads/" + upload.id + "/reports")
      .expect(200);
    assert.equal(regenerated.body.uploadId, upload.id);
    store.close();
    store = createReportStore(filename);
    assert.equal(store.list().length, 2);
    assert.throws(() => store.get(first.id), { code: "REPORT_NOT_FOUND" });
    assert.deepEqual(store.get(other.id).document, other.document);
    assert.deepEqual(store.getUpload(upload.id).buffer, bytes);
  }
  finally {
    store?.close();
    unlinkSync(filename);
    rmdirSync(directory);
  }
});
