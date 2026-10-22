#!/bin/sh
set -eu
cd "$(dirname "$0")"
exec ./scripts/with-runtime.sh node scripts/start-mac.mjs
