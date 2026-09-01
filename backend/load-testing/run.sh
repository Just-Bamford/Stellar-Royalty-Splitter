#!/usr/bin/env bash
set -euo pipefail

SCENARIO="${1:-smoke}"
BASE_URL="${BASE_URL:-http://localhost:3001}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

case "$SCENARIO" in
  smoke|normal|spike|sustained) ;;
  *) echo "usage: $0 {smoke|normal|spike|sustained}" >&2; exit 2 ;;
esac

if ! command -v k6 >/dev/null 2>&1; then
  echo "k6 is required; install it from https://grafana.com/docs/k6/latest/get-started/installation/" >&2
  exit 127
fi

mkdir -p "$ROOT/reports"
if [[ "$SCENARIO" == "smoke" ]]; then
  SCENARIO_FILE="$ROOT/scenarios/smoke.js"
else
  SCENARIO_FILE="$ROOT/scenarios/${SCENARIO}-test.js"
fi
k6 run --env BASE_URL="$BASE_URL" \
  --summary-export="$ROOT/reports/${SCENARIO}-summary.json" \
  "$SCENARIO_FILE"
