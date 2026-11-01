import * as os from 'os';
import { loadRunnersConfigAt } from '../remoteRun/runnersConfig';
import type { RedeemReply, RedeemRequest } from './gateProtocol';
import { getHandMadeRunnersPath, type HubContext } from './hubPaths';
import { withHubLock } from './hubLock';
import { readOrCreateHubKeyLocked } from './hubKey';
import {
  readPairedFile,
  readPendingFile,
  syncDerivedHubFiles,
  writePairedFile,
  writePendingFile,
  type PairedRunner,
  type PendingFile,
  type PendingPairing,
} from './hubRegistry';
import { encodePairCode, type PairCodePayload } from './pairCode';
import { createRandomId, generateEd25519KeyPair, getPublicKeyFingerprint } from './sshKeys';

/**
 * @description The registry's operations — each one a single critical section under the registry lock that reads the two files,
 * changes them and rewrites everything derived from them (`known_hosts`, the `authorized_keys` block). The pairing code is single use
 * because `redeem` deletes its pending entry (and with it the temporary key's line) inside that section; a second `redeem` of the
 * same code, concurrent or later, finds nothing.
 */

const msPerMinute = 60 * 1000;
/** How long a pairing code works. */
export const pairingLifetimeMinutes = 10;
export const pairingLifetimeMs = pairingLifetimeMinutes * msPerMinute;
const maxRunnerNameLength = 24;
const fallbackRunnerName = 'runner';

export interface CreatePairingParams {
  /** The address the runner dials, and the hub's ssh host key found there. */
  host: string;
  port: number;
  hostKey: string;
  /** Whose charness it is, as the runner shows it. */
  label: string;
  /** What the offering instance wants to find again when the code is used or expires; the CLI sets none. */
  messageRef?: string | null;
  nowMs: number;
  /** The account the runner logs in as (default: the account this process runs as). */
  sshUser?: string;
}

export interface CreatedPairing {
  pairId: string;
  expiresAtMs: number;
  /** The secret to hand to the runner machine. */
  code: string;
  payload: PairCodePayload;
}

function removeExpired(pending: PendingFile, nowMs: number): { kept: PendingFile; expired: PendingPairing[] } {
  const expired = pending.pending.filter((pairing) => pairing.expiresAtMs <= nowMs);
  return { kept: { pending: pending.pending.filter((pairing) => pairing.expiresAtMs > nowMs) }, expired };
}

/** @description Make a pairing code: a temporary key good for 10 minutes, its line in `authorized_keys`, its entry in `pending.json`. */
export async function createPairing(ctx: HubContext, params: CreatePairingParams): Promise<CreatedPairing> {
  return withHubLock(ctx.dir, () => {
    const paired = readPairedFile(ctx.dir);
    const pairId = createRandomId();
    const expiresAtMs = params.nowMs + pairingLifetimeMs;
    const temporaryKey = generateEd25519KeyPair(`charness-pairing-${pairId}`);
    const pairing: PendingPairing = {
      pairId,
      publicKey: temporaryKey.publicKey,
      keyFingerprint: getPublicKeyFingerprint(temporaryKey.publicKey),
      expiresAtMs,
      host: params.host,
      port: params.port,
      label: params.label,
      messageRef: params.messageRef ?? null,
    };
    // Codes that expired stay listed until `sweepExpiredPairings` hands them back: the instance that offered one still has a message to edit.
    const pending: PendingFile = { pending: [...readPendingFile(ctx.dir).pending, pairing] };
    writePendingFile(ctx.dir, pending);
    syncDerivedHubFiles(ctx, pending, paired, params.nowMs);
    const payload: PairCodePayload = {
      host: params.host,
      port: params.port,
      user: params.sshUser ?? os.userInfo().username,
      hostKey: params.hostKey,
      privateKey: temporaryKey.privateKey,
      pairId,
    };
    return { pairId, expiresAtMs, code: encodePairCode(payload), payload };
  });
}

/** @description Is the pairing code `pairId` still open (made, not used, not expired)? The gate asks before it sends the package. */
export function checkIsPairingOpen(ctx: HubContext, pairId: string, nowMs: number): boolean {
  return readPendingFile(ctx.dir).pending.some((pairing) => pairing.pairId === pairId && pairing.expiresAtMs > nowMs);
}

/**
 * @description Forget the pairing codes that have expired (their lines are gone from `authorized_keys` too) and return them, so the
 * offering instance can edit its messages. Run at boot, on a timer and by the CLI; sshd already refuses an expired key by itself.
 */
export async function sweepExpiredPairings(ctx: HubContext, nowMs: number): Promise<PendingPairing[]> {
  return withHubLock(ctx.dir, () => {
    const { kept, expired } = removeExpired(readPendingFile(ctx.dir), nowMs);
    if (expired.length === 0) return [];
    writePendingFile(ctx.dir, kept);
    syncDerivedHubFiles(ctx, kept, readPairedFile(ctx.dir), nowMs);
    return expired;
  });
}

