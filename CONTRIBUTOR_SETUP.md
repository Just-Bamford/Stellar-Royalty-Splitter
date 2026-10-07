# Contributor Setup Guide

Welcome to the Stellar Royalty Splitter project! This guide walks you through getting started as a contributor.

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Initial Setup](#initial-setup)
3. [Verify Your Setup](#verify-your-setup)
4. [Creating Your First PR](#creating-your-first-pr)
5. [Common Workflows](#common-workflows)
6. [Getting Help](#getting-help)

---

## Prerequisites

Before you begin, ensure you have:

| Tool      | Version | Install                                          |
| --------- | ------- | ------------------------------------------------ |
| Git       | Latest  | https://git-scm.com/                             |
| Node.js   | 20.x+   | https://nodejs.org/ (LTS recommended)            |
| Rust      | Latest  | https://rustup.rs/                               |
| npm       | 10.x+   | Comes with Node.js                               |

### Optional but Recommended

- **Visual Studio Code**: https://code.visualstudio.com/
- **GitHub CLI**: https://cli.github.com/ (for easy PR creation)

---

## Initial Setup

### Step 1: Fork the Repository

1. Go to https://github.com/Just-Bamford/Stellar-Royalty-Splitter
2. Click the **"Fork"** button (top right)
3. Select your account as the fork destination
4. Click **"Create fork"**

### Step 2: Clone Your Fork

```bash
# Replace YOUR_USERNAME with your GitHub username
git clone https://github.com/YOUR_USERNAME/Stellar-Royalty-Splitter.git
cd Stellar-Royalty-Splitter
```

### Step 3: Add Upstream Remote

```bash
# This allows you to sync with the original repo
git remote add upstream https://github.com/Just-Bamford/Stellar-Royalty-Splitter.git

# Verify both remotes exist
git remote -v
# Should show:
# origin    https://github.com/YOUR_USERNAME/...
# upstream  https://github.com/Just-Bamford/...
```

### Step 4: Check Out the Dev Branch

```bash
# Get latest from upstream
git fetch upstream

# Check out dev branch
git checkout dev

# Update to latest
git pull upstream dev
```

### Step 5: Create Your Feature Branch

```bash
# Create and switch to a new feature branch
git checkout -b feature/your-feature-name

# Examples:
# git checkout -b feature/add-pagination
# git checkout -b fix/cache-timing-issue
# git checkout -b docs/update-readme
```

**Branch naming conventions:**
- `feature/description` - New features
- `fix/description` - Bug fixes
- `docs/description` - Documentation
- `chore/description` - Maintenance tasks
- `test/description` - Test improvements

### Step 6: Install Dependencies

#### Backend

```bash
cd backend

# Install dependencies
npm ci

# Verify installation
npm test

# Expected output: 1106/1107 tests passing
```

#### Frontend (if working on UI)

```bash
cd frontend

# Install dependencies
npm install

# Verify installation
npm run build
```

#### Smart Contract (if modifying Rust)

```bash
# Install Rust wasm target (one-time)
rustup target add wasm32-unknown-unknown

# Verify
cargo build --target wasm32-unknown-unknown --release
```

---

## Verify Your Setup

### Quick Verification Script

```bash
# Run from project root
./scripts/validate-env.sh

# or using make
make validate-env
```

This checks:
- ✅ Git setup and remotes
- ✅ Node.js version (20.x+)
- ✅ npm version
- ✅ Rust toolchain
- ✅ Required environment files

### Manual Verification

```bash
# Verify Git setup
git remote -v                    # Should show origin and upstream
git branch -v                    # Should show you're on dev

# Verify Node.js
node --version                   # Should be 20.x or 22.x
npm --version                    # Should be 10.x+

# Verify Rust (if modifying contract)
rustc --version                  # Should be recent
cargo --version                  # Should be recent

# Run backend tests
cd backend
npm test                         # Should show 1106/1107 passing
```

---

## Creating Your First PR

### Step 1: Make Your Changes

```bash
# Make changes to files
# Example: edit src/routes/my-feature.js

# Verify changes
git status
git diff
```

### Step 2: Run Quality Checks

```bash
cd backend

# Format code
npm run format

# Check linting
npm run lint

# Run tests
npm test

# Expected: All tests passing, no linting errors
```

### Step 3: Commit Your Changes

```bash
# Stage changes
git add src/routes/my-feature.js

# Commit with message
git commit -m "feat: add new feature description"

# Examples:
# git commit -m "feat: add pagination to /users endpoint"
# git commit -m "fix: resolve race condition in distribution"
# git commit -m "docs: update README with new API docs"
```

**Commit message format:**
```
<type>: <short description (50 chars max)>

[optional body explaining the why, not the what]

[optional footer: Closes #123]
```

### Step 4: Push to Your Fork

```bash
# Push to your fork
git push -u origin feature/your-feature-name

# -u sets upstream, so next time you can just: git push
```

### Step 5: Create a Pull Request

**Option A: Using GitHub Web UI**

1. Go to your fork: https://github.com/YOUR_USERNAME/Stellar-Royalty-Splitter
2. Click **"Compare & pull request"** (should appear at top)
3. Verify:
   - **Base repository**: `Just-Bamford/Stellar-Royalty-Splitter`
   - **Base branch**: `dev` (NOT `main`)
   - **Head repository**: `YOUR_USERNAME/Stellar-Royalty-Splitter`
   - **Compare branch**: `feature/your-feature-name`
4. Add PR title and description (see below)
5. Click **"Create pull request"**

**Option B: Using GitHub CLI**

```bash
# From your feature branch
gh pr create \
  --title "feat: your feature title" \
  --body "Description of changes" \
  --base dev \
  --repo Just-Bamford/Stellar-Royalty-Splitter
```

### Step 6: PR Description Template

```markdown
## Description
Brief description of what this PR does.

## Changes
- Change 1
- Change 2
- Change 3

## Testing
- [ ] Backend tests pass: `npm test` (1106/1107 expected)
- [ ] No linting errors: `npm run lint`
- [ ] Formatted: `npm run format`
- [ ] [If UI change] Tested in browser
- [ ] [If contract change] Cargo tests pass

## Related Issues
Closes #123

## Screenshots (if applicable)
[Add screenshots of UI changes if any]
```

### Step 7: Wait for Review

GitHub Actions will automatically run tests. You'll see:

- ✅ Backend CI (Node 20.x, 22.x)
- ✅ Contract CI
- ✅ Security audits

If CI fails:
1. Click "Details" to see error logs
2. Fix issues locally
3. Commit and push again
4. CI will re-run automatically

If reviewers request changes:
1. Make the requested changes
2. Commit and push
3. CI and reviewers will check again
4. Do NOT force-push

---

## Common Workflows

### Syncing Your Fork with Latest Dev

```bash
# Fetch latest from upstream
git fetch upstream

# Rebase your current branch on latest dev
git rebase upstream/dev

# If you have unpushed commits, do:
git push -f origin feature/your-feature-name

# If you've already pushed, GitHub will warn about force-push.
# For regular PRs, avoid this - just merge dev into your branch instead:
git merge upstream/dev
git push origin feature/your-feature-name
```

### Updating Your PR After Review

```bash
# Make changes requested by reviewers
# ... edit files ...

# Format and test again
npm run format
npm test

# Commit the changes
git add .
git commit -m "Address review feedback"

# Push to your branch
git push origin feature/your-feature-name

# GitHub PR will update automatically
```

### Running Tests on Specific Files

```bash
cd backend

# Run tests for one file
npm test -- initialize.test.js

# Run tests matching a pattern
npm test -- distribute

# Run in watch mode (re-run on file changes)
npm test -- --watch initialize.test.js
```

### Checking Test Coverage

```bash
cd backend

# Run with coverage report
npm test -- --coverage

# Open report in browser
open coverage/lcov-report/index.html

# Find files with low coverage and add tests
```

### Reverting Changes

```bash
# Undo uncommitted changes to a file
git checkout -- src/file.js

# Undo uncommitted changes to everything
git reset --hard

# Undo a committed change (creates new commit)
git revert <commit-hash>

# Go back to upstream dev
git reset --hard upstream/dev
```

---

## Debugging Workflow Issues

### "I can't push to my branch"

```bash
# You might be behind - sync first
git fetch upstream
git rebase upstream/dev
git push -f origin feature/your-feature-name  # -f because of rebase
```

### "Tests fail on my machine but pass in CI"

1. Check Node version: `node --version` (must be 20.x or 22.x)
2. Clean install: `rm -rf node_modules && npm ci`
3. Clear cache: `npm test -- --clearCache`
4. Make sure on dev: `git checkout dev && git pull upstream dev`

### "I committed to main by accident"

```bash
# Don't panic! Here's how to fix it:

# 1. Find your commit hash
git log main --oneline | head -5

# 2. Switch to dev
git checkout dev

# 3. Cherry-pick your commit
git cherry-pick <commit-hash>

# 4. Push to your feature branch
git push -u origin feature/your-feature-name

# 5. Reset main to upstream
git checkout main
git reset --hard upstream/main
git push -f origin main

# Now create PR as normal from your feature branch
```

### "My branch is too far behind dev"

```bash
# Update to latest dev
git fetch upstream
git rebase upstream/dev

# If conflicts, resolve them, then:
git add .
git rebase --continue

# Force-push to your fork (since you rebased)
git push -f origin feature/your-feature-name
```

---

## File Structure Overview

```
Stellar-Royalty-Splitter/
├── backend/                   # Express API server
│   ├── src/
│   │   ├── routes/           # API endpoints
│   │   ├── database/         # SQLite schema/queries
│   │   ├── stellar.js        # Soroban RPC helpers
│   │   └── index.js          # Server entry point
│   ├── tests/                # Jest tests
│   ├── package.json
│   └── .env.example
├── frontend/                  # React + Vite UI
│   ├── src/
│   │   ├── components/       # React components
│   │   ├── App.tsx
│   │   └── main.tsx
│   ├── e2e/                  # Playwright tests
│   └── package.json
├── src/                       # Rust smart contract
│   └── lib.rs
├── tests/                     # Cargo integration tests
├── docs/                      # Documentation
├── CONTRIBUTING.md            # Contribution guidelines
├── README.md                  # Project overview
└── DEVELOPMENT.md             # Dev setup guide
```

---

## Best Practices

### Before Starting Work

- [ ] Fork the repo
- [ ] Clone your fork
- [ ] Add upstream remote
- [ ] Check out dev branch
- [ ] Pull latest: `git pull upstream dev`

### While Working

- [ ] Create feature branch from dev
- [ ] Make focused changes (one feature per PR)
- [ ] Test frequently: `npm test`
- [ ] Run linter: `npm run lint`
- [ ] Format code: `npm run format`
- [ ] Write clear commit messages

### Before Opening PR

- [ ] All tests passing: `npm test` (1106/1107 expected)
- [ ] No linting errors: `npm run lint`
- [ ] Code formatted: `npm run format`
- [ ] Rebased on latest dev
- [ ] PR targets dev branch (NOT main)
- [ ] Description includes what and why

### After Opening PR

- [ ] Wait for CI to complete (usually 5-10 minutes)
- [ ] Address review feedback promptly
- [ ] Push new commits (don't force-push)
- [ ] Ask questions if unclear
- [ ] Be patient and respectful

---

## Resources

### Documentation

- [README.md](./README.md) - Project overview
- [DEVELOPMENT.md](./DEVELOPMENT.md) - Development setup
- [CONTRIBUTING.md](./CONTRIBUTING.md) - Contribution guidelines
- [docs/TESTING.md](./docs/TESTING.md) - Testing guide
- [GITHUB_SETUP.md](./GITHUB_SETUP.md) - GitHub configuration

### External References

- [Git Handbook](https://guides.github.com/introduction/git-handbook/)
- [How to Create a Pull Request](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/proposing-changes-to-your-work-with-pull-requests/creating-a-pull-request)
- [Conventional Commits](https://www.conventionalcommits.org/)

### Tools

- [GitHub Web Editor](https://docs.github.com/en/codespaces/the-githubdev-web-based-editor)
- [GitHub CLI](https://cli.github.com/)
- [Visual Studio Code Git Extension](https://code.visualstudio.com/docs/sourcecontrol/overview)

---

## Getting Help

### Having Issues?

1. **Check the docs**: Browse [DEVELOPMENT.md](./DEVELOPMENT.md) and [docs/TESTING.md](./docs/TESTING.md)
2. **Search issues**: Look for similar problems at https://github.com/Just-Bamford/Stellar-Royalty-Splitter/issues
3. **Ask in PR**: Leave a comment on your PR with your question
4. **Open an issue**: Create a new issue describing the problem

### Want to Learn More?

- Read existing code in `backend/src/routes/` and `backend/tests/`
- Review previous PRs: https://github.com/Just-Bamford/Stellar-Royalty-Splitter/pulls?state=closed
- Check GitHub Discussions for questions and answers

### Code of Conduct

Be respectful, inclusive, and collaborative. We're all learning together.

---

## Next Steps

1. ✅ Complete this setup guide
2. ✅ Verify your environment
3. ✅ Create a feature branch
4. ✅ Make your first change
5. ✅ Run tests locally
6. ✅ Open your first PR
7. ✅ Celebrate! 🎉

Happy contributing!
