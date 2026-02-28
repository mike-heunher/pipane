#!/usr/bin/env bash
# Prod mode: build client with vite, compile server with bun, run in tmux
# Runs in tmux session "pi-web-prod"
set -euo pipefail
cd "$(dirname "$0")"

SESSION="pi-web-prod"
BUILD_DIR="dist"

export PORT="${PORT:-8222}"
export PI_CWD="${PI_CWD:-$(pwd)}"
export NODE_ENV="production"

echo "🏗️  Building pi-web for production..."

# 0. Rebuild pi-web-ui with tsc (tsgo has a bug with useDefineForClassFields: false)
echo "   → Rebuilding pi-web-ui (tsc)..."
WEB_UI_DIR="$(node -e "const p=require.resolve('@mariozechner/pi-web-ui');const marker='node_modules/@mariozechner/pi-web-ui';console.log(p.substring(0,p.indexOf(marker)+marker.length))")"
npx tsc -p "$WEB_UI_DIR/tsconfig.build.json"

# 1. Build client (vite + tailwind)
echo "   → Building client..."
npx vite build

# 2. Compile server with bun
echo "   → Compiling server with bun..."
bun build src/server/server.ts \
  --target=bun \
  --outdir="$BUILD_DIR/server" \
  --entry-naming="server.js"

echo "✅ Build complete."

# Kill existing session if any
tmux kill-session -t "$SESSION" 2>/dev/null || true

echo "🚀 Starting pi-web in production mode (tmux: $SESSION)..."
echo "   http://localhost:$PORT"

tmux new-session -d -s "$SESSION" -c "$(pwd)" \
  "PORT=$PORT PI_CWD=$PI_CWD NODE_ENV=production bun run $BUILD_DIR/server/server.js"

echo "✅ Running in tmux session '$SESSION'"
echo "   Attach: tmux attach -t $SESSION"
