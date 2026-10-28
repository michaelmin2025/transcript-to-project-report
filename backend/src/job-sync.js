// Synchronization never invokes report generation or discards a local result.
export function createJobSync(journal, adapter) {
  let busy = false;

  async function flush() {
    if (busy) {
      return { busy: true, delivered: 0, failed: 0 };
    }
    busy = true;
    let delivered = 0;
    let failed = 0;
    try {
      for (const record of journal.pending()) {
        try {
          await adapter.write(record);
          if (journal.acknowledge(record.job_id, record.revision)) {
            delivered += 1;
          }
        }
        catch {
          // Leave the durable record pending. Never log SDK errors or job payloads.
          failed += 1;
        }
      }
      return { busy: false, delivered, failed };
    }
    finally {
      busy = false;
    }
  }

  return { flush };
}
