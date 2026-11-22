import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  claudeRuntimeInfoTailBytes,
  getClaudeContextWindowTokens,
  parseClaudeRuntimeInfo,
  readClaudeContextUsedTokens,
  readClaudeFirstCallContextTokens,
  readClaudeRuntimeInfo,
} from '../utils/claudeRuntimeInfo';

const procSelfFdDirectory = '/proc/self/fd';
const tailPaddingCharacter = 'x';
/**
 * Counting open descriptors reads procfs, which only exists on Linux. Elsewhere
 * the descriptor-leak assertion is skipped rather than failing the whole test —
 * the parsing assertions it shares a fixture with stay platform-independent.
 */
const isOpenDescriptorCountSupported = process.platform === 'linux' && fs.existsSync(procSelfFdDirectory);

function createClaudeTailPaddingRecord(contentLength: number): string {
  return JSON.stringify({ type: 'user', message: { content: tailPaddingCharacter.repeat(contentLength) } });
}

function getOpenFileDescriptorCount(filePath: string): number | null {
  if (!isOpenDescriptorCountSupported) return null;
  const realFilePath = fs.realpathSync(filePath);
  return fs.readdirSync(procSelfFdDirectory).reduce((count, descriptor) => {
    try {
      return fs.readlinkSync(path.join(procSelfFdDirectory, descriptor)) === realFilePath ? count + 1 : count;
    } catch {
      // A descriptor can close after readdirSync and before its procfs link is read.
      return count;
    }
  }, 0);
}

test('maps only known Claude model families to their documented context windows', () => {
  for (const model of [
    'claude-haiku-4-5-20251001',
    'claude-sonnet-4-5-20250929',
    'claude-opus-4-5-20251101',
  ]) {
    assert.equal(getClaudeContextWindowTokens(model), 200_000);
  }
  for (const model of [
    'claude-sonnet-4-6',
    'claude-opus-4-7',
    'claude-opus-4-8',
    'claude-opus-5-0',
  ]) {
    assert.equal(getClaudeContextWindowTokens(model), 1_000_000);
  }
  assert.equal(getClaudeContextWindowTokens('claude-sonnet-4-4'), null);
  assert.equal(getClaudeContextWindowTokens('claude-opus-6-0'), null);
  assert.equal(getClaudeContextWindowTokens('opus'), null);
  // Real released ids whose family carries no minor: their 8-digit DATE must
  // never be read as one. `claude-opus-4-20250514` is a 200k model, so parsing
  // `20250514` as the minor reported a 1M window — worse than unknown. Staying
  // null keeps the module's rule that an unrecognised id never inherits a
  // neighbour's window.
  assert.equal(getClaudeContextWindowTokens('claude-opus-4-20250514'), null);
  assert.equal(getClaudeContextWindowTokens('claude-opus-4-1-20250805'), null);
});

test('uses the latest valid main-session metadata and ignores sidechain records', () => {
  const transcript = [
    JSON.stringify({ version: '2.1.0', type: 'user', message: { role: 'user', content: 'hello' } }),
    JSON.stringify({
      version: '9.9.9',
      isSidechain: true,
      type: 'assistant',
      message: {
        model: 'claude-opus-5-0',
        usage: { input_tokens: 999_999, cache_read_input_tokens: 1, cache_creation_input_tokens: 1 },
      },
    }),
    JSON.stringify({
      version: '2.1.1',
      type: 'assistant',
      message: {
        model: 'claude-sonnet-4-5-20250929',
        usage: { input_tokens: 150_000, cache_read_input_tokens: 12_000, cache_creation_input_tokens: 3_000 },
      },
    }),
    JSON.stringify({ version: '2.1.2', type: 'assistant', message: { content: [] } }),
    '{"type":"assistant",',
  ].join('\n');

  assert.deepEqual(parseClaudeRuntimeInfo(transcript), {
    version: '2.1.2',
    // The sidechain's `claude-opus-5-0` must not surface as the session's model.
    model: 'claude-sonnet-4-5-20250929',
    contextWindowTokens: 200_000,
    contextUsedTokens: 165_000,
  });
});

test('returns unknown context limits for unrecognised models without discarding valid usage', () => {
  const transcript = JSON.stringify({
    version: '2.1.3',
    type: 'assistant',
    message: {
      model: 'custom-model',
      usage: { input_tokens: 700, cache_read_input_tokens: 20, cache_creation_input_tokens: 4 },
    },
  });

  assert.deepEqual(parseClaudeRuntimeInfo(transcript), {
    version: '2.1.3',
    // An unrecognised model is still NAMED — only its limit stays unknown.
    model: 'custom-model',
    contextWindowTokens: null,
    contextUsedTokens: 724,
  });
});

