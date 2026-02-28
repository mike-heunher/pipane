#!/usr/bin/env bash
set -euo pipefail

echo "=== Building ==="
npm run build

echo ""
echo "=== Unit tests ==="
npm run test

echo ""
echo "=== E2E tests ==="
npx playwright test --timeout 60000

echo ""
echo "✅ All tests passed"
