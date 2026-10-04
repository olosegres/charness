/**
 * @description Unit coverage for the discrete-message send service behind the
 * `send_messages_to_user` MCP tool: each item is delivered as its OWN message
 * (never merged), an over-long text input is split defensively, blank strings
 * are skipped, a target-resolution failure short-circuits, cancellation stops
 * between items AND when it is raised from inside an in-flight attachment send,
 * and — the attachment extension — an item with a `path` routes
 * through the injected file-send pipeline (caption/asFile/authorizedWorkDir
 * threaded), mixed batches preserve order, an all-empty object is rejected, and
 * a file `deliveryUnknown` terminates the batch without inviting a retry.
 */

/** Test case: N/A — TelegramCode has no Jira tracker. */

import { splitMessage } from '../connectors/telegram/messageSplit';
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  createSendMessagesToThread,
  type SendMessagesToThreadDeps,
} from '../utils/messageSendService';
import type {
  SendFilesToThread,
  SendFilesToThreadOptions,
  SendFilesToThreadResult,
} from '../utils/fileSendService';
import { getAbortError } from '../utils';

interface FileCall {
  threadKey: string;
  options: SendFilesToThreadOptions;
}

interface Recorder {
  /** Text chunks handed to `sendChunk`, in order. */
  sent: string[];
  /** Resolved targets each text chunk went to. */
  targets: string[];
  /** Every attachment call handed to `sendFiles`. */
  fileCalls: FileCall[];
  /** Unified interleaved event log proving text/file ordering (`text:…` / `file:…`). */
  events: string[];
}

function createService(
  overrides: Partial<SendMessagesToThreadDeps<string>> = {},
): { service: ReturnType<typeof createSendMessagesToThread<string>>; recorder: Recorder } {
  const recorder: Recorder = { sent: [], targets: [], fileCalls: [], events: [] };
  const defaultSendFiles: SendFilesToThread = async (threadKey, options) => {
    recorder.fileCalls.push({ threadKey, options });
    recorder.events.push(`file:${options.paths.join(',')}`);
    return { ok: true, summary: `Sent ${options.paths.length} file(s) to the topic.` };
  };
  const service = createSendMessagesToThread<string>({
    resolveTarget: (threadKey) => ({ ok: true, target: threadKey }),
    sendChunk: async (target, chunk) => {
      recorder.targets.push(target);
      recorder.sent.push(chunk);
      recorder.events.push(`text:${chunk}`);
      return recorder.sent.length;
    },
    sendFiles: defaultSendFiles,
    splitMessage,
    maxMessageLength: 10,
    measureRendered: (chunk) => chunk.length,
    ...overrides,
  });
  return { service, recorder };
}

test('sends each input string as its own message, in order', async () => {
  const { service, recorder } = createService();
  const result = await service('-100:1', { messages: ['first', 'second', 'third'] });
  assert.deepEqual(recorder.sent, ['first', 'second', 'third']);
  assert.deepEqual(recorder.targets, ['-100:1', '-100:1', '-100:1']);
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.summary, 'Delivered 3 messages to the topic.');
  assert.equal(result.ok && result.undeliveredCount, 0);
});

test('never merges two distinct short inputs into one message', async () => {
  const { service, recorder } = createService();
  await service('-100:1', { messages: ['a', 'b'] });
  // Both are far under the cap, yet stay separate — the anti-glue guarantee.
  assert.equal(recorder.sent.length, 2);
});

test('splits a single over-long input into multiple messages', async () => {
  const { service, recorder } = createService();
  // 25 chars, cap 10 → three chunks (10 / 10 / 5), all delivered separately.
  const long = 'x'.repeat(25);
  const result = await service('-100:1', { messages: [long] });
  assert.equal(recorder.sent.length, 3);
  assert.equal(recorder.sent.join(''), long);
  assert.equal(result.ok && result.summary, 'Delivered 3 messages to the topic.');
});

test('skips a blank (whitespace-only) input without posting an empty bubble', async () => {
  const { service, recorder } = createService();
  const result = await service('-100:1', { messages: ['real', '   ', 'also real'] });
  assert.deepEqual(recorder.sent, ['real', 'also real']);
  assert.equal(result.ok && result.summary, 'Delivered 2 messages to the topic.');
});

