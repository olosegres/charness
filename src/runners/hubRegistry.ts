import * as fs from 'fs';
import { z } from 'zod';
import { writeJsonFileAtomically, writeTextFileAtomically } from '../configDirFile';
import { runnerDiskSettingsShape, runnerNamePattern, runnerWorkDirSchema } from '../remoteRun/runnersConfig';
import { buildRunnerKeyLine, buildTempKeyLine, writeManagedBlock } from './authorizedKeys';
import { hubHostSchema, hubIdSchema, hubPortSchema } from './hubIds';
import { getHubFilePaths, getRunnerHostAlias, type HubContext } from './hubPaths';
import { ensureHubDir } from './hubLock';
import { sweepOrphanLinkRecords } from './linkControl';
import { getCaughtErrnoCode } from '../configDirFile';
import { checkIsEd25519PublicKey } from './sshKeys';

/**
 * @description The hub's registry files and what is derived from them. `paired.json` is the machines that are attached,
 * `pending.json` the pairing codes that are out. Both are read freely (every write is a rename, a reader sees a whole file) and
 * written only under the registry lock (`hubLock.ts`). `known_hosts` (the runners' host keys, for the ssh calls through the link)
 * and the managed `authorized_keys` block are DERIVED from the two on every change — never edited on their own.
 *
 * A file that does not parse or validate stops the caller with the problem named (field and rule, no values): a registry that is
 * silently treated as empty would be rewritten empty and lose every pairing.
 *
 * `closed.json` is the odd one out: a TRACE, not part of the registry's truth — the codes that were closed unused, so a code that was
 * closed (its line was pasted for a machine that was already paired) can be told from one that ran out. Nothing depends on it for
 * correctness, so it is read leniently (a file that cannot be used reads as none, and the problem is handed to the caller to say once) and
 * its write never blocks the close it describes. It is a file of its own, not a field of a pending entry: the sweep drops pending entries
 * at expiry, which would lose the trace for an instance that was down, and every reader of the pending list would have to honour it.
 */

const registryFileMode = 0o600;
const knownHostsMode = 0o644;
const maxTextLength = 200;

const publicKeySchema = z.string().refine(checkIsEd25519PublicKey, 'must be an ed25519 public key (type and key, no comment)');

/** @description How the runner utility says it is kept running (reported at pairing). */
export const runnerServiceKinds = ['foreground', 'user-service', 'system-service', 'unknown'] as const;
export type RunnerServiceKind = (typeof runnerServiceKinds)[number];

const pairedRunnerSchema = z.strictObject({
  id: hubIdSchema,
  name: z.string().regex(runnerNamePattern, 'must be lowercase letters, digits and single dashes').max(40),
  /** The runner's own client key: what its `authorized_keys` line holds. */
  publicKey: publicKeySchema,
  keyFingerprint: z.string().max(maxTextLength),
  /** The host key of the runner's built-in ssh server: pinned by the gate and by `known_hosts`. */
  hostKey: publicKeySchema,
  workDir: runnerWorkDirSchema,
  os: z.string().max(maxTextLength),
  arch: z.string().max(maxTextLength),
  version: z.string().max(maxTextLength),
  serviceKind: z.enum(runnerServiceKinds),
  pairedAtMs: z.number().int().nonnegative(),
  /** The pairing that made it: how the instance that offered the code finds out that it was used, and what makes a retry of `redeem` idempotent. */
  pairId: hubIdSchema,
  /** What the runner was told about this hub (kept so a retried `redeem` is answered the same way after the pending entry is gone). */
  label: z.string().min(1).max(maxTextLength),
  host: hubHostSchema,
  port: hubPortSchema,
  /** Set from the hub: the runner stays attached, but no job is sent to it. */
  isPaused: z.boolean(),
  /** The runner's disk upkeep, when the operator replaced the defaults by editing this entry (`minFreeGb`, `copyMaxIdleDays`: see `runnersConfig.ts`). */
  ...runnerDiskSettingsShape,
});

export const pairedFileSchema = z.strictObject({
  /** Counts every change: a keyboard built from one revision never acts on a later list. */
  rev: z.number().int().nonnegative(),
  runners: z.array(pairedRunnerSchema),
});

