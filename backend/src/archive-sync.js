export function createArchiveSync(journal, adapter) {
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
        if (!journal.attempted(record.key, record.sha256)) {
          continue;
        }
        try {
          const receipt = await adapter.put(record.key, record.body);
          if (receipt.key !== record.key || receipt.sha256 !== record.sha256 || receipt.bytes !== record.body.length) {
            throw new Error("Invalid archive receipt");
          }
          if (journal.acknowledge(record.key, record.sha256)) {
            delivered += 1;
          }
        }
        catch (error) {
          journal.failed(record.key, record.sha256, error?.code);
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
