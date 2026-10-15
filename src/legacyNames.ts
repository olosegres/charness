/**
 * @description The names the project had before it was renamed from TelegramCode
 * to Charness, and the one place that knows how a running instance falls back to
 * them.
 *
 * WHY a fallback exists: instances hot-reload `main`, so for a while old and new
 * code meet — the hot SUPERVISOR keeps running the code it was started with (and
 * keeps setting the old env var names for each new worker), other hosts' mirrors
 * pull the rename without moving their data dir, and a running agent keeps the
 * MCP header its launch config named. Every renamed name is therefore read as
 * `new ?? old`, the old one only as a fallback, and each use of a fallback is
 * announced ONCE per process, naming the migration doc.
 *
 * Nothing here moves a user's file: the fallback only decides which existing path
 * is read. Moving them is `legacyMigration.ts`'s job, at a cold start.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** The document an operator or an agent finds the old → new table and the steps in. */
export const renameMigrationDoc = 'MIGRATION_RENAME_TO_CHARNESS.md';

/** Default `DATA_DIR` under the home dir, and the one the pre-rename releases used. */
export const defaultDataDirName = '.charness';
export const legacyDefaultDataDirName = '.telegramCode';

/**
 * Per-user config dir under `~/.config`, and the ones earlier releases used,
 * newest first: `telegramcode` before the rename, `telegram-code` before that.
 */
export const configDirName = 'charness';
export const legacyConfigDirNames: readonly string[] = ['telegramcode', 'telegram-code'];

/** A renamed environment variable: the current name and the one earlier releases used. */
export interface RenamedEnvName {
  current: string;
  legacy: string;
}

/**
 * The supervisor → worker handshake of hot mode (`charness hot`). An operator
 * never sets these: the supervisor does, so a legacy one reaching a worker means
 * the supervisor still runs pre-rename code.
 */
export const hotReloadEnvName: RenamedEnvName = {
  current: 'CHARNESS_HOT_RELOAD',
  legacy: 'TELEGRAMCODE_HOT_RELOAD',
};
export const openCodeProcessFileEnvName: RenamedEnvName = {
  current: 'CHARNESS_OPENCODE_PROCESS_FILE',
  legacy: 'TELEGRAMCODE_OPENCODE_PROCESS_FILE',
};
const supervisorEnvNames: readonly RenamedEnvName[] = [hotReloadEnvName, openCodeProcessFileEnvName];

/**
 * @description The value of a renamed variable: the current name wins, the legacy
 * one is the fallback. An empty value counts as unset, as everywhere the bot
 * reads these.
 */
export function readRenamedEnv(env: NodeJS.ProcessEnv, name: RenamedEnvName): string | undefined {
  return env[name.current] || env[name.legacy] || undefined;
}

const defaultDataDirByHome = new Map<string, string>();

/**
 * @description The default `DATA_DIR` (no explicit `DATA_DIR`): `~/.charness`,
 * except that an existing `~/.telegramCode` is kept while `~/.charness` does not
 * exist — an install made before the rename keeps its state where it is. Never
 * creates or moves anything.
 *
 * Decided ONCE per process and home dir: several modules resolve their paths at
 * load and others at every call, and a `~/.charness` that appears while the
 * process runs (the console tee creates it on a fresh install; an operator may
 * `mkdir` it) must not make the two halves disagree until the next restart.
 */
export function resolveDefaultDataDir(homeDir: string = os.homedir()): string {
  const decided = defaultDataDirByHome.get(homeDir);
  if (decided !== undefined) return decided;
  const currentDir = path.join(homeDir, defaultDataDirName);
  const legacyDir = path.join(homeDir, legacyDefaultDataDirName);
  const resolved = !fs.existsSync(currentDir) && fs.existsSync(legacyDir) ? legacyDir : currentDir;
  defaultDataDirByHome.set(homeDir, resolved);
  return resolved;
}

/**
 * @description Decide the default `DATA_DIR` again, forgetting the earlier
 * decision — for the one place that moves the dir (`legacyMigration.ts`), so the
 * rest of the process sees the new path from then on.
 */
export function redecideDefaultDataDir(homeDir: string = os.homedir()): string {
  defaultDataDirByHome.delete(homeDir);
  return resolveDefaultDataDir(homeDir);
}

