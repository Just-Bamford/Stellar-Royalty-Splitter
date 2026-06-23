const { Contract, SorobanRpc } = require('@stellar/stellar-sdk');
const EventEmitter = require('events');

class AdminTransferEventListener extends EventEmitter {
  constructor(server, contractId, cacheManager, logger = console) {
    super();
    this.server = server;
    this.contractId = contractId;
    this.cache = cacheManager;
    this.logger = logger;
    this.isRunning = false;
    this.pollIntervalMs = parseInt(process.env.ADMIN_EVENT_POLL_INTERVAL_MS, 10) || 1000;
    this.lastLedger = null;
    this.timer = null;
  }

  async start() {
    if (this.isRunning) return;
    this.isRunning = true;
    
    try {
      const latestLedger = await this.server.getLatestLedger();
      this.lastLedger = latestLedger.sequence;
      this.logger.info(`[AdminListener] Started. Ledger cursor: ${this.lastLedger}`);
      this._schedulePoll();
    } catch (err) {
      this.logger.error('[AdminListener] Failed to start:', err.message);
      this.isRunning = false;
      throw err;
    }
  }

  stop() {
    this.isRunning = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.logger.info('[AdminListener] Stopped.');
  }

  _schedulePoll() {
    if (!this.isRunning) return;
    this.timer = setTimeout(() => this._poll(), this.pollIntervalMs);
  }

  async _poll() {
    if (!this.isRunning) return;

    try {
      const startTime = performance.now();
      
      const eventsResponse = await this.server.getEvents({
        startLedger: this.lastLedger,
        filters: [
          {
            type: 'contract',
            contractIds: [this.contractId],
            topics: [
              ['*', this._topicHash('admin_transfer')]
            ]
          }
        ],
        limit: 100
      });

      if (eventsResponse.events && eventsResponse.events.length > 0) {
        for (const event of eventsResponse.events) {
          await this._handleEvent(event);
        }
        
        const lastEvent = eventsResponse.events[eventsResponse.events.length - 1];
        this.lastLedger = lastEvent.ledgerSequence;
      } else {
        // No events, advance cursor slightly to avoid re-querying same ledger
        const latest = await this.server.getLatestLedger();
        this.lastLedger = Math.max(this.lastLedger, latest.sequence - 1);
      }

      const duration = performance.now() - startTime;
      if (duration > 100) {
        this.logger.warn(`[AdminListener] Slow poll: ${duration.toFixed(2)}ms`);
      }

    } catch (err) {
      this.logger.error('[AdminListener] Poll error:', err.message);
      // Don't advance cursor on error, retry same ledger
    }

    this._schedulePoll();
  }

  async _handleEvent(event) {
    try {
      const oldAdmin = this._parseAddress(event.topic[2]);
      const newAdmin = this._parseAddress(event.topic[3]);
      
      const invalidateStart = performance.now();
      
      // Immediately invalidate admin cache
      await this.cache.invalidateAdmin();
      
      // Also invalidate full contract state to be safe
      await this.cache.invalidateAll();
      
      const invalidateDuration = performance.now() - invalidateStart;
      
      this.logger.info(
        `[AdminListener] Admin transfer detected. ` +
        `Old: ${oldAdmin} → New: ${newAdmin}. ` +
        `Cache invalidated in ${invalidateDuration.toFixed(2)}ms`
      );

      this.emit('adminTransferred', {
        oldAdmin,
        newAdmin,
        ledger: event.ledgerSequence,
        txHash: event.txHash,
        invalidateDuration
      });

    } catch (err) {
      this.logger.error('[AdminListener] Failed to handle event:', err.message);
      // Still invalidate cache even if parsing fails
      await this.cache.invalidateAll();
    }
  }

  _topicHash(topicName) {
    // Soroban event topics are hashed xdr.ScVal symbols
    const { xdr } = require('@stellar/stellar-sdk');
    const sym = xdr.ScVal.scvSymbol(topicName);
    return sym.toXDR('hex');
  }

  _parseAddress(topicBytes) {
    try {
      const { xdr } = require('@stellar/stellar-sdk');
      const scVal = xdr.ScVal.fromXDR(Buffer.from(topicBytes, 'hex'));
      return scVal.address().toString();
    } catch {
      return 'unknown';
    }
  }
}

module.exports = { AdminTransferEventListener };