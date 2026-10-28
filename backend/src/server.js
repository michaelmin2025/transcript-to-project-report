import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createApp } from "./app.js";
import { createReportStore } from "./store.js";
import { createTelemetry } from "./telemetry.js";
import { loadAccessControl } from "./auth.js";
import { loadJobConfiguration, startJobSynchronization } from "./job-runtime.js";

const accessControl = loadAccessControl();
const jobConfiguration = loadJobConfiguration();
const development = process.argv.includes("--dev");
const frontendDirectory = process.env.FRONTEND_DIST
  ? path.resolve(process.env.FRONTEND_DIST)
  : fileURLToPath(new URL("../../frontend/dist/", import.meta.url));
const index = path.join(frontendDirectory, "index.html");
const port = Number(process.env.PORT || 8080);
const host = process.env.HOST || "127.0.0.1";
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error("PORT must be an integer from 1 to 65535.");
  process.exitCode = 1;
}
else if (!development && !existsSync(index)) {
  console.error("The frontend has not been built. Run npm run build first.");
  process.exitCode = 1;
}
else {
  const databasePath = process.env.REPORTS_DB_PATH
    ? path.resolve(process.env.REPORTS_DB_PATH)
    : fileURLToPath(new URL("../data/reports.sqlite", import.meta.url));
  const store = createReportStore(databasePath);
  const jobRuntime = jobConfiguration ? startJobSynchronization(store, jobConfiguration) : null;
  const jobTracking = jobConfiguration ? { retentionDays: jobConfiguration.retention_days } : null;
  const telemetry = createTelemetry({ filename: process.env.APP_TELEMETRY_PATH || null });
  const server = createApp({ staticDirectory: development ? null : frontendDirectory, store, telemetry, accessControl, jobTracking }).listen(
    port,
    host,
    () => {
      console.log(`Transcript to Project Report: http://${host}:${port}`);
      if (!process.env.DEEPSEEK_API_KEY?.trim()) {
        console.log("DeepSeek is not configured. Add your API key to .env.");
      }
    },
  );
  server.once("close", async () => {
    await jobRuntime?.stop();
    store.close();
  });
  server.on("error", async (error) => {
    await jobRuntime?.stop();
    store.close();
    console.error(
      error.code === "EADDRINUSE"
        ? `Port ${port} is in use. Choose another PORT in .env.`
        : `Could not start the app (${error.code || "unknown error"}).`,
    );
    process.exitCode = 1;
  });
}
