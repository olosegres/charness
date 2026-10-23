import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { writeJsonFileAtomically } from '../configDirFile';

/**
 * The hot supervisor (`charness hot`: `tsc -w` + nodemon) reloads only its WORKER on an update. When a file the SUPERVISOR
 * itself loaded changed, the supervisor must be replaced too: it re-executes itself on `SIGUSR2` — same pid, so a Docker
 * entrypoint `wait`ing on it, `charness-restart-bot` and systemd see nothing. This module is the contract between the two:
 * the supervisor records what it loaded and who it is, the worker compares the record with `dist/` and, at an idle point,
 * signals exactly that supervisor — never a pid that has been reused.
 */

export const hotSupervisorRecordFileName = 'hot-supervisor.json';
const recordFileMode = 0o600;
const sha256Algorithm = 'sha256';
/** Sent by a worker to its supervisor: re-execute yourself. */
export const supervisorReexecSignal: NodeJS.Signals = 'SIGUSR2';

const recordSchema = z.object({
  pid: z.number().int().positive(),
  startToken: z.string().min(1),
  canReexec: z.boolean(),
  modules: z.array(z.object({ path: z.string(), sha256: z.string() })),
});

/** What a supervisor says about itself: its identity, whether it can re-execute, and the hash of every `dist/` module it loaded. */
export type HotSupervisorRecord = z.infer<typeof recordSchema>;

export function getHotSupervisorRecordPath(dataDir: string): string {
  return path.join(dataDir, hotSupervisorRecordFileName);
}

export function hashFile(filePath: string): string {
  return crypto.createHash(sha256Algorithm).update(fs.readFileSync(filePath)).digest('hex');
}

/**
 * @description The modules a process loaded from `<root>/dist`, as paths relative to `dist/` with the hash of the file on
 * disk. Called at the START of the supervisor, before its watcher rebuilds anything, so the hash is the loaded code's.
 */
export function collectLoadedDistModules(distDirectory: string, loadedModulePaths: readonly string[]): HotSupervisorRecord['modules'] {
  const prefix = `${distDirectory}${path.sep}`;
  return loadedModulePaths
    .filter((modulePath) => modulePath.startsWith(prefix) && modulePath.endsWith('.js'))
    .map((modulePath) => ({ path: path.relative(distDirectory, modulePath).split(path.sep).join('/'), sha256: hashFile(modulePath) }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

export function writeHotSupervisorRecord(dataDir: string, record: HotSupervisorRecord): void {
  writeJsonFileAtomically(getHotSupervisorRecordPath(dataDir), record, recordFileMode);
}

/** @description The supervisor's record; `null` when there is none (a supervisor that predates re-exec) or it is unreadable. */
export function readHotSupervisorRecord(dataDir: string): HotSupervisorRecord | null {
  try {
    const parsed = recordSchema.safeParse(JSON.parse(fs.readFileSync(getHotSupervisorRecordPath(dataDir), 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** @description The recorded modules whose file on disk now differs, or is gone: the supervisor runs code that is no longer there. */
export function getStaleSupervisorModules(record: HotSupervisorRecord, distDirectory: string): string[] {
  return record.modules
    .filter((module) => {
      try {
        return hashFile(path.join(distDirectory, module.path)) !== module.sha256;
      } catch {
        return true;
      }
    })
    .map((module) => module.path);
}

export interface SupervisorSignalDeps {
  /** The start token of the process with this pid now; `null` when no such process exists. */
  getStartToken: (pid: number) => string | null;
  kill: (pid: number, signal: NodeJS.Signals) => void;
}

export type SupervisorSignalResult = 'signaled' | 'gone' | 'differentProcess' | 'cannotReexec';

/**
 * @description Ask the supervisor named by `record` to re-execute — only when that pid is still the SAME process (its start
 * token matches) and the record says it can. A reused pid is a stranger's process: it gets nothing.
 */
export function requestSupervisorReexec(record: HotSupervisorRecord, deps: SupervisorSignalDeps): SupervisorSignalResult {
  if (!record.canReexec) return 'cannotReexec';
  const startToken = deps.getStartToken(record.pid);
  if (startToken === null) return 'gone';
  if (startToken !== record.startToken) return 'differentProcess';
  deps.kill(record.pid, supervisorReexecSignal);
  return 'signaled';
}
