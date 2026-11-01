/**
 * @description A listener that owns a port and answers nothing, not even the TCP handshake of a new connection: a child process
 * that listens with a backlog of 1 and blocks its event loop (`Atomics.wait`), so it never accepts. The kernel completes the
 * handshakes of the first connections into the accept queue and, once the queue is full, drops the next SYNs: a connect hangs
 * until the caller's own timeout. This is what a hung or overloaded server looks like to a probe — it holds the port and is
 * neither "refused" nor "connected". The queue is filled here, and that a connect now really hangs is checked, so a kernel that
 * behaves otherwise fails the test as "precondition not met" instead of passing it vacuously.
 *
 * Matches neither runner glob; imported by the OpenCode tests.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import * as net from 'node:net';

/** The listener's queue holds `backlog + 1` connections; more fillers than that are opened so the queue is certainly full. */
const listenBacklog = 1;
const fillerCount = 6;
/** The child ends by itself this long after it started if nobody kills it (a test process that died). */
const listenerLifetimeMs = 60_000;
/** A connect that takes this long without an answer is "hanging". */
const hangingConnectProbeMs = 300;
/** Far above any honest start of the child. */
const listenerStartTimeoutMs = 15_000;

const listenerScript = `
const net = require('node:net');
const server = net.createServer(() => {});
server.listen({ host: '127.0.0.1', port: Number(process.argv[1]), backlog: ${listenBacklog} }, () => {
  process.stdout.write(server.address().port + '\\n');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${listenerLifetimeMs});
  process.exit(0);
});
`;

export interface FullBacklogListener {
  port: number;
  /** Kill the listener and drop the filler connections. */
  stop(): void;
}

/** Whether a new connection to the port gets no answer (neither accepted nor refused) within the probe time. */
function checkIsConnectHanging(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.setTimeout(hangingConnectProbeMs);
    socket.once('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(false));
    socket.once('timeout', () => {
      socket.destroy();
      resolve(true);
    });
  });
}

/**
 * @description Start the listener (on `options.port`, or a free one) and fill its accept queue. Rejects, naming the unmet
 * precondition, when the port does not behave as a full queue does.
 */
export async function startFullBacklogListener(options: { port?: number } = {}): Promise<FullBacklogListener> {
  const child: ChildProcess = spawn(process.execPath, ['-e', listenerScript, (options.port ?? 0).toString()], { stdio: ['ignore', 'pipe', 'inherit'] });
  const fillers: net.Socket[] = [];
  const stop = (): void => {
    child.kill('SIGKILL');
    for (const filler of fillers) filler.destroy();
  };
  try {
    const port = await new Promise<number>((resolve, reject) => {
      const startTimer = setTimeout(() => reject(new Error('the full-backlog listener did not start')), listenerStartTimeoutMs);
      child.once('error', reject);
      child.once('exit', () => reject(new Error('the full-backlog listener exited before it listened')));
      child.stdout?.once('data', (chunk: Buffer) => {
        clearTimeout(startTimer);
        resolve(Number.parseInt(chunk.toString().trim(), 10));
      });
    });
    for (let index = 0; index < fillerCount; index += 1) {
      const filler = net.connect({ host: '127.0.0.1', port });
      filler.on('error', () => {});
      fillers.push(filler);
    }
    if (!(await checkIsConnectHanging(port))) {
      throw new Error('precondition not met: a connect to the port is still accepted or refused although its accept queue should be full');
    }
    return { port, stop };
  } catch (error) {
    stop();
    throw error;
  }
}
