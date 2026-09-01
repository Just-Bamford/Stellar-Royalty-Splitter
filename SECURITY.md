# Security Policy

Stellar Royalty Splitter handles on-chain fund distribution via a Soroban smart contract and a
Node.js backend API. We take security seriously and appreciate responsible disclosure of any
vulnerabilities.

---

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Report security issues privately by emailing:

**security@stellar-royalty-splitter.dev**

If you prefer encrypted communication, please request our PGP public key in your first email.

### What to include

- A clear description of the vulnerability and its potential impact
- Step-by-step reproduction instructions or a proof-of-concept
- The affected component (contract, backend API, signing key handling, frontend)
- Any suggested remediation if you have one

---

## Responsible Disclosure Process

1. **Submit** your report to the email address above.
2. **Acknowledgement** — We will confirm receipt within **48 hours**.
3. **Triage** — We will assess severity and scope within **5 business days**.
4. **Fix & Patch** — We will develop and test a fix. Timeline depends on severity:
   - Critical / High: patched within **7 days**
   - Medium: patched within **30 days**
   - Low / Informational: addressed in the next scheduled release
5. **Disclosure** — We coordinate a public disclosure date with you after the patch is live.
   We default to a **90-day** disclosure window from the date of your report.
6. **Credit** — With your permission, we will acknowledge your contribution in the release notes.

We ask that you:
- Give us reasonable time to fix the issue before public disclosure.
- Avoid accessing, modifying, or exfiltrating user data during research.
- Limit testing to accounts you own or have explicit permission to test.

---

## Scope

### In Scope

The following components are in scope for security research:

**Smart Contract (`src/lib.rs`)**
- Logic errors in royalty distribution (e.g. incorrect basis-point arithmetic, rounding exploits)
- Unauthorized invocation of privileged functions (`initialize`, `distribute`, `pause`, `admin_transfer`)
- Admin key / authorization bypass vulnerabilities
- Re-entrancy or cross-contract call vulnerabilities
- Integer overflow / underflow in share calculations
- Ability to drain contract funds without calling `distribute`

**Backend API (`backend/`)**
- Authentication or authorization bypass on API endpoints
- Exposure of `SERVER_SECRET_KEY` or `SIGNING_KEY_FILE` contents via API responses, logs, or errors
- Injection vulnerabilities (SQL, command, header injection)
- Insecure handling of the `ADMIN_ROTATE_TOKEN` bearer token
- Server-Side Request Forgery (SSRF) via Horizon / Soroban RPC URL parameters
- Path traversal when reading `SIGNING_KEY_FILE`

**Signing Key Handling**
- Scenarios where the server signing key could be extracted by an attacker
- Weak key-rotation logic that allows a stale key to be reused after rotation

**Deployment Configuration**
- Hardcoded secrets committed to the repository
- Insecure default environment variable values in `.env.example`

### Out of Scope

- Vulnerabilities in third-party dependencies that are already publicly disclosed (report those
  upstream)
- Denial-of-service attacks against the public Stellar network itself
- Social engineering or phishing attacks targeting contributors
- Issues in Stellar / Soroban infrastructure outside this project's control
- Theoretical vulnerabilities without a realistic attack path
- Freighter wallet internals (report those to the Freighter team)

---

## Expected Response Times

| Stage | Target |
|---|---|
| Acknowledgement | 48 hours |
| Triage & severity assessment | 5 business days |
| Fix — Critical / High | 7 days |
| Fix — Medium | 30 days |
| Fix — Low / Informational | Next scheduled release |
| Coordinated public disclosure | Up to 90 days from initial report |

---

## Security Best Practices for Contributors

- Never commit secrets, private keys, or `.env` files — `.gitignore` covers these, but verify
  before every push.
- **Use encrypted secrets stores in production** — AWS Secrets Manager or HashiCorp Vault are
  supported. Plaintext `SIGNING_KEY_FILE` or `SERVER_SECRET_KEY` should only be used for local
  development.
- Configure `SECRETS_ENCRYPTION_KEY` for at-rest encryption of cached secrets.
- Rotate `ADMIN_ROTATE_TOKEN` after any suspected compromise.
- Keep the Stellar CLI and all dependencies up to date.
- Review the `SECURITY_AUDIT.md` in this repository for known findings and their mitigations.

### Secrets Manager Configuration (Production)

The backend supports loading signing keys from encrypted secrets stores:

**AWS Secrets Manager:**
```bash
SECRETS_PROVIDER=aws
AWS_SECRET_NAME=stellar-signing-key
AWS_REGION=us-east-1
SECRETS_ENCRYPTION_KEY=your-32-char-encryption-key
```

**HashiCorp Vault:**
```bash
SECRETS_PROVIDER=vault
VAULT_ADDR=https://vault.example.com:8200
VAULT_TOKEN=hvs.your-token
VAULT_SECRET_PATH=secret/data/signing-key
SECRETS_ENCRYPTION_KEY=your-32-char-encryption-key
```

**Local Development (Plaintext Fallback):**
```bash
# File-based
SIGNING_KEY_FILE=/path/to/key.txt

# Or environment variable
SERVER_SECRET_KEY=SAAAA...
```

