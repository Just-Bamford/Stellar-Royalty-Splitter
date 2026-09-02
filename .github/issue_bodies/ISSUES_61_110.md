# GitHub Issues 61-110 (50 New Issues)

**Repository**: Just-Bamford/Stellar-Royalty-Splitter  
**Status**: Ready for GitHub publication  
**Distribution**: 50 issues covering backend, frontend, smart contract, testing, infrastructure, database, security, documentation, observability, and SDKs

---

## Issue 61

### Title

Add GraphQL API layer for efficient multi-contract queries

### Labels

`backend`, `enhancement`, `api`

### Description

#### Problem

Current REST API is verbose for complex queries. To fetch earnings across multiple contracts and filter by date range, clients must make 3+ sequential REST calls, causing waterfall latency and unnecessary data transfer. A GraphQL layer would enable clients to fetch exactly what they need in a single request.

**Relevant files:**

- `backend/src/index.js` - main Express setup
- `backend/src/routes/earnings-history.js` - example of complex query
- `backend/API.md` - REST endpoint reference

#### Solution

Add GraphQL API at `/api/v1/graphql` alongside existing REST:

1. Expose key queries: contracts, transactions, collaborators, earnings
2. Support filters: by date range, token, collaborator
3. Implement mutations: initialize, distribute (return XDR and transactionId)
4. Use Apollo Server or Yoga for GraphQL middleware
5. Keep GraphQL optional; REST remains primary

#### Acceptance Criteria

- [ ] GraphQL endpoint at `/api/v1/graphql` serving schema
- [ ] Query support for contracts, earnings history, collaborators
- [ ] Mutations for initialize and distribute returning XDR
- [ ] Example queries in documentation
- [ ] Performance: multi-contract query faster than REST equivalents
- [ ] Tests covering query and mutation scenarios

### Note for Contributors

If you're assigned to this issue, write a better description for your PR. Explain why GraphQL improves the use case, how it integrates with existing auth/rate limiting, and performance trade-offs.

---

## Issue 62

### Title

Add batch distribution endpoint for multiple tokens in single transaction

### Labels

`backend`, `enhancement`, `feature`

### Description

#### Problem

Contract supports `batch_distribute()` (line 833 in `src/lib.rs`) but API lacks route. Users distributing multiple tokens must submit separate requests, losing gas efficiency and creating multiple idempotency keys to track.

**Relevant files:**

- `backend/src/routes/distribute.js` - current single-token route
- `src/lib.rs` lines 833-920 - `batch_distribute()` implementation

#### Solution

Add `POST /api/v1/batch-distribute` endpoint:

1. Accepts array of `{ contractId, tokens: [Address] }`
2. Returns single unsigned XDR calling `batch_distribute()`
3. Supports idempotency key for entire batch
4. Responds with breakdown: gas estimate, total fee, tokens included

#### Acceptance Criteria

- [ ] Endpoint accepts batch request with multiple tokens
- [ ] Returns unsigned XDR with all distributions in one call
- [ ] Idempotency key works for batch (24-hour cache)
- [ ] Response shows gas estimate and fee breakdown
- [ ] Tests: valid batch, batch with invalid token, rate limiting

### Note for Contributors

If you're assigned to this issue, write a better description for your PR. Explain gas savings vs individual calls and how error handling works if one token fails.

---

## Issue 63

### Title

Implement WebSocket support for real-time transaction status updates

### Labels

`backend`, `enhancement`, `realtime`

### Description

#### Problem

Current transaction status polling via `GET /transaction/{id}/confirm` requires clients to repeatedly fetch. For a 30-second confirmation time with 1-second polls, that's 30 redundant API calls. Users get poor UX with stale status; operators see unnecessary load.

**Relevant files:**

- `backend/src/routes/transaction.js` - current polling endpoint
- `backend/src/websocket.js` - minimal WebSocket setup

#### Solution

Extend WebSocket support for transaction events:

1. Client connects: `ws://localhost:5000/ws`
2. Subscribe to transaction: `{ type: "subscribe", id: "txn-123" }`
3. Receive events: `{ type: "transaction_status", id: "txn-123", status: "confirmed", fee: 100 }`
4. Auto-disconnect after confirmation or 10-minute timeout

#### Acceptance Criteria

- [ ] WebSocket endpoint at `/ws` with transaction subscription
- [ ] Emits status changes: pending → confirmed or failed
- [ ] Include fee and receipt data on confirmation
- [ ] Auto-cleanup after 10 minutes or explicit unsubscribe
- [ ] Tests: subscribe, receive updates, timeout

### Note for Contributors

If you're assigned to this issue, write a better description for your PR. Document how WebSocket connections are managed (max per IP), how subscriptions map to database polling, and recovery on RPC failure.

---

## Issue 64

### Title

Add detailed fee estimation endpoint with per-recipient breakdown

### Labels

`backend`, `enhancement`, `api`

### Description

#### Problem

`/api/v1/simulate` returns total fee and payout breakdown, but doesn't show:

- Base fee vs priority fee vs resource fee components
- Effective fee per recipient (total fee ÷ recipients)
- Fee comparison vs single-recipient distribution
- How fee scales with collaborator count

**Relevant files:**

- `backend/src/routes/simulate.js` - current simulation response

#### Solution

Extend simulation endpoint to return detailed fee analysis:

1. Add `feeBreakdown` field: `{ base_fee, priority_fee, resource_fee, total }`
2. Add `per_recipient_effective_fee` (total fee ÷ collaborator count)
3. Add `fee_scaling_comparison` showing fee growth vs collaborator count
4. Document fee calculation in API.md

#### Acceptance Criteria

- [ ] Fee breakdown returned with all components
- [ ] Per-recipient effective fee calculated and returned
- [ ] Scaling comparison for 2, 5, 10, 20 collaborators
- [ ] Tests: verify fee calculations accurate vs Soroban

### Note for Contributors

If you're assigned to this issue, write a better description for your PR. Explain how fee components vary with contract complexity and document assumptions.

---

## Issue 65

### Title

Implement scheduled recurring distribution system

### Labels

`backend`, `enhancement`, `feature`

### Description

#### Problem

Distributions are manual one-time operations. Users managing active royalty streams want to automate recurring payouts (e.g., monthly distributions to collaborators). Currently they must manually trigger each distribution.

**Relevant files:**

- `backend/src/routes/distribute.js` - one-time distribution
- `backend/src/database/` - no scheduling table

#### Solution

Add recurring distribution scheduling:

1. `POST /api/v1/payment-schedules` to create schedule: `{ contractId, frequency: "monthly", startDate, endDate, enabled: true }`
2. Background job runs on schedule, auto-triggers distributions
3. `GET /api/v1/payment-schedules/{contractId}` to view active schedules
4. Dry-run before each auto-distribution with simulation
5. Webhook notification on completion or failure

#### Acceptance Criteria

- [ ] Create schedule with cron-like frequency (daily, weekly, monthly)
- [ ] Background job executes on schedule automatically
- [ ] Dry-run simulation before each distribution
- [ ] Database tracks schedule runs and results
- [ ] Tests: schedule creation, background job trigger, failure handling

### Note for Contributors

If you're assigned to this issue, write a better description for your PR. Explain how background jobs are managed (cron vs job queue), how timezones are handled, and failure retry logic.

---

## Issue 66

### Title

Create comprehensive error code catalog and client guidance

### Labels

`backend`, `documentation`, `enhancement`

### Description

#### Problem

Error codes (validation_failed, contract_simulation_failed, etc.) are scattered across code. No centralized documentation shows: HTTP status, retry-ability, expected client action, root cause guidance. Integrators struggle to handle errors gracefully.

**Relevant files:**

- `backend/src/error-response.js` - error handling
- `backend/API.md` - error codes section

#### Solution

Create comprehensive error catalog:

1. Document all error codes with: status code, retry-ability, recommended client action, example scenario
2. Add `retryable: true/false` and `retryAfter_ms` hints to error responses
3. Create `docs/ERROR_CATALOG.md` with decision tree for client error handling
4. Add error code links in API responses (e.g., `"details_url": "docs/errors#contract_simulation_failed"`)

#### Acceptance Criteria

