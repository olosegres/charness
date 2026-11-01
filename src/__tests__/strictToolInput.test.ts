/**
 * @description `scheduler/strictToolInput.ts`: the closed-object builder behind every bot tool's input and the
 * unknown-key message an agent reads — the key named, the nearest allowed key hinted (a case or `_` difference, a key
 * that holds the other, a typo), every allowed key listed. The SDK-level behaviour (the error reaching the agent over
 * the real server) is covered in `schedulerMcpStrictInput.test.ts`.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import {
  buildUnknownKeysMessage,
  createStrictToolInput,
  findClosestKey,
  getUnknownKeysMessageOfUnion,
  runWithRefusalLogging,
} from '../scheduler/strictToolInput';

describe('findClosestKey', () => {
  const messageItemKeys = ['text', 'path', 'as_file'];

  it('matches a key that differs only by case or separators', () => {
    assert.equal(findClosestKey('asFile', messageItemKeys), 'as_file');
    assert.equal(findClosestKey('AS-FILE', messageItemKeys), 'as_file');
    assert.equal(findClosestKey('thread_key', ['threadKey']), 'threadKey');
  });

  it('matches a key that holds, or is held by, an allowed one', () => {
    assert.equal(findClosestKey('filePath', messageItemKeys), 'path');
    assert.equal(findClosestKey('path', ['paths', 'caption']), 'paths');
    assert.equal(findClosestKey('message', ['messages', 'threadKey']), 'messages');
  });

  it('matches a typo of up to a third of the key length, a swapped pair included', () => {
    assert.equal(findClosestKey('stauts', ['id', 'title', 'status']), 'status');
    assert.equal(findClosestKey('txt', messageItemKeys), 'text');
    assert.equal(findClosestKey('pths', ['paths', 'caption']), 'paths');
  });

  it('prefers the most specific kind of match: an exact one over a held one over a typo', () => {
    assert.equal(findClosestKey('Path', ['paths', 'path']), 'path');
    assert.equal(findClosestKey('filePaths', ['path', 'paths']), 'paths');
  });

  it('suggests nothing when no allowed key is near', () => {
    assert.equal(findClosestKey('caption', messageItemKeys), undefined);
    assert.equal(findClosestKey('content', messageItemKeys), undefined);
    assert.equal(findClosestKey('x', messageItemKeys), undefined);
    assert.equal(findClosestKey('anything', []), undefined);
  });

  it('does not take a short allowed key for a hit just because the unknown key holds its letters', () => {
    assert.equal(findClosestKey('width', ['id', 'title']), undefined);
  });

  it('does not take a much longer allowed key for a hit just because it holds the unknown one: `file` is not the as_file flag', () => {
    assert.equal(findClosestKey('file', ['as_file']), undefined);
    assert.equal(findClosestKey('file', ['text', 'as_file']), undefined);
    assert.equal(findClosestKey('thread', ['threadKey']), undefined);
    assert.equal(findClosestKey('case', ['uppercase']), undefined);
  });

  it('still takes an allowed key that is one character longer than the unknown one', () => {
    assert.equal(findClosestKey('message', ['messages']), 'messages');
    assert.equal(findClosestKey('path', ['paths']), 'paths');
    assert.equal(findClosestKey('Path', ['paths']), 'paths');
  });

  it('points the usual names for an attachment at the key that takes it, never at the as_file flag', () => {
    const attachmentNames = ['file', 'files', 'filename', 'filenames', 'image', 'images', 'attachment', 'attachments', 'File_Name'];
    for (const attachmentName of attachmentNames) {
      assert.equal(findClosestKey(attachmentName, ['text', 'path', 'as_file']), 'path', attachmentName);
      assert.equal(findClosestKey(attachmentName, ['paths', 'caption', 'as_file', 'threadKey']), 'paths', attachmentName);
    }
  });

  it('suggests an alias target only where the input has one', () => {
    assert.equal(findClosestKey('file', ['id', 'title', 'status', 'note', 'ref', 'position']), undefined);
    assert.equal(findClosestKey('image', ['attachmentId']), undefined);
  });
});

describe('buildUnknownKeysMessage', () => {
  it('names the key, hints at the nearest allowed one and lists every allowed key', () => {
    assert.equal(
      buildUnknownKeysMessage(['filePath'], ['text', 'path', 'as_file']),
      'unknown key `filePath` — did you mean `path`? Allowed: text, path, as_file.',
    );
  });

  it('hints at `path` for `file` on an item, as the commonest wrong name for an attachment', () => {
    assert.equal(
      buildUnknownKeysMessage(['file'], ['text', 'path', 'as_file']),
      'unknown key `file` — did you mean `path`? Allowed: text, path, as_file.',
    );
  });

  it('says only the key when nothing is near', () => {
    assert.equal(
      buildUnknownKeysMessage(['caption'], ['text', 'path', 'as_file']),
      'unknown key `caption`. Allowed: text, path, as_file.',
    );
  });

  it('gives each unknown key its own sentence', () => {
    assert.equal(
      buildUnknownKeysMessage(['filePath', 'caption'], ['text', 'path']),
      'unknown key `filePath` — did you mean `path`? unknown key `caption`. Allowed: text, path.',
    );
  });

  it('says so when the input takes no key at all', () => {
    assert.equal(buildUnknownKeysMessage(['x'], []), 'unknown key `x`. Allowed: none.');
  });
});

describe('createStrictToolInput', () => {
  const input = createStrictToolInput({ name: z.string(), count: z.number().optional() });

  it('accepts the keys it lists, optional ones left out', () => {
    assert.deepEqual(input.parse({ name: 'a' }), { name: 'a' });
    assert.deepEqual(input.parse({ name: 'a', count: 2 }), { name: 'a', count: 2 });
  });

  it('refuses an unknown key with the message, not a silent strip', () => {
    const result = input.safeParse({ name: 'a', coutn: 2 });
    assert.equal(result.success, false);
    assert.equal(
      result.error?.issues[0].message,
      'unknown key `coutn` — did you mean `count`? Allowed: name, count.',
    );
  });

  it('keeps the ordinary messages for everything else', () => {
    const result = input.safeParse({ name: 5 });
    assert.equal(result.success, false);
    assert.match(result.error?.issues[0].message ?? '', /expected string/);
  });

  it('closes a nested object and lifts its message out of a union', () => {
    const item = createStrictToolInput({ text: z.string().optional(), path: z.string().optional() });
    const batch = createStrictToolInput({
      messages: z.array(z.union([z.string(), item], { error: getUnknownKeysMessageOfUnion })),
    });
    const result = batch.safeParse({ messages: ['fine', { text: 'x', filePath: 'a.png' }] });
    assert.equal(result.success, false);
    assert.equal(
      result.error?.issues[0].message,
      'unknown key `filePath` — did you mean `path`? Allowed: text, path.',
    );
    assert.deepEqual(result.error?.issues[0].path, ['messages', 1]);
  });

  it('leaves a union failure with no unknown key to its default message', () => {
    const batch = createStrictToolInput({
      messages: z.array(z.union([z.string(), z.number()], { error: getUnknownKeysMessageOfUnion })),
    });
    const result = batch.safeParse({ messages: [true] });
    assert.equal(result.success, false);
    assert.equal(result.error?.issues[0].message, 'Invalid input');
  });
});

describe('the diagnostic line for a refused call', () => {
  const input = createStrictToolInput({ name: z.string(), count: z.number().optional() });

  /** The lines logged while `input` parses `value` inside a refusal-logging context for `toolName`. */
  function collectRefusalLines(value: object, toolName = 'some_tool'): string[] {
    const lines: string[] = [];
    runWithRefusalLogging({ toolName, log: (line) => lines.push(line) }, () => input.safeParse(value));
    return lines;
  }

  it('names the tool and the unknown keys, once', () => {
    assert.deepEqual(collectRefusalLines({ name: 'a', coutn: 2, extra: 1 }), [
      '[scheduler-mcp] some_tool refused a call: unknown key(s) ["coutn","extra"]',
    ]);
  });

  it('logs once for an unknown key inside a nested object, naming the tool whose call it was', () => {
    const batch = createStrictToolInput({
      messages: z.array(z.union([z.string(), createStrictToolInput({ path: z.string().optional() })], { error: getUnknownKeysMessageOfUnion })),
    });
    const lines: string[] = [];
    runWithRefusalLogging({ toolName: 'send_things', log: (line) => lines.push(line) }, () => batch.safeParse({ messages: ['ok', { filePath: 'a.png' }] }));
    assert.deepEqual(lines, ['[scheduler-mcp] send_things refused a call: unknown key(s) ["filePath"]']);
  });

  it('logs nothing for a call that is refused for another reason, or accepted', () => {
    assert.deepEqual(collectRefusalLines({ name: 5 }), []);
    assert.deepEqual(collectRefusalLines({}), []);
    assert.deepEqual(collectRefusalLines({ name: 'a', count: 1 }), []);
  });

  it('logs nothing outside a refusal-logging context', () => {
    assert.equal(input.safeParse({ name: 'a', coutn: 2 }).success, false);
  });

  it('keeps the line to one bounded line whatever the agent put in the keys', () => {
    const [line] = collectRefusalLines({ name: 'a', ['bad\nkey' + 'x'.repeat(500)]: 1 });
    assert.ok(!line.includes('\n'), line);
    assert.ok(line.length < 200, `${line.length} chars`);
    const manyKeys = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`key${index}`, index]));
    const [manyLine] = collectRefusalLines({ name: 'a', ...manyKeys });
    assert.ok(manyLine.length < 300, `${manyLine.length} chars`);
    assert.match(manyLine, /\(\+30 more\)$/);
  });

  it('a logger that throws does not turn the refusal into another failure', () => {
    const result = runWithRefusalLogging({ toolName: 'some_tool', log: () => { throw new Error('disk full'); } }, () => input.safeParse({ name: 'a', coutn: 2 }));
    assert.equal(result.success, false);
    assert.equal(result.error?.issues[0].message, 'unknown key `coutn` — did you mean `count`? Allowed: name, count.');
  });
});
