import { z } from 'zod';

/**
 * @description Where a runner's link comes from, and when that is worth telling the operator. The gate that holds a link learns the address of the
 * connection from sshd (`SSH_CLIENT`) and records it in the link's status file. A runner is ONE machine, so its link should keep coming from the same
 * place (an address may change when the machine moves between networks, but not back and forth every few minutes); and «newest link wins» (`gateLink.ts`)
 * means that a second connection with the runner's key silently takes the first one's place. The audit that asked for this: a job on the machine can
 * read the runner's key, and whoever holds it can pretend to be that machine from anywhere, receive the project code the agents send to it and
 * answer with made-up results. Two things are worth saying:
 *
 *   - the SOURCE CHANGED: the link now comes from another address than the link before it (and whether it took the place of one that was still up);
 *   - a FIGHT: several such changes within minutes — two links, two addresses, each replacing the other (the runner reconnects by itself).
 *
 * It tells nothing when both machines share an address (one network behind one NAT shows one source), and only that the address changed when the
 * machine itself moved: the note says what was seen and leaves the judgement to the operator. Pure, so `runners ls` and the Telegram screen word it
 * from the same facts.
 */

/** Longest address recorded: an IPv6 address with its zone is 45 characters or a little more. */
export const maxSourceLength = 64;
/** How many changes a link's status file remembers. */
export const maxRecordedSourceChanges = 5;
/** How long after a change the operator is told about it. */
export const sourceChangeNoticeWindowMs = 24 * 60 * 60 * 1000;
/** Changes within this many minutes... */
export const linkFightWindowMs = 10 * 60 * 1000;
/** ...of at least this many are a fight, not a move. */
export const linkFightChangeCount = 3;
const fightSourcesNamed = 3;
/** The first word of `SSH_CLIENT` (`<address> <client port> <server port>`): an IPv4 or IPv6 address, nothing else. */
const sshClientAddressPattern = /^([0-9A-Fa-f:.]{2,45})(?: \d+ \d+)?$/;

export const linkSourceChangeSchema = z.strictObject({
  /** The address the link before this one came from. */
  fromSource: z.string().max(maxSourceLength),
  toSource: z.string().max(maxSourceLength),
  atMs: z.number().int().nonnegative(),
  /** The link before it was still up (its heartbeat was recent) when the new one took its place. */
  isLiveReplacement: z.boolean(),
});

export type LinkSourceChange = z.infer<typeof linkSourceChangeSchema>;

/** @name LinkConcern @description What the operator is told about a runner's link. */
export type LinkConcern =
  | { kind: 'sourceChanged'; fromSource: string; toSource: string; atMs: number; isLiveReplacement: boolean }
  | { kind: 'fighting'; sources: string[]; changeCount: number };

/** @description The address in sshd's `SSH_CLIENT` (`203.0.113.7 51820 22`); `null` when it is absent or not an address — nothing else is ever recorded. */
export function parseSshClientSource(sshClient: string | undefined): string | null {
  const match = sshClient === undefined ? null : sshClientAddressPattern.exec(sshClient.trim());
  return match === null ? null : match[1];
}

/** What a gate that starts knows of the link before it. */
export interface PreviousLinkRecord {
  source: string | null;
  sourceChanges: readonly LinkSourceChange[];
}

/**
 * @description The source and the changes a new link writes: `previous` was the link before it, `isPreviousLive` whether it was still up when this one
 * took its place. A link with no known source (no `SSH_CLIENT`, an older status file) never counts as a change.
 */
export function recordLinkSource(previous: PreviousLinkRecord | null, source: string | null, nowMs: number, isPreviousLive: boolean): { source: string | null; sourceChanges: LinkSourceChange[] } {
  const earlier = previous?.sourceChanges ?? [];
  const changed = previous?.source != null && source !== null && previous.source !== source;
  const sourceChanges = changed ? [...earlier, { fromSource: previous.source ?? '', toSource: source, atMs: nowMs, isLiveReplacement: isPreviousLive }] : [...earlier];
  return { source, sourceChanges: sourceChanges.slice(-maxRecordedSourceChanges) };
}

/** @description What is worth telling about a link whose recorded changes are `sourceChanges`, at `nowMs`; `null` when nothing is. A fight says more than the change in it. */
export function getLinkConcern(sourceChanges: readonly LinkSourceChange[] | undefined, nowMs: number): LinkConcern | null {
  const recent = (sourceChanges ?? []).filter((change) => nowMs - change.atMs < sourceChangeNoticeWindowMs);
  const latest = recent.at(-1);
  if (latest === undefined) return null;
  const burst = recent.filter((change) => nowMs - change.atMs < linkFightWindowMs);
  if (burst.length >= linkFightChangeCount) {
    const sources = [...new Set(burst.flatMap((change) => [change.fromSource, change.toSource]))].slice(0, fightSourcesNamed);
    return { kind: 'fighting', sources, changeCount: burst.length };
  }
  return { kind: 'sourceChanged', fromSource: latest.fromSource, toSource: latest.toSource, atMs: latest.atMs, isLiveReplacement: latest.isLiveReplacement };
}

/** @description The note of `charness runners ls` for a concern (English, plain text); `formatTime` words an instant. */
export function formatLinkConcernNote(concern: LinkConcern, formatTime: (epochMs: number) => string): string {
  if (concern.kind === 'fighting') return `(links from ${concern.sources.join(', ')} keep replacing each other: ${concern.changeCount} switches in 10 minutes — two machines may be using this runner's key; remove it and pair it again if that is not intended)`;
  const replaced = concern.isLiveReplacement ? `, taking the place of a link that was still up — if that is not a change of network of yours, remove this runner and pair it again: its key may be in use elsewhere` : '';
  return `(its link now comes from ${concern.toSource}, before from ${concern.fromSource}, ${formatTime(concern.atMs)}${replaced})`;
}
