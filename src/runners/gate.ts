import * as path from 'path';
import { pipeline } from 'stream/promises';
import type { Readable, Writable } from 'stream';
import { AuthorizedKeysBlockError } from './authorizedKeys';
import { getCaughtErrnoCode } from '../configDirFile';
import { runGateLink, type GateLinkTimings } from './gateLink';
import {
  formatGateAnswerHead,
  maxGateRequestBytes,
  noPackageMarker,
  redeemRequestSchema,
  runnerKeyRequests,
  temporaryKeyRequests,
  type GateRequest,
  type RedeemReply,
  type UnpairReply,
} from './gateProtocol';
import { hubIdPattern } from './hubIds';
import { createHubContext, type HubContext } from './hubPaths';
import { HubRegistryError } from './hubRegistry';
import { getHubPackage, openHubPackage } from './hubPackage';
import { checkIsPairingOpen, checkIsRunnerPaired, describeRunnerIdentity, redeemPairing, removePairedRunner } from './hubPairing';
import { cutRunnerLink } from './linkControl';

/**
 * @description `charness runner-gate` — what sshd starts for a runner's key (the forced command of its `authorized_keys` line, via
 * the `gate` wrapper). It is NOT a child of the bot: it survives bot restarts, and a hot reload never cuts a runner's link.
 *
 * The line names the registry folder, the `authorized_keys` file and the role of the key — `--dir D --keys K redeem <pairId>` for a
 * pairing's temporary key, `--dir D --keys K runner <runnerId>` for a paired runner's. What the runner asks for arrives in
 * `SSH_ORIGINAL_COMMAND` and is matched, as a whole, against the few words its role allows; anything else — another word, arguments,
 * no command at all (a shell login) — is refused. See `gateProtocol.ts` for what each request says.
 */

const refusedExitCode = 2;
const failedExitCode = 1;

export type GateInvocation =
  | { role: 'temporary'; dir: string; keysPath: string; pairId: string }
  | { role: 'runner'; dir: string; keysPath: string; runnerId: string };

export type GateArgsParsing = { ok: true; invocation: GateInvocation } | { ok: false; error: string };

/** @description The arguments of the forced command: `--dir <abs> --keys <abs> redeem|runner <id>`, nothing else. */
export function parseGateArgs(argv: readonly string[]): GateArgsParsing {
  const [dirFlag, dir, keysFlag, keysPath, mode, id, ...rest] = argv;
  if (dirFlag !== '--dir' || keysFlag !== '--keys' || dir === undefined || keysPath === undefined || id === undefined || rest.length > 0) {
    return { ok: false, error: 'usage: runner-gate --dir <folder> --keys <authorized_keys> redeem|runner <id>' };
  }
  if (!path.isAbsolute(dir) || !path.isAbsolute(keysPath)) return { ok: false, error: 'the folder and the keys file must be absolute paths' };
  if (!hubIdPattern.test(id)) return { ok: false, error: 'the id is not a valid id' };
  if (mode === 'redeem') return { ok: true, invocation: { role: 'temporary', dir, keysPath, pairId: id } };
  if (mode === 'runner') return { ok: true, invocation: { role: 'runner', dir, keysPath, runnerId: id } };
  return { ok: false, error: 'the mode must be redeem or runner' };
}

/** @description The request the runner may make with a key of `role`: `originalCommand` as a whole must be one of the role's words. */
export function routeGateRequest(role: GateInvocation['role'], originalCommand: string | undefined): GateRequest | null {
  const allowed = role === 'temporary' ? temporaryKeyRequests : runnerKeyRequests;
  return allowed.find((request) => request === originalCommand) ?? null;
}

export interface GateIo {
  stdin: Readable;
  stdout: Writable;
  /** One line to the runner's side of stderr. */
  log: (line: string) => void;
}

export interface GateOptions {
  /** Override pieces of the context (tests); `dir` and `keysPath` always come from the arguments. */
  context?: Partial<HubContext>;
  now?: () => number;
  linkTimings?: Partial<GateLinkTimings>;
}

async function readLimitedText(stream: Readable, maxBytes: number): Promise<string | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) return null;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Send the package: its marker (`request` says which answer it is), then the archive, read from a file opened BEFORE the marker is sent. */
async function writePackage(ctx: HubContext, io: GateIo, request: 'bootstrap' | 'package'): Promise<number> {
  const opened = await openHubPackage(ctx);
  io.stdout.write(formatGateAnswerHead(request, { id: opened.id }));
  await pipeline(opened.handle.createReadStream(), io.stdout, { end: false });
  return 0;
}

