#!/bin/sh
set -eu
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' \
    "What: Node.js was not found." \
    "Why: atelier needs Node.js 22.12 or newer." \
    "Fix: install it from https://nodejs.org and run this again." >&2
  exit 1
fi

exec node scripts/start.mjs "$@"
