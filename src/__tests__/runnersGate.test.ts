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
import { cancelReplySchema, gateMarker, maxGateRequestBytes, parseGateMarkerLine, redeemReplySchema, type GateMarker } from '../runners/gateProtocol';
import { getHubFilePaths } from '../runners/hubPaths';
import { createPairing, redeemPairing, removePairedRunner } from '../runners/hubPairing';
import { readPairedFile, readPendingFile } from '../runners/hubRegistry';
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

/** The marker line of an answer (it follows a line break, and may follow shell noise) and the bytes after it. */
function splitMarker(stdout: Buffer): { marker: GateMarker | null; request: string | undefined; body: Buffer } {
  const start = stdout.indexOf(gateMarker);
  const newline = stdout.indexOf(0x0a, start);
  const marker = start === -1 ? null : parseGateMarkerLine(stdout.subarray(start, newline).toString('utf8'));
  return { marker, request: marker?.request, body: stdout.subarray(newline + 1) };
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
  it('a pairing\'s key may bootstrap, redeem and cancel its own code — nothing else', () => {
    assert.equal(routeGateRequest('temporary', 'bootstrap'), 'bootstrap');
    assert.equal(routeGateRequest('temporary', 'redeem'), 'redeem');
    assert.equal(routeGateRequest('temporary', 'cancel'), 'cancel');
    for (const command of ['link', 'package', 'version', 'identity', 'unpair', 'bootstrap now', 'redeem; id', ' redeem', '', 'sh', '$(id)', undefined]) {
      assert.equal(routeGateRequest('temporary', command), null, String(command));
    }
  });

  it('a runner\'s key may link, fetch the package, ask the version and unpair — nothing else', () => {
    assert.equal(routeGateRequest('runner', 'link'), 'link');
    assert.equal(routeGateRequest('runner', 'package'), 'package');
    assert.equal(routeGateRequest('runner', 'version'), 'version');
    assert.equal(routeGateRequest('runner', 'identity'), 'identity');
    assert.equal(routeGateRequest('runner', 'unpair'), 'unpair');
    for (const command of ['bootstrap', 'redeem', 'cancel', 'link extra', 'scp -t /tmp', 'cat /etc/passwd', 'sftp', '', undefined]) {
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

  it('bootstrap sends the marker line, then the package as gzip, only while the code is open', async () => {
    const pairId = await createOpenPairing();
    const run = await runGate(gateArgs('redeem', pairId), 'bootstrap');
    assert.equal(run.code, 0);
    assert.ok(run.stdout.toString('latin1').startsWith(`\n${gateMarker} bootstrap id=`), 'a line break first, so the marker opens a line of its own');
    const { request, body } = splitMarker(run.stdout);
    assert.equal(request, 'bootstrap');
    const tar = gunzipSync(body).toString('latin1');
    for (const name of ['package.json', 'remoteRun/runner.sh', 'dist/cli.js', 'dist/runners/example.js']) assert.ok(tar.includes(name), name);
    assert.ok(!tar.includes('__tests__'));

    const unknown = await runGate(gateArgs('redeem', knownId), 'bootstrap');
    assert.equal(unknown.code, 2);
    assert.equal(unknown.stdout.length, 0);
  });

  it('cancel closes the code the key belongs to: the package is no longer sent, the code cannot be redeemed, its key line is gone — and asking again is harmless', async () => {
    const pairId = await createOpenPairing();
    assert.match(fs.readFileSync(fixture.ctx.authorizedKeysPath, 'utf8'), /charness-pairing:/);
    const run = await runGate(gateArgs('redeem', pairId), 'cancel');
    assert.equal(run.code, 0, run.log.join('\n'));
    const { request, body } = splitMarker(run.stdout);
    assert.equal(request, 'cancel');
    assert.deepEqual(cancelReplySchema.parse(JSON.parse(body.toString('utf8'))), { ok: true });
    assert.deepEqual(readPendingFile(fixture.ctx.dir).pending, []);
    assert.doesNotMatch(fs.readFileSync(fixture.ctx.authorizedKeysPath, 'utf8'), /charness-pairing:/, 'the key line is gone with the code');
    assert.equal((await runGate(gateArgs('redeem', pairId), 'bootstrap')).code, 2, 'no package for a closed code');
    const redeem = await runGate(gateArgs('redeem', pairId), 'redeem', JSON.stringify(createRedeemFixture().request));
    assert.equal(redeemReplySchema.parse(JSON.parse(splitMarker(redeem.stdout).body.toString('utf8'))).ok, false);
    const again = await runGate(gateArgs('redeem', pairId), 'cancel');
    assert.equal(again.code, 0);
    assert.deepEqual(cancelReplySchema.parse(JSON.parse(splitMarker(again.stdout).body.toString('utf8'))), { ok: false });
  });

  it('cancel never touches another code or a runner that used its code', async () => {
    const other = await createOpenPairing();
    const usedPairId = await createOpenPairing();
    const redeemed = await redeemPairing(fixture.ctx, usedPairId, createRedeemFixture().request, startMs);
    assert.equal(redeemed.ok, true);
    const cancelUsed = await runGate(gateArgs('redeem', usedPairId), 'cancel');
    assert.deepEqual(cancelReplySchema.parse(JSON.parse(splitMarker(cancelUsed.stdout).body.toString('utf8'))), { ok: false }, 'a spent code has nothing to close');
    assert.equal(readPairedFile(fixture.ctx.dir).runners.length, 1, 'and the runner it made stays');
    assert.deepEqual(readPendingFile(fixture.ctx.dir).pending.map((pairing) => pairing.pairId), [other], 'the other open code stays open');
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
    assert.match(reply.ok ? (reply.packageId ?? '') : '', /^[0-9a-f]{16}$/, 'the reply tells the hub\'s current package');
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
    const { marker, body } = splitMarker(run.stdout);
    assert.equal(marker?.request, 'package');
    assert.match(marker?.fields.id ?? '', /^[0-9a-f]{16}$/);
    assert.ok(gunzipSync(body).toString('latin1').includes('package.json'));
  });

  it('version answers with the marker and the hub\'s current package id, and nothing else', async () => {
    const runnerId = await pairRunner();
    const run = await runGate(gateArgs('runner', runnerId), 'version');
    assert.equal(run.code, 0);
    const { marker, body } = splitMarker(run.stdout);
    assert.equal(marker?.request, 'version');
    assert.match(marker?.fields.package ?? '', /^[0-9a-f]{16}$/);
    assert.equal(body.length, 0);
    assert.equal(marker?.fields.package, splitMarker((await runGate(gateArgs('runner', runnerId), 'package')).stdout).marker?.fields.id, 'the same id the package request announces');
  });

  it('identity tells a paired runner what redeem told it — the way back when that answer was lost — and tells it nothing once it is removed', async () => {
    const pairId = await createOpenPairing();
    const redeemed = await redeemPairing(fixture.ctx, pairId, createRedeemFixture().request, startMs);
    assert.ok(redeemed.ok);
    if (!redeemed.ok) return;
    const run = await runGate(gateArgs('runner', redeemed.runnerId), 'identity');
    assert.equal(run.code, 0);
    const { request, body } = splitMarker(run.stdout);
    assert.equal(request, 'identity');
    const reply = redeemReplySchema.parse(JSON.parse(body.toString('utf8')));
    assert.ok(reply.ok);
    if (reply.ok) {
      assert.deepEqual({ runnerId: reply.runnerId, name: reply.name, hubPublicKey: reply.hubPublicKey, label: reply.label, host: reply.host, port: reply.port }, {
        runnerId: redeemed.runnerId,
        name: redeemed.name,
        hubPublicKey: redeemed.hubPublicKey,
        label: redeemed.label,
        host: redeemed.host,
        port: redeemed.port,
      });
    }
    await removePairedRunner(fixture.ctx, redeemed.runnerId, startMs);
    const afterRemoval = await runGate(gateArgs('runner', redeemed.runnerId), 'identity');
    assert.equal(afterRemoval.code, 1);
    assert.equal(splitMarker(afterRemoval.stdout).request, 'identity');
    const removedReply = redeemReplySchema.parse(JSON.parse(splitMarker(afterRemoval.stdout).body.toString('utf8')));
    assert.deepEqual(removedReply, { ok: false, reason: 'this runner is not paired here' }, 'the answer the runner reads as «removed» — and nothing else');
  });

  it('identity tells «not paired» only for a runner that IS gone from the registry — a hub whose key cannot be read fails with no answer, so the runner tries again instead of stopping its jobs', async () => {
    const runnerId = await pairRunner();
    fs.rmSync(getHubFilePaths(fixture.ctx.dir).hubKey, { force: true });
    const run = await runGate(gateArgs('runner', runnerId), 'identity');
    assert.equal(run.code, 1, 'a failure');
    assert.equal(run.stdout.length, 0, 'and no JSON the runner could read as «removed»');
    assert.ok(run.log.some((line) => line.includes('hub key cannot be read')), run.log.join('\n'));
    assert.equal(readPairedFile(fixture.ctx.dir).runners.length, 1, 'the runner is still registered');
  });

  it('unpair removes the runner and says so; a second unpair says no', async () => {
    const runnerId = await pairRunner();
    const first = await runGate(gateArgs('runner', runnerId), 'unpair');
    assert.equal(first.code, 0);
    assert.deepEqual(JSON.parse(splitMarker(first.stdout).body.toString('utf8')), { ok: true });
    assert.equal(readPairedFile(fixture.ctx.dir).runners.length, 0);
    assert.deepEqual(JSON.parse(splitMarker((await runGate(gateArgs('runner', runnerId), 'unpair')).stdout).body.toString('utf8')), { ok: false });
  });

  it('a runner that left the registry is refused by `package`, `link` and `version` whatever its key line still allows', async () => {
    const runnerId = await pairRunner();
    await removePairedRunner(fixture.ctx, runnerId, startMs);
    for (const command of ['package', 'link', 'version']) {
      const run = await runGate(gateArgs('runner', runnerId), command);
      assert.equal(run.code, 2, command);
      assert.equal(run.stdout.length, 0, command);
      assert.ok(run.log.some((line) => line.includes('not paired')), command);
    }
  });

  it('a damaged authorized_keys block fails a redeem with a message that names no path, and spends nothing', async () => {
    const pairId = await createOpenPairing();
    fs.writeFileSync(fixture.ctx.authorizedKeysPath, '# charness runners: managed block, do not edit between the markers\n');
    const run = await runGate(gateArgs('redeem', pairId), 'redeem', JSON.stringify(createRedeemFixture().request));
    assert.equal(run.code, 1);
    assert.ok(run.log.some((line) => line.includes('damaged charness block')));
    assert.ok(run.log.every((line) => !line.includes(fixture.root)));
    assert.equal(readPairedFile(fixture.ctx.dir).runners.length, 0);
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