test('singular summary for a single delivered message', async () => {
  const { service } = createService();
  const result = await service('-100:1', { messages: ['solo'] });
  assert.equal(result.ok && result.summary, 'Delivered 1 message to the topic.');
  assert.deepEqual(result.ok && result.sentMessageIds, [1], 'the sent id comes back for the caller to pin or edit');
});

test('total send failure returns an error, not a false success', async () => {
  const { service } = createService({ sendChunk: async () => null });
  const result = await service('-100:1', { messages: ['a', 'b'] });
  assert.equal(result.ok, false);
  assert.match(!result.ok ? result.error : '', /Failed to deliver any message/);
});

test('partial send failure stays ok but reports the landed/attempted split', async () => {
  let calls = 0;
  const { service } = createService({
    // First message lands, second fails.
    sendChunk: async () => {
      calls += 1;
      return calls === 1 ? calls : null;
    },
  });
  const result = await service('-100:1', { messages: ['a', 'b'] });
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.summary, 'Delivered 1 of 2 messages to the topic (1 failed to send).');
  assert.equal(result.ok && result.undeliveredCount, 1);
  assert.deepEqual(result.ok && result.sentMessageIds, [1], 'only the message that landed is listed');
});

test('a target-resolution failure short-circuits before any send', async () => {
  const { service, recorder } = createService({
    resolveTarget: () => ({ ok: false, error: 'invalid threadKey "bad"' }),
  });
  const result = await service('bad', { messages: ['x', 'y'] });
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.error, 'invalid threadKey "bad"');
  assert.equal(recorder.sent.length, 0);
});

test('an already-aborted signal delivers nothing', async () => {
  const { service, recorder } = createService();
  const controller = new AbortController();
  controller.abort();
  const result = await service('-100:1', { messages: ['x', 'y'], signal: controller.signal });
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.error, 'cancelled after delivering 0 messages');
  assert.equal(recorder.sent.length, 0);
});

test('cancellation between messages stops further delivery', async () => {
  const controller = new AbortController();
  const recorder: Recorder = { sent: [], targets: [], fileCalls: [], events: [] };
  const service = createSendMessagesToThread<string>({
    resolveTarget: (threadKey) => ({ ok: true, target: threadKey }),
    sendChunk: async (_target, chunk) => {
      recorder.sent.push(chunk);
      // Abort right after the first message lands; the loop must stop before the second.
      controller.abort();
      return recorder.sent.length;
    },
    sendFiles: async (threadKey, options) => {
      recorder.fileCalls.push({ threadKey, options });
      return { ok: true, summary: 'sent' };
    },
    splitMessage,
    maxMessageLength: 10,
    measureRendered: (chunk) => chunk.length,
  });
  const result = await service('-100:1', {
    messages: ['first', 'second'],
    signal: controller.signal,
  });
  assert.deepEqual(recorder.sent, ['first']);
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.error, 'cancelled after delivering 1 message');
});

// ─── attachment items ────────────────────────────────────────────────

test('an attachment item routes to the file-send pipeline with caption/asFile/authorizedWorkDir', async () => {
  const { service, recorder } = createService();
  const result = await service('-100:7', {
    messages: [{ path: 'chart.png', text: 'my caption', asFile: true }],
    authorizedWorkDir: '/work/dir',
  });
  assert.equal(recorder.sent.length, 0);
  assert.equal(recorder.fileCalls.length, 1);
  assert.equal(recorder.fileCalls[0].threadKey, '-100:7');
  assert.deepEqual(recorder.fileCalls[0].options.paths, ['chart.png']);
  assert.equal(recorder.fileCalls[0].options.caption, 'my caption');
  assert.equal(recorder.fileCalls[0].options.asFile, true);
  assert.equal(recorder.fileCalls[0].options.authorizedWorkDir, '/work/dir');
  assert.equal(result.ok && result.summary, 'Delivered 1 message to the topic.');
});

