import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { addEnvFileVariableNames } from '../utils/agentEnvironment';
import { resolveGlobalConfigEnvPath } from '../legacyNames';

/**
 * @description Path to the per-user global config file.
 *
 * Prefers the canonical `~/.config/charness/.env`; falls back to the first
 * existing of the earlier releases' `~/.config/telegramcode/.env` and
 * `~/.config/telegram-code/.env` (the names live in `legacyNames.ts`, which also
 * announces the fallback at boot). When none exists the canonical path is
 * returned, so callers report the location a fresh install should use.
 *
 * Resolved lazily per call — tests may swap `HOME` between cases.
 */
export function globalEnvPath(): string {
  return resolveGlobalConfigEnvPath();
}

/** @description Path to the local `.env` for a supplied directory (defaults to `$PWD`). */
export function localEnvPath(localDirectory = process.cwd()): string {
  return path.join(localDirectory, '.env');
}

/**
 * @description Load environment from the wrapper's two well-known locations.
 *
 * Order is **global first, local second** so that `dotenv.config({ override: true })`
 * on the local file gives `<localDirectory>/.env` last-write-wins semantics over
 * the global. Both files are optional; if neither exists this is a no-op. The
 * explicit directory lets a supervisor load its worker's project config without
 * changing the operator-facing process cwd.
 *
 * The first load uses `override: false` so that variables already in
 * `process.env` (set by the user's shell, systemd, etc.) win against the
 * global file — matching how `dotenv/config` behaves today. The local file
 * then forces an override only for keys it explicitly sets.
 *
 * Returns the list of paths actually read, in load order. Useful for the
 * `charness` startup banner and for test assertions.
 */
export function loadEnvFiles(localDirectory = process.cwd()): { loaded: string[] } {
  // An isolated instance (Jira connector plan J3, D7): ONLY its own file — no
  // global config, no legacy config, no `$PWD/.env`, which may hold another
  // bot's token. It wins over the inherited environment.
  const envFile = process.env.ENV_FILE;
  if (envFile !== undefined) {
    if (!path.isAbsolute(envFile)) throw new Error(`ENV_FILE must be an absolute path (got "${envFile}")`);
    if (!fs.existsSync(envFile)) throw new Error(`ENV_FILE does not exist: ${envFile}`);
    if (!fs.statSync(envFile).isFile()) throw new Error(`ENV_FILE is not a regular file: ${envFile}`);
    // dotenv REPORTS a read failure instead of throwing; ignoring it would start
    // the instance on the inherited environment with nothing loaded.
    const { error, parsed } = dotenv.config({ path: envFile, override: true });
    if (error) throw new Error(`ENV_FILE could not be read: ${envFile} (${error.message})`);
    // R32: what the instance file set never reaches a tracker conversation's agent.
    addEnvFileVariableNames(Object.keys(parsed ?? {}));
    return { loaded: [envFile] };
  }

  const loaded: string[] = [];

  const globalPath = globalEnvPath();
  if (fs.existsSync(globalPath)) {
    dotenv.config({ path: globalPath, override: false });
    loaded.push(globalPath);
  }

  const localPath = localEnvPath(localDirectory);
  if (fs.existsSync(localPath)) {
    dotenv.config({ path: localPath, override: true });
    loaded.push(localPath);
  }

  return { loaded };
}
