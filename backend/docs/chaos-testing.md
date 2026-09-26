# Staging chaos testing

The fault-injection harness in `src/chaos/faultInjection.js` is disabled by default and is intended for staging only.

## Enable a run

```bash
CHAOS_ENABLED=true \
CHAOS_MODES=rpc-timeout,database-unavailable,websocket-drop,latency-spike \
CHAOS_PROBABILITY=0.05 \
CHAOS_LATENCY_MS=5000 \
npm run test:backend -- --runInBand
```

Application boundaries can call `chaos.run(mode, operation, { label })`. The shared Soroban `withTimeout` boundary is already connected, so `rpc-timeout` faults exercise the existing retry and 504 recovery paths. Database and WebSocket faults expose explicit retryable error codes for adapters and reconnection tests.

## Safety and success criteria

- Never enable `CHAOS_ENABLED` in production.
- Use a dedicated staging wallet, database, and RPC endpoint.
- Start with probability ≤ 5% and latency spikes ≤ 5 seconds.
- Monitor error rate, retry rate, WebSocket reconnects, database health, and distribution idempotency.
- A run passes only when injected failures recover without lost distribution records or duplicate payouts.
- Clear the fault controller and verify health endpoints before ending the run.
