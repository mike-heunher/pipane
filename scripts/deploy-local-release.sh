#!/usr/bin/env bash
# Build the current working tree and atomically advance a local systemd deployment.
set -Eeuo pipefail

TARGET="${1:-}"
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="/etc/pipane.env"
KEEP_RELEASES=5
STAGING_DIR=""
SERVICE_BACKUP=""
SERVICE_CHANGED=0
HAD_SERVICE_FILE=0
ACTIVATION_STARTED=0
GLOBAL_MODULE_PATH=""
GLOBAL_MODULE_BACKUP=""
GLOBAL_MODULE_CHANGED=0
HAD_GLOBAL_MODULE=0

case "$TARGET" in
	dev)
		DEPLOY_LABEL="dev"
		DEPLOY_ROOT="/opt/pipane-dev"
		SERVICE_NAME="pipane-dev"
		SERVICE_TEMPLATE="$SOURCE_DIR/scripts/pipane-dev.service"
		PORT=8223
		REQUIRE_CLEAN=0
		;;
	prod)
		DEPLOY_LABEL="production"
		DEPLOY_ROOT="/opt/pipane-prod"
		SERVICE_NAME="pipane"
		SERVICE_TEMPLATE="$SOURCE_DIR/scripts/pipane.service"
		PORT=8222
		REQUIRE_CLEAN=1
		GLOBAL_MODULE_PATH="/usr/lib/node_modules/pipane"
		;;
	*)
		echo "Usage: $0 dev|prod" >&2
		exit 2
		;;
esac

RELEASES_DIR="$DEPLOY_ROOT/releases"
CURRENT_LINK="$DEPLOY_ROOT/current"
SERVICE_FILE="/etc/systemd/system/$SERVICE_NAME.service"

restore_service_file() {
	if [[ $SERVICE_CHANGED -ne 1 ]]; then
		return
	fi
	if [[ $HAD_SERVICE_FILE -eq 1 && -n "$SERVICE_BACKUP" && -f "$SERVICE_BACKUP" ]]; then
		install -m 0644 "$SERVICE_BACKUP" "$SERVICE_FILE"
	else
		rm -f "$SERVICE_FILE"
	fi
	systemctl daemon-reload || true
	SERVICE_CHANGED=0
}

switch_global_module() {
	if [[ -z "$GLOBAL_MODULE_PATH" || "$(readlink "$GLOBAL_MODULE_PATH" 2>/dev/null || true)" == "$CURRENT_LINK" ]]; then
		return 0
	fi

	GLOBAL_MODULE_BACKUP="$(dirname "$GLOBAL_MODULE_PATH")/.pipane.deploy-backup.$$"
	if [[ -e "$GLOBAL_MODULE_PATH" || -L "$GLOBAL_MODULE_PATH" ]]; then
		mv -T "$GLOBAL_MODULE_PATH" "$GLOBAL_MODULE_BACKUP" || return 1
		HAD_GLOBAL_MODULE=1
	fi

	local next_global_link="$(dirname "$GLOBAL_MODULE_PATH")/.pipane.deploy-link.$$"
	if ! ln -s "$CURRENT_LINK" "$next_global_link" || ! mv -Tf "$next_global_link" "$GLOBAL_MODULE_PATH"; then
		rm -f "$next_global_link" "$GLOBAL_MODULE_PATH"
		if [[ $HAD_GLOBAL_MODULE -eq 1 ]]; then
			mv -T "$GLOBAL_MODULE_BACKUP" "$GLOBAL_MODULE_PATH" || true
		fi
		GLOBAL_MODULE_BACKUP=""
		HAD_GLOBAL_MODULE=0
		return 1
	fi
	GLOBAL_MODULE_CHANGED=1
}

restore_global_module() {
	if [[ $GLOBAL_MODULE_CHANGED -ne 1 ]]; then
		return
	fi
	rm -rf "$GLOBAL_MODULE_PATH"
	if [[ $HAD_GLOBAL_MODULE -eq 1 ]] \
		&& [[ -e "$GLOBAL_MODULE_BACKUP" || -L "$GLOBAL_MODULE_BACKUP" ]]; then
		mv -T "$GLOBAL_MODULE_BACKUP" "$GLOBAL_MODULE_PATH"
	fi
	GLOBAL_MODULE_BACKUP=""
	GLOBAL_MODULE_CHANGED=0
	HAD_GLOBAL_MODULE=0
}