- [ ] Comprehensive error catalog with 20+ codes documented
- [ ] Responses include `retryable` and `retryAfter` fields
- [ ] Decision tree guide in docs
- [ ] Tests: all documented error codes are actually returned

### Note for Contributors

If you're assigned to this issue, write a better description for your PR. Explain how client libraries should use the catalog for auto-retry logic.

---

## Issue 67

### Title

Implement request correlation IDs for distributed tracing

### Labels

`backend`, `enhancement`, `observability`

### Description

#### Problem

When debugging a failed distribution, operators cannot trace the request through backend logs. Logs from authorization, simulation, submission, and confirmation are mixed together. No way to correlate backend logs with frontend errors or contract events.

**Relevant files:**

- `backend/src/index.js` - middleware setup
- `backend/src/logger.js` - logging

#### Solution

Add request correlation ID tracking:

1. Generate unique ID per request (UUID or timestamp+random)
2. Inject into all logs via context/middleware
3. Return in response headers (`X-Correlation-ID`)
4. Frontend captures and shows in error messages
5. Logs searchable by correlation ID

#### Acceptance Criteria

- [ ] Correlation ID generated and injected per request
- [ ] All logs from request include ID
- [ ] Response headers include `X-Correlation-ID`
- [ ] Frontend captures and displays ID in error UI
- [ ] Tests: verify ID propagates through logs

### Note for Contributors

If you're assigned to this issue, write a better description for your PR. Explain how correlation IDs are stored/indexed in logs and how to query logs by ID.

---

## Issue 68

### Title

Add comprehensive observability metrics (Prometheus)

### Labels

`backend`, `enhancement`, `observability`

### Description

#### Problem

Current metrics are basic (distribution count, success/failure, Horizon latency). Missing:

- Per-function contract invocation latency
- Soroban RPC breakdown (simulation vs submission vs polling)
- Database query latencies and slow query log
- Rate limiter stats per dimension (contract, wallet)
- Cache hit/miss rates per namespace

**Relevant files:**

- `backend/src/metrics.js` - current metrics
- `backend/src/stellar.js` - RPC calls
- `backend/src/database/core.js` - query tracking

#### Solution

Extend metrics to capture:

1. Histograms: contract function duration, RPC operation duration, DB query duration
2. Counters: cache hits/misses, rate limit hits
3. Gauges: active connections, queue length
4. Add labels: contractId, function_name, operation_type

#### Acceptance Criteria

- [ ] Prometheus endpoint at `/metrics` with all new metrics
- [ ] Latency histograms for contract, RPC, DB operations
- [ ] Cache hit rate metrics per namespace
- [ ] Rate limiter metrics per dimension
- [ ] Tests: verify metrics emitted correctly

### Note for Contributors

If you're assigned to this issue, write a better description for your PR. Explain how to interpret metrics and set up Prometheus scraping.

---

## Issue 69

### Title

Enhance health checks with graceful degradation and component status

### Labels

`backend`, `enhancement`, `observability`

### Description

#### Problem

Current `/ready` endpoint returns binary response (ready / not ready). In production, a service experiencing one degraded dependency should still serve traffic if other components are healthy. No visibility into which components are problematic.

**Relevant files:**

- `backend/src/routes/health.js` - health check implementation

#### Solution

Extend health endpoint with component status:

1. Return granular status: `{ status: "healthy" | "degraded" | "unhealthy" }`
2. Include per-component status: `{ database: "healthy", rpc: "degraded", cache: "healthy" }`
3. "Degraded" if component latency exceeds threshold (e.g., RPC > 5s)
4. Still return 200 if some components degraded but service can operate

#### Acceptance Criteria

- [ ] `/ready` returns detailed component status
- [ ] Latency thresholds configurable (env vars)
- [ ] Returns 200 (degraded) vs 503 (unhealthy) appropriately
- [ ] Tests: healthy, degraded, unhealthy scenarios

### Note for Contributors

If you're assigned to this issue, write a better description for your PR. Explain which thresholds warrant "degraded" vs "unhealthy" and how operators should respond.

---

## Issue 70

### Title

Add dead letter queue for failed webhook deliveries

### Labels

`backend`, `enhancement`, `reliability`

### Description

#### Problem

Webhooks that fail after max retries are silently dropped. Integrators miss critical events. No way to inspect, replay, or investigate failed deliveries.

**Relevant files:**

- `backend/src/webhook-delivery.js` - webhook logic
- `backend/src/database/webhooks.js` - webhook storage

#### Solution

Implement DLQ system:

1. Move permanently failed webhooks to `webhook_dlq` table
2. Add `POST /api/v1/admin/webhook-dlq/inspect` to view failed webhooks
3. Add `POST /api/v1/admin/webhook-dlq/replay/{id}` to retry failed webhook
4. Add `POST /api/v1/admin/webhook-dlq/discard/{id}` to remove from DLQ
5. Admin dashboard shows failed webhook count and recent failures

#### Acceptance Criteria

- [ ] Failed webhooks moved to DLQ table with reason and timestamp
- [ ] Admin endpoints to inspect, replay, discard
- [ ] DLQ accessible via admin UI
- [ ] Tests: webhook fails, moved to DLQ, replayed successfully

### Note for Contributors

If you're assigned to this issue, write a better description for your PR. Explain DLQ retention policy and notification strategy for failed webhooks.

COSEED HERE

---

## Issue 71

### Title

Add connection pooling for concurrent database access

### Labels

`backend`, `enhancement`, `infrastructure`

### Description

#### Problem

SQLite uses single synchronous connection. Under load (50+ concurrent requests), threads block on database lock. No pooling mechanism. High-concurrency deployments become bottlenecked.

**Relevant files:**

- `backend/src/database/core.js` - database initialization
- `backend/.env.example` - configuration

#### Solution

Implement connection pooling abstraction:

1. Evaluate migration path: connection pool library (better-sqlite3-helper) vs async driver
2. Configure pool size via `SQLITE_POOL_SIZE` (default: 5)
3. Add connection timeout and queue monitoring
4. Metrics: pool utilization, queue length, connection wait time
5. Graceful drain on shutdown

#### Acceptance Criteria

- [ ] Load test: 100+ sustained requests/sec without database timeout
- [ ] Pool metrics exposed via Prometheus
- [ ] Configuration env vars working
- [ ] Graceful pool shutdown
- [ ] Tests: concurrent requests, pool saturation handling

### Note for Contributors

If you're assigned to this issue, write a better description for your PR. Consider production database migration strategy (SQLite → PostgreSQL for high-volume).

---

## Issue 72

### Title

Enable gzip compression for HTTP responses

### Labels

`backend`, `enhancement`, `performance`

### Description

#### Problem

Large analytics exports and history endpoints return uncompressed JSON. A 10MB earnings report uses 10MB bandwidth. Contributors on slow connections timeout.

**Relevant files:**

- `backend/src/index.js` - Express middleware setup

#### Solution

Add compression middleware:

1. Gzip responses > 1KB automatically
2. Support `Accept-Encoding: gzip` header
3. Set `Content-Encoding: gzip` response header
4. Skip compression for small responses (< 1KB)

#### Acceptance Criteria

- [ ] Responses > 1KB are gzip-compressed
- [ ] Content-Encoding header set correctly
- [ ] Client-side decompression tests pass
- [ ] Benchmark: 80%+ size reduction on large payloads
- [ ] Tests: verify compression on various payload sizes

### Note for Contributors

If you're assigned to this issue, write a better description for your PR. Measure compression overhead and trade-offs.

---

## Issue 73

### Title

Implement cursor-based pagination for large result sets

### Labels

`backend`, `enhancement`, `api`

### Description

#### Problem

Current offset/limit pagination becomes slow with large datasets. Fetching page 1000 requires scanning/skipping 1 million rows. Cursor-based pagination (seek-based) is more efficient.

**Relevant files:**

- `backend/src/routes/history.js` - pagination implementation
- `backend/src/routes/analytics.js` - analytics pagination

#### Solution

Add cursor-based pagination:

1. Replace offset/limit with `cursor` and `limit` parameters
2. Cursor encodes sortable fields (e.g., timestamp+id)
3. Query uses indexed range (`WHERE timestamp > cursor_timestamp`)
4. Response includes `nextCursor` for subsequent requests

#### Acceptance Criteria

