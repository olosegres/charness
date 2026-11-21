/**
 * The pure parts of the walkthrough tool (`src/walkthrough/`, DEVELOPMENT.md § Walkthrough videos and screenshots): which frames a recording
 * becomes, how long each stays, which state of the chat a screenshot is taken from, and how a card of the agent column reads. Drawing
 * them (a browser, `ffmpeg`) is run by the tool itself.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildWalkthroughFrames, frameBurstWindowMs, idleCaptionAfterMs, lastFrameHoldSeconds, planFrameTimings, tapHighlightMs } from '../walkthrough/buildWalkthroughFrames';
import { describeAgentCard, extractHighlightedBlock } from '../walkthrough/describeAgentCard';
import { selectShotView } from '../walkthrough/selectShotView';
import { getBotMessageDisplayText, listTopicColumns } from '../walkthrough/walkthroughPages';
import { walkthroughRecordingSchema, type RecordedMessage, type WalkthroughEvent, type WalkthroughRecording, type WalkthroughShot } from '../walkthrough/walkthroughTypes';

const noteMarker = '[Accounts';

function message(id: number, thread: number, text: string, patch: Partial<RecordedMessage> = {}): RecordedMessage {
  return { id, thread, isBot: true, text, keyboard: [], ...patch };
}

const recordingOf = (events: WalkthroughEvent[]): WalkthroughRecording => ({ startedAtMs: 0, events });

describe('which frames a recording becomes', () => {
  it('a frame starts with the first step, shows every step as pending until it runs, and marks the one that runs and the ones that passed', () => {
    const frames = buildWalkthroughFrames(recordingOf([
      { kind: 'chat', atMs: 0, messages: [message(1, 111, 'before any step')] },
      { kind: 'step', atMs: 1000, index: 1, name: 'first', phase: 'start' },
      { kind: 'step', atMs: 2000, index: 1, name: 'first', phase: 'pass' },
      { kind: 'step', atMs: 3000, index: 2, name: 'second', phase: 'start' },
    ]));
    assert.deepEqual(frames.map((frame) => frame.steps.map((step) => step.status)), [['run', 'pending'], ['pass', 'pending'], ['pass', 'run']]);
    assert.equal(frames[0].messages[0].text, 'before any step', 'what the chat held before the first step is on the first frame');
  });

  it('changes within one burst window of the burst\'s first change are ONE frame holding the last state; the next one after it is another', () => {
    const burstStartMs = 1000;
    const frames = buildWalkthroughFrames(recordingOf([
      { kind: 'step', atMs: 0, index: 1, name: 'only', phase: 'start' },
      { kind: 'chat', atMs: burstStartMs, messages: [message(1, 111, 'a')] },
      { kind: 'chat', atMs: burstStartMs + frameBurstWindowMs - 1, messages: [message(1, 111, 'a'), message(2, 111, 'b')] },
      { kind: 'chat', atMs: burstStartMs + frameBurstWindowMs, messages: [message(1, 111, 'a'), message(2, 111, 'b'), message(3, 111, 'c')] },
    ]));
    assert.deepEqual(frames.map((frame) => frame.messages.length), [0, 2, 3]);
    assert.equal(frames[1].atMs, burstStartMs, 'the burst keeps the time of its first change');
  });

  it('a tapped button is marked for a moment and then released by the next change', () => {
    const frames = buildWalkthroughFrames(recordingOf([
      { kind: 'step', atMs: 0, index: 1, name: 'only', phase: 'start' },
      { kind: 'tap', atMs: 1000, messageId: 7, data: 'lrm_g' },
      { kind: 'chat', atMs: 1000 + tapHighlightMs + 1, messages: [message(7, 111, 'confirmed')] },
    ]));
    assert.deepEqual(frames.map((frame) => frame.tapped), [null, { messageId: 7, data: 'lrm_g' }, null]);
  });

  it('the agent column gets every prompt, hook and tool result, and an answer only when a marker is set and its result holds the highlighted block', () => {
    const recording = recordingOf([
      { kind: 'step', atMs: 0, index: 1, name: 'only', phase: 'start' },
      { kind: 'prompt', atMs: 1000, issueKey: 'NOTE-1', text: 'hello' },
      { kind: 'answer', atMs: 2000, issueKey: 'NOTE-1', answerKind: 'final', outcome: 'closed' },
      { kind: 'answer', atMs: 3000, issueKey: 'NOTE-1', answerKind: 'final', outcome: `closed\n\n${noteMarker} · 12:00]` },
      { kind: 'hook', atMs: 4000, issueKey: 'NOTE-1', text: 'from the hook' },
      { kind: 'tool', atMs: 5000, issueKey: 'NOTE-1', tool: 'send_messages_to_user', outcome: 'Delivered' },
    ]);
    assert.deepEqual(buildWalkthroughFrames(recording).at(-1)?.agentCards.map((card) => card.kind), ['prompt', 'hook', 'tool'], 'without a marker no answer is shown');
    assert.deepEqual(buildWalkthroughFrames(recording, { highlightMarker: noteMarker }).at(-1)?.agentCards.map((card) => card.kind), ['prompt', 'answer', 'hook', 'tool'], 'the noted answer only');
  });
});

describe('how long a frame stays', () => {
  const frameAt = (atMs: number) => ({ atMs, messages: [], agentCards: [], steps: [], tapped: null });

  it('as long as the real time to the next one, never under 0.7 s nor over 3.2 s; a wait past the idle limit is named; the last one holds', () => {
    const timings = planFrameTimings([frameAt(0), frameAt(100), frameAt(1600), frameAt(1600 + idleCaptionAfterMs + 6000)]);
    assert.deepEqual(timings.map((timing) => timing.seconds), [0.7, 1.5, 3.2, lastFrameHoldSeconds]);
    assert.deepEqual(timings.map((timing) => timing.waitSeconds), [null, null, 10, null]);
  });
});

describe('which state of the chat a screenshot is taken from', () => {
  const shot = (patch: Partial<WalkthroughShot> = {}): WalkthroughShot => ({ name: 'picker', thread: 111, match: '^Pick one', topicName: 'Topic', caption: 'caption', ...patch });
  const picker = message(5, 111, 'Pick one\n\nExplanation', { keyboard: [[{ text: '1 h ✓', data: 'lrm_60' }]] });
  const recording = recordingOf([
    { kind: 'chat', atMs: 0, messages: [message(1, 111, 'op', { isBot: false }), message(2, 111, 'older bot'), message(3, 111, 'older bot too'), picker] },
    { kind: 'chat', atMs: 10, messages: [message(1, 111, 'op', { isBot: false }), message(2, 111, 'older bot'), message(3, 111, 'older bot too'), { ...picker, text: 'Done: every 1 h.', keyboard: [] }] },
  ]);

  it('the FIRST state in which the message matches, cut at it, with two messages before it by default — the picker, not the confirmation it later became', () => {
    assert.deepEqual(selectShotView(recording, shot())?.map((candidate) => candidate.id), [2, 3, 5]);
    assert.equal(selectShotView(recording, shot())?.at(-1)?.text.startsWith('Pick one'), true);
  });

  it('its own number of messages before, a match on the keyboard, a message of the operator\'s, and none when nothing matches', () => {
    assert.deepEqual(selectShotView(recording, shot({ before: 0 }))?.map((candidate) => candidate.id), [5]);
    assert.equal(selectShotView(recording, shot({ keyboardMatch: 'lrm_240' })), null);
    assert.equal(selectShotView(recording, shot({ keyboardMatch: 'lrm_60' }))?.length, 3);
    assert.deepEqual(selectShotView(recording, shot({ match: '^op$', isOperatorMessage: true, before: 0 }))?.map((candidate) => candidate.id), [1]);
    assert.equal(selectShotView(recording, shot({ thread: 112 })), null);
  });
});

describe('how a card of the agent column reads', () => {
  it('a prompt: its label from the request\'s key prefix, the last words before the highlighted block without the fake agent\'s tokens, and the block', () => {
    const card = describeAgentCard(
      { kind: 'prompt', atMs: 0, issueKey: 'NOTE-3', text: `[context]\n\nNOTE-3 [fake:answer] [work-ms:1500] first turn\n\n${noteMarker} · 14:05] work → next\nCall it.\n\ntail` },
      { agentLabels: { NOTE: 'orchestrating' }, highlightMarker: noteMarker },
    );
    assert.deepEqual(card, { label: 'orchestrating', kindText: 'prompt the agent read', words: 'NOTE-3 first turn', note: `${noteMarker} · 14:05] work → next\nCall it.` });
  });

  it('a tool\'s and an answer\'s result: the first line, and the block; a hook: its text as the block; no marker: no block', () => {
    assert.deepEqual(
      describeAgentCard({ kind: 'tool', atMs: 0, issueKey: 'CTRL-1', tool: 'send_messages_to_user', outcome: `Delivered 1 message\n\n${noteMarker} · 12:00 · changed] x` }, { highlightMarker: noteMarker }),
      { label: 'CTRL', kindText: 'send_messages_to_user result', words: 'Delivered 1 message', note: `${noteMarker} · 12:00 · changed] x` },
    );
    assert.equal(describeAgentCard({ kind: 'answer', atMs: 0, issueKey: 'X-1', answerKind: 'final', outcome: 'done' }, {}).kindText, 'answer_request final result');
    assert.equal(describeAgentCard({ kind: 'hook', atMs: 0, issueKey: 'X-1', text: 'from the hook' }, {}).note, 'from the hook');
    assert.equal(extractHighlightedBlock(`a\n\n${noteMarker} b`, undefined), null);
    assert.equal(extractHighlightedBlock('nothing here', noteMarker), null);
  });
});

describe('the chat columns and the recording file', () => {
  it('one column per topic that has a message, General named, unless the config names its columns', () => {
    const messages = [message(1, 112, 'b'), message(2, 1, 'g'), message(3, 111, 'a')];
    assert.deepEqual(listTopicColumns(messages, {}), [{ thread: 1, name: 'General' }, { thread: 111, name: 'Topic 111' }, { thread: 112, name: 'Topic 112' }]);
    assert.deepEqual(listTopicColumns(messages, { topics: [{ thread: 112, name: 'Control' }] }), [{ thread: 112, name: 'Control' }]);
  });

  it('a bot message is shown as Telegram renders it — its markup tags gone, its entities the characters they stand for', () => {
    assert.equal(getBotMessageDisplayText('🔧 tool →\n<pre><code>a &lt; b &amp;&amp; c</code></pre>'), '🔧 tool →\na < b && c');
    assert.equal(getBotMessageDisplayText('<blockquote expandable>exit 1</blockquote>'), 'exit 1');
    assert.equal(getBotMessageDisplayText('plain <not a tag> text'), 'plain <not a tag> text');
  });

  it('a recording file with a wrong event is refused naming the field, a good one parses', () => {
    assert.equal(walkthroughRecordingSchema.safeParse(recordingOf([{ kind: 'tap', atMs: 1, messageId: 2, data: 'x' }])).success, true);
    assert.equal(walkthroughRecordingSchema.safeParse({ startedAtMs: 0, events: [{ kind: 'tap', atMs: 1, messageId: 'two', data: 'x' }] }).success, false);
  });
});