test('includes generated assistant output in the next context use', () => {
  const transcript = JSON.stringify({
    type: 'assistant',
    message: {
      model: 'claude-sonnet-4-5-20250929',
      usage: {
        input_tokens: 700,
        output_tokens: 120,
        cache_read_input_tokens: 20,
        cache_creation_input_tokens: 4,
      },
    },
  });

  assert.deepEqual(parseClaudeRuntimeInfo(transcript), {
    version: null,
    model: 'claude-sonnet-4-5-20250929',
    contextWindowTokens: 200_000,
    contextUsedTokens: 844,
  });
});

test('keeps model limits and usage paired to the same latest valid assistant entry', () => {
  const transcript = [
    JSON.stringify({
      type: 'assistant',
      message: {
        model: 'claude-sonnet-4-5-20250929',
        usage: { input_tokens: 150_000, cache_read_input_tokens: 12_000, cache_creation_input_tokens: 3_000 },
      },
    }),
    JSON.stringify({
      type: 'assistant',
      message: {
        model: 'claude-opus-4-8',
        usage: { cache_read_input_tokens: 10 },
      },
    }),
  ].join('\n');

  assert.deepEqual(parseClaudeRuntimeInfo(transcript), {
    version: null,
    // The later `claude-opus-4-8` entry carries no usable usage, so the model
    // must stay paired with the entry the reported usage came from.
    model: 'claude-sonnet-4-5-20250929',
    contextWindowTokens: 200_000,
    contextUsedTokens: 165_000,
  });
});

test('returns only unknown values for malformed or absent transcript metadata', () => {
  assert.deepEqual(parseClaudeRuntimeInfo('{not json}\n{}'), {
    version: null,
    model: null,
    contextWindowTokens: null,
    contextUsedTokens: null,
  });
});