/** @description `~/.config/<dirName>/.env` under `homeDir`. */
export function buildGlobalConfigEnvPath(dirName: string, homeDir: string = os.homedir()): string {
  return path.join(homeDir, '.config', dirName, '.env');
}

/**
 * @description The per-user global config file: `~/.config/charness/.env`, else
 * the first existing of the earlier releases' dirs. When none exists the
 * canonical path is returned — the location a fresh install should use. Nothing
 * is moved.
 */
export function resolveGlobalConfigEnvPath(homeDir: string = os.homedir()): string {
  const canonicalPath = buildGlobalConfigEnvPath(configDirName, homeDir);
  if (fs.existsSync(canonicalPath)) return canonicalPath;
  for (const legacyDirName of legacyConfigDirNames) {
    const legacyPath = buildGlobalConfigEnvPath(legacyDirName, homeDir);
    if (fs.existsSync(legacyPath)) return legacyPath;
  }
  return canonicalPath;
}

/** @description The deprecation line every fallback prints: what to rename, to what, and where it is written down. */
export function formatDeprecation(legacyName: string, currentName: string): string {
  return `${legacyName} is deprecated, rename it to ${currentName} (see ${renameMigrationDoc})`;
}

type WriteLine = (text: string) => void;

function writeToStderr(text: string): void {
  process.stderr.write(text);
}

const announcedKeys = new Set<string>();

/**
 * @description Print one deprecation line, once per process per `key`. Returns
 * whether it printed. The default sink is `process.stderr` (read at call time, so
 * the console tee sees it).
 */
export function warnLegacyNameOnce(key: string, message: string, write: WriteLine = writeToStderr): boolean {
  if (announcedKeys.has(key)) return false;
  announcedKeys.add(key);
  write(`[deprecated] ${message}\n`);
  return true;
}

/** Forget what was announced and decided — for tests, which assert the once-only rules per case. */
export function resetLegacyNameState(): void {
  announcedKeys.clear();
  defaultDataDirByHome.clear();
}

/** One fallback in use at boot. */
export interface LegacyNameUse {
  key: string;
  message: string;
}

/**
 * @description Every legacy name the environment and the home dir make the
 * process fall back to right now: a legacy supervisor variable with no current
 * one, the global config dir when it is a pre-rename one, and the default data
 * dir when it is the pre-rename one. (The MCP header and the plugin file are
 * announced where they are seen.)
 */
export function findLegacyNameUses(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
): LegacyNameUse[] {
  const uses: LegacyNameUse[] = [];
  for (const name of supervisorEnvNames) {
    if (env[name.current] || !env[name.legacy]) continue;
    uses.push({
      key: `env:${name.legacy}`,
      message:
        `${name.legacy} is deprecated, the running \`charness hot\` supervisor still sets it: ` +
        `restart it to set ${name.current} (see ${renameMigrationDoc})`,
    });
  }
  // An isolated instance (`ENV_FILE`) reads no global config at all.
  if (!env.ENV_FILE) {
    const globalConfigPath = resolveGlobalConfigEnvPath(homeDir);
    const legacyDirName = legacyConfigDirNames.find(
      (dirName) => buildGlobalConfigEnvPath(dirName, homeDir) === globalConfigPath,
    );
    if (legacyDirName !== undefined) {
      uses.push({
        key: 'global-config-dir',
        message: formatDeprecation(`~/.config/${legacyDirName}`, `~/.config/${configDirName}`),
      });
    }
  }
  if (!env.DATA_DIR && resolveDefaultDataDir(homeDir) === path.join(homeDir, legacyDefaultDataDirName)) {
    uses.push({
      key: 'default-data-dir',
      message: formatDeprecation(`~/${legacyDefaultDataDirName}`, `~/${defaultDataDirName}`),
    });
  }
  return uses;
}

/**
 * @description The boot-time announcement: print each fallback in use, once per
 * process. Called by the plain start (after the console tee, so it reaches the
 * bot log) and by the hot supervisor.
 */
export function warnLegacyNamesAtBoot(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
  write: WriteLine = writeToStderr,
): void {
  for (const use of findLegacyNameUses(env, homeDir)) warnLegacyNameOnce(use.key, use.message, write);
}