The secrets manager automatically detects the configured provider and loads the key on startup.
Secrets are encrypted at rest when `SECRETS_ENCRYPTION_KEY` is configured.

---

## Supported Versions

| Version | Supported |
|---|---|
| `main` branch (latest) | Yes |
| Tagged releases | Yes (until superseded) |
| Forks / derivatives | Not supported — contact the fork maintainer |

---

*This policy follows the [responsible disclosure guidelines](https://cheatsheetseries.owasp.org/cheatsheets/Vulnerability_Disclosure_Cheat_Sheet.html)
published by OWASP and is inspired by [GitHub's security advisory best practices](https://docs.github.com/en/code-security/security-advisories).*

---

## Pre-Deploy Security Checklist

Before deploying the Stellar Royalty Splitter to mainnet, the deployer MUST manually verify and sign off on the following security checklist:

1. [ ] **Dependency Audit**: `cargo audit` returns no critical or high vulnerabilities.
2. [ ] **Linting**: The contract compiles with zero clippy warnings (`cargo clippy --all-targets -- -D warnings`).
3. [ ] **Authorization**: All endpoints that mutate state use `require_auth` or `require_admin`.
4. [ ] **Environment Variables**: `.env` does not contain production secrets; AWS Secrets Manager or HashiCorp Vault is configured for the backend.
5. [ ] **Admin Key**: The deployer address (the first address in `collaborators`) is securely stored and requires multi-sig or a hardware wallet for production.
6. [ ] **Basis Points**: Total shares configured in initialization perfectly sum to 10,000 (100%).


---

## Dependency Vulnerability Management

Third-party packages in the backend, frontend, shared workspace, Soroban
contract, and the CI toolchain itself are all treated as part of the attack
surface. Detection is automated; remediation is deliberate.

### What scans, and where

| Surface | Monitoring | Blocking CI check |
|---|---|---|
| `backend/` (npm) | Dependabot, weekly | `npm audit --audit-level=high` |
| `frontend/` (npm) | Dependabot, weekly | `npm audit --audit-level=high` |
| `shared/` (npm) | Dependabot, weekly | `npm audit --audit-level=high` |
| Soroban contract (cargo) | Dependabot, weekly | `cargo audit --deny warnings` |
| GitHub Actions | Dependabot, weekly | — |
| Lockfile integrity | — | `npm ci --dry-run` per workspace |

Configuration lives in [`.github/dependabot.yml`](.github/dependabot.yml) and
[`.github/workflows/dependency-audit.yml`](.github/workflows/dependency-audit.yml).

All npm scans install with `npm ci` so the advisories reported are for the
exact versions the lockfile pins, not whatever a semver range resolves to on
the day CI happens to run. The `lockfile-sync` job exists because a drifted
lockfile silently invalidates every other check in the table.

### Severity policy

| Severity | CI result | Expected action |
|---|---|---|
| **Critical** | Blocks the build | Fix before merge. If no patched version exists, the affected code path must be disabled or isolated; an exception requires maintainer sign-off recorded in the PR. |
| **High** | Blocks the build | Fix before merge, or record a reviewed exception (see below). |
| **Moderate** | Reported, does not block | Addressed through routine dependency maintenance. |
| **Low / informational** | Reported, does not block | Batched into scheduled maintenance. |

Job summaries list the affected package, the installed version, the severity,
and the version that fixes it where one is available.

### Dependency remediation workflow

1. **Reproduce locally.** `cd <workspace> && npm ci --ignore-scripts && npm audit`
   (or `cargo audit` at the repo root).
2. **Establish reachability.** A vulnerability in a code path the project never
   calls is a different risk from one on a request path. Record the finding.
3. **Prefer the narrowest fix.** A patch or minor bump of the direct dependency,
   or an npm `overrides` entry pinning a transitive package to a fixed version.
4. **Escalate deliberately.** If only a major upgrade fixes it, open a separate
   PR for that upgrade alone, with its own review and test run. Dependabot is
   configured never to propose major upgrades automatically.
5. **Verify.** Re-run the audit and the full test suite before merging.

**Do not run `npm audit fix --force`.** It performs major upgrades transitively
and has silently broken working builds. Never weaken a validation rule or
production check to make an audit pass.

### Accepted risks and false positives

An advisory that cannot currently be fixed is recorded explicitly rather than
suppressed:

- **Rust:** add the advisory ID to `ignore` in
  [`.cargo/audit.toml`](.cargo/audit.toml) with a rationale and an acceptance
  date. Two advisories are accepted there today, both transitive under the
  pinned `soroban-sdk 20.0.0` and both unreachable from contract entrypoints.
- **npm:** record the rationale in the PR that introduces the exception and
  re-review it when the pinned dependency next moves.

An entry in either place is a security decision with an owner and a review
date, not a way to quiet the build.

### Secrets

The audit workflow runs with `permissions: contents: read` and consumes no
repository secrets. `npm ci --ignore-scripts` prevents dependency install
scripts from executing in CI, so a malicious postinstall in a newly-published
package cannot read the runner environment during a scan.
