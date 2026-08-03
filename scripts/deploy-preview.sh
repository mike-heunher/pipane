#!/usr/bin/env bash
# Deploy one working-tree build to the isolated preview backend, rendezvous, and browser app.
set -Eeuo pipefail

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE_HOST="${PIPANE_PREVIEW_RENDEZVOUS_HOST:-root@10.1.10.36}"
REMOTE_ROOT="${PIPANE_PREVIEW_RENDEZVOUS_ROOT:-/opt/pipane-rendezvous-preview}"
PUBLIC_URL="${PIPANE_PREVIEW_PUBLIC_URL:-https://preview.pipane.dev}"
REMOTE_STAGING=""
ACTIVATED=0
SYSTEMD_UNIT="${PIPANE_PREVIEW_SYSTEMD_UNIT:-pipane-preview-deploy}"

usage() {
	cat <<'EOF'
Usage: npm run deploy:preview

Deploys the current working tree to the isolated preview stack:
  - local pipane-dev backend on port 8223
  - rendezvous server and browser at https://preview.pipane.dev

Production pipane.dev, the npm registry, and the local production backend are untouched.
EOF
}

if [[ "${1:-}" == "--help" ]]; then
	usage
	exit 0
fi
if [[ $# -ne 0 ]]; then
	usage >&2
	exit 2
fi
if [[ $EUID -ne 0 ]]; then
	echo "❌ Run the preview deployment as root." >&2
	exit 1
fi
if [[ ! "$REMOTE_ROOT" =~ ^/[A-Za-z0-9._/-]+$ ]]; then
	echo "❌ PIPANE_PREVIEW_RENDEZVOUS_ROOT must be an absolute path without spaces." >&2
	exit 1
fi
if [[ ! "$PUBLIC_URL" =~ ^https?://[A-Za-z0-9.-]+(:[0-9]+)?/?$ ]]; then
	echo "❌ PIPANE_PREVIEW_PUBLIC_URL must be an HTTP(S) origin." >&2
	exit 1
fi
if [[ ! "$SYSTEMD_UNIT" =~ ^[A-Za-z0-9_.@-]+$ ]]; then
	echo "❌ PIPANE_PREVIEW_SYSTEMD_UNIT must be a valid systemd unit name." >&2
	exit 1
fi
for command_name in ssh rsync sha256sum git node systemctl systemd-run; do
	if ! command -v "$command_name" >/dev/null 2>&1; then
		echo "❌ Missing required command: $command_name" >&2
		exit 1
	fi
done

if [[ "${PIPANE_PREVIEW_DEPLOY_IN_SYSTEMD:-0}" != "1" ]]; then
	if systemctl is-active --quiet "$SYSTEMD_UNIT"; then
		echo "❌ Preview deployment unit $SYSTEMD_UNIT is already running." >&2
		exit 1
	fi
	systemd-run --quiet --no-block --collect \
		--unit="$SYSTEMD_UNIT" \
		--property=Type=exec \
		--property=TimeoutStartSec=infinity \
		--working-directory="$SOURCE_DIR" \
		--setenv=PIPANE_PREVIEW_DEPLOY_IN_SYSTEMD=1 \
		--setenv=PIPANE_PREVIEW_RENDEZVOUS_HOST="$REMOTE_HOST" \
		--setenv=PIPANE_PREVIEW_RENDEZVOUS_ROOT="$REMOTE_ROOT" \
		--setenv=PIPANE_PREVIEW_PUBLIC_URL="$PUBLIC_URL" \
		"$SOURCE_DIR/scripts/deploy-preview.sh"
	echo "🚀 Preview deployment started in $SYSTEMD_UNIT."
	echo "📊 Logs: journalctl -u $SYSTEMD_UNIT -f"
	exit 0
fi

cleanup() {
	local exit_code=$?
	if [[ $ACTIVATED -ne 1 && -n "$REMOTE_STAGING" ]]; then
		local quoted_staging
		printf -v quoted_staging '%q' "$REMOTE_STAGING"
		ssh -o BatchMode=yes "$REMOTE_HOST" "rm -rf -- $quoted_staging" >/dev/null 2>&1 || true
	fi
	return "$exit_code"
}
trap cleanup EXIT

echo "🚀 Deploying the preview backend locally..."
VITE_PIPANE_BOOTSTRAP_DIAGNOSTICS=1 "$SOURCE_DIR/scripts/deploy-local-release.sh" dev

for required_file in dist/client/index.html dist/server/server/client-assets.js dist/server/rendezvous/server.js bin/pipane-rendezvous.js; do
	if [[ ! -f "$SOURCE_DIR/$required_file" ]]; then
		echo "❌ The local deployment did not produce $required_file." >&2
		exit 1
	fi
done

GIT_REV="$(git -C "$SOURCE_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
if [[ -n "$(git -C "$SOURCE_DIR" status --porcelain 2>/dev/null || true)" ]]; then
	GIT_REV="${GIT_REV}+dirty"
fi
RELEASE_ID="$(date -u +%Y%m%dT%H%M%S)-${GIT_REV//+/-}-$$"
REMOTE_STAGING="$REMOTE_ROOT/.staging-$RELEASE_ID"
SOURCE_INDEX_HASH="$(sha256sum "$SOURCE_DIR/dist/client/index.html" | awk '{print $1}')"
# The rendezvous server rewrites the runtime marker in index.html before serving
# it, so the uploaded source and public representation have distinct hashes.
EXPECTED_PUBLIC_INDEX_HASH="$(node "$SOURCE_DIR/scripts/hash-client-runtime-index.js" \
	"$SOURCE_DIR/dist/client/index.html" \
	"$SOURCE_DIR/dist/server/server/client-assets.js" \
	rendezvous)"

printf -v quoted_root '%q' "$REMOTE_ROOT"
printf -v quoted_staging '%q' "$REMOTE_STAGING"
echo "🌐 Uploading the matching preview runtime to $REMOTE_HOST..."
ssh -o BatchMode=yes "$REMOTE_HOST" \
	"install -d -m 0755 $quoted_root && rm -rf -- $quoted_staging && install -d -m 0755 $quoted_staging"
rsync --archive --delete --chmod=D755,F644 \
	"$SOURCE_DIR/dist" \
	"$SOURCE_DIR/bin" \
	"$SOURCE_DIR/package.json" \
	"$SOURCE_DIR/package-lock.json" \
	"$SOURCE_DIR/scripts/pipane-rendezvous-preview.service" \
	"$REMOTE_HOST:$REMOTE_STAGING/"

echo "📦 Installing isolated preview runtime dependencies..."
ssh -o BatchMode=yes "$REMOTE_HOST" \
	"cd $quoted_staging && npm ci --omit=dev --no-audit --no-fund"

ssh -o BatchMode=yes "$REMOTE_HOST" bash -s -- \
	"$REMOTE_ROOT" "$RELEASE_ID" "$SOURCE_INDEX_HASH" "$EXPECTED_PUBLIC_INDEX_HASH" "$PUBLIC_URL" \
	< "$SOURCE_DIR/scripts/activate-preview-rendezvous.sh"
ACTIVATED=1
REMOTE_STAGING=""

echo ""
echo "✅ Isolated preview stack deployed: $GIT_REV"
echo "📍 Backend:    http://127.0.0.1:8223"
echo "📍 Rendezvous: $PUBLIC_URL"
echo "📍 Browser:    $PUBLIC_URL"
echo "📦 npm was neither published nor globally installed."