/** @description What a runner may call itself: lowercase letters and digits with single dashes, short, never empty. */
export function sanitizeRunnerName(suggestedName: string): string {
  const cleaned = suggestedName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxRunnerNameLength)
    .replace(/-+$/g, '');
  return cleaned === '' ? fallbackRunnerName : cleaned;
}

/** @description `name`, or `name-2`, `name-3`, … — the first that no paired or hand-made runner has. */
export function pickFreeRunnerName(suggestedName: string, takenNames: ReadonlySet<string>): string {
  const base = sanitizeRunnerName(suggestedName);
  if (!takenNames.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!takenNames.has(candidate)) return candidate;
  }
}

function getTakenRunnerNames(ctx: HubContext, paired: readonly PairedRunner[]): Set<string> {
  const handMade = loadRunnersConfigAt(getHandMadeRunnersPath(ctx.dir)).config?.runners ?? [];
  return new Set([...paired.map((runner) => runner.name), ...handMade.map((runner) => runner.name)]);
}

/**
 * @description Use the pairing code `pairId`: the runner's keys become a paired runner and the code is spent. A code that is unknown,
 * used or expired, and a key that is already registered, are refused with the reason (no values) and change nothing.
 */
export async function redeemPairing(ctx: HubContext, pairId: string, request: RedeemRequest, nowMs: number): Promise<RedeemReply> {
  return withHubLock(ctx.dir, () => {
    const paired = readPairedFile(ctx.dir);
    const pending = readPendingFile(ctx.dir);
    const pairing = pending.pending.find((candidate) => candidate.pairId === pairId);
    if (pairing === undefined) return { ok: false, reason: 'this pairing code is unknown or already used' };
    if (pairing.expiresAtMs <= nowMs) return { ok: false, reason: 'this pairing code has expired' };
    if (paired.runners.some((runner) => runner.publicKey === request.publicKey)) return { ok: false, reason: 'this machine is already paired' };
    const hubKey = readOrCreateHubKeyLocked(ctx.dir);
    const runner: PairedRunner = {
      id: createRandomId(),
      name: pickFreeRunnerName(request.suggestedName, getTakenRunnerNames(ctx, paired.runners)),
      publicKey: request.publicKey,
      keyFingerprint: getPublicKeyFingerprint(request.publicKey),
      hostKey: request.hostKey,
      workDir: request.workDir,
      os: request.os,
      arch: request.arch,
      version: request.version,
      serviceKind: request.serviceKind,
      pairedAtMs: nowMs,
      pairId,
      isPaused: false,
    };
    const nextPaired = { rev: paired.rev + 1, runners: [...paired.runners, runner] };
    const nextPending: PendingFile = { pending: pending.pending.filter((candidate) => candidate.pairId !== pairId) };
    writePairedFile(ctx.dir, nextPaired);
    writePendingFile(ctx.dir, nextPending);
    syncDerivedHubFiles(ctx, nextPending, nextPaired, nowMs);
    return { ok: true, runnerId: runner.id, name: runner.name, hubPublicKey: hubKey.publicKey, label: pairing.label, host: pairing.host, port: pairing.port };
  });
}

/** @description Find a paired runner by its name or id. */
export function findPairedRunner(runners: readonly PairedRunner[], nameOrId: string): PairedRunner | undefined {
  return runners.find((runner) => runner.name === nameOrId) ?? runners.find((runner) => runner.id === nameOrId);
}

/** @description Take a runner out: its line leaves `authorized_keys`, its entry the registry. `null` when there is no such runner. The link is cut by the caller (`linkControl.ts`). */
export async function removePairedRunner(ctx: HubContext, nameOrId: string, nowMs: number): Promise<PairedRunner | null> {
  return withHubLock(ctx.dir, () => {
    const paired = readPairedFile(ctx.dir);
    const runner = findPairedRunner(paired.runners, nameOrId);
    if (runner === undefined) return null;
    const nextPaired = { rev: paired.rev + 1, runners: paired.runners.filter((candidate) => candidate.id !== runner.id) };
    writePairedFile(ctx.dir, nextPaired);
    syncDerivedHubFiles(ctx, readPendingFile(ctx.dir), nextPaired, nowMs);
    return runner;
  });
}

/** @description Pause or resume a runner from the hub: it stays attached but is never picked for a job while paused. `null` when there is no such runner. */
export async function setPairedRunnerPaused(ctx: HubContext, nameOrId: string, isPaused: boolean): Promise<PairedRunner | null> {
  return withHubLock(ctx.dir, () => {
    const paired = readPairedFile(ctx.dir);
    const runner = findPairedRunner(paired.runners, nameOrId);
    if (runner === undefined) return null;
    const updated: PairedRunner = { ...runner, isPaused };
    if (runner.isPaused !== isPaused) {
      writePairedFile(ctx.dir, { rev: paired.rev + 1, runners: paired.runners.map((candidate) => (candidate.id === runner.id ? updated : candidate)) });
    }
    return updated;
  });
}
