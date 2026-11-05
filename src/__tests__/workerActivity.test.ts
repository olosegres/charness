/**
 * @description Coverage for the «now» of a worker's status line (`scheduler/workerActivity.ts`): what a detached worker did
 * LAST, read from its event log in both worker formats — Claude Code `stream-json` and OpenCode `--format json` — with the
 * newest `events*.jsonl` of the run directory, the 1 MiB tail, and every unreadable case answering `null` rather than throwing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { checkStatusActivityMaxChars } from '../scheduler/checkStatus';
import { getWorkerActivityFromLines, readWorkerActivity, workerActivityTailBytes } from '../scheduler/workerActivity';

/** One Claude `assistant` event carrying the given content blocks. */
function claudeAssistant(...blocks: object[]): string {
  return JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: blocks } });
}

function claudeToolUse(name: string, input?: object): object {
  return { type: 'tool_use', id: 'toolu_1', name, ...(input === undefined ? {} : { input }) };
}

function claudeText(text: string): object {
  return { type: 'text', text };
}

/** The Claude events that carry no activity of their own and come between the interesting ones. */
const claudeNoiseLines = [
  JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta' } }),
  JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] } }),
  JSON.stringify({ type: 'system', subtype: 'init', model: 'some-model' }),
  JSON.stringify({ type: 'tool_progress', tool_use_id: 'toolu_1', elapsed_time_seconds: 3 }),
  JSON.stringify({ type: 'rate_limit_event', rate_limit_info: {} }),
];

function openCodeTool(tool: string, state?: object): string {
  return JSON.stringify({ type: 'tool_use', sessionID: 'ses_1', part: { type: 'tool', tool, ...(state === undefined ? {} : { state }) } });
}

function openCodeText(text: string): string {
  return JSON.stringify({ type: 'text', sessionID: 'ses_1', part: { type: 'text', text } });
}

// ─── Claude stream-json ──────────────────────────────────────────────

test('claude: the last tool call reads «<tool>: <description>»', () => {
  const lines = [claudeAssistant(claudeText('Starting.')), claudeAssistant(claudeToolUse('Bash', { command: 'yarn test', description: 'Run the unit tests' }))];
  assert.equal(getWorkerActivityFromLines(lines), 'Bash: Run the unit tests');
});

test('claude: whichever came LAST wins — a tool call after a text, a text after a tool call', () => {
  const textThenTool = [claudeAssistant(claudeText('Looking at it.')), claudeAssistant(claudeToolUse('Read', { file_path: 'src/a.ts' }))];
  assert.equal(getWorkerActivityFromLines(textThenTool), 'Read: src/a.ts');
  const toolThenText = [claudeAssistant(claudeToolUse('Read', { file_path: 'src/a.ts' })), claudeAssistant(claudeText('All three scopes are committed.'))];
  assert.equal(getWorkerActivityFromLines(toolThenText), 'All three scopes are committed.');
});

test('claude: the detail of a tool call is its description, else command, file_path, pattern, prompt — and none is the bare tool name', () => {
  const detailOf = (input?: object): string | null => getWorkerActivityFromLines([claudeAssistant(claudeToolUse('Tool', input))]);
  assert.equal(detailOf({ description: 'D', command: 'C', file_path: 'F', pattern: 'P', prompt: 'Q' }), 'Tool: D');
  assert.equal(detailOf({ command: 'C', file_path: 'F', pattern: 'P', prompt: 'Q' }), 'Tool: C');
  assert.equal(detailOf({ file_path: 'F', pattern: 'P', prompt: 'Q' }), 'Tool: F');
  assert.equal(detailOf({ pattern: 'P', prompt: 'Q' }), 'Tool: P');
  assert.equal(detailOf({ prompt: 'Q' }), 'Tool: Q');
  assert.equal(detailOf({ description: '   ', command: 'C' }), 'Tool: C', 'a blank description does not hide the command');
  assert.equal(detailOf({ unrelated: 'x' }), 'Tool');
  assert.equal(detailOf(), 'Tool');
});

test('claude: noise between and after the activity is skipped', () => {
  const lines = [claudeAssistant(claudeToolUse('Bash', { description: 'Build' })), ...claudeNoiseLines];
  assert.equal(getWorkerActivityFromLines(lines), 'Bash: Build');
});

