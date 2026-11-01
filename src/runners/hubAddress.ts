import { spawn } from 'child_process';
import { hubHostSchema, hubPortSchema } from './hubIds';
import { getPublicKeyFingerprint, parsePublicKey } from './sshKeys';

/**
 * @description The address runners dial and the check that it really is THIS machine's sshd. A pairing code pins the host key found
 * at that address, so a mistyped address, or one that reaches another machine, must be caught before a code is made — otherwise the
 * runner would be told to trust somebody else's key. The check compares what `ssh-keyscan` reads at the address with what it reads
 * on the machine's own loopback port.
 */

const defaultSshPort = 22;
const scanTimeoutSeconds = 5;
const scanKillMs = 8 * 1000;
const loopbackHosts: readonly string[] = ['127.0.0.1', 'localhost', '::1'];
const loopbackAddress = '127.0.0.1';
/** Host key types in the order a pairing prefers them. */
const hostKeyTypePreference: readonly string[] = ['ssh-ed25519', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521', 'ssh-rsa'];

export interface HubAddress {
  host: string;
  port: number;
}

export type HubAddressParsing = { ok: true; address: HubAddress } | { ok: false; error: string };

/** @description `host`, `host:port`, `[v6]:port` or a bare IPv6 address, as an address (port 22 when none is given). */
export function parseHubAddress(text: string): HubAddressParsing {
  const trimmed = text.trim();
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(trimmed);
  const hostAndPort = /^([^:]+):(\d+)$/.exec(trimmed);
  const [host, portText] = bracketed !== null ? [bracketed[1], bracketed[2]] : hostAndPort !== null ? [hostAndPort[1], hostAndPort[2]] : [trimmed, undefined];
  const port = portText === undefined ? defaultSshPort : Number(portText);
  if (!hubHostSchema.safeParse(host).success) return { ok: false, error: 'the address must be a host name or an IP address, optionally with :port' };
  if (!hubPortSchema.safeParse(port).success) return { ok: false, error: 'the port must be a number from 1 to 65535' };
  return { ok: true, address: { host, port } };
}

/** @description The host key to pin out of `ssh-keyscan` output: the most preferred type that is a well-formed key, as `<type> <base64>`. */
export function parseKeyscanOutput(output: string): string | null {
  const keys = output
    .split('\n')
    .filter((line) => !line.startsWith('#'))
    .map((line) => line.trim().split(/\s+/).slice(1, 3).join(' '))
    .filter((key) => parsePublicKey(key) !== null);
  for (const type of hostKeyTypePreference) {
    const found = keys.find((key) => key.startsWith(`${type} `));
    if (found !== undefined) return found;
  }
  return null;
}

/** @description Reads the ssh host key an address answers with (`null`: nothing answered). */
export type HostKeyScanner = (host: string, port: number) => Promise<string | null>;

/** @description The real scanner: `ssh-keyscan`, bounded. */
export const scanHostKey: HostKeyScanner = (host, port) => new Promise((resolve) => {
  const child = spawn('ssh-keyscan', ['-T', scanTimeoutSeconds.toString(), '-p', port.toString(), host], { stdio: ['ignore', 'pipe', 'ignore'] });
  let output = '';
  const killTimer = setTimeout(() => child.kill('SIGKILL'), scanKillMs);
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { output += chunk; });
  child.on('error', () => {
    clearTimeout(killTimer);
    resolve(null);
  });
  child.on('close', () => {
    clearTimeout(killTimer);
    resolve(parseKeyscanOutput(output));
  });
});

export type HubAddressCheck = { ok: true; hostKey: string; note: string | null } | { ok: false; error: string };

function describeKey(key: string): string {
  return getPublicKeyFingerprint(key);
}

/**
 * @description Does `address` answer with an ssh server, and is it this machine's own? Returns the host key to pin. The machine's own
 * sshd is read on its loopback; when that cannot be read the address is accepted with a note that it was not compared.
 */
export async function checkHubAddress(address: HubAddress, scan: HostKeyScanner): Promise<HubAddressCheck> {
  const found = await scan(address.host, address.port);
  if (found === null) return { ok: false, error: `nothing answers with an ssh host key at ${address.host}:${address.port} (is sshd running, and is the port reachable from outside?)` };
  if (loopbackHosts.includes(address.host)) return { ok: true, hostKey: found, note: null };
  const own = await scan(loopbackAddress, address.port);
  if (own === null) return { ok: true, hostKey: found, note: `this machine's own sshd could not be read on ${loopbackAddress}:${address.port}, so the address was not compared with it` };
  if (own !== found) {
    return { ok: false, error: `${address.host}:${address.port} answers with the ssh key ${describeKey(found)}, not this machine's own (${describeKey(own)}) — it is another machine, or a forward to one` };
  }
  return { ok: true, hostKey: found, note: null };
}
