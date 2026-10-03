import { execFile } from 'child_process';
import { promisify } from 'util';
import { getAgentEnvironment } from './agentEnvironment';

export const execFilePromise = promisify(execFile);

/**
 * @description `-t` target naming a tmux SESSION exactly (`kill-session`). A
 * bare name falls back to a PREFIX match when no session has exactly that name
 * — on tmux 3.4, with topic 2's session gone, `kill-session -t claude-<chat>-2`
 * kills topic 20's. The leading `=` makes the match exact.
 */
export function getTmuxSessionTarget(sessionName: string): string {
  return `=${sessionName}`;
}

/**
 * @description `-t` target naming a session's current pane exactly — for every
 * pane or window command (`send-keys`, `capture-pane`, `display-message`,
 * `list-panes`). Exact for the same reason as {@link getTmuxSessionTarget}; the
 * trailing `:` is required, since `send-keys -t =name` fails "can't find pane".
 */
export function getTmuxPaneTarget(sessionName: string): string {
  return `=${sessionName}:`;
}

/**
 * @description The arguments every tmux call starts with (Jira connector plan J3,
 * D8): `TMUX_SOCKET_NAME` puts the instance on its OWN tmux server (`-L`), away
 * from the default one — a boot kills every agent session it does not own, which
 * on a shared server would be another bot's. The CLI preflight validates the
 * name. This file is the only place that runs tmux; keep it so.
 */
export function getTmuxBaseArgs(): string[] {
  const socketName = process.env.TMUX_SOCKET_NAME;
  return socketName ? ['-L', socketName] : [];
}

/**
 * @description The environment a tmux call runs with. On a PRIVATE server
 * (`TMUX_SOCKET_NAME`) only the agent allowlist plus where its socket lives
 * (R32): the call that starts the server hands it its global environment, which
 * every session inherits and any process on the server can read back — a
 * tracker instance's secrets must not be in it. The default server (a Telegram
 * instance) keeps the bot's own environment, as before.
 */
export function getTmuxExecEnv(): NodeJS.ProcessEnv | undefined {
  if (!process.env.TMUX_SOCKET_NAME) return undefined;
  const socketDir = process.env.TMUX_TMPDIR;
  return { ...getAgentEnvironment(), ...(socketDir ? { TMUX_TMPDIR: socketDir } : {}) };
}

/** Best-effort tmux call: returns stdout on success, empty string on any error. */
export async function tmuxAsync(...args: string[]): Promise<string> {
  try {
    const { stdout } = await execFilePromise('tmux', [...getTmuxBaseArgs(), ...args], {
      encoding: 'utf-8',
      timeout: 5000,
      env: getTmuxExecEnv(),
    });
    return stdout.toString().trim();
  } catch {
    return '';
  }
}

/**
 * @description Strict tmux call: throws if tmux exits non-zero (or times out).
 * Used on critical paths (`new-session`, `send-keys` of the agent command
 * line) where silent failure would leave the bot thinking a session
 * started when it didn't. Callers should wrap and translate to a friendly
 * error for the user.
 */
export async function tmuxOrThrowAsync(...args: string[]): Promise<string> {
  const { stdout } = await execFilePromise('tmux', [...getTmuxBaseArgs(), ...args], {
    encoding: 'utf-8',
    timeout: 5000,
    env: getTmuxExecEnv(),
  });
  return stdout.toString().trim();
}

/**
 * @description Reject `args` with NUL or other control characters before
 * passing to a backend. These are unsafe in shell-quoted contexts (the
 * `'\\''` escape doesn't protect against `\x00`), and tmux/terminals
 * treat them as control sequences. Mirrors `validateSubdir`'s reasoning.
 */
export function checkArgsAreSafe(args: string): boolean {
  return !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(args);
}

/**
 * @description Shell-quote a path for safe inclusion in a tmux `send-keys "..."` command.
 *
 * The tmux command line concatenates: `tmux send-keys -t <name> "cd <dir> && claude ..."`.
 * The dir is interpreted by the user's shell after tmux delivers the keystrokes, so we
 * single-quote it. Embedded single quotes are escaped via the standard
 * `'\''` close-reopen idiom. This is the path a backend will `cd` into, so paths with
 * spaces or special chars (e.g. `~/my projects/foo`) must survive untouched.
 */
export function shellSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
