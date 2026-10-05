/**
 * @description Boot after a restart, json-stream half (lifecycle plan L4),
 * asserted against the `bot.ts` source since the reattach runs inside the bot's
 * boot: a thread whose process is gone is NOT re-spawned — it sleeps, its
 * downtime recap read from the transcript — and an adopted process is checked
 * against the persisted tool digest. The process-level proof is J7's restart.
 *
 * Test case: N/A — TelegramCode has no Jira tracker.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

const botSource = fs.readFileSync(path.join(__dirname, '..', 'bot.ts'), 'utf8');
const reattachJsonStream = botSource.slice(
  botSource.indexOf('// 2b. Claude JSON-stream'),
  botSource.indexOf('// 3. Terminal'),
);

describe('reattach: json-stream (L4)', () => {
  it('a thread whose process is gone sleeps: no resume at boot, the recap from the transcript', () => {
    assert.ok(!reattachJsonStream.includes('.resumeSession('), 'no dead-process re-spawn');
    assert.ok(reattachJsonStream.includes('jsonSleeping += 1;'));
    assert.match(reattachJsonStream, /void postReattachRecap\(\n\s*key, ownerAdapter, workDirDecision\.workDir, agent\.claudeSessionId, agent\.seenWatermark \?\? null, !opts\.quietReattach,\n\s*\)/);
    assert.ok(reattachJsonStream.includes('sleeping ${jsonSleeping}'), 'the boot line counts the sleeping threads');
  });

  it('an adopted process is checked against the persisted tool digest and stopped at its next idle point when stale', () => {
    assert.match(reattachJsonStream, /decideAdoptedToolListRefresh\(\{\n\s*persistedDigest: agent\.mcpToolDigest,[^]*?isWorking: ownerAdapter\.checkIsWorking\(key\),\n\s*\}\)/);
    assert.ok(reattachJsonStream.includes("if (refresh !== 'fresh') {") && reattachJsonStream.includes("stopAdoptedSessionWhenIdle(key, ownerAdapter, 'the stale tool list');"));
    // L5: either json-stream lifecycle owns the same tmux name — the persisted agent name picks the adopting instance;
    // an adopted per-turn process is stopped as soon as its turn ends.
    assert.ok(reattachJsonStream.includes('const ownerAdapter = agent && checkIsJsonStreamBackend(agent.name) ? getAdapter(agent.name) : null;'));
    assert.ok(reattachJsonStream.includes("stopAdoptedSessionWhenIdle(key, ownerAdapter, 'the per-turn lifecycle');"));
    assert.ok(reattachJsonStream.includes("if (agent.name === claudePerTurnAdapterName) rearmThreadIdleTimer(key);"), 'a sleeping per-turn session with a compaction due gets its timer at boot (L-D7)');
  });

  it('the adopted-process poll gives up when the CLI version is unknown or too old (L-D10): no 5 s "stopping" loop', () => {
    const stopAdopted = botSource.slice(botSource.indexOf('function stopAdoptedSessionWhenIdle('), botSource.indexOf('const adoptedToolListRefreshPollMs'));
    const gateAt = stopAdopted.indexOf('if (!adapter.checkIsAutoStopSupported(key)) {');
    const stopLogAt = stopAdopted.indexOf('stopping the adopted process (${reason})');
    assert.ok(gateAt > 0 && stopLogAt > gateAt, 'the gate precedes the "stopping" line and the suspend it announces');
    assert.ok(stopAdopted.includes('the adopted process is kept (${reason})'));
  });

  it('every json-stream (re)start persists the digest of the tools it connected to', () => {
    const persist = botSource.slice(botSource.indexOf('async function persistSessionStart('), botSource.indexOf('\n}\n', botSource.indexOf('async function persistSessionStart(')));
    assert.ok(persist.includes('await persistAdapterSessionIds(key, adapter, state);'));
    assert.ok(persist.includes('await state.setAgentMcpToolDigest(key, botMcpToolDigestReader(key.platform));'));
    assert.equal(botSource.split('await persistAdapterSessionIds(').length - 1, 1, 'the helper is the only caller: no (re)start bypasses the digest');
  });
});