test('claude: an event with several blocks answers its last readable one; thinking and blank text are skipped', () => {
  const thinking = { type: 'thinking', thinking: 'hmm', signature: 's' };
  const lines = [claudeAssistant(claudeText('First.'), claudeToolUse('Edit', { file_path: 'b.ts' }), thinking, claudeText('  \n '))];
  assert.equal(getWorkerActivityFromLines(lines), 'Edit: b.ts');
  assert.equal(getWorkerActivityFromLines([claudeAssistant(thinking)]), null, 'an event with nothing readable says nothing');
});

test('claude: a line the worker is still writing, a blank line and a non-object line are skipped', () => {
  const lines = [claudeAssistant(claudeToolUse('Bash', { description: 'Lint' })), '', '[1,2]', 'null', '{"type":"assistant","message":{"content":[{"type":"te'];
  assert.equal(getWorkerActivityFromLines(lines), 'Bash: Lint');
});

test('claude: the line is one line — whitespace collapsed — and at most the limit, cut with an ellipsis', () => {
  const lines = [claudeAssistant(claudeText(`Done:\n\n  a\tb   ${'z'.repeat(200)}`))];
  const activity = getWorkerActivityFromLines(lines);
  assert.equal(activity?.length, checkStatusActivityMaxChars);
  assert.ok(activity?.startsWith('Done: a b zzz'));
  assert.ok(activity?.endsWith('…'));
});

test('nothing readable: no lines, only noise, or only unknown events answer null', () => {
  assert.equal(getWorkerActivityFromLines([]), null);
  assert.equal(getWorkerActivityFromLines(claudeNoiseLines), null);
  assert.equal(getWorkerActivityFromLines([JSON.stringify({ type: 'something_new', part: { text: 'x' } })]), null);
});

// ─── OpenCode --format json ──────────────────────────────────────────

test('opencode: a tool call reads «<tool>: <description of its input>», else its title, else the bare tool', () => {
  const withDescription = openCodeTool('bash', { status: 'completed', title: 'yarn test', input: { command: 'yarn test', description: 'Run the unit tests' } });
  assert.equal(getWorkerActivityFromLines([withDescription]), 'bash: Run the unit tests');
  const withTitle = openCodeTool('read', { status: 'completed', title: 'src/a.ts', input: { filePath: '/x/src/a.ts' } });
  assert.equal(getWorkerActivityFromLines([withTitle]), 'read: src/a.ts');
  assert.equal(getWorkerActivityFromLines([openCodeTool('glob', { status: 'running' })]), 'glob');
  assert.equal(getWorkerActivityFromLines([openCodeTool('glob')]), 'glob');
});

test('opencode: the last text or tool call wins; step events and torn lines are skipped', () => {
  const stepFinish = JSON.stringify({ type: 'step_finish', part: { type: 'step-finish', reason: 'tool-calls' } });
  const stepStart = JSON.stringify({ type: 'step_start', part: { type: 'step-start' } });
  const toolThenText = [openCodeTool('bash', { title: 'make', input: { description: 'Build' } }), stepFinish, openCodeText('Build is green.'), stepFinish, stepStart, '{"type":"tex'];
  assert.equal(getWorkerActivityFromLines(toolThenText), 'Build is green.');
  const textThenTool = [openCodeText('Trying.'), openCodeTool('edit', { title: 'a.ts' }), stepFinish];
  assert.equal(getWorkerActivityFromLines(textThenTool), 'edit: a.ts');
  assert.equal(getWorkerActivityFromLines([openCodeText('   ')]), null, 'a blank text says nothing');
});

// ─── the run directory ───────────────────────────────────────────────

function withRunDir(run: (runDir: string) => Promise<void>): Promise<void> {
  const runDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'worker-activity-')));
  return run(runDir).finally(() => fs.rmSync(runDir, { recursive: true, force: true }));
}