async function handleRedeem(ctx: HubContext, pairId: string, io: GateIo, now: () => number): Promise<number> {
  const body = await readLimitedText(io.stdin, maxGateRequestBytes);
  let reply: RedeemReply;
  const parsed = body === null ? null : safeParseJson(body);
  if (parsed === null) {
    reply = { ok: false, reason: 'the request is not valid JSON or is too large' };
  } else {
    const request = redeemRequestSchema.safeParse(parsed);
    reply = request.success
      ? await redeemPairing(ctx, pairId, request.data, now(), getPackageIdOrNull(ctx, io.log))
      : { ok: false, reason: `the request is invalid: ${request.error.issues.map((issue) => `${issue.path.join('.') || '(root)'} ${issue.message}`).join('; ')}` };
  }
  io.stdout.write(formatGateAnswerHead('redeem'));
  io.stdout.write(`${JSON.stringify(reply)}\n`);
  return reply.ok ? 0 : failedExitCode;
}

function safeParseJson(text: string): object | null {
  try {
    const parsed: object | null = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

async function handleUnpair(ctx: HubContext, runnerId: string, io: GateIo, now: () => number): Promise<number> {
  const removed = await removePairedRunner(ctx, runnerId, now());
  if (removed !== null) cutRunnerLink(ctx.dir, runnerId);
  const reply: UnpairReply = { ok: removed !== null };
  io.stdout.write(formatGateAnswerHead('unpair'));
  io.stdout.write(`${JSON.stringify(reply)}\n`);
  return 0;
}

/** What the runner is told about a failure on the hub: our own registry messages, else only an error code — never a hub path. */
function describeFailure(error: unknown): string {
  if (error instanceof HubRegistryError || error instanceof AuthorizedKeysBlockError) return error.message;
  return `internal error (${getCaughtErrnoCode(error)})`;
}

async function handleIdentity(ctx: HubContext, runnerId: string, io: GateIo): Promise<number> {
  const reply = describeRunnerIdentity(ctx, runnerId, getPackageIdOrNull(ctx, io.log));
  io.stdout.write(formatGateAnswerHead('identity'));
  io.stdout.write(`${JSON.stringify(reply)}\n`);
  return reply.ok ? 0 : failedExitCode;
}

async function handleVersion(ctx: HubContext, io: GateIo): Promise<number> {
  io.stdout.write(formatGateAnswerHead('version', { package: getPackageIdOrNull(ctx, io.log) ?? noPackageMarker }));
  return 0;
}

function getPackageIdOrNull(ctx: HubContext, log: (line: string) => void): string | null {
  try {
    return getHubPackage(ctx).id;
  } catch (error) {
    log(`the package cannot be packed (${describeFailure(error)}); the link goes up without one`);
    return null;
  }
}

/** @description Serve one request of one runner; resolves with the exit code of the gate process. */
export async function runRunnerGate(argv: readonly string[], env: NodeJS.ProcessEnv, io: GateIo, options: GateOptions = {}): Promise<number> {
  const parsed = parseGateArgs(argv);
  if (!parsed.ok) {
    io.log(parsed.error);
    return refusedExitCode;
  }
  const { invocation } = parsed;
  const request = routeGateRequest(invocation.role, env.SSH_ORIGINAL_COMMAND);
  if (request === null) {
    io.log('refused: this key may only be used by charness-runner');
    return refusedExitCode;
  }
  const ctx = createHubContext({ ...options.context, dir: invocation.dir, authorizedKeysPath: invocation.keysPath });
  const now = options.now ?? Date.now;
  try {
    if (invocation.role === 'temporary') {
      if (request === 'bootstrap') {
        if (!checkIsPairingOpen(ctx, invocation.pairId, now())) {
          io.log('refused: this pairing code is unknown, used or expired');
          return refusedExitCode;
        }
        return await writePackage(ctx, io, 'bootstrap');
      }
      return await handleRedeem(ctx, invocation.pairId, io, now);
    }
    // The key line is only the way in: a runner that left the registry is refused whatever its line (or an ssh connection it already
    // has open, which keeps the key's options) still allows. Two requests are answered anyway, because their answer IS «not paired»:
    // `unpair` (idempotent) and `identity` (a removed runner asks it after a refused `link` to tell a removal from a failure — it
    // answers `{ok:false}` and discloses nothing).
    if (request !== 'unpair' && request !== 'identity' && !checkIsRunnerPaired(ctx, invocation.runnerId)) {
      io.log('refused: this runner is not paired here');
      return refusedExitCode;
    }
    switch (request) {
      case 'link':
        return await runGateLink({ ctx, runnerId: invocation.runnerId, input: io.stdin, output: io.stdout, packageId: getPackageIdOrNull(ctx, io.log), log: io.log, timings: options.linkTimings, now });
      case 'package':
        return await writePackage(ctx, io, 'package');
      case 'version':
        return await handleVersion(ctx, io);
      case 'identity':
        return await handleIdentity(ctx, invocation.runnerId, io);
      case 'unpair':
        return await handleUnpair(ctx, invocation.runnerId, io, now);
      default:
        return refusedExitCode;
    }
  } catch (error) {
    io.log(`failed: ${describeFailure(error)}`);
    return failedExitCode;
  }
}
