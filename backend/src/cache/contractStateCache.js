import NodeCache from "node-cache";

export class ContractStateCache {
  constructor(ttlSeconds = 30) {
    this.cache = new NodeCache({ stdTTL: ttlSeconds, checkperiod: 5 });
    this.ttl = ttlSeconds;
    this.adminInvalidationTime = null;
  }

  async getAdmin() {
    // Force fresh read for 500ms after invalidation
    if (this.adminInvalidationTime && Date.now() - this.adminInvalidationTime < 500) {
      return null;
    }
    return this.cache.get("admin");
  }

  setAdmin(adminAddress) {
    this.cache.set("admin", adminAddress);
  }

  async invalidateAdmin() {
    this.cache.del("admin");
    this.adminInvalidationTime = Date.now();
  }

  async invalidateAll() {
    const keys = this.cache.keys();
    this.cache.del(keys);
    this.adminInvalidationTime = Date.now();
  }

  getStats() {
    return {
      keys: this.cache.keys().length,
      ttl: this.ttl,
      adminInvalidationTime: this.adminInvalidationTime,
      isAdminStale: this.adminInvalidationTime
        ? Date.now() - this.adminInvalidationTime > 500
        : false,
    };
  }
}