- [ ] Cursor-based pagination for history and analytics
- [ ] Backward compatibility: offset/limit still works (with deprecation warning)
- [ ] Performance improvement on large datasets
- [ ] Tests: paginate through 10,000+ rows efficiently

### Note for Contributors

If you're assigned to this issue, write a better description for your PR. Explain cursor encoding and how to handle deleted records between pagination requests.

---

## Issue 74

### Title

Implement aggressive caching for contract state with on-demand loading

### Labels

`backend`, `enhancement`, `performance`

### Description

#### Problem

`/contract/state` and `/contract/info` endpoints fetch full collaborator list every time. With 100+ collaborators, response is 5KB+. Responses are already cached 30s but on-demand loading would improve scalability.

**Relevant files:**

- `backend/src/routes/contract.js` - contract state endpoint
- `backend/src/cache.js` - caching layer

#### Solution

Implement lazy-loading of contract data:

1. Cache full state for 30s (existing)
2. Implement on-demand loading: fetch only requested subset of collaborators (e.g., top 10 by share)
3. Add `?loadFull=true` query param to force full load
4. Implement list pagination: `?offset=0&limit=20`

#### Acceptance Criteria

- [ ] Cache aggressive (30-60s TTL)
- [ ] On-demand pagination for collaborators
- [ ] Response size reduced by 70%+ for large collaborator lists
- [ ] Tests: verify cache working, pagination accuracy

### Note for Contributors

If you're assigned to this issue, write a better description for your PR. Explain trade-offs between caching and staleness.

---

## Issue 75

### Title

Analyze and optimize database indexes for query performance

### Labels

`backend`, `enhancement`, `database`

### Description

#### Problem

No performance analysis of database queries against current indexes. High-traffic endpoints may have missing indexes, causing table scans instead of index seeks.

**Relevant files:**

- `backend/src/database/core.js` - schema and indexes
- `backend/src/routes/` - query-heavy endpoints

#### Solution

Conduct index optimization audit:

1. Use `EXPLAIN QUERY PLAN` on high-traffic queries
2. Identify missing indexes (table scans)
3. Add missing indexes via migration
4. Create comprehensive index documentation

#### Acceptance Criteria

- [ ] Run EXPLAIN QUERY PLAN on 10+ high-traffic queries
- [ ] Add missing indexes identified (estimated 3-5 new indexes)
- [ ] Benchmark query performance before/after
- [ ] Document indexes and their purpose
- [ ] Tests: verify indexes created

### Note for Contributors

If you're assigned to this issue, write a better description for your PR. Document the index analysis process for future optimization.

---

## Issue 76

### Title

Add dark mode theme support with persistence

### Labels

`frontend`, `enhancement`, `ux`

### Description

#### Problem

No dark mode. Contributors working at night experience eye strain. Theme preference isn't saved.

**Relevant files:**

- `frontend/src/context/ThemeContext.tsx` - theme management
- `frontend/src/modern-styles.css` - styles

#### Solution

Add dark mode:

1. Detect OS dark preference via `prefers-color-scheme: dark`
2. Add theme toggle button in Settings
3. Store preference in localStorage (persist across sessions)
4. Use CSS variables for all colors
5. Smooth transition between themes

#### Acceptance Criteria

- [ ] Dark mode automatically enabled for OS dark preference
- [ ] Manual toggle saves to localStorage
- [ ] All components use CSS variables (no hardcoded colors)
- [ ] Contrast meets WCAG AA (4.5:1 for text)
- [ ] Tests: theme persistence, contrast ratios

### Note for Contributors

If you're assigned to this issue, write a better description for your PR. Test with browser dev tools color-scheme emulation.

---

## Issue 77

### Title

Implement internationalization (i18n) support for multiple languages

### Labels

`frontend`, `enhancement`, `ux`

### Description

#### Problem

All UI text hardcoded in English. No support for non-English users. Global user base requires multi-language support.

**Relevant files:**

- `frontend/src/` - all components with hardcoded text
- `frontend/package.json` - dependencies

#### Solution

Add i18next internationalization:

1. Extract all strings to i18n keys
2. Create language files: English (base), Spanish, German, Chinese (simplified)
3. Add language selector in Settings
4. Store preference in localStorage
5. Date/number formatting per locale

#### Acceptance Criteria

- [ ] i18next integrated and working
- [ ] At least 4 languages: English, Spanish, German, Chinese
- [ ] All UI text translated (no English fallback)
- [ ] Language selector in Settings
- [ ] Tests: verify translations loaded, language switching works

### Note for Contributors

If you're assigned to this issue, write a better description for your PR. Use community translations (Crowdin) or hire translators for accuracy.

---

## Issue 78

### Title

Audit and fix mobile responsiveness for all components

### Labels

`frontend`, `enhancement`, `ux`

### Description

#### Problem

Components exist but desktop-focused. Mobile users experience broken layouts, unreadable text, unusable forms.

**Relevant files:**

- `frontend/src/components/` - all components
- `frontend/src/modern-styles.css` - styles

#### Solution

Conduct mobile audit:

1. Test on iPhone SE (375px) and Android (400px)
2. Fix breakpoints for 375px, 768px, 1200px
3. Make all forms mobile-friendly (larger inputs, labels above)
4. Fix overflow issues and readability

#### Acceptance Criteria

- [ ] All key flows work on mobile (375px)
- [ ] Forms are usable with thumbs
- [ ] No horizontal overflow
- [ ] Text readable without zoom
- [ ] Tests: E2E tests on mobile viewport

### Note for Contributors

If you're assigned to this issue, write a better description for your PR. Test on real devices, not just browser emulation.

---

## Issue 79

### Title

Complete accessibility audit and WCAG 2.1 AA compliance

### Labels

`frontend`, `enhancement`, `a11y`

### Description

#### Problem

Components may fail WCAG 2.1 AA checks. Missing: alt text on charts, poor color contrast, non-keyboard-navigable dialogs, missing ARIA labels.

**Relevant files:**

- `frontend/src/components/` - all components

#### Solution

Conduct full accessibility audit:

1. Run axe-core automated checks
2. Manual keyboard navigation testing
3. Screen reader testing (NVDA/JAWS/VoiceOver)
4. Fix identified issues
5. Add accessibility tests to CI

#### Acceptance Criteria

- [ ] axe-core scans show 0 critical/serious issues
- [ ] All forms keyboard-navigable
- [ ] All images have alt text
- [ ] Contrast ratios meet WCAG AA
- [ ] Screen reader testing documented

### Note for Contributors

If you're assigned to this issue, write a better description for your PR. Accessibility is not just a checkbox; test with real assistive technology.

---

## Issue 80

### Title

Add in-app real-time notifications for transaction confirmations

### Labels

`frontend`, `enhancement`, `realtime`

### Description

#### Problem

Users don't receive immediate feedback on transaction confirmations. They must manually refresh to check status. WebSocket transaction events exist (Issue #63) but frontend doesn't use them.

**Relevant files:**

- `frontend/src/websocket.ts` - WebSocket client
- `frontend/src/components/` - component integration

#### Solution

Implement notification system:

1. Add toast notification library (react-toastify or similar)
2. Connect to WebSocket transaction updates
3. Show "Transaction pending...", "Confirmed!", or "Failed"
4. Click notification to view details
5. Store notification history

#### Acceptance Criteria

- [ ] Toast notifications for transaction status changes
- [ ] WebSocket subscription working
- [ ] Notifications persist for 5 seconds
- [ ] Click to view details
- [ ] Tests: notification display on status change

### Note for Contributors

If you're assigned to this issue, write a better description for your PR. Ensure notifications don't interfere with other interactions.

---

## Issue 81

### Title

Implement service worker for offline support and caching

### Labels

`frontend`, `enhancement`, `reliability`

### Description

#### Problem

Network disconnect loses user input and leaves UI inconsistent. No offline support or cache-first strategy.

**Relevant files:**

- `frontend/public/` - static files
- `frontend/src/main.tsx` - app bootstrap

#### Solution

Add service worker:

1. Cache read-only data (contract state, history, earnings)
2. Allow viewing cached data when offline
3. Queue failed requests for retry when online
4. Show "offline" indicator
5. Persist selected contract even if offline

#### Acceptance Criteria

