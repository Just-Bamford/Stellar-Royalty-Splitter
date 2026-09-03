# Contributing Guide

Thank you for contributing to the Stellar Royalty Splitter! This guide will help you set up your development environment and follow our contribution workflow.

## Prerequisites

- **Node.js**: 20.x LTS (required for backend CI)
- **Rust**: Latest stable (for smart contract development)
- **Git**: Latest version
- **Visual Studio Build Tools** (Windows): For native module compilation

## Setup

### Backend

```bash
cd backend
npm ci
npm run lint
npm test
```

### Smart Contract

```bash
rustup target add wasm32-unknown-unknown
cargo build --target wasm32-unknown-unknown --release
cargo test --workspace --locked --features testutils
```

## Development Workflow

### 0. Clone and Branch Setup

```bash
# Clone the repository
git clone https://github.com/Just-Bamford/Stellar-Royalty-Splitter.git
cd Stellar-Royalty-Splitter

# Check out the dev branch (active development)
git checkout dev
git pull origin dev

# Create your feature branch OFF dev (not main)
git checkout -b feature/your-feature-name
```

**Important:** Always branch off `dev`, not `main`. The `main` branch is for stable releases only.

### 1. Create a Branch

```bash
git checkout dev
git pull origin dev
git checkout -b feature/your-feature-name
```

**Branch naming conventions:**

- `feature/description` - New features
- `fix/description` - Bug fixes
- `docs/description` - Documentation
- `chore/description` - Maintenance tasks
- `test/description` - Test additions/improvements

### 2. Make Changes

**Backend:**

- Ensure code follows ESLint rules
- Write tests for new functionality
- Update API.md if endpoints change

**Smart Contract:**

- Follow Rust conventions
- Include unit tests
- Update documentation

### 3. Run Quality Checks

**Backend:**

```bash
cd backend
npm run lint      # ESLint checks
npm run format    # Auto-format code
npm test          # Run all tests (1106/1107 passing)
```

**Smart Contract:**

```bash
cargo fmt --all -- --check
cargo test --workspace --locked --features testutils
```

**Fix issues:**

```bash
cd backend
npm run format    # Auto-fix formatting
npm run lint      # Check remaining issues
```

### 3a. Run Dependency Security Audits

Run these checks locally before opening a PR to catch vulnerable dependencies early.

**JavaScript (backend):**

```bash
cd backend
npm audit --audit-level=high
```

**JavaScript (frontend):**

```bash
cd frontend
npm audit --audit-level=high
```

**Rust:**

```bash
# Install cargo-audit once
cargo install cargo-audit --locked

# Run audit (from repo root)
cargo audit
```

The CI pipeline runs all three audits automatically on every PR and on a weekly schedule. PRs that introduce high or critical vulnerabilities will fail CI. If a finding is a false positive or cannot be remediated immediately, open a separate issue — do not disable the check in-line.

### 4. Commit Your Changes

```bash
git add .
git commit -m "type: description"
```

**Commit types:**

- `feat:` - New feature
- `fix:` - Bug fix
- `docs:` - Documentation
- `refactor:` - Code refactoring
- `test:` - Test additions/fixes
- `chore:` - Maintenance

**Example:**

```bash
git commit -m "feat: add pagination to /users endpoint"
git commit -m "fix: resolve race condition in distribution logic"
```

### 5. Push and Create Pull Request

```bash
# Push to your feature branch
git push -u origin feature/your-feature-name
```

Then create a PR on GitHub with:

- **Title**: Clear, descriptive, under 70 characters
- **Base Branch**: `dev` (not `main`)
- **Description**:
  - What was changed
  - Why it was changed
  - What was tested
  - Any blocking issues or notes
  - Link to related issue: `Closes #N`

### 6. Address Feedback

- Push additional commits to your branch
- Address review comments
- Do NOT force-push unless asked

### 7. Merge

Once approved and CI passes, maintainers will merge your PR into `dev`. Periodically, `dev` is merged into `main` for releases.

## Quality Standards

### Backend Code

- **Linting**: Must pass ESLint
- **Tests**: All tests must pass (currently 1106/1107 passing - 99.9%)
- **Node Versions**: Must work on Node 20.x and 22.x
- **Coverage**: Aim for >70% test coverage

### Smart Contract Code

- **Formatting**: Must pass `cargo fmt --check`
- **Tests**: All tests must pass
- **Targets**: Must compile for `wasm32-unknown-unknown`
- **Documentation**: Public functions must be documented

