/**
 * Issue #393: Multiple RPC Endpoint Failover Tests
 * Tests for RPC endpoint health checking, circuit breaker, and failover logic
 */

import { describe, it, beforeEach, afterEach } from "@jest/globals";
import assert from "node:assert";
import {
  _resetRpcEndpointHealth,
  _getRpcEndpointHealth,
  _getHorizonEndpointHealth,
  _setCurrentRpcIndex,
  _setCurrentHorizonIndex,
  checkAllRpcEndpoints,
  checkAllHorizonEndpoints,
  getCurrentRpcUrl,
  getCurrentHorizonUrl,
  _config,
} from "../src/stellar.js";

describe("RPC Endpoint Failover (Issue #393)", () => {
  beforeEach(() => {
    _resetRpcEndpointHealth();
  });

  afterEach(() => {
    _resetRpcEndpointHealth();
  });

  describe("Endpoint Configuration", () => {
    it("should parse multiple RPC URLs from env var", () => {
      assert.ok(_config.RPC_URLS.length >= 1);
      assert.ok(_config.HORIZON_URLS.length >= 1);
    });

    it("should have circuit breaker config", () => {
      assert.strictEqual(_config.CIRCUIT_BREAKER_THRESHOLD, 3);
      assert.strictEqual(_config.CIRCUIT_BREAKER_RESET_MS, 60_000);
      assert.strictEqual(_config.HEALTH_CHECK_INTERVAL_MS, 30_000);
    });
  });

  describe("Health Tracking", () => {
    it("should initialize all endpoints as healthy", () => {
      const rpcHealth = _getRpcEndpointHealth();
      const horizonHealth = _getHorizonEndpointHealth();

      assert.strictEqual(rpcHealth.size, _config.RPC_URLS.length);
      assert.strictEqual(horizonHealth.size, _config.HORIZON_URLS.length);

      for (const [url, health] of rpcHealth) {
        assert.strictEqual(health.healthy, true);
        assert.strictEqual(health.failCount, 0);
      }

      for (const [url, health] of horizonHealth) {
        assert.strictEqual(health.healthy, true);
        assert.strictEqual(health.failCount, 0);
      }
    });

    it("should reset health tracking", () => {
      _setCurrentRpcIndex(2);
      _setCurrentHorizonIndex(1);
      _resetRpcEndpointHealth();

      const rpcHealth = _getRpcEndpointHealth();
      assert.strictEqual(rpcHealth.size, _config.RPC_URLS.length);
      for (const health of rpcHealth.values()) {
        assert.strictEqual(health.healthy, true);
        assert.strictEqual(health.failCount, 0);
      }
    });
  });

  describe("Current Endpoint Selection", () => {
    it("should return current RPC URL", () => {
      const url = getCurrentRpcUrl();
      assert.ok(typeof url === "string");
      assert.ok(url.length > 0);
    });

    it("should return current Horizon URL", () => {
      const url = getCurrentHorizonUrl();
      assert.ok(typeof url === "string");
      assert.ok(url.length > 0);
    });

    it("should allow manual index setting for testing", () => {
      _setCurrentRpcIndex(0);
      assert.strictEqual(getCurrentRpcUrl(), _config.RPC_URLS[0]);

      if (_config.RPC_URLS.length > 1) {
        _setCurrentRpcIndex(1);
        assert.strictEqual(getCurrentRpcUrl(), _config.RPC_URLS[1]);
      }
    });
  });

  describe("Health Check Functions", () => {
    it("should check all RPC endpoints", async () => {
      const results = await checkAllRpcEndpoints();
      assert.ok(Array.isArray(results));
      assert.strictEqual(results.length, _config.RPC_URLS.length);

      for (const result of results) {
        assert.ok(result.url);
        assert.ok(typeof result.healthy === "boolean");
        assert.ok(typeof result.responseTimeMs === "number");
      }
    });

    it("should check all Horizon endpoints", async () => {
      const results = await checkAllHorizonEndpoints();
      assert.ok(Array.isArray(results));
      assert.strictEqual(results.length, _config.HORIZON_URLS.length);

      for (const result of results) {
        assert.ok(result.url);
        assert.ok(typeof result.connected === "boolean");
        assert.ok(typeof result.responseTimeMs === "number");
      }
    });
  });

  describe("Backwards Compatibility", () => {
    it("should fallback to single URL env var if set", () => {
      assert.ok(_config.RPC_URL);
      assert.ok(_config.HORIZON_URL);
    });
  });
});
