#!/bin/bash
# Restart the bot inside the container without restarting the container: every agent keeps running and is
# adopted by the new bot. What a change to the hot supervisor's own files (src/cli.ts, src/cli/hot.ts,
# nodemon.json) needs.
#
#   docker exec charness-<instance> charness-restart-bot
#
# `telegramcode-restart-bot`, its name before the rename, is a link to this script and still works.
set -euo pipefail

supervisorPidFile=/tmp/charness-supervisor.pid
restartNowFile=/tmp/charness-restart-now

if [ "$(basename "$0")" = "telegramcode-restart-bot" ]; then
  echo "telegramcode-restart-bot is deprecated, rename it to charness-restart-bot (see MIGRATION_RENAME_TO_CHARNESS.md)" >&2
fi

pid=$(cat "$supervisorPidFile" 2>/dev/null || true)
if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then
  echo "charness-restart-bot: no running bot supervisor found" >&2
  exit 1
fi
touch "$restartNowFile"
kill -TERM "$pid"
echo "charness-restart-bot: the bot is stopping; the entrypoint starts it again"
