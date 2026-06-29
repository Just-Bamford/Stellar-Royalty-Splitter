# Contributing Guide

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

### 1. Create a Branch

```bash
git checkout main
git pull origin main
git checkout -b feature/your-feature-name
```

**Branch naming conventions:**

- `feature/description` - New features
- `fix/description` - Bug fixes
- `docs/description` - Documentation
- `chore/description` - Maintenance tasks

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
npm test          # Run all tests
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
git push -u origin feature/your-feature-name
```

Then create a PR on GitHub with:

- **Title**: Clear, descriptive, under 70 characters
- **Description**:
  - What was changed
  - Why it was changed
  - What was tested
  - Any blocking issues or notes

### 6. Address Feedback

- Push additional commits to your branch
- Address review comments
- Do NOT force-push unless asked

### 7. Merge

Once approved and CI passes, maintainers will merge your PR.

## Quality Standards

### Backend Code

- **Linting**: Must pass ESLint
- **Tests**: All tests must pass
- **Node Versions**: Must work on Node 20.x and 22.x
- **Coverage**: Aim for >70% test coverage

### Smart Contract Code

- **Formatting**: Must pass `cargo fmt --check`
- **Tests**: All tests must pass
- **Targets**: Must compile for `wasm32-unknown-unknown`
- **Documentation**: Public functions must be documented

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

**Happy contributing!**
