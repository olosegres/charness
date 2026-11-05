/**
 * @description The few seams of the voice feature that live in the side-effecting `bot.ts` and that no process-level
 * flow can reach: the readiness fact, the graceful shutdown of the plain bot's sidecar, the teardown of an armed `/stt`
 * step, and the rule that only the one-time migration reads the old env keys. Everything that has a behaviour to
 * observe — the `/stt` screens and typed steps, the trace redaction, the voice path through the engine chain with its
 * fallbacks and notices, the migration at boot, the local-engine boot step with the end of an interrupted install — is
 * tested end to end in `telegramCommandsE2e.test.ts` and `sttBootE2e.test.ts`, not by reading `bot.ts`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const srcDir = path.join(__dirname, '..');
const botSource = fs.readFileSync(path.join(srcDir, 'bot.ts'), 'utf8');

test('readiness and boot use the same chain: the check asks for an engine, boot migrates the old env keys first', () => {
  assert.match(botSource, /hasSpeechEngine:\s*getResolvedSttSettings\(\)\.engines\.length > 0/);
  assert.match(botSource, /\n {2}sttRuntime\.init\(\);\n/);
});

test('a voice note warms the local engine up as it ARRIVES — after the no-engine gate, before the job is queued — and the job reuses that one ask', () => {
  const handler = botSource.slice(botSource.indexOf("bot.on(message('voice')"), botSource.indexOf('async function processVoiceJob'));
  const warmUp = handler.indexOf('const warmedEndpoint = warmUpFirstEngine(sttSettings.engines,');
  assert.ok(warmUp > handler.indexOf('getNoEngineNoticeCode(sttSettings)'), 'after the gate that refuses a voice with no engine');
  assert.ok(warmUp < handler.indexOf('getVoiceTranscriptionQueue(key)'), 'before the voice job is queued');
  assert.match(handler, /processVoiceJob\(key, fileId, durationSeconds, getTopicRequesterId\(ctx\.from\), warmedEndpoint, /, 'the job gets the warm-up\'s ask');
  assert.match(botSource, /transcribeVoiceFile\(key, tempFile, durationSeconds, warmedEndpoint\)/, 'and hands it to the chain');
  assert.match(botSource, /language: settings\.language,\n\s+warmedEndpoint,/, 'which uses it instead of asking the engine again');
});

test('the «transcribing…» note is armed LAST, right before the job is queued, and the queue chain finishes it whatever happened to the job', () => {
  const handler = botSource.slice(botSource.indexOf("bot.on(message('voice')"), botSource.indexOf('async function processVoiceJob'));
  const armed = handler.indexOf('const progressNote = startVoiceProgressNote(key);');
  assert.ok(armed > handler.indexOf('const replyBlock = getReplyQuoteBlock(key, ctx.message);'), 'after the last statement that can still throw, or an armed note would be stranded');
  assert.ok(armed > handler.indexOf('getNoEngineNoticeCode(sttSettings)'), 'a voice refused for having no engine gets no note');
  assert.ok(armed < handler.indexOf('getVoiceTranscriptionQueue(key)'), 'before the job is queued: the clock runs from the voice\'s arrival');
  assert.match(handler, /\.catch\(\(err\) => \{[^}]*\}\)\n\s+\.finally\(\(\) => progressNote\.finish\(\)\);/, 'a job that never ran or rejected still ends the wait');
});

test('the voice job ends the wait BEFORE it answers — AWAITED, so the note is gone before the echo goes out: on a failed download, as soon as the transcription returns, and on an unexpected error', () => {
  const job = botSource.slice(botSource.indexOf('async function processVoiceJob'), botSource.indexOf('File intake handler'));
  const finishes = [...job.matchAll(/await progressNote\.finish\(\);/g)].map((match) => match.index);
  assert.equal(finishes.length, 3, 'one end of the wait per way out of the job');
  const [afterDownloadFailure, afterTranscription, afterUnexpectedError] = finishes;
  assert.ok(afterDownloadFailure < job.indexOf("`${t('voice.failed')} (${msg})`"), 'the download failure notice replaces the note');
  assert.ok(afterTranscription > job.indexOf('await transcribeVoiceFile(key, tempFile'), 'after the chain returned, text or failure');
  assert.ok(afterTranscription < job.indexOf('if (!result.ok)'), 'before the failure notice');
  assert.ok(afterTranscription < job.indexOf("t('voice.transcribed'"), 'before the 🎤 echo, not at the end of a job that may take long to deliver the prompt');
  assert.ok(afterUnexpectedError < job.indexOf("'Error processing voice message'"), 'the generic error replaces the note');
});

test('the note is SILENT and unpaced, its delete is unpaced, and its id rides the transient-message set a restart cleans up', () => {
  const wiring = botSource.slice(botSource.indexOf('function startVoiceProgressNote'), botSource.indexOf('// ═', botSource.indexOf('function startVoiceProgressNote')));
  assert.match(wiring, /\{ disable_notification: true \},\n\s+\{ unpaced: true, signal \},/, 'silent, outside the pacer like the 🎤 echo, and cancellable while it has not started');
  assert.match(wiring, /rememberNote: \(messageId\) => addVoiceProgressNoteId\(key, messageId\),/, 'the id is registered by the note itself, and only while the note is still wanted');
  assert.match(wiring, /deleteThreadMessageDetailed\(key, messageId, \{ isUnpaced: true \}\)/, 'the delete must not queue behind agent output, or the note would outlive the echo');
  assert.match(wiring, /if \(deletion !== 'stayed'\) removeVoiceProgressNoteId\(key, messageId\);/, 'a note that stayed keeps its place in the set');
  assert.match(botSource, /subagentEditInFlight: false, voiceProgressNoteIds: \[\], undeletedMessageIds: \[\] \};/, 'a thread starts with no note and no leftover');
  for (const helper of ['addVoiceProgressNoteId', 'removeVoiceProgressNoteId']) {
    const body = botSource.slice(botSource.indexOf(`function ${helper}`));
    assert.ok(body.slice(0, body.indexOf('\n}\n')).includes('persistTransientFrames(key);'), `${helper} mirrors the set to state.json (the ungraceful-exit safety net)`);
  }
});

test('a shutdown stops the voice notes first thing, and the sweep waits for them before it collects ids', () => {
  const cleanup = botSource.slice(botSource.indexOf('cleanupTimers: () => {'));
  assert.ok(cleanup.slice(0, cleanup.indexOf('clearInterval(inMemoryGcInterval);')).includes('void voiceProgressNotes.shutDown();'), 'before any other timer step: no note may fire during the output flush');
  const sweep = botSource.slice(botSource.indexOf('async function sweepTransientFramesOnShutdown'));
  const sweepBody = sweep.slice(0, sweep.indexOf('\n}\n'));
  assert.ok(sweepBody.indexOf('await voiceProgressNotes.shutDown();') !== -1, 'the sweep waits for the notes');
  assert.ok(sweepBody.indexOf('await voiceProgressNotes.shutDown();') < sweepBody.indexOf('sweepTransientMessages('), 'and only then collects and deletes the ids');
  assert.match(botSource, /const voiceProgressNotes = createVoiceProgressNoteRegistry\(\);/, 'one registry for the process');
});

test('the shutdown sweep and the boot reconciliation share the retention rule: a retryable failure keeps the id, nothing is forgotten', () => {
  const sweep = botSource.slice(botSource.indexOf('async function sweepTransientFramesOnShutdown'));
  const sweepBody = sweep.slice(0, sweep.indexOf('\n}\n'));
  assert.match(sweepBody, /checkIsRetryable: checkIsRetryableTelegramError,/);
  assert.match(sweepBody, /saveKeptIds: setUndeletedMessageIds,/, 'the kept ids go through the one save of the set (memory first, then disk), not straight to the store');
  assert.ok(!sweepBody.includes('state.setTransientFrames('), 'the sweep never writes the persisted set behind the in-memory state: a later save of the thread would drop what it kept');
  assert.match(botSource, /checkIsRetryable: checkIsRetryableTelegramError,\n\};/, 'the reconciliation\'s default deps use the same classifier');
  assert.match(botSource, /void reconcileTransientFrames\(orphanedTransientFrames\)\.catch\(/, 'the boot does not wait for the deletes');
});

test('the plain bot stops the sidecar in its graceful shutdown; a hot worker leaves it to its supervisor', () => {
  assert.match(botSource, /stopSidecars: checkIsOpenCodeExternalHost\(\) \? undefined : \(\) => sttOwner\.stop\(\),/);
});

test('a topic teardown drops an armed /stt step and its timer', () => {
  assert.match(botSource, /void cancelSttInput\(key, \{ isSilent: true \}\); \/\/ teardown/);
});

test('no module reads the old voice env keys from the environment any more (the migration takes them as an argument)', () => {
  const offenders: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__') visit(entryPath);
      } else if (entry.name.endsWith('.ts') && /process\.env\.(GROQ|OPENAI)_API_KEY|groqApiKey|openaiApiKey/.test(fs.readFileSync(entryPath, 'utf8'))) {
        offenders.push(path.relative(srcDir, entryPath));
      }
    }
  };
  visit(srcDir);
  assert.deepEqual(offenders, []);
});
