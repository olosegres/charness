import * as os from 'os';
import { loadRunnersConfigAt } from '../remoteRun/runnersConfig';
import { assertManagedBlockIntact } from './authorizedKeys';
import type { RedeemReply, RedeemRequest } from './gateProtocol';
import { getHandMadeRunnersPath, type HubContext } from './hubPaths';
import { withHubLock } from './hubLock';
import { readHubKey, readOrCreateHubKeyLocked } from './hubKey';
import {
  readPairedFile,
  readPendingFile,
  syncDerivedHubFiles,
  writePairedFile,
  writePendingFile,
  type PairedFile,
  type PairedRunner,
  type PendingFile,
  type PendingPairing,
} from './hubRegistry';
import { encodePairCode, type PairCodePayload } from './pairCode';
import { pairingLifetimeMs } from './pairingTiming';
import { createRandomId, generateEd25519KeyPair, getPublicKeyFingerprint } from './sshKeys';

/**
 * @description The registry's operations — each one a transaction under the registry lock (`runTransaction`):
 *
 *   1. the `authorized_keys` block is checked first — a damaged one stops the operation before anything is written;
 *   2. the AUTHORITATIVE files change: `paired.json`, then `pending.json`;
 *   3. everything derived from them (`known_hosts`, the block) is rewritten from the registry — and this last step runs at the end of
 *      EVERY operation, whether it changed anything or not, so a step that failed (or a crash between two writes) is mended by the
 *      next operation, a plain `ls` included.
 *
 * Nothing in the middle can lose or double-spend a pairing: `redeem` records the runner with the id of the code that made it, so a
 * code is single use even when the pending entry outlives a crash (the entry is dropped by the next transaction, before anything else), and
 * a retry from the same machine is answered the same way (idempotent). A runner that is removed from `paired.json` is refused by every gate request at once, whatever its key line still says.
 */

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
  /** How long the code works (default: the production lifetime, 10 minutes). */
  lifetimeMs?: number;
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

interface RegistryState {
  paired: PairedFile;
  pending: PendingFile;
}

interface TransactionOutcome<TResult> {
  result: TResult;
  /** The new content of a registry file; absent = unchanged. */
  paired?: PairedFile;
  pending?: PendingFile;
}

function runTransaction<TResult>(ctx: HubContext, nowMs: number, work: (state: RegistryState) => TransactionOutcome<TResult>): Promise<TResult> {
  return withHubLock(ctx.dir, () => {
    assertManagedBlockIntact(ctx.authorizedKeysPath);
    const paired = readPairedFile(ctx.dir);
    // A pending entry whose code was already used (a crash between the two writes of a redemption) is dropped BEFORE anything else is
    // done, and persisted: the paired runner is the only proof that the code is spent, and a later removal of that runner must not leave
    // the entry — and with it the code's temporary key — behind to be redeemed again.
    const pending = readPendingFile(ctx.dir);
    const openPending: PendingFile = { pending: pending.pending.filter((pairing) => !checkIsPairingUsed(paired, pairing.pairId)) };
    if (openPending.pending.length !== pending.pending.length) writePendingFile(ctx.dir, openPending);
    const state: RegistryState = { paired, pending: openPending };
    const outcome = work(state);
    if (outcome.paired !== undefined) writePairedFile(ctx.dir, outcome.paired);
    if (outcome.pending !== undefined) writePendingFile(ctx.dir, outcome.pending);
    syncDerivedHubFiles(ctx, outcome.pending ?? state.pending, outcome.paired ?? state.paired, nowMs);
    return outcome.result;
  });
}

function removeExpired(pending: PendingFile, nowMs: number): { kept: PendingFile; expired: PendingPairing[] } {
  const expired = pending.pending.filter((pairing) => pairing.expiresAtMs <= nowMs);
  return { kept: { pending: pending.pending.filter((pairing) => pairing.expiresAtMs > nowMs) }, expired };
}

function checkIsPairingUsed(paired: PairedFile, pairId: string): boolean {
  return paired.runners.some((runner) => runner.pairId === pairId);
}

/** @description Make a pairing code: a temporary key good for 10 minutes, its line in `authorized_keys`, its entry in `pending.json`. */
export function createPairing(ctx: HubContext, params: CreatePairingParams): Promise<CreatedPairing> {
  return runTransaction(ctx, params.nowMs, (state) => {
    const pairId = createRandomId();
    const expiresAtMs = params.nowMs + (params.lifetimeMs ?? pairingLifetimeMs);
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
    const payload: PairCodePayload = {
      host: params.host,
      port: params.port,
      user: params.sshUser ?? os.userInfo().username,
      hostKey: params.hostKey,
      privateKey: temporaryKey.privateKey,
      pairId,
    };
    // Codes that expired stay listed until `sweepExpiredPairings` hands them back: the instance that offered one still has a message to edit.
    return { result: { pairId, expiresAtMs, code: encodePairCode(payload), payload }, pending: { pending: [...state.pending.pending, pairing] } };
  });
}

/** @description Is the pairing code `pairId` still open (made, not used, not expired)? The gate asks before it sends the package. */
export function checkIsPairingOpen(ctx: HubContext, pairId: string, nowMs: number): boolean {
  return readPendingFile(ctx.dir).pending.some((pairing) => pairing.pairId === pairId && pairing.expiresAtMs > nowMs)
    && !checkIsPairingUsed(readPairedFile(ctx.dir), pairId);
}

