/**
 * @description The connections the bot keeps pooled to the Bot API, and what happens when the server closed one the bot
 * still held.
 *
 * The bot keeps its connections alive and reuses them. A server closes an idle one after a while; a client that learns
 * of it only when it writes its next request (a process starved of CPU, whose event loop has not yet read the close)
 * gets «socket hang up» / `ECONNRESET` / `EPIPE` for a request the server never saw. Two layers:
 *
 *  1. The agent closes a connection that sat idle in the pool for {@link botApiFreeSocketTimeoutMs} itself, long before
 *     the server's own idle limit (api.telegram.org kept an idle HTTP/1.1 connection for more than 130 s when measured),
 *     so an ordinary pause between two sends never meets a connection the server closed. A client stalled past the
 *     server's limit cannot be helped that way: its timers do not run either, and the stale connection is still in the
 *     pool when the next request starts.
 *  2. {@link installReusedConnectionRetry} retries such a request ONCE, on a fresh connection. It does so only when the
 *     request rode a REUSED connection and failed before any response byte (`ClientRequest.reusedSocket` is the
 *     documented signal Node gives for exactly this), so the server did not process it and a retry cannot post twice.
 *     A timeout, an abort, a failure after the response started and a first-time connection are never retried.
 */

import * as http from 'http';
import * as https from 'https';
import { AsyncLocalStorage } from 'async_hooks';
import { Readable } from 'stream';
import type { CallApiHost } from '../../outputTrace';
import { checkIsConnectionResetError } from '../../sendErrorClassifier';

/**
 * @description How long a connection may idle in the pool before the agent closes it. Well under the server's own limit
 * (the real Bot API held an idle HTTP/1.1 connection for more than 130 s when measured, and sends no `Keep-Alive` hint),
 * long enough to span the pauses between a topic's sends and the typing indicator, so a streaming reply keeps its warm
 * connection.
 *
 * It is a socket idle timeout, applied by Node only to FREE sockets (`http.Agent` destroys a socket on `timeout` only if
 * it sits in the free list): a long poll that waits 50 s for an update is not cut.
 */
export const botApiFreeSocketTimeoutMs = 30_000;

/** The initial delay of the TCP keep-alive probes on a pooled connection. */
const tcpKeepAliveInitialDelayMs = 10_000;

/** The log line of a retry: `<prefix> (<method>): …`. Never carries the bot token. */
export const reusedConnectionRetryLogPrefix = '[telegram] pooled connection was closed by the server, retrying once on a fresh one';

/** How deep a payload is searched for a one-shot stream (`{ media: [{ media: { source: stream } }] }` is the deepest shape). */
const maxPayloadDepth = 5;

/** What one `callApi` learns from the agent about its own request. */
interface ReuseProbe {
  /** The request rode a reused (pooled) connection that failed before any response byte. */
  isPooledConnectionLost: boolean;
}

/**
 * The probe of the `callApi` that is running, handed to the agent through the async context: node-fetch sits between the
 * two and keeps nothing of the request on the error it throws.
 */
const reuseProbeStorage = new AsyncLocalStorage<ReuseProbe>();

/** Mark the running `callApi`'s probe when this reused request fails before its response starts. */
function watchReusedRequest(request: http.ClientRequest): void {
  const probe = reuseProbeStorage.getStore();
  if (!probe) return;
  let isResponseStarted = false;
  request.once('response', () => { isResponseStarted = true; });
  request.once('error', () => {
    if (!isResponseStarted) probe.isPooledConnectionLost = true;
  });
}

/** `agent.reuseSocket` is called by Node, synchronously inside `http.request`, when a pooled socket is handed to a request. */
function trackReusedConnections<TAgent extends http.Agent>(agent: TAgent): TAgent {
  const reuseSocket = agent.reuseSocket.bind(agent);
  agent.reuseSocket = (socket, request) => {
    reuseSocket(socket, request);
    watchReusedRequest(request);
  };
  return agent;
}

/** The pooling both agents share. `freeSocketTimeoutMs` is a test seam; production keeps {@link botApiFreeSocketTimeoutMs}. */
function getBotApiAgentOptions(freeSocketTimeoutMs: number): http.AgentOptions {
  return { keepAlive: true, keepAliveMsecs: tcpKeepAliveInitialDelayMs, family: 4, timeout: freeSocketTimeoutMs };
}

/**
 * @description The keep-alive, IPv4-pinned `https.Agent` the Bot API client and the file downloads ride: a warm
 * connection avoids the cold-handshake stall.
 */
export function createBotApiHttpsAgent(freeSocketTimeoutMs: number = botApiFreeSocketTimeoutMs): https.Agent {
  return trackReusedConnections(new https.Agent(getBotApiAgentOptions(freeSocketTimeoutMs)));
}

/**
 * @description The same pooling for an `http://` API root (the process-level tests' fake on loopback): Telegraf drops its
 * agent for such a root and node-fetch then falls back to the global agent, which has other limits.
 */
export function createBotApiHttpAgent(freeSocketTimeoutMs: number = botApiFreeSocketTimeoutMs): http.Agent {
  return trackReusedConnections(new http.Agent(getBotApiAgentOptions(freeSocketTimeoutMs)));
}

/**
 * A file handed to Telegraf as a stream can be read once: sending the payload again would upload what is left of it. Also
 * skips a Buffer (its bytes are not walked) and bounds the walk.
 */
function checkIsPayloadReplayable(payload: object, depth = 0): boolean {
  if (payload instanceof Readable) return false;
  if (ArrayBuffer.isView(payload) || depth >= maxPayloadDepth) return true;
  return Object.values(payload).every((value) => typeof value !== 'object' || value === null || checkIsPayloadReplayable(value, depth + 1));
}

/** Close every idle pooled connection: one that went stale was idle just as long as its siblings, so a retry must not meet another. */
function destroyFreeSockets(agent: http.Agent): void {
  for (const sockets of Object.values(agent.freeSockets)) {
    for (const socket of [...(sockets ?? [])]) socket.destroy();
  }
}

/**
 * @description Wrap `host.callApi` so a request that rode a reused connection and was dropped before any response byte is
 * sent again ONCE on a fresh connection (see the module description for why that cannot post twice). A second failure is
 * the caller's, as before. `agent` is the one `host` sends through. Sits BELOW the send queue, the global pacer and the 429
 * retry — the retry takes no permit, the thread's order is kept — and above the output trace, which therefore shows both
 * attempts.
 */
export function installReusedConnectionRetry(host: CallApiHost, agent: http.Agent): void {
  const originalCallApi = host.callApi.bind(host);
  host.callApi = async (method, payload, options) => {
    const probe: ReuseProbe = { isPooledConnectionLost: false };
    try {
      return await reuseProbeStorage.run(probe, () => originalCallApi(method, payload, options));
    } catch (error) {
      const isRetryable = probe.isPooledConnectionLost && checkIsConnectionResetError(error) && checkIsPayloadReplayable(payload);
      if (!isRetryable) throw error;
      console.warn(`${reusedConnectionRetryLogPrefix} (${method})`);
      destroyFreeSockets(agent);
      return originalCallApi(method, payload, options);
    }
  };
}
