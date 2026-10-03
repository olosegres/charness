/**
 * @description The environment an agent of a tracker conversation starts with
 * (Jira connector plan R32): a short allowlist of what a shell and Claude Code's
 * own login need, read from the process environment — never a variable the
 * instance's `ENV_FILE` set. Everything else the instance holds (the tracker
 * account's API token among it) stays out of reach of an agent that a
 * prompt-injected issue could steer. The same set is what tmux calls on a
 * PRIVATE tmux server run with, so that server's global environment — which
 * every session on it inherits and any process on it can read back — holds no
 * secret either.
 */

/**
 * The variables passed on: the user, the home folder (Claude Code's login lives
 * there), the search path, the shell, the locale, the terminal type, the
 * temporary folder and the timezone (`/timezone` sets it on the process).
 * Claude Code 2.1.287 starts and finds its login in HOME with this list alone
 * (probed under `env -i`). A deployment that relies on `CLAUDE_CONFIG_DIR`, an
 * HTTP(S) proxy or `NODE_EXTRA_CA_CERTS` must add the name here: a missing one
 * fails silently (no login found, no network), never with an error.
 */
export const agentEnvironmentNames = [
  'HOME',
  'PATH',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TMPDIR',
  'TZ',
] as const;

/** Names the instance's `ENV_FILE` set — recorded by the env loader on every load (the hot worker loads it again). */
const envFileVariableNames = new Set<string>();

/** @description Remember which variables came from the instance's `ENV_FILE`: none of them reaches an agent. */
export function addEnvFileVariableNames(names: Iterable<string>): void {
  for (const name of names) envFileVariableNames.add(name);
}

/** @description Forget the recorded names — for tests only, so each case starts from a process that loaded no env file. */
export function resetEnvFileVariableNamesForTests(): void {
  envFileVariableNames.clear();
}

/**
 * @description The allowlisted variables `env` holds, minus any the `ENV_FILE`
 * set — an instance file that sets `PATH` leaves the agent on the shell's default
 * search path rather than handing it a value from the file.
 */
export function getAgentEnvironment(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const name of agentEnvironmentNames) {
    const value = env[name];
    if (value !== undefined && !envFileVariableNames.has(name)) environment[name] = value;
  }
  return environment;
}
