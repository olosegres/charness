import { createHash, randomBytes } from 'crypto';
import * as path from 'path';

/**
 * @description Job ids and project slugs.
 *
 * A job id is `<runner>-<6 base32>`, made on the main box and stored on the runner as the Pueue label `rr-<id>` (Pueue's own ids
 * restart after a reset, so they never name a job). The project slug names the runner-side copy of a project:
 * `<basename>-<10 hex of sha256(hostname:uid:absolute root)>` — two main-box users or two checkouts of one project never share a copy.
 * The project KEY says which copies are of one REPOSITORY (any folder name, any worktree) of one main-box user: `<hash of owner and the repository's root commit>`.
 */

const base32Alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
const jobSuffixLength = 6;
const slugHashLength = 10;
const slugBasenameMaxLength = 40;
const projectKeyHashLength = 32;
const bitsPerBase32Digit = 5;
const bitMask = 0b11111;
const bytesPerSuffix = 4;

export const pueueLabelPrefix = 'rr-';

const jobIdPattern = /^([a-z0-9]+(?:-[a-z0-9]+)*)-([a-z2-7]{6})$/;

/** @description A fresh id for a job that goes to `runnerName`. `random` is injectable for the tests. */
export function createJobId(runnerName: string, random: (size: number) => Buffer = randomBytes): string {
  const bytes = random(bytesPerSuffix);
  let value = bytes.readUInt32BE(0);
  let suffix = '';
  for (let digit = 0; digit < jobSuffixLength; digit += 1) {
    suffix += base32Alphabet[value & bitMask];
    value = Math.floor(value / 2 ** bitsPerBase32Digit);
  }
  return `${runnerName}-${suffix}`;
}

/** @description The runner name inside a job id, or `null` when `text` is not a job id. */
export function parseJobId(text: string): { runnerName: string } | null {
  const match = jobIdPattern.exec(text);
  return match === null ? null : { runnerName: match[1] };
}

/** @description The Pueue label that ties a Pueue task to its job. */
export function getJobLabel(jobId: string): string {
  return `${pueueLabelPrefix}${jobId}`;
}

/** @description The runner-side folder name of the project at `projectRoot` for this main-box user. */
export function getProjectSlug(projectRoot: string, owner: { hostname: string; uid: number }): string {
  const baseName = path.basename(projectRoot).replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_').slice(0, slugBasenameMaxLength) || 'project';
  const hash = createHash('sha256').update(`${owner.hostname}:${owner.uid}:${projectRoot}`).digest('hex').slice(0, slugHashLength);
  return `${baseName}-${hash}`;
}

/**
 * @description What the runner matches copies on when it seeds a new copy from another (`runner.sh`, «seeding a new copy»): the repository (its first root commit, the same in every clone and worktree whatever the
 * folder is called) of this main-box user (`owner` = `hostname:uid`, as the job's `owner` has it), so a folder that merely shares a name with another project's, or another user's checkout, is never a source.
 */
export function getProjectKey(owner: string, rootCommit: string): string {
  return createHash('sha256').update(`${owner}\0${rootCommit}`).digest('hex').slice(0, projectKeyHashLength);
}