test('reads runtime metadata from a bounded tail, discards its first line, and closes the descriptor', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcode-claude-runtime-'));
  const transcriptPath = path.join(tempDir, 'session.jsonl');
  try {
    const prefixRecord = JSON.stringify({ version: '1.0.0', type: 'user', message: { content: 'prefix' } });
    const discardedTailContextRecord = JSON.stringify({
      version: '1.0.0',
      type: 'assistant',
      message: {
        model: 'claude-sonnet-4-5-20250929',
        usage: { input_tokens: 150_000, cache_read_input_tokens: 12_000, cache_creation_input_tokens: 3_000 },
      },
    });
    const laterTailRecords = [
      JSON.stringify({ version: '2.1.2', type: 'user', message: { role: 'user', content: 'latest prompt' } }),
      JSON.stringify({
        version: '2.1.3',
        type: 'assistant',
        message: { model: 'custom-model', usage: { input_tokens: 'unknown' } },
      }),
    ];
    const tailWithoutPadding = [discardedTailContextRecord, createClaudeTailPaddingRecord(0), ...laterTailRecords].join('\n');
    const tailPaddingLength = claudeRuntimeInfoTailBytes - Buffer.byteLength(tailWithoutPadding);
    assert.ok(tailPaddingLength > 0, 'fixture must leave room to pad the bounded tail exactly');
    const boundedTail = [
      discardedTailContextRecord,
      createClaudeTailPaddingRecord(tailPaddingLength),
      ...laterTailRecords,
    ].join('\n');
    assert.equal(Buffer.byteLength(boundedTail), claudeRuntimeInfoTailBytes, 'tail must start exactly at a complete assistant record');

    const transcript = `${prefixRecord}\n${boundedTail}`;
    fs.writeFileSync(transcriptPath, transcript);

    const descriptorCountBeforeRead = getOpenFileDescriptorCount(transcriptPath);
    const runtimeInfo = await readClaudeRuntimeInfo(transcriptPath);
    const descriptorCountAfterRead = getOpenFileDescriptorCount(transcriptPath);

    assert.deepEqual(runtimeInfo, {
      version: '2.1.3',
      // The only fully-valid record sits in the discarded partial first line,
      // so no model is claimed from the bounded tail.
      model: null,
      contextWindowTokens: null,
      contextUsedTokens: null,
    });
    if (isOpenDescriptorCountSupported) {
      assert.equal(descriptorCountAfterRead, descriptorCountBeforeRead, 'reader must close its transcript descriptor');
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// ── the context of the FIRST model call after the last compaction (the idle compaction's baseline) ──

const boundaryRecord = JSON.stringify({ type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', compactMetadata: { trigger: 'manual' } });
const summaryRecord = JSON.stringify({ type: 'user', isCompactSummary: true, message: { role: 'user', content: 'the summary' } });

function createAssistantRecord(usage: { input: number; cacheRead?: number; cacheCreation?: number; output?: number }, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      model: 'claude-opus-4-6',
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: usage.input, cache_read_input_tokens: usage.cacheRead ?? 0, cache_creation_input_tokens: usage.cacheCreation ?? 0, output_tokens: usage.output ?? 0 },
    },
    ...extra,
  });
}

function writeLines(lines: readonly string[]): string {
  const filePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-first-call-')), 'session.jsonl');
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`);
  return filePath;
}

test('readClaudeFirstCallContextTokens: the first model call AFTER the last compaction — input + cache read + cache write, never the older epoch, the turn\'s last call or the output', async () => {
  const filePath = writeLines([
    createAssistantRecord({ input: 9, cacheRead: 500_000 }), // an older epoch
    boundaryRecord,
    summaryRecord,
    createAssistantRecord({ input: 3, cacheRead: 21_000, cacheCreation: 1_000, output: 400 }), // the first call of the next turn
    createAssistantRecord({ input: 5, cacheRead: 90_000, cacheCreation: 2_000, output: 1_200 }), // the same turn's last call, 120k later
  ]);
  assert.equal(await readClaudeFirstCallContextTokens(filePath), 22_003);
  assert.equal(await readClaudeContextUsedTokens(filePath), 5 + 90_000 + 2_000 + 1_200, 'while the context in use now is the last call\'s, output included');
});

test('readClaudeFirstCallContextTokens: a conversation never compacted gives its first call; a sidechain, a synthetic or error message, a record with no tokens and a line that only mentions an assistant record are no model call of it', async () => {
  const filePath = writeLines([
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'the text "type":"assistant" is quoted here' } }),
    createAssistantRecord({ input: 7, cacheRead: 99_999 }, { isSidechain: true }),
    createAssistantRecord({ input: 8, cacheRead: 88_888 }, { isApiErrorMessage: true }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', model: '<synthetic>', content: [], usage: { input_tokens: 4, cache_read_input_tokens: 77_777 } } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', model: 'claude-opus-4-6', content: [] } }),
    createAssistantRecord({ input: 0 }),
    createAssistantRecord({ input: 2, cacheRead: 30_000, cacheCreation: 8_000 }),
    createAssistantRecord({ input: 6, cacheRead: 60_000 }),
  ]);
  assert.equal(await readClaudeFirstCallContextTokens(filePath), 38_002);
});

test('readClaudeFirstCallContextTokens: a long first turn does not push the figure out of reach — the walk goes back to the boundary, past the runtime info\'s 128 KiB tail and one read chunk', async () => {
  const padding = Array.from({ length: 40 }, () => createClaudeTailPaddingRecord(100_000)); // ~4 MB of tool output inside the epoch
  const filePath = writeLines([
    createAssistantRecord({ input: 1, cacheRead: 400_000 }),
    boundaryRecord,
    summaryRecord,
    createAssistantRecord({ input: 3, cacheRead: 24_000, cacheCreation: 500 }),
    ...padding,
    createAssistantRecord({ input: 4, cacheRead: 180_000 }),
  ]);
  assert.ok(fs.statSync(filePath).size > 3 * claudeRuntimeInfoTailBytes);
  assert.equal(await readClaudeFirstCallContextTokens(filePath), 24_503);
});

test('readClaudeFirstCallContextTokens: nothing when the epoch holds no model call yet, the file cannot be read or is empty', async () => {
  assert.equal(await readClaudeFirstCallContextTokens(writeLines([createAssistantRecord({ input: 1, cacheRead: 1_000 }), boundaryRecord, summaryRecord])), null, 'a compaction just done, no turn yet');
  assert.equal(await readClaudeFirstCallContextTokens(path.join(os.tmpdir(), 'no-such-dir', 'session.jsonl')), null);
  assert.equal(await readClaudeFirstCallContextTokens(writeLines([])), null);
  assert.equal(await readClaudeContextUsedTokens(path.join(os.tmpdir(), 'no-such-dir', 'session.jsonl')), null);
});
