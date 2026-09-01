## [0.1.0] - 2026-07-28

### Version Info
- Frontend: v0.1.0
- Backend: v0.1.0

# Changelog

All notable changes to the Stellar Royalty Splitter project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### ✨ Features

- Application-level and feature-level error boundaries with safe fallback states
- Configuration duplication enabling users to clone existing royalty splits as editable drafts
- Automated release workflow with version validation and changelog generation

### 🐛 Bug Fixes

- Fixed missing table closing tags in CollaboratorTable component

### 🔧 Chores

- Established semantic versioning strategy
- Added release automation CI/CD pipeline
- Created changelog generation tooling

## [0.1.0] - 2024-01-15

### ✨ Features

- Initial project setup with frontend (React/Vite) and backend (Node.js/Express)
- Stellar wallet integration with Freighter
- Contract initialization and configuration management
- Primary royalty distribution system
- Secondary royalty tracking and management
- Collaborator management with address validation
- Transaction history and analytics
- Configuration import/export (JSON)
- Payment holds and suspension management
- Tax compliance reporting
- Multi-contract earnings tracking
- System health dashboard
- Admin dashboard with analytics
- Keyboard shortcuts and accessibility features

### 🐛 Bug Fixes

- Session expiration handling
- Network mismatch detection
- Form validation edge cases

### 🔧 Chores

- ESLint and Prettier configuration
- GitHub Actions CI/CD pipelines
- Database schema and migrations
- Email notification templates

---

## Release Notes

### Version Alignment

- Frontend and Backend versions stay aligned (major.minor must match)
- See [VERSIONING.md](VERSIONING.md) for details on versioning strategy

### Release Process

1. Update version in `frontend/package.json` and `backend/package.json`
2. Commit with message: `chore: release vX.Y.Z`
3. Push to main - GitHub Actions automatically:
   - Validates versions
   - Generates changelog from commits
   - Creates git tag
   - Creates GitHub Release

For detailed release process, see [VERSIONING.md](VERSIONING.md)
