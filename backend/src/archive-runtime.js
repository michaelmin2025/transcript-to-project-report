import { createTranscriptArchive } from "./transcript-archive.js";
import { createArchiveSync } from "./archive-sync.js";

export function loadArchiveConfiguration(environment = process.env) {
  const fields = {
    endpoint_url: "TRANSCRIPT_ARCHIVE_ENDPOINT_URL",
    region: "TRANSCRIPT_ARCHIVE_REGION",
    bucket: "TRANSCRIPT_ARCHIVE_BUCKET",
    upload_prefix: "TRANSCRIPT_ARCHIVE_UPLOAD_PREFIX",
    report_prefix: "TRANSCRIPT_ARCHIVE_REPORT_PREFIX",
    retention_days: "TRANSCRIPT_ARCHIVE_RETENTION_DAYS",
  };
  const names = Object.values(fields);
  if (names.every(name => environment[name] === undefined)) {
    return null;
  }
  const config = Object.fromEntries(Object.entries(fields).map(([key, name]) => [key, environment[name]]));
  config.retention_days = Number(config.retention_days);
  if (!names.every(name => typeof environment[name] === "string" && environment[name].length > 0)
    || !["http://ministack:4566", "http://100.64.73.87:4566"].includes(config.endpoint_url)
    || config.region !== "us-east-1" || config.bucket !== "ministack-lab-assets"
    || config.upload_prefix !== "transcript/uploads/" || config.report_prefix !== "transcript/reports/"
    || !Number.isInteger(config.retention_days) || config.retention_days < 7 || config.retention_days > 365) {
    throw new Error("Transcript archive configuration is incomplete or not a supported lab configuration.");
  }
  return config;
}

export function startArchiveSynchronization(store, config, { adapter = null } = {}) {
  if (!store.archiveEnabled) {
    throw new Error("Archive synchronization requires enabled durable storage.");
  }
  const remote = adapter || createTranscriptArchive(config);
  const synchronizer = createArchiveSync(store.archives, remote);
  let running = null;
  let stopped = false;

  function flush() {
    if (stopped) {
      return Promise.resolve(null);
    }
    if (!running) {
      running = synchronizer.flush().catch(() => {
        console.error("{\"event\":\"archive_sync_failed\"}");
        return { delivered: 0, failed: 1 };
      }).finally(() => {
        running = null;
      });
    }
    return running;
  }

  const timer = setInterval(flush, 15_000);
  timer.unref();
  void flush();
  return {
    flush,
    async stop() {
      stopped = true;
      clearInterval(timer);
      await running;
      if (!adapter) {
        remote.close();
      }
    },
  };
}