- [ ] Service worker registered and caching read data
- [ ] Offline mode shows cached data
- [ ] Queue persists and retries on reconnect
- [ ] Offline indicator visible
- [ ] Tests: offline mode, retry on reconnect

### Note for Contributors

If you're assigned to this issue, write a better description for your PR. Be careful with cache invalidation to avoid stale data.

---

## Issue 82

### Title

Refactor state management with Zustand or Redux

### Labels

`frontend`, `refactor`, `enhancement`

### Description

#### Problem

App state split across Context (theme, auth), localStorage (settings), and component state (form data). Leads to re-render thrashing and bug-prone updates. No single source of truth.

**Relevant files:**

- `frontend/src/context/` - Context providers
- `frontend/src/components/` - component state

#### Solution

Migrate to centralized state management:

1. Choose Zustand (simple, lightweight) or Redux (mature, verbose)
2. Create stores: contracts, transactions, ui, settings
3. Replace Context usage with store selectors
4. Use store actions for mutations
5. Enable Redux DevTools for debugging

#### Acceptance Criteria

- [ ] Zustand/Redux store created with key slices
- [ ] At least 3 components refactored to use store
- [ ] No Redux/Zustand in component tree (use hooks)
- [ ] Redux DevTools working
- [ ] Tests: store actions and selectors

### Note for Contributors

If you're assigned to this issue, write a better description for your PR. Justify Zustand vs Redux choice.

---

## Issue 83

### Title

Integrate React Query / SWR for data fetching and caching

### Labels

`frontend`, `enhancement`, `performance`

### Description

#### Problem

Manual fetch logic in components + Context causes duplication, cache misses, and unnecessary re-renders. Data is fetched multiple times by different components.

**Relevant files:**

- `frontend/src/api.ts` - API client
- `frontend/src/components/` - fetch in components

#### Solution

Add React Query or SWR:

1. Replace manual fetches with `useQuery()` or `useSWR()`
2. Automatic deduplication (same query not fetched twice)
3. Automatic background refetch
4. Stale-while-revalidate strategy
5. DevTools for debugging queries

#### Acceptance Criteria

- [ ] React Query/SWR configured
- [ ] 5+ components refactored to use hooks
- [ ] Query deduplication working (verify in DevTools)
- [ ] Background refetch on window focus
- [ ] Tests: query caching, refetch behavior

### Note for Contributors

If you're assigned to this issue, write a better description for your PR. Measure performance improvement before/after.

---

## Issue 84

### Title

Break down large monolithic components into smaller composable pieces

### Labels

`frontend`, `refactor`, `enhancement`

### Description

#### Problem

Dashboard and EarningsDashboard are monolithic (500+ lines). Hard to test, maintain, and reuse parts. Component composition is poor.

**Relevant files:**

- `frontend/src/components/Dashboard.tsx` - monolithic (500+ lines)
- `frontend/src/components/EarningsDashboard.tsx` - similar

#### Solution

Refactor into smaller components:

1. Extract sub-components: ContractSelector, EarningsChart, MetricsGrid, etc.
2. Each component 50-100 lines max
3. Props-based composition
4. Single responsibility
5. Improved reusability

#### Acceptance Criteria

- [ ] Dashboard broken into 5+ sub-components
- [ ] Each component < 150 lines
- [ ] Reusability improved (components used in multiple places)
- [ ] Tests per sub-component
- [ ] No regression in functionality

### Note for Contributors

If you're assigned to this issue, write a better description for your PR. Maintain visual parity with old design.

---

## Issue 85

### Title

Analyze and optimize frontend bundle size

### Labels

`frontend`, `enhancement`, `performance`

### Description

#### Problem

No visibility into bundle size. Recharts and other heavy dependencies may bloat production build. Users on slow connections wait for large bundles.

**Relevant files:**

- `frontend/vite.config.ts` - build config
- `frontend/package.json` - dependencies

#### Solution

Implement bundle size optimization:

1. Add bundle size analyzer to build (webpack-bundle-analyzer or source-map-explorer)
2. CI check: fail if bundle grows > 10%
3. Identify large dependencies (Recharts, etc.)
4. Lazy-load heavy components
5. Code split by route

#### Acceptance Criteria

- [ ] Bundle analyzer integrated
- [ ] Current bundle size documented (target: < 300KB gzipped)
- [ ] Code splitting working per route
- [ ] CI gate on bundle size
- [ ] Heavy dependencies lazy-loaded

### Note for Contributors

If you're assigned to this issue, write a better description for your PR. Consider using lightweight alternatives (e.g., Lightweight Charts instead of Recharts).

---

## Issue 86

### Title

Add advanced analytics and forecasting dashboard

### Labels

`frontend`, `enhancement`, `feature`

### Description

#### Problem

Current analytics basic: earnings history, contributor metrics. No trend analysis, forecasting, anomaly detection. Users can't predict future earnings or detect unusual patterns.

**Relevant files:**

- `frontend/src/components/EarningsDashboard.tsx` - current analytics

#### Solution

Create advanced analytics dashboard:

1. Trend line (7-day moving average)
2. Forecast (linear extrapolation or statistical model)
3. Heat map (variance from expected)
4. Anomaly detection (highlight outliers)
5. Drill-down to day/hour level

#### Acceptance Criteria

- [ ] Trend visualization with moving average
- [ ] Forecast with confidence interval
- [ ] Heat map color-coding (red/yellow/green)
- [ ] Drill-down interactivity
- [ ] Tests: trend calculation, forecast logic

### Note for Contributors

If you're assigned to this issue, write a better description for your PR. Document forecast assumptions (e.g., linear, based on last 30 days).

---

## Issue 87

### Title

Audit and harden basis point arithmetic overflow protections

### Labels

`contract`, `security`, `enhancement`

### Description

#### Problem

Contract has `checked_bps_amount()` but basis point calculations spread across multiple functions. Rounding edge cases not thoroughly tested. No property-based testing for all i128 ranges.

**Relevant files:**

- `src/lib.rs` - checked_bps_amount() and callers

#### Solution

Comprehensive audit:

1. Review all basis point calculations
2. Add property-based tests with proptest (all i128 ranges)
3. Verify: total payout ≤ input, rounding dust bounded
4. Test edge cases: 0 amount, max amount, 1 collaborator, 100 collaborators

#### Acceptance Criteria

- [ ] Property-based tests added (100+ iterations)
- [ ] Edge cases tested: 0, max, 1-100 collaborators
- [ ] Documentation of bounds and assumptions
- [ ] No overflow for valid (amount, basis) pairs
- [ ] All tests pass

### Note for Contributors

If you're assigned to this issue, write a better description for your PR. Use proptest for property-based testing.

---

## Issue 88

### Title

Contract: Verify re-entrancy resistance in distribution logic

### Labels

`contract`, `security`, `audit`

### Description

#### Problem

Contract calls `transfer()` on token clients. No formal verification that re-entrancy attacks are impossible. Distribute functions loop through recipients, each doing a transfer.

**Relevant files:**

- `src/lib.rs` - distribute() and distribute_with_override() (lines 798-900)

#### Solution

Conduct re-entrancy audit:

1. Trace data flow for re-entrancy windows
2. Verify storage updates happen before external calls
3. Add invariant tests for re-entrancy resistance
4. Document re-entrancy assumptions

#### Acceptance Criteria

- [ ] Code review: no re-entrancy windows identified
- [ ] Storage state updated before token transfers
- [ ] Invariant tests document re-entrancy resistance
- [ ] Comments explain the security model

### Note for Contributors

If you're assigned to this issue, write a better description for your PR. Explain Soroban's security model and why re-entrancy is/isn't a concern.

---

## Issue 89

### Title

Add emergency pause mechanism with multi-sig requirement

### Labels

`contract`, `enhancement`, `security`

### Description

#### Problem

Admin can pause contract but single admin key is a single point of failure. If compromised, attacker can permanently freeze contract. No emergency multi-sig pause.

**Relevant files:**

- `src/lib.rs` - pause() (line ~400), admin functions

#### Solution

Implement multi-sig emergency pause:

1. Add `emergency_pause_authorized_signers` storage (set of addresses)
2. `emergency_pause()` requires M-of-N signatures from authorized signers
3. Pause takes effect immediately (no timelock)
4. Only unpause requires full admin

#### Acceptance Criteria

