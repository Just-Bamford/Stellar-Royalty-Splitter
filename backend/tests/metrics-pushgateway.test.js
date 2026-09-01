import {
  buildPushgatewayUrl,
  createMetricsPusher,
  getPushgatewayConfig,
} from "../src/metrics-pushgateway.js";

describe("Prometheus Pushgateway metrics export", () => {
  test("is disabled when PROMETHEUS_PUSHGATEWAY_URL is not set", () => {
    expect(getPushgatewayConfig({}).enabled).toBe(false);
  });

  test("builds job and instance URL safely", () => {
    const config = {
      enabled: true,
      url: "http://pushgateway:9091",
      job: "royalty api",
      instance: "pod/1",
      intervalMs: 30000,
    };
    expect(buildPushgatewayUrl(config)).toBe(
      "http://pushgateway:9091/metrics/job/royalty%20api/instance/pod%2F1",
    );
  });

  test("pushOnce sends current Prometheus text body", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true });
    const pusher = createMetricsPusher({
      config: {
        enabled: true,
        url: "http://pushgateway:9091",
        job: "api",
        intervalMs: 30000,
      },
      fetchImpl,
      metricsProvider: () => "metric 1\n",
    });

    await pusher.pushOnce();

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://pushgateway:9091/metrics/job/api",
      expect.objectContaining({
        method: "PUT",
        body: "metric 1\n",
      }),
    );
  });

  test("tracks push failures for exponential backoff handling", async () => {
    const pusher = createMetricsPusher({
      config: {
        enabled: true,
        url: "http://pushgateway:9091",
        job: "api",
        intervalMs: 30000,
      },
      fetchImpl: jest.fn().mockResolvedValue({ ok: false, status: 503 }),
      metricsProvider: () => "metric 1\n",
      log: { warn: jest.fn() },
    });

    await expect(pusher.pushOnce()).rejects.toThrow("503");
  });
});
