import * as os from 'os';
import { checkHubAddress, type HostKeyScanner, type HubAddress } from './hubAddress';

/**
 * @description The public address `/runners` proposes to the operator at the first pairing: the globally routable addresses of this
 * machine's own network interfaces, on the ssh port 22, the first of which that answers with THIS machine's own sshd (the check of
 * `hubAddress.ts`). A machine behind NAT (a cloud VPS whose public address lives on the provider's router) has none, and the
 * operator types one — nothing is asked of a third-party service to learn it.
 */

const defaultCandidatePort = 22;
const ipv6GlobalUnicastMask = 0xe000;
const ipv6GlobalUnicastPrefix = 0x2000;
const hexRadix = 16;
const octetCount = 4;

/** @description `host:port`, a bare IPv6 host in brackets (`[2001:db8::1]:22`) — the spelling `parseHubAddress` reads back. */
export function formatHubAddress(address: HubAddress): string {
  return address.host.includes(':') ? `[${address.host}]:${address.port}` : `${address.host}:${address.port}`;
}

function checkIsPublicIpv4(address: string): boolean {
  const octets = address.split('.').map(Number);
  if (octets.length !== octetCount || octets.some((octet) => !Number.isInteger(octet))) return false;
  const [first, second] = octets;
  const isPrivateOrReserved =
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    first >= 224;
  return !isPrivateOrReserved;
}

/** Global unicast is 2000::/3; a link-local, unique-local or loopback address never is. */
function checkIsPublicIpv6(address: string): boolean {
  const firstGroup = Number.parseInt(address.split(':')[0], hexRadix);
  return Number.isInteger(firstGroup) && (firstGroup & ipv6GlobalUnicastMask) === ipv6GlobalUnicastPrefix;
}

/** @description The globally routable addresses among `interfaces` (default: this machine's), IPv4 before IPv6, each once. */
export function listPublicAddressCandidates(interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): string[] {
  const addresses = Object.values(interfaces).flatMap((entries) => entries ?? []).filter((entry) => !entry.internal);
  const ipv4 = addresses.filter((entry) => entry.family === 'IPv4' && checkIsPublicIpv4(entry.address)).map((entry) => entry.address);
  const ipv6 = addresses.filter((entry) => entry.family === 'IPv6' && checkIsPublicIpv6(entry.address)).map((entry) => entry.address);
  return [...new Set([...ipv4, ...ipv6])];
}

export interface ProposedHubAddress {
  address: HubAddress;
  hostKey: string;
}

/**
 * @description The first of `candidates` (on port 22) that answers with this machine's own ssh host key, or `null` when none does.
 * A candidate whose own sshd could not be compared (`note` set) is not proposed: a proposal is a promise that the check passed.
 */
export async function findProposedHubAddress(candidates: readonly string[], scan: HostKeyScanner): Promise<ProposedHubAddress | null> {
  for (const host of candidates) {
    const address: HubAddress = { host, port: defaultCandidatePort };
    const check = await checkHubAddress(address, scan);
    if (check.ok && check.note === null) return { address, hostKey: check.hostKey };
  }
  return null;
}