const pendingPairingSchema = z.strictObject({
  pairId: hubIdSchema,
  /** The temporary key's PUBLIC half (the private half is in the code only). */
  publicKey: publicKeySchema,
  keyFingerprint: z.string().max(maxTextLength),
  expiresAtMs: z.number().int().nonnegative(),
  host: hubHostSchema,
  port: hubPortSchema,
  /** Whose charness it is, as the runner shows it (`@ExampleBot`, a host name). */
  label: z.string().min(1).max(maxTextLength),
  /** The message the offering instance edits when the code is used or expires (opaque to the hub); `null` for the CLI. */
  messageRef: z.string().max(maxTextLength).nullable(),
});

const pendingFileSchema = z.strictObject({ pending: z.array(pendingPairingSchema) });

const closedCodeSchema = z.strictObject({ pairId: hubIdSchema, closedAtMs: z.number().int().nonnegative() });
const closedFileSchema = z.strictObject({ closed: z.array(closedCodeSchema) });
/** The newest this many closings are kept: a closing is rare and its trace is wanted by a message that is still unsettled, so a cap is all the bound it needs. */
const maxClosedCodes = 50;

/** @name PairedRunner @description One attached machine. */
export type PairedRunner = z.infer<typeof pairedRunnerSchema>;
/** @name PairedFile @description `paired.json`. */
export type PairedFile = z.infer<typeof pairedFileSchema>;
/** @name PendingPairing @description One pairing code that is out. */
export type PendingPairing = z.infer<typeof pendingPairingSchema>;
/** @name PendingFile @description `pending.json`. */
export type PendingFile = z.infer<typeof pendingFileSchema>;
/** @name ClosedCode @description A pairing code that was closed unused, and when. */
export type ClosedCode = z.infer<typeof closedCodeSchema>;

/** @name ClosedCodesRead @description What `closed.json` holds, and — when it could not be used — why (the caller says it, once). */
export interface ClosedCodesRead {
  codes: ClosedCode[];
  problem: string | null;
}

export class HubRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HubRegistryError';
  }
}

/** @description The registry files were written but a file derived from them could not be; the next locked operation repairs it. */
export class HubDerivedFilesError extends HubRegistryError {
  constructor(fileName: string, errnoCode: string) {
    super(`the registry was updated but ${fileName} could not be written (${errnoCode}); the next runners command repairs it`);
    this.name = 'HubDerivedFilesError';
  }
}