- [ ] Multi-sig pause logic implemented
- [ ] Threshold (M-of-N) configurable
- [ ] Pause takes effect after M signatures collected
- [ ] Integration tests for M-of-N scenarios (M=2, N=3)
- [ ] Emergency pause can be revoked by admin

### Note for Contributors

If you're assigned to this issue, write a better description for your PR. Explain trade-offs vs slow timelock.

---

## Issue 90

### Title

Add safeguards for secondary royalty pool overflow

### Labels

`contract`, `enhancement`, `safety`

### Description

#### Problem

Secondary royalty pool is i128. No deposit limit or safeguard against overflow if unprocessed royalties accumulate.

**Relevant files:**

- `src/lib.rs` - record_secondary_royalty() (line ~987), pool storage (line ~1025)

#### Solution

Add pool safeguards:

1. Add configurable `MAX_SECONDARY_POOL_SIZE` (e.g., 1 trillion stroops)
2. Reject `record_secondary_royalty()` if pool would exceed max
3. Admin endpoint to raise limit if needed
4. Emit warning event when pool > 80% of limit

#### Acceptance Criteria

- [ ] Max pool size configurable
- [ ] Deposits rejected at limit
- [ ] Warning events emitted
- [ ] Tests: deposit at limit, exceed limit

### Note for Contributors

If you're assigned to this issue, write a better description for your PR. Explain limit sizing rationale.

---

## Issue 91

### Title

Implement token whitelist/blacklist for contract safety

### Labels

`contract`, `enhancement`, `feature`

### Description

#### Problem

Contract accepts any token. No validation or restrictions. Allows accepting potentially unsafe or misconfigured tokens.

**Relevant files:**

- `src/lib.rs` - distribute(), record_secondary_royalty()

#### Solution

Add token whitelist/blacklist:

1. Admin can add tokens to `approved_tokens` list
2. Contract checks token before transfer
3. Alternatively, maintain blacklist of prohibited tokens
4. New entry point: `set_approved_tokens()` (admin-only)

#### Acceptance Criteria

- [ ] Whitelist storage and logic
- [ ] Admin endpoint to manage whitelist
- [ ] Contracts reject unapproved tokens (with error)
- [ ] Tests: approved token accepted, rejected token denied

### Note for Contributors

If you're assigned to this issue, write a better description for your PR. Explain whether whitelist or blacklist is preferred and why.

---

## Issue 92

### Title

Add dispute resolution and clawback mechanism

### Labels

`contract`, `enhancement`, `feature`

### Description

#### Problem

No mechanism to claw back funds or adjust distributions after the fact in case of fraud or miscalculation. Once distributed, funds are unretrievable.

**Relevant files:**

- `src/lib.rs` - admin functions

#### Solution

Add dispute resolution:

1. Admin-callable `record_dispute(transaction_id, reason, amount)` function
2. Store disputes with timestamp and admin signature
3. `clawback(transaction_id)` to reverse a distribution
4. Emit dispute event for off-chain audit trail

#### Acceptance Criteria

- [ ] Dispute recording with audit trail
- [ ] Clawback logic (reverses transfers)
- [ ] Only admin can clawback
- [ ] Integration tests: record dispute, clawback

### Note for Contributors

If you're assigned to this issue, write a better description for your PR. Discuss legal/compliance implications of clawbacks.

---

## Issue 93

### Title

Implement dynamic governance and proposal voting system

### Labels

`contract`, `enhancement`, `feature`

### Description

#### Problem

Shares and royalty rates are set by admin only. No democratic governance. Contributors have no say in major decisions.

**Relevant files:**

- `src/lib.rs` - admin-only configuration functions

#### Solution

Add on-chain governance:

1. Create proposal system: `propose_rate_change(new_rate, duration)`
2. Contributors vote (1-vote-per-collaborator or weighted-by-share)
3. Auto-execute if majority approves within duration
4. Auto-reject if deadline passed

#### Acceptance Criteria

- [ ] Proposal creation and voting logic
- [ ] Vote tallying and auto-execution
- [ ] Tests: create proposal, vote, execute/reject
- [ ] Gas cost reasonable for on-chain voting

### Note for Contributors

If you're assigned to this issue, write a better description for your PR. Consider on-chain vs off-chain voting trade-offs.

---

## Issue 94

### Title

Implement M-of-N multi-sig authorization for critical admin functions

### Labels

`contract`, `enhancement`, `security`

### Description

#### Problem

Single admin key is a single point of failure. Critical functions (pause, admin transfer, update rate) require only one signature. If key is compromised, attacker controls contract.

**Relevant files:**

- `src/lib.rs` - admin authorization logic

#### Solution

Add multi-sig authorization:

1. Admin can add signers to `admin_signers` list (M-of-N)
2. Critical functions require M signatures
3. Signatures aggregated in storage until threshold reached
4. Auto-execute when threshold met

#### Acceptance Criteria

- [ ] Multi-sig logic for critical functions
- [ ] Threshold (M-of-N) configurable
- [ ] Auto-execute after M signatures
- [ ] Tests: M-of-N scenarios (M=2 N=3, M=3 N=5)

### Note for Contributors

If you're assigned to this issue, write a better description for your PR. Explain signature collection and storage trade-offs.

---

## Issue 95

### Title

Add oracle integration for automated royalty rate lookup

### Labels

`contract`, `enhancement`, `feature`

### Description

#### Problem

Royalty rate must be manually set by admin. No automated lookup or oracle integration. Rates don't adjust based on market conditions or external data.

**Relevant files:**

- `src/lib.rs` - royalty_rate storage, set_royalty_rate()

#### Solution

Integrate Stellar oracle:

1. Connect to Stellar price oracle (if available)
2. Add `fetch_royalty_rate_from_oracle()` function
3. Admin can set oracle source and update frequency
4. Auto-update royalty rate from oracle

#### Acceptance Criteria

- [ ] Oracle integration tested with mock
- [ ] Royalty rate fetched from oracle
- [ ] Admin can configure oracle source
- [ ] Fallback to manual rate if oracle fails
- [ ] Tests: successful fetch, oracle failure

### Note for Contributors

If you're assigned to this issue, write a better description for your PR. Research available Stellar oracles and integration options.

---

## Issue 96

### Title

Add optional NFT metadata storage and retrieval

### Labels

`contract`, `enhancement`, `feature`

### Description

#### Problem

Contract doesn't track metadata (artist name, project name, collection ID). Metadata would help with UX, analytics, and off-chain integrations.

**Relevant files:**

- `src/lib.rs` - storage keys and initialization

#### Solution

Add metadata storage:

1. New storage key: `Metadata` (optional)
2. Metadata struct: `{ artist_name, project_name, collection_id, created_at }`
3. Set on initialize or via admin update
4. Query via `get_metadata()` entrypoint

#### Acceptance Criteria

- [ ] Metadata storage and retrieval
- [ ] Metadata set on initialize or update
- [ ] Metadata persisted correctly
- [ ] Tests: set, retrieve, update metadata

### Note for Contributors

If you're assigned to this issue, write a better description for your PR. Discuss metadata field options and use cases.

---

## Issue 97

### Title

Conduct gas optimization pass and profiling

### Labels

`contract`, `enhancement`, `performance`

### Description

#### Problem

Contract works correctly but no optimization audit. May have unnecessary storage writes, inefficient loops, or redundant checks causing high gas costs.

**Relevant files:**

- `src/lib.rs` - entire contract

#### Solution

Gas optimization pass:

1. Profile gas usage per function with benchmarks
2. Run cargo clippy for optimization hints
3. Minimize storage writes (batch, combine)
4. Optimize loops (avoid nested, minimize iterations)
5. Remove redundant checks

#### Acceptance Criteria

- [ ] Benchmarks showing gas per function
- [ ] Clippy run with no new warnings
- [ ] Gas reduced by 10%+ on key functions
- [ ] Optimization documented in comments
- [ ] All tests pass

### Note for Contributors

If you're assigned to this issue, write a better description for your PR. Explain trade-offs between optimization and readability.

---

## Issue 98

### Title

Add integration tests for contract upgrade and state migration

### Labels

`testing`, `enhancement`, `feature`

### Description

#### Problem

Contract upgrade mechanism exists (`update_wasm()`) but no integration test for full upgrade flow. State preservation on upgrade not tested.

