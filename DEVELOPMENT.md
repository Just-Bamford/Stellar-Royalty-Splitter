# Development Guide

Complete setup and development instructions for the Stellar Royalty Splitter project.

## Table of Contents

1. [Quick Start](#quick-start)
2. [Frontend Setup](#frontend-setup)
3. [Backend Setup](#backend-setup)
4. [Smart Contract Setup](#smart-contract-setup)
5. [Running Locally](#running-locally)
6. [Testing](#testing)
7. [Debugging](#debugging)
8. [Common Issues](#common-issues)

---

## Quick Start

### Prerequisites

- **Node.js**: 20.x LTS (download from [nodejs.org](https://nodejs.org))
- **Rust**: Latest stable (install from [rustup.rs](https://rustup.rs))
- **Git**: Latest version
- **Visual Studio Build Tools** (Windows only): Required for native modules
  - Install from [Visual Studio](https://visualstudio.microsoft.com/downloads/)
  - Select "Desktop development with C++"

### Initial Setup

```bash
# Clone the repository
git clone https://github.com/your-org/stellar-royalty-splitter.git
cd stellar-royalty-splitter

# Install development hooks (optional but recommended)
./scripts/setup-hooks.sh  # macOS/Linux
# or
.\scripts\setup-hooks.bat  # Windows
```

---

## Frontend Setup

### Installation

```bash
# Navigate to frontend directory
cd frontend

# Install dependencies
npm install

# Verify Node version
node --version  # Should be 20.x or later
```

### Development Server

```bash
npm run dev

# Server runs on http://localhost:5173 (default Vite port)
```

### Build for Production

```bash
npm run build
npm run preview  # Preview production build
```

### Quality Checks

```bash
npm run lint
npm run format
```

---

## Backend Setup

### Installation

```bash
# Navigate to backend directory
cd backend

# Install dependencies
npm ci  # Use 'npm ci' instead of 'npm install' for reproducible builds

# Verify Node version
node --version  # Should be 20.x or 22.x
```

### Environment Setup

```bash
# Copy example env file
cp .env.example .env

# Edit .env with your configuration
# Required variables:
#   - DATABASE_PATH: Path to SQLite database
#   - JWT_SECRET: Secret key for JWT tokens
#   - STELLAR_NETWORK: testnet or public
#   - PORT: Server port (default 5000)

cat .env  # Verify your setup
```

For detailed configuration options, see [SECRETS_MANAGER.md](./backend/SECRETS_MANAGER.md)

### Development Server

```bash
npm run dev

# Server runs on http://localhost:5000
# Auto-restarts on file changes
```

### Production Build

```bash
npm start

# Server runs on http://localhost:5000
# No file watching - pure node execution
```

### Quality Checks

```bash
# Linting
npm run lint

# Auto-format code
npm run format

# Run tests
npm test

# Run specific test file
npm test -- admin.test.js
```

### Database Initialization

```bash
# Database auto-initializes on first run
# Check database schema in: backend/src/database/

# To reset database:
rm database.db  # Then restart server
```

---

## Smart Contract Setup

### Installation

```bash
# Rust stable is required
rustup default stable
rustup target add wasm32-unknown-unknown
rustup component add rustfmt

# Verify installation
rustc --version
cargo --version
```

### Build

```bash
# Build for WASM (Stellar deployment)
cargo build --target wasm32-unknown-unknown --release

# Output: target/wasm32-unknown-unknown/release/stellar_royalty_splitter.wasm
```

### Testing

```bash
# Run all tests
cargo test --workspace --locked --features testutils

# Run specific test
cargo test --package stellar-royalty-splitter test_distribute

# Run tests with output
cargo test -- --nocapture

# Run storage snapshot tests
cargo test --workspace --locked --features testutils test_storage_snapshot
```

### Code Quality

```bash
# Check formatting
cargo fmt --all -- --check

# Auto-format
cargo fmt --all

# Clippy lints
cargo clippy --all-targets
```

### Contract Documentation

See [SOROBAN.md](./SOROBAN.md) for contract-specific development details.

---

## Running Locally

### All Services (Recommended Development Setup)

In separate terminal windows:

**Terminal 1: Smart Contract (Stellar network)**

```bash
# Install Stellar CLI (one-time)
# https://developers.stellar.org/docs/build/smart-contracts#using-stellar-cli

stellar contract build  # Watch for changes
```

**Terminal 2: Backend API**

```bash
cd backend
npm run dev

# Server: http://localhost:5000
# Logs: Check console output
```

**Terminal 3: Frontend UI**

```bash
cd frontend
npm run dev

# UI: http://localhost:5173
```

### Check Services Are Running

```bash
# Backend health check
curl http://localhost:5000/health

# Expected response:
# {"status":"healthy","version":"0.1.0"}
```

---

## Testing

### Backend Tests

```bash
cd backend

# Run all tests
npm test

# Watch mode (continuous)
npm test -- --watch

# Run specific file
npm test -- health.test.js

# Run with coverage
npm test -- --coverage
```

### Contract Tests

```bash
# Run all contract tests
cargo test --workspace --locked --features testutils

# Run with backtrace on failure
RUST_BACKTRACE=1 cargo test --workspace --locked --features testutils

# Run specific test
cargo test test_distribute
```

### Integration Tests

```bash
cd backend

# Run integration tests only
npm test -- distribute.integration.test.js

# These test end-to-end flows between components
```

---

## Debugging

### Backend Debugging

#### Verbose Logging

```bash
# Enable debug logs
DEBUG=stellar* npm run dev
DEBUG=* npm run dev  # All logs

# Or set in .env
DEBUG=stellar*
```

#### VS Code Debugging

Add to `.vscode/launch.json`:

```json
{
  "type": "node",
  "request": "launch",
  "name": "Backend Dev",
  "program": "${workspaceFolder}/backend/src/index.js",
  "restart": true,
  "console": "integratedTerminal"
}
```

Press F5 to start debugging.

#### Network Inspection

```bash
# Use cURL to test endpoints
curl -X GET http://localhost:5000/health
curl -X POST http://localhost:5000/api/initialize \
  -H "Content-Type: application/json" \
  -d '{"collaborators": [...]}'
```

### Contract Debugging

#### Add Debug Output

```rust
use soroban_sdk::log;

log!(&env, "Debug message: {}", value);
```

#### Test with Assertions

```rust
#[test]
fn test_example() {
    let result = perform_action();
    assert_eq!(result, expected_value);
    assert!(condition, "error message");
}
```

---

## Common Issues

### Node.js Version Mismatch

**Issue**: "This version of npm does not support Node v18.x"

```bash
# Install Node 20.x LTS
node --version  # Check current

# Using nvm (macOS/Linux):
nvm install 20
nvm use 20

# Or download from nodejs.org and install
```

### better-sqlite3 Build Fails (Windows)

**Issue**: `gyp ERR! find VS Could not find any Visual Studio`

**Solutions**:

Option 1: Install Visual Studio Build Tools

- Download from [Visual Studio](https://visualstudio.microsoft.com/downloads/)
- Select "Desktop development with C++"
- Restart terminal

Option 2: Use WSL2

```bash
wsl --install
# Then develop inside WSL
```

Option 3: Skip native module (tests run in CI)

```bash
npm ci --omit=optional
```

### Port Already in Use

**Issue**: "EADDRINUSE :::5000"

```bash
# Find process using port 5000
netstat -ano | findstr :5000  # Windows
lsof -i :5000                  # macOS/Linux

# Kill the process
taskkill /PID <PID> /F        # Windows
kill -9 <PID>                  # macOS/Linux

# Or use different port
PORT=5001 npm run dev
```

### Database Locked

**Issue**: "database is locked"

```bash
# Stop all processes using the database
pkill -f "node.*backend"

# Or delete and recreate
rm backend/database.db
npm run dev  # Will create new database
```

### Git Merge Conflicts

**Issue**: Conflicts after pulling main

```bash
# Option 1: Abort and rebase
git merge --abort
git fetch origin
git rebase origin/main
# Fix conflicts in editor
git add .
git rebase --continue

# Option 2: Use mergetool
git mergetool
```

### Cargo Build Cache Issues

**Issue**: "Cargo build unexpectedly fails"

```bash
# Clear cache
cargo clean

# Rebuild
cargo build --target wasm32-unknown-unknown --release
```

### ESLint/Prettier Conflicts

**Issue**: Lint errors even after formatting

```bash
# Use format script (fixes both prettier and eslint)
cd backend
npm run format

# Or fix manually:
npx eslint src/**/*.js --fix
npx prettier --write src/**/*.js
```

---

## Performance Tips

### Backend

- Use database indexes for frequently queried fields
- Implement caching for contract state queries
- Monitor response times with metrics endpoint

### Contract

- Minimize state writes
- Use efficient data structures
- Test gas costs with `cargo test`

### Frontend

- Use React DevTools for component profiling
- Lazy-load routes and components
- Monitor bundle size

---

## Contributing

For contribution guidelines, see [CONTRIBUTING.md](./CONTRIBUTING.md)

For GitHub setup and branch protection, see [GITHUB_SETUP.md](./GITHUB_SETUP.md)

---

## Support

- **Documentation**: Check [API.md](./backend/API.md)
- **Issues**: Search [GitHub Issues](https://github.com/your-org/stellar-royalty-splitter/issues)
- **Discussions**: GitHub Discussions
- **Email**: maintainers@example.com
