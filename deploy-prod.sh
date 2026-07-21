#!/usr/bin/env bash
# Explicitly deploy the current committed working tree to local production on port 8222.
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$SCRIPT_DIR/scripts/deploy-local-release.sh" prod
