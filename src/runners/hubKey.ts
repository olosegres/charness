import * as fs from 'fs';
import { writeTextFileAtomically } from '../configDirFile';
import { getHubFilePaths } from './hubPaths';
import { HubRegistryError } from './hubRegistry';
import { checkIsEd25519PublicKey, generateEd25519KeyPair, type SshKeyPair } from './sshKeys';

/**
 * @description The hub's own client key (`hub_ed25519`): the one key every runner's built-in ssh server accepts, and the one the
 * stock `ssh` calls of `remote-run` log in with. It is made on the first pairing; one key for all runners, because it only proves
 * "this is the hub" to a machine that already trusts this hub.
 */

const privateKeyMode = 0o600;
const publicKeyMode = 0o644;
const hubKeyComment = 'charness-hub';

/** @description The hub key, or `null` when none was made yet (or its files do not read). */
export function readHubKey(dir: string): SshKeyPair | null {
  const paths = getHubFilePaths(dir);
  try {
    const privateKey = fs.readFileSync(paths.hubKey, 'utf8');
    const publicKey = fs.readFileSync(paths.hubPublicKey, 'utf8').trim().split(' ').slice(0, 2).join(' ');
    return checkIsEd25519PublicKey(publicKey) ? { privateKey, publicKey } : null;
  } catch {
    return null;
  }
}

/** @description The hub key, made now when it is missing. The registry lock must be held (two first pairings must not make two keys). */
export function readOrCreateHubKeyLocked(dir: string): SshKeyPair {
  const existing = readHubKey(dir);
  if (existing !== null) return existing;
  const paths = getHubFilePaths(dir);
  // Every paired runner trusts THIS key: a half-present pair is never quietly replaced by a new one.
  if (fs.existsSync(paths.hubKey) || fs.existsSync(paths.hubPublicKey)) {
    throw new HubRegistryError('hub_ed25519 and hub_ed25519.pub do not read as a pair; restore them, or delete both and pair the runners again');
  }
  const created = generateEd25519KeyPair(hubKeyComment);
  writeTextFileAtomically(paths.hubKey, created.privateKey, privateKeyMode);
  writeTextFileAtomically(paths.hubPublicKey, `${created.publicKey} ${hubKeyComment}\n`, publicKeyMode);
  return created;
}
