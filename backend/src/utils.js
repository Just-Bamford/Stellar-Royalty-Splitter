export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function parsePositiveInt(value, fallback) {
  const n = parseInt(value ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function createWarmingCache(ttl = 60000, lead = 30000) {
  const cache = new Map();

  const refresh = (key, loadValue) => {
    const currentEntry = cache.get(key);
    if (currentEntry?.refreshPromise) return currentEntry.refreshPromise;

    const refreshPromise = Promise.resolve()
      .then(() => loadValue())
      .then((value) => {
        cache.set(key, {
          value,
          expiresAt: Date.now() + ttl,
        });
        return value;
      })
      .catch((error) => {
        const entryAfterFailure = cache.get(key);
        if (entryAfterFailure?.refreshPromise === refreshPromise) {
          cache.set(key, {
            ...entryAfterFailure,
            refreshPromise: undefined,
          });
        }
        throw error;
      });

    cache.set(key, {
      ...(currentEntry ?? {}),
      refreshPromise,
    });
    return refreshPromise;
  };

  return {
    async get(key, loadValue) {
      const now = Date.now();
      const entry = cache.get(key);

      if (entry?.refreshPromise && entry.value === undefined) {
        return entry.refreshPromise;
      }

      if (entry && now < entry.expiresAt) {
        if (now >= entry.expiresAt - lead && !entry.refreshPromise) {
          refresh(key, loadValue).catch(() => {});
        }
        return entry.value;
      }

      if (entry) {
        if (!entry.refreshPromise) {
          refresh(key, loadValue).catch(() => {});
        }
        return entry.value;
      }

      return refresh(key, loadValue);
    },
  };
}
