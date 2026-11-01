import * as net from 'net';
import type { Readable, Writable } from 'stream';

/**
 * @description `charness runner-proxy <socket>` — the `ProxyCommand` of the ssh calls to a paired runner: it joins ssh's stdin and
 * stdout to the unix socket that the runner's gate listens on (`gateLink.ts`). When nothing listens, the runner is offline: the
 * proxy says so on stderr, which ssh shows as the reason, and exits 255 — the status ssh itself uses for a failed connection, which
 * remote-run already treats as «the connection was lost».
 */

const connectionFailedExitCode = 255;

export interface RunnerProxyIo {
  stdin: Readable;
  stdout: Writable;
  stderr: Writable;
}

/** @description Join `io` to the socket; resolves with the exit code when either side ends. */
export function runRunnerProxy(socketPath: string, io: RunnerProxyIo): Promise<number> {
  return new Promise((resolve) => {
    const socket = net.connect(socketPath);
    let isConnected = false;
    socket.once('connect', () => {
      isConnected = true;
      io.stdin.pipe(socket);
      socket.pipe(io.stdout, { end: false });
    });
    socket.once('error', () => {
      if (!isConnected) io.stderr.write('charness runner-proxy: the runner is not connected\n');
      socket.destroy();
    });
    socket.once('close', () => {
      io.stdin.unpipe(socket);
      resolve(isConnected ? 0 : connectionFailedExitCode);
    });
    io.stdin.once('end', () => socket.end());
  });
}
