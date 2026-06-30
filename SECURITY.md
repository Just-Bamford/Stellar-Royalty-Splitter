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
- Ability to drain contract funds without calling `distribute`**Backend API (`backend/`)**
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
- Use `SIGNING_KEY_FILE` (secrets-manager integration) rather than `SERVER_SECRET_KEY` in
  production environments.
- Require signed write requests with a nonce and timestamp so backend mutations can reject
  tampered, stale, or replayed payloads.
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

## Re-entrancy and Initialization Guard Strategy

### How the guard works

The contract uses a single atomic check-then-write pattern in `apply_initialize`:

```rust
if env.storage().instance().has(&StorageKey::Admin) {
    Self::fail(env, ContractError::AlreadyInitialized);
}
// ... validation ...
storage::instance_set(env, &StorageKey::Admin, &admin); // written last
```

`StorageKey::Admin` is the sentinel. It is checked at the top of every initialization path and written only after all validation passes. Because Soroban execution is single-threaded and deterministic, there is no window between the check and the write where a second call could observe an uninitialized state.

### All initialization paths are guarded

| Entry point | Guard |
|---|---|
| `initialize` | `apply_initialize` checks `Admin` key before any write |
| `commit_initialize` | Checks `Admin` key first; also checks `InitCH` to block double-commit |
| `reveal_initialize` | Checks `Admin` key first; `NoPendingCommit` if no prior commit |

### Why true concurrency is not possible

Soroban smart contracts run in a single-threaded, deterministic Wasm sandbox. Each transaction is executed sequentially within a ledger. Two transactions in the same ledger targeting the same contract are ordered by the protocol — the second observes the state written by the first. There is no shared-memory concurrency, no preemption, and no cross-call re-entrancy within a single invocation.

### What the tests cover (`tests/reentrancy_test.rs`)

| # | Scenario | Expected result |
|---|---|---|
| 1 | Direct second call to `initialize` | `AlreadyInitialized` |
| 2 | Three sequential re-init attempts | All return `AlreadyInitialized` |
| 3 | Storage state after rejected attempt | All original entries unchanged |
| 4 | `commit_initialize` after live contract | `AlreadyInitialized` |
| 5 | `reveal_initialize` after live contract | `AlreadyInitialized` |
| 6 | Double `commit_initialize` | `CommitmentExists` on second call |
| 7 | `reveal_initialize` with no prior commit | `NoPendingCommit` |
| 8 | `init` event count after rejections | Emitted exactly once |
| 9 | `StorageKey::Admin` after 5 rejections | Original admin address unchanged |
| 10 | Collaborator list after rejected re-init | Original 3-entry list unchanged |
| 11 | Contract version after rejected re-init | Original version unchanged |
| 12 | Guard fires before share validation | Returns `AlreadyInitialized`, not `InvalidShareTotal` |
