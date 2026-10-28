import assert from "node:assert/strict";
import { scryptSync } from "node:crypto";
import test from "node:test";
import { spawnSync } from "node:child_process";
import request from "supertest";
import { createApp } from "../src/app.js";
import { loadAccessControl } from "../src/auth.js";

const origin = "http://private.example:4567";
const username = "test-owner";
const password = "synthetic-password-for-tests";
const salt = Buffer.alloc(16, 7);
const hash = `${salt.toString("hex")}:${scryptSync(password, salt, 64).toString("hex")}`;
const environment = { APP_AUTH_USERNAME: username, APP_AUTH_PASSWORD_HASH: hash, APP_AUTH_ORIGIN: origin };

const credentials = (user = username, secret = password) => `Basic ${Buffer.from(`${user}:${secret}`).toString("base64")}`;

function application() {
  return createApp({
    apiKey: "",
    staticDirectory: null,
    accessControl: loadAccessControl(environment),
    store: { list: () => [], listUploads: () => [] },
  });
}

test("production authentication configuration fails closed", () => {
  for (const invalid of [
    {},
    { ...environment, APP_AUTH_USERNAME: "bad:user" },
    { ...environment, APP_AUTH_PASSWORD_HASH: "plaintext" },
    { ...environment, APP_AUTH_ORIGIN: "https://private.example/path" },
    { ...environment, APP_AUTH_ORIGIN: "null" },
    { ...environment, APP_AUTH_ORIGIN: "file:///tmp" },
  ]) {
    assert.throws(() => loadAccessControl(invalid));
  }
});

test("health GET and HEAD stay public for monitoring", async () => {
  const app = application();
  await request(app).get("/health").expect(200, { status: "ok" });
  await request(app).head("/health").expect(200);
  await request(app).post("/health").set("Origin", origin).expect(401);
});

test("anonymous UI, assets, lists, downloads and exports are protected", async () => {
  const app = application();
  for (const path of ["/", "/index.html", "/assets/app.js", "/api/config", "/api/reports", "/api/reports/test", "/api/uploads", "/api/uploads/test/file"]) {
    const result = await request(app).get(path).expect(401);
    assert.match(result.headers["www-authenticate"], /^Basic /);
    assert.equal(result.headers["cache-control"], "no-store");
    assert.equal(result.text.includes(password), false);
  }
  for (const path of ["/api/reports", "/api/reports/export", "/api/uploads/test/reports"]) {
    await request(app).post(path).set("Origin", origin).expect(401);
  }
  await request(app).put("/api/reports/test").set("Origin", origin).send({}).expect(401);
  await request(app).delete("/api/reports/test").set("Origin", origin).expect(401);
});

test("wrong credentials and malformed headers do not authorize", async () => {
  const app = application();
  for (const header of [credentials(username, "wrong"), credentials("wrong"), "Bearer token", "Basic !!!", "Basic YQ==", "Basic /w=="]) {
    await request(app).get("/api/reports").set("Authorization", header).expect(401);
  }
});

test("valid owner can read persisted lists and configuration", async () => {
  const app = application();
  await request(app).get("/api/reports").set("Authorization", credentials()).expect(200, []);
  await request(app).get("/api/uploads").set("Authorization", credentials()).expect(200, []);
  const response = await request(app).get("/api/config").set("Authorization", credentials()).expect(200);
  assert.equal(response.body.configured, false);
  assert.equal(response.body.persistence, true);
});

test("authenticated requests cannot mutate from a foreign or missing origin", async () => {
  const app = application();
  for (const path of ["/api/reports", "/api/uploads/test/reports", "/api/reports/export"]) {
    await request(app).post(path).set("Authorization", credentials()).expect(403);
    await request(app).post(path).set("Authorization", credentials()).set("Origin", "http://attacker.example").expect(403);
  }
  await request(app).delete("/api/reports/test").set("Authorization", credentials()).expect(403);
  await request(app).get("/api/reports").set("Authorization", credentials()).set("Sec-Fetch-Site", "cross-site").expect(403);
  await request(app).get("/api/reports").set("Authorization", credentials()).set("Origin", "null").expect(403);
});

test("same-origin authenticated writes reach input validation", async () => {
  await request(application()).post("/api/reports/export")
    .set("Origin", origin).set("Authorization", credentials()).send({}).expect(400);
});

test("failed guesses are throttled without blocking health probes", async () => {
  const app = application();
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await request(app).get("/api/reports").set("Authorization", "Bearer invalid").expect(401);
  }
  const response = await request(app).get("/api/reports").set("Authorization", credentials()).expect(429);
  assert.equal(response.headers["retry-after"], "60");
  await request(app).get("/health").expect(200);
});

test("accepted browser credentials support parallel asset and API requests", async () => {
  const app = application();
  await request(app).get("/api/reports").set("Authorization", credentials()).expect(200);
  await Promise.all(Array.from({ length: 12 }, () =>
    request(app).get("/api/reports").set("Authorization", credentials()).expect(200)));
});

test("the actual server refuses to start without owner credentials", () => {
  const result = spawnSync(process.execPath, ["backend/src/server.js"], {
    encoding: "utf8",
    timeout: 20_000,
    env: { ...process.env, APP_AUTH_USERNAME: "", APP_AUTH_PASSWORD_HASH: "", APP_AUTH_ORIGIN: "" },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Single-user authentication is missing or invalid/);
});