cleanup() {
	local exit_code=$?
	if [[ -n "$STAGING_DIR" && -d "$STAGING_DIR" ]]; then
		rm -rf "$STAGING_DIR"
	fi
	if [[ $exit_code -ne 0 && $ACTIVATION_STARTED -eq 0 ]]; then
		restore_service_file
	fi
	if [[ -n "$SERVICE_BACKUP" ]]; then
		rm -f "$SERVICE_BACKUP"
	fi
	if [[ -n "$GLOBAL_MODULE_BACKUP" ]]; then
		rm -rf "$GLOBAL_MODULE_BACKUP"
	fi
	return "$exit_code"
}
trap cleanup EXIT

if [[ $EUID -ne 0 ]]; then
	echo "❌ Run this local deployment as root."
	exit 1
fi

for command_name in node npm flock curl systemctl sha256sum git; do
	if ! command -v "$command_name" >/dev/null 2>&1; then
		echo "❌ Missing required command: $command_name"
		exit 1
	fi
done

if [[ ! -f "$ENV_FILE" ]]; then
	echo "❌ Missing $ENV_FILE (local deployments reuse production's pi and auth settings)."
	exit 1
fi

AUTH_TOKEN="$(set -a; source "$ENV_FILE"; printf '%s' "${PIPANE_AUTH_TOKEN:-}")"
if [[ -z "$AUTH_TOKEN" ]]; then
	echo "❌ $ENV_FILE must define PIPANE_AUTH_TOKEN."
	exit 1
fi
AUTH_COOKIE_VALUE="$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$AUTH_TOKEN")"

assert_clean_source() {
	if [[ $REQUIRE_CLEAN -ne 1 ]]; then
		return
	fi

	local source_status
	if ! source_status="$(git -C "$SOURCE_DIR" status --porcelain)"; then
		echo "❌ Production deployments require a valid Git working tree."
		exit 1
	fi
	if [[ -n "$source_status" ]]; then
		echo "❌ Production deployments require a clean Git working tree. Commit or stash changes first."
		exit 1
	fi
}

assert_clean_source

mkdir -p "$RELEASES_DIR" /run/lock
exec 9>"/run/lock/pipane-local-deploy.lock"
if ! flock -n 9; then
	echo "❌ Another local pipane deployment is already running."
	exit 1
fi

assert_clean_source

echo "🚀 Deploying pipane $DEPLOY_LABEL from $SOURCE_DIR..."

LOCK_HASH="$(sha256sum "$SOURCE_DIR/package-lock.json" | awk '{print $1}')"
LOCK_STAMP="$SOURCE_DIR/node_modules/.pipane-package-lock.sha256"
INSTALLED_LOCK_HASH="$(cat "$LOCK_STAMP" 2>/dev/null || true)"
if [[ ! -d "$SOURCE_DIR/node_modules" || "$LOCK_HASH" != "$INSTALLED_LOCK_HASH" ]]; then
	echo "📦 Dependencies changed; installing..."
	(cd "$SOURCE_DIR" && npm install --no-audit --no-fund)
	LOCK_HASH="$(sha256sum "$SOURCE_DIR/package-lock.json" | awk '{print $1}')"
	printf '%s\n' "$LOCK_HASH" > "$LOCK_STAMP"
else
	echo "📦 Dependencies unchanged; skipping npm install."
fi

assert_clean_source

echo "🏗️  Building pipane..."
(cd "$SOURCE_DIR" && npm run build)
assert_clean_source

GIT_REV="$(git -C "$SOURCE_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
if [[ -n "$(git -C "$SOURCE_DIR" status --porcelain 2>/dev/null || true)" ]]; then
	GIT_REV="${GIT_REV}+dirty"
fi
RELEASE_ID="$(date -u +%Y%m%dT%H%M%S)-${GIT_REV//+/-}"
RELEASE_DIR="$RELEASES_DIR/$RELEASE_ID"
if [[ -e "$RELEASE_DIR" ]]; then
	RELEASE_DIR="${RELEASE_DIR}-$$"
fi