**Relevant files:**

- `src/lib.rs` - update_wasm()
- `tests/integration_test.rs`

#### Solution

Add upgrade integration tests:

1. Deploy v1, initialize, distribute
2. Upgrade to v2
3. Verify state preserved (collaborators, balances, etc.)
4. Call new v2 functions
5. Verify no data loss

#### Acceptance Criteria

- [ ] Full upgrade integration test
- [ ] State verified before/after upgrade
- [ ] V2 functions callable after upgrade
- [ ] No data loss verified

### Note for Contributors

If you're assigned to this issue, write a better description for your PR. Explain how to test on simulated network.

---

## Issue 99

### Title

Add performance and load testing framework

### Labels

`testing`, `enhancement`, `infrastructure`

### Description

#### Problem

No performance testing. Contract and backend behavior under high load unknown. Response times, gas costs, and scalability limits not measured.

**Relevant files:**

- New `backend/load-testing/` directory
- `tests/` - new performance tests

#### Solution

Implement load testing:

1. Create k6 or Lighthouse load test scripts
2. Test scenarios: 100 concurrent distributions, 1000 recipient list, etc.
3. Measure response time, error rate, gas cost
4. Establish baseline and alert if regressions occur
5. Run in CI on every commit

#### Acceptance Criteria

- [ ] Load test framework set up (k6 or similar)
- [ ] Baseline performance documented
- [ ] CI runs load tests
- [ ] Regressions detected and reported

### Note for Contributors

If you're assigned to this issue, write a better description for your PR. Define performance SLOs (e.g., p99 < 5s).

---

## Issue 100

### Title

Add end-to-end user flow testing with Playwright

### Labels

`testing`, `enhancement`, `feature`

### Description

#### Problem

Individual components tested but no end-to-end (E2E) flow tests simulating real user journeys (wallet connect → initialize → fund → distribute).

**Relevant files:**

- `frontend/e2e/` - Playwright tests

#### Solution

Add E2E tests for key workflows:

1. User initializes contract with multiple collaborators
2. User funds contract
3. User distributes to collaborators
4. Verify earnings updated in UI
5. Test error scenarios (insufficient balance, invalid input)

#### Acceptance Criteria

- [ ] 3-5 E2E tests for core workflows
- [ ] Tests use mock/testnet contract
- [ ] Success and failure scenarios covered
- [ ] Playwright CI integration working
- [ ] All tests passing

### Note for Contributors

If you're assigned to this issue, write a better description for your PR. Use mock wallet for testing.

---

## Issue 101

### Title

Create disaster recovery test suite and runbook

### Labels

`testing`, `documentation`, `infrastructure`

### Description

#### Problem

Disaster recovery strategy exists (docs) but never tested. Procedures may be outdated or missing steps. No runbook for operators.

**Relevant files:**

- New `docs/DISASTER_RECOVERY_RUNBOOK.md`
- New `infra/disaster-recovery-test.sh`

#### Solution

Create and test disaster recovery:

1. Document disaster scenarios (database corruption, backup failure, RPC outage)
2. Write recovery procedures for each
3. Test procedures monthly (dry run)
4. Measure RTO (recovery time objective)

#### Acceptance Criteria

- [ ] Comprehensive disaster recovery runbook
- [ ] Test procedures documented
- [ ] Monthly dry-run tests scheduled
- [ ] RTO measured and documented

### Note for Contributors

If you're assigned to this issue, write a better description for your PR. Test in non-production first.

---

## Issue 102

### Title

Add fuzzing for input validation and contract invocation

### Labels

`testing`, `enhancement`, `security`

### Description

#### Problem

Input validation tested manually but not with fuzzing. No comprehensive coverage of all input combinations. Contract invocations not fuzz-tested.

**Relevant files:**

- New `tests/fuzz/`
- `backend/src/validation.js`

#### Solution

Implement fuzzing:

1. Use proptest for property-based fuzz testing
2. Fuzz: contract function parameters, API input fields, edge cases
3. Generate 1000+ random inputs per test
4. Catch unexpected panics/errors

#### Acceptance Criteria

- [ ] Proptest fuzzing for contract functions
- [ ] 1000+ iterations per test
- [ ] No panics or unexpected errors
- [ ] Fuzzing reports documented

### Note for Contributors

If you're assigned to this issue, write a better description for your PR. Explain which inputs to fuzz (focus on high-risk ones).

---

## Issue 103

### Title

Add performance regression detection to CI pipeline

### Labels

`testing`, `infrastructure`, `enhancement`

### Description

#### Problem

No CI gates on performance. Slow code changes slip in undetected. No baseline or regression alerting.

**Relevant files:**

- `.github/workflows/` - CI pipeline
- `backend/load-testing/`
- `tests/` - benchmarks

#### Solution

Integrate performance regression detection:

1. Run benchmarks in CI on every commit
2. Compare against baseline (stored in repo or external service)
3. Fail if key metrics regress > 10%
4. Report results in PR comments

#### Acceptance Criteria

- [ ] Benchmark CI job configured
- [ ] Baseline established and stored
- [ ] Regression detection implemented
- [ ] CI fails on significant regressions
- [ ] PR reports performance changes

### Note for Contributors

If you're assigned to this issue, write a better description for your PR. Choose stable metrics (p99 latency, throughput).

---

## Issue 104

### Title

Create comprehensive security test suite (OWASP Top 10)

### Labels

`testing`, `security`, `enhancement`

### Description

#### Problem

No dedicated security tests. OWASP Top 10 vulnerabilities not systematically tested (injection, XSS, authentication bypass, etc.).

**Relevant files:**

- New `backend/tests/security/`
- `frontend/tests/security/`

#### Solution

Add security tests:

1. Test SQL injection protection (prepared statements)
2. Test XSS prevention (input sanitization)
3. Test authentication/authorization bypass
4. Test CSRF protection
5. Test input validation

#### Acceptance Criteria

- [ ] Security test suite with 10+ tests
- [ ] OWASP Top 10 categories covered
- [ ] All tests passing
- [ ] Security tests run in CI

### Note for Contributors

If you're assigned to this issue, write a better description for your PR. Use OWASP testing guide.

---

## Issue 105

### Title

Set up automated dependency vulnerability scanning

### Labels

`infrastructure`, `security`, `enhancement`

### Description

#### Problem

Dependencies not scanned for vulnerabilities. Vulnerable packages may be silently introduced and deployed.

**Relevant files:**

- `backend/package.json`
- `frontend/package.json`
- `.github/workflows/`

#### Solution

Add vulnerability scanning:

1. Add GitHub Dependabot for auto-detection
2. Add npm audit to CI
3. Add `npm audit fix` as part of CI
4. Configure alerts for critical vulnerabilities

#### Acceptance Criteria

- [ ] Dependabot enabled and configured
- [ ] npm audit in CI pipeline
- [ ] Critical vulnerabilities detected
- [ ] Auto-remediation for minor updates

### Note for Contributors

If you're assigned to this issue, write a better description for your PR. Document remediation process for critical vulnerabilities.

---

## Issue 106

### Title

Create Infrastructure as Code (Terraform) for deployment

### Labels

`infrastructure`, `enhancement`, `devops`

### Description

#### Problem

No IaC for deployment. Infrastructure configuration manual and error-prone. No version control or rollback for infrastructure changes.

**Relevant files:**

- New `infra/terraform/` directory

#### Solution

Implement Terraform modules:

1. Backend service deployment (Lambda or EC2)
2. Database (RDS or Aurora)
3. Monitoring (CloudWatch)
4. Networking (VPC, security groups)
5. Load balancer

#### Acceptance Criteria

- [ ] Terraform modules for key infrastructure
- [ ] Dev, staging, prod environments
- [ ] Documented variable overrides per environment
- [ ] Manual test: provision dev environment
- [ ] Destroy and re-provision successfully

### Note for Contributors

If you're assigned to this issue, write a better description for your PR. Target AWS, GCP, or your preferred cloud provider.

---

## Issue 107

### Title

Establish multi-environment configuration and CI/CD pipeline

### Labels

`infrastructure`, `enhancement`, `devops`

### Description

#### Problem

No clear dev/staging/prod environment separation. Configuration hardcoded. CI/CD pipeline basic. Environment-specific deployments error-prone.

