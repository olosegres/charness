# Troubleshooting

Known problems and their fixes. Check the bot first with `/doctor` (admin rights, privacy mode, paths, CLIs); installing and
configuring is in [SETUP.md](../SETUP.md), the commands are in [commands.md](commands.md), the overview is the
[README](../README.md).

## Bot doesn't see text (Telegram)

You disabled privacy mode in @BotFather **after** adding the bot. The
flag is cached on join. Fix:

1. Remove the bot from the group.
2. (Re-confirm in @BotFather → `/setprivacy` → this bot → `Disable`.)
3. Add the bot back.

Verify with `/doctor` — the privacy line should report it as disabled.

## `/bind` says "folder not found" (Telegram)

The folder you launched from doesn't contain a subfolder with that name (or
it's a symlink pointing outside it). Run `/ls` to see what's available, or fix
the host path. Path-traversal attempts (`../`, absolute paths,
NUL bytes, NFC-vs-NFD mismatches) are rejected by design — see
`validateSubdir` in `src/validation.ts`.

## "Missing right" / `/clear_messages` does nothing (Telegram)

The bot needs admin rights `can_delete_messages` and `can_pin_messages`
in addition to `can_manage_topics`. Open group settings → admins →
the bot → tick the missing boxes. `/doctor` shows the exact gap.

## Two instances on the same machine fight each other

You forgot to set distinct `DATA_DIR` and `OPENCODE_URL`. The bot logs
`[startup] DATA_DIR=<path>` on boot — if both instances log the same
path, give each its own `DATA_DIR` and `OPENCODE_URL` port and restart both.

## Claude opens a session picker instead of resuming

The 1.x adapter invoked `claude --resume` with no UUID and relied on the
interactive picker, which doesn't survive a non-interactive pty. 2.0
generates a UUID with `crypto.randomUUID()`, passes it via
`--session-id`, and resumes via `--resume <uuid>`. If you see a picker
anyway, your local claude CLI is older than 2.1.x — upgrade with
`npm i -g @anthropic-ai/claude-code` (the bot also auto-installs on
first use, see `src/installManager.ts`).

## OpenCode "address already in use" / "port … is in use … will not start another server"

Two instances on the same host with the same `OPENCODE_URL`, or something else holding that port. The bot
never starts a server onto a port that still takes connections: a server that answers its health check is
used as it is (a slow one too — a check with no answer is asked again, three tries of 2 s, before it counts),
and one it did not start that stays silent gets the error "OpenCode server port N is in use by a process that
did not answer its health probe … it will not start another server on the port" instead of a second server
that dies on the busy port. Only a refused connection proves a port free: a port that does not answer a connect
at all (a hung listener with a full accept queue) gets "port N is not known to be free" and no new server either. A server the bot started itself that stays silent on all three tries is stopped
and replaced. Pick a different port for the second instance (e.g. `4097`), or stop what holds the port.
