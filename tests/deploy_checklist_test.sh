#!/usr/bin/env bash
# deploy_checklist_test.sh - E2E test to verify deploy.sh checklist prompt

set -euo pipefail

echo "▶ Running deploy checklist E2E test..."

# Fake dependencies so the script doesn't fail on preflight checks unnecessarily
# Wait, actually we can just run it and see if it fails at the prompt before
# checking for cargo/stellar. The prompt is *before* the command -v cargo.
# So we just pipe "n" and check the exit code.

SCRIPT_PATH="./scripts/deploy.sh"

echo "Test 1: Answering 'n' should abort deployment"
# We expect exit code 1
if echo "n" | $SCRIPT_PATH > /dev/null 2>&1; then
  echo "❌ ERROR: deploy.sh did not abort when 'n' was provided."
  exit 1
else
  echo "✅ deploy.sh aborted correctly."
fi

echo "Test 2: Using --force should bypass the prompt"
# We don't want it to actually deploy, but we can verify it passes the prompt
# and fails at 'cargo' or 'stellar' preflight or proceeds further.
# The exit code might be 1 if cargo/stellar isn't installed, but we can grep the output.

OUTPUT=$($SCRIPT_PATH --force 2>&1 || true)
if echo "$OUTPUT" | grep -q "SECURITY CHECKLIST"; then
  echo "❌ ERROR: deploy.sh prompted for checklist even with --force"
  exit 1
else
  echo "✅ deploy.sh bypassed prompt correctly with --force."
fi

echo "Test 3: Using --ci should bypass the prompt"
OUTPUT=$($SCRIPT_PATH --ci 2>&1 || true)
if echo "$OUTPUT" | grep -q "SECURITY CHECKLIST"; then
  echo "❌ ERROR: deploy.sh prompted for checklist even with --ci"
  exit 1
else
  echo "✅ deploy.sh bypassed prompt correctly with --ci."
fi

echo "✅ All deploy checklist tests passed!"
exit 0