---

## Testing Requirements for Contributors

Before opening a PR, ensure all tests pass locally:

### Backend Tests (Required)

```bash
cd backend
npm test
```

Expected result: **1106/1107 tests passing** (one timing-related cache edge case)

If you see test failures:

1. Check that you're on the latest `dev` branch
2. Run `npm ci` to ensure dependencies are fresh
3. Run `npm run format` to fix linting issues
4. Run `npm test` again

### Test Files to Check If You Modified

- Modified `src/routes/*.js`? → Check corresponding `tests/*.test.js` and `tests/*.integration.test.js`
- Modified `src/stellar.js`? → Check `tests/stellar.test.js`
- Modified `src/database/*.js`? → Check `tests/database.test.js`
- Modified validation logic? → Check `tests/*validation*.test.js`

### Adding Tests

When adding new functionality:

1. Create a corresponding test file in `backend/tests/`
2. Use the existing test patterns (Jest)
3. Mock external dependencies (Stellar, database, etc.)
4. Aim for >70% coverage on new code
5. Run full suite before committing: `npm test`

### Contract Tests (Required if modifying Rust)

```bash
cargo test --workspace --locked --features testutils
```

---

## Common Issues

### better-sqlite3 Installation Fails (Windows)

If you see build errors for `better-sqlite3`:

1. Install Visual Studio Build Tools with C++ workload
2. Or use WSL2: `wsl --install`
3. Or skip local tests (they run in CI):
   ```bash
   npm ci --omit=optional
   ```

### Port Already in Use

Backend runs on port 5000 by default:

```bash
npm run dev  # Port 5000
```

If port is in use, kill the process or change PORT env var:

```bash
set PORT=5001 && npm run dev
```

### Git Merge Conflicts

When pulling main:

```bash
git fetch origin
git rebase origin/main
# Fix conflicts in your editor
git add .
git rebase --continue
```

## CI/CD Pipeline

### Automatic Checks

All PRs run:

- **Backend CI**:
  - Node 20.x and 22.x tests
  - ESLint checks
  - Jest tests
- **Smart Contract CI**:
  - WASM compilation
  - Cargo tests
  - Formatting check
- **Dependency Security Audit**:
  - `npm audit --audit-level=high` for backend and frontend JS packages
  - `cargo audit` for Rust crates
  - Also runs weekly to catch newly disclosed CVEs

### CI Must Pass Before Merge

PRs are blocked from merging until:

- All status checks pass
- At least one review is approved
- No requested changes remain

## Getting Help

- Check existing issues and PRs
- Ask questions in PR comments
- Review existing code for patterns
- Check API.md and SECRETS_MANAGER.md for backend documentation

## Code of Conduct

Be respectful, inclusive, and collaborative. We're all learning together.

---

## Running tests with coverage

CI publishes a coverage summary on every backend and frontend PR (see the "Backend CI" / "Frontend CI"
job summaries in the Actions tab). Coverage there is **informational, not a hard gate** — it exists to
support review, not to block valid changes because a generated or low-value file dragged the percentage
down. To reproduce the same numbers locally:

### Backend coverage

```bash
cd backend
npm run test:coverage
```

Uses Jest's built-in V8 coverage collector (no extra dependency). Writes an HTML report and `lcov.info`
to `backend/coverage/`; open `backend/coverage/lcov-report/index.html` in a browser for a file-by-file
breakdown. `src/database/index.js` (a pure re-export barrel) and `src/database.js` (an unused legacy
duplicate of `src/database/`, pre-existing on `main`) are excluded from collection since neither
contains logic that a percentage should reflect.

### Frontend coverage

```bash
cd frontend
npm run test:coverage
```

Uses Vitest with `@vitest/coverage-v8`. Writes an HTML report and `lcov.info` to `frontend/coverage/`.
Test files themselves, `src/main.tsx` (entrypoint), and config files are excluded from collection.