function readRegistryFile<TFile>(filePath: string, fileName: string, schema: z.ZodType<TFile>, createEmpty: () => TFile): TFile {
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return createEmpty();
    throw new HubRegistryError(`${fileName} could not be read`);
  }
  let parsedJson: object;
  try {
    parsedJson = JSON.parse(text);
  } catch {
    throw new HubRegistryError(`${fileName} is not valid JSON; fix or remove it by hand (nothing was changed)`);
  }
  const parsed = schema.safeParse(parsedJson);
  if (parsed.success) return parsed.data;
  throw new HubRegistryError(`${fileName} is invalid: ${parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'} ${issue.message}`).join('; ')}`);
}

/** @description `paired.json` right now (missing = nobody paired). */
export function readPairedFile(dir: string): PairedFile {
  return readRegistryFile(getHubFilePaths(dir).paired, 'paired.json', pairedFileSchema, () => ({ rev: 0, runners: [] }));
}

/** @description `pending.json` right now (missing = no code out). */
export function readPendingFile(dir: string): PendingFile {
  return readRegistryFile(getHubFilePaths(dir).pending, 'pending.json', pendingFileSchema, () => ({ pending: [] }));
}

/**
 * @description `closed.json` right now: its codes, or none — with the problem named — when it cannot be read or does not validate. A trace
 * must never stop the caller, so unlike the registry files this does not throw; the caller says the problem once.
 */
export function readClosedCodes(dir: string): ClosedCodesRead {
  try {
    return { codes: readRegistryFile(getHubFilePaths(dir).closed, 'closed.json', closedFileSchema, () => ({ closed: [] })).closed, problem: null };
  } catch (error) {
    if (error instanceof HubRegistryError) return { codes: [], problem: `${error.message}; the codes in it read as expired` };
    throw error;
  }
}

/**
 * @description Note that the code `pairId` was closed at `nowMs` (the newest {@link maxClosedCodes} are kept); the registry lock must be held. BEST
 * EFFORT: a trace that cannot be written is said through `ctx.log` and costs only the nicer text («this line was used on a machine that was
 * already paired» reads «expired»), never the closing it describes. A file that cannot be used is replaced.
 */
export function recordClosedCode(ctx: HubContext, pairId: string, nowMs: number): void {
  const { codes, problem } = readClosedCodes(ctx.dir);
  if (problem !== null) ctx.log(`${problem}; it is written anew`);
  try {
    ensureHubDir(ctx.dir);
    writeJsonFileAtomically(getHubFilePaths(ctx.dir).closed, closedFileSchema.parse({ closed: [...codes.filter((entry) => entry.pairId !== pairId), { pairId, closedAtMs: nowMs }].slice(-maxClosedCodes) }), registryFileMode);
  } catch (error) {
    ctx.log(`closed.json could not be written (${getCaughtErrnoCode(error)}); the messages of the code that was just closed will read as expired`);
  }
}

/** @description Write `paired.json`; the registry lock must be held. */
export function writePairedFile(dir: string, file: PairedFile): void {
  ensureHubDir(dir);
  writeJsonFileAtomically(getHubFilePaths(dir).paired, pairedFileSchema.parse(file), registryFileMode);
}

/** @description Write `pending.json`; the registry lock must be held. */
export function writePendingFile(dir: string, file: PendingFile): void {
  ensureHubDir(dir);
  writeJsonFileAtomically(getHubFilePaths(dir).pending, pendingFileSchema.parse(file), registryFileMode);
}

/** @description The `known_hosts` text for the ssh calls through the links: one line per runner, under its alias. */
export function renderKnownHosts(runners: readonly PairedRunner[]): string {
  return runners.map((runner) => `${getRunnerHostAlias(runner.id)} ${runner.hostKey}\n`).join('');
}

/** @description The lines of the managed `authorized_keys` block: every pairing code still open, then every paired runner. */
export function renderManagedBlockLines(ctx: HubContext, pending: readonly PendingPairing[], runners: readonly PairedRunner[], nowMs: number): string[] {
  const gatePath = getHubFilePaths(ctx.dir).gate;
  const common = { gatePath, keysPath: ctx.authorizedKeysPath, dir: ctx.dir };
  return [
    ...pending.filter((pairing) => pairing.expiresAtMs > nowMs).map((pairing) => buildTempKeyLine({ ...common, publicKey: pairing.publicKey, expiresAtMs: pairing.expiresAtMs, pairId: pairing.pairId })),
    ...runners.map((runner) => buildRunnerKeyLine({ ...common, publicKey: runner.publicKey, runnerId: runner.id })),
  ];
}

function readTextIfPresent(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

/**
 * @description Bring the derived files in line with the two registry files: `known_hosts` and the `authorized_keys` block, each written
 * only when it differs, and the link files of runners that are no longer registered deleted. The registry lock must be held. The block goes LAST, so a key is never allowed before the files its gate reads
 * are in place. The registry files are authoritative and are written BEFORE this runs; a failure here is reported as
 * {@link HubDerivedFilesError} and mends itself, because every locked operation ends with this same call.
 */
export function syncDerivedHubFiles(ctx: HubContext, pending: PendingFile, paired: PairedFile, nowMs: number): void {
  const knownHostsPath = getHubFilePaths(ctx.dir).knownHosts;
  const knownHosts = renderKnownHosts(paired.runners);
  try {
    if (readTextIfPresent(knownHostsPath) !== knownHosts) writeTextFileAtomically(knownHostsPath, knownHosts, knownHostsMode);
  } catch (error) {
    throw new HubDerivedFilesError('known_hosts', getCaughtErrnoCode(error));
  }
  try {
    writeManagedBlock(ctx.authorizedKeysPath, renderManagedBlockLines(ctx, pending.pending, paired.runners, nowMs));
  } catch (error) {
    throw new HubDerivedFilesError('authorized_keys', getCaughtErrnoCode(error));
  }
  // The link files of a runner the registry does not know are leftovers: best effort, it cannot fail the operation that has already written its files.
  sweepOrphanLinkRecords(ctx.dir, paired.runners.map((runner) => runner.id), ctx.log);
}
