/**
 * In-memory stand-in for `src/database/core.js` used by the #996 metering
 * tests.
 *
 * `better-sqlite3` is mocked out for the whole Jest project, so the metering
 * service is exercised against a fake `db` that implements exactly the
 * statements the service prepares. Keeping the fake here (rather than mocking
 * the service itself) means the real SQL, bucketing and pricing logic runs.
 */

const isInsertKey = (sql) => sql.startsWith("insert into partner_api_keys");
const isSelectKeys = (sql) => sql.startsWith("select * from partner_api_keys");
const isListAll = (sql) =>
  isSelectKeys(sql) && sql.includes("order by createdat desc") && !sql.includes("where");
const isListActive = (sql) => isSelectKeys(sql) && sql.includes("status = 'active'");
const isListByPartner = (sql) => isSelectKeys(sql) && sql.includes("where partnerid = ?");
const isGetById = (sql) => isSelectKeys(sql) && sql.includes("where id = ?");
const isGetByKeyId = (sql) => isSelectKeys(sql) && sql.includes("where keyid = ?");
const isGetByHash = (sql) => isSelectKeys(sql) && sql.includes("where keyhash = ?");
const isRevoke = (sql) =>
  sql.startsWith("update partner_api_keys") && sql.includes("status = 'revoked'");
const isTouch = (sql) => sql.startsWith("update partner_api_keys") && sql.includes("lastusedat");
const isUpdateTier = (sql) => sql.startsWith("update partner_api_keys") && sql.includes("set tier");
// `count(*) as c` must not also match the analytics statements, which alias
// the same aggregate as `count(*) as calls` — hence the trailing `from`.
const isCountDay = (sql) => sql.includes("count(*) as c from") && sql.includes("bucketday = ?");
const isCountMonth = (sql) => sql.includes("count(*) as c from") && sql.includes("bucketday >= ?");
const isInsertEvent = (sql) => sql.startsWith("insert into api_call_events");
const isPrune = (sql) => sql.startsWith("delete from api_call_events");
const isUsageOverTime = (sql) => sql.includes("as avgdurationms") && sql.includes("group by bucketday");
const isTopEndpoints = (sql) => sql.includes("group by endpoint, method");
const isPartnerTotals = (sql) => sql.startsWith("select k.partnerid");
const isTotals = (sql) => sql.includes("as servererrors");
const isStatusBreakdown = (sql) => sql.includes("group by statuscode");

const inWindow = (event, since, until, partnerId) =>
  event.bucketDay >= since && event.bucketDay <= until && (!partnerId || event.partnerId === partnerId);

/**
 * Bind arguments for the analytics statements.
 *
 * They all take `(since, until)`, optionally followed by `partnerId` when the
 * statement is the scoped variant, followed by `tail` extra parameters.
 */
function scopedArgs(args, { scoped, tailCount = 0 } = {}) {
  const [since, until] = args;
  const partnerId = scoped ? args[2] : null;
  const tailStart = scoped ? 3 : 2;
  return { since, until, partnerId, tail: args.slice(tailStart, tailStart + tailCount) };
}

/**
 * @returns {{db: object, keys: Array, events: Array, reset: () => void}}
 */
