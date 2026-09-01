# Release Guide

This guide explains how to perform a release of the Stellar Royalty Splitter project.

## Quick Start

1. Update versions in `package.json` files
2. Commit and push to `main`
3. GitHub Actions automatically creates the release

## Step-by-Step

### Step 1: Prepare Changes

Ensure your feature branch is up-to-date and all tests pass:

```bash
git checkout main
git pull origin main
npm test  # Run all tests
```

### Step 2: Determine Version Change

Use [Semantic Versioning](https://semver.org/):

- **PATCH** (0.0.X): Bug fixes only
- **MINOR** (0.X.0): New features, backward-compatible
- **MAJOR** (X.0.0): Breaking changes

Example version progression:

```
0.1.0 → 0.1.1 (patch fix)
0.1.1 → 0.2.0 (new feature)
0.2.0 → 1.0.0 (breaking change)
```

### Step 3: Update Versions

Update BOTH `frontend/package.json` and `backend/package.json`:

```json
{
  "name": "stellar-royalty-splitter-ui",
  "version": "0.2.0"
}
```

**IMPORTANT**: Major and minor versions MUST match:

- ✅ `frontend: 0.2.0` + `backend: 0.2.1` (patch can differ)
- ✅ `frontend: 0.2.0` + `backend: 0.2.0` (exact match)
- ❌ `frontend: 0.2.0` + `backend: 0.1.0` (minor mismatch)

### Step 4: Commit Changes

Use a conventional commit message:

```bash
git add frontend/package.json backend/package.json
git commit -m "chore: release v0.2.0"
git push origin main
```

### Step 5: Monitor Workflow

GitHub Actions automatically runs:

1. **Version Validation**
   - Checks semantic versioning format
   - Verifies major.minor alignment
   - Ensures versions differ from last tag

2. **Changelog Generation**
   - Extracts commits since last tag
   - Categorizes by type (feat, fix, perf, etc.)
   - Formats as markdown

3. **Release Creation**
   - Creates git tag (e.g., `v0.2.0`)
   - Creates GitHub Release
   - Attaches generated changelog

Check status: https://github.com/your-org/Stellar-Royalty-Splitter/actions

### Step 6: Verify Release

1. Go to **Releases** on GitHub
2. Click the latest release (should be `v0.2.0`)
3. Verify:
   - ✅ Tag name correct (`v0.2.0`)
   - ✅ Changelog complete
   - ✅ Features/fixes properly listed

## Rollback

If a release fails:

1. **Check workflow logs** (Actions tab)
2. **Fix the issue** (usually version format)
3. **Revert commit** if needed
4. **Make corrections** to versions
5. **Push again** - workflow retries

No incomplete tags are created if validation fails, so rollbacks are safe.

## What Happens Automatically

The release workflow:

- ✅ Validates version format (X.Y.Z)
- ✅ Validates version alignment (frontend/backend)
- ✅ Generates changelog from commits
- ✅ Creates annotated git tag
- ✅ Creates GitHub Release with changelog
- ✅ Fails safely (no tag if validation fails)

## Commit Message Convention

For better changelog categorization, use:

```
feat: add new feature
fix: fix a bug
perf: improve performance
docs: documentation changes
test: add tests
chore: build, deps, tooling
breaking: BREAKING CHANGE
```

The changelog generator reads these to auto-categorize entries.

Example:

```
feat(error-boundary): add application-level error handling

Implements safe error logging and feature-level isolation
to prevent one component failure from breaking the app.

Fixes #123
```

## Common Issues

### Version format invalid

**Error**: `Invalid frontend version format: "0.2" (expected X.Y.Z)`

**Fix**: Ensure version is `X.Y.Z` format (e.g., `0.2.0`)

### Version mismatch

**Error**: `Major version mismatch: frontend 0.2 vs backend 0.1`

**Fix**: Update both files to have matching major.minor (patch can differ)

### Version not updated

**Error**: `Version not updated: still at 0.1.0 (last release was 0.1.0)`

**Fix**: Change version to something new (e.g., `0.1.1` or `0.2.0`)

### Changelog missing

**Error**: `CHANGELOG.md missing version headers`

**Fix**: Changelog is auto-generated, but structure is validated. Ensure `## [X.Y.Z]` headers exist.

## Advanced

### Manual Testing

To test the release process locally:

```bash
# Test changelog generation
node .github/scripts/generate-changelog.js

# Test validation
node .github/scripts/validate-release.js
```

### Monitoring Releases

View all releases and tags:

```bash
git tag  # List all tags
git describe --tags  # Show current tag
```

### Release History

View release history at: `/releases`

## Support

For issues with the release process:

1. Check [VERSIONING.md](./VERSIONING.md) for strategy details
2. Review workflow logs in GitHub Actions
3. Check commit messages follow convention
4. Verify version formats are valid

## Examples

### Patch Release

```bash
# Current: 0.1.5
# Change to: 0.1.6

# frontend/package.json
"version": "0.1.6"

# backend/package.json
"version": "0.1.6"

git commit -m "chore: release v0.1.6"
```

### Minor Release

```bash
# Current: 0.1.5
# Change to: 0.2.0

# frontend/package.json
"version": "0.2.0"

# backend/package.json
"version": "0.2.0"

git commit -m "chore: release v0.2.0"
```

### Major Release (Breaking)

```bash
# Current: 0.2.3
# Change to: 1.0.0

# frontend/package.json
"version": "1.0.0"

# backend/package.json
"version": "1.0.0"

git commit -m "breaking: release v1.0.0 - redesign API"
```

## See Also

- [VERSIONING.md](./VERSIONING.md) - Version strategy details
- [CHANGELOG.md](./CHANGELOG.md) - Release history
- [.github/workflows/release.yml](./.github/workflows/release.yml) - Workflow definition
