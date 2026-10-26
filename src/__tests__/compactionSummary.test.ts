/**
 * @description Unit coverage for lifting the freshly-generated compaction summary
 * out of each backend so F2's idle notice can surface its "Where we stopped"
 * closing section:
 *  - OpenCode: `getLatestOpenCodeCompactionSummary` over `GET /message` records
 *    (the assistant message stored with `summary:true`).
 *  - Claude: `readLatestCompactSummaryFromTranscript` over the on-disk
 *    transcript's `isCompactSummary:true` line, and both Claude adapters'
 *    `getSessionCompactionSummary` (the context bridge's read, whatever the
 *    session's state).
 *
 * Plus the WIRING of `AgentAdapter.streamsCompactionSummary`, the one field that
 * decides whether the bot posts the summary itself: the pure gate rule is covered in
 * `compactOnIdle.test.ts`, but nothing there proves the flag is actually declared on
 * the backend that streams its own summary and absent on the ones that do not — and
 * a missing declaration would silently post a SECOND copy of OpenCode's summary in
 * every topic while every other test stayed green.
 *
 * Test case: n/a (no Jira tracker for this project).
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { OpenCodeAdapter, getLatestOpenCodeCompactionSummary } from '../adapters/openCodeAdapter';
import { ClaudeJsonStreamAdapter } from '../adapters/claudeJsonStreamAdapter';
import { readLatestCompactSummaryFromTranscript } from '../utils/claudeCompactSummary';
import { ClaudeCliAdapter, getClaudeTranscriptPath } from '../adapters/claudeCliAdapter';
import { type AgentAdapter } from '../types';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';

test('getLatestOpenCodeCompactionSummary: returns the newest summary:true assistant text', () => {
  const records = [
    { info: { role: 'user', id: 'u1' }, parts: [{ type: 'text', text: 'hi' }] },
    { info: { role: 'assistant', id: 'a1' }, parts: [{ type: 'text', text: 'a normal answer' }] },
    {
      info: { role: 'assistant', id: 's1', summary: true },
      parts: [{ type: 'text', text: '## Goals\n- ship it\n\n<<<WHERE_WE_STOPPED>>>\nmid-refactor' }],
    },
  ];
  const out = getLatestOpenCodeCompactionSummary(records);
  assert.ok(out);
  assert.ok(out.includes('## Goals'));
  assert.ok(out.includes('mid-refactor'));
});

test('getLatestOpenCodeCompactionSummary: no summary message → null', () => {
  const records = [{ info: { role: 'assistant', id: 'a1' }, parts: [{ type: 'text', text: 'answer' }] }];
  assert.equal(getLatestOpenCodeCompactionSummary(records), null);
  assert.equal(getLatestOpenCodeCompactionSummary('not-an-array'), null);
});

test('getLatestOpenCodeCompactionSummary: prefers the LAST summary when several exist', () => {
  const records = [
    { info: { role: 'assistant', id: 's1', summary: true }, parts: [{ type: 'text', text: 'old summary' }] },
    { info: { role: 'assistant', id: 's2', summary: true }, parts: [{ type: 'text', text: 'new summary' }] },
  ];
  assert.equal(getLatestOpenCodeCompactionSummary(records), 'new summary');
});

test('readLatestCompactSummaryFromTranscript: reads the isCompactSummary line content', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cjson-transcript-'));
  const file = path.join(dir, 'session.jsonl');
  try {
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } }),
        JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } }),
        JSON.stringify({
          type: 'user',
          isCompactSummary: true,
          message: { role: 'user', content: 'Summary:\n1. ...\n<<<WHERE_WE_STOPPED>>>\nmid-task\n<<<END_WHERE_WE_STOPPED>>>' },
        }),
      ].join('\n') + '\n',
    );
    const out = readLatestCompactSummaryFromTranscript(file);
    assert.ok(out);
    assert.ok(out.includes('Summary:'));
    assert.ok(out.includes('mid-task'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readLatestCompactSummaryFromTranscript: unreadable file → null', () => {
  assert.equal(readLatestCompactSummaryFromTranscript('/no/such/transcript.jsonl'), null);
});

for (const [adapterName, createAdapter] of [
  ['json-stream', () => new ClaudeJsonStreamAdapter()],
  ['tmux', () => new ClaudeCliAdapter()],
] as const) {
  test(`${adapterName} adapter getSessionCompactionSummary: the newest summary of a conversation that is not running — and it is not among the conversation's turns`, async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cjson-home-'));
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const key = makeTelegramKey(-1001111111111, 111);
      const workDir = '/example/work/project';
      const sessionId = randomUUID();
      const transcriptPath = getClaudeTranscriptPath(workDir, sessionId);
      fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
      fs.writeFileSync(
        transcriptPath,
        [
          { type: 'user', message: { role: 'user', content: 'hello' } },
          { type: 'user', isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { role: 'user', content: 'old summary' } },
          { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } },
          { type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted' },
          { type: 'user', isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { role: 'user', content: 'new summary' } },
        ].map((entry) => `${JSON.stringify(entry)}\n`).join(''),
      );
      const adapter = createAdapter();
      assert.equal(await adapter.getSessionCompactionSummary(key, workDir, sessionId), 'new summary');
      assert.deepEqual((await adapter.getRecentTurns(key, workDir, sessionId, 6)).map((turn) => turn.text), ['hello', 'ok'], 'the summary is no turn');
      assert.equal(await adapter.getSessionCompactionSummary(key, workDir, randomUUID()), null, 'a conversation with no transcript has none');
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
}

test('readLatestCompactSummaryFromTranscript: finds the summary among many lines that are not one, and tolerates a spaced key, a false flag and torn lines', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cjson-transcript-'));
  const file = path.join(dir, 'session.jsonl');
  try {
    const filler = Array.from({ length: 500 }, (_unused, index) => JSON.stringify({ type: 'user', message: { role: 'user', content: `line ${index}` } }));
    fs.writeFileSync(
      file,
      [
        ...filler,
        JSON.stringify({ type: 'user', isCompactSummary: false, message: { role: 'user', content: 'not a summary: the flag is false' } }),
        '{"type":"user","isCompactSummary":true,"message":{"role":"user","content":"torn summary line',
        '{ "type": "user", "isCompactSummary": true, "message": { "role": "user", "content": [{ "type": "text", "text": "spaced summary" }] } }',
        ...filler,
      ].join('\n') + '\n',
    );
    assert.equal(readLatestCompactSummaryFromTranscript(file), 'spaced summary');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('streamsCompactionSummary is declared ONLY by the backend whose summary already reaches the topic', () => {
  // OpenCode's `POST /session/:id/summarize` produces a real assistant message that
  // rides the SSE stream into the topic, so the bot must stay quiet; both Claude
  // backends write the summary only into their on-disk transcript and emit no
  // assistant text, so the bot is the ONLY thing that can surface it. The contrast is
  // the point: asserting the `true` alone would also pass on an adapter set where
  // every backend declared it and no summary was ever posted at all.
  const openCode: AgentAdapter = new OpenCodeAdapter();
  const jsonStream: AgentAdapter = new ClaudeJsonStreamAdapter();
  const tmuxScrape: AgentAdapter = new ClaudeCliAdapter();
  assert.equal(openCode.streamsCompactionSummary, true, 'OpenCode streams its own summary');
  assert.ok(
    !jsonStream.streamsCompactionSummary,
    'the json-stream backend emits no summary text — the bot must post it',
  );
  assert.ok(
    !tmuxScrape.streamsCompactionSummary,
    'the tmux backend emits no summary text either',
  );
});
