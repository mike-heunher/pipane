#!/usr/bin/env bash
# Dev mode: tsx watch for server auto-reload + vite HMR for client
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

SESSION="pi-web-dev"
DEV_PORT="${DEV_PORT:-8111}"
BACKEND_PORT="${BACKEND_PORT:-18111}"
PI_CWD="${PI_CWD:-$SCRIPT_DIR}"

echo "🚀 Starting local development..."

ensure_tmux_window() {
    local session="$1"
    local window="${2:-}"
    local target="${session}${window:+:$window}"
    if tmux has-session -t "$session" 2>/dev/null; then
        if tmux send-keys -t "$target" "" 2>/dev/null; then
            echo "📦 Reusing tmux session '$session'${window:+ window '$window'}..."
            tmux send-keys -t "$target" C-c
            sleep 1
            return
        fi
        echo "⚠️  Dead pane in '$session', recreating..."
        tmux kill-session -t "$session" 2>/dev/null
    fi
    echo "📦 Creating tmux session '$session'..."
    tmux new-session -d -s "$session"
}

ensure_tmux_window "$SESSION"

tmux send-keys -t "$SESSION" \
  "cd '$SCRIPT_DIR' && DEV_PORT=$DEV_PORT BACKEND_PORT=$BACKEND_PORT PORT=$BACKEND_PORT PI_CWD='$PI_CWD' npx concurrently \
    --names 'server,client' \
    --prefix-colors 'cyan,green' \
    --kill-others \
    'npx tsx watch src/server/server.ts' \
    'npx vite'" C-m

echo ""
echo "✅ Local development started!"
echo "📍 Running on: http://localhost:$DEV_PORT (vite HMR → backend :$BACKEND_PORT)"
echo "To attach: tmux attach -t $SESSION"
