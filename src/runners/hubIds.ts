import { z } from 'zod';

/**
 * @description The shapes of the identifiers that travel through ssh command lines, file names and the registry. Every one is matched
 * against a strict pattern at the boundary it enters by (a gate's arguments, a pair code, a registry file), so none can carry a quote,
 * a space, a slash or a leading dash into a shell word, a path or an `authorized_keys` option.
 */

/** Ids made by {@link createRandomId}: 12 lowercase hex digits. */
export const hubIdPattern = /^[0-9a-f]{12}$/;

const hostNamePattern = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,252}$/;
/** An IPv6 literal: hex digits, colons (at least two) and an optional dotted tail. */
const ipv6Pattern = /^(?=(?:[^:]*:){2})[0-9A-Fa-f:.]{2,45}$/;
const sshUserPattern = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;
const maxPort = 65535;

export const hubIdSchema = z.string().regex(hubIdPattern, 'must be a 12-digit hex id');
/** A host name or address a runner dials: no spaces, no leading dash or dot, nothing a shell or ssh would read as an option. */
export const hubHostSchema = z.string().refine((host) => hostNamePattern.test(host) || ipv6Pattern.test(host), 'must be a host name or an IP address');
export const hubPortSchema = z.number().int().min(1).max(maxPort);
export const hubSshUserSchema = z.string().regex(sshUserPattern, 'must be a plain account name');

const hostKeyPattern = /^(ssh-ed25519|ecdsa-sha2-nistp(?:256|384|521)|ssh-rsa) [A-Za-z0-9+/]+={0,2}$/;
/** The hub's ssh host key as `<type> <base64>` — what a runner pins. */
export const hubHostKeySchema = z.string().regex(hostKeyPattern, 'must be an ssh public key');
