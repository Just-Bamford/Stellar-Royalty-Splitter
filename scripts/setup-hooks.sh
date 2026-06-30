#!/bin/bash
# Setup development hooks for contributors
# Run: ./scripts/setup-hooks.sh

set -e

echo "Setting up development hooks..."

# Create pre-commit hook for backend
mkdir -p .git/hooks

cat > .git/hooks/pre-commit << 'EOF'
#!/bin/bash
# Pre-commit hook: Check backend code quality

if git diff --cached --quiet --exit-code -- backend/; then
    exit 0
fi

echo "Running pre-commit checks on backend files..."

cd backend

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
    echo "Running npm ci..."
    npm ci
fi

# Get list of staged files in backend
STAGED_FILES=$(git diff --cached --name-only -- .)

# Run ESLint on staged files
echo "Running ESLint on modified files..."
if echo "$STAGED_FILES" | grep -q "\.js$"; then
    npx eslint $(echo "$STAGED_FILES" | grep "\.js$" | tr '\n' ' ') || {
        echo "❌ ESLint failed. Run 'npm run format' to fix issues."
        exit 1
    }
fi

echo "✅ Pre-commit checks passed"
EOF

chmod +x .git/hooks/pre-commit

# Create pre-push hook for backend tests
cat > .git/hooks/pre-push << 'EOF'
#!/bin/bash
# Pre-push hook: Run tests before pushing

# Get current branch
BRANCH=$(git rev-parse --abbrev-ref HEAD)

# Skip checks on main branch (these run in CI)
if [ "$BRANCH" = "main" ]; then
    echo "Pushing to main. CI will validate."
    exit 0
fi

# Check if backend files changed
if ! git diff origin/main...HEAD --quiet -- backend/; then
    echo "Backend files changed. Running tests..."
    cd backend
    
    if [ ! -d "node_modules" ]; then
        npm ci
    fi
    
    npm test || {
        echo "❌ Tests failed. Fix issues before pushing."
        exit 1
    }
fi

echo "✅ All checks passed. Pushing..."
EOF

chmod +x .git/hooks/pre-push

echo "✅ Git hooks installed successfully!"
echo ""
echo "Hooks installed:"
echo "  - pre-commit: Runs ESLint on modified JS files"
echo "  - pre-push: Runs tests before pushing to remote"
echo ""
echo "To disable a hook temporarily:"
echo "  git commit --no-verify"
echo "  git push --no-verify"
