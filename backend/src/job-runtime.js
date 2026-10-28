import { createTranscriptJobs } from "./transcript-jobs.js";
import { createJobSync } from "./job-sync.js";

export function loadJobConfiguration(environment = process.env) {
  const names = ["TRANSCRIPT_JOBS_ENDPOINT_URL", "TRANSCRIPT_JOBS_REGION", "TRANSCRIPT_JOBS_TABLE", "TRANSCRIPT_JOBS_RETENTION_DAYS"];
  if (names.every(name => environment[name] === undefined)) {
    return null;
  }
  const config = {
    endpoint_url: environment.TRANSCRIPT_JOBS_ENDPOINT_URL,
    region: environment.TRANSCRIPT_JOBS_REGION,
    table: environment.TRANSCRIPT_JOBS_TABLE,
    retention_days: Number(environment.TRANSCRIPT_JOBS_RETENTION_DAYS),
  };
  if (!names.every(name => typeof environment[name] === "string" && environment[name].length > 0)
    || !["http://ministack:4566", "http://100.64.73.87:4566"].includes(config.endpoint_url)
    || config.region !== "us-east-1" || config.table !== "ministack-lab-transcript-jobs"
    || !Number.isInteger(config.retention_days) || config.retention_days < 7 || config.retention_days > 365) {
    throw new Error("Transcript job configuration is incomplete or not a supported lab configuration.");
  }
  return config;
}

export function startJobSynchronization(store, config, { adapter = null } = {}) {
  const remote = adapter || createTranscriptJobs(config);
  store.jobs.recoverInterrupted();
  const synchronizer = createJobSync(store.jobs, remote);
  let running = null;
  let stopped = false;

  function flush() {
    if (stopped) {
      return Promise.resolve(null);
    }
    if (!running) {
      running = synchronizer.flush().catch(() => {
        console.error("{\"event\":\"job_sync_failed\"}");
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
