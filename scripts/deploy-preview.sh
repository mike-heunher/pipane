#!/usr/bin/env bash
# Deploy one working-tree build to the local dev backend and the public browser app.
set -Eeuo pipefail

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE_HOST="${PIPANE_PREVIEW_WEB_HOST:-root@10.1.10.36}"
REMOTE_ROOT="${PIPANE_PREVIEW_WEB_ROOT:-/opt/pipane-web-preview}"
PUBLIC_URL="${PIPANE_PREVIEW_PUBLIC_URL:-https://pipane.dev}"
REMOTE_STAGING=""
ACTIVATED=0

usage() {
	cat <<'EOF'
Usage: npm run deploy:preview

Deploys the current working tree to:
  - the local pipane-dev backend on port 8223
  - the browser bundle served at https://pipane.dev

The central rendezvous process and local production backend are not replaced.
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
	echo "❌ PIPANE_PREVIEW_WEB_ROOT must be an absolute path without spaces." >&2
	exit 1
fi
if [[ ! "$PUBLIC_URL" =~ ^https?://[A-Za-z0-9.-]+(:[0-9]+)?/?$ ]]; then
	echo "❌ PIPANE_PREVIEW_PUBLIC_URL must be an HTTP(S) origin." >&2
	exit 1
fi
for command_name in ssh rsync sha256sum git; do
	if ! command -v "$command_name" >/dev/null 2>&1; then
		echo "❌ Missing required command: $command_name" >&2
		exit 1
	fi
done

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
"$SOURCE_DIR/scripts/deploy-local-release.sh" dev

if [[ ! -f "$SOURCE_DIR/dist/client/index.html" ]]; then
	echo "❌ The local deployment did not produce dist/client/index.html." >&2
	exit 1
fi

GIT_REV="$(git -C "$SOURCE_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
if [[ -n "$(git -C "$SOURCE_DIR" status --porcelain 2>/dev/null || true)" ]]; then
	GIT_REV="${GIT_REV}+dirty"
fi
RELEASE_ID="$(date -u +%Y%m%dT%H%M%S)-${GIT_REV//+/-}-$$"
REMOTE_STAGING="$REMOTE_ROOT/.staging-$RELEASE_ID"
EXPECTED_INDEX_HASH="$(sha256sum "$SOURCE_DIR/dist/client/index.html" | awk '{print $1}')"

printf -v quoted_root '%q' "$REMOTE_ROOT"
printf -v quoted_staging '%q' "$REMOTE_STAGING"
echo "🌐 Uploading the matching browser bundle to $REMOTE_HOST..."
ssh -o BatchMode=yes "$REMOTE_HOST" \
	"install -d -m 0755 $quoted_root && rm -rf -- $quoted_staging && install -d -m 0755 $quoted_staging"
rsync --archive --delete --chmod=D755,F644 \
	"$SOURCE_DIR/dist/client/" "$REMOTE_HOST:$REMOTE_STAGING/"

ssh -o BatchMode=yes "$REMOTE_HOST" bash -s -- \
	"$REMOTE_ROOT" "$RELEASE_ID" "$EXPECTED_INDEX_HASH" "$PUBLIC_URL" \
	< "$SOURCE_DIR/scripts/activate-preview-web.sh"
ACTIVATED=1
REMOTE_STAGING=""

echo ""
echo "✅ Preview stack deployed: $GIT_REV"
echo "📍 Backend: http://127.0.0.1:8223"
echo "📍 Browser: $PUBLIC_URL"
echo "📦 npm was not published or installed."
