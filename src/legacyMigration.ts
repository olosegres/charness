/**
 * @description The automatic, idempotent move from the pre-rename names to the
 * Charness ones, run at a COLD start of the bot: the global config dir
 * (`~/.config/telegramcode`, older `~/.config/telegram-code` → `~/.config/charness`)
 * and the default data dir (`~/.telegramCode` → `~/.charness`). Each moved dir
 * leaves a relative SYMLINK at its old path, so a tmux / json-stream agent that
 * still holds an old absolute path, an external script and an older mirror keep
 * working. `legacyNames.ts` stays the read-fallback for whatever this does not
 * (or could not) move.
 *
 * WHEN it runs — and the rules that keep it safe:
 *  - cold start only: the plain `charness` start and the hot SUPERVISOR's start.
 *    A hot WORKER reload never migrates (its supervisor, possibly the pre-rename
 *    code, still holds paths in the data dir — the caller passes nothing and
 *    this module is never reached from the worker).
 *  - under the instance lock, before the state is loaded (the caller acquires
 *    it; {@link migrateLegacyNamesUnderLock} takes it itself for the supervisor).
 *  - never for an isolated instance (`ENV_FILE`): it reads only its own file and
 *    its own dirs, and the shared config and default data dir belong to another
 *    bot. Never for an explicit `DATA_DIR`, whatever it names.
 *  - idempotent: a target that exists, or an old path that is already a symlink
 *    (ours, or the operator's own), skips the step; nothing is ever deleted; a
 *    failed step is logged and leaves BOTH sides usable (a failed symlink rolls
 *    the move back).
 *  - `TELEGRAMCODE_*` keys are renamed to `CHARNESS_*` only in the global config
 *    file this migration moved (a `.bak` copy first). `ENV_FILE` and `$PWD/.env`
 *    are never rewritten: the first is the operator's own, possibly read-only
 *    and mounted into a container; the second belongs to whatever project the
 *    bot was launched from.
 *
 * One log line per action taken. A step that is skipped because there is nothing
 * to do is silent, so a second start prints nothing.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  configDirName,
  defaultDataDirName,
  legacyConfigDirNames,
  legacyDefaultDataDirName,
  redecideDefaultDataDir,
  renameMigrationDoc,
} from './legacyNames';
import { releaseLock, tryAcquireLock } from './instanceLock';

/** The pre-rename key prefix in a config file, and what it becomes. */
const legacyEnvKeyPrefix = 'TELEGRAMCODE_';
const currentEnvKeyPrefix = 'CHARNESS_';
const envFileName = '.env';
const envBackupSuffix = '.bak';

type FsOps = Pick<
  typeof fs,
  | 'lstatSync'
  | 'renameSync'
  | 'symlinkSync'
  | 'realpathSync'
  | 'readFileSync'
  | 'writeFileSync'
  | 'copyFileSync'
  | 'chmodSync'
  | 'existsSync'
  | 'unlinkSync'
>;

export interface LegacyMigrationOptions {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  /** One line per action taken. */
  log?: (line: string) => void;
  /** One line per failed step. */
  warn?: (line: string) => void;
  /** The file operations — injected by tests to make a step fail. */
  fsOps?: FsOps;
}

export interface LegacyMigrationResult {
  /** The lines logged for actions taken, in order. */
  actions: string[];
  /** The lines logged for steps that failed, in order. */
  failures: string[];
}

type MigrationStep =
  | { kind: 'move-dir'; area: 'config' | 'data'; from: string; to: string }
  | { kind: 'rename-env-keys'; envFile: string; legacyDir: string };

interface ResolvedOptions {
  homeDir: string;
  env: NodeJS.ProcessEnv;
  log: (line: string) => void;
  warn: (line: string) => void;
  fsOps: FsOps;
}

function resolveOptions(options: LegacyMigrationOptions): ResolvedOptions {
  return {
    homeDir: options.homeDir ?? os.homedir(),
    env: options.env ?? process.env,
    log: options.log ?? ((line) => process.stderr.write(`${line}\n`)),
    warn: options.warn ?? ((line) => process.stderr.write(`${line}\n`)),
    fsOps: options.fsOps ?? fs,
  };
}

type PathKind = 'missing' | 'symlink' | 'directory' | 'other';

function getPathKind(fsOps: FsOps, target: string): PathKind {
  try {
    const stat = fsOps.lstatSync(target);
    if (stat.isSymbolicLink()) return 'symlink';
    return stat.isDirectory() ? 'directory' : 'other';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'other';
  }
}

