import { createHash } from "node:crypto";
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { z } from "zod";
import { AppError } from "./errors.js";

const identifier = z.string().uuid();
const maxUpload = 1024 * 1024;
const maxReport = 4 * 1024 * 1024;

function invalid() {
  return new AppError(400, "INVALID_ARCHIVE_OBJECT", "Archive identifier, type or content is invalid.");
}

function unavailable() {
  return new AppError(503, "ARCHIVE_UNAVAILABLE", "Archive storage is unavailable. The local copy is preserved.");
}

function conflict() {
  return new AppError(409, "ARCHIVE_CONFLICT", "The archive key already contains different content.");
}

export function uploadArchiveKey(id, mime) {
  if (!identifier.safeParse(id).success || !["text/plain", "application/pdf"].includes(mime)) {
    throw invalid();
  }
  return `transcript/uploads/${id}.${mime === "application/pdf" ? "pdf" : "txt"}`;
}

export function reportArchiveKey(id, version) {
  if (!identifier.safeParse(id).success || !Number.isSafeInteger(version) || version < 1) {
    throw invalid();
  }
  return `transcript/reports/${id}/v${version}.json`;
}

function objectType(key) {
  if (typeof key !== "string") {
    throw invalid();
  }
  const upload = /^transcript\/uploads\/([^/]+)\.(txt|pdf)$/.exec(key);
  if (upload && identifier.safeParse(upload[1]).success) {
    return { contentType: upload[2] === "pdf" ? "application/pdf" : "text/plain", limit: maxUpload };
  }
  const report = /^transcript\/reports\/([^/]+)\/v([1-9][0-9]*)\.json$/.exec(key);
  if (report && identifier.safeParse(report[1]).success && Number.isSafeInteger(Number(report[2]))) {
    return { contentType: "application/json", limit: maxReport };
  }
  throw invalid();
}

async function readBounded(body, limit) {
  let timer;
  try {
    if (!body?.[Symbol.asyncIterator]) {
      throw unavailable();
    }

    const read = async () => {
      const chunks = [];
      let size = 0;
      for await (const chunk of body) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > limit) {
          throw conflict();
        }
        chunks.push(bytes);
      }
      return Buffer.concat(chunks, size);
    };

    return await Promise.race([
      read(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(unavailable()), 5000);
      }),
    ]);
  }
  finally {
    clearTimeout(timer);
    body?.destroy?.();
  }
}

export function createTranscriptArchive(config, { client = null } = {}) {
  if (!config || !["http://ministack:4566", "http://100.64.73.87:4566"].includes(config.endpoint_url)
    || config.region !== "us-east-1" || config.bucket !== "ministack-lab-assets"
    || config.upload_prefix !== "transcript/uploads/" || config.report_prefix !== "transcript/reports/") {
    throw new Error("An explicit supported transcript archive MiniStack configuration is required.");
  }
  const bucket = config.bucket;
  const owned = !client;
  const storage = client || new S3Client({
    endpoint: config.endpoint_url,
    region: config.region,
    forcePathStyle: true,
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
    maxAttempts: 2,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });

  async function verify(key, expected, contentType, digest) {
    let response;
    try {
      response = await storage.send(new GetObjectCommand({ Bucket: bucket, Key: key }), {
        abortSignal: AbortSignal.timeout(5000),
      });
    }
    catch (error) {
      if (error?.$metadata?.httpStatusCode === 404 || ["NoSuchKey", "NotFound"].includes(error?.name)) {
        return false;
      }
      throw unavailable();
    }
    try {
      if (response.ContentType !== contentType
        || (response.ContentLength !== undefined && response.ContentLength !== expected.length)
        || (response.Metadata?.sha256 && response.Metadata.sha256 !== digest)) {
        throw conflict();
      }
      const bytes = await readBounded(response.Body, expected.length);
      if (!bytes.equals(expected)) {
        throw conflict();
      }
      return true;
    }
    catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw unavailable();
    }
    finally {
      response.Body?.destroy?.();
    }
  }

  async function put(key, body) {
    const { contentType, limit } = objectType(key);
    if (!Buffer.isBuffer(body) || body.length < 1 || body.length > limit) {
      throw invalid();
    }
    // Own the buffer: callers cannot mutate bytes while an asynchronous write runs.
    const bytes = Buffer.from(body);
    if (contentType === "application/json") {
      try {
        const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw invalid();
        }
      }
      catch {
        throw invalid();
      }
    }
    const hash = createHash("sha256").update(bytes);
    const digest = hash.digest("hex");
    const receipt = { key, bytes: bytes.length, sha256: digest };
    if (await verify(key, bytes, contentType, digest)) {
      return receipt;
    }
    try {
      await storage.send(new PutObjectCommand({
        Bucket: bucket, Key: key, Body: bytes, ContentType: contentType,
        ContentLength: bytes.length, ServerSideEncryption: "AES256", IfNoneMatch: "*",
        Metadata: { sha256: digest },
        ChecksumSHA256: Buffer.from(digest, "hex").toString("base64"),
      }), { abortSignal: AbortSignal.timeout(5000) });
    }
    catch {
      // Includes conditional conflicts and uncertain acceptance after a timeout.
      // Read back the object; only identical bytes count as successful delivery.
      if (await verify(key, bytes, contentType, digest)) {
        return receipt;
      }
      throw unavailable();
    }
    if (!await verify(key, bytes, contentType, digest)) {
      throw unavailable();
    }
    return receipt;
  }

  return {
    put,
    close() {
      if (owned) {
        storage.destroy();
      }
    },
  };
}
