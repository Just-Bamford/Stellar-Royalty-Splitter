# Contributing to Stellar Royalty Splitter

Thanks for your interest in contributing. This guide covers everything you need to get the project running locally, write and run tests, and open a pull request.

If you run into problems during setup or development, check the **[Troubleshooting Guide](TROUBLESHOOTING.md)** first — it covers 25+ common issues with step-by-step fixes.

---

## Table of Contents

- [Prerequisites](#prerequisites)
- [Fork and clone](#fork-and-clone)
- [Smart contract setup](#smart-contract-setup)
- [Backend setup](#backend-setup)
- [Frontend setup](#frontend-setup)
- [Running tests](#running-tests)
- [Branch naming](#branch-naming)
- [Commit message standards](#commit-message-standards)
- [PR guidelines](#pr-guidelines)
- [Windows auth guard caveat](#windows-auth-guard-caveat)

---

## Prerequisites

You need the following tools installed before working on any part of the project.

### Rust and wasm32 target

```bash
# Install Rust via rustup
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Add the wasm32 target required for Soroban contract compilation
rustup target add wasm32-unknown-unknown
```

### Soroban CLI (Stellar CLI)

```bash
cargo install --locked stellar-cli
```

Verify the install:

```bash
stellar --version
```

### Node.js

The backend and frontend both require Node.js 18 or later.

- Download: https://nodejs.org
- Or via a version manager: `nvm install 20`

Verify:

```bash
node --version   # should be >= 18
npm --version
```

---

## Fork and clone

```bash
git clone https://github.com/<your-username>/Stellar-Royalty-Splitter.git
cd Stellar-Royalty-Splitter
```

---

## Smart contract setup

The Soroban contract lives in `src/lib.rs`. No additional setup is needed beyond Rust and the wasm32 target.

Build the contract:

```bash
cargo build --target wasm32-unknown-unknown --release
```

---

## Backend setup

```bash
cd backend
cp .env.example .env   # fill in your values — see README for field descriptions
npm install
npm run dev            # starts on http://localhost:3001
```

The backend builds unsigned Soroban transaction XDR and returns it to the frontend. It never holds or uses a user's private key.

---

## Frontend setup

```bash
cd frontend
npm install
npm run dev            # starts on http://localhost:5173
```

The frontend proxies `/api/*` to the backend automatically via the Vite config. Make sure the backend is running first.

---

## Running tests

### Smart contract tests

Run all tests (unit + integration):

```bash
cargo test
```

Run only the inline unit tests inside `src/lib.rs`:

```bash
cargo test --lib
```

Run only the integration tests in `tests/`:

```bash
cargo test --test integration_test
```

Run a specific test by name:

```bash
cargo test test_royalty_rate_boundary_max
```

Show output from passing tests (useful for debugging):

```bash
cargo test -- --nocapture
```

### Backend tests

```bash
cd backend
npm test
```

### Frontend tests

```bash
cd frontend
npm test -- --run   # single pass, no watch mode
```

---

## Branch naming

| Type     | Pattern                     | Example                        |
| -------- | --------------------------- | ------------------------------ |
| Feature  | `feat/<short-description>`  | `feat/governance-royalty-rate` |
| Bug fix  | `fix/<short-description>`   | `fix/secondary-sale-dedup`     |
| Tests    | `test/<short-description>`  | `test/royalty-error-cases`     |
| Docs     | `docs/<short-description>`  | `docs/contributing-guide`      |
| Chore    | `chore/<short-description>` | `chore/update-dependencies`    |

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

| Type       | When to use                                          |
| ---------- | ---------------------------------------------------- |
| `feat`     | New feature or user-facing enhancement               |
| `fix`      | Bug fix                                              |
| `docs`     | Documentation only                                   |
| `test`     | Adding or updating tests                             |
| `chore`    | Maintenance — deps, config, tooling                  |
| `refactor` | Code restructuring with no behavior change           |
| `perf`     | Performance improvement                              |
| `style`    | Formatting, whitespace — no logic change             |

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

Before opening a PR:

- [ ] `cargo test` passes with no failures
- [ ] No new compiler warnings (`cargo build` is clean)
- [ ] Frontend and backend start without console errors
- [ ] New public contract functions have rustdoc comments (params, errors, auth)
- [ ] New tests are included for any changed behavior
- [ ] The PR description references the related issue number(s) with `Closes #N`
- [ ] Branch is up to date with `main` (`git rebase origin/main`)

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
