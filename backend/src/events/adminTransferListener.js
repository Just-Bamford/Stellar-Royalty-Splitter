import EventEmitter from "events";
import { xdr } from "@stellar/stellar-sdk";

export class AdminTransferEventListener extends EventEmitter {
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
      this.logger.info(`[AdminListener] Started at ledger ${this.lastLedger}`);
      this._schedulePoll();
    } catch (err) {
      this.logger.error("[AdminListener] Start failed:", err.message);
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
    this.logger.info("[AdminListener] Stopped");
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
            type: "contract",
            contractIds: [this.contractId],
            topics: [["*", this._topicHash("admin_transfer")]],
          },
        ],
        limit: 100,
      });

      if (eventsResponse.events?.length > 0) {
        for (const event of eventsResponse.events) {
          await this._handleEvent(event);
        }
        const last = eventsResponse.events[eventsResponse.events.length - 1];
        this.lastLedger = last.ledgerSequence;
      } else {
        const latest = await this.server.getLatestLedger();
        this.lastLedger = Math.max(this.lastLedger, latest.sequence - 1);
      }

      const duration = performance.now() - startTime;
      if (duration > 100) {
        this.logger.warn(`[AdminListener] Slow poll: ${duration.toFixed(2)}ms`);
      }
    } catch (err) {
      this.logger.error("[AdminListener] Poll error:", err.message);
    }

    this._schedulePoll();
  }

  async _handleEvent(event) {
    try {
      const oldAdmin = this._parseAddress(event.topic[2]);
      const newAdmin = this._parseAddress(event.topic[3]);

      const invStart = performance.now();
      await this.cache.invalidateAdmin();
      await this.cache.invalidateAll();
      const invDuration = performance.now() - invStart;

      this.logger.info(
        `[AdminListener] Transfer: ${oldAdmin} → ${newAdmin} ` +
        `(invalidated in ${invDuration.toFixed(2)}ms)`
      );

      this.emit("adminTransferred", {
        oldAdmin,
        newAdmin,
        ledger: event.ledgerSequence,
        txHash: event.txHash,
        invalidateDuration: invDuration,
      });
    } catch (err) {
      this.logger.error("[AdminListener] Handle error:", err.message);
      await this.cache.invalidateAll();
    }
  }

  _topicHash(name) {
    return xdr.ScVal.scvSymbol(name).toXDR("hex");
  }

  _parseAddress(bytes) {
    try {
      return xdr.ScVal.fromXDR(Buffer.from(bytes, "hex")).address().toString();
    } catch {
      return "unknown";
    }
  }
}