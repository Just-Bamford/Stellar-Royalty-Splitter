# ISSUE 7
Backend has rate limiting (`express-rate-limit`) configured with defaults, but the configuration is hardcoded and not well documented. Different endpoints may have different sensitivity (e.g., initialize should be stricter than health checks). Current setup lacks flexibility for operators to tune limits without code changes or clear guidance on recommended values.

**Relevant files:**
- `backend/src/middleware/` - likely rate-limit middleware
- `backend/src/index.js` - middleware wiring

## Solution
Extract rate-limit configuration to environment variables or a dedicated config file. Document default limits for each endpoint category (health, read, write, admin). Add middleware that applies endpoint-specific limits.

## Acceptance Criteria
- [ ] Extract rate-limit configuration from code to environment variables
- [ ] Document recommended limits for health, read, write, and admin endpoints
- [ ] Add separate limiters for initialize, distribute, and read endpoints
- [ ] Add tests verifying rate limits are enforced
- [ ] Write a `RATE_LIMITING.md` guide
- [ ] Verify health/ready endpoints are not rate-limited

## Note
If you're assigned to this issue, write a better description for your PR. Clearly explain what was changed, why it was needed, how it was implemented, and how it was tested.

---

# ISSUE 8
Current API endpoints (`/api/v1/initialize`, `/api/v1/distribute`) return unsigned XDR that the frontend signs and submits. Users have no way to preview the exact payout distribution or detect errors before signing, leading to poor UX when transactions fail.

## Solution
Add a `/api/v1/simulate` endpoint that accepts the same parameters as distribute/initialize but returns detailed simulation results without broadcasting to the network.

## Acceptance Criteria
- [ ] Create `/api/v1/simulate` endpoint with simulation results
- [ ] Endpoint calls Soroban RPC to simulate without broadcasting
- [ ] Response includes simulation result, gas estimate, payout breakdown
- [ ] Update frontend DistributeForm to call simulate and show preview
- [ ] Add error scenarios: insufficient balance, invalid recipient, gas overflow
- [ ] Add integration tests

## Note
If you're assigned to this issue, write a better description for your PR. Clearly explain what was changed, why it was needed, how it was implemented, and how it was tested.

---

# ISSUE 9
The contract uses `checked_bps_amount()` to calculate payout shares safely, but basis point calculations appear across multiple functions. While the core math is safe, edge cases may exist for large amounts or boundary conditions.

## Solution
Conduct a thorough audit of all basis point calculations and add property-based tests to verify correctness across all valid input ranges.

## Acceptance Criteria
- [ ] Review all basis point calculations and document assumptions
- [ ] Add property-based tests using proptest
- [ ] Verify no overflow for max i128 amounts and 10,000 basis points
- [ ] Verify rounding dust is always properly bounded
- [ ] Document audit findings
- [ ] All tests pass

## Note
If you're assigned to this issue, write a better description for your PR. Clearly explain what was changed, why it was needed, how it was implemented, and how it was tested.

---

# ISSUE 10
The InitializeForm component allows users to enter collaborators and shares but provides minimal validation feedback. Users don't see errors until after submission, creating a poor UX.

## Solution
Add real-time validation to InitializeForm with field-level error messages and submit button disabled until form is valid.

## Acceptance Criteria
- [ ] Shares sum validation runs as user types
- [ ] Stellar address format validation for each collaborator
- [ ] Duplicate address detection
- [ ] Clear, actionable error messages
- [ ] Submit button disabled until all validations pass
- [ ] Add unit tests for validation logic

## Note
If you're assigned to this issue, write a better description for your PR. Clearly explain what was changed, why it was needed, how it was implemented, and how it was tested.

---

# ISSUE 11
Backend tests for initialization, distribution, and secondary royalty flows manually set up contract state and mint tokens repeatedly. This boilerplate is repeated across 30+ test files.

## Solution
Create a test utilities module with reusable fixtures for common test scenarios to reduce boilerplate and improve maintainability.

## Acceptance Criteria
- [ ] Create test utilities module with at least 5 fixture functions
- [ ] Refactor at least 3 existing test files using new fixtures
- [ ] Reduce boilerplate by >30%
- [ ] Utilities well-documented with JSDoc
- [ ] Add tests for utilities themselves
- [ ] All existing tests pass

## Note
If you're assigned to this issue, write a better description for your PR. Clearly explain what was changed, why it was needed, how it was implemented, and how it was tested.

---

# ISSUE 12
The contract emits events for distribution and royalty rate changes but not for critical state changes like pause/unpause and admin transfer, limiting auditability.

## Solution
Add event emissions to all critical state change functions with actor, timestamp, and relevant details.

## Acceptance Criteria
- [ ] `pause()` and `unpause()` emit events with actor and timestamp
- [ ] `admin_transfer()` and `accept_admin()` emit events with old/new admin
- [ ] Add integration tests verifying events are emitted correctly
- [ ] Document event schemas
- [ ] Verify no significant gas cost increase

## Note
If you're assigned to this issue, write a better description for your PR. Clearly explain what was changed, why it was needed, how it was implemented, and how it was tested.

---

# ISSUE 13
Users can view earnings history and contributor metrics via API but cannot export this data to CSV for spreadsheet analysis or tax reporting.

## Solution
Add `/api/v1/earnings-history/export` and `/api/v1/contributor-tax/export` endpoints that return CSV-formatted data for analysis.

## Acceptance Criteria
- [ ] Add earnings history export endpoint with date range filtering
- [ ] Add tax report export endpoint with year filtering
- [ ] CSV includes appropriate headers and formatting
- [ ] Stream data to avoid memory overhead for large datasets
- [ ] Verify role-based access control
- [ ] Add tests for CSV format and data accuracy

## Note
If you're assigned to this issue, write a better description for your PR. Clearly explain what was changed, why it was needed, how it was implemented, and how it was tested.

---

# ISSUE 14
Frontend forms use standard HTML inputs but lack keyboard navigation shortcuts, ARIA labels, and screen reader support, limiting accessibility.

## Solution
Add comprehensive accessibility improvements: ARIA labels, keyboard shortcuts, focus management, and semantic HTML.

## Acceptance Criteria
- [ ] All form inputs have associated label elements and ARIA-describedby
- [ ] Submit/cancel buttons are keyboard accessible
- [ ] Logical focus order throughout forms
- [ ] Error messages announced to screen readers
- [ ] Keyboard shortcut (Ctrl+Enter) submits forms
- [ ] Add accessibility tests (axe or jest-axe)
- [ ] Manual keyboard and screen reader testing

## Note
If you're assigned to this issue, write a better description for your PR. Clearly explain what was changed, why it was needed, how it was implemented, and how it was tested.

---

# ISSUE 15
Backend has webhook delivery logic but if endpoints are temporarily down, initial delivery attempts fail without retries, leading to missed notifications.

## Solution
Implement exponential backoff retry logic with persistent storage of failed attempts and background job to retry.

## Acceptance Criteria
- [ ] Add retry columns to webhooks table (retry_count, next_retry_at)
- [ ] Implement exponential backoff: 1s, 2s, 4s, 8s, 16s
- [ ] Add background job to retry failed webhooks
- [ ] Log retry attempts with timestamp and error details
- [ ] Add tests for retry behavior and max retries
- [ ] Document retry behavior and max retry count

## Note
If you're assigned to this issue, write a better description for your PR. Clearly explain what was changed, why it was needed, how it was implemented, and how it was tested.