export function createFakeMeteringDb() {
  const keys = [];
  const events = [];
  let nextKeyRowId = 1;
  let nextEventId = 1;

  function insertKeyFrom(args) {
    const [keyId, keyHash, partnerId, partnerName, tier, dailyCallLimit, monthlyCallLimit, monthlyPriceCents, expiresAt] = args;
    const row = {
      id: nextKeyRowId++,
      keyId,
      keyHash,
      partnerId,
      partnerName,
      tier,
      dailyCallLimit,
      monthlyCallLimit,
      monthlyPriceCents: monthlyPriceCents ?? 0,
      status: "active",
      createdAt: "2026-01-01 00:00:00",
      expiresAt: expiresAt ?? null,
      lastUsedAt: null,
      revokedAt: null,
    };
    keys.push(row);
    return row;
  }

  function insertEventFrom(args) {
    const [keyId, partnerId, endpoint, method, statusCode, durationMs, rateLimited, bucketDay] = args;
    const row = {
      id: nextEventId++,
      keyId,
      partnerId,
      endpoint,
      method,
      statusCode,
      durationMs,
      rateLimited,
      bucketDay,
    };
    events.push(row);
    return row;
  }

  const noop = { run: () => ({ changes: 0 }), get: () => undefined, all: () => [] };

  const db = {
    open: true,
    prepare(sql) {
      const n = sql.replace(/\s+/g, " ").trim().toLowerCase();

      if (isInsertKey(n)) {
        return {
          run: (...args) => {
            const row = insertKeyFrom(args);
            return { changes: 1, lastInsertRowid: row.id };
          },
          get: () => undefined,
          all: () => [],
        };
      }
      if (isGetByHash(n)) {
        return { run: () => ({ changes: 0 }), get: (h) => keys.find((k) => k.keyHash === h), all: () => [] };
      }
      if (isGetById(n)) {
        return { run: () => ({ changes: 0 }), get: (id) => keys.find((k) => k.id === id), all: () => [] };
      }
      if (isGetByKeyId(n)) {
        return { run: () => ({ changes: 0 }), get: (kid) => keys.find((k) => k.keyId === kid), all: () => [] };
      }
      if (isListActive(n)) {
        return { run: () => ({ changes: 0 }), get: () => undefined, all: () => keys.filter((k) => k.status === "active") };
      }
      if (isListByPartner(n)) {
        return {
          run: () => ({ changes: 0 }),
          get: () => undefined,
          all: (pid) => keys.filter((k) => k.partnerId === pid),
        };
      }
      if (isListAll(n)) {
        return { run: () => ({ changes: 0 }), get: () => undefined, all: () => [...keys] };
      }
      if (isRevoke(n)) {
        return {
          run: (id) => {
            const key = keys.find((k) => k.id === id && k.status === "active");
            if (!key) return { changes: 0 };
            key.status = "revoked";
            key.revokedAt = "2026-01-02 00:00:00";
            return { changes: 1 };
          },
          get: () => undefined,
          all: () => [],
        };
      }
      if (isTouch(n)) {
        return {
          run: (id) => {
            const key = keys.find((k) => k.id === id);
            if (key) key.lastUsedAt = "2026-01-03 00:00:00";
            return { changes: key ? 1 : 0 };
          },
          get: () => undefined,
          all: () => [],
        };
      }
      if (isUpdateTier(n)) {
        return {
          run: (tier, dailyCallLimit, monthlyCallLimit, monthlyPriceCents, id) => {
            const key = keys.find((k) => k.id === id);
            if (!key) return { changes: 0 };
            key.tier = tier;
            key.dailyCallLimit = dailyCallLimit;
            key.monthlyCallLimit = monthlyCallLimit;
            key.monthlyPriceCents = monthlyPriceCents;
            return { changes: 1 };
          },
          get: () => undefined,
          all: () => [],
        };
      }
      if (isCountDay(n)) {
        return {
          run: () => ({ changes: 0 }),
          get: (keyId, bucketDay) => ({
            c: events.filter((e) => e.keyId === keyId && e.bucketDay === bucketDay && !e.rateLimited).length,
          }),
          all: () => [],
        };
      }
      if (isCountMonth(n)) {
        return {
          run: () => ({ changes: 0 }),
          get: (keyId, since) => ({
            c: events.filter((e) => e.keyId === keyId && e.bucketDay >= since && !e.rateLimited).length,
          }),
          all: () => [],
        };
      }
      if (isInsertEvent(n)) {
        return {
          run: (...args) => {
            insertEventFrom(args);
            return { changes: 1 };
          },
          get: () => undefined,
          all: () => [],
        };
      }
      if (isPrune(n)) {
        return {
          run: (before) => {
            const remaining = events.filter((e) => e.bucketDay >= before);
            const changes = events.length - remaining.length;
            events.length = 0;
            events.push(...remaining);
            return { changes };
          },
          get: () => undefined,
          all: () => [],
        };
      }
      if (isPartnerTotals(n)) {
        return {
          run: () => ({ changes: 0 }),
          get: () => undefined,
          all: (since, until) =>
            keys.map((k) => {
              const scoped = events.filter((e) => e.keyId === k.keyId && inWindow(e, since, until, null));
              return {
                partnerId: k.partnerId,
                partnerName: k.partnerName,
                tier: k.tier,
                monthlyPriceCents: k.monthlyPriceCents,
                monthlyCallLimit: k.monthlyCallLimit,
                status: k.status,
                calls: scoped.filter((e) => !e.rateLimited).length,
                errors: scoped.filter((e) => e.statusCode >= 400).length,
              };
            }),
        };
      }
      if (isUsageOverTime(n)) {
        return {
          run: () => ({ changes: 0 }),
          get: () => undefined,
          all: (...args) => {
            const { since, until, partnerId } = scopedArgs(args, {
              scoped: n.includes("and partnerid = ?"),
            });
            const buckets = new Map();
            for (const e of events.filter((x) => inWindow(x, since, until, partnerId))) {
              const row = buckets.get(e.bucketDay) ?? { day: e.bucketDay, calls: 0, rateLimited: 0, errors: 0, durations: [] };
              row.calls += 1;
              if (e.rateLimited) row.rateLimited += 1;
              if (e.statusCode >= 400) row.errors += 1;
              if (e.durationMs !== null) row.durations.push(e.durationMs);
              buckets.set(e.bucketDay, row);
            }
            return [...buckets.values()]
              .sort((a, b) => a.day.localeCompare(b.day))
              .map((r) => ({
                day: r.day,
                calls: r.calls,
                rateLimited: r.rateLimited,
                errors: r.errors,
                avgDurationMs:
                  r.durations.length > 0 ? r.durations.reduce((a, b) => a + b, 0) / r.durations.length : 0,
              }));
          },
        };
      }
      if (isTopEndpoints(n)) {
        return {
          run: () => ({ changes: 0 }),
          get: () => undefined,
          all: (...args) => {
            const { since, until, partnerId, tail } = scopedArgs(args, {
              scoped: n.includes("and partnerid = ?"),
              tailCount: 1,
            });
            const limit = tail[0];
            const buckets = new Map();
            for (const e of events.filter((x) => inWindow(x, since, until, partnerId))) {
              const mapKey = `${e.method} ${e.endpoint}`;
              const row = buckets.get(mapKey) ?? {
                endpoint: e.endpoint,
                method: e.method,
                calls: 0,
                errors: 0,
                durations: [],
              };
              row.calls += 1;
              if (e.statusCode >= 400) row.errors += 1;
              if (e.durationMs !== null) row.durations.push(e.durationMs);
              buckets.set(mapKey, row);
            }
            return [...buckets.values()]
              .sort((a, b) => b.calls - a.calls)
              .slice(0, limit)
              .map((r) => ({
                endpoint: r.endpoint,
                method: r.method,
                calls: r.calls,
                errors: r.errors,
                avgDurationMs:
                  r.durations.length > 0 ? r.durations.reduce((a, b) => a + b, 0) / r.durations.length : 0,
              }));
          },
        };
      }
      if (isTotals(n)) {
        return {
          run: () => ({ changes: 0 }),
          get: () => undefined,
          all: (...args) => {
            const { since, until, partnerId } = scopedArgs(args, {
              scoped: n.includes("and partnerid = ?"),
            });
            const scoped = events.filter((x) => inWindow(x, since, until, partnerId));
            const durations = scoped.map((e) => e.durationMs).filter((d) => d !== null);
            return [
              {
                totalCalls: scoped.length,
                totalErrors: scoped.filter((e) => e.statusCode >= 400).length,
                serverErrors: scoped.filter((e) => e.statusCode >= 500).length,
                totalRateLimited: scoped.filter((e) => e.rateLimited).length,
                avgDurationMs:
                  durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : 0,
              },
            ];
          },
        };
      }
      if (isStatusBreakdown(n)) {
        return {
          run: () => ({ changes: 0 }),
          get: () => undefined,
          all: (...args) => {
            const { since, until, partnerId } = scopedArgs(args, {
              scoped: n.includes("and partnerid = ?"),
            });
            const buckets = new Map();
            for (const e of events.filter((x) => inWindow(x, since, until, partnerId))) {
              buckets.set(e.statusCode, (buckets.get(e.statusCode) ?? 0) + 1);
            }
            return [...buckets.entries()]
              .sort((a, b) => b[1] - a[1])
              .map(([statusCode, calls]) => ({ statusCode, calls }));
          },
        };
      }

      return noop;
    },
  };

  return {
    db,
    keys,
    events,
    reset() {
      keys.length = 0;
      events.length = 0;
      nextKeyRowId = 1;
      nextEventId = 1;
    },
  };
}
