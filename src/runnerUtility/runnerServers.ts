import type { Duplex } from 'stream';
import { Server, utils, type AuthContext } from 'ssh2';
import { parsePublicKey } from '../runners/sshKeys';
import { serveExec, type ExecTracker } from './execSession';
import { injectStreamIntoSshServer } from './injectStream';

/**
 * @description The runner's built-in ssh servers. There is no sshd on the runner and nothing listens: the hub's gate speaks ssh over the
 * channel of the runner's own outbound connection, with the runner as the SERVER (see `src/runners/gateLink.ts`). Two servers, one inside
 * the other:
 *
 *   link server     the ssh session of the gate itself; it accepts a `direct-tcpip` channel and hands that channel to
 *   session server  an ordinary ssh server for the hub's stock `ssh` (ControlMaster, rsync, `exec`) — one channel per connection of the
 *                   hub's socket
 *
 * Both accept ONE key — the hub's, checked with a real signature — and both refuse everything that is not an `exec`: no shell, no pty,
 * no subsystem, no x11, no agent, no port or unix-socket forwarding in either direction. `env` requests are accepted and ignored: a job
 * never gets variables from the hub's ssh client.
 */

export interface RunnerServersOptions {
  /** The PEM/OpenSSH private key of the built-in server (its public half is pinned by the hub). */
  serverPrivateKey: string;
  /** `ssh-ed25519 <base64>`: the only key that may log in. */
  hubPublicKey: string;
  /** The environment for the next command; asked per command. */
  readEnv: () => NodeJS.ProcessEnv;
  cwd: string;
  /** Called with the number of running commands whenever it changes. */
  onActiveCountChange?: (activeCount: number) => void;
}

export interface RunnerServers {
  /** Serve ssh over `stream` (the exec channel to the hub) as the link server. */
  acceptLinkStream: (stream: Duplex) => void;
  getActiveExecCount: () => number;
}

/** @description The check shared by both servers: the hub's key only, and the signature must verify (the first, unsigned query only asks «would this key do?»). */
export function createHubAuthenticator(hubPublicKey: string): (auth: AuthContext) => void {
  const hubBlob = parsePublicKey(hubPublicKey)?.blob;
  const hubKey = utils.parseKey(hubPublicKey);
  if (hubBlob === undefined || hubKey instanceof Error) throw new Error('the hub key does not read as an ssh public key');
  return (auth) => {
    if (auth.method !== 'publickey' || !auth.key.data.equals(hubBlob)) {
      auth.reject();
      return;
    }
    if (auth.signature === undefined) {
      auth.accept();
      return;
    }
    if (auth.blob !== undefined && hubKey.verify(auth.blob, auth.signature, auth.hashAlgo)) auth.accept();
    else auth.reject();
  };
}

export function createRunnerServers(options: RunnerServersOptions): RunnerServers {
  const authenticate = createHubAuthenticator(options.hubPublicKey);
  let activeExecCount = 0;
  const tracker: ExecTracker = {
    started: () => {
      activeExecCount += 1;
      options.onActiveCountChange?.(activeExecCount);
    },
    ended: () => {
      activeExecCount -= 1;
      options.onActiveCountChange?.(activeExecCount);
    },
  };

  const sessionServer = new Server({ hostKeys: [options.serverPrivateKey] }, (connection) => {
    connection.on('error', () => undefined);
    connection.on('authentication', authenticate);
    connection.on('request', (_accept, reject) => reject?.());
    connection.on('tcpip', (_accept, reject) => reject());
    connection.on('openssh.streamlocal', (_accept, reject) => reject());
    connection.on('ready', () => {
      connection.on('session', (acceptSession) => {
        const session = acceptSession();
        session.on('env', (accept) => accept?.());
        for (const refused of ['pty', 'shell', 'subsystem', 'x11'] as const) session.on(refused, (_accept: unknown, reject: (() => boolean) | undefined) => reject?.());
        session.on('exec', (accept, _reject, info) => {
          serveExec(accept(), info.command, { env: options.readEnv(), cwd: options.cwd, tracker });
        });
      });
    });
  });

  const linkServer = new Server({ hostKeys: [options.serverPrivateKey] }, (connection) => {
    connection.on('error', () => undefined);
    connection.on('authentication', authenticate);
    connection.on('request', (_accept, reject) => reject?.());
    connection.on('ready', () => {
      connection.on('tcpip', (accept) => injectStreamIntoSshServer(sessionServer, accept()));
    });
  });

  return {
    acceptLinkStream: (stream) => injectStreamIntoSshServer(linkServer, stream),
    getActiveExecCount: () => activeExecCount,
  };
}
