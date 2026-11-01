import { createHash, randomBytes } from 'crypto';
import { utils } from 'ssh2';

/**
 * @description The few things charness does with ssh keys: make an ed25519 pair (the runner's own, the hub's, a pairing's temporary
 * one), write a public key the way `authorized_keys` and `known_hosts` read it, and its fingerprint. Public keys are kept as the
 * two-field `<type> <base64>` text — no comment — and checked against a strict pattern before they are ever written into a file
 * sshd reads: a key that carried a newline or an option would be a line of its own.
 */

const base64Alphabet = 'A-Za-z0-9+/';
const publicKeyPattern = new RegExp(`^(ssh-ed25519|ecdsa-sha2-nistp(?:256|384|521)|ssh-rsa) ([${base64Alphabet}]+={0,2})$`);
const ed25519Type = 'ssh-ed25519';
const idByteLength = 6;
/** The odds of a bad key are about 1 in 300: ten tries in a row failing is not luck. */
const maxKeyGenerationAttempts = 10;

export interface SshKeyPair {
  /** OpenSSH private key text (what `ssh -i` reads). */
  privateKey: string;
  /** `ssh-ed25519 <base64>`. */
  publicKey: string;
}

export interface ParsedPublicKey {
  type: string;
  /** The key as the ssh wire protocol carries it (what a host key verifier is handed). */
  blob: Buffer;
}

/**
 * @description A new ed25519 pair; `comment` is kept in the private key only. `ssh2`'s generator drops a leading zero byte of the key
 * now and then (about 1 key in 300 comes out with a 31-byte public key, which neither `ssh2` nor OpenSSH can read), so every pair is
 * read back before it is returned and a bad one is made again.
 */
export function generateEd25519KeyPair(comment: string): SshKeyPair {
  for (let attempt = 0; attempt < maxKeyGenerationAttempts; attempt += 1) {
    const generated = utils.generateKeyPairSync('ed25519', { comment });
    const publicKey = generated.public.split(' ').slice(0, 2).join(' ');
    if (!(utils.parseKey(publicKey) instanceof Error) && !(utils.parseKey(generated.private) instanceof Error)) {
      return { privateKey: generated.private, publicKey };
    }
  }
  throw new Error('could not generate a readable ed25519 key');
}

/** @description `value` as a public key, or `null` when it is not exactly `<type> <base64>`. */
export function parsePublicKey(value: string): ParsedPublicKey | null {
  const match = publicKeyPattern.exec(value);
  if (match === null) return null;
  const blob = Buffer.from(match[2], 'base64');
  return blob.length === 0 ? null : { type: match[1], blob };
}

/** @description Is `value` a public key of the type charness issues to runners and the hub — ed25519 — in the strict form? */
export function checkIsEd25519PublicKey(value: string): boolean {
  return parsePublicKey(value)?.type === ed25519Type;
}

/** @description `SHA256:…`, the fingerprint `ssh-keygen -l` prints. */
export function getPublicKeyFingerprint(publicKey: string): string {
  const parsed = parsePublicKey(publicKey);
  if (parsed === null) throw new Error('not a public key');
  return `SHA256:${createHash('sha256').update(parsed.blob).digest('base64').replace(/=+$/, '')}`;
}

/** @description A random identifier (12 lowercase hex digits) safe in a file name, a shell word, an `authorized_keys` option and as the first word of an argument list. */
export function createRandomId(): string {
  return randomBytes(idByteLength).toString('hex');
}
