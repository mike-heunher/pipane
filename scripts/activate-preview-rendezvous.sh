#!/usr/bin/env bash
# Atomically activate an uploaded, isolated rendezvous preview release.
set -Eeuo pipefail

if [[ $# -ne 5 ]]; then
	echo "Usage: $0 <deploy-root> <release-id> <source-index-sha256> <public-index-sha256> <public-url>" >&2
	exit 2
fi

DEPLOY_ROOT="$1"
RELEASE_ID="$2"
SOURCE_INDEX_HASH="$3"
EXPECTED_PUBLIC_INDEX_HASH="$4"
PUBLIC_URL="${5%/}"
RELEASES_DIR="$DEPLOY_ROOT/releases"
CURRENT_LINK="$DEPLOY_ROOT/current"
STAGING_DIR="$DEPLOY_ROOT/.staging-$RELEASE_ID"
RELEASE_DIR="$RELEASES_DIR/$RELEASE_ID"
SERVICE_NAME="${PIPANE_PREVIEW_RENDEZVOUS_SERVICE:-pipane-rendezvous-preview}"
SERVICE_FILE="${PIPANE_PREVIEW_RENDEZVOUS_SERVICE_FILE:-/etc/systemd/system/$SERVICE_NAME.service}"
STATE_DIR="${PIPANE_PREVIEW_RENDEZVOUS_STATE_DIR:-/var/lib/pipane-rendezvous-preview}"
SERVICE_USER="${PIPANE_PREVIEW_RENDEZVOUS_USER:-pipane-rendezvous}"
SERVICE_GROUP="${PIPANE_PREVIEW_RENDEZVOUS_GROUP:-pipane-rendezvous}"
SYSTEMCTL="${PIPANE_PREVIEW_SYSTEMCTL:-systemctl}"
LOCK_FILE="${PIPANE_PREVIEW_LOCK_FILE:-/run/lock/pipane-preview-rendezvous-deploy.lock}"
HEALTH_ATTEMPTS="${PIPANE_PREVIEW_HEALTH_ATTEMPTS:-60}"
HEALTH_DELAY="${PIPANE_PREVIEW_HEALTH_DELAY:-0.25}"
KEEP_RELEASES=5
ACTIVATION_STARTED=0
ACTIVATION_SUCCEEDED=0
PREVIOUS_RELEASE=""
HAD_SERVICE_FILE=0
SERVICE_BACKUP=""

if [[ $EUID -ne 0 && "${PIPANE_PREVIEW_SKIP_USER_SETUP:-0}" != "1" ]]; then
	echo "❌ Preview rendezvous activation must run as root." >&2
	exit 1
fi
if [[ ! "$DEPLOY_ROOT" =~ ^/[A-Za-z0-9._/-]+$ ]] \
	|| [[ ! "$SERVICE_FILE" =~ ^/[A-Za-z0-9._/-]+$ ]] \
	|| [[ ! "$STATE_DIR" =~ ^/[A-Za-z0-9._/-]+$ ]] \
	|| [[ ! "$LOCK_FILE" =~ ^/[A-Za-z0-9._/-]+$ ]] \
	|| [[ ! "$RELEASE_ID" =~ ^[A-Za-z0-9._-]+$ ]] \
	|| [[ ! "$SERVICE_NAME" =~ ^[A-Za-z0-9_.@-]+$ ]] \
	|| [[ ! "$SERVICE_USER" =~ ^[A-Za-z_][A-Za-z0-9_-]*$ ]] \
	|| [[ ! "$SERVICE_GROUP" =~ ^[A-Za-z_][A-Za-z0-9_-]*$ ]] \
	|| [[ ! "$SOURCE_INDEX_HASH" =~ ^[a-f0-9]{64}$ ]] \
	|| [[ ! "$EXPECTED_PUBLIC_INDEX_HASH" =~ ^[a-f0-9]{64}$ ]] \
	|| [[ ! "$PUBLIC_URL" =~ ^https?://[A-Za-z0-9.-]+(:[0-9]+)?$ ]] \
	|| [[ ! "$HEALTH_ATTEMPTS" =~ ^[1-9][0-9]*$ ]] \
	|| [[ ! "$HEALTH_DELAY" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
	echo "❌ Invalid preview rendezvous activation arguments." >&2
	exit 2
fi
for command_name in curl flock sha256sum; do
	if ! command -v "$command_name" >/dev/null 2>&1; then
		echo "❌ Missing required command: $command_name" >&2
		exit 1
	fi
done
for required_file in \
	"dist/client/index.html" \
	"dist/server/rendezvous/server.js" \
	"bin/pipane-rendezvous.js" \
	"node_modules/ws/package.json" \
	"pipane-rendezvous-preview.service"; do
	if [[ ! -f "$STAGING_DIR/$required_file" ]]; then
		echo "❌ Uploaded preview release is missing $required_file." >&2
		exit 1
	fi
done
if [[ "$(sha256sum "$STAGING_DIR/dist/client/index.html" | awk '{print $1}')" != "$SOURCE_INDEX_HASH" ]]; then
	echo "❌ Uploaded preview browser bundle failed its checksum." >&2
	exit 1
fi

mkdir -p "$RELEASES_DIR" "$(dirname "$LOCK_FILE")"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
	echo "❌ Another preview rendezvous deployment is already running." >&2
	exit 1
fi
if [[ -e "$RELEASE_DIR" ]]; then
	echo "❌ Preview release already exists: $RELEASE_ID" >&2
	exit 1
fi

switch_current() {
	local target="$1"
	local next_link="$DEPLOY_ROOT/.current.$$"
	ln -s "$target" "$next_link"
	mv -Tf "$next_link" "$CURRENT_LINK"
}

restore_service_file() {
	if [[ -n "$SERVICE_BACKUP" && -f "$SERVICE_BACKUP" ]]; then
		cp -a "$SERVICE_BACKUP" "$SERVICE_FILE"
	elif [[ $HAD_SERVICE_FILE -eq 0 ]]; then
		rm -f "$SERVICE_FILE"
	fi
	"$SYSTEMCTL" daemon-reload || true
}

cleanup() {
	local exit_code=$?
	if [[ $exit_code -ne 0 && $ACTIVATION_STARTED -eq 1 && $ACTIVATION_SUCCEEDED -ne 1 ]]; then
		if [[ -n "$PREVIOUS_RELEASE" && -d "$PREVIOUS_RELEASE" ]]; then
			echo "↩️  Restoring $(basename "$PREVIOUS_RELEASE")..." >&2
			switch_current "$PREVIOUS_RELEASE" || true
		else
			rm -f "$CURRENT_LINK"
		fi
		restore_service_file
		"$SYSTEMCTL" restart "$SERVICE_NAME" || true
		rm -rf "$RELEASE_DIR"
	elif [[ $ACTIVATION_STARTED -ne 1 && -d "$STAGING_DIR" ]]; then
		rm -rf "$STAGING_DIR"
	fi
	[[ -z "$SERVICE_BACKUP" ]] || rm -f "$SERVICE_BACKUP"
	return "$exit_code"
}
trap cleanup EXIT

if [[ "${PIPANE_PREVIEW_SKIP_USER_SETUP:-0}" != "1" ]]; then
	if ! getent group "$SERVICE_GROUP" >/dev/null; then
		groupadd --system "$SERVICE_GROUP"
	fi
	if ! id "$SERVICE_USER" >/dev/null 2>&1; then
		useradd --system --gid "$SERVICE_GROUP" --home-dir "$STATE_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
	fi
	install -d -m 0750 -o "$SERVICE_USER" -g "$SERVICE_GROUP" "$STATE_DIR"
fi

mv "$STAGING_DIR" "$RELEASE_DIR"
PREVIOUS_RELEASE="$(readlink -f "$CURRENT_LINK" 2>/dev/null || true)"
switch_current "$RELEASE_DIR"
ACTIVATION_STARTED=1

RENDERED_SERVICE="$(mktemp)"
sed \
	-e "s|@DEPLOY_ROOT@|$DEPLOY_ROOT|g" \
	-e "s|@STATE_DIR@|$STATE_DIR|g" \
	-e "s|@SERVICE_USER@|$SERVICE_USER|g" \
	-e "s|@SERVICE_GROUP@|$SERVICE_GROUP|g" \
	"$RELEASE_DIR/pipane-rendezvous-preview.service" > "$RENDERED_SERVICE"
if [[ -f "$SERVICE_FILE" ]]; then
	SERVICE_BACKUP="$(mktemp)"
	cp -a "$SERVICE_FILE" "$SERVICE_BACKUP"
	HAD_SERVICE_FILE=1
fi
install -m 0644 "$RENDERED_SERVICE" "$SERVICE_FILE"
rm -f "$RENDERED_SERVICE"
"$SYSTEMCTL" daemon-reload
"$SYSTEMCTL" enable "$SERVICE_NAME" >/dev/null
"$SYSTEMCTL" restart "$SERVICE_NAME"

HEALTHY=0
for ((attempt = 0; attempt < HEALTH_ATTEMPTS; attempt++)); do
	PUBLIC_INDEX_HASH="$(curl -fsS "$PUBLIC_URL/" 2>/dev/null | sha256sum | awk '{print $1}' || true)"
	if "$SYSTEMCTL" is-active --quiet "$SERVICE_NAME" \
		&& curl -fsS "$PUBLIC_URL/health" 2>/dev/null | grep -q '"ok":true' \
		&& [[ "$PUBLIC_INDEX_HASH" == "$EXPECTED_PUBLIC_INDEX_HASH" ]]; then
		HEALTHY=1
		break
	fi
	sleep "$HEALTH_DELAY"
done
if [[ $HEALTHY -ne 1 ]]; then
	echo "❌ Public preview rendezvous failed its service, health, or browser checksum check." >&2
	exit 1
fi
ACTIVATION_SUCCEEDED=1

mapfile -t ALL_RELEASES < <(
	find "$RELEASES_DIR" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' \
		| sort -rn | cut -d' ' -f2-
)
for ((i = KEEP_RELEASES; i < ${#ALL_RELEASES[@]}; i++)); do
	if [[ "${ALL_RELEASES[$i]}" != "$(readlink -f "$CURRENT_LINK")" ]]; then
		rm -rf "${ALL_RELEASES[$i]}"
	fi
done

echo "✅ Preview rendezvous activated: $RELEASE_ID"