/** Write a log whose modification time is exactly `modifiedAtMs`, so the «newest» is decided by the test, not by the disk clock. */
function writeLog(runDir: string, fileName: string, lines: string[], modifiedAtMs: number): void {
  const filePath = path.join(runDir, fileName);
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`);
  fs.utimesSync(filePath, new Date(modifiedAtMs), new Date(modifiedAtMs));
}

const baseMs = Date.parse('2026-11-05T10:00:00.000Z');

test('run dir: the newest events*.jsonl is read — a resume’s events-2.jsonl wins over events.jsonl', async () => {
  await withRunDir(async (runDir) => {
    writeLog(runDir, 'events.jsonl', [claudeAssistant(claudeToolUse('Bash', { description: 'First run' }))], baseMs);
    assert.equal(await readWorkerActivity(runDir), 'Bash: First run');
    writeLog(runDir, 'events-2.jsonl', [openCodeTool('bash', { input: { description: 'Resumed run' } })], baseMs + 60_000);
    assert.equal(await readWorkerActivity(runDir), 'bash: Resumed run');
  });
});

test('run dir: the newest by modification time decides, whatever the numbers; on a tie the higher run number', async () => {
  await withRunDir(async (runDir) => {
    writeLog(runDir, 'events-3.jsonl', [claudeAssistant(claudeText('Run three.'))], baseMs);
    writeLog(runDir, 'events-2.jsonl', [claudeAssistant(claudeText('Run two.'))], baseMs + 60_000);
    assert.equal(await readWorkerActivity(runDir), 'Run two.', 'the most recently written log is the live one');
    writeLog(runDir, 'events-2.jsonl', [claudeAssistant(claudeText('Run two.'))], baseMs);
    assert.equal(await readWorkerActivity(runDir), 'Run three.', 'equal times: the later run');
  });
});

test('run dir: only top-level events*.jsonl count — other names and a nested folder are ignored', async () => {
  await withRunDir(async (runDir) => {
    writeLog(runDir, 'events.jsonl', [claudeAssistant(claudeText('The real log.'))], baseMs);
    const newer = baseMs + 600_000;
    writeLog(runDir, 'events.jsonl.bak', [claudeAssistant(claudeText('A backup.'))], newer);
    writeLog(runDir, 'events-x.jsonl', [claudeAssistant(claudeText('Not a run number.'))], newer);
    writeLog(runDir, 'stderr.log', [claudeAssistant(claudeText('A stderr log.'))], newer);
    fs.mkdirSync(path.join(runDir, 'nested'));
    writeLog(path.join(runDir, 'nested'), 'events.jsonl', [claudeAssistant(claudeText('A nested log.'))], newer);
    fs.mkdirSync(path.join(runDir, 'events-9.jsonl'));
    assert.equal(await readWorkerActivity(runDir), 'The real log.');
  });
});

test('run dir: a missing directory, a directory without a log, an empty log and a path that is a file all answer null', async () => {
  await withRunDir(async (runDir) => {
    assert.equal(await readWorkerActivity(path.join(runDir, 'not-there')), null);
    assert.equal(await readWorkerActivity(runDir), null, 'no log yet');
    writeLog(runDir, 'events.jsonl', [], baseMs);
    assert.equal(await readWorkerActivity(runDir), null, 'an empty log');
    const aFile = path.join(runDir, 'brief.md');
    fs.writeFileSync(aFile, 'x');
    assert.equal(await readWorkerActivity(aFile), null, 'a file is no run directory');
  });
});

test('run dir: only the last 1 MiB is read — an activity inside it is found in a large log, one before it is not', async () => {
  await withRunDir(async (runDir) => {
    const noiseLine = JSON.stringify({ type: 'stream_event', event: { delta: 'x'.repeat(4000) } });
    const noiseLinesPerMiB = Math.ceil(workerActivityTailBytes / (noiseLine.length + 1));

    // The activity is the last thing in a log over 1.5 MiB: found, and the cut first line of the tail does not break the read.
    const noise = Array.from({ length: Math.ceil(noiseLinesPerMiB * 1.5) }, () => noiseLine);
    writeLog(runDir, 'events.jsonl', [claudeAssistant(claudeText('Old news.')), ...noise, claudeAssistant(claudeToolUse('Bash', { description: 'Near the end' }))], baseMs);
    assert.ok(fs.statSync(path.join(runDir, 'events.jsonl')).size > workerActivityTailBytes * 1.5);
    assert.equal(await readWorkerActivity(runDir), 'Bash: Near the end');

    // The last activity is further back than the tail: nothing readable in it.
    writeLog(runDir, 'events.jsonl', [claudeAssistant(claudeText('Too far back.')), ...noise], baseMs + 60_000);
    assert.equal(await readWorkerActivity(runDir), null);
  });
});

test('run dir: a line the worker is writing at the end of the file does not hide the previous event', async () => {
  await withRunDir(async (runDir) => {
    const complete = claudeAssistant(claudeToolUse('Bash', { description: 'Compile' }));
    fs.writeFileSync(path.join(runDir, 'events.jsonl'), `${complete}\n{"type":"assistant","message":{"content":[{"type":"tex`);
    assert.equal(await readWorkerActivity(runDir), 'Bash: Compile');
  });
});
