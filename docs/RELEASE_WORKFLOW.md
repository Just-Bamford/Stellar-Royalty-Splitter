# Release Workflow Documentation

## Overview

The Stellar Royalty Splitter project has a fully automated CI/CD pipeline for releases. This ensures version consistency, generates changelogs, and creates tagged releases on GitHub automatically.

## How Releases Work

### Automatic Release Trigger

Releases are triggered automatically when you push changes to `main` that include version updates in `package.json` files or the `CHANGELOG.md`:

```bash
# Example: Update version and push
npm version minor          # Updates frontend/package.json
git push origin main       # Triggers release workflow
```

### Release Workflow Steps

1. **Version Parsing** - Extracts versions from `frontend/package.json` and `backend/package.json`

2. **Version Validation**
   - Checks semantic versioning format (X.Y.Z)
   - Ensures frontend and backend versions align on major.minor
   - Verifies version was incremented from last release

3. **Changelog Generation**
   - Collects commits since last tag
   - Categorizes by type: Features, Fixes, Breaking Changes, Performance, Chores
   - Generates formatted markdown entry

4. **Changelog Validation**
   - Ensures CHANGELOG.md exists and has proper structure
   - Checks for duplicate version entries

5. **Release Creation**
   - Creates annotated git tag: `v{VERSION}`
   - Creates GitHub release with changelog as body
   - Auto-generates release notes

6. **Error Handling**
   - All validation happens before tag creation
   - Failed releases don't create incomplete tags
   - Clear error messages help fix issues

## CI Workflows

### Frontend CI (`.github/workflows/frontend-ci.yml`)

Runs on changes to `frontend/**` files:

- **Version Validation** - Checks version alignment with backend
- **Type Checking** - TypeScript compilation
- **Tests** - React component tests via Vitest
- **Build** - Production bundle creation

### Backend CI (`.github/workflows/backend-ci.yml`)

Runs on changes to `backend/**` files:

- **Version Validation** - Checks version alignment with frontend
- **Linting** - ESLint on JavaScript code
- **Tests** - Jest test suite on Node 20.x and 22.x
- **Coverage** - Uploads to codecov

### Contract CI (`.github/workflows/contract-ci.yml`)

Runs on changes to Rust contract files:

- **Version Validation** - Checks version alignment
- **Format Check** - Rust formatter validation
- **Build** - WASM32 target compilation
- **Tests** - Cargo test suite with snapshots

## Version Strategy

### Semantic Versioning

All versions follow semantic versioning: `MAJOR.MINOR.PATCH`

- **MAJOR** - Breaking API changes, contract incompatibility
- **MINOR** - New features, non-breaking changes
- **PATCH** - Bug fixes, documentation

### Version Alignment Rule

Frontend and backend versions must align on `MAJOR.MINOR`:

```
✅ Frontend 0.5.2, Backend 0.5.3  (patch versions can differ)
✅ Frontend 1.0.0, Backend 1.0.1
❌ Frontend 0.5.0, Backend 0.6.0  (minor versions differ)
❌ Frontend 1.0.0, Backend 2.0.0  (major versions differ)
```

This ensures coordinated releases while allowing patch flexibility.

### Contract Versioning

The Rust contract uses its own versioning in `Cargo.toml`. While it should logically align with the JavaScript packages, it can version independently. The release workflow validates JS package alignment but doesn't enforce contract versioning.

## Changelog Format

Changelog entries are auto-generated in this format:

```markdown
## [VERSION] - DATE

### ✨ Features

- feat: New feature description (commit hash)

### 🐛 Bug Fixes

- fix: Bug fix description (commit hash)

### ⚠️ Breaking Changes

- breaking: Breaking change description (commit hash)

### ⚡ Performance

- perf: Performance improvement (commit hash)

### 🔧 Chores

- chore: Maintenance task (commit hash)

### Version Info

- Frontend: vX.Y.Z
- Backend: vX.Y.Z
```

## Release Process

### Step 1: Prepare Changes

Make your changes and commit them following conventional commit format:

```bash
git commit -m "feat: add new royalty split feature"
git commit -m "fix: correct payment calculation bug"
git commit -m "breaking: change API endpoint structure"
```

