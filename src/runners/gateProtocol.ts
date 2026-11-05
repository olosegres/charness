import type { Readable } from 'stream';
import { z } from 'zod';
import { runnerWorkDirSchema } from '../remoteRun/runnersConfig';
import { hubIdSchema } from './hubIds';
import { checkIsEd25519PublicKey } from './sshKeys';
import { runnerServiceKinds } from './hubRegistry';

/**
 * @description What a runner and the hub's gate say to each other over the forced command of the runner's ssh key. The runner runs
 * `ssh … <request>`; sshd starts the gate with the request word in `SSH_ORIGINAL_COMMAND`.
 *
 *   temporary key (a pairing code):  `bootstrap`  marker line, then the packed charness package (raw gzip)
 *                                    `redeem`     stdin: a {@link RedeemRequest} as JSON; stdout: marker line, then a {@link RedeemReply}
 *   permanent key (a paired runner): `link`       marker line (`package=<id> epoch=<the link's start in ms>`, and `lid=recorded` when the lid the request carried was recorded), then an ssh session in which the GATE is the client (see gateLink.ts)
 *                                    `package`    marker line, then the packed package (raw gzip)
 *                                    `version`    marker line with the hub's current `package=<id>`, nothing else — asked every few minutes over
 *                                                 the connection that is already open, so a linked runner learns of an update
 *                                    `identity`   marker line, then a {@link RedeemReply} — what `redeem` answered for this key's runner. The
 *                                                 way back for a runner whose redeem answer was lost: the hub committed the pairing and
 *                                                 removed the temporary key, so only the permanent key can still ask
 *                                    `unpair`     marker line, then {@link UnpairReply}
 *                                    `lid`        stdin: `closed` or `open`, then (when the `link` marker named one) the link's epoch; marker line, then a
 *                                                 {@link LidReply}. A Mac runner tells the hub when its lid is closed with nothing keeping it awake: it
 *                                                 will sleep, and takes no new job meanwhile (`linkControl.ts`). The `link` request itself may carry
 *                                                 the lid at the moment of connecting (`link lid=closed|open`, {@link formatLinkCommand}): the hub records it
 *                                                 BEFORE the link's socket exists, so a runner is never online with a lid the hub has not heard about
 *
 * Every answer starts with a MARKER line (after a line break, see {@link formatGateAnswerHead}): a shell that prints something before the
 * forced command (a chatty `.bashrc`) would otherwise corrupt the stream; the reader discards everything up to the marker — the runner
 * utility with {@link readUntilGateMarker}, the pasted `sh` line with `grep -b` over the first {@link maxGateNoiseBytes} bytes.
 */

/** What a `lid` report (and the lid argument of a `link`) says: the lid is closed with nothing keeping the Mac awake, or it is not. */
export const lidReportBodies = { closed: 'closed', open: 'open' } as const;

/** The value of the `lid` field of a `link` marker: the hub recorded the lid the request carried. A marker without it says the lid was not recorded — an older hub, or a record that could not be written. */
export const lidRecordedMarkerValue = 'recorded';

/** The text every marker line starts with; the `1` is the protocol version. */
export const gateMarker = '--charness-gate-1--';
export const gateRequests = ['bootstrap', 'redeem', 'cancel', 'link', 'package', 'version', 'identity', 'unpair', 'lid'] as const;
/** @name GateRequest @description One of the words a runner may send. */
export type GateRequest = (typeof gateRequests)[number];

export const temporaryKeyRequests: readonly GateRequest[] = ['bootstrap', 'redeem', 'cancel'];
export const runnerKeyRequests: readonly GateRequest[] = ['link', 'package', 'version', 'identity', 'unpair', 'lid'];

/**
 * @description The command a runner runs for a link: `link`, or — a Mac that knows its lid — `link lid=closed` / `link lid=open`. The forced command of its key matches the whole
 * text against exactly these (`parseLinkLidArgument`), so no other argument is ever passed on.
 */
