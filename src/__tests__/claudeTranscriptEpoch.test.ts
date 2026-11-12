/**
 * @description The backwards reader of a Claude transcript's last epoch (`utils/claudeTranscriptEpoch.ts`): it returns the
 * lines after the LAST compaction boundary, oldest first, and stops there — however the file's size falls against its read
 * chunks, with multi-byte characters cut by a chunk's edge.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { readClaudeTranscriptEpochLines } from '../utils/claudeTranscriptEpoch';

const boundaryLine = JSON.stringify({ type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', compactMetadata: { trigger: 'auto' } });
const acceptAll = (): boolean => true;

function writeTranscript(lines: readonly string[], isNewlineAtEnd = true): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-epoch-'));
  const filePath = path.join(dir, 'session.jsonl');
  fs.writeFileSync(filePath, `${lines.join('\n')}${isNewlineAtEnd ? '\n' : ''}`);
  return filePath;
}

test('readClaudeTranscriptEpochLines: the lines after the LAST boundary, oldest first — earlier epochs are never read back', () => {
  const filePath = writeTranscript(['epoch-0 a', boundaryLine, 'epoch-1 a', boundaryLine, 'epoch-2 a', 'epoch-2 b']);
  assert.deepEqual(readClaudeTranscriptEpochLines(filePath, acceptAll), ['epoch-2 a', 'epoch-2 b']);
});

test('readClaudeTranscriptEpochLines: no boundary → the whole file; a missing file → nothing', () => {
  assert.deepEqual(readClaudeTranscriptEpochLines(writeTranscript(['a', 'b']), acceptAll), ['a', 'b']);
  assert.deepEqual(readClaudeTranscriptEpochLines('/nonexistent/session.jsonl', acceptAll), []);
});

test('readClaudeTranscriptEpochLines: a line that merely MENTIONS the boundary is no boundary; a last line with no newline is kept', () => {
  const mention = JSON.stringify({ type: 'user', message: { content: 'the subtype "compact_boundary" is in this text' } });
  const filePath = writeTranscript(['old', boundaryLine, mention, 'last-without-newline'], false);
  assert.deepEqual(readClaudeTranscriptEpochLines(filePath, acceptAll), [mention, 'last-without-newline']);
});

test('readClaudeTranscriptEpochLines: only the lines the filter accepts are kept (raw text, before any parse)', () => {
  const filePath = writeTranscript(['keep 1', 'drop', boundaryLine, 'keep 2', 'drop', 'keep 3']);
  assert.deepEqual(readClaudeTranscriptEpochLines(filePath, (line) => line.startsWith('keep')), ['keep 2', 'keep 3']);
});

test('readClaudeTranscriptEpochLines: over several read chunks, with multi-byte characters cut by a chunk\'s edge, every line comes back whole', () => {
  // ~3.5 MB of lines of two-byte and four-byte characters, so the 1 MiB reads land inside characters and inside lines.
  const epochLines = Array.from({ length: 9000 }, (_value, index) => `${index} ${'проверка 🙂 '.repeat(20)}${index}`);
  const tailLine = `tail ${'я'.repeat(2_000_000)}`;
  const filePath = writeTranscript(['before', boundaryLine, ...epochLines, tailLine]);
  assert.ok(fs.statSync(filePath).size > 3 * 1024 * 1024);
  const read = readClaudeTranscriptEpochLines(filePath, acceptAll);
  assert.equal(read.length, epochLines.length + 1);
  assert.deepEqual(read.slice(0, -1), epochLines);
  assert.equal(read.at(-1), tailLine, 'a line longer than a read chunk comes back whole');
});
