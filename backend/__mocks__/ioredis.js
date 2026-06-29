const stores = new Map();

function getStore(url) {
  if (!stores.has(url)) {
    stores.set(url, new Map());
  }
  return stores.get(url);
}

export default class Redis {
  constructor(url = "redis://localhost:6379") {
    this.url = url;
    this.store = getStore(url);
  }

  async get(key) {
    return this.store.get(key) ?? null;
  }

  async setex(key, _ttl, value) {
    this.store.set(key, value);
    return "OK";
  }

  async del(...keys) {
    let deleted = 0;
    for (const key of keys) {
      if (this.store.delete(key)) {
        deleted += 1;
      }
    }
    return deleted;
  }

  async flushdb() {
    this.store.clear();
    return "OK";
  }

  async ping() {
    return "PONG";
  }

  async quit() {
    return "OK";
  }
}
