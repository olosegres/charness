import type { Socket } from 'net';
import type { Duplex } from 'stream';
import type { Server } from 'ssh2';

/**
 * @description ssh2's `Server.injectSocket` is typed for a `net.Socket` but takes any bidirectional stream «as though it were a TCP
 * socket connection» — the channel the hub's gate speaks over, and a `direct-tcpip` channel of that session, are such streams; this is
 * how the runner serves ssh over a link. The one cast the library's typing needs is here.
 */
export function injectStreamIntoSshServer(server: Server, stream: Duplex): void {
  server.injectSocket(stream as Socket);
}
