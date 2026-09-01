# Security Regression Suite

Dedicated security regression tests mapped to the OWASP Top 10 (2021).

These tests assert **application behaviour** — that a hostile request is
refused and that the refusal is safe — rather than asserting that
security-related code exists. No production code was added to make them pass;
they exercise the validation, RBAC, signing, CORS, and error-envelope layers
the API already ships.

## Running

```bash
cd backend
npm test                     # whole suite, including tests/security/
node --experimental-vm-modules node_modules/jest/bin/jest.js tests/security/
```

Jest's `testPathPatterns=tests/` already collects this directory, so the
security suite runs in CI via the existing `backend-ci.yml` test job with no
workflow change required.

## OWASP category mapping

| OWASP category | File | What is asserted |
|---|---|---|
| A01 — Broken Access Control | `access-control.security.test.js` | Role hierarchy ordering; every below-threshold role is refused with 403; missing/forged/non-string roles fall back to `viewer`; `requireRole` throws on an unknown role at wiring time; denials leak no internals |
| A02 — Cryptographic / Sensitive Data Exposure | `configuration-exposure.security.test.js` | Stack traces never reach the client; error envelope exposes only documented fields; 413 does not echo the body; a 500 is not advertised as retryable |
| A03 — Injection | `injection.security.test.js` | SQL, NoSQL, command, path-traversal, template and JNDI payloads are refused by the address/contract schemas; type-confusion objects cannot satisfy a string schema |
| A03 — Injection (XSS) | `hostile-input.security.test.js` | Script/`javascript:`/SVG/iframe payloads are refused at the schema boundary |
| A04 — Insecure Design (resource exhaustion) | `hostile-input.security.test.js` | Collaborator-count cap, oversized arrays, payload-size guard, numeric bounds, share-sum invariant, prototype pollution, deep nesting |
| A05 — Security Misconfiguration | `configuration-exposure.security.test.js` | Wildcard CORS refused outside dev; production requires an explicit `FRONTEND_ORIGIN`; non-`http(s)` and malformed origins refused |
| A07 — Identification and Authentication Failures | `authentication.security.test.js` | Ed25519 forgery, malformed signatures, invalid public keys, post-signing tampering of body/path/method/nonce, nonce replay, stale and future timestamps |

Total: **139 tests across 5 files.**

## Categories that do not apply

Documented rather than covered by artificial tests:

- **A08 — Software and Data Integrity Failures.** Dependency integrity is
  enforced by lockfiles plus the dependency scanning workflow
  (`.github/workflows/dependency-audit.yml` and `.github/dependabot.yml`),
  not by application code. Testing it here would assert CI configuration, not
  behaviour.
- **A09 — Security Logging and Monitoring Failures.** The RBAC and signature
  layers emit structured `logger.warn` events (`rbac_denied`,
  `signature_verification_failed`) on every rejection. These are asserted
  indirectly — the denial path is covered — but log-shipping and alerting are
  infrastructure concerns outside the unit boundary.
- **CSRF.** The API is a stateless JSON service authenticated by Ed25519
  request signatures, not by ambient cookies or sessions. A browser cannot be
  induced to produce a valid `X-Signature` for a cross-site request, so the
  classic CSRF model does not apply. The replay and tampering tests in
  `authentication.security.test.js` cover the equivalent threat.
- **A10 — Server-Side Request Forgery.** The backend calls fixed, configured
  Horizon/Soroban RPC endpoints; no user-supplied URL is fetched.

## Verified failure determinism

Both protections below were mutated locally and the suite failed as required
(sources restored afterwards):

| Mutation | Result |
|---|---|
| `requireRole`: `if (roleIndex >= minIndex)` → `if (true)` | 14 access-control tests fail |
| `verifyRequestSignature`: `if (isNonceSeen(nonce))` → `if (false)` | replay-protection test fails |

## Frontend

No `frontend/tests/security/` directory is added. The frontend is a Vite/React
client that renders values returned by the API; it holds no authentication,
authorization, or input-trust boundary of its own. The security boundary this
suite protects is the backend API, and placing security regression tests there
is where a removed protection actually becomes observable.
