#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

if ! command -v uv >/dev/null 2>&1; then
	echo "未找到 uv，请先安装 uv 后重试。" >&2
	exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
	echo "未找到 npm，请先安装 Node.js 22.19 或更新版本。" >&2
	exit 1
fi

uv sync --project backend --frozen
npm install --ignore-scripts
exec npm run dev:desktop