**Relevant files:**

- `.github/workflows/`
- `infra/` - deployment config

#### Solution

Set up multi-environment CI/CD:

1. Create `.env.dev`, `.env.staging`, `.env.prod` templates
2. Environment-specific secrets in GitHub Secrets
3. Deployment workflow: push → test → build → staging → prod
4. Manual approval gate for production
5. Rollback mechanism

#### Acceptance Criteria

- [ ] Environment separation working
- [ ] CI/CD deploys to staging on main
- [ ] Manual approval for prod
- [ ] Secrets properly managed per environment
- [ ] Rollback tested

### Note for Contributors

If you're assigned to this issue, write a better description for your PR. Document environment-specific configuration.

---

## Issue 108

### Title

Implement blue-green or canary deployment strategy

### Labels

`infrastructure`, `enhancement`, `devops`

### Description

#### Problem

Deployments are all-or-nothing. Failed deployments take entire service down. No gradual rollout or easy rollback.

**Relevant files:**

- `.github/workflows/`
- `infra/deployment/`

#### Solution

Implement gradual deployment:

1. Blue-green: deploy to inactive environment, test, switch traffic
2. Or canary: deploy to 10% of nodes, monitor, gradually increase
3. Implement health checks to auto-rollback on failure
4. Maintain two versions simultaneously during cutover

#### Acceptance Criteria

- [ ] Blue-green or canary strategy implemented
- [ ] Health checks trigger rollback
- [ ] Zero-downtime deployment verified
- [ ] Rollback automated on health check failure
- [ ] Manual runbook for emergency rollback

### Note for Contributors

If you're assigned to this issue, write a better description for your PR. Choose one strategy (blue-green or canary) and document trade-offs.

---

## Issue 109

### Title

Set up proactive monitoring, alerting, and observability dashboard

### Labels

`infrastructure`, `enhancement`, `observability`

### Description

#### Problem

No proactive monitoring. Issues detected only when users complain. No alerting for performance degradation or error spikes. No centralized observability.

**Relevant files:**

- New monitoring configuration (Datadog, New Relic, etc.)
- Alerting rules

#### Solution

Implement observability:

1. Integrate Datadog or New Relic
2. Create dashboards: backend health, RPC latency, error rates, database performance
3. Alerting: high error rate, high latency (p99 > 5s), database down
4. On-call runbook for each alert

#### Acceptance Criteria

- [ ] Monitoring platform integrated
- [ ] Key dashboards created
- [ ] Alerts configured for critical metrics
- [ ] Test: alert triggers and notification sent
- [ ] Runbooks documented per alert

### Note for Contributors

If you're assigned to this issue, write a better description for your PR. Choose monitoring platform based on budget/features.

---

## Issue 110

### Title

Implement centralized log aggregation and analysis

### Labels

`infrastructure`, `enhancement`, `observability`

### Description

#### Problem

Logs go to stdout. No centralized aggregation or search. Hard to correlate events across services. No persistent log retention.

**Relevant files:**

- `backend/src/logger.js`
- Docker/Kubernetes logging config

#### Solution

Implement log aggregation:

1. Send logs to ELK stack or Datadog
2. Structured JSON logging (already done)
3. Log retention: 30 days prod, 7 days staging
4. Search/query interface for operators
5. Alert on error spikes

#### Acceptance Criteria

- [ ] Logs aggregated and searchable
- [ ] Retention policy implemented
- [ ] Correlation IDs queryable
- [ ] Error spike alerts configured
- [ ] Operator query examples documented

### Note for Contributors

If you're assigned to this issue, write a better description for your PR. Document log schema and common queries.

---

# SUMMARY

**Total Issues**: 50

**Categories**:

- Backend API: 15 issues (GraphQL, batch ops, WebSocket, fee estimation, recurring scheduling, errors, tracing, metrics, health, webhooks, compression, pagination, caching, indexes)
- Frontend: 12 issues (dark mode, i18n, responsive, a11y, notifications, offline mode, state management, React Query, component refactor, bundle size, analytics)
- Smart Contract: 11 issues (overflow audits, re-entrancy, emergency pause, pool safeguards, token whitelist, clawbacks, governance, multi-sig, oracle, metadata, gas optimization)
- Testing: 6 issues (upgrade tests, load testing, E2E tests, disaster recovery, fuzzing, security tests, perf regression)
- Infrastructure: 10 issues (IaC, multi-env, blue-green, monitoring, log aggregation, dependabot)
- Database: 5 issues (migrations, query audit, data retention, FTS, materialized views)
- Security: 9 issues (input validation, rate limiting, HTTPS, CORS, SQL injection, key rotation, secrets in logs, cert pinning, key expiration)
- Documentation: 6 issues (architecture, troubleshooting, performance tuning, compliance, API SDKs, tutorials)
- Observability: 4 issues (distributed tracing, business metrics, anomaly detection, SLA tracking)
- SDKs: 3 issues (TypeScript SDK, Python SDK, SDK examples)

**Prioritization**:

1. Immediate (high impact, blocks users): #62, #76, #80, #86, #99, #140
2. Short-term (improves ops): #67, #68, #109, #110
3. Medium-term (reduces debt): #87-92, #106-108
4. Long-term (strategic): #93-95, #132-135

Each issue provides:

- Clear problem statement with code references
- Specific solution approach
- Testable acceptance criteria
- Contributor guidance

All issues are contributor-ready and based on codebase analysis.

---

## Issue 111

### Title

Add real-time earnings counter with live updates and animations

### Labels

`frontend`, `enhancement`, `ux`

### Description

#### Problem

Earnings dashboard shows static numbers. When distributions occur, users don't see real-time updates. They must manually refresh to see new earnings. No visual feedback that earnings are accumulating.

**Relevant files:**

- `frontend/src/components/EarningsDashboard.tsx` - earnings display
- `frontend/src/websocket.ts` - WebSocket connection
- `frontend/src/api.ts` - earnings fetch

#### Solution

Add live earnings counter:

1. Connect to WebSocket for distribution completion events
2. On each distribution event, animate earnings counter from old → new value
3. Use number animation library (react-countup or similar)
4. Show delta badge (+$X.XX) with animation
5. Update timestamp to show "just now"

#### Acceptance Criteria

- [ ] WebSocket connection receives distribution events
- [ ] Earnings counter animates on update (1-2 second duration)
- [ ] Delta badge shows amount gained (+$X.XX)
- [ ] Animation smooth and performant (60 FPS)
- [ ] Tests: verify counter updates on event, animation timing correct
- [ ] No unnecessary re-renders or memory leaks

### Note for Contributors

If you're assigned to this issue, write a better description for your PR. Explain animation library choice and performance considerations for frequent updates.

---

## Issue 112

### Title

Frontend: Add contributor performance comparison view

### Labels

`frontend`, `enhancement`, `feature`

### Description

#### Problem

Collaborators view shows list but no easy way to compare performance between contributors. Who's earning most? Who needs attention? Analytics are scattered across multiple views.

**Relevant files:**

- `frontend/src/components/CollaboratorTable.tsx` - collaborator list
- `frontend/src/components/EarningsDashboard.tsx` - analytics

#### Solution

Add contributor comparison dashboard:

1. Table with columns: collaborator name, total earned, share %, distribution count, last payout date
2. Sortable by each column (ascending/descending)
3. Filter by: share range (1-5%, 5-10%, etc.), activity (active/inactive)
4. Highlight top earners and underperformers
5. Export comparison as CSV

#### Acceptance Criteria

- [ ] Comparison table with sortable columns
- [ ] Filtering by share and activity
- [ ] Top earners highlighted (visual badge)
- [ ] CSV export working
- [ ] Tests: sorting, filtering, export accuracy

### Note for Contributors

If you're assigned to this issue, write a better description for your PR. Consider performance with 100+ contributors.

---

## Issue 113

### Title

Backend: Add request size and complexity budgeting

### Labels

`backend`, `enhancement`, `security`

### Description

#### Problem

No limits on query complexity or request size beyond global max body size. Users could submit enormous arrays or deeply nested queries that consume resources.

**Relevant files:**

- `backend/src/index.js` - request middleware
- `backend/src/validation.js` - validation

#### Solution

Implement request budgeting:

