#!/bin/bash
# Start the bot from the mounted checkout in hot mode and keep it running — what a systemd unit with
# Restart=always does on a host. The tmux server and the OpenCode server leave the bot's process tree, so a bot
# restart (a crash, telegramcode-restart-bot, a hot reload) never ends an agent; only a container restart does.
set -euo pipefail

checkout=/opt/telegramcode
supervisorPidFile=/tmp/telegramcode-supervisor.pid
restartNowFile=/tmp/telegramcode-restart-now
restartDelaySeconds=20
installStamp=node_modules/.telegramcode-image

cd "$checkout"
if [ ! -f package.json ]; then
  echo "telegramcode: no checkout at $checkout — mount the bot's repository there" >&2
  exit 2
fi
mkdir -p "$HOME"

# Dependencies installed for THIS image: node-pty is native, so a node_modules installed on a host is rebuilt.
lockHash=$(sha256sum yarn.lock | cut -d' ' -f1)
installedFor=$(cat "$installStamp" 2>/dev/null || true)
if [ "$installedFor" != "$lockHash" ]; then
  echo "telegramcode: installing dependencies for the image" >&2
  yarn install --immutable
  # No stamp: this node_modules was not installed by the image. yarn keeps a native build made under the same
  # Node version as up to date, whatever system built it, so rebuild them all once.
  if [ -z "$installedFor" ]; then
    yarn rebuild
  fi
  echo "$lockHash" > "$installStamp"
fi
if [ ! -f dist/cli.js ]; then
  echo "telegramcode: building" >&2
  yarn build
fi

stopSupervisor() {
  local pid
  pid=$(cat "$supervisorPidFile" 2>/dev/null || true)
  if [ -n "$pid" ]; then
    kill -TERM "$pid" 2>/dev/null || true
    # The bot flushes its state and releases its lock before it exits.
    wait "$pid" 2>/dev/null || true
  fi
  exit 0
}
trap stopSupervisor TERM INT

while true; do
  node dist/cli.js hot &
  echo $! > "$supervisorPidFile"
  status=0
  wait $! || status=$?
  if [ -f "$restartNowFile" ]; then
    rm -f "$restartNowFile"
    echo "telegramcode: restarting the bot" >&2
    continue
  fi
  echo "telegramcode: the bot exited ($status); restarting in ${restartDelaySeconds} s" >&2
  sleep "$restartDelaySeconds"
done
