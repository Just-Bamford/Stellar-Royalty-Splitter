# GitHub Repository Setup Guide

This document describes the recommended GitHub configuration for the Stellar Royalty Splitter repository to prevent merge conflicts and CI failures.

## Branch Protection Rules

### How to Set Up (GitHub Web UI)

1. Go to: **Settings → Branches → Add rule**
2. Apply rule to branch: `main`
3. Configure the following settings:

### Recommended Configuration

#### 1. Require Pull Request Reviews Before Merging

- ✅ **Require approvals**: 1
- ✅ **Dismiss stale pull request approvals when new commits are pushed**
- ✅ **Require review from code owners** (if CODEOWNERS file exists)

#### 2. Require Status Checks to Pass Before Merging

- ✅ **Require branches to be up to date before merging**
- ✅ **Require passing builds before merging**

Select these required checks:

- `Backend CI / test` (Node 20.x)
- `Backend CI / test` (Node 22.x)
- `Contract CI / cargo test (wasm32-unknown-unknown)`

#### 3. Require Code Reviews

- ✅ **Require approval of the most recent reviewable push**
- ✅ **Dismiss stale pull request approvals when new commits are pushed**

#### 4. Other Protections

- ✅ **Allow force pushes** → None
- ✅ **Allow deletions** → Unchecked
- ✅ **Allow auto-merge** → Do not allow (requires manual merge)

---

## Step-by-Step Setup Instructions

### Via GitHub CLI

If you prefer using GitHub CLI:

```bash
# Install gh if not already installed
# https://cli.github.com

# Set required status checks
gh repo edit \
  --enable-auto-merge=false \
  --enable-squash-merge=false \
  --enable-rebase-merge=false

# Require pull request reviews (using web UI, no CLI support yet)
```

### Via Web UI (Detailed Steps)

1. **Navigate to Branch Protection**
   - Go to your repository
   - Click "Settings"
   - Click "Branches" in the left sidebar
   - Under "Branch protection rules", click "Add rule"

2. **Configure Rule Name**
   - Branch name pattern: `main`

3. **Enable Required Pull Request Reviews**
   - Check: "Require pull request reviews before merging"
   - Required number of reviews: `1`
   - Check: "Dismiss stale pull request approvals when new commits are pushed"
   - Uncheck: "Require approval of the most recent reviewable push" (optional)

4. **Enable Status Checks**
   - Check: "Require status checks to pass before merging"
   - Check: "Require branches to be up to date before merging"
   - Search for and select:
     - `Backend CI / test (20.x)`
     - `Backend CI / test (22.x)`
     - `Contract CI / cargo test (wasm32-unknown-unknown)`

5. **Restrict Who Can Push**
   - Uncheck: "Allow force pushes" (or select "Restricted to administrators")
   - Uncheck: "Allow deletions"

6. **Create the Rule**
   - Click "Create"

---

## Enforce Policies

### What This Prevents

✅ Merges without CI passing
✅ Merges without code review
✅ Force pushes to main
✅ Direct pushes bypassing PR checks
✅ Accidental deletions of main branch

### What Contributors Can Still Do

✅ Create branches freely
✅ Create PRs from any branch
✅ Push to their own branches
✅ Rebase/squash commits locally

---

## Additional Recommendations

### 1. Create a CODEOWNERS File

Create `.github/CODEOWNERS`:

```
# Backend code
backend/src/            @maintainer-username
backend/tests/          @maintainer-username

# Smart contract code
src/                    @maintainer-username
tests/                  @maintainer-username

# CI/CD
.github/workflows/      @maintainer-username
```

### 2. Enable Auto-Dismiss Stale Reviews

Already included in the protection rule configuration above.

### 3. Require Commit Signing (Optional)

For enhanced security:

1. Go to Settings → Branches
2. Edit the rule
3. Check: "Require commit signatures"
4. Contributors must sign commits with GPG keys

### 4. Enforce Merge Strategy (Optional)

Go to Settings → General → Pull Requests:

- ✅ Allow squash merging (recommended for clean history)
- ❌ Allow merge commits
- ✅ Allow rebase merging

Default to: **Squash and merge**

---

## Verification

After setting up branch protection, verify it works:

1. Create a test branch: `git checkout -b test/protection`
2. Make a dummy change: `echo "test" > test.txt`
3. Commit and push:
   ```bash
   git add test.txt
   git commit -m "test: verify branch protection"
   git push -u origin test/protection
   ```
4. Create a PR on GitHub
5. Try to merge WITHOUT approvals/passing CI:
   - **Button should be disabled** with message "Some checks haven't completed yet"
6. After CI passes and you get 1 approval:
   - **Merge button becomes active**

---

## Troubleshooting

### "Some checks haven't completed yet" Error

- Wait for CI workflows to complete
- Check workflow logs for failures
- Fix issues locally and push new commits

### "Approval from a code owner is required" Error

- Get approval from someone in CODEOWNERS
- Make sure reviewer has write access to repo

### "Waiting on required status checks"

- CI hasn't finished running
- Go to PR → "Checks" tab to monitor progress
- Common failures:
  - ESLint errors → run `npm run lint` locally
  - Test failures → run `npm test` locally
  - Build failures → check error logs

---

## Maintenance

### Quarterly Review

Every 3 months, review:

- Are branches still getting merged with failures? (if yes, CI setup needs review)
- Are PRs stuck waiting? (if yes, SLA issues need attention)
- Have requirements changed? (update accordingly)

### When Adding New Workflows

If you add new CI workflows:

1. Update the branch protection rule
2. Add new checks to the required list
3. Test with a dummy PR

---

## References

- [GitHub Branch Protection Rules](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)
- [GitHub Status Checks](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories/about-status-checks)
- [GitHub CODEOWNERS](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners)
