import logger from "../logger.js";

const DEFAULT_MAX_QUEUE_SIZE = 100;
const DEFAULT_FLUSH_THRESHOLD = 50;
const DEFAULT_FLUSH_INTERVAL_MS = 10_000;

function validateRequest(request) {
  if (!request || !request.contractId || !request.tokenId) {
    throw new TypeError("Batch distribution requests require contractId and tokenId");
  }
}

function groupKey(request) {
  return `${request.contractId}:${request.tokenId}`;
}

/**
 * Collects distribution requests and hands one grouped workload at a time to
 * an injected transaction processor. The processor can build unsigned XDR,
 * submit a transaction, or use a test double without coupling this service to
 * a particular signing or RPC implementation.
 */
export class BatchProcessor {
  constructor({
    processGroup,
    maxQueueSize = DEFAULT_MAX_QUEUE_SIZE,
    flushThreshold = DEFAULT_FLUSH_THRESHOLD,
    flushIntervalMs = DEFAULT_FLUSH_INTERVAL_MS,
    now = () => Date.now(),
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
    loggerImpl = logger,
  } = {}) {
    if (typeof processGroup !== "function") {
      throw new TypeError("BatchProcessor requires a processGroup function");
    }

    this.processGroup = processGroup;
    this.maxQueueSize = maxQueueSize;
    this.flushThreshold = flushThreshold;
    this.flushIntervalMs = flushIntervalMs;
    this.now = now;
    this.setTimeout = setTimeoutImpl;
    this.clearTimeout = clearTimeoutImpl;
    this.logger = loggerImpl;
    this.queue = [];
    this.timer = null;
    this.nextFlushAt = null;
    this.processing = false;
  }

  /** Enqueue a request and resolve it with the result of its processed group. */
  enqueue(request, callback) {
    validateRequest(request);

    if (this.queue.length >= this.maxQueueSize) {
      const error = new Error("Batch distribution queue is full");
      error.code = "batch_queue_full";
      if (typeof callback === "function") callback(error);
      return Promise.reject(error);
    }

    const promise = new Promise((resolve, reject) => {
      this.queue.push({ request, resolve, reject });
    });

    this.scheduleTimer();
    if (this.queue.length >= this.flushThreshold) {
      void this.flush();
    }

    if (typeof callback === "function") {
      promise.then((result) => callback(null, result), callback);
    }
    return promise;
  }

  get size() {
    return this.queue.length;
  }

  async flush() {
    if (this.processing || this.queue.length === 0) return [];

    this.processing = true;
    if (this.timer !== null) {
      this.clearTimeout(this.timer);
      this.timer = null;
    }
    this.nextFlushAt = null;

    const pending = this.queue.splice(0, this.queue.length);
    const groups = new Map();
    for (const item of pending) {
      const key = groupKey(item.request);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }

    const results = [];
    try {
      for (const items of groups.values()) {
        const requests = items.map(({ request }) => request);
        try {
          const result = await this.processGroup(requests, {
            contractId: requests[0].contractId,
            tokenId: requests[0].tokenId,
          });
          for (const item of items) item.resolve(result);
          results.push(result);
        } catch (error) {
          for (const item of items) item.reject(error);
          this.logger.warn("Batch distribution group failed", {
            contractId: requests[0].contractId,
            tokenId: requests[0].tokenId,
            error: error?.message ?? String(error),
          });
        }
      }
      return results;
    } finally {
      this.processing = false;
      if (this.queue.length > 0) this.scheduleTimer();
    }
  }

  scheduleTimer() {
    if (this.timer !== null || this.queue.length === 0) return;
    this.nextFlushAt = this.now() + this.flushIntervalMs;
    this.timer = this.setTimeout(() => {
      this.timer = null;
      this.nextFlushAt = null;
      void this.flush();
    }, Math.max(0, this.nextFlushAt - this.now()));
    this.timer?.unref?.();
  }

  stop() {
    if (this.timer !== null) {
      this.clearTimeout(this.timer);
      this.timer = null;
    }
    this.nextFlushAt = null;
  }
}

export const BATCH_PROCESSOR_DEFAULTS = Object.freeze({
  maxQueueSize: DEFAULT_MAX_QUEUE_SIZE,
  flushThreshold: DEFAULT_FLUSH_THRESHOLD,
  flushIntervalMs: DEFAULT_FLUSH_INTERVAL_MS,
});