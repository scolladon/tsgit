#!/bin/bash
# Stop hook: final quality gate when session ends
# Runs lint + unit tests to ensure the project is never left broken

set -euo pipefail

cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)"

if [[ ! -f "package.json" ]]; then
  exit 0
fi

ERRORS=""

# Check for lint errors
if ! npx biome check . 2>/dev/null; then
  ERRORS="${ERRORS}\n- Biome lint/format errors detected"
fi

# Check for type errors
if ! npx tsc --noEmit 2>/dev/null; then
  ERRORS="${ERRORS}\n- TypeScript type errors detected"
fi

# Run unit tests
if ! npx vitest run --project unit 2>/dev/null; then
  ERRORS="${ERRORS}\n- Unit tests failing"
fi

if [[ -n "$ERRORS" ]]; then
  echo "Quality issues found before session end:"
  echo -e "$ERRORS"
  echo ""
  echo "The project may be in a broken state. Consider fixing before ending."
  exit 0
fi