Frontend unit/component tests run with [Vitest](https://vitest.dev/) + [React Testing
Library](https://testing-library.com/react) — see `frontend/vitest.config.ts` and
`frontend/src/test/setup.ts`. This is separate from the Playwright end-to-end suite under
`frontend/e2e/` (`npm run test:e2e`), which is not coverage-instrumented.

### Contract coverage

Contract coverage is intentionally **not wired into CI** for now. `cargo-llvm-cov` requires a working
`cargo test` build first, and as of this writing `cargo test --lib --features testutils` fails to
compile on a fresh toolchain due to a transitive dependency skew: the resolved `derive_arbitrary`
version generates code calling `Arbitrary::try_size_hint`, a method not present on the resolved
`arbitrary` version pulled in by `soroban-env-common`/`stellar-xdr`. This reproduces with plain `cargo
test`, independent of any coverage tooling, so it isn't something coverage instrumentation caused or can
route around — see the pinned dependency versions with `cargo tree -p arbitrary` if you want to
investigate a fix (likely a `Cargo.lock` pin or a `soroban-sdk` version bump, both larger changes than
adding coverage tooling should make on their own). If your local toolchain doesn't hit this, you can
still try it manually:

```bash
cargo install cargo-llvm-cov   # one-time
cargo llvm-cov --lib --features testutils --html
```

Once the underlying build issue is resolved, wiring this into CI is a small addition (a `contract-ci.yml`
job running the same command with `--summary-only` piped into `$GITHUB_STEP_SUMMARY`, mirroring the
backend/frontend workflows).

---

## Branch naming

| Type    | Pattern                     | Example                        |
| ------- | --------------------------- | ------------------------------ |
| Feature | `feat/<short-description>`  | `feat/governance-royalty-rate` |
| Bug fix | `fix/<short-description>`   | `fix/secondary-sale-dedup`     |
| Tests   | `test/<short-description>`  | `test/royalty-error-cases`     |
| Docs    | `docs/<short-description>`  | `docs/contributing-guide`      |
| Chore   | `chore/<short-description>` | `chore/update-dependencies`    |

Keep branch names lowercase and hyphen-separated. Avoid slashes beyond the type prefix.

---

## Commit message standards

Follow the [Conventional Commits](https://www.conventionalcommits.org/) specification:

```
<type>: <short description>

[optional body — explain the why, not the what]

[optional footer — issue references, breaking change notes]
```

### Types

| Type       | When to use                                |
| ---------- | ------------------------------------------ |
| `feat`     | New feature or user-facing enhancement     |
| `fix`      | Bug fix                                    |
| `docs`     | Documentation only                         |
| `test`     | Adding or updating tests                   |
| `chore`    | Maintenance — deps, config, tooling        |
| `refactor` | Code restructuring with no behavior change |
| `perf`     | Performance improvement                    |
| `style`    | Formatting, whitespace — no logic change   |

### Closing issues

Add a `Closes` footer to automatically close the linked issue when the PR merges:

```
fix: validate distribute amount against contract balance

Fetch contract balance before building the distribute tx so the
frontend can reject amounts that exceed what the contract holds.

Closes #78245
```

---

## PR guidelines

Before opening a PR on GitHub:

- [ ] Branch is checked out FROM `dev` (not `main`)
- [ ] Branch is up to date with `dev` (`git fetch origin && git rebase origin/dev`)
- [ ] All backend tests pass: `cd backend && npm test` (1106/1107 passing expected)
- [ ] No new ESLint errors: `npm run lint`
- [ ] Code is formatted: `npm run format`
- [ ] If modified Rust: `cargo test` passes with no failures
- [ ] No new compiler warnings (`cargo build` is clean)
- [ ] Frontend and backend start without console errors
- [ ] New public contract functions have rustdoc comments (params, errors, auth)
- [ ] New tests are included for any changed behavior
- [ ] The PR description references the related issue number(s) with `Closes #N`
- [ ] PR base branch is set to `dev` (not `main`)

Keep PRs focused. One issue per PR is preferred. If a fix naturally touches multiple related issues, bundle them and close all in the description.

---

## Windows auth guard caveat

Some tests in the test suite use `require_auth()` checks that behave differently on Windows due to how the Soroban test environment handles mock authorizations.

In `tests/integration_test.rs` you may see tests annotated with:

```rust
#[cfg(not(target_os = "windows"))]
```

These tests verify that unauthorized callers are correctly rejected. On Windows, the mock auth infrastructure in `soroban-sdk` can produce different panic behavior, causing the test to fail for the wrong reason or not panic at all.

**If you are on Windows and a `#[should_panic]` auth test fails unexpectedly:**

- This is a known tooling limitation, not a contract bug.
- Run the full suite on Linux or macOS (or via WSL) to confirm correctness.
- Do not remove the `#[cfg(not(target_os = "windows"))]` guard — it is intentional.
- If you are adding a new auth rejection test, add the same cfg guard if you observe the same behavior.

**Happy contributing!**