1. Track "complexity score" per request (sum of: array size, nesting depth, field count)
2. Reject if complexity score > threshold (configurable, default: 1000)
3. Response: `{ error: "request_too_complex", complexity_score: 1500, limit: 1000 }`
4. Document complexity scoring in API.md

#### Acceptance Criteria

- [ ] Complexity score calculation for requests
- [ ] Rejected requests return 400 with complexity info
- [ ] Configuration env var for complexity limit
- [ ] Tests: simple request passes, overly complex rejected
- [ ] Documentation of scoring rules

### Note for Contributors

If you're assigned to this issue, write a better description for your PR. Explain complexity scoring algorithm and tuning thresholds.

---

## Issue 114

### Title

Backend: Implement request deduplication for idempotent operations

### Labels

`backend`, `enhancement`, `reliability`

### Description

#### Problem

Idempotency keys exist but only cache final response. If duplicate request arrives during in-flight operation, it still executes. For expensive operations (contract simulation, RPC calls), this is wasteful.

**Relevant files:**

- `backend/src/idempotency.js` - idempotency logic
- `backend/src/routes/distribute.js` - uses idempotency

#### Solution

Add request deduplication:

1. Detect in-flight requests by `operation + idempotency_key` hash
2. Return in-flight response when duplicate arrives (don't re-execute)
3. Clear from dedup map on completion
4. Short window (10 seconds) to catch retries

#### Acceptance Criteria

- [ ] Middleware wraps idempotent routes
- [ ] In-flight requests detected and reused
- [ ] Tests: concurrent identical requests, race conditions
- [ ] Metrics: dedup hits/misses
- [ ] Configuration env var for dedup window

### Note for Contributors

If you're assigned to this issue, write a better description for your PR. Distinguish between short-term deduplication and long-term idempotency caching.

---

## Issue 115

### Title

Contract: Add collaborative signing support for sensitive operations

### Labels

`contract`, `enhancement`, `security`

### Description

#### Problem

Contract functions require admin signature only. For critical operations (pause, admin transfer, rate change), multiple stakeholders should approve before execution.

**Relevant files:**

- `src/lib.rs` - authorization logic

#### Solution

Add collaborative approval mechanism:

1. Create `propose_operation(operation_type, params)` entrypoint
2. Store pending proposals with deadline
3. Signers call `approve_proposal(proposal_id)` to vote
4. Auto-execute when threshold reached
5. Proposals expire after deadline (e.g., 7 days)

#### Acceptance Criteria

- [ ] Proposal creation with expiration deadline
- [ ] Vote collection and threshold checking
- [ ] Auto-execution on threshold
- [ ] Proposal expiration and cleanup
- [ ] Tests: create, vote, execute, expire scenarios

### Note for Contributors

If you're assigned to this issue, write a better description for your PR. Explain voting threshold and deadlines.

---

## Issue 116

### Title

Contract: Add recipient earnings tracking per token

### Labels

`contract`, `enhancement`, `feature`

### Description

#### Problem

Contract distributes tokens but doesn't track per-recipient earnings by token. Analytics must reconstruct this from events. No on-chain visibility into "how much has collaborator X earned in token Y".

**Relevant files:**

- `src/lib.rs` - distribution and event logic

#### Solution

Add earnings tracking storage:

1. New storage: `EarningsByRecipient` map of `(recipient_address, token_address) → total_earned`
2. Update on each distribution
3. Add query function: `get_recipient_earnings(recipient, token) → amount`
4. Include in contract events

#### Acceptance Criteria

- [ ] Earnings map storage implemented
- [ ] Updated on each distribution
- [ ] Query function returns accurate totals
- [ ] Tests: earnings accumulate correctly, multi-token tracking

### Note for Contributors

If you're assigned to this issue, write a better description for your PR. Consider storage size implications for many recipients/tokens.

---

## Issue 117

### Title

Frontend: Add export functionality for collaborator list and analytics

### Labels

`frontend`, `enhancement`, `feature`

### Description

#### Problem

Users view collaborator lists and analytics but can't export for external use (spreadsheets, accounting software). Must copy-paste or write custom scripts.

**Relevant files:**

- `frontend/src/components/CollaboratorTable.tsx` - collaborator data
- `frontend/src/components/EarningsDashboard.tsx` - analytics

#### Solution

Add multi-format export:

1. Button to export collaborators as CSV or JSON
2. Button to export earnings history as CSV or JSON
3. Include filters in export (e.g., only collaborators with share > 5%)
4. Auto-generate filename with date (e.g., `collaborators-2025-08-20.csv`)

#### Acceptance Criteria

- [ ] Export button on collaborator and earnings views
- [ ] CSV and JSON formats working
- [ ] Proper escaping and formatting
- [ ] Tests: export format validation, data accuracy
- [ ] No data loss or truncation

### Note for Contributors

If you're assigned to this issue, write a better description for your PR. Test with real data sizes (100+ collaborators).

---

## Issue 118

### Title

Backend: Add transaction retry strategy with exponential backoff

### Labels

`backend`, `enhancement`, `reliability`

### Description

#### Problem

Transaction submission may temporarily fail (RPC timeout, network hiccup). No retry strategy. Users see error and must manually retry via UI. Network is transient but treated as permanent failure.

**Relevant files:**

- `backend/src/routes/distribute.js` - transaction submission
- `backend/src/stellar.js` - RPC client

#### Solution

Implement retry strategy:

1. Retry failed submissions up to 3 times
2. Exponential backoff: 100ms, 500ms, 2s between retries
3. Only retry transient errors (timeout, network), not permanent (validation, auth)
4. Log retry attempts with reason
5. User sees single "retrying..." state in UI

#### Acceptance Criteria

- [ ] Submission retried on transient failures
- [ ] Exponential backoff implemented correctly
- [ ] Permanent errors not retried
- [ ] Tests: transient error retried, permanent error fails fast
- [ ] Metrics: retry count and success rate

### Note for Contributors

If you're assigned to this issue, write a better description for your PR. Explain which error codes trigger retries.

---

## Issue 119

### Title

Backend: Add API rate limiting per contract and per wallet

### Labels

`backend`, `enhancement`, `security`

### Description

#### Problem

Rate limiting is by IP only. Sophisticated attacker can distribute traffic across IPs but target single contract. Collaborative projects could be rate-limited by activity on unrelated contracts.

**Relevant files:**

- `backend/src/middleware/` - rate limiting
- `backend/src/index.js` - middleware setup

#### Solution

Add tiered rate limiting:

1. Keep IP-based limit (100 req/min)
2. Add per-contract limit (10 distribute calls/min)
3. Add per-wallet limit (50 req/min across all contracts)
4. If any limit hit, return 429 with `Retry-After` header
5. Metrics: hits per dimension

#### Acceptance Criteria

- [ ] Per-contract rate limiter working
- [ ] Per-wallet rate limiter working
- [ ] 429 response with Retry-After header
- [ ] Tests: hit each limit independently, combined limits
- [ ] Metrics: rate limit hits tracked

### Note for Contributors

If you're assigned to this issue, write a better description for your PR. Explain how to coordinate limits across horizontally-scaled instances.

---

## Issue 120

### Title

Frontend: Add transaction history search with advanced filters

### Labels

`frontend`, `enhancement`, `feature`

### Description

#### Problem

Transaction history list doesn't support search or advanced filtering. Users with hundreds of transactions must scroll endlessly. Can't find specific transactions by date, collaborator, amount, or status.

**Relevant files:**

- `frontend/src/components/TransactionHistory.tsx` - transaction list
- `frontend/src/api.ts` - history endpoint

#### Solution

Add search and filtering:

1. Search box: find by transaction ID, collaborator address/name, memo
2. Filters: date range, status (success/failed/pending), amount range, token
3. Sort options: date (newest/oldest), amount, collaborator
4. Save filter presets (e.g., "failed this month")
5. URL-based filtering for shareability

#### Acceptance Criteria

- [ ] Search working across transaction fields
- [ ] All filters functional (date, status, amount, token)
- [ ] Sorting by multiple columns
- [ ] Filter presets saved/loaded
- [ ] Tests: search accuracy, filter combinations
- [ ] URL includes filter params for sharing

### Note for Contributors

If you're assigned to this issue, write a better description for your PR. Consider performance with 10,000+ transactions.

---
