import { DynamoDBClient, GetItemCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { z } from "zod";
import { AppError } from "./errors.js";

const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const identifier = z.string().uuid();
const recordSchema = z.object({
  job_id: identifier,
  workflow: z.literal("transcript-report"),
  schema_version: z.literal(1),
  revision: z.union([z.literal(1), z.literal(2)]),
  status: z.enum(["PROCESSING", "COMPLETED", "FAILED", "CANCELLED"]),
  created_at: integer,
  updated_at: integer,
  expires_at: integer,
  upload_id: identifier.optional(),
  report_id: identifier.optional(),
  error_code: z.enum(["GENERATION_FAILED", "STORAGE_UNAVAILABLE", "CANCELLED"]).optional(),
}).strict().refine(value => value.updated_at >= value.created_at && value.expires_at > value.updated_at)
  .refine(value => value.status === "PROCESSING" ? value.revision === 1 : value.revision === 2)
  .refine(value => value.status === "COMPLETED" ? Boolean(value.report_id) && !value.error_code : !value.report_id)
  .refine(value => value.status === "FAILED" ? Boolean(value.error_code) && value.error_code !== "CANCELLED" : true)
  .refine(value => value.status === "CANCELLED" ? value.error_code === "CANCELLED" : value.status !== "PROCESSING" || !value.error_code);

function unavailable() {
  return new AppError(503, "JOB_STORAGE_UNAVAILABLE", "Job status storage is unavailable. Please try again later.");
}

function parseRecord(value) {
  const parsed = recordSchema.safeParse(value);
  if (!parsed.success) {
    throw new AppError(400, "INVALID_JOB_METADATA", "Job metadata is invalid.");
  }
  return parsed.data;
}

function validateConfig(config) {
  if (!config || !["http://ministack:4566", "http://100.64.73.87:4566"].includes(config.endpoint_url)
    || config.region !== "us-east-1" || config.table !== "ministack-lab-transcript-jobs") {
    throw new Error("An explicit transcript-job MiniStack endpoint, region and table are required.");
  }
}

export function createTranscriptJobs(config, { client = null, now = () => Math.floor(Date.now() / 1000) } = {}) {
  validateConfig(config);
  const owned = !client;
  const database = client || new DynamoDBClient({
    endpoint: config.endpoint_url,
    region: config.region,
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
    maxAttempts: 2,
  });

  async function send(command) {
    return database.send(command, { abortSignal: AbortSignal.timeout(5000) });
  }

  async function get(jobId) {
    if (!identifier.safeParse(jobId).success) {
      throw new AppError(400, "INVALID_JOB_ID", "Job identifier is invalid.");
    }
    try {
      const response = await send(new GetItemCommand({
        TableName: config.table, Key: { job_id: { S: jobId } }, ConsistentRead: true,
      }));
      if (!response.Item) {
        return null;
      }
      const decoded = Object.fromEntries(Object.entries(response.Item).map(([key, value]) => {
        if (Object.keys(value).length !== 1 || !("S" in value || "N" in value)) {
          throw unavailable();
        }
        return [key, "S" in value ? value.S : Number(value.N)];
      }));
      const record = parseRecord(decoded);
      if (record.job_id !== jobId) {
        throw unavailable();
      }
      return record.expires_at <= now() ? null : record;
    }
    catch {
      // SDK messages and stored values may contain private data; never expose them.
      throw unavailable();
    }
  }

  async function write(value) {
    const record = parseRecord(value);
    if (record.expires_at <= now()) {
      throw new AppError(410, "JOB_EXPIRED", "Job metadata has expired.");
    }
    const item = Object.fromEntries(Object.entries(record).map(([key, field]) =>
      [key, typeof field === "number" ? { N: String(field) } : { S: field }]));
    try {
      await send(new PutItemCommand({
        TableName: config.table,
        Item: item,
        // A terminal snapshot may arrive first when replaying a durable outbox.
        // Existing records only advance from PROCESSING to a newer revision.
        ConditionExpression: "attribute_not_exists(#id) OR (#workflow = :workflow AND #created = :created AND #expires = :expires AND #status = :processing AND #revision < :revision)",
        ExpressionAttributeNames: {
          "#id": "job_id", "#workflow": "workflow", "#created": "created_at",
          "#expires": "expires_at", "#status": "status", "#revision": "revision",
        },
        ExpressionAttributeValues: {
          ":workflow": { S: record.workflow }, ":created": { N: String(record.created_at) },
          ":expires": { N: String(record.expires_at) }, ":processing": { S: "PROCESSING" },
          ":revision": { N: String(record.revision) },
        },
      }));
      return record;
    }
    catch (error) {
      if (error.name !== "ConditionalCheckFailedException") {
        throw unavailable();
      }
    }
    const existing = await get(record.job_id);
    if (JSON.stringify(existing) === JSON.stringify(record)) {
      return existing;
    }
    throw new AppError(409, "JOB_STATE_CONFLICT", "Job status has already changed.");
  }

  return {
    get,
    write,
    close() {
      if (owned) {
        database.destroy();
      }
    },
  };
}
