#!/usr/bin/env bash
# Prod mode: build and run pipane
set -euo pipefail
cd "$(dirname "$0")"

export PI_CWD="${PI_CWD:-$(pwd)}"

echo "🏗️  Building pipane for production..."

# Build client + server
echo "   → Building client + server..."
npm run build

echo "✅ Build complete."
echo ""

exec node bin/pipane.js "$@"
