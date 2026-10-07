import { jest, describe, test, expect, beforeEach, afterEach } from "@jest/globals";
import { BatchProcessor } from "../src/services/batch-processor.js";
import { batchDeduplicationMiddleware } from "../src/middleware/batch-dedup.js";

describe("BatchProcessor", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test("collects requests and groups them by contract and token", async () => {
    const processGroup = jest.fn(async (requests, group) => ({
      transactionId: `${group.contractId}-${group.tokenId}`,
      count: requests.length,
    }));
    const processor = new BatchProcessor({ processGroup });

    const first = processor.enqueue({ contractId: "contract-a", tokenId: "token-a", amount: "1" });
    const second = processor.enqueue({ contractId: "contract-a", tokenId: "token-a", amount: "2" });
    const third = processor.enqueue({ contractId: "contract-a", tokenId: "token-b", amount: "3" });

    expect(processGroup).not.toHaveBeenCalled();
    jest.advanceTimersByTime(10_000);

    await expect(Promise.all([first, second, third])).resolves.toEqual([
      { transactionId: "contract-a-token-a", count: 2 },
      { transactionId: "contract-a-token-a", count: 2 },
      { transactionId: "contract-a-token-b", count: 1 },
    ]);
    expect(processGroup).toHaveBeenCalledTimes(2);
    processor.stop();
  });

  test("flushes immediately at 50 items and caps the queue at 100", async () => {
    const processGroup = jest.fn(async (requests) => ({ transactionId: "tx-batch", count: requests.length }));
    const processor = new BatchProcessor({ processGroup });
    const requests = Array.from({ length: 50 }, (_, index) =>
      processor.enqueue({ contractId: "contract-a", tokenId: "token-a", amount: String(index + 1) })
    );

    await expect(Promise.all(requests)).resolves.toHaveLength(50);
    expect(processGroup).toHaveBeenCalledTimes(1);
    expect(processGroup).toHaveBeenCalledWith(expect.any(Array), {
      contractId: "contract-a",
      tokenId: "token-a",
    });
    expect(processor.size).toBe(0);

    const boundedProcessor = new BatchProcessor({
      processGroup,
      flushThreshold: 200,
    });
    for (let index = 0; index < 100; index += 1) {
      boundedProcessor.enqueue({
        contractId: "contract-b",
        tokenId: "token-b",
        amount: String(index + 1),
      });
    }
    expect(boundedProcessor.size).toBe(100);
    await expect(
      boundedProcessor.enqueue({ contractId: "contract-b", tokenId: "token-b", amount: "101" })
    ).rejects.toMatchObject({
      code: "batch_queue_full",
    });
    processor.stop();
    boundedProcessor.stop();
  });
});

describe("batchDeduplicationMiddleware", () => {
  function invoke(middleware, body, handle) {
    return new Promise((resolve, reject) => {
      const response = {
        statusCode: 200,
        status(statusCode) {
          this.statusCode = statusCode;
          return this;
        },
        json(payload) {
          resolve({ status: this.statusCode, body: payload });
          return this;
        },
      };

      try {
        middleware({ body }, response, (error) => {
          if (error) return reject(error);
          return handle(response);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  test("shares the same response for an identical tuple", async () => {
    let createdTransactions = 0;
    const middleware = batchDeduplicationMiddleware({ ttlMs: 60_000 });
    const body = { contractId: "contract-a", tokenId: "token-a", amount: "10" };
    const handle = (response) => {
      createdTransactions += 1;
      setImmediate(() => response.json({ transactionId: "tx-1" }));
    };

    const responses = await Promise.all(
      Array.from({ length: 10 }, () => invoke(middleware, body, handle))
    );

    expect(createdTransactions).toBe(1);
    expect(responses).toHaveLength(10);
    expect(responses.every(({ body: responseBody }) => responseBody.transactionId === "tx-1")).toBe(true);
    expect(middleware.size()).toBe(1);
  });

  test("expires completed entries and allows a later request through", async () => {
    let currentTime = 0;
    let createdTransactions = 0;
    const middleware = batchDeduplicationMiddleware({
      ttlMs: 100,
      now: () => currentTime,
    });
    const body = { contractId: "contract-a", tokenId: "token-a", amount: "10" };
    const handle = (response) => {
      createdTransactions += 1;
      response.json({ transactionId: `tx-${createdTransactions}` });
    };

    await invoke(middleware, body, handle);
    currentTime = 101;
    await invoke(middleware, body, handle);

    expect(createdTransactions).toBe(2);
  });
});
