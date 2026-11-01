import * as fs from 'fs';
import { writeTextFileAtomically } from '../configDirFile';
import { generateEd25519KeyPair, type SshKeyPair } from '../runners/sshKeys';
import type { RunnerHomePaths } from './runnerHome';

/**
 * @description The runner's two keys, made at pairing and never changed: the CLIENT key (the hub's `authorized_keys` line holds its
 * public half — it is how the runner logs in and may do nothing but speak to the gate) and the HOST key of its built-in ssh server (the
 * hub pins its public half, so nobody else can answer in the runner's name). Both are made with `generateEd25519KeyPair`, which
 * reads every key back (ssh2's generator now and then writes a key nothing can read).
 */

const privateKeyMode = 0o600;
const publicKeyMode = 0o644;
const publicKeySuffix = '.pub';

function readKeyPair(privatePath: string): SshKeyPair | null {
  try {
    const privateKey = fs.readFileSync(privatePath, 'utf8');
    const publicKey = fs.readFileSync(`${privatePath}${publicKeySuffix}`, 'utf8').trim().split(' ').slice(0, 2).join(' ');
    return { privateKey, publicKey };
  } catch {
    return null;
  }
}

function ensureKeyPair(privatePath: string, comment: string): SshKeyPair {
  const existing = readKeyPair(privatePath);
  if (existing !== null) return existing;
  const created = generateEd25519KeyPair(comment);
  writeTextFileAtomically(privatePath, created.privateKey, privateKeyMode);
  writeTextFileAtomically(`${privatePath}${publicKeySuffix}`, `${created.publicKey} ${comment}\n`, publicKeyMode);
  return created;
}

export interface RunnerKeys {
  client: SshKeyPair;
  server: SshKeyPair;
}

/** @description Both keys, made now when missing. */
export function ensureRunnerKeys(paths: RunnerHomePaths): RunnerKeys {
  fs.mkdirSync(paths.keysDir, { recursive: true, mode: 0o700 });
  return { client: ensureKeyPair(paths.clientKey, 'charness-runner-client'), server: ensureKeyPair(paths.serverKey, 'charness-runner-host') };
}

/** @description Both keys, or `null` when any is missing (not paired on this account). */
export function readRunnerKeys(paths: RunnerHomePaths): RunnerKeys | null {
  const client = readKeyPair(paths.clientKey);
  const server = readKeyPair(paths.serverKey);
  return client === null || server === null ? null : { client, server };
}
