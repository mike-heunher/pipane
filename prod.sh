#!/usr/bin/env bash
# Prod mode: build and run pipane
set -euo pipefail
cd "$(dirname "$0")"

export PI_CWD="${PI_CWD:-$(pwd)}"

echo "🏗️  Building pipane for production..."

# Rebuild pi-web-ui with tsc (tsgo has a bug with useDefineForClassFields: false)
echo "   → Rebuilding pi-web-ui (tsc)..."
WEB_UI_DIR="$(node -e "const p=require.resolve('@mariozechner/pi-web-ui');const marker='node_modules/@mariozechner/pi-web-ui';console.log(p.substring(0,p.indexOf(marker)+marker.length))")"
npx tsc -p "$WEB_UI_DIR/tsconfig.build.json"

# Build client + server
echo "   → Building client + server..."
npm run build

echo "✅ Build complete."
echo ""

exec node bin/pipane.js "$@"
