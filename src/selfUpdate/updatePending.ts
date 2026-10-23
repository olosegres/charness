import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { writeJsonFileAtomically } from '../configDirFile';
import { maxUnconfirmedBoots } from './constants';

/**
 * `DATA_DIR/update-pending.json` — written BEFORE the switch to a new version, and the one thing the next boot needs to know
 * about it. Each boot of an unconfirmed version counts itself in; a version that cannot boot `maxUnconfirmedBoots` times in a
 * row (a supervisor keeps restarting it) is rolled back by the boot itself, before it imports the bot. A version that stays up
 * is confirmed by the running bot, which deletes the marker. A rolled-back marker is kept for the restored version to report.
 */

export const updatePendingFileName = 'update-pending.json';
const markerFileMode = 0o600;

const versionPointSchema = z.object({ version: z.string(), commit: z.string().nullable() });

const markerSchema = z.object({
  kind: z.enum(['npm', 'git']),
  /** `pending`: the new version is booting / unconfirmed; `rolledBack`: it did not start and the old one is back; `rollbackFailed`: it did not start and going back failed too. */
  status: z.enum(['pending', 'rolledBack', 'rollbackFailed']),
  from: versionPointSchema,
  to: versionPointSchema,
  /** How many boots of the new version have started without being confirmed. */
  attempts: z.number().int().nonnegative(),
  isUserRequested: z.boolean(),
  failureReason: z.string().optional(),
});

export type UpdatePendingMarker = z.infer<typeof markerSchema>;
export type VersionPoint = z.infer<typeof versionPointSchema>;

export function getUpdatePendingPath(dataDir: string): string {
  return path.join(dataDir, updatePendingFileName);
}

/** @description The marker; `null` when there is none or it is unreadable (never a reason to refuse to boot). */
export function readUpdatePending(dataDir: string): UpdatePendingMarker | null {
  try {
    const parsed = markerSchema.safeParse(JSON.parse(fs.readFileSync(getUpdatePendingPath(dataDir), 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function writeUpdatePending(dataDir: string, marker: UpdatePendingMarker): void {
  writeJsonFileAtomically(getUpdatePendingPath(dataDir), marker, markerFileMode);
}

export function clearUpdatePending(dataDir: string): void {
  fs.rmSync(getUpdatePendingPath(dataDir), { force: true });
}

/** @description A marker for a switch about to happen: no boot of the new version has started. */
export function createPendingMarker(options: { kind: 'npm' | 'git'; from: VersionPoint; to: VersionPoint; isUserRequested: boolean }): UpdatePendingMarker {
  return { ...options, status: 'pending', attempts: 0 };
}

export type BootAction = { action: 'proceed'; marker: UpdatePendingMarker | null } | { action: 'rollback'; marker: UpdatePendingMarker };

/**
 * @description What this boot does about the marker: nothing without one or once it is settled; otherwise count itself in
 * and go on — unless the new version has already started and not been confirmed `limit` times, which is a version that does
 * not boot: roll back.
 */
export function decideBootAction(marker: UpdatePendingMarker | null, limit: number = maxUnconfirmedBoots): BootAction {
  if (marker === null || marker.status !== 'pending') return { action: 'proceed', marker };
  if (marker.attempts >= limit) return { action: 'rollback', marker };
  return { action: 'proceed', marker: { ...marker, attempts: marker.attempts + 1 } };
}

export interface BootRollbackDeps {
  dataDir: string;
  /** Put the previous version back (npm: reinstall it; checkout: reset and rebuild). Throws when it cannot. */
  rollback: (marker: UpdatePendingMarker) => Promise<void>;
  log: (line: string) => void;
}

export type BootOutcome = 'proceed' | 'rolledBack' | 'rollbackFailed';

/**
 * @description The boot-time check, run BEFORE the bot module is imported (a broken new bot must not be able to stop it from
 * counting). `rolledBack`: the old version is back — the caller restarts onto it; `rollbackFailed`: it could not be put back,
 * boot on and let the bot say so.
 */
export async function runBootUpdateCheck(deps: BootRollbackDeps): Promise<BootOutcome> {
  const decision = decideBootAction(readUpdatePending(deps.dataDir));
  if (decision.action === 'proceed') {
    if (decision.marker?.status === 'pending') writeUpdatePending(deps.dataDir, decision.marker);
    return 'proceed';
  }
  const { marker } = decision;
  deps.log(`[update] ${marker.to.version} did not start ${marker.attempts} times — going back to ${marker.from.version}`);
  const reason = `the new version did not start (${marker.attempts} boots without confirmation)`;
  try {
    await deps.rollback(marker);
    writeUpdatePending(deps.dataDir, { ...marker, status: 'rolledBack', failureReason: reason });
    return 'rolledBack';
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    deps.log(`[update] going back failed: ${detail}`);
    writeUpdatePending(deps.dataDir, { ...marker, status: 'rollbackFailed', failureReason: `${reason}; going back failed: ${detail}` });
    return 'rollbackFailed';
  }
}
