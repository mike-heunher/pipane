#!/usr/bin/env bash
# Explicitly build and deploy the working tree to the local pipane dev service.
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_ROOT="/opt/pipane-dev"
RELEASES_DIR="$DEPLOY_ROOT/releases"
CURRENT_LINK="$DEPLOY_ROOT/current"
SERVICE_NAME="pipane-dev"
SERVICE_TEMPLATE="$SCRIPT_DIR/scripts/pipane-dev.service"
SERVICE_FILE="/etc/systemd/system/$SERVICE_NAME.service"
ENV_FILE="/etc/pipane.env"
DEV_PORT=8223
KEEP_RELEASES=5
STAGING_DIR=""

if [[ $EUID -ne 0 ]]; then
	echo "❌ Run this local deployment as root."
	exit 1
fi

for command_name in node npm npx flock curl systemctl; do
	if ! command -v "$command_name" >/dev/null 2>&1; then
		echo "❌ Missing required command: $command_name"
		exit 1
	fi
done

if [[ ! -f "$ENV_FILE" ]]; then
	echo "❌ Missing $ENV_FILE (the dev service reuses production's pi and auth settings)."
	exit 1
fi

mkdir -p "$RELEASES_DIR"
exec 9>"$DEPLOY_ROOT/deploy.lock"
if ! flock -n 9; then
	echo "❌ Another pipane dev deployment is already running."
	exit 1
fi

cleanup() {
	if [[ -n "$STAGING_DIR" && -d "$STAGING_DIR" ]]; then
		rm -rf "$STAGING_DIR"
	fi
}
trap cleanup EXIT

echo "🚀 Deploying pipane dev from $SCRIPT_DIR..."

LOCK_HASH="$(sha256sum "$SCRIPT_DIR/package-lock.json" | awk '{print $1}')"
INSTALLED_LOCK_HASH="$(cat "$DEPLOY_ROOT/package-lock.sha256" 2>/dev/null || true)"
if [[ ! -d "$SCRIPT_DIR/node_modules" || "$LOCK_HASH" != "$INSTALLED_LOCK_HASH" ]]; then
	echo "📦 Dependencies changed; installing..."
	(cd "$SCRIPT_DIR" && npm install)
	LOCK_HASH="$(sha256sum "$SCRIPT_DIR/package-lock.json" | awk '{print $1}')"
	printf '%s\n' "$LOCK_HASH" > "$DEPLOY_ROOT/package-lock.sha256"
else
	echo "📦 Dependencies unchanged; skipping npm install."
fi

echo "🏗️  Building pipane..."
(cd "$SCRIPT_DIR" && npm run build)

GIT_REV="$(git -C "$SCRIPT_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
if [[ -n "$(git -C "$SCRIPT_DIR" status --porcelain 2>/dev/null || true)" ]]; then
	GIT_REV="${GIT_REV}+dirty"
fi
RELEASE_ID="$(date -u +%Y%m%dT%H%M%S)-${GIT_REV//+/-}"
RELEASE_DIR="$RELEASES_DIR/$RELEASE_ID"
if [[ -e "$RELEASE_DIR" ]]; then
	RELEASE_DIR="${RELEASE_DIR}-$$"
fi

STAGING_DIR="$(mktemp -d "$RELEASES_DIR/.staging.XXXXXX")"
cp -a "$SCRIPT_DIR/dist" "$SCRIPT_DIR/bin" "$SCRIPT_DIR/package.json" "$SCRIPT_DIR/package-lock.json" "$STAGING_DIR/"
ln -s "$SCRIPT_DIR/node_modules" "$STAGING_DIR/node_modules"
printf 'deployed_at=%s\nsource=%s\nrevision=%s\n' \
	"$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$SCRIPT_DIR" "$GIT_REV" > "$STAGING_DIR/deploy-info"
mv "$STAGING_DIR" "$RELEASE_DIR"
STAGING_DIR=""

if ! cmp -s "$SERVICE_TEMPLATE" "$SERVICE_FILE"; then
	echo "🔧 Installing $SERVICE_NAME systemd service..."
	install -m 0644 "$SERVICE_TEMPLATE" "$SERVICE_FILE"
	systemctl daemon-reload
fi

PREVIOUS_RELEASE="$(readlink -f "$CURRENT_LINK" 2>/dev/null || true)"
NEXT_LINK="$DEPLOY_ROOT/.current.$$"
ln -s "$RELEASE_DIR" "$NEXT_LINK"
mv -Tf "$NEXT_LINK" "$CURRENT_LINK"

echo "🔄 Restarting $SERVICE_NAME..."
systemctl enable "$SERVICE_NAME" >/dev/null
systemctl restart "$SERVICE_NAME"

HEALTHY=0
for _ in $(seq 1 40); do
	if systemctl is-active --quiet "$SERVICE_NAME" && curl -fsS "http://127.0.0.1:$DEV_PORT/" >/dev/null 2>&1; then
		HEALTHY=1
		break
	fi
	sleep 0.25
done

if [[ $HEALTHY -ne 1 ]]; then
	echo "❌ Dev deployment failed its health check."
	journalctl -u "$SERVICE_NAME" -n 30 --no-pager || true
	if [[ -n "$PREVIOUS_RELEASE" && -d "$PREVIOUS_RELEASE" ]]; then
		echo "↩️  Rolling back to $(basename "$PREVIOUS_RELEASE")..."
		ROLLBACK_LINK="$DEPLOY_ROOT/.current.rollback.$$"
		ln -s "$PREVIOUS_RELEASE" "$ROLLBACK_LINK"
		mv -Tf "$ROLLBACK_LINK" "$CURRENT_LINK"
		systemctl restart "$SERVICE_NAME"
	else
		systemctl stop "$SERVICE_NAME" || true
	fi
	exit 1
fi

mapfile -t ALL_RELEASES < <(
	find "$RELEASES_DIR" -mindepth 1 -maxdepth 1 -type d ! -name '.staging.*' -printf '%T@ %p\n' \
		| sort -rn | cut -d' ' -f2-
)
for ((i = KEEP_RELEASES; i < ${#ALL_RELEASES[@]}; i++)); do
	if [[ "${ALL_RELEASES[$i]}" != "$(readlink -f "$CURRENT_LINK")" ]]; then
		rm -rf "${ALL_RELEASES[$i]}"
	fi
done

LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo ""
echo "✅ Pipane dev deployed: $GIT_REV"
echo "📍 Local: http://127.0.0.1:$DEV_PORT"
if [[ -n "$LAN_IP" ]]; then
	echo "📍 LAN:   http://$LAN_IP:$DEV_PORT"
fi
echo "📊 Logs:  journalctl -u $SERVICE_NAME -f"
