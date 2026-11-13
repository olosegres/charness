/**
 * @description The ports the process-level flows give an isolated instance (`e2e/isolatedCharness.ts`). Flows run in
 * parallel on one loopback, so a port a flow keeps as an address — the `OPENCODE_URL` of an instance with no OpenCode
 * server, probed at every boot — must be one nobody can be handed. A port taken from `getFreePort` is released at once and
 * the kernel hands released ports to the next `listen(0)` of any flow; the fake that gets one receives the instance's
 * `GET /global/health` among its own requests (reproduced by pointing the instance's `OPENCODE_URL` at a fake Anthropic
 * API: seven of that flow's nine steps failed on the extra requests).
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { probeOpenCodePort } from '../installManager';
import {
  fixedPortRangeStart,
  getEphemeralPortFloor,
  getFreeFixedPort,
  getFreePort,
  getUnservedPort,
  holdPort,
} from './e2e/isolatedCharness';

const testsDir = __dirname;
const kitFileName = 'isolatedCharness.ts';
const thisFileName = path.basename(__filename);
const portDrawCount = 300;

/** The lines of every test source (flows, kits, fakes) that hand an instance an address for OpenCode, taken from `getFreePort`. */
const addressTakenFromFreePort = /OPENCODE_URL[^\n]*getFreePort|openCode:[^\n]*getFreePort|dead\w*\s*=\s*await getFreePort/i;

function listTestSourceFiles(): string[] {
  return fs.readdirSync(testsDir, { recursive: true, encoding: 'utf8' })
    .filter((relativePath) => relativePath.endsWith('.ts'))
    .filter((relativePath) => path.basename(relativePath) !== kitFileName && path.basename(relativePath) !== thisFileName);
}

/** A draw that returns `ports` in turn, then the last one for ever. */
function drawInTurn(ports: readonly number[]): () => number {
  let next = 0;
  return () => ports[Math.min(next++, ports.length - 1)];
}

describe('getUnservedPort', () => {
  it('lies below every port the kernel or the kit hands to a listener', async () => {
    const ephemeralFloor = getEphemeralPortFloor();
    for (let draw = 0; draw < portDrawCount; draw += 1) {
      const port = await getUnservedPort();
      assert.ok(port < fixedPortRangeStart, `${port} is in the range getFreeFixedPort draws from`);
      assert.ok(port < ephemeralFloor, `${port} is in the range the kernel hands to listen(0) and to outgoing connections`);
    }
    // The ports the other two helpers give, for contrast: what getFreePort returns is the kernel's own next port.
    assert.ok(await getFreePort() >= ephemeralFloor);
    const fixedPort = await getFreeFixedPort();
    assert.ok(fixedPort >= fixedPortRangeStart && fixedPort < ephemeralFloor);
  });

  it('is a port the bot reads as free — only a refused connection proves a port free, so a held listener would not do', async () => {
    const port = await getUnservedPort();
    assert.equal((await probeOpenCodePort(port.toString())).state, 'free');
    const holder = await holdPort(0);
    try {
      assert.equal((await probeOpenCodePort(holder.port.toString())).state, 'inUse', 'a port a listener holds reads as in use');
    } finally {
      await holder.release();
    }
  });

  it('skips a candidate something listens on', async () => {
    const free = await getUnservedPort();
    const holder = await holdPort(0);
    try {
      assert.equal(await getUnservedPort(drawInTurn([holder.port, holder.port, free])), free);
    } finally {
      await holder.release();
    }
  });

  it('gives up, naming the range, when every candidate is taken', async () => {
    const holder = await holdPort(0);
    try {
      await assert.rejects(getUnservedPort(drawInTurn([holder.port])), /no unserved port in \[\d+, \d+\) after \d+ tries/);
    } finally {
      await holder.release();
    }
  });
});

describe('the addresses the flows give an instance for OpenCode', () => {
  it('none is taken from getFreePort: that port is released, and another flow\'s next listener can be handed it', () => {
    const offenders = listTestSourceFiles().flatMap((relativePath) => fs.readFileSync(path.join(testsDir, relativePath), 'utf8')
      .split('\n')
      .flatMap((line, index) => (addressTakenFromFreePort.test(line) ? [`${relativePath}:${index + 1}: ${line.trim()}`] : [])));
    assert.deepEqual(offenders, [], 'take the port of an address that stays dead from getUnservedPort');
  });
});