export function formatLinkCommand(isLidClosed: boolean | null): string {
  return isLidClosed === null ? 'link' : `link lid=${isLidClosed ? lidReportBodies.closed : lidReportBodies.open}`;
}

const linkLidArgumentPattern = new RegExp(`^link lid=(${lidReportBodies.closed}|${lidReportBodies.open})$`);

/** @description The lid a `link` command carries: `true` closed, `false` open, `null` for a plain `link` (or any other text). */
export function parseLinkLidArgument(command: string | undefined): boolean | null {
  const match = command === undefined ? null : linkLidArgumentPattern.exec(command);
  return match === null ? null : match[1] === lidReportBodies.closed;
}

/** What a `link` / `version` answer names as the package when the hub cannot pack one. */
export const noPackageMarker = 'none';
/** The username the gate's ssh client logs in with inside the link (the runner's server ignores it). */
export const linkUserName = 'charness';
/** The most bytes of a request body the gate reads from stdin. */
export const maxGateRequestBytes = 64 * 1024;
const maxTextLength = 200;

const markerLinePattern = new RegExp(`^${gateMarker} (${gateRequests.join('|')})((?: [a-z]+=[A-Za-z0-9._:@/-]*)*)$`);

/**
 * @description What every answer of the gate starts with: a line break, then the marker line. The break ends whatever unfinished line a
 * shell rc printed before the gate ran (a banner without its newline), so the marker always opens a line of its own.
 */
export function formatGateAnswerHead(request: GateRequest, fields: Readonly<Record<string, string>> = {}): string {
  return `\n${formatGateMarkerLine(request, fields)}`;
}

function checkIsGateRequest(value: string): value is GateRequest {
  return gateRequests.some((request) => request === value);
}

/** @description `--charness-gate-1-- link package=abc…`, newline included. Field values are limited to a safe alphabet. */
export function formatGateMarkerLine(request: GateRequest, fields: Readonly<Record<string, string>> = {}): string {
  const rendered = Object.entries(fields).map(([key, value]) => ` ${key}=${value}`).join('');
  return `${gateMarker} ${request}${rendered}\n`;
}

export interface GateMarker {
  request: GateRequest;
  fields: Record<string, string>;
}

/** @description The marker `line` (without its newline) says, or `null` when it is not a marker line. */
export function parseGateMarkerLine(line: string): GateMarker | null {
  const match = markerLinePattern.exec(line);
  if (match === null || !checkIsGateRequest(match[1])) return null;
  const fields: Record<string, string> = {};
  for (const field of match[2].split(' ').filter((part) => part !== '')) {
    const separator = field.indexOf('=');
    fields[field.slice(0, separator)] = field.slice(separator + 1);
  }
  return { request: match[1], fields };
}

const newlineByte = 0x0a;
/** How much text before the marker (a chatty shell rc) a reader puts up with. */
export const maxGateNoiseBytes = 64 * 1024;

/**
 * @description Read `stream` up to and including the marker line: lines before it (noise from the hub's shell) are dropped. Resolves with
 * the marker and the bytes that followed it in what was read — the caller puts them back (`stream.unshift(rest)`) before handing the
 * stream on, since they already belong to the answer. `null`: the stream ended or the noise was too long without a marker. The stream
 * is paused when this resolves.
 */
