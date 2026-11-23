/**
 * @description The account switch after a usage limit must not wait for a "working" flag the limit left stuck.
 *
 * Live incident: a fresh process got a batch of messages, the first turn failed with a usage limit, and the
 * CLI never echoed the queued messages — the unconsumed-input list stayed non-empty, the session looked working
 * for good, and the deferred switch never fired. Load-bearing intent:
 * - an error `result` keeps the messages queued behind it (the CLI runs them as its next turn, measured on 2.1.330), and a deferred
 *   switch waits for that turn: it fires at its end, never at the failed turn's, which would kill them unread (review 18 #2); one the CLI
 *   never echoes holds it only within the grace;
 * - a switch answering a limit (`isAfterLimit`) re-spawns now even over a busy / input-holding session, while a
 *   plain apply still defers;
 * - a deferred switch reads as a re-spawn about to start from the turn's end on, and the re-spawn as one under way
 *   (`checkIsRespawnPending`): the turn probe holds the turn end meanwhile, so no reminder starts a launch beside it.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { ClaudeJsonStreamAdapter } from '../adapters/claudeJsonStreamAdapter';
import { keyToString, type SessionKey } from '../sessionKey';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import { type UnconsumedInput } from '../utils/jsonStreamUnconsumedInput';
import { unconsumedInputGraceMs } from '../utils/jsonStreamPendingWork';
import { createStreamSessionFixture } from './claudeJsonStreamSessionFixture';

const key: SessionKey = makeTelegramKey(-100999222, 78);
const limitResult = JSON.stringify({ type: 'result', is_error: true, result: "You've hit your weekly limit" }) + '\n';
const okResult = JSON.stringify({ type: 'result', is_error: false, result: 'done' }) + '\n';
const initFrame = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-acct', model: 'claude-test' }) + '\n';
const echoFrame = (text: string): string => JSON.stringify({ type: 'user', message: { role: 'user', content: text }, session_id: 'sess-acct' }) + '\n';
/** Past a timer tick: the deferred switch re-spawns one tick after the turn end that releases it. */
const afterTimerTick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

/** `count` messages written to the CLI and not echoed back. */
const queuedInputs = (count: number): UnconsumedInput[] => Array.from({ length: count }, (_unused, index) => ({ text: `queued ${index}`, since: Date.now(), hasUnmatchedEcho: false }));

function setup(): { adapter: ClaudeJsonStreamAdapter; respawns: Array<string | null | undefined> } {
  const adapter = new ClaudeJsonStreamAdapter();
  adapter.setClaudeConfigDirReader(() => '/profiles/perf');
  const session = createStreamSessionFixture({ key, workDir: '/tmp/jsonstream-account-work', sessionId: 'sess-acct' });
  adapter['sessions'].set(keyToString(key), session);
  const respawns: Array<string | null | undefined> = [];
  adapter['respawnWithChange'] = async (_s, change) => { respawns.push(change.configDir); };
  return { adapter, respawns };
}

