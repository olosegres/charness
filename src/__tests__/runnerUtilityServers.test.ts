/**
 * @description `runnerUtility/runnerServers.ts` + `execSession.ts`: the runner's built-in ssh servers, driven the way the hub drives them.
 * The «gate» is an ssh2 client on a socket (the link server's session); each `forwardOut` becomes a channel that carries a second ssh
 * session (the hub's stock ssh). Only the hub's key gets in; only `exec` is served, in a clean environment; a closed channel closes the
 * pipes but does not kill the command; forwarding and pty/shell/subsystem requests are refused.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import type { Readable } from 'stream';
import { EventEmitter } from 'events';
import { Client, utils, type ClientChannel, type NoneAuthContext, type PublicKeyAuthContext } from 'ssh2';
import { createHubAuthenticator, createRunnerServers, type RunnerServers } from '../runnerUtility/runnerServers';
import { generateEd25519KeyPair, parsePublicKey, type SshKeyPair } from '../runners/sshKeys';
import { waitUntil } from './runnersTestKit';

const hubKey = generateEd25519KeyPair('hub');
const serverKey = generateEd25519KeyPair('runner-host');
const strangerKey = generateEd25519KeyPair('stranger');

let root = '';
let servers: RunnerServers;
let listener: net.Server;
let socketPath = '';
let activeCounts: number[] = [];
/** What the next command's environment is: a test that wants a command to fail to start points PATH at nothing. */
let jobPath = process.env.PATH ?? '';
const clients: Client[] = [];

function connectClient(options: { sock: Readable; key: SshKeyPair }): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    clients.push(client);
    client.once('ready', () => resolve(client));
    client.once('error', reject);
    // The sock is a net.Socket or a channel: both are duplex streams.
    client.connect({ sock: options.sock, username: 'hub', privateKey: options.key.privateKey, hostVerifier: () => true });
  });
}

/** The gate's side: ssh over a connection to the link server. */
async function connectLink(key: SshKeyPair = hubKey): Promise<Client> {
  const socket = net.connect(socketPath);
  await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  return connectClient({ sock: socket, key });
}

/** The hub's stock ssh: a session carried by a `direct-tcpip` channel of the link. */
async function connectSession(link: Client, key: SshKeyPair = hubKey): Promise<Client> {
  const channel = await new Promise<ClientChannel>((resolve, reject) => {
    link.forwardOut('127.0.0.1', 0, '127.0.0.1', 22, (error, stream) => (error === undefined ? resolve(stream) : reject(error)));
  });
  return connectClient({ sock: channel, key });
}

interface ExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: string | null;
}

function exec(client: Client, command: string, options: { stdin?: string; env?: Record<string, string> } = {}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    client.exec(command, { env: options.env }, (error, stream) => {
      if (error !== undefined) {
        reject(error);
        return;
      }
      const result: ExecResult = { stdout: '', stderr: '', code: null, signal: null };
      stream.on('data', (chunk: Buffer) => { result.stdout += chunk.toString('utf8'); });
      stream.stderr.on('data', (chunk: Buffer) => { result.stderr += chunk.toString('utf8'); });
      stream.on('exit', (code: number | null, signal?: string) => {
        result.code = code;
        result.signal = signal ?? null;
      });
      stream.on('close', () => resolve(result));
      if (options.stdin !== undefined) stream.end(options.stdin);
    });
  });
}

