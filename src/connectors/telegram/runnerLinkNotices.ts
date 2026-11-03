import * as fs from 'fs';
import { z } from 'zod';
import { getCaughtErrnoCode, writeJsonFileAtomically } from '../../configDirFile';
import { hubIdSchema } from '../../runners/hubIds';
import { linkFightWindowMs, type LinkConcern } from '../../runners/linkConcern';

/**
 * @description What this INSTANCE has already told the operator about where a runner's link comes from (`DATA_DIR/runner-link-notices.json`). A
 * link that comes from another address than it did — or links that keep replacing each other — is posted ONCE in General and pinned (the operator runs
 * every topic muted, and a pin is what pierces a muted topic); this record is what keeps a look five seconds later, or a restart, from posting it
 * again. A concern is told apart by `changeAtMs`, the time of the newest change it is about: only a NEWER change is news — and not one that falls within a
 * fight's window of a fight already told, because those are the same fight. The record is the instance's own, like the pairing messages: the hub's
 * link files are shared by every charness of the OS user, and each instance tells its own operator. A runner that left the registry leaves the record.
 */

const fileMode = 0o600;

const linkNoticeSchema = z.strictObject({
  runnerId: hubIdSchema,
  /** The time of the newest change the told concern was about. */
  changeAtMs: z.number().int().nonnegative(),
  /** The told concern was a fight. */
  isFight: z.boolean(),
});

const linkNoticesFileSchema = z.strictObject({ notices: z.array(linkNoticeSchema) });

/** @name LinkNotice @description What was told about one runner's link last. */
export type LinkNotice = z.infer<typeof linkNoticeSchema>;

export interface LinkNoticesRead {
  notices: LinkNotice[];
  /** Why the file could not be used (it reads as empty and the next write replaces it); `null` when it was fine or missing. */
  problem: string | null;
}

/** @description The record in `filePath`. A missing file is none; one that is not valid reads as none and says why (the next write replaces it). */
export function readLinkNotices(filePath: string): LinkNoticesRead {
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    return { notices: [], problem: getCaughtErrnoCode(error) === 'ENOENT' ? null : `${filePath} could not be read` };
  }
  try {
    const parsed = linkNoticesFileSchema.safeParse(JSON.parse(text));
    return parsed.success ? { notices: parsed.data.notices, problem: null } : { notices: [], problem: `${filePath} is invalid` };
  } catch {
    return { notices: [], problem: `${filePath} is not valid JSON` };
  }
}

/** @description Write the record, through a temp file and a rename. */
export function writeLinkNotices(filePath: string, notices: readonly LinkNotice[]): void {
  writeJsonFileAtomically(filePath, { notices }, fileMode);
}

/** @description What `concern` becomes in the record once it has been told. */
export function createLinkNotice(runnerId: string, concern: LinkConcern): LinkNotice {
  return { runnerId, changeAtMs: concern.atMs, isFight: concern.kind === 'fighting' };
}

/** @description Is `concern` news, given what was told of the runner last (`announced`; `undefined` = nothing yet)? A newer change is — unless it belongs to a fight already told. */
export function checkIsNewConcern(concern: LinkConcern, announced: LinkNotice | undefined): boolean {
  if (announced === undefined) return true;
  if (concern.atMs <= announced.changeAtMs) return false;
  return !(announced.isFight && concern.atMs - announced.changeAtMs < linkFightWindowMs);
}
