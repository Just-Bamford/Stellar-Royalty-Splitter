const NodeCache = require('node-cache');

class ContractStateCache {
  constructor(ttlSeconds = 30) {
    this.cache = new NodeCache({ stdTTL: ttlSeconds, checkperiod: 5 });
    this.ttl = ttlSeconds;
    this.adminInvalidationTime = null;
    this.logger = console;
  }

  async getAdmin() {
    // If recently invalidated, force fresh read for 500ms
    if (this.adminInvalidationTime && 
        (Date.now() - this.adminInvalidationTime) < 500) {
      return null; // Signal cache miss to force on-chain read
    }
    return this.cache.get('admin');
  }

  setAdmin(adminAddress) {
    this.cache.set('admin', adminAddress);
    this.logger.info(`[Cache] Admin cached: ${adminAddress}`);
  }

  async invalidateAdmin() {
    this.cache.del('admin');
    this.adminInvalidationTime = Date.now();
    this.logger.info('[Cache] Admin cache invalidated');
  }

  async invalidateAll() {
    const keys = this.cache.keys();
    this.cache.del(keys);
    this.adminInvalidationTime = Date.now();
    this.logger.info(`[Cache] Full cache invalidated. Keys removed: ${keys.length}`);
  }

  getStats() {
    return {
      keys: this.cache.keys().length,
      ttl: this.ttl,
      adminInvalidationTime: this.adminInvalidationTime,
      isAdminStale: this.adminInvalidationTime ? 
        (Date.now() - this.adminInvalidationTime) > 500 : false
    };
  }
}

module.exports = { ContractStateCache };