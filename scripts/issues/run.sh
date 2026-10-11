#!/usr/bin/env bash
# Start the local issue triage server. See README.md.
set -euo pipefail
cd "$(dirname "$0")/../.."
exec node --import ./packages/coding-agent/src/source-resolver.ts scripts/issues/main.ts
