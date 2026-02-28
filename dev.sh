#!/usr/bin/env bash
# Dev mode: tsx watch for server auto-reload + vite HMR for client
# Runs in tmux session "pi-web-dev"
# Vite serves on DEV_PORT (8111), Express backend on BACKEND_PORT (18111)
set -euo pipefail
cd "$(dirname "$0")"

SESSION="pi-web-dev"

# Kill existing session if any
tmux kill-session -t "$SESSION" 2>/dev/null || true

export DEV_PORT="${DEV_PORT:-8111}"
export BACKEND_PORT="${BACKEND_PORT:-18111}"
export PORT="$BACKEND_PORT"
export PI_CWD="${PI_CWD:-$(pwd)}"

echo "🔧 Starting pi-web in dev mode (tmux: $SESSION)..."
echo "   http://localhost:$DEV_PORT (vite HMR → backend :$BACKEND_PORT)"

tmux new-session -d -s "$SESSION" -c "$(pwd)" \
  "DEV_PORT=$DEV_PORT BACKEND_PORT=$BACKEND_PORT PORT=$BACKEND_PORT PI_CWD=$PI_CWD npx concurrently \
    --names 'server,client' \
    --prefix-colors 'cyan,green' \
    --kill-others \
    'npx tsx watch src/server/server.ts' \
    'npx vite'"

echo "✅ Running in tmux session '$SESSION'"
echo "   Attach: tmux attach -t $SESSION"
