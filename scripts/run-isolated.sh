#!/bin/sh
# Start this checkout as an ISOLATED instance (Jira connector plan J3, D7):
# the process gets a clean environment — only HOME, PATH, USER, SHELL, LANG,
# TERM and ENV_FILE — so nothing exported in the calling shell (another bot's
# token, Atlassian credentials) reaches it, and the env loader reads ONLY the
# given file (no ~/.config/telegramcode/.env, no legacy config, no $PWD/.env).
#
#   scripts/run-isolated.sh /absolute/path/to/instance.env [telegramcode args…]
#
# The env file holds every setting of the instance, e.g. CONNECTORS, DATA_DIR,
# WORK_ROOT and TMUX_SOCKET_NAME. IS_SANDBOX is passed on when set: inside the
# telegramcode image the instance runs as root, where Claude Code needs it.
set -eu

if [ "$#" -lt 1 ]; then
  echo "usage: $0 <absolute env file> [telegramcode args...]" >&2
  exit 2
fi
env_file=$1
shift
case "$env_file" in
  /*) ;;
  *) echo "run-isolated: the env file must be an absolute path (got: $env_file)" >&2; exit 2 ;;
esac
if [ ! -f "$env_file" ] || [ ! -r "$env_file" ]; then
  echo "run-isolated: not a readable file: $env_file" >&2
  exit 2
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec env -i \
  HOME="$HOME" \
  PATH="$PATH" \
  USER="${USER:-}" \
  SHELL="${SHELL:-/bin/sh}" \
  LANG="${LANG:-C.UTF-8}" \
  TERM="${TERM:-dumb}" \
  ${IS_SANDBOX:+"IS_SANDBOX=$IS_SANDBOX"} \
  ENV_FILE="$env_file" \
  node "$script_dir/../dist/cli.js" "$@"
