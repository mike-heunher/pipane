#!/usr/bin/env bash
# Deploy the current working tree to the local dev backend and the pipane.dev browser preview.
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$SCRIPT_DIR/scripts/deploy-preview.sh" "$@"