export function readUntilGateMarker(stream: Readable, maxNoiseBytes: number = maxGateNoiseBytes): Promise<{ marker: GateMarker; rest: Buffer } | null> {
  return new Promise((resolve) => {
    let buffered = Buffer.alloc(0);
    let droppedBytes = 0;
    const settle = (result: { marker: GateMarker; rest: Buffer } | null): void => {
      stream.off('data', onData);
      stream.off('end', onEnd);
      stream.off('close', onEnd);
      stream.pause();
      resolve(result);
    };
    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk]);
      for (;;) {
        const newline = buffered.indexOf(newlineByte);
        if (newline === -1) {
          if (droppedBytes + buffered.length > maxNoiseBytes) settle(null);
          return;
        }
        const marker = parseGateMarkerLine(buffered.subarray(0, newline).toString('utf8').replace(/\r$/, ''));
        const rest = buffered.subarray(newline + 1);
        if (marker !== null) {
          settle({ marker, rest });
          return;
        }
        droppedBytes += newline + 1;
        buffered = rest;
        if (droppedBytes > maxNoiseBytes) {
          settle(null);
          return;
        }
      }
    };
    const onEnd = (): void => settle(null);
    stream.on('data', onData);
    stream.once('end', onEnd);
    stream.once('close', onEnd);
  });
}

const publicKeySchema = z.string().refine(checkIsEd25519PublicKey, 'must be an ed25519 public key (type and key, no comment)');

/** @description What the runner tells the hub when it redeems a pairing code. */
export const redeemRequestSchema = z.strictObject({
  /** A name the runner would like (its host name); the hub makes it valid and unique. */
  suggestedName: z.string().max(maxTextLength),
  publicKey: publicKeySchema,
  hostKey: publicKeySchema,
  workDir: runnerWorkDirSchema,
  os: z.string().max(maxTextLength),
  arch: z.string().max(maxTextLength),
  version: z.string().max(maxTextLength),
  serviceKind: z.enum(runnerServiceKinds),
});
/** @name RedeemRequest @description The body of a `redeem`. */
export type RedeemRequest = z.infer<typeof redeemRequestSchema>;

export const redeemReplySchema = z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    runnerId: hubIdSchema,
    name: z.string(),
    hubPublicKey: publicKeySchema,
    label: z.string(),
    host: z.string(),
    port: z.number().int(),
    /** The hub's current package (what the runner just downloaded, or something newer); `null` when it cannot be packed. */
    packageId: z.string().nullable(),
  }),
  z.strictObject({ ok: z.literal(false), reason: z.string() }),
]);
/** @name RedeemReply @description What `redeem` answers. */
export type RedeemReply = z.infer<typeof redeemReplySchema>;

export const unpairReplySchema = z.strictObject({ ok: z.boolean() });

/**
 * `ok`: the hub took the report (or knew better: a report from an older link than the one now in force is dropped, and answered the same way, because the sender can do
 * nothing about it); `false`: the body was neither of {@link lidReportBodies} nor followed by a number.
 */
export const lidReplySchema = z.strictObject({ ok: z.boolean() });
/** @name LidReply @description What `lid` answers. */
export type LidReply = z.infer<typeof lidReplySchema>;

const lidReportBodyPattern = new RegExp(`^(${lidReportBodies.closed}|${lidReportBodies.open})(?: (\\d{1,16}))?$`);

/** @description What the body of a `lid` request says: closed or open, and the epoch of the link it was made on (`null` when none was named); `null` for anything else. */
export function parseLidReportBody(body: string): { isClosed: boolean; linkEpochMs: number | null } | null {
  const match = lidReportBodyPattern.exec(body.trim());
  return match === null ? null : { isClosed: match[1] === lidReportBodies.closed, linkEpochMs: match[2] === undefined ? null : Number(match[2]) };
}

/** @description The body of a `lid` request. */
export function formatLidReportBody(isClosed: boolean, linkEpochMs: number | null): string {
  return `${isClosed ? lidReportBodies.closed : lidReportBodies.open}${linkEpochMs === null ? '' : ` ${linkEpochMs}`}`;
}

/** `ok`: the code was open and is closed now; `false`: there was nothing to close (spent, expired, or cancelled already). */
export const cancelReplySchema = z.strictObject({ ok: z.boolean() });
/** @name CancelReply @description What `cancel` answers. */
export type CancelReply = z.infer<typeof cancelReplySchema>;
/** @name UnpairReply @description What `unpair` answers. */
export type UnpairReply = z.infer<typeof unpairReplySchema>;
