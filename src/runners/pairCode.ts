import { z } from 'zod';
import { hubHostSchema, hubIdSchema, hubPortSchema, hubSshUserSchema } from './hubIds';

/**
 * @description The pairing code: everything a runner needs to reach the hub ONCE — the address, the hub's ssh host key to pin, the
 * account to log in as, a private key that is good for one `redeem` (and the package download), and the pairing's id. Text
 * `cr1.<base64url of a JSON object>`; the `1` is the format version. It is a secret until it is used or has expired: it is never
 * logged, and a decode error names a field, never a value.
 */

export const pairCodePrefix = 'cr1.';
const maxCodeLength = 4096;
const privateKeyPattern = /^-----BEGIN OPENSSH PRIVATE KEY-----\n[A-Za-z0-9+/=\n]+\n-----END OPENSSH PRIVATE KEY-----\n?$/;
const hostKeyPattern = /^(ssh-ed25519|ecdsa-sha2-nistp(?:256|384|521)|ssh-rsa) [A-Za-z0-9+/]+={0,2}$/;

const pairCodePayloadSchema = z.strictObject({
  host: hubHostSchema,
  port: hubPortSchema,
  user: hubSshUserSchema,
  hostKey: z.string().regex(hostKeyPattern, 'must be an ssh public key'),
  privateKey: z.string().max(2048).regex(privateKeyPattern, 'must be an OpenSSH private key'),
  pairId: hubIdSchema,
});

/** @name PairCodePayload @description What a pairing code carries. */
export type PairCodePayload = z.infer<typeof pairCodePayloadSchema>;

export type PairCodeDecoding = { ok: true; payload: PairCodePayload } | { ok: false; error: string };

export function encodePairCode(payload: PairCodePayload): string {
  return `${pairCodePrefix}${Buffer.from(JSON.stringify(pairCodePayloadSchema.parse(payload)), 'utf8').toString('base64url')}`;
}

/** @description The payload of `code`, or why it is not one (the reason never quotes the code). */
export function decodePairCode(code: string): PairCodeDecoding {
  if (!code.startsWith(pairCodePrefix)) return { ok: false, error: `a pairing code starts with ${pairCodePrefix}` };
  if (code.length > maxCodeLength) return { ok: false, error: 'the pairing code is too long' };
  let parsedJson: object;
  try {
    parsedJson = JSON.parse(Buffer.from(code.slice(pairCodePrefix.length), 'base64url').toString('utf8'));
  } catch {
    return { ok: false, error: 'the pairing code is damaged (not a copy of the whole line?)' };
  }
  const parsed = pairCodePayloadSchema.safeParse(parsedJson);
  if (parsed.success) return { ok: true, payload: parsed.data };
  return { ok: false, error: `the pairing code is damaged: ${parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'} ${issue.message}`).join('; ')}` };
}
