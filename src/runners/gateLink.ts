import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { Duplex, Writable, type Readable } from 'stream';
import { Client } from 'ssh2';
import { getCaughtErrnoCode } from '../configDirFile';
import { formatGateAnswerHead, linkUserName, noPackageMarker } from './gateProtocol';
import { getRunnerLinkPaths, type HubContext } from './hubPaths';
import { readHubKey } from './hubKey';
import { readPairedFile } from './hubRegistry';
import { recordLinkSource, type LinkSourceChange } from './linkConcern';
import { readLinkState, writeLinkState, type LinkState } from './linkControl';
import { parsePublicKey } from './sshKeys';

/**
 * @description The `link` request: the hub end of a runner's permanent connection.
 *
 * The runner dials the hub with an ordinary ssh client and runs `link`; sshd starts this gate, whose stdin and stdout ARE that
 * channel. Over it the roles turn around: the gate is an ssh CLIENT (`ssh2`) and the runner's built-in server is the SERVER — the gate
 * checks the server's host key against the one pinned at pairing and logs in with the hub key. The gate then listens on
 * `link/<id>.sock`; for every connection to it, it opens a `direct-tcpip` channel to the runner, whose server treats the channel as
 * a socket of its own and speaks ssh over it to whoever is on the other end — stock `ssh` through `runner-proxy`, with everything
 * remote-run needs from ssh (one master, rsync, exec). The runner has no listening port, and the hub's only exposure is the forced
 * command of a key that cannot forward anything.
 *
 * A request from the runner side to open a channel or a forwarding is refused by the client library itself (nothing is registered
 * for it); the gate accepts none.
 *
 * NEWEST LINK WINS: a gate that starts takes the socket path over (it renames its freshly bound socket onto it). The gate that was
 * replaced notices within one check interval — the file at the path is not the one it bound — and leaves, which also ends the runner's
 * half-open old connection. The same check ends a gate whose runner was removed from the registry. A stock sshd with
 * `ClientAliveInterval 0` would never notice a dead peer; the ssh keepalive of this client does.
 */

const loopbackAddress = '127.0.0.1';
/** The port of the `direct-tcpip` request. The runner's server ignores it: every channel goes to its one ssh server. */
const runnerServerPort = 22;
const socketMode = 0o600;
const linkDirMode = 0o700;
const socketSuffixBytes = 3;
const keepaliveCountMax = 3;
/** A link whose heartbeat is younger than this many check intervals was still up when a newer one took its place (see `linkConcern.ts`). */
const liveLinkHeartbeats = 3;
const sshHostKeyAlgorithm = 'ssh-ed25519';

export interface GateLinkTimings {
  /** How often the gate checks that it still holds the socket and that its runner is still paired. */
  checkIntervalMs: number;
  /** How often the ssh keepalive pings the runner. */
  keepaliveIntervalMs: number;
  /** How long the ssh handshake with the runner may take. */
  readyTimeoutMs: number;
}

export const defaultGateLinkTimings: GateLinkTimings = { checkIntervalMs: 10 * 1000, keepaliveIntervalMs: 15 * 1000, readyTimeoutMs: 20 * 1000 };

export interface GateLinkParams {
  ctx: HubContext;
  runnerId: string;
  /** The channel from the runner (the gate's stdin) and to it (stdout). */
  input: Readable;
  output: Writable;
  /** The id of the hub's current package, told to the runner in the marker line (`null` when it cannot be packed). */
  packageId: string | null;
  /** The address the link connects from, as sshd told the gate (`parseSshClientSource`); `null`/absent when it did not. Recorded in the status file. */
  source?: string | null;
  log: (line: string) => void;
  timings?: Partial<GateLinkTimings>;
  now?: () => number;
}

/**
 * A writable that hands everything to `target` and never ends it: the gate's stdout is `process.stdout`, which is not to be closed
 * (the gate ends by leaving), and the ssh client ends its transport when it is done.
 */
function createNonClosingWritable(target: Writable): Writable {
  return new Writable({
    write(chunk: Buffer, _encoding, callback) {
      target.write(chunk, callback);
    },
  });
}

