/**
 * @description The install progress message: one message per install, edited in place, remembered in
 * state.json (with the "enable on done" flag) so a reloaded bot continues the SAME message; a deleted message
 * is replaced; the END of the job is not this reporter's business (the finisher edits and forgets the
 * message); with no group the progress goes to the log, one line per phase.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { keyToString, type SessionKey } from '../sessionKey';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import type { SttInstallProgressMessage } from '../state';
import type { SttInstallProgress } from '../stt/sttInstall';
import { createSttInstallLogReporter, createSttInstallMessageReporter, type SttInstallMessagePorts } from '../stt/sttInstallReporter';
import { buildSttInstallProgressText, formatSttElapsed, formatSttInstallLogLine, type SttTranslate } from '../stt/sttScreenPlan';

const generalKey: SessionKey = makeTelegramKey(-1001111111111, 1);
const otherKey: SessionKey = makeTelegramKey(-1001111111111, 77);

const echo: SttTranslate = (code, vars) =>
  vars ? `${code}(${Object.entries(vars).map(([name, value]) => `${name}=${value}`).join(',')})` : code;

const progress = (phase: SttInstallProgress['phase'], extra: Partial<SttInstallProgress> = {}): SttInstallProgress => ({
  phase,
  detail: '',
  bytesDownloaded: 0,
  ...extra,
});

function createPorts(initialMessage: SttInstallProgressMessage | null = null, options: { editFails?: boolean } = {}) {
  let remembered = initialMessage;
  let nextId = 500;
  let clockMs = 0;
  const calls: string[] = [];
  const ports: SttInstallMessagePorts = {
    getState: () => ({
      getSttInstallProgressMessage: () => remembered,
      setSttInstallProgressMessage: async (message) => { remembered = message; calls.push(`remember:${message ? message.messageId : 'none'}`); },
    }),
    replyToThread: async (_key, text) => { calls.push(`send:${text}`); return nextId++; },
    editThreadMessage: async (_key, messageId, text) => {
      calls.push(`edit:${messageId}:${text}`);
      return !options.editFails;
    },
    translateFor: () => echo,
    nowMs: () => clockMs,
  };
  return { ports, calls, getRemembered: () => remembered, advance: (ms: number) => { clockMs += ms; } };
}

test('text: a running install shows the elapsed time over the phase line; the end shows only the outcome', () => {
  assert.equal(buildSttInstallProgressText(progress('creatingEnvironment'), 5, echo), 'stt.install.header(elapsed=0:05)\nstt.install.creatingEnvironment');
  assert.equal(buildSttInstallProgressText(progress('installingPackages'), 65, echo), 'stt.install.header(elapsed=1:05)\nstt.install.installingPackages');
  assert.equal(
    buildSttInstallProgressText(progress('downloadingModel', { detail: '120/216 MB' }), 600, echo),
    'stt.install.header(elapsed=10:00)\nstt.install.downloadingModel(progress=120/216 MB)',
  );
  assert.equal(buildSttInstallProgressText(progress('checking'), 0, echo), 'stt.install.header(elapsed=0:00)\nstt.install.checking');
  assert.equal(buildSttInstallProgressText(progress('done'), 99, echo), 'stt.install.done');
});

test('text: a failure shows the error and the last five lines of the log, each cut to one line\'s worth', () => {
  const logTail = ['one', 'two', 'three', 'four', 'five', 'six', 'x'.repeat(500)];
  const text = buildSttInstallProgressText(progress('failed', { error: 'the model check failed', logTail }), 9, echo);
  const lines = text.split('\n');
  assert.equal(lines[0], 'stt.install.failed(error=the model check failed)');
  assert.equal(lines.length, 6);
  assert.deepEqual(lines.slice(1, 5), ['  three', '  four', '  five', '  six']);
  assert.equal(lines[5].length, 2 + 160);
});

test('elapsed time and log lines', () => {
  assert.equal(formatSttElapsed(0), '0:00');
  assert.equal(formatSttElapsed(59.9), '0:59');
  assert.equal(formatSttElapsed(3600), '60:00');
  assert.equal(formatSttElapsed(-3), '0:00');
  assert.equal(formatSttInstallLogLine(progress('installingPackages')), '[STT] install: installingPackages');
  assert.equal(formatSttInstallLogLine(progress('downloadingModel', { detail: '5/216 MB' })), '[STT] install: downloadingModel 5/216 MB');
  assert.equal(formatSttInstallLogLine(progress('failed', { error: 'no uv' })), '[STT] install: failed — no uv');
});

test('the message reporter posts once, then edits that message and remembers its id', async () => {
  const { ports, calls, getRemembered, advance } = createPorts();
  const { report } = createSttInstallMessageReporter(ports, generalKey);

  await report(progress('creatingEnvironment'));
  advance(3000);
  await report(progress('installingPackages'));
  advance(3000);
  await report(progress('downloadingModel', { detail: '10/216 MB' }));

  assert.deepEqual(calls, [
    'send:stt.install.header(elapsed=0:00)\nstt.install.creatingEnvironment',
    'remember:500',
    'edit:500:stt.install.header(elapsed=0:03)\nstt.install.installingPackages',
    'edit:500:stt.install.header(elapsed=0:06)\nstt.install.downloadingModel(progress=10/216 MB)',
  ]);
  assert.deepEqual(getRemembered(), { threadKey: keyToString(generalKey), messageId: 500 });
});

test('the end of the job leaves the message and its memory to the finisher', async () => {
  const { ports, calls, getRemembered } = createPorts();
  const { report, getMessageId } = createSttInstallMessageReporter(ports, generalKey);
  await report(progress('checking'));
  const callsBeforeEnd = calls.length;
  await report(progress('done'));
  await report(progress('failed', { error: 'boom' }));
  assert.equal(calls.length, callsBeforeEnd, 'neither a done nor a failed report touches the message or the state');
  assert.deepEqual(getRemembered(), { threadKey: keyToString(generalKey), messageId: 500 }, 'the message stays remembered until the finisher forgets it');
  assert.equal(getMessageId(), 500);
});

test('the reporter hands out the id of the message it edits, including a replacement for a deleted one', async () => {
  const { ports } = createPorts({ threadKey: keyToString(generalKey), messageId: 321 }, { editFails: true });
  const { report, getMessageId } = createSttInstallMessageReporter(ports, generalKey);
  assert.equal(getMessageId(), 321, 'before the first report: the remembered message');
  await report(progress('installingPackages'));
  assert.equal(getMessageId(), 500, 'the edit failed, a new message took over');
});

test('the "enable on done" flag is remembered with the message — also with a replaced one — so a reload still finishes the job', async () => {
  const { ports, getRemembered } = createPorts();
  const existing = { threadKey: keyToString(otherKey), messageId: 777, shouldEnableOnDone: true };
  const first = createSttInstallMessageReporter(ports, otherKey, existing);
  await first.report(progress('creatingEnvironment'));
  assert.deepEqual(getRemembered(), existing);

  // A reloaded bot: the flag comes back from the remembered message, and survives a replacement of the message.
  const reloaded = createPorts({ threadKey: keyToString(otherKey), messageId: 777, shouldEnableOnDone: true }, { editFails: true });
  await createSttInstallMessageReporter(reloaded.ports, otherKey).report(progress('downloadingModel', { detail: '1/216 MB' }));
  assert.deepEqual(reloaded.getRemembered(), { threadKey: keyToString(otherKey), messageId: 500, shouldEnableOnDone: true });
});

test('an install nobody asked for in /stt is remembered without the flag', async () => {
  const { ports, getRemembered } = createPorts();
  await createSttInstallMessageReporter(ports, generalKey).report(progress('creatingEnvironment'));
  assert.equal(getRemembered()?.shouldEnableOnDone, undefined);
});

test('a reloaded bot continues the remembered message of that topic, not a new one', async () => {
  const { ports, calls } = createPorts({ threadKey: keyToString(generalKey), messageId: 321 });
  await createSttInstallMessageReporter(ports, generalKey).report(progress('downloadingModel', { detail: '1/216 MB' }));
  assert.ok(calls[0].startsWith('edit:321:'), calls[0]);
  assert.ok(!calls.some((call) => call.startsWith('send:')));
});

test('a remembered message of ANOTHER topic is not edited', async () => {
  const { ports, calls } = createPorts({ threadKey: keyToString(otherKey), messageId: 321 });
  await createSttInstallMessageReporter(ports, generalKey).report(progress('checking'));
  assert.ok(calls[0].startsWith('send:'), calls[0]);
});

test('a message the caller already posted (the /stt confirm screen) is the one edited, and gets remembered', async () => {
  const { ports, calls, getRemembered } = createPorts();
  const existing = { threadKey: keyToString(otherKey), messageId: 777 };
  await createSttInstallMessageReporter(ports, otherKey, existing).report(progress('creatingEnvironment'));
  assert.ok(calls[0].startsWith('edit:777:'));
  assert.deepEqual(getRemembered(), existing);
});

test('an edit that fails (the message was deleted) posts a fresh message and remembers THAT', async () => {
  const { ports, calls, getRemembered } = createPorts({ threadKey: keyToString(generalKey), messageId: 321 }, { editFails: true });
  await createSttInstallMessageReporter(ports, generalKey).report(progress('installingPackages'));
  assert.ok(calls[0].startsWith('edit:321:'));
  assert.ok(calls[1].startsWith('send:'));
  assert.deepEqual(getRemembered(), { threadKey: keyToString(generalKey), messageId: 500 });
});

test('the log reporter writes one line per phase change', () => {
  const lines: string[] = [];
  const report = createSttInstallLogReporter((line) => lines.push(line));
  report(progress('creatingEnvironment'));
  report(progress('downloadingModel', { detail: '1/216 MB' }));
  report(progress('downloadingModel', { detail: '2/216 MB' }));
  report(progress('failed', { error: 'boom' }));
  assert.deepEqual(lines, ['[STT] install: creatingEnvironment', '[STT] install: downloadingModel 1/216 MB', '[STT] install: failed — boom']);
});