/**
 * @description Forget the pairing codes that have expired (their lines are gone from `authorized_keys` too) and return them, so the
 * offering instance can edit its messages. A code that was used but whose entry outlived a crash is dropped without being returned.
 * Run at boot, on a timer and by the CLI; sshd already refuses an expired key by itself.
 */
export function sweepExpiredPairings(ctx: HubContext, nowMs: number): Promise<PendingPairing[]> {
  return runTransaction(ctx, nowMs, (state) => {
    const { kept, expired } = removeExpired(state.pending, nowMs);
    return { result: expired, ...(kept.pending.length === state.pending.pending.length ? {} : { pending: kept }) };
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

function buildRedeemReply(runner: PairedRunner, hubPublicKey: string, packageId: string | null): RedeemReply {
  return { ok: true, runnerId: runner.id, name: runner.name, hubPublicKey, label: runner.label, host: runner.host, port: runner.port, packageId };
}

/** @description What `redeem` answered (or would answer) for the paired runner `runnerId` — for the runner that lost the answer. `ok: false` when it is not in the registry. */
export function describeRunnerIdentity(ctx: HubContext, runnerId: string, packageId: string | null): RedeemReply {
  const runner = readPairedFile(ctx.dir).runners.find((candidate) => candidate.id === runnerId);
  const hubKey = readHubKey(ctx.dir);
  if (runner === undefined || hubKey === null) return { ok: false, reason: 'this runner is not paired here' };
  return buildRedeemReply(runner, hubKey.publicKey, packageId);
}

const unusableCodeReply: RedeemReply = { ok: false, reason: 'this pairing code is unknown or already used' };

/**
 * @description Use the pairing code `pairId`: the runner's keys become a paired runner and the code is spent. A code that is unknown,
 * used (by another key) or expired, and a key that is already registered, are refused with the reason (no values) and change nothing.
 * The SAME machine asking again for a code it has already used — its answer was lost, or the hub failed after the registry was written —
 * is answered again, and the derived files are repaired on the way. `packageId` is the hub's current package, told to the runner.
 */
export function redeemPairing(ctx: HubContext, pairId: string, request: RedeemRequest, nowMs: number, packageId: string | null = null): Promise<RedeemReply> {
  return runTransaction(ctx, nowMs, (state): TransactionOutcome<RedeemReply> => {
    const used = state.paired.runners.find((runner) => runner.pairId === pairId);
    if (used !== undefined) {
      return { result: used.publicKey === request.publicKey ? buildRedeemReply(used, readOrCreateHubKeyLocked(ctx.dir).publicKey, packageId) : unusableCodeReply };
    }
    const pairing = state.pending.pending.find((candidate) => candidate.pairId === pairId);
    if (pairing === undefined) return { result: unusableCodeReply };
    if (pairing.expiresAtMs <= nowMs) return { result: { ok: false, reason: 'this pairing code has expired' } };
    if (state.paired.runners.some((runner) => runner.publicKey === request.publicKey)) return { result: { ok: false, reason: 'this machine is already paired' } };
    const runner: PairedRunner = {
      id: createRandomId(),
      name: pickFreeRunnerName(request.suggestedName, getTakenRunnerNames(ctx, state.paired.runners)),
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
      label: pairing.label,
      host: pairing.host,
      port: pairing.port,
      isPaused: false,
    };
    return {
      result: buildRedeemReply(runner, readOrCreateHubKeyLocked(ctx.dir).publicKey, packageId),
      paired: { rev: state.paired.rev + 1, runners: [...state.paired.runners, runner] },
      pending: { pending: state.pending.pending.filter((candidate) => candidate.pairId !== pairId) },
    };
  });
}

/** @description Find a paired runner by its name or id. */
export function findPairedRunner(runners: readonly PairedRunner[], nameOrId: string): PairedRunner | undefined {
  return runners.find((runner) => runner.name === nameOrId) ?? runners.find((runner) => runner.id === nameOrId);
}

/** @description Is the runner `runnerId` in the registry? Every request of a runner's key asks, so a removed runner is refused at once even when its key line is still there. */
export function checkIsRunnerPaired(ctx: HubContext, runnerId: string): boolean {
  return readPairedFile(ctx.dir).runners.some((runner) => runner.id === runnerId);
}

/** @description Take a runner out: its entry leaves the registry, its line `authorized_keys`. `null` when there is no such runner. The link is cut by the caller (`linkControl.ts`). A retry after a failed step finds nothing to remove and repairs the files. */
export function removePairedRunner(ctx: HubContext, nameOrId: string, nowMs: number): Promise<PairedRunner | null> {
  return runTransaction(ctx, nowMs, (state) => {
    const runner = findPairedRunner(state.paired.runners, nameOrId);
    if (runner === undefined) return { result: null };
    return { result: runner, paired: { rev: state.paired.rev + 1, runners: state.paired.runners.filter((candidate) => candidate.id !== runner.id) } };
  });
}

/** @description Pause or resume a runner from the hub: it stays attached but is never picked for a job while paused. `null` when there is no such runner. */
export function setPairedRunnerPaused(ctx: HubContext, nameOrId: string, isPaused: boolean): Promise<PairedRunner | null> {
  return runTransaction(ctx, Date.now(), (state) => {
    const runner = findPairedRunner(state.paired.runners, nameOrId);
    if (runner === undefined) return { result: null };
    const updated: PairedRunner = { ...runner, isPaused };
    if (runner.isPaused === isPaused) return { result: updated };
    return { result: updated, paired: { rev: state.paired.rev + 1, runners: state.paired.runners.map((candidate) => (candidate.id === runner.id ? updated : candidate)) } };
  });
}