/** @description Run the link until it ends; resolves with the exit code of the gate (0: it held the link and it ended; 1: it never came up). */
export function runGateLink(params: GateLinkParams): Promise<number> {
  const { ctx, runnerId, log } = params;
  const timings = { ...defaultGateLinkTimings, ...params.timings };
  const now = params.now ?? Date.now;
  const paths = getRunnerLinkPaths(ctx.dir, runnerId);

  const runner = readPairedFile(ctx.dir).runners.find((candidate) => candidate.id === runnerId);
  const hubKey = readHubKey(ctx.dir);
  const pinnedHostKey = runner === undefined ? null : parsePublicKey(runner.hostKey);
  if (runner === undefined || hubKey === null || pinnedHostKey === null) {
    log('this runner is not paired here');
    return Promise.resolve(1);
  }
  const pinnedBlob = pinnedHostKey.blob;

  return new Promise<number>((resolve) => {
    const client = new Client();
    const openConnections = new Set<net.Socket>();
    const sinceMs = now();
    let server: net.Server | null = null;
    let boundInode: number | null = null;
    let checkTimer: NodeJS.Timeout | null = null;
    let isReady = false;
    let isFinished = false;
    const duplex = Duplex.from({ readable: params.input, writable: createNonClosingWritable(params.output) });

    const readSocketInode = (): number | null => {
      try {
        return fs.statSync(paths.socket).ino;
      } catch {
        return null;
      }
    };

    const writeState = (state: LinkState): void => {
      try {
        writeLinkState(ctx.dir, runnerId, state);
      } catch (error) {
        // The link works without its status file; the hub only loses "last seen".
        log(`cannot write the link status (${getCaughtErrnoCode(error)})`);
      }
    };

    const finish = (reason: string): void => {
      if (isFinished) return;
      isFinished = true;
      if (checkTimer !== null) clearInterval(checkTimer);
      for (const connection of openConnections) connection.destroy();
      // The socket file is NOT deleted here: checking that the file is still this gate's and then deleting it is two steps, and a
      // successor may rename its own socket onto the path between them. A leftover file only refuses connections (the runner reads as
      // offline); the next gate renames over it and `cutRunnerLink` deletes it.
      server?.close();
      const state = readLinkState(ctx.dir, runnerId);
      if (isReady && state?.pid === process.pid) writeState({ ...state, endedAtMs: now() });
      log(`link ended: ${reason}`);
      client.end();
      duplex.destroy();
      resolve(isReady ? 0 : 1);
    };

    // Where this link comes from, and whether that is another place than the link before it (and whether that one was still up): decided once, when
    // this gate takes the socket over, from the status file the previous gate left, and written with every heartbeat.
    let linkSource: string | null = params.source ?? null;
    let sourceChanges: LinkSourceChange[] = [];
    const recordSource = (): void => {
      const previous = readLinkState(ctx.dir, runnerId);
      const isPreviousLive = previous !== null && previous.endedAtMs === null && now() - previous.lastBeatMs < timings.checkIntervalMs * liveLinkHeartbeats;
      const recorded = recordLinkSource(previous === null ? null : { source: previous.source ?? null, sourceChanges: previous.sourceChanges ?? [] }, params.source ?? null, now(), isPreviousLive);
      linkSource = recorded.source;
      sourceChanges = recorded.sourceChanges;
    };

    const beat = (): void => {
      writeState({ pid: process.pid, sinceMs, lastBeatMs: now(), endedAtMs: null, source: linkSource, sourceChanges });
    };

    const check = (): void => {
      if (readSocketInode() !== boundInode) {
        finish('another link took over');
        return;
      }
      try {
        if (!readPairedFile(ctx.dir).runners.some((candidate) => candidate.id === runnerId)) {
          finish('the runner was removed');
          return;
        }
      } catch {
        // An unreadable registry says nothing about this runner: keep the link and look again at the next check.
      }
      beat();
    };

    const acceptConnection = (connection: net.Socket): void => {
      openConnections.add(connection);
      connection.on('close', () => openConnections.delete(connection));
      connection.on('error', () => connection.destroy());
      try {
        client.forwardOut(loopbackAddress, 0, loopbackAddress, runnerServerPort, (error, channel) => {
          if (error !== undefined) {
            connection.destroy();
            return;
          }
          if (connection.destroyed) {
            channel.destroy();
            return;
          }
          connection.pipe(channel);
          channel.pipe(connection);
          channel.on('close', () => connection.destroy());
          channel.on('error', () => connection.destroy());
          connection.on('close', () => channel.destroy());
        });
      } catch {
        connection.destroy();
      }
    };

    // The socket is bound under a name of its own and RENAMED onto the link's path: renaming is the atomic takeover, and a gate that is
    // replaced closes its server without touching the new gate's file (`net.Server.close()` deletes whatever file is at the path it was
    // bound to — at the link's path that would be the successor's socket).
    const bindSocket = (): void => {
      fs.mkdirSync(path.dirname(paths.socket), { recursive: true, mode: linkDirMode });
      const ownPath = `${paths.socket}.${randomBytes(socketSuffixBytes).toString('hex')}`;
      const listener = net.createServer(acceptConnection);
      server = listener;
      listener.once('error', (error) => finish(`cannot listen on the link socket (${getCaughtErrnoCode(error)})`));
      listener.listen(ownPath, () => {
        try {
          fs.chmodSync(ownPath, socketMode);
          boundInode = fs.statSync(ownPath).ino;
          fs.renameSync(ownPath, paths.socket);
        } catch (error) {
          finish(`cannot publish the link socket (${getCaughtErrnoCode(error)})`);
          return;
        }
        isReady = true;
        recordSource();
        beat();
        checkTimer = setInterval(check, timings.checkIntervalMs);
      });
    };

    params.output.write(formatGateAnswerHead('link', { package: params.packageId ?? noPackageMarker }));
    duplex.on('error', () => finish('the connection to the runner failed'));
    // The channel from the runner ended cleanly (EOF: the ssh session that carried it is gone). A duplex whose readable side ended stays half
    // open, so the ssh client never sees a close — only a failed write or the keepalive's silence would tell, and until then the hub shows a
    // runner that has left as online.
    params.input.once('end', () => finish('the channel from the runner ended'));
    client.on('error', (error) => finish(`ssh: ${error.message}`));
    client.on('close', () => finish('the runner disconnected'));
    client.on('ready', bindSocket);
    client.connect({
      sock: duplex,
      username: linkUserName,
      privateKey: hubKey.privateKey,
      algorithms: { serverHostKey: [sshHostKeyAlgorithm] },
      hostVerifier: (key: Buffer | string) => Buffer.isBuffer(key) && key.equals(pinnedBlob),
      keepaliveInterval: timings.keepaliveIntervalMs,
      keepaliveCountMax,
      readyTimeout: timings.readyTimeoutMs,
    });
  });
}
