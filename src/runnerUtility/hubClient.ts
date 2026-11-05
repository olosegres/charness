import { Client, type ClientChannel, type ServerHostKeyAlgorithm } from 'ssh2';
import type { z } from 'zod';
import { formatLidReportBody, lidReplySchema, readUntilGateMarker, type GateMarker, type GateRequest } from '../runners/gateProtocol';
import type { LidReportResult } from './lidState';
import { parsePublicKey } from '../runners/sshKeys';

/**
 * @description The runner's side of every conversation with the hub's sshd: an ssh2 client that pins the hub's host key (the one in the
 * pairing code, then in `config.json`), logs in with a key, and runs one of the gate's request words (`redeem`, `package`, `link`,
 * `unpair`). Whatever the hub's shell printed before the gate ran is skipped up to the marker line (`readUntilGateMarker`).
 */

const connectReadyTimeoutMs = 20 * 1000;
const keepaliveIntervalMs = 15 * 1000;
const keepaliveCountMax = 3;
const clientAuthenticationLevel = 'client-authentication';
const hostDeniedText = 'Host denied';

export interface HubEndpoint {
  host: string;
  port: number;
  user: string;
  /** `<type> <base64>`: the only host key that is accepted. */
  hostKey: string;
}

export type HubConnectionFailure = 'auth' | 'hostKey' | 'network';

/** @description Why the hub could not be reached: the key was refused (`auth` — for a paired runner, it was removed), the host key is not the pinned one, or the network/sshd. */
export class HubConnectionError extends Error {
  readonly failure: HubConnectionFailure;

  constructor(failure: HubConnectionFailure, message: string) {
    super(message);
    this.name = 'HubConnectionError';
    this.failure = failure;
  }
}

/** The signature algorithms the client offers for each key type: only those of the pinned key, so a hub with several host keys cannot answer with another one. */
const hostKeyAlgorithms: Record<string, ServerHostKeyAlgorithm[]> = {
  'ssh-ed25519': ['ssh-ed25519'],
  'ecdsa-sha2-nistp256': ['ecdsa-sha2-nistp256'],
  'ecdsa-sha2-nistp384': ['ecdsa-sha2-nistp384'],
  'ecdsa-sha2-nistp521': ['ecdsa-sha2-nistp521'],
  'ssh-rsa': ['rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa'],
};

function classifyFailure(error: Error & { level?: string }): HubConnectionError {
  if (error.level === clientAuthenticationLevel) return new HubConnectionError('auth', 'the hub refused the runner\'s key');
  if (error.message.includes(hostDeniedText)) return new HubConnectionError('hostKey', 'the hub\'s ssh host key is not the one pinned at pairing');
  return new HubConnectionError('network', error.message);
}

/** @description Connect and log in; resolves with the ready client. The caller ends it. */
export function connectToHub(endpoint: HubEndpoint, privateKey: string): Promise<Client> {
  const pinned = parsePublicKey(endpoint.hostKey);
  const serverHostKey = pinned === null ? undefined : hostKeyAlgorithms[pinned.type];
  if (pinned === null || serverHostKey === undefined) return Promise.reject(new HubConnectionError('hostKey', 'the pinned hub host key does not read'));
  const pinnedBlob = pinned.blob;
  return new Promise<Client>((resolve, reject) => {
    const client = new Client();
    let isReady = false;
    client.once('ready', () => {
      isReady = true;
      resolve(client);
    });
    // Kept for the life of the client: an error after `ready` (a reset connection) must never be an unhandled event; whoever uses the
    // client listens for `close` / `error` itself.
    client.on('error', (error: Error) => {
      if (isReady) return;
      client.end();
      reject(classifyFailure(error));
    });
    client.connect({
      host: endpoint.host,
      port: endpoint.port,
      username: endpoint.user,
      privateKey,
      algorithms: { serverHostKey },
      hostVerifier: (key: Buffer | string) => Buffer.isBuffer(key) && key.equals(pinnedBlob),
      keepaliveInterval: keepaliveIntervalMs,
      keepaliveCountMax,
      readyTimeout: connectReadyTimeoutMs,
    });
  });
}

export interface GateAnswer {
  marker: GateMarker;
  /** The channel, positioned right after the marker line (what came with it is put back). */
  channel: ClientChannel;
}

/**
 * @description Run the gate request `request` and read its marker line; `null` when the answer has none (the hub refused, or the key line is gone). `body` is sent as stdin and
 * ends it; without one stdin stays open (`link`). `command` is the text actually run when it is more than the word (`link lid=closed`, `formatLinkCommand`).
 */
export function callGate(client: Client, request: GateRequest, body: string | null, command: string = request): Promise<GateAnswer | null> {
  return new Promise((resolve, reject) => {
    client.exec(command, async (error, channel) => {
      if (error !== undefined) {
        reject(new HubConnectionError('network', error.message));
        return;
      }
      if (body !== null) channel.end(body);
      const read = await readUntilGateMarker(channel);
      if (read === null || read.marker.request !== request) {
        channel.destroy();
        resolve(null);
        return;
      }
      channel.unshift(read.rest);
      resolve({ marker: read.marker, channel });
    });
  });
}

/** @description Everything the channel still sends, as text. */
export async function readChannelText(channel: ClientChannel): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of channel) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

/** @description A gate request whose answer is one JSON line (`redeem`, `cancel`, `identity`, `unpair`), parsed with `schema`. */
export async function requestGateJson<TReply>(client: Client, request: 'redeem' | 'cancel' | 'unpair' | 'identity', body: string | null, schema: z.ZodType<TReply>): Promise<TReply> {
  const answer = await callGate(client, request, body ?? '');
  if (answer === null) throw new HubConnectionError('network', 'the hub did not answer the request');
  const text = await readChannelText(answer.channel);
  let parsedJson: object;
  try {
    parsedJson = JSON.parse(text);
  } catch {
    throw new HubConnectionError('network', 'the hub\'s answer is not valid JSON');
  }
  const parsed = schema.safeParse(parsedJson);
  if (!parsed.success) throw new HubConnectionError('network', 'the hub\'s answer is not what this version expects');
  return parsed.data;
}

/**
 * @description Tell the hub whether this Mac's lid is closed with nothing keeping it awake (the `lid` request), naming the link it is said on (`linkEpoch`, from the `link` marker;
 * `null` for a hub that named none). `taken`: the hub took it; `refused`: it answered and would not (a gate that does not know the word has no marker; a body it rejects says
 * `ok:false`) — a retry now is refused the same; a connection that cannot be used THROWS like any gate request, and the caller calls that `failed`.
 */
export async function sendLidReport(client: Client, isClosed: boolean, linkEpoch: string | null): Promise<LidReportResult> {
  const epochMs = linkEpoch === null || !/^\d{1,16}$/.test(linkEpoch) ? null : Number(linkEpoch);
  const answer = await callGate(client, 'lid', formatLidReportBody(isClosed, epochMs));
  if (answer === null) return 'refused';
  try {
    return lidReplySchema.parse(JSON.parse(await readChannelText(answer.channel))).ok ? 'taken' : 'refused';
  } catch {
    return 'refused';
  }
}
