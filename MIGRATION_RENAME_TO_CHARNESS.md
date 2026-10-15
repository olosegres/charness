# Migrating from the TelegramCode names to Charness

The product, the package and the command became **Charness** / `charness` in 3.0.0. This change renames what
was left under the old name: the config and data dirs, the environment variables, the Docker names and a few
internal identifiers. **Nothing breaks on update**: every old name is still read as a fallback, and each fallback
in use prints one line at start (the terminal and the bot log):

```
[deprecated] ~/.telegramCode is deprecated, rename it to ~/.charness (see MIGRATION_RENAME_TO_CHARNESS.md)
```

The new name always wins when both exist. The fallbacks are a bridge, not a permanent feature — and at a cold
start the bot renames the config and data dirs itself, see [Automatic migration](#automatic-migration).

## What was renamed

| Old | New | While the old one is still read |
|-----|-----|---------------------------------|
| `~/.config/telegramcode/.env` (and the older `~/.config/telegram-code/.env`) | `~/.config/charness/.env` | read when the new file does not exist |
| `~/.telegramCode` — the default `DATA_DIR` | `~/.charness` | used while `~/.charness` does not exist (or holds no `state.json` while the old dir does); an explicit `DATA_DIR` is never touched |
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

## Automatic migration

At a **cold start** the bot moves what it can, once, by itself:

| What | Becomes | Then |
|------|---------|------|
| `~/.config/telegramcode` (else the older `~/.config/telegram-code`) | `~/.config/charness` | a symlink `~/.config/telegramcode` → `charness` is left at the old path |
| `~/.telegramCode`, the **default** data dir | `~/.charness` | a symlink `~/.telegramCode` → `.charness` is left at the old path |
| `TELEGRAMCODE_*` keys in the config `.env` it just moved | `CHARNESS_*` | the original is kept next to it as `.env.bak` (a second backup becomes `.env.bak.<time>`) |

It logs one line per action, for example
`[migrate] moved ~/.telegramCode to ~/.charness; ~/.telegramCode is now a symlink to it`, into the terminal and
the bot log. The symlinks are relative, so running tmux / json-stream agents and your scripts that still use the
old paths keep working; delete a symlink when nothing uses it any more.

The rules it keeps:

- **Cold start only.** The plain `charness` start, and the start of the `charness hot` supervisor. A hot
  worker's reload never migrates: its supervisor, and the agents it started, still hold files in the data dir.
  A hot-mode instance therefore migrates when its supervisor is restarted.
- **Under the instance lock, before the state is loaded.** A live instance holding the lock blocks it (a line
  says so; the next start tries again).
- **Never an explicit `DATA_DIR`**, whatever path it names, and **nothing at all for an isolated instance**
  (`ENV_FILE` set: it reads only its own file, and the shared config and default data dir belong to another bot).
- **Only the global config file it moved** gets its keys renamed. `ENV_FILE` and a `$PWD/.env` are never
  rewritten: the first is yours (often read-only, mounted into a container), the second belongs to the project
  the bot was launched from. Rename keys there by hand if you use them.
- **Idempotent, and it never deletes anything.** A target that already exists, or an old path that is already
  a symlink (yours, or one of its own), skips the step silently — a second start prints nothing. A step that
  fails (another filesystem, no permission) is logged, leaves both sides usable (a failed symlink undoes its
  move) and the old name keeps working with its deprecation line.

What it cannot fix stays announced: a `TELEGRAMCODE_*` variable set by systemd, your shell or Docker, a
`DATA_DIR` you set to an old-looking path, the Docker names and mounts, and a hot-mode instance until its
supervisor is restarted.

## Steps by hand

Only needed where the automatic migration does not apply or failed — a hot-mode instance before its supervisor
restarts, an `ENV_FILE` instance, an explicit `DATA_DIR`, Docker. Order does not matter.

### A plain npm install

1. `npm install -g charness@latest`, then restart `charness` (or `charness hot`).
2. The start does the renames itself (see above). If it logged that it could not, or you want it by hand:
   stop the bot, `mv ~/.config/telegramcode ~/.config/charness`.
3. Data dir, only if you rely on the default (no `DATA_DIR` in your env file). To keep it exactly where it is and
   silence the line, add to `~/.config/charness/.env` (an explicit `DATA_DIR` is never migrated):

   ```dotenv
   DATA_DIR=/home/<you>/.telegramCode
   ```

   To move it by hand, stop the bot first and move it while **no agent is running**; the automatic migration
   leaves a symlink for the ones that are, a hand `mv` does not: `mv ~/.telegramCode ~/.charness`, start the bot.
   Update anything of yours that holds the old path (a cron entry, a script).
4. If you start the bot with `TELEGRAMCODE_*` variables of your own, nothing reads them besides the two hot-mode
   ones below; they are set by the supervisor, not by you.

### A source checkout with self-update (hot mode)

1. `scripts/self-update.sh` pulls the change; hot mode rebuilds and restarts the **worker**, which falls back to
   the old names the **supervisor** still sets (`TELEGRAMCODE_HOT_RELOAD`, `TELEGRAMCODE_OPENCODE_PROCESS_FILE`)
   and does not migrate.
2. The update touches the supervisor's own files, so restart it once (`systemctl --user restart <unit>` or stop
   and start `charness hot`): the new supervisor migrates the config and data dirs under the instance lock,
   then sets the new variable names, and the deprecation lines about them stop. Agents survive the restart as
   after any bot restart, and keep their old paths through the symlinks.
3. Every host that mirrors this checkout (`git pull` on a timer) gets the same change and does the same when
   its supervisor restarts.

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

- `[migrate] moved …` lines at a cold start: the automatic migration above, once.
- `[migrate] could not move …` / `skipped: another instance holds the lock`: the step is left for the next cold
  start or for you; the old name keeps working.
- `[deprecated] … is deprecated, rename it to … (see MIGRATION_RENAME_TO_CHARNESS.md)` once per start for each
  old name still in use: a hot worker's data dir or config dir (until its supervisor restarts), a failed move,
  a plugin file or the MCP header (an agent session that was launched before the update still sends the old
  one; a restarted session sends the new one).
- `[deprecated] TELEGRAMCODE_HOT_RELOAD … the running charness hot supervisor still sets it`: restart the
  supervisor (above).
- The OpenCode compaction plugin is reinstalled under its new name and the old file is deleted; a folder whose
  OpenCode instance already loaded the old plugin keeps it until OpenCode is restarted.
