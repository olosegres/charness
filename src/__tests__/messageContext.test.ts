/**
 * @description Unit coverage for the message-context helpers: joining the blocks that
 * apply to one message (the reply quote and the forwarded mark) and folding the result
 * ahead of a prompt — the rule every route a prompt takes (the live forward, the
 * startup buffer, a file or album announcement) shares.
 *
 * Cases:
 *   - the blocks of a message join in order, with a blank line between; absent ones
 *     are skipped; none at all → `undefined`;
 *   - folding: the block leads the prompt after a blank line; no context, a slash
 *     command the operator typed or a terminal's shell line → the prompt unchanged;
 *   - a FORWARDED message is never a slash command: its words starting with `/` are folded under the mark.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { checkIsSlashCommandPrompt, getPromptWithMessageContext, joinMessageContextBlocks, type MessageContext } from '../utils/messageContext';

/** The block of a reply to the agent's answer, as the bridge renders it. */
const assistantBlock = ['[Replying to an earlier message · from: assistant]', '> X did Y'].join('\n');

/** The mark of a forwarded message, as the bridge renders it. */
const forwardedMark = '[Forwarded message · from: channel "Ops" · originally sent: 2026-11-06T18:20:00+04:00]';

/** What a typed reply carries, and what a forward carries. */
const replyContext: MessageContext = { block: assistantBlock, isForwarded: false };
const forwardContext: MessageContext = { block: forwardedMark, isForwarded: true };
/** A message of a topic member (not the operator): its mark leads, and it is flagged as somebody else's. */
const talkerMark = '[Message from topic member "Alice Smith" (@alice) · not the operator]';
const talkerContext: MessageContext = { block: talkerMark, isForwarded: false, nonOperatorSender: 'topic member "Alice Smith" (@alice)' };

/** An agent prompt — not a terminal's shell line. */
const agentPrompt = { isShellInput: false };

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
    getPromptWithMessageContext('why did it fail?', { ...agentPrompt, context: replyContext }),
    `${assistantBlock}\n\nwhy did it fail?`,
  );
});

test('getPromptWithMessageContext: no context (not a reply or a forward) → the prompt unchanged', () => {
  assert.equal(getPromptWithMessageContext('why did it fail?', { ...agentPrompt, context: undefined }), 'why did it fail?');
});

test('getPromptWithMessageContext: a slash command the operator typed stays a bare control token', () => {
  assert.equal(getPromptWithMessageContext('/compact', { ...agentPrompt, context: replyContext }), '/compact');
});

test('getPromptWithMessageContext: a terminal shell line never carries the block', () => {
  // Typed into a shell, `> X did Y` would run `did Y` with its output
  // overwriting a file named `X` in the bound folder.
  assert.equal(getPromptWithMessageContext('ls -la', { context: replyContext, isShellInput: true }), 'ls -la');
  assert.equal(getPromptWithMessageContext('ls -la', { context: forwardContext, isShellInput: true }), 'ls -la');
});

test('getPromptWithMessageContext: a forwarded mark leads the forwarded words like a quote does', () => {
  assert.equal(
    getPromptWithMessageContext('disk 91% on web-1', { ...agentPrompt, context: forwardContext }),
    `${forwardedMark}\n\ndisk 91% on web-1`,
  );
});

test('getPromptWithMessageContext: FORWARDED words that start with a slash are content — the mark is folded ahead of them, they are no control token', () => {
  assert.equal(
    getPromptWithMessageContext('/clear the cache please', { ...agentPrompt, context: forwardContext }),
    `${forwardedMark}\n\n/clear the cache please`,
  );
});

test('checkIsSlashCommandPrompt: a typed slash is a command, the same words forwarded are not, and plain words never are', () => {
  assert.equal(checkIsSlashCommandPrompt('/compact', undefined), true);
  assert.equal(checkIsSlashCommandPrompt('/compact', replyContext), true);
  assert.equal(checkIsSlashCommandPrompt('/compact', forwardContext), false);
  assert.equal(checkIsSlashCommandPrompt('compact', undefined), false);
});

test('getPromptWithMessageContext: a topic member\'s message is led by the author mark', () => {
  assert.equal(getPromptWithMessageContext('please run the tests', { ...agentPrompt, context: talkerContext }), `${talkerMark}\n\nplease run the tests`);
});

test('getPromptWithMessageContext: a topic member\'s slash text is never a control token — it reaches the agent marked, as plain words (a backstop for a route that missed the refusal)', () => {
  assert.equal(checkIsSlashCommandPrompt('/compact', talkerContext), false);
  assert.equal(getPromptWithMessageContext('/compact', { ...agentPrompt, context: talkerContext }), `${talkerMark}\n\n/compact`);
  assert.equal(checkIsSlashCommandPrompt('/compact', replyContext), true, 'the operator\'s own reply with a slash text still is one');
});

test('getPromptWithMessageContext: even a topic member\'s message stays out of a terminal', () => {
  assert.equal(getPromptWithMessageContext('ls', { context: talkerContext, isShellInput: true }), 'ls');
});
