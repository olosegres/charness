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
});

describe('buildUnknownKeysMessage', () => {
  it('names the key, hints at the nearest allowed one and lists every allowed key', () => {
    assert.equal(
      buildUnknownKeysMessage(['filePath'], ['text', 'path', 'as_file']),
      'unknown key `filePath` — did you mean `path`? Allowed: text, path, as_file.',
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
