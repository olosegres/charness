/**
 * @description Wiring guard — the voice path reads its engines from `stt.json`
 * on every voice note and gives each engine a timeout scaled by the voice's own
 * length. The handlers live in the side-effecting `bot.ts`, so this locks the
 * seams between the behaviourally tested pieces (`sttSettings.test.ts`,
 * `transcribeChain.test.ts`): the voice duration reaches the chain, the gate asks
 * the resolved chain (not an env key), and the old env keys are read ONLY by the
 * one-time migration.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const srcDir = path.join(__dirname, '..');
const botSource = fs.readFileSync(path.join(srcDir, 'bot.ts'), 'utf8');

/** A top-level function's body — up to the next top-level declaration. */
function getFunctionBody(name: string): string {
  const startIdx = botSource.search(new RegExp(`\\n(?:async )?function ${name}\\(`));
  assert.notEqual(startIdx, -1, `${name} must exist in bot.ts`);
  const after = botSource.slice(startIdx + 1);
  const nextDeclMatch = after.search(/\n(?:async function|function) /);
  return after.slice(0, nextDeclMatch === -1 ? undefined : nextDeclMatch);
}

test('the voice handler hands Telegram\'s voice duration to the job, and the job to the chain', () => {
  const handlerStart = botSource.indexOf("bot.on(message('voice')");
  const handler = botSource.slice(handlerStart, botSource.indexOf('async function processVoiceJob(', handlerStart));
  assert.match(handler, /const\s+durationSeconds\s*=\s*ctx\.message\.voice\.duration/);
  assert.match(handler, /processVoiceJob\(\s*key\s*,\s*fileId\s*,\s*durationSeconds\s*,/);
  assert.match(getFunctionBody('processVoiceJob'), /transcribeVoiceFile\(\s*key\s*,\s*tempFile\s*,\s*durationSeconds\s*\)/);
});

test('the transcription walks the resolved chain with the voice length and the configured language', () => {
  const body = getFunctionBody('transcribeVoiceFile');
  assert.match(body, /getResolvedSttSettings\(\)/);
  assert.match(body, /transcribeWithEngines\(\s*filePath\s*,\s*engines\s*,/);
  assert.match(body, /durationSeconds,/);
  assert.match(body, /language:\s*settings\.language/);
  assert.match(body, /\[transcribe\] \$\{from\} failed \(\$\{error\}\); falling back to \$\{to\}/);
  assert.match(body, /\[transcribe\] ok via \$\{result\.engine\} in \$\{Date\.now\(\) - startedAtMs\}ms \(\$\{durationSeconds\}s audio\)/);
  assert.match(body, /replyToThread\(key, t\('voice\.retrying'/, 'the retry notice stays, now fed only by the last engine');
});

test('the voice gate asks the resolved chain, and a broken stt.json gets its own notice', () => {
  const handlerStart = botSource.indexOf("bot.on(message('voice')");
  const handler = botSource.slice(handlerStart, botSource.indexOf('async function processVoiceJob(', handlerStart));
  assert.match(handler, /sttSettings\.engines\.length === 0/);
  assert.match(handler, /t\(sttSettings\.errors\.length > 0 \? 'voice\.config_invalid' : 'voice\.no_api_key'\)/);
});

test('readiness and boot use the same chain: the check asks for an engine, boot migrates the old env keys first', () => {
  assert.match(botSource, /hasSpeechEngine:\s*getResolvedSttSettings\(\)\.engines\.length > 0/);
  assert.match(botSource, /\n {2}sttRuntime\.init\(\);\n/);
});

test('boot starts NO sidecar: it cleans up, re-attaches to or starts the INSTALL, and the first voice that needs the engine starts it', () => {
  const boot = getFunctionBody('bootSttLocalEngine');
  assert.match(boot, /sttOwner\.cleanupAtBoot\(\)/);
  assert.match(boot, /isGigaamInstalling\(resolveDataDir\(\)\)/);
  assert.match(boot, /needsAutoInstall/);
  assert.doesNotMatch(boot, /\.ensure\(/, 'only a voice reaching the local engine may start the process');
  assert.match(botSource, /void bootSttLocalEngine\(\)/);
  // After the startup status, i.e. once Telegram is up and General can take the progress message.
  assert.ok(botSource.indexOf('void bootSttLocalEngine()') > botSource.indexOf('await sendStartupStatus(bootMode.isHotReload)'));
});

test('the auto-install reports into General (or the remembered message), else into the log, and edits are never retried by a loop', () => {
  const body = getFunctionBody('startSttAutoInstall');
  assert.match(body, /makeTelegramKey\(groupId, GENERAL_THREAD_ID\)/);
  assert.match(body, /createSttInstallMessageReporter\(createSttInstallMessagePorts\(\), targetKey\)/);
  assert.match(body, /createSttInstallLogReporter/);
  assert.match(body, /sttInstallJobs\.start\(\{ reportTo \}\)/);
  assert.doesNotMatch(body, /for \(|while \(/, 'no retry loop');
});

test('the plain bot stops the sidecar in its graceful shutdown; a hot worker leaves it to its supervisor', () => {
  assert.match(botSource, /stopSidecars: checkIsOpenCodeExternalHost\(\) \? undefined : \(\) => sttOwner\.stop\(\),/);
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
