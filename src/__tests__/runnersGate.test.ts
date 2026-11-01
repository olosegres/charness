/**
 * @description `runners/gate.ts` + `gateWrapper.ts`: what sshd starts for a runner's key. The arguments of the forced command, the
 * routing of `SSH_ORIGINAL_COMMAND` against the words each key role allows (anything else — a shell login, extra arguments, the other
 * role's words — is refused), and each request answered over plain streams: the package, `redeem`, `unpair`.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { Readable } from 'stream';
import { gunzipSync } from 'zlib';
import { parseGateArgs, routeGateRequest, runRunnerGate, type GateInvocation } from '../runners/gate';
import { ensureGateWrapper, renderGateWrapper } from '../runners/gateWrapper';
import { gateMarker, maxGateRequestBytes, parseGateMarkerLine, redeemReplySchema } from '../runners/gateProtocol';
import { getHubFilePaths } from '../runners/hubPaths';
import { createPairing, redeemPairing } from '../runners/hubPairing';
import { readPairedFile } from '../runners/hubRegistry';
import { generateEd25519KeyPair } from '../runners/sshKeys';
import { createCollector, createHubFixture, createRedeemFixture, type HubFixture } from './runnersTestKit';

const startMs = Date.UTC(2026, 10, 1, 12, 0, 0);
const knownId = 'abcdef012345';
const hubHostKey = generateEd25519KeyPair('hub-host').publicKey;

let fixture: HubFixture;

interface GateRun {
  code: number;
  stdout: Buffer;
  log: string[];
}

async function runGate(invocation: string[], command: string | undefined, stdin: Buffer | string = ''): Promise<GateRun> {
  const output = createCollector();
  const log: string[] = [];
  const code = await runRunnerGate(
    invocation,
    command === undefined ? {} : { SSH_ORIGINAL_COMMAND: command },
    { stdin: Readable.from(stdin === '' ? [] : [Buffer.from(stdin)]), stdout: output.stream, log: (line) => log.push(line) },
    { context: { packageRoot: fixture.ctx.packageRoot }, now: () => startMs + 1000 },
  );
  return { code, stdout: output.getBuffer(), log };
}

function gateArgs(role: 'redeem' | 'runner', id: string): string[] {
  return ['--dir', fixture.ctx.dir, '--keys', fixture.ctx.authorizedKeysPath, role, id];
}

/** The text after the first line and the first line parsed as a marker. */
function splitMarker(stdout: Buffer): { request: string | undefined; body: Buffer } {
  const newline = stdout.indexOf(0x0a);
  return { request: parseGateMarkerLine(stdout.subarray(0, newline).toString('utf8'))?.request, body: stdout.subarray(newline + 1) };
}

describe('gate arguments', () => {
  it('reads the forced command of both key roles', () => {
    assert.deepEqual(parseGateArgs(['--dir', '/d', '--keys', '/k', 'redeem', knownId]), { ok: true, invocation: { role: 'temporary', dir: '/d', keysPath: '/k', pairId: knownId } satisfies GateInvocation });
    assert.deepEqual(parseGateArgs(['--dir', '/d', '--keys', '/k', 'runner', knownId]), { ok: true, invocation: { role: 'runner', dir: '/d', keysPath: '/k', runnerId: knownId } satisfies GateInvocation });
  });

  it('refuses anything else', () => {
    for (const argv of [
      [],
      ['--dir', '/d', 'redeem', knownId],
      ['--keys', '/k', '--dir', '/d', 'redeem', knownId],
      ['--dir', 'relative', '--keys', '/k', 'redeem', knownId],
      ['--dir', '/d', '--keys', 'relative', 'redeem', knownId],
      ['--dir', '/d', '--keys', '/k', 'redeem', 'not-an-id'],
      ['--dir', '/d', '--keys', '/k', 'redeem', `${knownId}; id`],
      ['--dir', '/d', '--keys', '/k', 'shell', knownId],
      ['--dir', '/d', '--keys', '/k', 'redeem', knownId, 'extra'],
    ]) {
      assert.equal(parseGateArgs(argv).ok, false, JSON.stringify(argv));
    }
  });
});

