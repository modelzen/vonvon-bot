#!/usr/bin/env bash
# Run after npm run build. Fake Feishu only; no service installation or real bot data.
set -euo pipefail
T=$(mktemp -d)
trap 'rm -rf -- "${T:?}"' EXIT
node "$(dirname "$0")/check-crash-recovery.mjs" "$T"
