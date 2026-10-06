#!/bin/bash
# Restart the bot inside the container without restarting the container: every agent keeps running and is
# adopted by the new bot. What a change to the hot supervisor's own files (src/cli.ts, src/cli/hot.ts,
# nodemon.json) needs.
#
#   docker exec telegramcode-<instance> telegramcode-restart-bot
set -euo pipefail

supervisorPidFile=/tmp/telegramcode-supervisor.pid
restartNowFile=/tmp/telegramcode-restart-now

pid=$(cat "$supervisorPidFile" 2>/dev/null || true)
if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then
  echo "telegramcode-restart-bot: no running bot supervisor found" >&2
  exit 1
fi
touch "$restartNowFile"
kill -TERM "$pid"
echo "telegramcode-restart-bot: the bot is stopping; the entrypoint starts it again"
