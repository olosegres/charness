import { z } from 'zod';
import { hubHostKeySchema, hubHostSchema, hubIdSchema, hubPortSchema, hubSshUserSchema } from './hubIds';

/**
 * @description The pairing code: everything a runner needs to reach the hub ONCE — the address, the hub's ssh host key to pin, the
 * account to log in as, a private key that is good for one `redeem` (and the package download), and the pairing's id. Text
 * `cr2.<user>,<host>,<port>,<pairId>,<host key type>,<host key base64>,<private key body>` (see {@link PairCodeFields}); the `2` is the format
 * version. It is a secret until it is used or has expired: it is never logged, and a decode error names a field, never a value.
 *
 * Why a plain list and not an encoded object: the pasted line needs every one of these values ITSELF, before there is any program on the machine to
 * decode a code (to reach the hub with the key, to pin its host key), so it holds them once, as shell variables — and the code is put together from
 * those variables by the shell, `"cr2.$u,$h,$p,<id>,$y,$z,$k"`, instead of being a second copy of them inside the line (a Telegram message holds 4096
 * characters, and a copy as base64 cost the line more than a third of its length). Every value has passed a strict pattern (`hubIds.ts`) that contains no
 * `,`, so the list splits without ambiguity; the key body is the base64 text of the OpenSSH private key, header, footer and line breaks left off.
 *
 * Version 1 — `cr1.<base64url of a JSON object>` — is still READ: a line made by the version before stays good for its ten minutes, and the program it
 * downloads is the hub's current one. It is never written.
 */

export const pairCodePrefix = 'cr2.';
const jsonPairCodePrefix = 'cr1.';
const fieldSeparator = ',';
const maxCodeLength = 4096;
/** The lines around the base64 body of an OpenSSH private key. */
export const privateKeyHeader = '-----BEGIN OPENSSH PRIVATE KEY-----';
export const privateKeyFooter = '-----END OPENSSH PRIVATE KEY-----';
/** How wide the lines of the key body are in the key the hub generates; a decoded key has the same layout, so a payload comes back as it went. */
const privateKeyLineWidth = 64;
const privateKeyPattern = /^-----BEGIN OPENSSH PRIVATE KEY-----\n[A-Za-z0-9+/=\n]+\n-----END OPENSSH PRIVATE KEY-----\n?$/;

const pairCodePayloadSchema = z.strictObject({
  host: hubHostSchema,
  port: hubPortSchema,
  user: hubSshUserSchema,
  hostKey: hubHostKeySchema,
  privateKey: z.string().max(2048).regex(privateKeyPattern, 'must be an OpenSSH private key'),
  pairId: hubIdSchema,
});

/** @name PairCodePayload @description What a pairing code carries. */
export type PairCodePayload = z.infer<typeof pairCodePayloadSchema>;

/**
 * @name PairCodeFields
 * @description The values of a `cr2.` code as text, in the order the code lists them: what a shell line holds as variables and joins ({@link joinPairCodeFields}).
 */
export interface PairCodeFields {
  user: string;
  host: string;
  port: string;
  pairId: string;
  hostKeyType: string;
  hostKeyBlob: string;
  privateKeyBody: string;
}

export type PairCodeDecoding = { ok: true; payload: PairCodePayload } | { ok: false; error: string };

/** @description `payload` after the strict patterns have judged every value; throws when one does not hold. */
export function parsePairCodePayload(payload: PairCodePayload): PairCodePayload {
  return pairCodePayloadSchema.parse(payload);
}

/** @description The values of `payload` (checked) as the code lists them. */
export function getPairCodeFields(payload: PairCodePayload): PairCodeFields {
  const checked = parsePairCodePayload(payload);
  const [hostKeyType, hostKeyBlob] = checked.hostKey.split(' ');
  const privateKeyBody = checked.privateKey.replace(privateKeyHeader, '').replace(privateKeyFooter, '').replace(/\s+/g, '');
  return { user: checked.user, host: checked.host, port: checked.port.toString(), pairId: checked.pairId, hostKeyType, hostKeyBlob, privateKeyBody };
}

/** @description The code made of `fields` — each one a value, or the shell word that will hold it (`$u`): the ONE place that knows their order. */
export function joinPairCodeFields(fields: PairCodeFields): string {
  const { user, host, port, pairId, hostKeyType, hostKeyBlob, privateKeyBody } = fields;
  return `${pairCodePrefix}${[user, host, port, pairId, hostKeyType, hostKeyBlob, privateKeyBody].join(fieldSeparator)}`;
}

export function encodePairCode(payload: PairCodePayload): string {
  return joinPairCodeFields(getPairCodeFields(payload));
}

function foldPrivateKeyBody(body: string): string {
  return (body.match(new RegExp(`.{1,${privateKeyLineWidth}}`, 'g')) ?? []).join('\n');
}

/** The object a `cr2.` code lists, before the patterns judge it, or `null` when the list is not the right length. */
function readFieldsCode(code: string): object | null {
  const fields = code.slice(pairCodePrefix.length).split(fieldSeparator);
  if (fields.length !== 7) return null;
  const [user, host, port, pairId, hostKeyType, hostKeyBlob, privateKeyBody] = fields;
  return { host, port: Number(port), user, hostKey: `${hostKeyType} ${hostKeyBlob}`, privateKey: `${privateKeyHeader}\n${foldPrivateKeyBody(privateKeyBody)}\n${privateKeyFooter}\n`, pairId };
}

/** The object a `cr1.` code holds, or `null` when it is no base64url JSON. */
function readJsonCode(code: string): object | null {
  try {
    return JSON.parse(Buffer.from(code.slice(jsonPairCodePrefix.length), 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

/** @description The payload of `code`, or why it is not one (the reason never quotes the code). */
export function decodePairCode(code: string): PairCodeDecoding {
  const isFieldsCode = code.startsWith(pairCodePrefix);
  if (!isFieldsCode && !code.startsWith(jsonPairCodePrefix)) return { ok: false, error: `a pairing code starts with ${pairCodePrefix}` };
  if (code.length > maxCodeLength) return { ok: false, error: 'the pairing code is too long' };
  const candidate = isFieldsCode ? readFieldsCode(code) : readJsonCode(code);
  if (candidate === null) return { ok: false, error: 'the pairing code is damaged (not a copy of the whole line?)' };
  const parsed = pairCodePayloadSchema.safeParse(candidate);
  if (parsed.success) return { ok: true, payload: parsed.data };
  return { ok: false, error: `the pairing code is damaged: ${parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'} ${issue.message}`).join('; ')}` };
}
