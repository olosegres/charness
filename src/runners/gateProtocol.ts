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
 *   permanent key (a paired runner): `link`       marker line, then an ssh session in which the GATE is the client (see gateLink.ts)
 *                                    `package`    marker line, then the packed package (raw gzip)
 *                                    `unpair`     marker line, then {@link UnpairReply}
 *
 * Every answer starts with a MARKER line (after a line break, see {@link formatGateAnswerHead}): a shell that prints something before the
 * forced command (a chatty `.bashrc`) would otherwise corrupt the stream; the reader discards everything up to the marker — the runner
 * utility with {@link readUntilGateMarker}, the pasted `sh` line with `grep -b` over the first {@link maxGateNoiseBytes} bytes.
 */

/** The text every marker line starts with; the `1` is the protocol version. */
export const gateMarker = '--charness-gate-1--';
export const gateRequests = ['bootstrap', 'redeem', 'link', 'package', 'unpair'] as const;
/** @name GateRequest @description One of the words a runner may send. */
export type GateRequest = (typeof gateRequests)[number];

export const temporaryKeyRequests: readonly GateRequest[] = ['bootstrap', 'redeem'];
export const runnerKeyRequests: readonly GateRequest[] = ['link', 'package', 'unpair'];

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
/** @name UnpairReply @description What `unpair` answers. */
export type UnpairReply = z.infer<typeof unpairReplySchema>;
