import { createHash, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const derive = promisify(scrypt);

export function loadAccessControl(environment = process.env) {
  const username = environment.APP_AUTH_USERNAME;
  const encoded = environment.APP_AUTH_PASSWORD_HASH;
  const origin = environment.APP_AUTH_ORIGIN;
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(username || "")
    || !/^[a-f0-9]{32}:[a-f0-9]{128}$/.test(encoded || "")) {
    throw new Error("Single-user authentication is missing or invalid; configure private runtime settings.");
  }
  let parsed;
  try {
    parsed = new URL(origin);
  }
  catch {
    throw new Error("APP_AUTH_ORIGIN must be an explicit HTTP(S) origin.");
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin !== origin) {
    throw new Error("APP_AUTH_ORIGIN must be an explicit HTTP(S) origin without a path.");
  }
  const [salt, expected] = encoded.split(":").map(part => Buffer.from(part, "hex"));
  const expectedUser = createHash("sha256").update(username).digest();
  return createAccessControl({ expectedUser, salt, expected, origin });
}

function createAccessControl({ expectedUser, salt, expected, origin }) {
  let windowStart = 0;
  let attempts = 0;
  let active = 0;
  let accepted = null;
  let acceptedUntil = 0;
  const maximumAttempts = 30;
  return async function accessControl(request, response, next) {
    response.set("Cache-Control", "no-store");
    if (["GET", "HEAD"].includes(request.method) && request.path === "/health") {
      next();
      return;
    }
    // Check before authentication so browsers cannot use cached credentials cross-site.
    if (request.get("Sec-Fetch-Site") === "cross-site"
      || (request.get("Origin") && request.get("Origin") !== origin)
      || (!["GET", "HEAD", "OPTIONS"].includes(request.method) && request.get("Origin") !== origin)) {
      response.status(403).json({ error: { code: "ORIGIN_DENIED", message: "Request origin is not allowed." } });
      return;
    }

    const challenge = () => response
      .set("WWW-Authenticate", "Basic realm=\"Private transcript app\", charset=\"UTF-8\"")
      .status(401).json({ error: { code: "AUTH_REQUIRED", message: "Sign in to access this app." } });

    const header = request.get("Authorization") || "";
    if (!header) {
      challenge();
      return;
    }
    const now = Date.now();
    const fingerprint = createHash("sha256").update(header).digest();
    if (accepted && now < acceptedUntil && timingSafeEqual(fingerprint, accepted)) {
      acceptedUntil = now + 300_000;
      next();
      return;
    }
    if (now - windowStart >= 60_000) {
      windowStart = now;
      attempts = 0;
    }
    if (attempts >= maximumAttempts || active >= 2) {
      response.set("Retry-After", "60").status(429)
        .json({ error: { code: "AUTH_THROTTLED", message: "Wait a minute before trying again." } });
      return;
    }
    // Reserve an attempt before asynchronous password work to bound concurrent guessing.
    attempts += 1;
    const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(header);
    if (!match || header.length > 1200) {
      challenge();
      return;
    }
    let credentials;
    try {
      const bytes = Buffer.from(match[1], "base64");
      if (bytes.toString("base64") !== match[1]) {
        throw new Error("Invalid encoding");
      }
      credentials = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    }
    catch {
      challenge();
      return;
    }
    const separator = credentials.indexOf(":");
    const username = credentials.slice(0, separator);
    const password = credentials.slice(separator + 1);
    if (separator < 1 || username.length > 64 || Buffer.byteLength(password) > 512) {
      challenge();
      return;
    }
    active += 1;
    try {
      const candidate = await derive(password, salt, 64, { N: 16384, r: 8, p: 1 });
      const user = createHash("sha256").update(username).digest();
      const userMatches = timingSafeEqual(user, expectedUser);
      const passwordMatches = timingSafeEqual(candidate, expected);
      if (!userMatches || !passwordMatches) {
        challenge();
        return;
      }
      accepted = fingerprint;
      acceptedUntil = Date.now() + 300_000;
      // Successful requests do not exhaust the failed-attempt allowance.
      attempts = Math.max(0, attempts - 1);
      next();
    }
    catch {
      response.status(503).json({ error: { code: "AUTH_UNAVAILABLE", message: "Sign-in is temporarily unavailable." } });
    }
    finally {
      active -= 1;
    }
  };
}
