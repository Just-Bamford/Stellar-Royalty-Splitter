# Versioning Strategy

This document defines the versioning and release process for the Stellar Royalty Splitter project.

## Semantic Versioning

We follow [Semantic Versioning 2.0.0](https://semver.org/):

- **MAJOR** version: Breaking changes, incompatible API changes
- **MINOR** version: New features, backward-compatible additions
- **PATCH** version: Bug fixes, backward-compatible changes

Example: `1.2.3` = Major 1, Minor 2, Patch 3

## Version Alignment

Frontend and backend versions must stay aligned:

- Major and minor versions MUST match (e.g., `1.2.x` frontend with `1.2.y` backend)
- Patch versions may differ (e.g., `1.2.3` frontend with `1.2.5` backend if patch fix needed)
- Both versions are updated in `package.json` files before release

## Release Process

### Prerequisites

- All tests pass on main branch
- Code review completed and approved
- No failing CI checks

### Manual Release (Recommended for Production)

1. **Update Versions**
   - Update `frontend/package.json` version
   - Update `backend/package.json` version
   - Ensure major.minor match

2. **Prepare Release Notes**
   - Commit version changes with message: `chore: release v1.2.3`
   - Push to main branch

3. **Trigger Release**
   - GitHub Actions automatically detects version change
   - Validates versions and generates changelog
   - Creates git tag and GitHub Release
   - Changelog is auto-generated from commits

4. **Verify Release**
   - Check GitHub Release page
   - Verify tag is created
   - Review changelog for completeness

### Automated Release Workflow

The CI/CD pipeline (`release.yml`) automatically:

1. **Detects version changes** when `package.json` files are modified
2. **Validates versions** (semantic versioning format, alignment)
3. **Generates changelog** from git commits since last tag
4. **Creates git tag** (`v1.2.3`)
5. **Creates GitHub Release** with changelog
6. **Fails safely** - if validation fails, no tag is created

## Commit Message Convention

Use conventional commits for better changelog generation:

```
feat: add new payment method
fix: resolve race condition in distribution
perf: optimize collaborator query
docs: update API documentation
chore: update dependencies
test: add integration tests
breaking: remove deprecated API endpoint
```

Format: `<type>(<scope>): <subject>`

### Types

- `feat`: New feature
- `fix`: Bug fix
- `perf`: Performance improvement
- `docs`: Documentation
- `test`: Tests
- `chore`: Build, deps, CI config
- `breaking`: Breaking change

## Changelog Format

Changelogs are organized by:

- **⚠️ Breaking Changes**: Incompatible changes requiring migration
- **✨ Features**: New capabilities
- **🐛 Bug Fixes**: Resolved issues
- **⚡ Performance**: Speed/efficiency improvements
- **🔧 Chores**: Build, dependencies, tooling

Example:

```markdown
## [1.2.0] - 2024-01-15

### ⚠️ Breaking Changes

- Change API response format (abc1234)

### ✨ Features

- Add configuration duplication (def5678)
- Improve error boundaries (ghi9012)

### 🐛 Bug Fixes

- Fix payment calculation issue (jkl3456)

### Version Info

- Frontend: v1.2.0
- Backend: v1.2.0
```

## Version Release Checklist

- [ ] All tests passing
- [ ] Code review approved
- [ ] Version numbers updated in package.json files
- [ ] Major.minor versions aligned between frontend/backend
- [ ] Commit message follows convention
- [ ] Push to main branch
- [ ] Wait for GitHub Actions to complete
- [ ] Verify release page and changelog
- [ ] Tag created successfully
- [ ] No breaking changes without documentation

## Failed Release Recovery

If a release fails:

1. **Check the workflow logs** - GitHub Actions shows the error
2. **Fix the issue** - Most likely version format or alignment
3. **Update versions again** if needed
4. **Push to main** - Workflow will retry
5. **Verify the next run** succeeds

No incomplete tags are created if validation fails.

## Examples

### Normal Minor Release

```
frontend/package.json: 1.0.0 → 1.1.0
backend/package.json: 1.0.0 → 1.1.0
```

### Patch Release (Staggered)

```
frontend/package.json: 1.1.0 → 1.1.1
backend/package.json: 1.1.0 → 1.1.0 (no change, has next patch)
```

Later:

```
backend/package.json: 1.1.0 → 1.1.1
```

### Major Release (Breaking Change)

```
frontend/package.json: 1.0.0 → 2.0.0
backend/package.json: 1.0.0 → 2.0.0
Commit: "breaking: redesign API response format"
```

## Maintenance

- Versions are managed via `package.json` files
- No manual version tracking needed
- Changelog is auto-generated from commits
- Tags follow pattern: `v1.2.3`
- Releases are immutable - retag only in exceptional cases

## CI Integration

See `.github/workflows/release.yml` for:

- Version validation rules
- Changelog generation logic
- Tag creation process
- Release failure handling
