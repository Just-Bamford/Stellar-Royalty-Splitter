# Contributing to Stellar Royalty Splitter

Thanks for your interest in contributing. Here's everything you need to get up and running.

---

## Fork and clone

```bash
git clone https://github.com/<your-username>/Stellar-Royalty-Splitter.git
cd Stellar-Royalty-Splitter
```

---

## Backend setup

```bash
cd backend
cp .env.example .env   # fill in your values
npm install
npm run dev            # runs on http://localhost:3001
```

See [Environment Variables](README.md#environment-variables) for a description of each `.env` field.

---

## Frontend setup

```bash
cd frontend
npm install
npm run dev            # runs on http://localhost:5173
```

The frontend proxies `/api/*` to the backend automatically via Vite config.

---

## Rust contract tests

```bash
cargo test
```

To run only the inline unit tests:

```bash
cargo test --lib
```

---

## Branch naming

| Type     | Pattern                        | Example                              |
| -------- | ------------------------------ | ------------------------------------ |
| Feature  | `feat/<short-description>`     | `feat/governance-royalty-rate`       |
| Bug fix  | `fix/<short-description>`      | `fix/secondary-sale-dedup`           |
| Tests    | `test/<short-description>`     | `test/royalty-error-cases`           |
| Docs     | `docs/<short-description>`     | `docs/contributing-guide`            |
| Chore    | `chore/<short-description>`    | `chore/update-dependencies`          |

---

## Commit message standards

Follow the [Conventional Commits](https://www.conventionalcommits.org/) specification:

```
<type>: <description>

[optional body]

[optional footer]
```

### Types

- `feat:` — new feature or enhancement
- `fix:` — bug fix
- `docs:` — documentation changes
- `test:` — adding or updating tests
- `chore:` — maintenance tasks (dependencies, config, etc.)
- `refactor:` — code restructuring without changing behavior
- `perf:` — performance improvements
- `style:` — formatting, whitespace, etc.

### Examples

```bash
feat: add update_share function for collaborator management

fix: validate transaction hash format in confirm endpoint

docs: add usage examples to README

test: add E2E tests for critical user flows

chore: remove debug logs from backend
```

### Closing issues

Reference issue numbers in commit messages to automatically close them:

```bash
git commit -m "feat: add export and share to AdminDashboard

Closes #147"
```

---

## PR checklist

Before opening a PR, make sure:

- [ ] `cargo test` passes with no failures
- [ ] No console errors in the frontend or backend
- [ ] Code follows the existing style (no new linting warnings)
- [ ] New functions have comments explaining their purpose
- [ ] The PR description references the related issue number
