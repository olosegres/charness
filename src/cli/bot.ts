import * as fs from 'fs';
import * as path from 'path';
import { loadEnvWithConnectorGuards } from './connectorGuards';
import { acquireLock, installLockCleanupHandlers, releaseLock } from '../instanceLock';
import { resolveDataDir } from '../state';
import { installConsoleFileTap } from '../utils/consoleFileTap';
import { warnLegacyNamesAtBoot } from '../legacyNames';
import { migrateLegacyNames } from '../legacyMigration';
import { createBootRollback } from '../selfUpdate/bootRollback';
import { getLaunchEnvironment } from '../selfUpdate/launchEnvironment';
import { createDefaultReexecDeps, getReexecTarget, reexecProcess } from '../selfUpdate/restart';
import { runBootUpdateCheck } from '../selfUpdate/updatePending';

/**
 * @description Shared bot startup used by the public no-arg CLI and the
 * internal hot-worker entry.
 *
 * Responsibilities executed in order:
 *
 *   1. Load `.env` files (global, then local override — or ONLY `ENV_FILE`)
 *      between the connector guards, which exit on a breach. Must happen BEFORE
 *      the bot module is imported, because `src/bot.ts` reads many
 *      `process.env.*` values at top-level (TELEGRAM_BOT_TOKEN, WORK_ROOT,
 *      ALLOWED_GROUP_ID, etc.).
 *   2. Default `WORK_ROOT` to `process.cwd()` if still unset. This is the
 *      normal path: start `charness` from the parent folder containing
 *      the projects/topics you want to bind.
 *   3. Validate `WORK_ROOT` resolves to an existing directory — fail fast
 *      with a clear message if not.
 *   4. Acquire the single-instance lock and wire cleanup handlers.
 *   5. Count this boot against a pending update (`update-pending.json`): a new version that has failed to start twice
 *      is rolled back here — before the bot module can break the boot — and the process restarts onto the old one.
 *      After the lock, never before: a start that loses the lock is not a boot, and counting it would let two stray
 *      starts roll a healthy running version back from underneath it.
 *   6. Dynamically import `../bot` (which reads env at module scope) and
 *      call `startBot()`.
 *
 * The dynamic import in step 6 is deliberate: a static `import` at the top
 * of this file would resolve `process.env` at module-load time, before
 * the env load ran, and we'd see undefined tokens. `await import(...)`
 * defers binding until after env is populated.
 */
export async function runBot(options: { isHotWorker?: boolean } = {}): Promise<void> {
  // The connector guards wrap the env load: a breach exits here, before the
  // console tee, the lock or the bot module can do anything (Jira plan J3).
  const { loaded } = loadEnvWithConnectorGuards();

  // Tee stdout/stderr to an hourly bucket file under DATA_DIR as EARLY as
  // possible (right after env load, so DATA_DIR from .env is honoured) — boot
  // logs below this line are captured for post-incident reading, terminal view
  // preserved. Best-effort; never throws into a write.
  installConsoleFileTap(resolveDataDir());

  if (loaded.length === 0) {
    process.stderr.write(
      `Warning: no .env file found in $PWD or ~/.config/charness/. ` +
        `Required env (TELEGRAM_BOT_TOKEN) ` +
        `must come from the shell instead. ALLOWED_GROUP_ID is optional ` +
        `(auto-pairs on first contact if unset; access = the group's admins).\n`,
    );
  }

  if (!process.env.WORK_ROOT) {
    process.env.WORK_ROOT = process.cwd();
    process.stderr.write(
      `Using $PWD as WORK_ROOT: ${process.env.WORK_ROOT}\n`,
    );
  }
  const wr = process.env.WORK_ROOT;
  if (!fs.existsSync(wr) || !fs.statSync(wr).isDirectory()) {
    process.stderr.write(
      `WORK_ROOT does not exist or is not a directory: ${wr}\n`,
    );
    process.exit(1);
  }

  await acquireLock();
  installLockCleanupHandlers();

  await handleUpdateRollbackAtBoot(options.isHotWorker === true);

  // The pre-rename config / data dirs and keys move to the Charness names here: a COLD start, under the
  // lock, before the bot module (and its state) loads. A hot worker's reload never migrates. What it
  // could not move is announced next, once — after the tee, so the lines reach the bot log.
  if (!options.isHotWorker) migrateLegacyNames();
  warnLegacyNamesAtBoot();

  // Lazy import so env is fully populated before the bot module's top-level
  // `process.env.*` reads run. See file-level docstring for rationale.
  const { startBot } = await import('../bot');
  await startBot();
}

/**
 * @description The boot-time half of a safe update: a version that cannot start is put back by the process that failed to
 * start it, holding the instance lock. A plain process then releases the lock and restarts onto the restored install
 * (`process.execve` keeps the pid, and the new image takes the lock afresh); a hot worker exits cleanly instead (the exit
 * handler releases the lock), and its watcher rebuilds the reset checkout and starts a new worker.
 */
async function handleUpdateRollbackAtBoot(isHotWorker: boolean): Promise<void> {
  const packageRoot = path.resolve(__dirname, '..', '..');
  const outcome = await runBootUpdateCheck({
    dataDir: resolveDataDir(),
    rollback: createBootRollback({ packageRoot, execPath: process.execPath, platform: process.platform, hasExecve: typeof process.execve === 'function', isHotWorker }),
    log: (line) => console.error(line),
  });
  if (outcome !== 'rolledBack') return;
  if (isHotWorker) {
    process.exit(0);
    return;
  }
  releaseLock();
  reexecProcess(getReexecTarget({ execPath: process.execPath, packageRoot, argv: process.argv }), getLaunchEnvironment(), createDefaultReexecDeps());
}
