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
