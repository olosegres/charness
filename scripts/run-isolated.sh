#!/bin/sh
# Start this checkout as an ISOLATED instance: the process gets a clean
# environment — only HOME, PATH, USER, SHELL, LANG and TERM — so nothing exported
# in the calling shell (another bot's token) reaches it. The env loader then
# reads only the instance's own `$HOME/.config/telegramcode/.env` (and a `.env`
# in the working directory, which the caller keeps empty), so a caller that
# points HOME at a folder of its own gets an instance of its own.
#
#   HOME=/path/to/instance/home scripts/run-isolated.sh [telegramcode args…]
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec env -i \
  HOME="$HOME" \
  PATH="$PATH" \
  USER="${USER:-}" \
  SHELL="${SHELL:-/bin/sh}" \
  LANG="${LANG:-C.UTF-8}" \
  TERM="${TERM:-dumb}" \
  node "$script_dir/../dist/cli.js" "$@"
