#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
export PATH="$ROOT/.tools/runtime/bin:$ROOT/.tools/pnpm/node_modules/.bin:$ROOT/node_modules/.bin:$PATH"
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-$ROOT/.tools/ms-playwright}"

if [ ! -x "$ROOT/.tools/runtime/bin/node" ]; then
  printf '%s\n' "项目运行时不存在: $ROOT/.tools/runtime/bin/node" >&2
  exit 1
fi

exec "$@"