test('an attachment item without text or workdir sends no caption and no authorizedWorkDir', async () => {
  const { service, recorder } = createService();
  const result = await service('-100:1', { messages: [{ path: 'a.png' }] });
  assert.equal(recorder.fileCalls.length, 1);
  assert.equal(recorder.fileCalls[0].options.caption, undefined);
  assert.equal(recorder.fileCalls[0].options.asFile, undefined);
  assert.equal(recorder.fileCalls[0].options.authorizedWorkDir, undefined);
  assert.equal(result.ok && result.summary, 'Delivered 1 message to the topic.');
});

test('an object item with only text is a plain text message', async () => {
  const { service, recorder } = createService();
  const result = await service('-100:1', { messages: [{ text: 'just text' }] });
  assert.deepEqual(recorder.sent, ['just text']);
  assert.equal(recorder.fileCalls.length, 0);
  assert.equal(result.ok && result.summary, 'Delivered 1 message to the topic.');
});

test('a mixed batch waits for an attachment before sending later text', async () => {
  let markFileStarted = (): void => {};
  let releaseFile = (_result: SendFilesToThreadResult): void => {};
  const fileStarted = new Promise<void>((resolve) => { markFileStarted = resolve; });
  const fileResult = new Promise<SendFilesToThreadResult>((resolve) => { releaseFile = resolve; });
  const { service, recorder } = createService({
    sendFiles: async (_threadKey, options) => {
      recorder.events.push(`file:${options.paths.join(',')}`);
      markFileStarted();
      return fileResult;
    },
  });
  const resultPromise = service('-100:1', {
    messages: ['intro', { path: 'a.png', text: 'cap' }, 'outro'],
  });

  await fileStarted;
  assert.deepEqual(recorder.events, ['text:intro', 'file:a.png']);
  releaseFile({ ok: true, summary: 'sent' });

  const result = await resultPromise;
  assert.deepEqual(recorder.events, ['text:intro', 'file:a.png', 'text:outro']);
  assert.equal(result.ok && result.summary, 'Delivered 3 messages to the topic.');
});

test('an all-empty object is rejected before anything is sent', async () => {
  const { service, recorder } = createService();
  const result = await service('-100:1', { messages: [{}] });
  assert.equal(result.ok, false);
  assert.match(!result.ok ? result.error : '', /non-empty text or path/);
  assert.equal(recorder.events.length, 0);
});

test('an object with only whitespace text and no path is rejected', async () => {
  const { service, recorder } = createService();
  const result = await service('-100:1', { messages: ['ok', { text: '   ' }] });
  assert.equal(result.ok, false);
  assert.match(!result.ok ? result.error : '', /non-empty text or path/);
  // Validation happens up front, so the preceding valid item is NOT sent either.
  assert.equal(recorder.events.length, 0);
});

test('a failed attachment stays a partial success and names the attachment error', async () => {
  const failingSendFiles: SendFilesToThread = async () => ({
    ok: false,
    error: 'cannot read a.png: ENOENT',
  });
  const { service } = createService({ sendFiles: failingSendFiles });
  const result = await service('-100:1', { messages: ['ok text', { path: 'a.png' }] });
  assert.equal(result.ok, true);
  assert.match(result.ok ? result.summary : '', /Delivered 1 of 2 messages/);
  assert.match(result.ok ? result.summary : '', /Attachment errors: cannot read a\.png: ENOENT/);
  assert.equal(result.ok && result.undeliveredCount, 1, 'the failed attachment counts as undelivered');
});

test('an attachment-only batch that fails returns an error naming the attachment cause', async () => {
  const failingSendFiles: SendFilesToThread = async () => ({ ok: false, error: 'bad path' });
  const { service } = createService({ sendFiles: failingSendFiles });
  const result = await service('-100:1', { messages: [{ path: 'a.png' }] });
  assert.equal(result.ok, false);
  assert.match(!result.ok ? result.error : '', /Failed to deliver any message/);
  assert.match(!result.ok ? result.error : '', /Attachment errors: bad path/);
});