describe('gate routing', () => {
  it('a pairing\'s key may bootstrap and redeem — nothing else', () => {
    assert.equal(routeGateRequest('temporary', 'bootstrap'), 'bootstrap');
    assert.equal(routeGateRequest('temporary', 'redeem'), 'redeem');
    for (const command of ['link', 'package', 'unpair', 'bootstrap now', 'redeem; id', ' redeem', '', 'sh', '$(id)', undefined]) {
      assert.equal(routeGateRequest('temporary', command), null, String(command));
    }
  });

  it('a runner\'s key may link, fetch the package and unpair — nothing else', () => {
    assert.equal(routeGateRequest('runner', 'link'), 'link');
    assert.equal(routeGateRequest('runner', 'package'), 'package');
    assert.equal(routeGateRequest('runner', 'unpair'), 'unpair');
    for (const command of ['bootstrap', 'redeem', 'link extra', 'scp -t /tmp', 'cat /etc/passwd', 'sftp', '', undefined]) {
      assert.equal(routeGateRequest('runner', command), null, String(command));
    }
  });
});

describe('gate requests', () => {
  beforeEach(() => {
    fixture = createHubFixture();
  });
  afterEach(() => {
    fixture.cleanup();
  });

  async function createOpenPairing(): Promise<string> {
    return (await createPairing(fixture.ctx, { host: 'host.example', port: 22, hostKey: hubHostKey, label: '@ExampleBot', nowMs: startMs, sshUser: 'hubuser' })).pairId;
  }

  async function pairRunner(): Promise<string> {
    const reply = await redeemPairing(fixture.ctx, await createOpenPairing(), createRedeemFixture().request, startMs);
    if (!reply.ok) throw new Error(reply.reason);
    return reply.runnerId;
  }

  it('refuses a request its key role may not make, before touching anything', async () => {
    const pairId = await createOpenPairing();
    const wrongForTemporary = await runGate(gateArgs('redeem', pairId), 'link');
    assert.equal(wrongForTemporary.code, 2);
    assert.equal(wrongForTemporary.stdout.length, 0);
    const shellLogin = await runGate(gateArgs('redeem', pairId), undefined);
    assert.equal(shellLogin.code, 2);
    const wrongForRunner = await runGate(gateArgs('runner', knownId), 'redeem');
    assert.equal(wrongForRunner.code, 2);
    assert.equal(wrongForRunner.stdout.length, 0);
    const badArgs = await runGate(['--dir', fixture.ctx.dir], 'bootstrap');
    assert.equal(badArgs.code, 2);
  });

  it('bootstrap sends the package as raw gzip — no marker — only while the code is open', async () => {
    const pairId = await createOpenPairing();
    const run = await runGate(gateArgs('redeem', pairId), 'bootstrap');
    assert.equal(run.code, 0);
    const tar = gunzipSync(run.stdout).toString('latin1');
    for (const name of ['package.json', 'remoteRun/runner.sh', 'dist/cli.js', 'dist/runners/example.js']) assert.ok(tar.includes(name), name);
    assert.ok(!tar.includes('__tests__'));
    assert.ok(!run.stdout.toString('latin1').startsWith(gateMarker));

    const unknown = await runGate(gateArgs('redeem', knownId), 'bootstrap');
    assert.equal(unknown.code, 2);
    assert.equal(unknown.stdout.length, 0);
  });

  it('redeem registers the runner and answers with the marker, then the reply', async () => {
    const pairId = await createOpenPairing();
    const { request } = createRedeemFixture();
    const run = await runGate(gateArgs('redeem', pairId), 'redeem', JSON.stringify(request));
    assert.equal(run.code, 0, run.log.join('\n'));
    const { request: marker, body } = splitMarker(run.stdout);
    assert.equal(marker, 'redeem');
    const reply = redeemReplySchema.parse(JSON.parse(body.toString('utf8')));
    assert.equal(reply.ok, true);
    assert.deepEqual(readPairedFile(fixture.ctx.dir).runners.map((runner) => runner.publicKey), [request.publicKey]);
  });

  it('redeem answers a code that is gone with a refusal and a non-zero exit', async () => {
    const run = await runGate(gateArgs('redeem', knownId), 'redeem', JSON.stringify(createRedeemFixture().request));
    assert.equal(run.code, 1);
    const reply = redeemReplySchema.parse(JSON.parse(splitMarker(run.stdout).body.toString('utf8')));
    assert.equal(reply.ok, false);
  });

  it('redeem refuses a body that is not valid, is not JSON, or is too large — and registers nothing', async () => {
    const pairId = await createOpenPairing();
    for (const body of ['not json', '[]', JSON.stringify({ ...createRedeemFixture().request, publicKey: 'ssh-rsa AAAA' }), `{"x":"${'a'.repeat(maxGateRequestBytes)}"}`]) {
      const run = await runGate(gateArgs('redeem', pairId), 'redeem', body);
      assert.equal(run.code, 1);
      const reply = redeemReplySchema.parse(JSON.parse(splitMarker(run.stdout).body.toString('utf8')));
      assert.equal(reply.ok, false);
    }
    assert.equal(readPairedFile(fixture.ctx.dir).runners.length, 0);
  });

  it('package sends the marker with the package id, then the gzip', async () => {
    const runnerId = await pairRunner();
    const run = await runGate(gateArgs('runner', runnerId), 'package');
    assert.equal(run.code, 0);
    const newline = run.stdout.indexOf(0x0a);
    const marker = parseGateMarkerLine(run.stdout.subarray(0, newline).toString('utf8'));
    assert.equal(marker?.request, 'package');
    assert.match(marker?.fields.id ?? '', /^[0-9a-f]{16}$/);
    assert.ok(gunzipSync(run.stdout.subarray(newline + 1)).toString('latin1').includes('package.json'));
  });

  it('unpair removes the runner and says so; a second unpair says no', async () => {
    const runnerId = await pairRunner();
    const first = await runGate(gateArgs('runner', runnerId), 'unpair');
    assert.equal(first.code, 0);
    assert.deepEqual(JSON.parse(splitMarker(first.stdout).body.toString('utf8')), { ok: true });
    assert.equal(readPairedFile(fixture.ctx.dir).runners.length, 0);
    assert.deepEqual(JSON.parse(splitMarker((await runGate(gateArgs('runner', runnerId), 'unpair')).stdout).body.toString('utf8')), { ok: false });
  });

  it('a failure tells the runner no hub path', async () => {
    fs.mkdirSync(fixture.ctx.dir, { recursive: true });
    fs.writeFileSync(getHubFilePaths(fixture.ctx.dir).pending, '{broken');
    const run = await runGate(gateArgs('redeem', knownId), 'bootstrap');
    assert.equal(run.code, 1);
    assert.ok(run.log.length > 0);
    assert.ok(run.log.every((line) => !line.includes(fixture.root)));
  });
});