### Step 2: Update Versions

Update both `package.json` files to the same major.minor version:

```bash
# Frontend
cd frontend
npm version minor  # Updates patch or minor
cd ..

# Backend must match
cd backend
npm version minor
cd ..
```

### Step 3: Push to Main

```bash
git push origin main
```

The release workflow automatically runs and:

- Validates versions
- Generates changelog
- Creates GitHub release
- Tags the commit

### Step 4: Verify Release

Check GitHub Releases page or use:

```bash
git describe --tags  # Shows latest tag
git tag -l           # Lists all tags
```

## Troubleshooting

### Version Mismatch Error

**Problem**: Release fails with "Version mismatch: frontend X.Y.Z, backend X.Y.Z"

**Solution**: Ensure major.minor versions match between `frontend/package.json` and `backend/package.json`:

```json
// frontend/package.json
{ "version": "0.5.2" }

// backend/package.json
{ "version": "0.5.3" }  // ✅ minor versions match
```

### Version Not Updated

**Problem**: Release fails with "Version not updated"

**Solution**: You must increment the version before triggering release. Use `npm version`:

```bash
npm version major   # 1.0.0 -> 2.0.0
npm version minor   # 1.0.0 -> 1.1.0
npm version patch   # 1.0.0 -> 1.0.1
```

### CHANGELOG.md Format Error

**Problem**: Release fails with "CHANGELOG.md missing version entries"

**Solution**: Ensure CHANGELOG.md has proper version headers:

```markdown
## [0.1.0] - 2026-07-28 # ✅ Correct format

### Features

- ...

## 0.1.0 - 2026-07-28 # ❌ Wrong format (missing brackets)
```

### No Commits Since Last Tag

**Problem**: Changelog shows no entries

**Solution**: This is normal for the first release. Subsequent releases will show commits since the last tag. Ensure commits follow conventional commit format:

```bash
# Good commit messages:
git commit -m "feat: add feature"
git commit -m "fix: resolve issue"
git commit -m "perf: optimize query"

# Vague messages won't categorize well:
git commit -m "update"       # Shows as chore
git commit -m "misc fixes"   # Shows as chore
```

## Rollback

### Revert a Release

If a release has issues:

```bash
# Delete local tag
git tag -d v1.0.0

# Delete remote tag
git push origin --delete v1.0.0

# Fix the issue and re-release
```

### Revert Commits

If you need to revert changes included in a release:

```bash
# Find the commit to revert
git log --oneline

# Create a revert commit
git revert <commit-hash>

# Push to main (triggers new release)
git push origin main
```

## Manual Release (If Needed)

If automatic releases don't work, you can manually create a release:

```bash
# Create tag locally
git tag -a v0.1.0 -m "Release 0.1.0"

# Push tag to create release
git push origin v0.1.0
```

GitHub will automatically detect the tag and create a release page.

## Files Reference

| File                                    | Purpose                           |
| --------------------------------------- | --------------------------------- |
| `.github/workflows/release.yml`         | Main release workflow             |
| `.github/workflows/frontend-ci.yml`     | Frontend CI pipeline              |
| `.github/workflows/backend-ci.yml`      | Backend CI pipeline               |
| `.github/workflows/contract-ci.yml`     | Contract CI pipeline              |
| `.github/scripts/generate-changelog.js` | Changelog generation              |
| `.github/scripts/validate-release.js`   | Version validation                |
| `CHANGELOG.md`                          | Public changelog                  |
| `VERSIONING.md`                         | Versioning strategy documentation |

## Best Practices

1. **Commit Often** - Small, atomic commits are easier to categorize
2. **Use Conventional Commits** - `feat:`, `fix:`, `breaking:` prefixes
3. **Keep Versions Synchronized** - Always update major.minor together
4. **Review Before Release** - Check changelog preview before pushing
5. **Test Locally First** - Run validation scripts before pushing
6. **Document Breaking Changes** - Add details in commit body for breaking changes

## Support

For issues with the release workflow:

1. Check the workflow logs on GitHub Actions
2. Verify version formats and alignment
3. Check commit message formatting
4. Ensure CHANGELOG.md structure is valid
5. Review the troubleshooting section above
