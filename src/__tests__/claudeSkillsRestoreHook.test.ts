/**
 * @description The Claude skills restore's `SessionStart` hook (`hooks/claudeSkillsRestoreHook.ts`): what each slot prints
 * for a compaction of a transcript shaped like Claude Code 2.1.322's, that it prints NOTHING and exits 0 on any doubt —
 * input that is not a compaction's, a sub-agent's, a transcript that is gone, a command line it does not know — and the chain
 * that makes the parts land by number: a slot waits for the previous one's marker and process, for a bound only, never for a
 * marker of another compaction; an empty slot leaves its marker at once; old markers are swept. The chain over real
 * processes, in the order a CLI takes them, is `skillsRestoreE2e.test.ts`.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  planSkillsRestoreSlot,
  runSkillsRestoreSlot,
  skillsRestoreMarkerMaxAgeMs,
  sweepStaleSlotMarkers,
  waitForPreviousSlot,
  writeSlotMarker,
  type SkillsRestoreHookArguments,
  type SlotChainTimings,
} from '../hooks/claudeSkillsRestoreHook';
import { claudeSkillBaseDirPrefix, skillsRestoreHeader, skillsRestorePartMaxChars } from '../utils/skillsRestore';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-restore-hook-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const hookEntryPath = path.join(__dirname, '..', 'hooks', 'claudeSkillsRestoreHook.ts');

/** Slot `slot` of 24 with no unavailable folder and no chain. */
function getSlotArguments(slot: number, overrides: Partial<SkillsRestoreHookArguments> = {}): SkillsRestoreHookArguments {
  return { slot, slotCount: 24, unavailableSkillsDir: null, orderDir: null, ...overrides };
}

/** What slot `slot` prints for `inputText`, `null` for nothing. */
function getSlotOutput(inputText: string, hookArguments: SkillsRestoreHookArguments): string | null {
  return planSkillsRestoreSlot(inputText, hookArguments).output;
}

