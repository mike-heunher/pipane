#!/usr/bin/env bash
# Explicitly deploy the current committed working tree to local production on port 8222.
# The actual deployment runs under PID 1 so restarting pipane cannot kill it.
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SYSTEMD_UNIT="${PIPANE_PROD_DEPLOY_SYSTEMD_UNIT:-pipane-prod-deploy}"

if [[ $# -ne 0 ]]; then
	echo "Usage: npm run deploy:prod" >&2
	exit 2
fi
if [[ $EUID -ne 0 ]]; then
	echo "❌ Run the production deployment as root." >&2
	exit 1
fi
if [[ ! "$SYSTEMD_UNIT" =~ ^[A-Za-z0-9_.@-]+$ ]]; then
	echo "❌ PIPANE_PROD_DEPLOY_SYSTEMD_UNIT must be a valid systemd unit name." >&2
	exit 1
fi

if [[ "${PIPANE_PROD_DEPLOY_IN_SYSTEMD:-0}" != "1" ]]; then
	for command_name in systemctl systemd-run; do
		if ! command -v "$command_name" >/dev/null 2>&1; then
			echo "❌ Missing required command: $command_name" >&2
			exit 1
		fi
	done
	if systemctl is-active --quiet "$SYSTEMD_UNIT"; then
		echo "❌ Production deployment unit $SYSTEMD_UNIT is already running." >&2
		exit 1
	fi
	systemd-run --quiet --no-block --collect \
		--unit="$SYSTEMD_UNIT" \
		--property=Type=exec \
		--property=TimeoutStartSec=infinity \
		--working-directory="$SCRIPT_DIR" \
		--setenv=PIPANE_PROD_DEPLOY_IN_SYSTEMD=1 \
		"$SCRIPT_DIR/deploy-prod.sh"
	echo "🚀 Production deployment started in $SYSTEMD_UNIT."
	echo "📊 Logs: journalctl -u $SYSTEMD_UNIT -f"
	exit 0
fi

exec "$SCRIPT_DIR/scripts/deploy-local-release.sh" prod
