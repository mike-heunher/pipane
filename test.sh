#!/usr/bin/env bash
set -euo pipefail

npm run test:all

echo ""
echo "✅ Typecheck, coverage, build, and E2E tests passed"
