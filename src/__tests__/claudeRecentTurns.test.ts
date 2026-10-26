/**
 * @description Unit coverage for `readRecentClaudeTurns` — the pure reader that
 * pulls the last N conversational turns out of a Claude `.jsonl` transcript for
 * the resume context block.
 *
 * Fixtures are shaped like REAL Claude transcripts (same schema the existing
 * `claudeCliAdapter.sessions.test.ts` uses):
 *   user      → { type:'user',      message:{ role:'user',      content } }   content = string OR block array
 *   assistant → { type:'assistant', message:{ role:'assistant', content:[ {type:'text',text} | {type:'tool_use',…} ] } }
 *   summary   → { type:'summary', summary, leafUuid }  (meta — never a turn)
 *
 * The reader must: keep only user/assistant entries with renderable text,
 * concat an assistant's text blocks while ignoring tool_use, skip summary/meta
 * and tool_use-only assistant entries, and return the last `limit` in
 * chronological order.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readRecentClaudeTurns } from '../adapters/claudeCliAdapter';

const limit = 3;

function writeTranscript(filePath: string, entries: object[]): void {
  fs.writeFileSync(filePath, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

describe('readRecentClaudeTurns', () => {
  let dir: string;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-recent-turns-'));
  });

  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns [] for a missing file', () => {
    assert.deepEqual(readRecentClaudeTurns(path.join(dir, 'nope.jsonl'), limit), []);
  });

  it('returns the last 3 text turns chronologically, skipping meta + tool_use-only', () => {
    const filePath = path.join(dir, 'mixed.jsonl');
    writeTranscript(filePath, [
      // Five real turns precede the window — only the last 3 survive.
      { type: 'user', message: { role: 'user', content: 'turn 1 user' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'turn 2 assistant' }] } },
      // A summary line is meta, not a turn.
      { type: 'summary', summary: 'A conversation summary', leafUuid: 'whatever' },
      // An assistant entry that is ONLY a tool_use → no renderable text → skipped.
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: {} }] } },
      // Assistant that interleaves tool_use with two text blocks → concat the text only.
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'part A' },
            { type: 'tool_use', name: 'Read', input: {} },
            { type: 'text', text: 'part B' },
          ],
        },
      },
      { type: 'user', message: { role: 'user', content: 'final user turn' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'final assistant turn' }] } },
    ]);

    const turns = readRecentClaudeTurns(filePath, limit);

    // Exactly the last 3 renderable turns, oldest→newest. The tool_use-only
    // assistant and the summary never count as turns.
    assert.deepEqual(turns, [
      { role: 'assistant', text: 'part A\n\npart B' },
      { role: 'user', text: 'final user turn' },
      { role: 'assistant', text: 'final assistant turn' },
    ]);
  });

  it('reads user content as a bare string and as a text-block array', () => {
    const filePath = path.join(dir, 'user-shapes.jsonl');
    writeTranscript(filePath, [
      { type: 'user', message: { role: 'user', content: 'bare string user' } },
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'block-array user' }] } },
    ]);

    const turns = readRecentClaudeTurns(filePath, limit);
    assert.deepEqual(turns, [
      { role: 'user', text: 'bare string user' },
      { role: 'user', text: 'block-array user' },
    ]);
  });

  it('shows a slash command run in the CLI as just its name, and skips the caveat and stdout entries around it without letting them take a slot', () => {
    const filePath = path.join(dir, 'compacted.jsonl');
    writeTranscript(filePath, [
      { type: 'user', message: { role: 'user', content: 'older prompt' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'older answer' }] } },
      { type: 'user', message: { role: 'user', content: 'Run the tests' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'All tests pass.' }] } },
      {
        type: 'user',
        isMeta: true,
        message: { role: 'user', content: '<local-command-caveat>The command below was run directly in Claude Code, not sent to you as a request.</local-command-caveat>' },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: '<command-name>/compact</command-name>\n            <command-message>compact</command-message>\n            <command-args>Make the summary MAXIMALLY COMPLETE: keep every decision.</command-args>',
        },
      },
      { type: 'user', message: { role: 'user', content: '<local-command-stdout>Compacted PreCompact [grep -qF -e \'x\'] completed successfully</local-command-stdout>' } },
    ]);

    // The window is the last 3 REAL entries: the three skipped ones are not among them.
    assert.deepEqual(readRecentClaudeTurns(filePath, limit), [
      { role: 'user', text: 'Run the tests' },
      { role: 'assistant', text: 'All tests pass.' },
      { role: 'user', text: '/compact' },
    ]);
  });

  it('skips user entries made only of injected tags, in either content shape, and cuts an injected block out of a typed message', () => {
    const filePath = path.join(dir, 'injected.jsonl');
    writeTranscript(filePath, [
      { type: 'user', message: { role: 'user', content: '<system-reminder>be careful</system-reminder>' } },
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: '<task-notification>\n<task-id>abc</task-id>\n</task-notification>' }] } },
      { type: 'user', message: { role: 'user', content: '<local-command-stderr>boom</local-command-stderr>' } },
      { type: 'user', message: { role: 'user', content: '<system-reminder>be brief</system-reminder>\n\nfinal user turn' } },
    ]);

    assert.deepEqual(readRecentClaudeTurns(filePath, limit), [{ role: 'user', text: 'final user turn' }]);
  });

  it('tolerates a half-written trailing line without dropping earlier turns', () => {
    const filePath = path.join(dir, 'truncated.jsonl');
    const good = [
      { type: 'user', message: { role: 'user', content: 'kept turn' } },
    ];
    fs.writeFileSync(filePath, good.map((e) => JSON.stringify(e)).join('\n') + '\n{ "type": "assist');

    const turns = readRecentClaudeTurns(filePath, limit);
    assert.deepEqual(turns, [{ role: 'user', text: 'kept turn' }]);
  });
});
