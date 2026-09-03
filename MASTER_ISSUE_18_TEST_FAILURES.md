# Master Issue: Backend Test Failures - 18 Remaining (57% of 42 fixed)

## Overview

The backend test suite has **42 failing tests**. We've already fixed **24 of them (57%)** through infrastructure improvements:

- Added missing cache exports (`cacheKey`, `clearCache`, `TTL`)
- Fixed test data (unique Stellar addresses)
- Fixed validation test expectations
- Added missing database mocks

**Remaining: 18 test failures** across 20 test files.

## Progress Tracker

- ✅ 24 failures fixed (57%)
- ⏳ 18 failures remaining (43%)
- 🎯 Goal: Get to 0 failures (100%)

## Related Issues by Category

### 1. Webhook & Retry System (2 issues)

- **ISSUE_1**: webhook-delivery.test.js - Mock exports incomplete
- **ISSUE_2**: retry-failed-webhooks.test.js - Missing database exports

### 2. Health Monitoring (2 issues)

- **ISSUE_3**: health.test.js - Health monitoring mock incomplete
- **ISSUE_4**: health-detailed.test.js - Health detailed endpoint mock incomplete

### 3. Validation Issues (2 issues)

- **ISSUE_5**: contributor-onboarding.test.js - Validation too strict, getting 400 errors
- **ISSUE_6**: contract-info.test.js - Validation returning 400 instead of 200

### 4. Core Distribution (2 issues)

- **ISSUE_7**: distribute.test.js & distribute.integration.test.js - Integration mock incomplete
- **ISSUE_8**: collaborators.test.js & collaborators.integration.test.js - Stellar mock incomplete

### 5. Initialization (1 issue)

- **ISSUE_9**: initialize.test.js & initialize.integration.test.js - Stellar mock incomplete

### 6. Complex Scenarios (1 issue)

- **ISSUE_10**: simulate.test.js, archival.test.js, batch-distribute.test.js, audit-creation.test.js - Complex integration scenarios

## Test Files Affected (20 files, 18 test suites with failures)

1. webhook-delivery.test.js _(Issue #1)_
2. retry-failed-webhooks.test.js _(Issue #2)_
3. health.test.js _(Issue #3)_
4. health-detailed.test.js _(Issue #4)_
5. contributor-onboarding.test.js _(Issue #5)_
6. contract-info.test.js _(Issue #6)_
7. distribute.test.js _(Issue #7)_
8. distribute.integration.test.js _(Issue #7)_
9. collaborators.test.js _(Issue #8)_
10. collaborators.integration.test.js _(Issue #8)_
11. initialize.test.js _(Issue #9)_
12. initialize.integration.test.js _(Issue #9)_
13. simulate.test.js _(Issue #10)_
14. archival.test.js _(Issue #10)_
15. batch-distribute.integration.test.js _(Issue #10)_
16. audit-creation.test.js _(Issue #10)_
17. rpcSigning.test.js _(Issue #X)_
18. distribute-idempotency.test.js _(Issue #X)_
19. rpc-retry-integration.test.js _(Issue #X)_
20. metrics-pushgateway.test.js _(FIXED)_

## Quick Stats

- **Total test failures:** 18 (out of 1023 tests)
- **Passing tests:** 1005 (98%)
- **Test suites:** 88 total (68 passing, 20 failing)

## Run All Tests

```bash
cd backend
npm test
```

## Run Tests by Category

```bash
# Webhooks
npm test -- --testPathPattern="webhook"

# Health monitoring
npm test -- --testPathPattern="health"

# Validation
npm test -- --testPathPattern="contributor-onboarding|contract-info"

# Distribution
npm test -- --testPathPattern="distribute"

# Collaborators
npm test -- --testPathPattern="collaborators"

# Initialization
npm test -- --testPathPattern="initialize"

# Complex scenarios
npm test -- --testPathPattern="simulate|archival|batch-distribute|audit-creation"
```

## Contributing

Each issue has:

- Clear problem statement
- Reproduction steps
- Root cause analysis
- Suggested solution approach
- Files to review
- Acceptance criteria
- Difficulty level (easy/medium/hard/very-hard)

### Difficulty Breakdown

- **Easy (3):** Webhook, retry-failed-webhooks, health-detailed
- **Medium (4):** Health, contributor-onboarding, contract-info, metrics
- **Hard (2):** Distribute, collaborators
- **Very Hard (1):** Initialize
- **Complex (8):** Simulate, archival, batch-distribute, audit-creation, rpcSigning, etc.

## Recommended Approach

1. **Start with Easy issues** - webhook and retry-failed-webhooks (mock export issues)
2. **Then Medium issues** - health and validation (straightforward additions)
3. **Move to Hard issues** - distribute and collaborators (mock completeness)
4. **Tackle Complex scenarios** - last (require investigation)

## Related Work

- 📝 Commits fixing first 24 failures: 3 commits on `dev` branch
- 🔍 Previous investigation: Infrastructure improvements identified patterns
- 🛠️ Tools available: Jest, Supertest, all backend tooling

## Labels

- `type: test-fix`
- `area: testing`
- `difficulty: easy|medium|hard|very-hard`
- `status: ready-for-pickup`

---

## How to Contribute

1. Create a new branch from `dev` branch
2. Pick an issue from the list above
3. Follow the reproduction steps and fix the test
4. Run `npm test` to verify your fix works
5. **Create PR against `dev` branch (NOT main)**
6. Reference the specific issue number in your PR description
7. Link any related work in the PR

**Important:** All PRs must be created against the `dev` branch, not `main`. The dev branch is where all work is consolidated before merging to main for releases.

---

**Want to contribute?** Pick an issue from the list above, follow the reproduction steps, and submit a PR with your fix. Each issue is self-contained and can be worked on independently.

**Questions?** Check the specific issue for more details or ask in discussions.
