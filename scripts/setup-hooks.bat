@echo off
REM Setup development hooks for contributors (Windows)
REM Run: scripts\setup-hooks.bat

setlocal enabledelayedexpansion

echo Setting up development hooks...

REM Create .git\hooks directory if it doesn't exist
if not exist ".git\hooks" mkdir .git\hooks

REM Create pre-commit hook (PowerShell)
(
echo ^#!/bin/bash
echo # Pre-commit hook: Check backend code quality
echo.
echo if git diff --cached --quiet --exit-code -- backend/; then
echo     exit 0
echo fi
echo.
echo echo "Running pre-commit checks on backend files..."
echo.
echo cd backend
echo.
echo # Check if node_modules exists
echo if [ ! -d "node_modules" ]; then
echo     echo "Running npm ci..."
echo     npm ci
echo fi
echo.
echo # Get list of staged files in backend
echo STAGED_FILES=$^(git diff --cached --name-only -- .^)
echo.
echo # Run ESLint on staged files
echo echo "Running ESLint on modified files..."
echo if echo "$STAGED_FILES" ^| grep -q "\.js$"; then
echo     npx eslint $^(echo "$STAGED_FILES" ^| grep "\.js$" ^| tr '\n' ' '^) ^|^| {
echo         echo "❌ ESLint failed. Run 'npm run format' to fix issues."
echo         exit 1
echo     }
echo fi
echo.
echo echo "✅ Pre-commit checks passed"
) > .git\hooks\pre-commit

REM Create pre-push hook (PowerShell)
(
echo ^#!/bin/bash
echo # Pre-push hook: Run tests before pushing
echo.
echo # Get current branch
echo BRANCH=$^(git rev-parse --abbrev-ref HEAD^)
echo.
echo # Skip checks on main branch (these run in CI^)
echo if [ "$BRANCH" = "main" ]; then
echo     echo "Pushing to main. CI will validate."
echo     exit 0
echo fi
echo.
echo # Check if backend files changed
echo if ! git diff origin/main...HEAD --quiet -- backend/; then
echo     echo "Backend files changed. Running tests..."
echo     cd backend
echo.
echo     if [ ! -d "node_modules" ]; then
echo         npm ci
echo     fi
echo.
echo     npm test ^|^| {
echo         echo "❌ Tests failed. Fix issues before pushing."
echo         exit 1
echo     }
echo fi
echo.
echo echo "✅ All checks passed. Pushing..."
) > .git\hooks\pre-push

echo.
echo ✅ Git hooks installed successfully!
echo.
echo Hooks installed:
echo   - pre-commit: Runs ESLint on modified JS files
echo   - pre-push: Runs tests before pushing to remote
echo.
echo To disable a hook temporarily:
echo   git commit --no-verify
echo   git push --no-verify
echo.