STAGING_DIR="$(mktemp -d "$RELEASES_DIR/.staging.XXXXXX")"
cp -a "$SOURCE_DIR/dist" "$SOURCE_DIR/bin" "$SOURCE_DIR/package.json" "$SOURCE_DIR/package-lock.json" "$STAGING_DIR/"
ln -s "$SOURCE_DIR/node_modules" "$STAGING_DIR/node_modules"
printf 'deployed_at=%s\nsource=%s\nrevision=%s\n' \
	"$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$SOURCE_DIR" "$GIT_REV" > "$STAGING_DIR/deploy-info"
mv "$STAGING_DIR" "$RELEASE_DIR"
STAGING_DIR=""

if ! cmp -s "$SERVICE_TEMPLATE" "$SERVICE_FILE"; then
	echo "🔧 Installing $SERVICE_NAME systemd service..."
	SERVICE_BACKUP="$(mktemp)"
	if [[ -f "$SERVICE_FILE" ]]; then
		cp -a "$SERVICE_FILE" "$SERVICE_BACKUP"
		HAD_SERVICE_FILE=1
	fi
	install -m 0644 "$SERVICE_TEMPLATE" "$SERVICE_FILE"
	SERVICE_CHANGED=1
	systemctl daemon-reload
fi

PREVIOUS_RELEASE="$(readlink -f "$CURRENT_LINK" 2>/dev/null || true)"
NEXT_LINK="$DEPLOY_ROOT/.current.$$"
ln -s "$RELEASE_DIR" "$NEXT_LINK"
mv -Tf "$NEXT_LINK" "$CURRENT_LINK"
ACTIVATION_STARTED=1

echo "🔄 Restarting $SERVICE_NAME..."
HEALTHY=0
if switch_global_module \
	&& systemctl enable "$SERVICE_NAME" >/dev/null \
	&& systemctl restart "$SERVICE_NAME"; then
	for _ in $(seq 1 40); do
		if systemctl is-active --quiet "$SERVICE_NAME" \
			&& curl -fsS -H "Cookie: pipane_auth=$AUTH_COOKIE_VALUE" \
				"http://127.0.0.1:$PORT/api/debug/health" 2>/dev/null | grep -q '"ok":true'; then
			HEALTHY=1
			break
		fi
		sleep 0.25
	done
fi

if [[ $HEALTHY -ne 1 ]]; then
	echo "❌ $DEPLOY_LABEL deployment failed its health check."
	journalctl -u "$SERVICE_NAME" -n 30 --no-pager \
		| sed -E 's#(auth\?token=)[^ ]+#\1[redacted]#g' || true
	if [[ -n "$PREVIOUS_RELEASE" && -d "$PREVIOUS_RELEASE" ]]; then
		echo "↩️  Rolling back to $(basename "$PREVIOUS_RELEASE")..."
		ROLLBACK_LINK="$DEPLOY_ROOT/.current.rollback.$$"
		ln -s "$PREVIOUS_RELEASE" "$ROLLBACK_LINK"
		mv -Tf "$ROLLBACK_LINK" "$CURRENT_LINK"
		restore_global_module
		systemctl restart "$SERVICE_NAME" || true
	elif [[ $SERVICE_CHANGED -eq 1 ]]; then
		echo "↩️  Restoring the previous $SERVICE_NAME service..."
		rm -f "$CURRENT_LINK"
		restore_global_module
		restore_service_file
		systemctl restart "$SERVICE_NAME" || true
	else
		rm -f "$CURRENT_LINK"
		restore_global_module
		systemctl stop "$SERVICE_NAME" || true
	fi
	exit 1
fi

if [[ -n "$GLOBAL_MODULE_BACKUP" ]]; then
	rm -rf "$GLOBAL_MODULE_BACKUP"
	GLOBAL_MODULE_BACKUP=""
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
echo "✅ Pipane $DEPLOY_LABEL deployed: $GIT_REV"
echo "📍 Local: http://127.0.0.1:$PORT/auth?token=$AUTH_COOKIE_VALUE"
if [[ -n "$LAN_IP" ]]; then
	echo "📍 LAN:   http://$LAN_IP:$PORT/auth?token=$AUTH_COOKIE_VALUE"
fi
echo "📊 Logs:  journalctl -u $SERVICE_NAME -f"