/** A project with skills on disk, and a transcript that loaded them with the Skill tool (as the CLI records it). */
function createSession(skills: Record<string, string>): { transcriptPath: string; skillDir: (name: string) => string } {
  const sessionDir = fs.mkdtempSync(path.join(root, 'session-'));
  const skillDir = (name: string): string => path.join(sessionDir, '.claude', 'skills', name);
  const lines: string[] = [JSON.stringify({ type: 'user', message: { role: 'user', content: 'an old epoch' } }), JSON.stringify({ type: 'system', subtype: 'compact_boundary' })];
  for (const [index, [name, body]] of Object.entries(skills).entries()) {
    fs.mkdirSync(skillDir(name), { recursive: true });
    fs.writeFileSync(path.join(skillDir(name), 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\n\n${body}`);
    const toolUseId = `toolu_${index}`;
    lines.push(
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: toolUseId, name: 'Skill', input: { skill: name } }] } }),
      JSON.stringify({ type: 'user', isMeta: true, sourceToolUseID: toolUseId, message: { role: 'user', content: [{ type: 'text', text: `${claudeSkillBaseDirPrefix}${skillDir(name)}\n\n${body}` }] } }),
    );
  }
  const transcriptPath = path.join(sessionDir, 'session.jsonl');
  fs.writeFileSync(transcriptPath, `${lines.join('\n')}\n`);
  return { transcriptPath, skillDir };
}

function buildInput(transcriptPath: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ session_id: 's-1', transcript_path: transcriptPath, cwd: root, hook_event_name: 'SessionStart', source: 'compact', ...extra });
}

function readContext(output: string | null): string {
  assert.ok(output !== null, 'the slot prints');
  const parsed: { hookSpecificOutput: { hookEventName: string; additionalContext: string } } = JSON.parse(output);
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'SessionStart');
  return parsed.hookSpecificOutput.additionalContext;
}

/** Longer than Claude's own re-attach keeps whole (20,000 characters): the bot must give it back. */
const bigBody = Array.from({ length: 800 }, (_value, index) => `Rule ${index}: a rule of the big skill.`).join('\n');

test('a compaction: slot 1 prints the header and the list; a skill Claude cuts comes back WHOLE over the next slots; one past the parts prints nothing', () => {
  const { transcriptPath, skillDir } = createSession({ small: '# small\n', big: bigBody });
  const outputs = Array.from({ length: 24 }, (_value, index) => getSlotOutput(buildInput(transcriptPath), getSlotArguments(index + 1)));
  const printed = outputs.filter((output): output is string => output !== null).map(readContext);
  assert.ok(printed.length > 1 && printed.length < 24, `the restore takes a few parts: ${printed.length}`);
  assert.ok(outputs.slice(printed.length).every((output) => output === null), 'every slot past the last part prints nothing');
  assert.ok(printed.every((part) => part.startsWith(skillsRestoreHeader) && part.length <= skillsRestorePartMaxChars));
  const list = printed[0];
  assert.ok(list.includes(`- big: its current full text is below (skill file: ${skillDir('big')}/SKILL.md)`));
  assert.ok(list.includes(`- small: its current full text is below (skill file: ${skillDir('small')}/SKILL.md)`), 'the small one too: Claude Code\'s own re-attach is not relied on');
  const joined = printed.join('\n');
  for (const rule of ['Rule 0: a rule of the big skill.', 'Rule 799: a rule of the big skill.']) assert.ok(joined.includes(rule), rule);
  assert.ok(joined.includes('## Skill: small'), 'the small one is given whole');
  // The full path of the file each text was read from, right under its base directory.
  for (const name of ['big', 'small']) {
    assert.ok(joined.includes(`${claudeSkillBaseDirPrefix}${skillDir(name)}\nSkill file: ${skillDir(name)}/SKILL.md\n`), `${name}: its skill file`);
  }
});

test('the bot\'s skills of a process started without them are not available now', () => {
  const { transcriptPath, skillDir } = createSession({ 'charness-orchestration': '# orchestration\n' });
  const context = readContext(getSlotOutput(buildInput(transcriptPath), getSlotArguments(1, { unavailableSkillsDir: path.dirname(skillDir('x')) })));
  assert.ok(context.includes('- charness-orchestration: was loaded before but is not available now'));
});

test('NOTHING on any doubt: not a compaction, a sub-agent, no transcript, not JSON, no skill loaded', () => {
  const { transcriptPath } = createSession({ big: bigBody });
  const slot = getSlotArguments(1);
  assert.equal(getSlotOutput(buildInput(transcriptPath, { source: 'startup' }), slot), null);
  assert.equal(getSlotOutput(buildInput(transcriptPath, { source: 'resume' }), slot), null);
  assert.equal(getSlotOutput(buildInput(transcriptPath, { agent_id: 'agent-1' }), slot), null);
  assert.equal(getSlotOutput(buildInput(path.join(root, 'missing.jsonl')), slot), null);
  assert.equal(getSlotOutput('not json', slot), null);
  assert.equal(getSlotOutput(buildInput(createSession({}).transcriptPath), slot), null, 'no skill → nothing at all');
});

test('the hook process: prints its part as hook JSON, and nothing with exit 0 on a bad command line or bad input', () => {
  const { transcriptPath } = createSession({ big: bigBody });
  const run = (args: readonly string[], input: string): { status: number | null; stdout: string } => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', hookEntryPath, ...args], { input, encoding: 'utf8', timeout: 60_000 });
    return { status: result.status, stdout: result.stdout };
  };
  const printed = run(['1', '24'], buildInput(transcriptPath));
  assert.equal(printed.status, 0);
  assert.ok(readContext(printed.stdout).startsWith(skillsRestoreHeader));
  for (const [args, input] of [[['1', '24'], 'garbage'], [['0', '24'], buildInput(transcriptPath)], [['25', '24'], buildInput(transcriptPath)], [[], buildInput(transcriptPath)]] as const) {
    assert.deepEqual(run(args, input), { status: 0, stdout: '' }, `args ${JSON.stringify(args)}`);
  }
});

// ── The chain: the parts land by number ──

/** Short timings, so a bound that runs out costs the test little. */
const testTimings: SlotChainTimings = { slotWaitMs: 400, chainCapMs: 5_000, settleMs: 0, pollMs: 10 };

/** The pid of a process that has ended and been collected: "gone". */
function getGonePid(): number {
  const result = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.ok(result.pid > 0);
  return result.pid;
}

function createOrderDir(): string {
  return fs.mkdtempSync(path.join(root, 'order-'));
}

const eventId = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const otherEventId = 'bbbbbbbbbbbbbbbbbbbbbbbb';

test('the chain: slot 1 never waits; the previous slot done (marker there, its process gone) → this one goes at once', async () => {
  const orderDir = createOrderDir();
  assert.equal(await waitForPreviousSlot({ orderDir, eventId, slot: 1, timings: testTimings }), 'first');
  const gonePid = getGonePid();
  writeSlotMarker(orderDir, eventId, 1, { pid: gonePid, parentPid: gonePid });
  const startedAt = Date.now();
  assert.equal(await waitForPreviousSlot({ orderDir, eventId, slot: 2, timings: testTimings }), 'afterPrevious');
  assert.ok(Date.now() - startedAt < testTimings.slotWaitMs, `no wait for a slot that is done: ${Date.now() - startedAt} ms`);
});

test('the chain: no marker of the previous slot → this one goes after the bound, never waits for ever', async () => {
  const orderDir = createOrderDir();
  const startedAt = Date.now();
  assert.equal(await waitForPreviousSlot({ orderDir, eventId, slot: 2, timings: testTimings }), 'timedOut');
  const elapsedMs = Date.now() - startedAt;
  assert.ok(elapsedMs >= testTimings.slotWaitMs && elapsedMs < testTimings.slotWaitMs + 1_000, `waited the bound: ${elapsedMs} ms`);
});

test('the chain: a marker left by ANOTHER compaction (an earlier one of the same session) never lets a slot skip its wait', async () => {
  const orderDir = createOrderDir();
  const gonePid = getGonePid();
  writeSlotMarker(orderDir, otherEventId, 1, { pid: gonePid, parentPid: gonePid });
  const startedAt = Date.now();
  assert.equal(await waitForPreviousSlot({ orderDir, eventId, slot: 2, timings: testTimings }), 'timedOut');
  assert.ok(Date.now() - startedAt >= testTimings.slotWaitMs, 'it waited for its own compaction\'s marker');
});

test('the chain: the marker alone is not enough — the slot waits until the previous slot\'s process is gone (the CLI takes its output then)', async () => {
  const orderDir = createOrderDir();
  const previous = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 300)'], { stdio: 'ignore' });
  const previousExited = new Promise<number>((resolve) => { previous.once('exit', () => resolve(Date.now())); });
  assert.ok(previous.pid !== undefined);
  writeSlotMarker(orderDir, eventId, 1, { pid: previous.pid, parentPid: previous.pid });
  const outcome = await waitForPreviousSlot({ orderDir, eventId, slot: 2, timings: { ...testTimings, slotWaitMs: 5_000 } });
  const resumedAt = Date.now();
  assert.equal(outcome, 'afterPrevious');
  assert.ok(resumedAt >= await previousExited, 'not before the previous process ended');
});

test('the chain: a broken slot\'s successor gives up after one bound and the slot after it follows THAT one — the order holds past the gap', async () => {
  const orderDir = createOrderDir();
  const gonePid = getGonePid();
  writeSlotMarker(orderDir, eventId, 1, { pid: gonePid, parentPid: gonePid });
  // Slot 2 never ends. Slot 3 waits one bound for it, then goes and leaves its marker; slot 4 (two links behind slot 1) would wait
  // two bounds, but follows slot 3 as soon as slot 3 is done.
  const startedAt = Date.now();
  const doneAt: Record<number, number> = {};
  const third = waitForPreviousSlot({ orderDir, eventId, slot: 3, timings: testTimings }).then((outcome) => {
    doneAt[3] = Date.now();
    writeSlotMarker(orderDir, eventId, 3, { pid: gonePid, parentPid: gonePid });
    return outcome;
  });
  const fourth = waitForPreviousSlot({ orderDir, eventId, slot: 4, timings: testTimings }).then((outcome) => {
    doneAt[4] = Date.now();
    return outcome;
  });
  assert.deepEqual(await Promise.all([third, fourth]), ['timedOut', 'afterPrevious']);
  assert.ok(doneAt[3] - startedAt >= testTimings.slotWaitMs, 'slot 3 gave slot 2 its bound');
  assert.ok(doneAt[4] >= doneAt[3], 'slot 4 went after slot 3');
  assert.ok(doneAt[4] - startedAt < 2 * testTimings.slotWaitMs, `slot 4 did not wait its own two bounds: ${doneAt[4] - startedAt} ms`);
});

test('a slot\'s run: an EMPTY slot leaves its marker at once; a slot with a part prints after the previous one, leaves its marker and deletes the one it read; the LAST part clears the compaction\'s markers', async () => {
  const orderDir = createOrderDir();
  const { transcriptPath } = createSession({ small: '# small\n', big: bigBody });
  const input = buildInput(transcriptPath);
  const plan = planSkillsRestoreSlot(input, getSlotArguments(2, { orderDir }));
  assert.ok(plan.eventId !== null && plan.output !== null, 'slot 2 holds a part of this restore');
  const printed: string[] = [];
  const write = async (output: string): Promise<void> => { printed.push(output); };

  await runSkillsRestoreSlot(input, getSlotArguments(24, { orderDir }), write, testTimings);
  assert.deepEqual(printed, [], 'slot 24 has no part');
  assert.ok(fs.existsSync(path.join(orderDir, `${plan.eventId}-24`)), 'the empty slot left its marker at once');

  const gonePid = getGonePid();
  writeSlotMarker(orderDir, plan.eventId, 1, { pid: gonePid, parentPid: gonePid });
  await runSkillsRestoreSlot(input, getSlotArguments(2, { orderDir }), write, testTimings);
  assert.deepEqual(printed, [plan.output]);
  assert.deepEqual(fs.readdirSync(orderDir).sort(), [`${plan.eventId}-2`, `${plan.eventId}-24`], 'its own marker left, the one it read gone');

  // The last part's slot ends the chain: every marker of this compaction goes; another compaction's stays.
  assert.ok(plan.partCount > 2, `the big skill takes several parts (${plan.partCount})`);
  writeSlotMarker(orderDir, plan.eventId, plan.partCount - 1, { pid: gonePid, parentPid: gonePid });
  writeSlotMarker(orderDir, otherEventId, 1, { pid: gonePid, parentPid: gonePid });
  await runSkillsRestoreSlot(input, getSlotArguments(plan.partCount, { orderDir }), write, testTimings);
  assert.equal(printed.length, 2, 'the last part printed');
  assert.deepEqual(fs.readdirSync(orderDir), [`${otherEventId}-1`], 'nothing of this compaction is left behind');
});

test('the compaction id: the same for every slot of one compaction, another for the next compaction of the same session; none without a restore', () => {
  const { transcriptPath } = createSession({ small: '# small\n', big: bigBody });
  const ids = new Set(Array.from({ length: 24 }, (_value, index) => planSkillsRestoreSlot(buildInput(transcriptPath), getSlotArguments(index + 1)).eventId));
  assert.equal(ids.size, 1);
  const [firstId] = [...ids];
  assert.match(firstId ?? '', /^[0-9a-f]{24}$/);
  // The next compaction: the previous one's boundary, then the records of the new epoch — the same skills again.
  const nextEpoch = fs.readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean).slice(2);
  fs.appendFileSync(transcriptPath, `${[JSON.stringify({ type: 'system', subtype: 'compact_boundary' }), ...nextEpoch.map((line) => line.replace('toolu_', 'toolu_next_'))].join('\n')}\n`);
  const nextId = planSkillsRestoreSlot(buildInput(transcriptPath), getSlotArguments(1)).eventId;
  assert.ok(nextId !== null && nextId !== firstId, 'a marker of the previous compaction is never this one\'s');
  assert.equal(planSkillsRestoreSlot(buildInput(createSession({}).transcriptPath), getSlotArguments(1)).eventId, null);
});

test('the sweep: markers older than the bound go, fresh ones and other files stay', () => {
  const orderDir = createOrderDir();
  const gonePid = getGonePid();
  writeSlotMarker(orderDir, eventId, 1, { pid: gonePid, parentPid: gonePid });
  writeSlotMarker(orderDir, otherEventId, 3, { pid: gonePid, parentPid: gonePid });
  fs.writeFileSync(path.join(orderDir, 'notes.txt'), 'not a marker');
  const old = new Date(Date.now() - skillsRestoreMarkerMaxAgeMs - 60_000);
  fs.utimesSync(path.join(orderDir, `${otherEventId}-3`), old, old);
  fs.utimesSync(path.join(orderDir, 'notes.txt'), old, old);
  sweepStaleSlotMarkers(orderDir, Date.now() - skillsRestoreMarkerMaxAgeMs);
  assert.deepEqual(fs.readdirSync(orderDir).sort(), [`${eventId}-1`, 'notes.txt']);
});
