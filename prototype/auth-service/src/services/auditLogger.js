/**
 * Non-blocking asynchronous audit logger (Step 6 in prototype architecture).
 * Defers serialization and I/O off the response critical path via setImmediate.
 */
function createAuditLogger({ enabled = true, sink = console.log } = {}) {
  function logEvent(event) {
    if (!enabled) return;
    setImmediate(() => {
      const record = {
        timestamp: new Date().toISOString(),
        ...event,
      };
      sink(JSON.stringify(record));
    });
  }

  return { logEvent };
}

module.exports = {
  createAuditLogger,
};
