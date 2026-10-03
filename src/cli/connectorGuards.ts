import * as fs from 'fs';
import { parseConnectors } from '../platform/connectorSet';
import { getJiraConfigPath, jiraConfigFileName } from '../connectors/jira/configFile';
import { resolveDataDir } from '../state';
import { loadEnvFiles } from './envLoader';

/**
 * @description The fail-closed guards that stop a start before it can touch
 * anything (Jira connector plan J3: D6, D7, D8); which connectors an instance
 * serves is `platform/connectorSet.ts`. They run in the CLI preflight — before
 * the console tee, the lock and the bot module — for the plain and the hot
 * start alike.
 *
 * What they make impossible for an instance that serves Jira:
 *  - using a Telegram bot token it inherited (a live bot's): with the Telegram
 *    connector off a present `TELEGRAM_BOT_TOKEN` is fatal;
 *  - reading the shared config files that hold such tokens: its settings come
 *    from `ENV_FILE` only, required before any file is read;
 *  - touching the default tmux server, where another bot's sessions live (its
 *    boot kills every session it does not own): `TMUX_SOCKET_NAME` is required
 *    and may not name the default server;
 *  - acting under the operator's Atlassian identity: a Jira-only instance
 *    refuses any `ATLASSIAN_*` variable in its environment (its own Jira
 *    settings use other names).
 */


/** `tmux -L default` IS the default server. */
const defaultTmuxSocketName = 'default';
/** A socket NAME, never a path: `-L` puts it in tmux's own socket directory. */
const tmuxSocketNameRe = /^[A-Za-z0-9_-]+$/;
const atlassianEnvPrefix = 'ATLASSIAN_';
/**
 * The oldest Node the Jira connector runs on (R20): it loads an ES-module-only
 * package through `require()`, unflagged from 22.12 — earlier, its first answer
 * would crash the instance instead of refusing the start.
 */
const jiraMinimumNodeVersion = [22, 12] as const;

/** Is `version` (`process.versions.node`, e.g. `22.11.0`) older than `minimum`? */
function checkIsNodeVersionBelow(version: string, minimum: readonly [number, number]): boolean {
  const [major = 0, minor = 0] = version.split('.').map((part) => Number.parseInt(part, 10));
  return major < minimum[0] || (major === minimum[0] && minor < minimum[1]);
}
const envFileRequiredError = 'CONNECTORS lists jira: set ENV_FILE to the instance\'s own env file (it is the only file read)';

type EnvReading = Readonly<Record<string, string | undefined>>;

/**
 * @description The guard that must hold BEFORE any env file is read: an instance
 * the shell already marks as serving Jira reads its settings from `ENV_FILE`
 * only, so the shared config files (which hold a live bot's token) are never
 * opened. A `CONNECTORS` the shell sets but that does not parse is refused here
 * too: it cannot tell whether the instance was meant to serve Jira.
 */
export function getPreloadGuardErrors(env: EnvReading): string[] {
  const parsed = parseConnectors(env.CONNECTORS);
  if (!parsed.ok) return [parsed.error];
  if (!parsed.connectors.includes('jira') || env.ENV_FILE) return [];
  return [envFileRequiredError];
}

/**
 * @description The guards on the loaded environment. Names only — never a value.
 * `envFileAtLaunch` is `ENV_FILE` as it was BEFORE the load: only that value
 * says the instance read nothing but its own file, since a shared config file
 * may itself define `ENV_FILE`.
 */
export function getConnectorGuardErrors(input: {
  env: EnvReading;
  hasJiraConfig: boolean;
  envFileAtLaunch: string | undefined;
  /** `process.versions.node`. */
  nodeVersion: string;
}): string[] {
  const { env } = input;
  const parsed = parseConnectors(env.CONNECTORS);
  if (!parsed.ok) return [parsed.error];
  const isTelegramServed = parsed.connectors.includes('telegram');
  const isJiraServed = parsed.connectors.includes('jira');
  const errors: string[] = [];
  if (!isTelegramServed && env.TELEGRAM_BOT_TOKEN) {
    errors.push('TELEGRAM_BOT_TOKEN is set but the telegram connector is off: refusing a bot token this instance must not use');
  }
  if (env.ENV_FILE !== input.envFileAtLaunch) {
    // The env load already happened from other files; in hot mode the worker would then read a different one.
    errors.push('ENV_FILE is set inside an env file: it may only come from the launching environment');
  } else if (isJiraServed && !input.envFileAtLaunch) {
    errors.push(envFileRequiredError);
  }
  if (isJiraServed && checkIsNodeVersionBelow(input.nodeVersion, jiraMinimumNodeVersion)) {
    errors.push(`CONNECTORS lists jira: Node ${input.nodeVersion} is too old — the Jira connector needs Node ${jiraMinimumNodeVersion.join('.')} or newer`);
  }
  if (isJiraServed && !input.hasJiraConfig) {
    errors.push(`CONNECTORS lists jira but DATA_DIR has no ${jiraConfigFileName}`);
  }
  const tmuxSocketName = env.TMUX_SOCKET_NAME;
  if (tmuxSocketName !== undefined && (!tmuxSocketNameRe.test(tmuxSocketName) || tmuxSocketName === defaultTmuxSocketName)) {
    errors.push(`TMUX_SOCKET_NAME must be a plain name other than "${defaultTmuxSocketName}" (letters, digits, "_", "-")`);
  } else if (isJiraServed && !tmuxSocketName) {
    errors.push('CONNECTORS lists jira: set TMUX_SOCKET_NAME — this instance must not use the default tmux server');
  }
  if (isJiraServed && !isTelegramServed) {
    const atlassianNames = Object.keys(env).filter((name) => name.startsWith(atlassianEnvPrefix)).sort();
    if (atlassianNames.length > 0) {
      errors.push(`a Jira-only instance refuses Atlassian variables in its environment: ${atlassianNames.join(', ')}`);
    }
  }
  return errors;
}

function exitOnGuardErrors(errors: string[]): void {
  if (errors.length === 0) return;
  for (const error of errors) process.stderr.write(`[startup] ${error}\n`);
  process.exit(1);
}

/**
 * @description Load the env files between the two guard passes — the ONE way the
 * CLI starts (plain and hot), so no start skips a guard. Exits 1 on a breach.
 */
export function loadEnvWithConnectorGuards(localDirectory?: string): { loaded: string[] } {
  exitOnGuardErrors(getPreloadGuardErrors(process.env));
  const envFileAtLaunch = process.env.ENV_FILE;
  const result = loadEnvFiles(localDirectory);
  const hasJiraConfig = fs.existsSync(getJiraConfigPath(resolveDataDir()));
  exitOnGuardErrors(getConnectorGuardErrors({ env: process.env, hasJiraConfig, envFileAtLaunch, nodeVersion: process.versions.node }));
  return result;
}
