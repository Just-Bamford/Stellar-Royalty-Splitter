// Manual mock for better-sqlite3. Most backend tests only need no-op database
// calls; application-log tests additionally use this tiny in-memory table.
const applicationLogs = [];
let nextLogId = 1;
const noop = () => {};

const contractVersions = new Map();
const migrationStages = new Map();
const versionMetrics = [];

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

  // Contract versioning mock handlers
  if (normalized.startsWith("insert into contract_versions")) {
    return {
      run: (...args) => {
        const [versionId, contractId, wasmHash, state, deployedAt, deployedBy, metadata] = args;
        contractVersions.set(versionId, {
          version_id: versionId,
          contract_id: contractId,
          wasm_hash: wasmHash,
          state,
          deployed_at: deployedAt,
          deployed_by: deployedBy,
          metadata: metadata || "{}",
        });
        return { changes: 1, lastInsertRowid: contractVersions.size };
      },
      get: () => undefined,
      all: () => [],
    };
  }
  if (normalized.includes("from contract_versions") && normalized.includes("version_id = ?")) {
    return {
      run: noop,
      get: (id) => contractVersions.get(id),
      all: (id) => {
        const row = contractVersions.get(id);
        return row ? [row] : [];
      },
    };
  }
  if (normalized.includes("from contract_versions") && normalized.includes("contract_id = ?")) {
    return {
      run: noop,
      get: (id) => Array.from(contractVersions.values()).find((v) => v.contract_id === id),
      all: (id) => Array.from(contractVersions.values()).filter((v) => v.contract_id === id),
    };
  }
  if (normalized.startsWith("update contract_versions set state = ?")) {
    return {
      run: (state, versionId) => {
        const row = contractVersions.get(versionId);
        if (row) row.state = state;
        return { changes: 1 };
      },
      get: () => undefined,
      all: () => [],
    };
  }
  if (normalized.startsWith("insert into migration_stages")) {
    return {
      run: (...args) => {
        const [migrationId, fromVersion, toVersion, currentStage, rolloutPercentage, startedAt, status, metrics] = args;
        migrationStages.set(migrationId, {
          migration_id: migrationId,
          from_version: fromVersion,
          to_version: toVersion,
          current_stage: currentStage,
          rollout_percentage: rolloutPercentage,
          started_at: startedAt,
          status,
          metrics: metrics || "{}",
        });
        return { changes: 1, lastInsertRowid: migrationStages.size };
      },
      get: () => undefined,
      all: () => [],
    };
  }
  if (normalized.includes("from migration_stages") && normalized.includes("migration_id = ?")) {
    return {
      run: noop,
      get: (id) => migrationStages.get(id),
      all: (id) => {
        const m = migrationStages.get(id);
        return m ? [m] : [];
      },
    };
  }
  if (normalized.startsWith("update migration_stages set current_stage = ?, rollout_percentage = ?, status = ?")) {
    return {
      run: (stage, percentage, status, id) => {
        const m = migrationStages.get(id);
        if (m) {
          m.current_stage = stage;
          m.rollout_percentage = percentage;
          m.status = status;
        }
        return { changes: 1 };
      },
      get: () => undefined,
      all: () => [],
    };
  }
  if (normalized.startsWith("update migration_stages set current_stage = ?, rollout_percentage = ?, completed_at = ?, status = ?")) {
    return {
      run: (stage, percentage, completedAt, status, id) => {
        const m = migrationStages.get(id);
        if (m) {
          m.current_stage = stage;
          m.rollout_percentage = percentage;
          m.completed_at = completedAt;
          m.status = status;
        }
        return { changes: 1 };
      },
      get: () => undefined,
      all: () => [],
    };
  }
  if (normalized.includes("from migration_stages") && normalized.includes("status = 'in_progress'")) {
    return {
      run: noop,
      get: () => Array.from(migrationStages.values()).find((m) => m.status === "in_progress"),
      all: () => Array.from(migrationStages.values()).filter((m) => m.status === "in_progress"),
    };
  }
  if (normalized.startsWith("insert into version_metrics")) {
    return {
      run: (...args) => {
        const [versionId, metricName, metricValue, recordedAt, metadata] = args;
        versionMetrics.push({
          version_id: versionId,
          metric_name: metricName,
          metric_value: metricValue,
          recorded_at: recordedAt,
          metadata: metadata || "{}",
        });
        return { changes: 1 };
      },
      get: () => undefined,
      all: () => [],
    };
  }
  if (normalized.includes("from version_metrics") && normalized.includes("version_id = ?")) {
    return {
      run: noop,
      get: (vId) => versionMetrics.find((m) => m.version_id === vId),
      all: (vId) => versionMetrics.filter((m) => m.version_id === vId),
    };
  }

  return { run: () => ({ changes: 1, lastInsertRowid: 1 }), get: () => undefined, all: () => [] };
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