describe('gate wrapper', () => {
  beforeEach(() => {
    fixture = createHubFixture();
  });
  afterEach(() => {
    fixture.cleanup();
  });

  it('runs this install\'s node on this install\'s cli.js with the gate arguments passed through', () => {
    assert.equal(renderGateWrapper({ nodePath: '/opt/node/bin/node', cliPath: '/opt/charness/dist/cli.js' }), `#!/bin/sh\nexec '/opt/node/bin/node' '/opt/charness/dist/cli.js' runner-gate "$@"\n`);
  });

  it('single-quotes a path with a quote in it', () => {
    assert.ok(renderGateWrapper({ nodePath: "/o'k/node", cliPath: '/c/cli.js' }).includes(`'/o'\\''k/node'`));
  });

  it('is written private and executable, rewritten when the install moves, and left alone when nothing changed', () => {
    const gatePath = ensureGateWrapper(fixture.ctx);
    assert.equal(gatePath, getHubFilePaths(fixture.ctx.dir).gate);
    assert.equal(fs.statSync(gatePath).mode & 0o777, 0o700);
    assert.equal(fs.readFileSync(gatePath, 'utf8'), renderGateWrapper(fixture.ctx));
    const inode = fs.statSync(gatePath).ino;
    ensureGateWrapper(fixture.ctx);
    assert.equal(fs.statSync(gatePath).ino, inode);
    ensureGateWrapper({ ...fixture.ctx, nodePath: '/somewhere/else/node' });
    assert.ok(fs.readFileSync(gatePath, 'utf8').includes('/somewhere/else/node'));
  });
});
