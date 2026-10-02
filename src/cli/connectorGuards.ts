import * as fs from 'fs';
import * as path from 'path';
import type { PlatformId } from '../sessionKey';
import { resolveDataDir } from '../state';
import { loadEnvFiles } from './envLoader';

/**
 * @description Which connectors an instance serves, and the fail-closed guards
 * that stop a start before it can touch anything (Jira connector plan J3: D6,
 * D7, D8). They run in the CLI preflight — before the console tee, the lock and
 * the bot module — for the plain and the hot start alike.
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

export const connectorIds = ['telegram', 'jira'] as const;
export type ConnectorId = (typeof connectorIds)[number];

/** An unset `CONNECTORS` keeps the instance what it always was. */
export const defaultConnectors: readonly ConnectorId[] = ['telegram'];

/** The Jira connector's config file under `DATA_DIR` (its content is J4's). */
export const jiraConfigFileName = 'jira.json';

/** `tmux -L default` IS the default server. */
const defaultTmuxSocketName = 'default';
/** A socket NAME, never a path: `-L` puts it in tmux's own socket directory. */
const tmuxSocketNameRe = /^[A-Za-z0-9_-]+$/;
const atlassianEnvPrefix = 'ATLASSIAN_';
const envFileRequiredError = 'CONNECTORS lists jira: set ENV_FILE to the instance\'s own env file (it is the only file read)';

function checkIsConnectorId(name: string): name is ConnectorId {
  return connectorIds.some((id) => id === name);
}

export type ConnectorsParse = { ok: true; connectors: ConnectorId[] } | { ok: false; error: string };

/** @description `CONNECTORS` as a comma list (`telegram`, `jira`), unset → Telegram only. */
export function parseConnectors(raw: string | undefined): ConnectorsParse {
  if (raw === undefined || raw.trim() === '') return { ok: true, connectors: [...defaultConnectors] };
  const names = raw.split(',').map((name) => name.trim()).filter((name) => name !== '');
  const unknown = names.filter((name) => !checkIsConnectorId(name));
  if (unknown.length > 0) {
    return { ok: false, error: `CONNECTORS has unknown connector(s) ${unknown.join(', ')} (known: ${connectorIds.join(', ')})` };
  }
  if (names.length === 0) return { ok: false, error: 'CONNECTORS names no connector' };
  return { ok: true, connectors: connectorIds.filter((id) => names.includes(id)) };
}

/** @description The platforms whose conversations an instance serving `connectors` owns. */
export function getServedPlatforms(connectors: readonly ConnectorId[]): ReadonlySet<PlatformId> {
  return new Set<PlatformId>(connectors);
}

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
  const hasJiraConfig = fs.existsSync(path.join(resolveDataDir(), jiraConfigFileName));
  exitOnGuardErrors(getConnectorGuardErrors({ env: process.env, hasJiraConfig, envFileAtLaunch }));
  return result;
}
