#!/usr/bin/env bash
# Atomically activate an uploaded pipane.dev browser preview on the rendezvous host.
set -Eeuo pipefail

if [[ $# -ne 4 ]]; then
	echo "Usage: $0 <deploy-root> <release-id> <index-sha256> <public-url>" >&2
	exit 2
fi

DEPLOY_ROOT="$1"
RELEASE_ID="$2"
EXPECTED_INDEX_HASH="$3"
PUBLIC_URL="${4%/}"
RELEASES_DIR="$DEPLOY_ROOT/releases"
CURRENT_LINK="$DEPLOY_ROOT/current"
STAGING_DIR="$DEPLOY_ROOT/.staging-$RELEASE_ID"
RELEASE_DIR="$RELEASES_DIR/$RELEASE_ID"
DEFAULT_PACKAGE_CLIENT_DIR="/usr/lib/node_modules/pipane/dist/client"
PACKAGE_CLIENT_DIR="${PIPANE_PREVIEW_PACKAGE_CLIENT_DIR:-$DEFAULT_PACKAGE_CLIENT_DIR}"
LOCK_FILE="${PIPANE_PREVIEW_LOCK_FILE:-/run/lock/pipane-preview-web-deploy.lock}"
HEALTH_ATTEMPTS="${PIPANE_PREVIEW_HEALTH_ATTEMPTS:-40}"
HEALTH_DELAY="${PIPANE_PREVIEW_HEALTH_DELAY:-0.25}"
KEEP_RELEASES=5
ACTIVATION_STARTED=0
ACTIVATION_SUCCEEDED=0
PREVIOUS_RELEASE=""

if [[ $EUID -ne 0 && "$PACKAGE_CLIENT_DIR" == "$DEFAULT_PACKAGE_CLIENT_DIR" ]]; then
	echo "❌ Preview web activation must run as root." >&2
	exit 1
fi
if [[ ! "$DEPLOY_ROOT" =~ ^/[A-Za-z0-9._/-]+$ ]] \
	|| [[ ! "$PACKAGE_CLIENT_DIR" =~ ^/[A-Za-z0-9._/-]+$ ]] \
	|| [[ ! "$LOCK_FILE" =~ ^/[A-Za-z0-9._/-]+$ ]] \
	|| [[ ! "$RELEASE_ID" =~ ^[A-Za-z0-9._-]+$ ]] \
	|| [[ ! "$EXPECTED_INDEX_HASH" =~ ^[a-f0-9]{64}$ ]] \
	|| [[ ! "$PUBLIC_URL" =~ ^https?://[A-Za-z0-9.-]+(:[0-9]+)?$ ]] \
	|| [[ ! "$HEALTH_ATTEMPTS" =~ ^[1-9][0-9]*$ ]] \
	|| [[ ! "$HEALTH_DELAY" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
	echo "❌ Invalid preview web activation arguments." >&2
	exit 2
fi
for command_name in curl flock sha256sum; do
	if ! command -v "$command_name" >/dev/null 2>&1; then
		echo "❌ Missing required command: $command_name" >&2
		exit 1
	fi
done
if [[ ! -f "$STAGING_DIR/index.html" ]]; then
	echo "❌ Uploaded browser bundle is missing index.html." >&2
	exit 1
fi
if [[ "$(sha256sum "$STAGING_DIR/index.html" | awk '{print $1}')" != "$EXPECTED_INDEX_HASH" ]]; then
	echo "❌ Uploaded browser bundle failed its checksum." >&2
	exit 1
fi

mkdir -p "$RELEASES_DIR" "$(dirname "$LOCK_FILE")"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
	echo "❌ Another preview web deployment is already running." >&2
	exit 1
fi
if [[ -e "$RELEASE_DIR" ]]; then
	echo "❌ Preview release already exists: $RELEASE_ID" >&2
	exit 1
fi

cleanup() {
	local exit_code=$?
	if [[ $exit_code -ne 0 && $ACTIVATION_STARTED -eq 1 && $ACTIVATION_SUCCEEDED -ne 1 ]]; then
		if [[ -n "$PREVIOUS_RELEASE" && -d "$PREVIOUS_RELEASE" ]]; then
			echo "↩️  Restoring $(basename "$PREVIOUS_RELEASE")..." >&2
			switch_current "$PREVIOUS_RELEASE" || true
		fi
		rm -rf "$RELEASE_DIR"
	elif [[ $ACTIVATION_STARTED -ne 1 && -d "$STAGING_DIR" ]]; then
		rm -rf "$STAGING_DIR"
	fi
	return "$exit_code"
}
trap cleanup EXIT

switch_current() {
	local target="$1"
	local next_link="$DEPLOY_ROOT/.current.$$"
	ln -s "$target" "$next_link"
	mv -Tf "$next_link" "$CURRENT_LINK"
}

bootstrap_package_client_link() {
	if [[ -L "$PACKAGE_CLIENT_DIR" ]]; then
		if [[ "$(readlink "$PACKAGE_CLIENT_DIR")" != "$CURRENT_LINK" ]]; then
			echo "❌ $PACKAGE_CLIENT_DIR points outside the preview deployment." >&2
			exit 1
		fi
		if [[ ! -f "$PACKAGE_CLIENT_DIR/index.html" ]]; then
			echo "❌ The current preview browser bundle is missing index.html." >&2
			exit 1
		fi
		return
	fi
	if [[ ! -d "$PACKAGE_CLIENT_DIR" || ! -f "$PACKAGE_CLIENT_DIR/index.html" ]]; then
		echo "❌ Missing packaged Pipane browser bundle at $PACKAGE_CLIENT_DIR." >&2
		exit 1
	fi

	local bootstrap_id="bootstrap-$(date -u +%Y%m%dT%H%M%S)-$$"
	local bootstrap_staging="$RELEASES_DIR/.bootstrap.$$"
	local bootstrap_release="$RELEASES_DIR/$bootstrap_id"
	local package_backup="${PACKAGE_CLIENT_DIR}.preview-backup.$$"
	local package_link="${PACKAGE_CLIENT_DIR}.preview-link.$$"

	cp -a "$PACKAGE_CLIENT_DIR" "$bootstrap_staging"
	mv "$bootstrap_staging" "$bootstrap_release"
	switch_current "$bootstrap_release"
	ln -s "$CURRENT_LINK" "$package_link"
	mv "$PACKAGE_CLIENT_DIR" "$package_backup"
	if ! mv "$package_link" "$PACKAGE_CLIENT_DIR"; then
		mv "$package_backup" "$PACKAGE_CLIENT_DIR" || true
		rm -f "$package_link"
		exit 1
	fi
	rm -rf "$package_backup"
}

bootstrap_package_client_link
mv "$STAGING_DIR" "$RELEASE_DIR"
PREVIOUS_RELEASE="$(readlink -f "$CURRENT_LINK" 2>/dev/null || true)"
switch_current "$RELEASE_DIR"
ACTIVATION_STARTED=1

HEALTHY=0
for ((attempt = 0; attempt < HEALTH_ATTEMPTS; attempt++)); do
	PUBLIC_INDEX_HASH="$(curl -fsS "$PUBLIC_URL/" 2>/dev/null | sha256sum | awk '{print $1}' || true)"
	if curl -fsS "$PUBLIC_URL/health" 2>/dev/null | grep -q '"ok":true' \
		&& [[ "$PUBLIC_INDEX_HASH" == "$EXPECTED_INDEX_HASH" ]]; then
		HEALTHY=1
		break
	fi
	sleep "$HEALTH_DELAY"
done

if [[ $HEALTHY -ne 1 ]]; then
	echo "❌ Public preview failed its health or browser checksum check." >&2
	exit 1
fi

ACTIVATION_SUCCEEDED=1

mapfile -t ALL_RELEASES < <(
	find "$RELEASES_DIR" -mindepth 1 -maxdepth 1 -type d ! -name '.bootstrap.*' -printf '%T@ %p\n' \
		| sort -rn | cut -d' ' -f2-
)
for ((i = KEEP_RELEASES; i < ${#ALL_RELEASES[@]}; i++)); do
	if [[ "${ALL_RELEASES[$i]}" != "$(readlink -f "$CURRENT_LINK")" ]]; then
		rm -rf "${ALL_RELEASES[$i]}"
	fi
done

echo "✅ Public browser preview activated: $RELEASE_ID"
