# Migrating from the TelegramCode names to Charness

The product, the package and the command became **Charness** / `charness` in 3.0.0. This change renames what
was left under the old name: the config and data dirs, the environment variables, the Docker names and a few
internal identifiers. **Nothing breaks on update**: every old name is still read as a fallback, and each fallback
in use prints one line at start (the terminal and the bot log):

```
[deprecated] ~/.telegramCode is deprecated, rename it to ~/.charness (see MIGRATION_RENAME_TO_CHARNESS.md)
```

The new name always wins when both exist. Nothing is moved for you. The fallbacks are a bridge, not a
permanent feature: rename now.

## What was renamed

| Old | New | While the old one is still read |
|-----|-----|---------------------------------|
| `~/.config/telegramcode/.env` (and the older `~/.config/telegram-code/.env`) | `~/.config/charness/.env` | read when the new file does not exist |
| `~/.telegramCode` — the default `DATA_DIR` | `~/.charness` | used while `~/.charness` does not exist; an explicit `DATA_DIR` is never touched |
| `TELEGRAMCODE_HOT_RELOAD`, `TELEGRAMCODE_OPENCODE_PROCESS_FILE` | `CHARNESS_HOT_RELOAD`, `CHARNESS_OPENCODE_PROCESS_FILE` | read when the new one is unset; `charness hot` sets both |
| MCP header `x-telegramcode-mcp-client-id` | `x-charness-mcp-client-id` | the bot's MCP server accepts both |
| OpenCode plugin `telegramcode-compaction.js` (id `telegramcode-compaction`) | `charness-compaction.js` (id `charness-compaction`) | the old file is removed when the new one is installed |
| Docker image `telegramcode`, service `telegramcode`, container `telegramcode-main` | `charness`, `charness`, `charness-main` | a container of the old image keeps running as it is |
| `/opt/telegramcode`, `/home/telegramcode`, `/srv/telegramcode/…` (Docker mounts and host paths) | `/opt/charness`, `/home/charness`, `/srv/charness/…` | the new image's entrypoint accepts the old mount points |
| `telegramcode-restart-bot` | `charness-restart-bot` | the old name is a link in the new image and says so |
| compose variables `TELEGRAMCODE_DATA_DIR`, `TELEGRAMCODE_WORK_ROOT` | `CHARNESS_DATA_DIR`, `CHARNESS_WORK_ROOT` | `examples/docker-compose.yml` reads both |
| `/tmp/telegramcode-supervisor.pid`, `/tmp/telegramcode-restart-now`, `node_modules/.telegramcode-image` (inside the container) | the same with `charness-` / `.charness-image` | the old install stamp is still honoured |

Unchanged on purpose: the `telegramcode` and `telegramCode` commands (aliases of `charness` in `package.json`),
the `TELEGRAM_*` variables (they name Telegram, not the project) and every `DATA_DIR` you set explicitly.

## Steps

Do the update first; do the renames whenever the deprecation lines tell you to. Order does not matter.

### A plain npm install

1. `npm install -g charness@latest`, then restart `charness` (or `charness hot`).
2. Config: stop the bot, then `mv ~/.config/telegramcode ~/.config/charness`.
3. Data dir, only if you rely on the default (no `DATA_DIR` in your env file). Either leave it where it is and
   say so, which also silences the line and moves nothing — add to `~/.config/charness/.env`:

   ```dotenv
   DATA_DIR=/home/<you>/.telegramCode
   ```

   or move it while **no agent is running** (a session started under the old path keeps writing its exit code
   there): stop the bot, `mv ~/.telegramCode ~/.charness`, start the bot. Update anything of yours that holds the
   old path (a cron entry, a script).
4. If you start the bot with `TELEGRAMCODE_*` variables of your own, nothing reads them besides the two hot-mode
   ones below; they are set by the supervisor, not by you.

### A source checkout with self-update (hot mode)

1. `scripts/self-update.sh` pulls the change; hot mode rebuilds and restarts the **worker**, which falls back to
   the old names the **supervisor** still sets (`TELEGRAMCODE_HOT_RELOAD`, `TELEGRAMCODE_OPENCODE_PROCESS_FILE`).
2. The update touches the supervisor's own files, so restart it once (`systemctl --user restart <unit>` or stop
   and start `charness hot`): it then sets the new variable names, and the deprecation lines about them stop.
   Agents survive the restart as after any bot restart.
3. Rename the config and the data dir as in the npm steps above.
4. Every host that mirrors this checkout (`git pull` on a timer) gets the same change and the same lines;
   rename there too.

### Docker

A running container of the old image is not affected by the update: it runs the old entrypoint, with the
checkout mounted at `/opt/telegramcode`, and hot mode picks the new code up as above. Move to the new names when
you next rebuild the image:

1. `cd <checkout> && docker build -t charness -f docker/Dockerfile .`
2. Mount the checkout at `/opt/charness` and the agents' home at `/home/charness`. The new entrypoint still
   starts from `/opt/telegramcode` and uses a non-empty `/home/telegramcode` while `/home/charness` is empty,
   with a warning each; `docker exec` shells use `/home/charness`, so mount it there.
3. Name the container `charness-<instance>` (or keep your own name; the instance lock only needs the hostname
   to stay fixed). Restart only the bot with `docker exec <container> charness-restart-bot`.
4. With `examples/docker-compose.yml`: copy the new file and rename `TELEGRAMCODE_DATA_DIR` and
   `TELEGRAMCODE_WORK_ROOT` in your `.env` to `CHARNESS_DATA_DIR` and `CHARNESS_WORK_ROOT` (the old names still
   work). The service name changed, so `docker compose down` the old one first, or `up` leaves it running next to
   the new one.

## What you may see after the update

- `[deprecated] … is deprecated, rename it to … (see MIGRATION_RENAME_TO_CHARNESS.md)` once per start for each
  old name in use: the data dir, the global config dir, a plugin file or the MCP header (an agent session that was
  launched before the update still sends the old one; a restarted session sends the new one).
- `[deprecated] TELEGRAMCODE_HOT_RELOAD … the running charness hot supervisor still sets it`: restart the
  supervisor (above).
- The OpenCode compaction plugin is reinstalled under its new name and the old file is deleted; a folder whose
  OpenCode instance already loaded the old plugin keeps it until OpenCode is restarted.
