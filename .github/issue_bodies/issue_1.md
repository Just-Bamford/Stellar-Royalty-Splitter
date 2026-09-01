The backend already has RPC retry logic documented in `RPC_RETRY_CONFIG.md` and implemented through `backend/src/rpc-retry.js`, but RPC failures are not handled consistently across the route integrations.

When Soroban RPC experiences timeouts, connection failures, or temporary unavailability:

* `backend/src/routes/initialize.js` does not consistently apply the retry mechanism to its RPC operations.
* `backend/src/routes/distribute.js` can propagate transient RPC failures as generic API errors.
* `backend/src/routes/secondary-royalty.js` lacks consistent recovery and failure handling for RPC operations.
* Callers may receive insufficient information to distinguish transient infrastructure failures from permanent transaction or validation errors.

**Relevant files:**
- `backend/src/rpc-retry.js` - retry utility
- `backend/src/routes/initialize.js` - missing consistent retry integration
- `backend/src/routes/distribute.js` - missing consistent retry integration
- `backend/src/routes/secondary-royalty.js` - missing consistent retry integration

## Solution

Integrate the existing RPC retry utility consistently across all relevant Soroban RPC operations in the affected routes.

Transient RPC failures should be retried using the existing retry configuration. Once the retry policy is exhausted, the backend should return an appropriate service-unavailable response instead of treating the failure as a generic internal server error.

Add structured retry logging and expose RPC dependency status through the health/readiness endpoint so operators can identify connectivity problems without exposing internal RPC details.

## Acceptance Criteria

- [ ] All relevant Soroban RPC calls in `initialize.js`, `distribute.js`, and `secondary-royalty.js` use the shared retry utility.
- [ ] RPC timeouts and transient network failures are retried according to the existing retry configuration.
- [ ] Retry attempts and final failures are logged with sufficient debugging context.
- [ ] Transient RPC failures return `503 Service Unavailable` after retry exhaustion.
- [ ] Permanent contract, validation, and authorization errors are not incorrectly converted into `503` responses.
- [ ] The health/readiness endpoint reports Soroban RPC connectivity status.
- [ ] Tests cover RPC timeout recovery and retry exhaustion.
- [ ] Existing backend tests continue to pass.

## Note for Contributors

If you're assigned to this issue, write a better description for your PR. Clearly explain what was changed, why it was needed, how it was implemented, and how it was tested.

Reuse the existing RPC retry utility rather than creating route-specific retry implementations. Do not expose RPC credentials, internal infrastructure details, or sensitive transaction data in API responses or logs.