describe('the runner\'s built-in servers', () => {
  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'srv-'));
    socketPath = path.join(root, 'link.sock');
    activeCounts = [];
    jobPath = process.env.PATH ?? '';
    servers = createRunnerServers({
      serverPrivateKey: serverKey.privateKey,
      hubPublicKey: hubKey.publicKey,
      readEnv: () => ({ PATH: jobPath, HOME: root, ONLY_THIS: '1' }),
      cwd: root,
      onActiveCountChange: (count) => activeCounts.push(count),
    });
    listener = net.createServer((socket) => {
      socket.on('error', () => undefined);
      servers.acceptLinkStream(socket);
    });
    await new Promise<void>((resolve) => { listener.listen(socketPath, resolve); });
  });
  afterEach(() => {
    for (const client of clients.splice(0)) client.destroy();
    listener.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('runs a command: stdout, stderr and the exit code come back through the nested session', async () => {
    const session = await connectSession(await connectLink());
    const result = await exec(session, 'printf out; printf err >&2; exit 3');
    assert.deepEqual(result, { stdout: 'out', stderr: 'err', code: 3, signal: null });
  });

  it('the client\'s EOF is the command\'s EOF', async () => {
    const session = await connectSession(await connectLink());
    assert.equal((await exec(session, 'cat', { stdin: 'hello' })).stdout, 'hello');
  });

  it('runs in a clean environment: the utility\'s own variables do not reach the job, and a client `env` request is ignored', async () => {
    process.env.SECRET_OF_THE_UTILITY = 'leak';
    try {
      const session = await connectSession(await connectLink());
      const result = await exec(session, 'env; echo "[$FROM_CLIENT]"', { env: { FROM_CLIENT: 'x' } });
      assert.ok(result.stdout.includes('ONLY_THIS=1'));
      assert.ok(!result.stdout.includes('SECRET_OF_THE_UTILITY'));
      assert.ok(result.stdout.includes('[]'));
    } finally {
      delete process.env.SECRET_OF_THE_UTILITY;
    }
  });

  it('reports a signal that ended the command', async () => {
    const session = await connectSession(await connectLink());
    const result = await exec(session, 'kill -TERM $$');
    assert.equal(result.signal, 'TERM');
  });

  it('a command keeps running when its channel is closed — only its pipes close — and counts as busy until it ends', async () => {
    const session = await connectSession(await connectLink());
    const markerPath = path.join(root, 'finished');
    await new Promise<void>((resolve, reject) => {
      session.exec(`sleep 0.4; echo done > ${markerPath}`, (error, stream) => {
        if (error !== undefined) {
          reject(error);
          return;
        }
        stream.close();
        resolve();
      });
    });
    await waitUntil(() => servers.getActiveExecCount() === 1, 'the command to count as running');
    assert.equal(fs.existsSync(markerPath), false);
    await waitUntil(() => fs.existsSync(markerPath), 'the command to finish although its channel was closed', 10_000);
    await waitUntil(() => servers.getActiveExecCount() === 0, 'the command to stop counting');
    assert.deepEqual(activeCounts, [1, 0]);
  });

  it('a command that cannot start is finished once: the busy count never goes negative, and the next command still counts', async () => {
    const session = await connectSession(await connectLink());
    jobPath = path.join(root, 'no-such-folder');
    const failed = await exec(session, 'true');
    assert.equal(failed.code, 127);
    assert.match(failed.stderr, /cannot start the command/);
    await waitUntil(() => activeCounts.length >= 2, 'the failed command to be counted in and out');
    assert.deepEqual(activeCounts, [1, 0]);
    assert.equal(servers.getActiveExecCount(), 0);

    jobPath = process.env.PATH ?? '';
    const markerPath = path.join(root, 'second-finished');
    await new Promise<void>((resolve, reject) => {
      session.exec(`sleep 0.4; echo done > ${markerPath}`, (error, stream) => {
        if (error !== undefined) {
          reject(error);
          return;
        }
        stream.close();
        resolve();
      });
    });
    await waitUntil(() => servers.getActiveExecCount() === 1, 'the next command to count as running — not as idle');
    await waitUntil(() => fs.existsSync(markerPath), 'the next command to finish', 10_000);
    await waitUntil(() => servers.getActiveExecCount() === 0, 'the next command to stop counting');
    assert.deepEqual(activeCounts, [1, 0, 1, 0]);
  });

  it('serves nothing but exec: no pty, no shell, no subsystem', async () => {
    const session = await connectSession(await connectLink());
    await assert.rejects(new Promise((resolve, reject) => { session.exec('true', { pty: true }, (error, stream) => (error === undefined ? resolve(stream) : reject(error))); }));
    await assert.rejects(new Promise((resolve, reject) => { session.shell((error, stream) => (error === undefined ? resolve(stream) : reject(error))); }));
    await assert.rejects(new Promise((resolve, reject) => { session.subsys('sftp', (error, stream) => (error === undefined ? resolve(stream) : reject(error))); }));
  });

  it('forwards nothing in either direction through the session', async () => {
    const session = await connectSession(await connectLink());
    await assert.rejects(new Promise((resolve, reject) => { session.forwardOut('127.0.0.1', 0, '127.0.0.1', 22, (error, stream) => (error === undefined ? resolve(stream) : reject(error))); }));
    await assert.rejects(new Promise((resolve, reject) => { session.forwardIn('127.0.0.1', 0, (error, port) => (error === undefined ? resolve(port) : reject(error))); }));
  });

  it('the link server itself serves no session: it only passes channels on', async () => {
    const link = await connectLink();
    await assert.rejects(new Promise((resolve, reject) => { link.exec('true', (error, stream) => (error === undefined ? resolve(stream) : reject(error))); }));
  });

  it('refuses every key but the hub\'s, at the link and at the session', async () => {
    await assert.rejects(connectLink(strangerKey), /authentication methods failed/);
    const link = await connectLink();
    await assert.rejects(connectSession(link, strangerKey), /authentication methods failed/);
  });

  it('serves several sessions over one link at once', async () => {
    const link = await connectLink();
    const [first, second] = await Promise.all([connectSession(link), connectSession(link)]);
    const results = await Promise.all([exec(first, 'echo one'), exec(second, 'echo two')]);
    assert.deepEqual(results.map((result) => result.stdout.trim()), ['one', 'two']);
  });
});

