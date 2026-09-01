## Summary

This pull request closes four operational and product gaps in Stellar Royalty Splitter:

- **#873:** Adds HTTP request counters and latency histograms, Node resource metrics, Prometheus scrape configuration, alert rules, an importable Grafana dashboard, and an operator response map.
- **#850:** Adds a Playwright journey covering wallet connection, contract initialization, funding boundary setup, and distribution submission with deterministic browser-side network mocks.
- **#849:** Adds a fast k6 smoke scenario and portable runner covering smoke, normal, spike, and sustained scenarios with JSON summaries and explicit latency/error thresholds.
- **#846:** Adds optional `NftMetadata` storage and retrieval with artist name, project name, and collection ID fields; supports initialization, admin updates, clearing, and legacy initialization compatibility.

## Validation

- `cargo test --lib nft_metadata_tests` — 2 passed.
- Focused backend metrics test — passed.
- Playwright test discovery — 1 journey test discovered.
- `node --check backend/src/metrics.js` — passed.
- `bash -n backend/load-testing/run.sh` — passed.
- `git diff --check` — passed.

The full Rust integration-test target requires the release WASM artifact at `target/wasm32-unknown-unknown/release/stellar_royalty_splitter.wasm`, which is not present in the clean checkout. Backend-wide test collection also includes unrelated workspace dependency/environment failures; the focused metrics test passes independently.

## Operational notes

Prometheus should scrape `/metrics` and `/api/v1/health` using `monitoring/prometheus.yml`. Grafana can import `monitoring/grafana/royalty-splitter-dashboard.json`. Metadata fields use empty strings to represent omitted values because Soroban SDK 20 does not support `Option<String>` in contract types; the complete metadata record remains optional.

Closes #873
Closes #850
Closes #849
Closes #846
