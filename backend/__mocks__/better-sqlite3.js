// Manual mock for better-sqlite3. Most backend tests only need no-op database
// calls; application-log tests additionally use this tiny in-memory table.
const applicationLogs = [];
let nextLogId = 1;
const noop = () => {};

function applicationLogRow(args) {
  const [level, message, correlationId = null, requestId = null, service = "api", metadata = "{}"] = args;
  return {
    id: nextLogId++,
    timestamp: new Date().toISOString(),
    level,
    message,
    correlation_id: correlationId,
    request_id: requestId,
    service,
    metadata,
  };
}

function prepare(sql) {
  const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
  if (normalized.startsWith("insert into application_logs")) {
    return {
      run: (...args) => {
        if (args.length === 0 && normalized.includes("-10 days")) {
          applicationLogs.push({
            id: nextLogId++,
            timestamp: new Date(Date.now() - 10 * 86_400_000).toISOString(),
            level: "info",
            message: "old",
            correlation_id: null,
            request_id: null,
            service: "api",
            metadata: "{}",
          });
        } else {
          applicationLogs.push(applicationLogRow(args));
        }
        return { changes: 1 };
      },
      get: () => undefined,
      all: () => [],
    };
  }
  if (normalized.startsWith("delete from application_logs where timestamp")) {
    return {
      run: (modifier = "-30 days") => {
        const days = Number(String(modifier).match(/-([\d.]+) days/)?.[1] ?? 30);
        const cutoff = Date.now() - days * 86_400_000;
        const before = applicationLogs.length;
        for (let index = applicationLogs.length - 1; index >= 0; index -= 1) {
          if (new Date(applicationLogs[index].timestamp).getTime() < cutoff) applicationLogs.splice(index, 1);
        }
        return { changes: before - applicationLogs.length };
      },
      get: () => undefined,
      all: () => [],
    };
  }
  if (normalized === "delete from application_logs") {
    return {
      run: () => {
        const changes = applicationLogs.length;
        applicationLogs.length = 0;
        return { changes };
      },
      get: () => undefined,
      all: () => [],
    };
  }
  if (normalized.includes("from application_logs") && normalized.includes("count(*)")) {
    return {
      run: noop,
      get: () => {
        const errors = applicationLogs.filter((row) => row.level === "error");
        return { errorCount: errors.length, lastError: errors.at(-1)?.timestamp ?? null };
      },
      all: () => [],
    };
  }
  if (normalized.includes("from application_logs")) {
    return {
      run: noop,
      get: () => undefined,
      all: (...args) => {
        const values = args;
        let rows = [...applicationLogs];
        if (normalized.includes("correlation_id = ?")) rows = rows.filter((row) => row.correlation_id === values[0]);
        if (normalized.includes("request_id = ?")) rows = rows.filter((row) => row.request_id === values[0]);
        if (normalized.includes("level = ?")) rows = rows.filter((row) => row.level === values[0]);
        return rows.reverse().map((row) => ({
          id: row.id,
          timestamp: row.timestamp,
          level: row.level,
          message: row.message,
          correlationId: row.correlation_id,
          requestId: row.request_id,
          service: row.service,
          metadata: row.metadata,
        }));
      },
    };
  }
  return { run: noop, get: () => undefined, all: () => [] };
}

const mockDb = {
  pragma: noop,
  prepare,
  exec: noop,
  transaction: (fn) => fn,
};

export default function Database() {
  return mockDb;
}