describe('the process number the wake-up engine reads a prompt off (review 18 #2)', () => {
  it('every process the adapter spawns or adopts gets a number of its own; none is named for a session with no live process', () => {
    const adapter = new ClaudeJsonStreamAdapter();
    const first = adapter['createProcessGeneration']();
    assert.notEqual(adapter['createProcessGeneration'](), first);
    const session = createStreamSessionFixture({ key, workDir: '/tmp/jsonstream-account-work', sessionId: 'sess-acct', processGeneration: 5 });
    adapter['sessions'].set(keyToString(key), session);
    assert.equal(adapter.getProcessGeneration(key), 5);
    session.isActive = false;
    assert.equal(adapter.getProcessGeneration(key), undefined, 'stopped, or down for a re-spawn');
    assert.equal(adapter.getProcessGeneration(makeTelegramKey(-100999222, 79)), undefined, 'another topic');
  });

  it('a spawn (a resume and a re-spawn spawn too) and an adopt each number the process they build', () => {
    const adapterSource = fs.readFileSync(path.join(__dirname, '..', 'adapters', 'claudeJsonStreamAdapter.ts'), 'utf8');
    assert.equal(adapterSource.match(/processGeneration: this\.createProcessGeneration\(\),/g)?.length, 2);
    assert.match(adapterSource, /private async replaceSessionProcess\([^]*?await this\.spawnSession\(/, 'a re-spawn builds its process through the spawn');
  });
});

describe('claude-json-stream account switch after a limit', () => {
  it('a plain apply over a session holding unconsumed input defers', async () => {
    const { adapter, respawns } = setup();
    adapter['sessions'].get(keyToString(key))!.unconsumedInputs = queuedInputs(4);
    assert.equal(await adapter.applyClaudeConfigDir(key), 'deferred');
    assert.deepEqual(respawns, []);
  });

  it('isAfterLimit re-spawns now even when busy with unconsumed input', async () => {
    const { adapter, respawns } = setup();
    const session = adapter['sessions'].get(keyToString(key))!;
    session.isBusy = true;
    session.unconsumedInputs = queuedInputs(3);
    assert.equal(await adapter.applyClaudeConfigDir(key, { isAfterLimit: true }), 'respawned');
    assert.deepEqual(respawns, ['/profiles/perf']);
  });

  it('an error result keeps the messages queued behind it (the CLI runs them next, measured on 2.1.330): still working within the grace, so a switch picked now defers — a re-spawn would kill them unread (review 18 #2)', async () => {
    const { adapter, respawns } = setup();
    const session = adapter['sessions'].get(keyToString(key))!;
    session.isBusy = true;
    session.unconsumedInputs = queuedInputs(4); // four queued messages, the CLI echoed none of them yet
    adapter['onStdout'](session, limitResult);
    assert.equal(session.unconsumedInputs.length, 4);
    assert.equal(adapter.checkIsWorking(key), true, 'the per-turn stop waits for the turn that takes them in');
    assert.equal(await adapter.applyClaudeConfigDir(key), 'deferred');
    assert.deepEqual(respawns, []);
  });

  it('a normal result keeps the count of messages still queued', () => {
    const { adapter } = setup();
    const session = adapter['sessions'].get(keyToString(key))!;
    session.unconsumedInputs = queuedInputs(2);
    adapter['onStdout'](session, okResult);
    assert.equal(session.unconsumedInputs.length, 2);
  });

  it('a deferred switch is a re-spawn about to start from the turnEnded event on, and the re-spawn one under way; a turn still working, or no switch, is none (report 6, not fixed 2)', async () => {
    const { adapter } = setup();
    const session = adapter['sessions'].get(keyToString(key))!;
    assert.equal(adapter.checkIsRespawnPending(key), false, 'no switch');
    session.isBusy = true;
    assert.equal(await adapter.applyClaudeConfigDir(key), 'deferred');
    assert.equal(adapter.checkIsRespawnPending(key), false, 'the turn still works: the switch waits for its end');
    const pendingAtTurnEnd: boolean[] = [];
    adapter.on('turnEnded', () => { pendingAtTurnEnd.push(adapter.checkIsRespawnPending(key)); });
    adapter['onStdout'](session, okResult);
    assert.deepEqual(pendingAtTurnEnd, [true], 'what the bot reads at the turn end: the re-spawn is about to start');
    session.isConfigDirSwitchPending = false;
    session.isRespawning = true;
    session.isActive = false;
    assert.equal(adapter.checkIsRespawnPending(key), true, 'under way, the process down for it');
    assert.equal(adapter.checkIsRespawnPending(makeTelegramKey(-100999222, 79)), false, 'another topic');
  });

  it('a switch pending on a process that stops working with NO turn end (a task hold lapsing, an input past its grace) is no re-spawn coming: nothing holds the turn (review 17 nit 5)', async () => {
    const { adapter, respawns } = setup();
    const session = adapter['sessions'].get(keyToString(key))!;
    session.isBusy = true;
    assert.equal(await adapter.applyClaudeConfigDir(key), 'deferred');
    session.isBusy = false;
    assert.equal(adapter.checkIsRespawnPending(key), false);
    assert.deepEqual(respawns, []);
  });

  it('a write in the turn end\'s own handlers (the todo reminder) takes the release back: the switch waits for the next turn end, and nothing is held meanwhile (review 17 nit 5)', async () => {
    const { adapter, respawns } = setup();
    const session = adapter['sessions'].get(keyToString(key))!;
    session.isBusy = true;
    assert.equal(await adapter.applyClaudeConfigDir(key), 'deferred');
    adapter.on('turnEnded', () => { session.isBusy = true; });
    adapter['onStdout'](session, okResult);
    assert.equal(adapter.checkIsRespawnPending(key), false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(respawns, []);
    assert.equal(session.isConfigDirSwitchPending, true, 'still pending for the next turn end');
  });

  it('a deferred switch, an error result with M queued behind it, then M\'s own turn: no re-spawn before that turn\'s end, the re-spawn after it (review 18 #2)', async () => {
    const { adapter, respawns } = setup();
    const session = adapter['sessions'].get(keyToString(key))!;
    session.isBusy = true;
    session.unconsumedInputs = [{ text: 'M', since: Date.now(), hasUnmatchedEcho: false }];
    assert.equal(await adapter.applyClaudeConfigDir(key), 'deferred');

    adapter['onStdout'](session, limitResult);
    await afterTimerTick();
    assert.deepEqual(respawns, [], 'the failed turn\'s end: M waits for its own turn, the switch with it');
    assert.equal(adapter.checkIsRespawnPending(key), false, 'no re-spawn coming: nothing holds the turn probe');

    adapter['onStdout'](session, initFrame + echoFrame('M'));
    await afterTimerTick();
    assert.deepEqual(respawns, [], 'M\'s turn runs');
    assert.deepEqual(session.unconsumedInputs, [], 'the CLI took M in');

    adapter['onStdout'](session, okResult);
    await afterTimerTick();
    assert.deepEqual(respawns, ['/profiles/perf'], 'M\'s turn ended: the switch fires');
  });

  it('a message queued behind a failed turn that the CLI never echoes holds the switch only within the grace: the next turn end past it fires it', async () => {
    const { adapter, respawns } = setup();
    const session = adapter['sessions'].get(keyToString(key))!;
    session.isBusy = true;
    session.unconsumedInputs = queuedInputs(1);
    assert.equal(await adapter.applyClaudeConfigDir(key), 'deferred');
    adapter['onStdout'](session, limitResult);
    await afterTimerTick();
    assert.deepEqual(respawns, []);

    // The grace passes with no turn: the next read (the poll's, the stop's) drops it — it was never on its way.
    session.unconsumedInputs = session.unconsumedInputs.map((input) => ({ ...input, since: Date.now() - unconsumedInputGraceMs - 1 }));
    assert.equal(adapter.checkIsWorking(key), false);
    // The next prompt's turn ends: nothing holds the switch any more.
    session.isBusy = true;
    adapter['onStdout'](session, okResult);
    await afterTimerTick();
    assert.deepEqual(respawns, ['/profiles/perf']);
  });
});
