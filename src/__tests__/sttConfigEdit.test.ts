/**
 * @description The edits `/stt` makes to stt.json: each returns the next settings or a named refusal, validated by
 * the same schema as a hand edit; ids are fresh and stable; the local engine goes first; URLs are normalised
 * and never carry a login.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  addSttEngine,
  dropLocalSttEngine,
  enableLocalSttEngine,
  moveSttEngine,
  normaliseSttUrl,
  removeSttEngine,
  setSttEngineApiKey,
  setSttEngineTimeout,
  setSttIdleMinutes,
  setSttLanguage,
  setSttWorkers,
  toggleSttEngineDisabled,
  type SttEditResult,
} from '../stt/sttConfigEdit';
import { createEmptySttConfig, defaultSttTimeout, sttEngineLimit, type SttConfigFile } from '../stt/sttSettings';

const sampleKey = 'gsk_sampleSecretKey1234567890';

function configOf(...engines: SttConfigFile['engines']): SttConfigFile {
  return { ...createEmptySttConfig(), engines };
}

function expectOk(result: SttEditResult): SttConfigFile {
  assert.ok(result.ok, result.ok ? '' : result.reason);
  return result.config;
}

const groq = { id: 'q1', kind: 'groq' as const, apiKey: sampleKey };
const openai = { id: 'o1', kind: 'openai' as const, apiKey: 'sk-sampleSecretKey12345' };
const local = { id: 'g', kind: 'gigaam' as const };

test('move: swaps with the neighbour, stays at the ends, refuses an unknown id', () => {
  const config = configOf(groq, openai, local);
  assert.deepEqual(expectOk(moveSttEngine(config, 'o1', -1)).engines.map((engine) => engine.id), ['o1', 'q1', 'g']);
  assert.deepEqual(expectOk(moveSttEngine(config, 'o1', 1)).engines.map((engine) => engine.id), ['q1', 'g', 'o1']);
  assert.deepEqual(expectOk(moveSttEngine(config, 'q1', -1)).engines.map((engine) => engine.id), ['q1', 'o1', 'g'], 'the first stays first');
  assert.deepEqual(expectOk(moveSttEngine(config, 'g', 1)).engines.map((engine) => engine.id), ['q1', 'o1', 'g'], 'the last stays last');
  assert.deepEqual(moveSttEngine(config, 'nope', 1), { ok: false, reason: 'unknownEngine' });
});

test('use / don\'t use toggles the disabled flag without losing the engine\'s other settings', () => {
  const config = configOf({ ...groq, timeout: { baseSeconds: 5, percentOfDuration: 50 } });
  const off = expectOk(toggleSttEngineDisabled(config, 'q1'));
  assert.deepEqual(off.engines[0], { ...config.engines[0], isDisabled: true });
  const on = expectOk(toggleSttEngineDisabled(off, 'q1'));
  assert.deepEqual(on.engines[0], config.engines[0]);
  assert.ok(!('isDisabled' in on.engines[0]), 'switching back on removes the flag, not sets it false');
});

test('timeout: one half changes, the other keeps its current value (the default when none was set)', () => {
  const config = configOf(groq);
  const withBase = expectOk(setSttEngineTimeout(config, 'q1', { baseSeconds: 20 }, defaultSttTimeout));
  assert.deepEqual(withBase.engines[0].timeout, { baseSeconds: 20, percentOfDuration: 25 });
  const withPercent = expectOk(setSttEngineTimeout(withBase, 'q1', { percentOfDuration: 100 }, defaultSttTimeout));
  assert.deepEqual(withPercent.engines[0].timeout, { baseSeconds: 20, percentOfDuration: 100 });
  assert.deepEqual(setSttEngineTimeout(config, 'q1', { baseSeconds: 0 }, defaultSttTimeout), { ok: false, reason: 'invalidValue' }, 'the schema\'s range still applies');
});

test('api key: set and replaced on the chosen engine only', () => {
  const config = configOf(groq, openai);
  const next = expectOk(setSttEngineApiKey(config, 'o1', 'sk-anotherKey1234567'));
  assert.equal(next.engines[0].apiKey, sampleKey);
  assert.equal(next.engines[1].apiKey, 'sk-anotherKey1234567');
  assert.deepEqual(setSttEngineApiKey(config, 'zz', 'sk-anotherKey1234567'), { ok: false, reason: 'unknownEngine' });
});

test('remove drops the engine; an unknown id is refused', () => {
  const config = configOf(groq, openai);
  assert.deepEqual(expectOk(removeSttEngine(config, 'q1')).engines, [openai]);
  assert.deepEqual(removeSttEngine(config, 'x'), { ok: false, reason: 'unknownEngine' });
});

test('add: fresh ids per kind, hosted engines last, the local one first and only once, the limit respected', () => {
  let config = createEmptySttConfig();
  let added = addSttEngine(config, { kind: 'groq', apiKey: sampleKey });
  assert.ok(added.ok && added.engineId === 'q1');
  config = expectOk(added);
  added = addSttEngine(config, { kind: 'groq', apiKey: 'gsk_secondKey123456789' });
  assert.ok(added.ok && added.engineId === 'q2');
  config = expectOk(added);
  added = addSttEngine(config, { kind: 'url', url: 'http://stt.local:8000/v1/audio/transcriptions' });
  assert.ok(added.ok && added.engineId === 'u1');
  config = expectOk(added);
  assert.deepEqual(config.engines[2], { id: 'u1', kind: 'url', url: 'http://stt.local:8000/v1/audio/transcriptions' }, 'no empty key is stored');
  config = expectOk(addSttEngine(config, { kind: 'gigaam' }));
  assert.deepEqual(config.engines.map((engine) => engine.id), ['g', 'q1', 'q2', 'u1']);
  assert.deepEqual(addSttEngine(config, { kind: 'gigaam' }), { ok: false, reason: 'alreadyListed' });

  let full = config;
  while (full.engines.length < sttEngineLimit) full = expectOk(addSttEngine(full, { kind: 'openai', apiKey: `sk-key${full.engines.length}-1234567` }));
  assert.deepEqual(addSttEngine(full, { kind: 'groq', apiKey: sampleKey }), { ok: false, reason: 'full' });
});

test('add: a URL engine may carry its key', () => {
  const result = addSttEngine(createEmptySttConfig(), { kind: 'url', url: 'https://stt.example/v1/audio/transcriptions', apiKey: sampleKey });
  assert.equal(expectOk(result).engines[0].apiKey, sampleKey);
});

test('enable local: put first when absent, switch on where it stands, leave an enabled one alone', () => {
  assert.deepEqual(expectOk(enableLocalSttEngine(configOf(groq))).engines.map((engine) => engine.id), ['g', 'q1']);
  const disabled = configOf(groq, { ...local, isDisabled: true });
  const enabled = expectOk(enableLocalSttEngine(disabled));
  assert.deepEqual(enabled.engines.map((engine) => engine.id), ['q1', 'g'], 'its place is kept');
  assert.ok(!enabled.engines[1].isDisabled);
  const already = configOf(groq, local);
  assert.deepEqual(expectOk(enableLocalSttEngine(already)), already);
});

test('drop local removes the local engine only', () => {
  assert.deepEqual(expectOk(dropLocalSttEngine(configOf(local, groq))).engines, [groq]);
  assert.deepEqual(expectOk(dropLocalSttEngine(configOf(groq))).engines, [groq]);
});

test('language, idle minutes and workers go through the schema (a workers value is clamped to a choice)', () => {
  const config = createEmptySttConfig();
  assert.equal(expectOk(setSttLanguage(config, 'ru')).language, 'ru');
  assert.equal(expectOk(setSttLanguage(expectOk(setSttLanguage(config, 'ru')), null)).language, null);
  assert.deepEqual(setSttLanguage(config, 'russian'), { ok: false, reason: 'invalidValue' });
  assert.equal(expectOk(setSttIdleMinutes(config, 0)).gigaam.idleMinutes, 0);
  assert.equal(expectOk(setSttIdleMinutes(config, 60)).gigaam.idleMinutes, 60);
  assert.deepEqual(setSttIdleMinutes(config, -5), { ok: false, reason: 'invalidValue' });
  assert.equal(expectOk(setSttWorkers(config, 8)).gigaam.workers, 8);
  assert.equal(expectOk(setSttWorkers(config, 3)).gigaam.workers, 2);
});

test('urls: a base address gets the transcriptions path, a full one is kept, a prefix is respected', () => {
  const normalise = (input: string): string => {
    const result = normaliseSttUrl(input);
    assert.ok(result.ok, input);
    return result.ok ? result.url : '';
  };
  assert.equal(normalise('http://stt.local:8000'), 'http://stt.local:8000/v1/audio/transcriptions');
  assert.equal(normalise('  http://stt.local:8000/  '), 'http://stt.local:8000/v1/audio/transcriptions');
  assert.equal(normalise('https://stt.example/v1'), 'https://stt.example/v1/audio/transcriptions');
  assert.equal(normalise('https://stt.example/v1/'), 'https://stt.example/v1/audio/transcriptions');
  assert.equal(normalise('https://stt.example/openai/v1'), 'https://stt.example/openai/v1/audio/transcriptions');
  assert.equal(normalise('https://stt.example/v1/audio/transcriptions'), 'https://stt.example/v1/audio/transcriptions');
  assert.equal(normalise('https://stt.example/api/audio/transcriptions/'), 'https://stt.example/api/audio/transcriptions/');
  assert.equal(normalise('https://stt.example/whisper#frag'), 'https://stt.example/whisper', 'any other path is kept as typed, the fragment dropped');
});

test('urls: not http(s), not an address, or a login inside → refused with the right reason', () => {
  assert.deepEqual(normaliseSttUrl('ftp://stt.local/x'), { ok: false, reason: 'invalid' });
  assert.deepEqual(normaliseSttUrl('stt.local:8000'), { ok: false, reason: 'invalid' });
  assert.deepEqual(normaliseSttUrl('not a url'), { ok: false, reason: 'invalid' });
  assert.deepEqual(normaliseSttUrl(''), { ok: false, reason: 'invalid' });
  assert.deepEqual(normaliseSttUrl('http://user:secret@stt.local/v1'), { ok: false, reason: 'credentials' });
  assert.deepEqual(normaliseSttUrl('http://token@stt.local/v1'), { ok: false, reason: 'credentials' });
});