test('a file deliveryUnknown terminates the batch without sending later items', async () => {
  const unknownResult: SendFilesToThreadResult = {
    ok: false,
    kind: 'deliveryUnknown',
    error: 'Telegram delivery outcome is unknown: socket hang up',
  };
  const { service, recorder } = createService({ sendFiles: async () => unknownResult });
  const result = await service('-100:1', {
    messages: ['a', { path: 'x.png' }, 'b'],
  });
  // 'a' was sent; the unknown attachment stops the batch before 'b'.
  assert.deepEqual(recorder.sent, ['a']);
  assert.equal(result.ok, false);
  assert.equal('kind' in result && result.kind, 'deliveryUnknown');
  assert.match(!result.ok ? result.error : '', /outcome became unknown/);
});

test('an abort DURING an attachment send comes back as the structured cancellation', async () => {
  // `sendFiles` REJECTS on abort (it rethrows `getAbortError`) instead of
  // returning, and nothing caught it — so a batch cancelled mid-upload let the
  // raw abort escape the whole service. The agent then never learned that
  // `intro` had already landed and would re-send the whole batch, posting it
  // twice. It must read as the same graceful cancellation the between-items
  // check produces, naming the count already delivered.
  const controller = new AbortController();
  const { service, recorder } = createService({
    sendFiles: async (_threadKey, options) => {
      // Mirror the real pipeline: abort arrives while the upload is in flight.
      controller.abort();
      throw getAbortError(options.signal ?? controller.signal);
    },
  });

  const result = await service('-100:1', {
    messages: ['intro', { path: 'chart.png' }, 'outro'],
    signal: controller.signal,
  });

  assert.deepEqual(recorder.sent, ['intro'], 'only the pre-abort text landed');
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.error, 'cancelled after delivering 1 message');
});

test('an abort carrying a custom reason is still a graceful cancellation', async () => {
  // The MCP cancellation notification aborts with a STRING reason, so
  // `getAbortError` synthesises a fresh `AbortError` rather than returning the
  // reason — detection must key on the error identity, not on its message text.
  const controller = new AbortController();
  const { service } = createService({
    sendFiles: async (_threadKey, options) => {
      controller.abort('client cancelled the request');
      throw getAbortError(options.signal ?? controller.signal);
    },
  });

  const result = await service('-100:1', {
    messages: ['intro', { path: 'chart.png' }],
    signal: controller.signal,
  });

  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.error, 'cancelled after delivering 1 message');
});

test('a NON-abort throw from an attachment send still propagates', async () => {
  // The catch must not turn a genuine crash into a silent "cancelled".
  const { service } = createService({
    sendFiles: async () => {
      throw new Error('disk exploded');
    },
  });

  await assert.rejects(
    () => service('-100:1', { messages: ['intro', { path: 'chart.png' }] }),
    /disk exploded/,
  );
});

test('an aborted batch still reports deliveryUnknown when the file send returns it', async () => {
  // Ordering invariant of the real pipeline: `sendFiles` maps an ambiguous
  // delivery to a RETURNED `deliveryUnknown` result BEFORE it considers the
  // abort, and the new catch must not shadow that — a delivery whose outcome is
  // unknown MUST NOT be retried, so it can never be downgraded to "cancelled".
  const controller = new AbortController();
  const { service } = createService({
    sendFiles: async () => {
      controller.abort();
      return {
        ok: false,
        kind: 'deliveryUnknown',
        error: 'Telegram delivery outcome is unknown: socket hang up',
      } satisfies SendFilesToThreadResult;
    },
  });

  const result = await service('-100:1', {
    messages: ['intro', { path: 'chart.png' }],
    signal: controller.signal,
  });

  assert.equal(result.ok, false);
  assert.equal('kind' in result && result.kind, 'deliveryUnknown');
  assert.match(!result.ok ? result.error : '', /outcome became unknown/);
});

test('cancellation stops a following attachment send', async () => {
  const controller = new AbortController();
  const { service, recorder } = createService({
    sendChunk: async () => {
      controller.abort();
      return 1;
    },
  });
  const result = await service('-100:1', {
    messages: ['first', { path: 'a.png' }],
    signal: controller.signal,
  });
  assert.equal(recorder.fileCalls.length, 0);
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.error, 'cancelled after delivering 1 message');
});
