/**
 * @description What a transcript file holds decides whether the CLI can be launched on its session id: only a file with a
 * conversation entry can be resumed; the metadata-only stub the CLI leaves behind (live incident: a conversation whose
 * transcript the CLI's cleanup had removed) is refused by `--resume` AND `--session-id`, so it must never pass for a
 * conversation. The entry types below were measured against CLI 2.1.302 (`--resume` over a transcript of only that type).
 * And the running cost a `--resume` restores: the last `cost-state` entry of the conversation, which the CLI (2.1.304)
 * writes back at its exit — the start an API account's spend is counted from (`utils/claudeApiSpend.ts`).
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readClaudeTranscriptContent, readClaudeTranscriptRestoredCostUsd } from '../utils/claudeTranscriptContent';

const sessionId = '11111111-2222-4333-8444-555555555555';
const entry = (type: string): string => JSON.stringify({ type, sessionId });

/** The three metadata entries a stopped process wrote back into a transcript that was gone (the live stub, text redacted). */
const stubLines = [
  JSON.stringify({ type: 'last-prompt', lastPrompt: 'a prompt', leafUuid: '66666666-7777-4888-8999-000000000000', sessionId }),
  JSON.stringify({ type: 'ai-title', aiTitle: 'A title', sessionId }),
  JSON.stringify({ type: 'mode', mode: 'normal', sessionId }),
];

describe('readClaudeTranscriptContent', () => {
  let directory: string;

  before(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-transcript-content-'));
  });

  after(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  function write(name: string, content: string): string {
    const filePath = path.join(directory, `${name}.jsonl`);
    fs.writeFileSync(filePath, content);
    return filePath;
  }

  it('a file that is not there is absent', async () => {
    assert.equal(await readClaudeTranscriptContent(path.join(directory, 'nothing.jsonl')), 'absent');
  });

  it('an empty file and the CLI\'s metadata-only stub are not a conversation', async () => {
    assert.equal(await readClaudeTranscriptContent(write('empty', '')), 'metadataOnly');
    assert.equal(await readClaudeTranscriptContent(write('stub', `${stubLines.join('\n')}\n`)), 'metadataOnly');
    const everyMetadataType = ['last-prompt', 'ai-title', 'mode', 'atis-latch', 'cost-state', 'queue-operation', 'api-request', 'api-request-shape', 'api-request-blob', 'file-history-snapshot'];
    assert.equal(await readClaudeTranscriptContent(write('metadata', `${everyMetadataType.map(entry).join('\n')}\n`)), 'metadataOnly');
  });

  it('a transcript with a user, an assistant or an attachment entry is a conversation, wherever it comes', async () => {
    for (const type of ['user', 'assistant', 'attachment']) {
      assert.equal(await readClaudeTranscriptContent(write(`alone-${type}`, `${entry(type)}\n`)), 'conversation', type);
      assert.equal(await readClaudeTranscriptContent(write(`after-metadata-${type}`, `${stubLines.join('\n')}\n${entry(type)}\n`)), 'conversation', type);
    }
  });

  it('a torn or foreign line holds no conversation, and the lines around it still count', async () => {
    const torn = '{"type":"user","message":{"content":"half a li';
    assert.equal(await readClaudeTranscriptContent(write('torn-only', torn)), 'metadataOnly');
    assert.equal(await readClaudeTranscriptContent(write('garbage', `not json\n42\nnull\n${stubLines[0]}\n`)), 'metadataOnly');
    assert.equal(await readClaudeTranscriptContent(write('garbage-then-user', `not json\nnull\n${entry('user')}\n`)), 'conversation');
    assert.equal(await readClaudeTranscriptContent(write('user-then-torn', `${entry('user')}\n${torn}`)), 'conversation');
  });

  it('a type that only appears inside a message is not an entry type', async () => {
    const mention = JSON.stringify({ type: 'last-prompt', lastPrompt: '{"type":"user"} was in my prompt', sessionId });
    assert.equal(await readClaudeTranscriptContent(write('mention', `${mention}\n`)), 'metadataOnly');
  });

  it('a large transcript answers at its first conversation entry without reading on', async () => {
    const filePath = write('large', `${stubLines[0]}\n${entry('user')}\n${'x'.repeat(8 * 1024 * 1024)}\n`);
    const startedAt = Date.now();
    assert.equal(await readClaudeTranscriptContent(filePath), 'conversation');
    assert.ok(Date.now() - startedAt < 1000, 'the answer did not wait for the whole file');
  });

  it('a path that cannot be read for another reason than being absent is never taken for a stub that may be removed', async () => {
    assert.equal(await readClaudeTranscriptContent(directory), 'conversation', 'a directory in the transcript\'s place');
  });
});

describe('readClaudeTranscriptRestoredCostUsd', () => {
  let directory: string;

  before(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-transcript-cost-'));
  });

  after(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  function write(name: string, lines: readonly string[]): string {
    const filePath = path.join(directory, `${name}.jsonl`);
    fs.writeFileSync(filePath, `${lines.join('\n')}\n`);
    return filePath;
  }

  const costState = (totalCostUSD: unknown, ofSessionId = sessionId): string => JSON.stringify({ type: 'cost-state', sessionId: ofSessionId, totalCostUSD, totalAPIDuration: 1200 });

  it('is the conversation\'s LAST cost-state total, as the CLI restores it (each exit writes one)', async () => {
    assert.equal(await readClaudeTranscriptRestoredCostUsd(write('two-exits', [entry('user'), costState(0.5), entry('assistant'), costState(1.25), entry('user')]), sessionId), 1.25);
  });

  it('is 0 for a transcript with none: the CLI then counts from zero', async () => {
    assert.equal(await readClaudeTranscriptRestoredCostUsd(write('none', [entry('user'), entry('assistant')]), sessionId), 0);
  });

  it('skips another conversation\'s entry, a torn or NUL-padded line, a malformed total and a mention inside a message', async () => {
    const mention = JSON.stringify({ type: 'user', sessionId, message: { role: 'user', content: '{"type":"cost-state","totalCostUSD":99}' } });
    const lines = [costState(0.75), costState(5, '99999999-2222-4333-8444-555555555555'), `\0\0${costState(0.9)}`, costState(-1), costState('2'), costState(Number.MAX_VALUE), mention, '{"type":"cost-state","sessi'];
    assert.equal(await readClaudeTranscriptRestoredCostUsd(write('mixed', lines), sessionId), 0.9);
  });

  it('is unknown when the file cannot be read', async () => {
    assert.equal(await readClaudeTranscriptRestoredCostUsd(path.join(directory, 'nothing.jsonl'), sessionId), null);
  });
});
