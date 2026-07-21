#!/usr/bin/env bash
# Explicitly deploy the current working tree to the local dev service on port 8223.
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$SCRIPT_DIR/scripts/deploy-local-release.sh" dev
