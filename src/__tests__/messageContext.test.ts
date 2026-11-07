/**
 * @description Unit coverage for the message-context helpers: joining the blocks that
 * apply to one message (the reply quote and the forwarded mark) and folding the result
 * ahead of a prompt — the rule every route a prompt takes (the live forward, the
 * startup buffer, a file or album announcement) shares.
 *
 * Cases:
 *   - the blocks of a message join in order, with a blank line between; absent ones
 *     are skipped; none at all → `undefined`;
 *   - folding: the block leads the prompt after a blank line; no block, a slash
 *     command or a terminal's shell line → the prompt unchanged.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { getPromptWithMessageContext, joinMessageContextBlocks } from '../utils/messageContext';

/** The block of a reply to the agent's answer, as the bridge renders it. */
const assistantBlock = ['[Replying to an earlier message · from: assistant]', '> X did Y'].join('\n');

/** The mark of a forwarded message, as the bridge renders it. */
const forwardedMark = '[Forwarded message · from: channel Ops · originally sent: 2026-11-06T18:20:00+04:00]';

/** An agent prompt — neither a slash command nor a terminal's shell line. */
const agentPrompt = { isSlashCommand: false, isShellInput: false };

test('joinMessageContextBlocks: the blocks of one message join in order, a blank line between', () => {
  assert.equal(joinMessageContextBlocks([assistantBlock, forwardedMark]), `${assistantBlock}\n\n${forwardedMark}`);
});

test('joinMessageContextBlocks: an absent block is skipped, whichever one it is', () => {
  assert.equal(joinMessageContextBlocks([undefined, forwardedMark]), forwardedMark);
  assert.equal(joinMessageContextBlocks([assistantBlock, undefined]), assistantBlock);
  assert.equal(joinMessageContextBlocks([null, '', forwardedMark]), forwardedMark);
});

test('joinMessageContextBlocks: no block at all → undefined, never an empty string', () => {
  assert.equal(joinMessageContextBlocks([undefined, null, '']), undefined);
  assert.equal(joinMessageContextBlocks([]), undefined);
});

test('getPromptWithMessageContext: the block leads the prompt, a blank line between', () => {
  assert.equal(
    getPromptWithMessageContext('why did it fail?', { ...agentPrompt, block: assistantBlock }),
    `${assistantBlock}\n\nwhy did it fail?`,
  );
});

test('getPromptWithMessageContext: no block (not a reply or a forward, or nothing to say) → the prompt unchanged', () => {
  assert.equal(getPromptWithMessageContext('why did it fail?', { ...agentPrompt, block: undefined }), 'why did it fail?');
});

test('getPromptWithMessageContext: a slash command stays a bare control token', () => {
  assert.equal(
    getPromptWithMessageContext('/compact', { ...agentPrompt, block: assistantBlock, isSlashCommand: true }),
    '/compact',
  );
});

test('getPromptWithMessageContext: a terminal shell line never carries the block', () => {
  // Typed into a shell, `> X did Y` would run `did Y` with its output
  // overwriting a file named `X` in the bound folder.
  assert.equal(
    getPromptWithMessageContext('ls -la', { ...agentPrompt, block: assistantBlock, isShellInput: true }),
    'ls -la',
  );
});

test('getPromptWithMessageContext: a forwarded mark leads the forwarded words like a quote does', () => {
  assert.equal(
    getPromptWithMessageContext('disk 91% on web-1', { ...agentPrompt, block: forwardedMark }),
    `${forwardedMark}\n\ndisk 91% on web-1`,
  );
});
