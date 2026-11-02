import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { getCaughtErrnoCode, writeJsonFileAtomically } from '../configDirFile';
import { hubIdSchema } from './hubIds';
import type { HubContext } from './hubPaths';

/**
 * @description The pairing codes that were CLOSED unused (`cancelPairing`) — the trace a closing leaves, so the offering instance can tell
 * a code that was closed because its line was used on a machine that was already paired from one that simply ran out. Without it a retry
 * of a failed service step would turn its Telegram messages into «expired» and make `charness runners pair --wait` fail, although the line
 * did its job. `closed.json` in the registry folder, written under the hub lock by the same transaction that drops the code; an entry is
 * kept {@link closedCodeKeepMs} (as long as an unsettled message is retried) and the list holds at most {@link maxClosedCodes}. A file that
 * cannot be read counts as empty: the messages then read «expired», which is the truth of a code that is gone.
 */

const closedFileName = 'closed.json';
const closedFileMode = 0o600;
/** As long as a pairing message whose edit keeps failing is tried again (`connectors/telegram/commands/runners.ts`). */
export const closedCodeKeepMs = 24 * 60 * 60 * 1000;
const maxClosedCodes = 50;

const closedCodeSchema = z.strictObject({ pairId: hubIdSchema, closedAtMs: z.number().int().nonnegative() });
const closedFileSchema = z.strictObject({ closed: z.array(closedCodeSchema) });

/** @name ClosedCode @description A code that was closed unused, and when. */
export type ClosedCode = z.infer<typeof closedCodeSchema>;

/** @description The closed codes in the registry's `closed.json`; none when the file is missing, and none — said once through the context's log — when it cannot be used. */
export function readClosedCodes(ctx: HubContext): ClosedCode[] {
  let text: string;
  try {
    text = fs.readFileSync(path.join(ctx.dir, closedFileName), 'utf8');
  } catch (error) {
    if (getCaughtErrnoCode(error) !== 'ENOENT') ctx.log(`${closedFileName} could not be read (${getCaughtErrnoCode(error)}); the codes in it read as expired`);
    return [];
  }
  try {
    const parsed = closedFileSchema.safeParse(JSON.parse(text));
    if (!parsed.success) ctx.log(`${closedFileName} is invalid; the codes in it read as expired`);
    return parsed.success ? parsed.data.closed : [];
  } catch {
    ctx.log(`${closedFileName} is not valid JSON; the codes in it read as expired`);
    return [];
  }
}

/** @description Note that `pairId` was closed at `nowMs`; entries older than {@link closedCodeKeepMs} and all but the newest {@link maxClosedCodes} go. Call under the hub lock. */
export function recordClosedCode(ctx: HubContext, pairId: string, nowMs: number): void {
  const kept = readClosedCodes(ctx).filter((entry) => entry.pairId !== pairId && nowMs - entry.closedAtMs < closedCodeKeepMs);
  writeJsonFileAtomically(path.join(ctx.dir, closedFileName), { closed: [...kept, { pairId, closedAtMs: nowMs }].slice(-maxClosedCodes) }, closedFileMode);
}