function describePath(homeDir: string, target: string): string {
  return target.startsWith(`${homeDir}${path.sep}`) ? `~${target.slice(homeDir.length)}` : target;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The pre-rename keys a config file still carries that can be renamed (no `CHARNESS_` twin yet). */
function findRenamableEnvKeys(content: string): string[] {
  const definedKeys = new Set<string>();
  for (const match of content.matchAll(/^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=/gm)) {
    definedKeys.add(match[1]);
  }
  const renamable: string[] = [];
  for (const key of definedKeys) {
    if (!key.startsWith(legacyEnvKeyPrefix) || key.length === legacyEnvKeyPrefix.length) continue;
    if (!definedKeys.has(`${currentEnvKeyPrefix}${key.slice(legacyEnvKeyPrefix.length)}`)) renamable.push(key);
  }
  return renamable;
}

function readEnvFileIfPresent(fsOps: FsOps, filePath: string): string | null {
  try {
    return String(fsOps.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * @description What a migration would do right now, in order. Reads the file
 * system only. An isolated instance (`ENV_FILE`) plans nothing.
 */
function planMigration(options: ResolvedOptions): MigrationStep[] {
  const { homeDir, env, fsOps } = options;
  if (env.ENV_FILE) return [];
  const steps: MigrationStep[] = [];

  const configRoot = path.join(homeDir, '.config');
  const canonicalConfigDir = path.join(configRoot, configDirName);
  const canonicalConfigKind = getPathKind(fsOps, canonicalConfigDir);
  const legacyConfigDirs = legacyConfigDirNames.map((name) => path.join(configRoot, name));
  const movableConfigDir =
    canonicalConfigKind === 'missing'
      ? legacyConfigDirs.find((dir) => getPathKind(fsOps, dir) === 'directory')
      : undefined;
  if (movableConfigDir !== undefined) {
    steps.push({ kind: 'move-dir', area: 'config', from: movableConfigDir, to: canonicalConfigDir });
    steps.push({ kind: 'rename-env-keys', envFile: path.join(canonicalConfigDir, envFileName), legacyDir: movableConfigDir });
  } else if (canonicalConfigKind === 'directory') {
    // A move of an earlier start whose key rename failed: the old path is our symlink to the canonical dir.
    const envFile = path.join(canonicalConfigDir, envFileName);
    const linkedLegacyDir = legacyConfigDirs.find((dir) => isSymlinkTo(fsOps, dir, canonicalConfigDir));
    const content = linkedLegacyDir === undefined ? null : readEnvFileIfPresent(fsOps, envFile);
    if (linkedLegacyDir !== undefined && content !== null && findRenamableEnvKeys(content).length > 0) {
      steps.push({ kind: 'rename-env-keys', envFile, legacyDir: linkedLegacyDir });
    }
  }

  // An explicit DATA_DIR is the operator's, whatever it names.
  if (!env.DATA_DIR) {
    const legacyDataDir = path.join(homeDir, legacyDefaultDataDirName);
    const canonicalDataDir = path.join(homeDir, defaultDataDirName);
    if (getPathKind(fsOps, legacyDataDir) === 'directory' && getPathKind(fsOps, canonicalDataDir) === 'missing') {
      steps.push({ kind: 'move-dir', area: 'data', from: legacyDataDir, to: canonicalDataDir });
    }
  }
  return steps;
}

function isSymlinkTo(fsOps: FsOps, linkPath: string, targetDir: string): boolean {
  if (getPathKind(fsOps, linkPath) !== 'symlink') return false;
  try {
    return fsOps.realpathSync(linkPath) === fsOps.realpathSync(targetDir);
  } catch {
    return false;
  }
}

/**
 * @description Whether a start has anything to migrate — cheap, so the hot
 * supervisor takes the instance lock only when it will use it.
 */
export function hasPendingLegacyMigration(options: LegacyMigrationOptions = {}): boolean {
  return planMigration(resolveOptions(options)).length > 0;
}

/**
 * Rename the dir and leave a relative symlink at the old path. If the symlink
 * cannot be made the move is undone, so the old path never ends up missing.
 */
function moveDirLeavingSymlink(fsOps: FsOps, from: string, to: string, warn: (line: string) => void): void {
  fsOps.renameSync(from, to);
  try {
    fsOps.symlinkSync(path.basename(to), from);
  } catch (symlinkError) {
    try {
      fsOps.renameSync(to, from);
    } catch (rollbackError) {
      warn(
        `[migrate] ${from} was moved to ${to} and the symlink back failed (${describeError(symlinkError)}), ` +
          `and so did undoing the move (${describeError(rollbackError)}): link ${from} to ${to} by hand`,
      );
    }
    throw symlinkError;
  }
}

function findFreeBackupPath(fsOps: FsOps, envFile: string): string {
  const firstChoice = `${envFile}${envBackupSuffix}`;
  return fsOps.existsSync(firstChoice) ? `${firstChoice}.${Date.now()}` : firstChoice;
}

/**
 * Rename `TELEGRAMCODE_*` keys to `CHARNESS_*` in one file, after a backup copy.
 * The file's mode and a symlinked file's link are kept (the real file is
 * rewritten in place by rename). Returns the keys renamed.
 */
function renameEnvFileKeys(fsOps: FsOps, envFile: string): { keys: string[]; backupPath: string } | null {
  let realFile: string;
  try {
    realFile = fsOps.realpathSync(envFile);
  } catch (error) {
    // A config dir without a `.env` has no keys to rename.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const content = String(fsOps.readFileSync(realFile, 'utf8'));
  const keys = findRenamableEnvKeys(content);
  if (keys.length === 0) return null;
  const renamedKeys = new Set(keys);
  const rewritten = content.replace(
    /^([ \t]*(?:export[ \t]+)?)(TELEGRAMCODE_[A-Za-z0-9_]+)(?=[ \t]*=)/gm,
    (whole, prefix: string, key: string) =>
      renamedKeys.has(key) ? `${prefix}${currentEnvKeyPrefix}${key.slice(legacyEnvKeyPrefix.length)}` : whole,
  );
  if (rewritten === content) return null;

  const mode = fsOps.lstatSync(realFile).mode & 0o777;
  const backupPath = findFreeBackupPath(fsOps, realFile);
  fsOps.copyFileSync(realFile, backupPath, fs.constants.COPYFILE_EXCL);
  const tempPath = `${realFile}.tmp-${process.pid}`;
  try {
    fsOps.writeFileSync(tempPath, rewritten, { mode });
    fsOps.chmodSync(tempPath, mode);
    fsOps.renameSync(tempPath, realFile);
  } catch (error) {
    try {
      fsOps.unlinkSync(tempPath);
    } catch {
      // never written
    }
    throw error;
  }
  return { keys, backupPath };
}

/**
 * @description Run the migration. The CALLER holds the instance lock. Safe to
 * call on every cold start: with nothing to do it does nothing and says nothing.
 */
export function migrateLegacyNames(options: LegacyMigrationOptions = {}): LegacyMigrationResult {
  const resolved = resolveOptions(options);
  const { homeDir, fsOps } = resolved;
  const result: LegacyMigrationResult = { actions: [], failures: [] };
  const logAction = (line: string): void => {
    result.actions.push(line);
    resolved.log(line);
  };
  const logFailure = (line: string): void => {
    result.failures.push(line);
    resolved.warn(line);
  };

  const failedMoves = new Set<string>();
  for (const step of planMigration(resolved)) {
    if (step.kind === 'move-dir') {
      const fromLabel = describePath(homeDir, step.from);
      const toLabel = describePath(homeDir, step.to);
      try {
        moveDirLeavingSymlink(fsOps, step.from, step.to, resolved.warn);
        logAction(`[migrate] moved ${fromLabel} to ${toLabel}; ${fromLabel} is now a symlink to it`);
        if (step.area === 'data') redecideDefaultDataDir(homeDir);
      } catch (error) {
        failedMoves.add(step.from);
        logFailure(
          `[migrate] could not move ${fromLabel} to ${toLabel} (${describeError(error)}): it stays where it is and ` +
            `is still used; move it by hand with the bot stopped (see ${renameMigrationDoc})`,
        );
      }
      continue;
    }
    if (failedMoves.has(step.legacyDir)) continue;
    const envLabel = describePath(homeDir, step.envFile);
    try {
      const renamed = renameEnvFileKeys(fsOps, step.envFile);
      if (renamed === null) continue;
      logAction(
        `[migrate] renamed ${renamed.keys.length} key(s) ${legacyEnvKeyPrefix}* to ${currentEnvKeyPrefix}* in ` +
          `${envLabel} (${renamed.keys.join(', ')}); the old file is kept as ${describePath(homeDir, renamed.backupPath)}`,
      );
    } catch (error) {
      logFailure(
        `[migrate] could not rename the ${legacyEnvKeyPrefix}* keys in ${envLabel} (${describeError(error)}): ` +
          `rename them by hand (see ${renameMigrationDoc})`,
      );
    }
  }
  return result;
}

/**
 * @description The hot SUPERVISOR's cold start: take the instance lock for the
 * length of the migration. A lock held by a live instance (or any failure to
 * take it) skips the migration and says why; the next start tries again.
 */
export function migrateLegacyNamesUnderLock(options: LegacyMigrationOptions = {}): LegacyMigrationResult {
  const resolved = resolveOptions(options);
  const empty: LegacyMigrationResult = { actions: [], failures: [] };
  if (!hasPendingLegacyMigration(options)) return empty;
  let lock: ReturnType<typeof tryAcquireLock>;
  try {
    lock = tryAcquireLock();
  } catch (error) {
    const line = `[migrate] skipped: the instance lock could not be taken (${describeError(error)})`;
    resolved.warn(line);
    return { actions: [], failures: [line] };
  }
  if (!lock.ok) {
    const line =
      `[migrate] skipped: another instance holds the lock on this data dir (${lock.reason}); ` +
      `the old names keep working and the next cold start tries again`;
    resolved.warn(line);
    return { actions: [], failures: [line] };
  }
  try {
    return migrateLegacyNames(options);
  } finally {
    releaseLock();
  }
}