describe('the hub authenticator', () => {
  const hubBlob = parsePublicKey(hubKey.publicKey)?.blob ?? Buffer.alloc(0);
  const signedData = Buffer.from('the data the client signs');

  function sign(key: SshKeyPair): Buffer {
    const parsed = utils.parseKey(key.privateKey);
    if (parsed instanceof Error) throw parsed;
    const signature = parsed.sign(signedData);
    if (signature instanceof Error) throw signature;
    return signature;
  }

  function judge(request: { algo?: string; data?: Buffer; signature?: Buffer; blob?: Buffer; hashAlgo?: string }): 'accepted' | 'rejected' | 'unanswered' {
    let outcome: 'accepted' | 'rejected' | 'unanswered' = 'unanswered';
    const auth: PublicKeyAuthContext = Object.assign(new EventEmitter(), {
      username: 'hub',
      service: 'ssh-connection',
      method: 'publickey' as const,
      key: { algo: request.algo ?? 'ssh-ed25519', data: request.data ?? hubBlob },
      signature: request.signature,
      blob: request.blob,
      hashAlgo: request.hashAlgo,
      accept: () => { outcome = 'accepted'; },
      reject: () => { outcome = 'rejected'; },
    });
    createHubAuthenticator(hubKey.publicKey)(auth);
    return outcome;
  }

  function judgeNoneMethod(): 'accepted' | 'rejected' | 'unanswered' {
    let outcome: 'accepted' | 'rejected' | 'unanswered' = 'unanswered';
    const auth: NoneAuthContext = Object.assign(new EventEmitter(), {
      username: 'hub',
      service: 'ssh-connection',
      method: 'none' as const,
      accept: () => { outcome = 'accepted'; },
      reject: () => { outcome = 'rejected'; },
    });
    createHubAuthenticator(hubKey.publicKey)(auth);
    return outcome;
  }

  it('accepts the hub\'s key with a valid signature, and the unsigned «would this key do?» query', () => {
    assert.equal(judge({ signature: sign(hubKey), blob: signedData }), 'accepted');
    assert.equal(judge({}), 'accepted');
  });

  it('refuses a signature made by another key under the hub\'s public key', () => {
    assert.equal(judge({ signature: sign(strangerKey), blob: signedData }), 'rejected');
  });

  it('refuses a signature that does not match the data, or that is garbage', () => {
    assert.equal(judge({ signature: sign(hubKey), blob: Buffer.from('other data') }), 'rejected');
    assert.equal(judge({ signature: Buffer.from('not a signature'), blob: signedData }), 'rejected');
  });

  it('refuses the hub\'s public key offered under another algorithm — verify answers an Error there, which is not a pass', () => {
    for (const algo of ['rsa-sha2-256', 'rsa-sha2-512', 'ssh-rsa', 'ecdsa-sha2-nistp256']) {
      assert.equal(judge({ algo, signature: Buffer.from('garbage'), blob: signedData, hashAlgo: 'sha256' }), 'rejected', algo);
      assert.equal(judge({ algo }), 'rejected', `${algo}, unsigned`);
    }
    assert.equal(judge({ signature: Buffer.from('garbage'), blob: signedData, hashAlgo: 'sha256' }), 'rejected', 'the right algorithm with an unusable hash algorithm and a bad signature');
  });

  it('refuses another key, and every method but a public key', () => {
    const other = parsePublicKey(strangerKey.publicKey)?.blob ?? Buffer.alloc(0);
    assert.equal(judge({ data: other, signature: sign(strangerKey), blob: signedData }), 'rejected');
    assert.equal(judgeNoneMethod(), 'rejected');
  });
});
