#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

usage() {
	echo "用法：./start.sh [desktop|web|cli] [参数...]" >&2
	echo "      ./start.sh --prepare" >&2
}

if ! command -v npm >/dev/null 2>&1; then
	echo "未找到 npm，请先安装 Node.js 22.19 或更新版本。" >&2
	exit 1
fi

if [[ "${1:-}" == "--prepare" ]]; then
	if ! command -v uv >/dev/null 2>&1; then
		echo "未找到 uv，请先安装 uv 后重试。" >&2
		exit 1
	fi
	uv sync --project backend --frozen
	npm install --ignore-scripts
	exit 0
fi

MODE=desktop
case "${1:-}" in
	desktop|web|cli)
		MODE="$1"
		shift
		;;
	"") ;;
	*)
		usage
		exit 2
		;;
esac

if [[ "$MODE" == desktop && $# -gt 0 ]]; then
	usage
	exit 2
fi

BACKEND="${AMAZME_PYTHON_BACKEND:-backend/.venv/bin/amazme-backend}"
if [[ "$BACKEND" != /* ]]; then
	BACKEND="$ROOT/$BACKEND"
fi
if [[ ! -x "$BACKEND" || ! -d node_modules ]]; then
	echo "依赖尚未准备，请先运行 ./start.sh --prepare。" >&2
	exit 1
fi
export AMAZME_PYTHON_BACKEND="$BACKEND"

case "$MODE" in
	desktop) exec npm run dev:desktop ;;
	web)
		if [[ $# -gt 0 ]]; then
			exec npm run dev:web -- "$@"
		fi
		exec npm run dev:web
		;;
	cli)
		if [[ $# -gt 0 ]]; then
			exec npm run dev:tui -- "$@"
		fi
		exec npm run dev:tui
		;;
esac
