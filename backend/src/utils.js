export function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

export function parsePositiveInt(value, fallback) {
  const n = parseInt(value ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function createWarmingCache(ttl = 60000, lead = 30000) {
  const c = new Map();
  return {
    async get(k, f) {
      const n = Date.now(), e = c.get(k);
      if (e && n < e.e) {
        if (n >= e.e - lead && !e.r) {
          e.r = 1;
          f().then(v => c.set(k, {v, e: Date.now() + ttl}));
        }
        return e.v;
      }
      if (e) {
        if (!e.r) {
          e.r = 1;
          f().then(v => c.set(k, {v, e: Date.now() + ttl}));
        }
        return e.v;
      }
      const v = await f();
      c.set(k, {v, e: Date.now() + ttl});
      return v;
    },
  };
}