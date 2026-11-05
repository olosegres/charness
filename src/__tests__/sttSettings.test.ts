/**
 * @description `stt.json` is the ONE source of truth for voice recognition: the
 * file order is the chain order, a typo is a named error that never echoes a
 * value (the file holds API keys), a bad hand edit keeps the last good settings,
 * and the old env keys move into it exactly once.
 */

import { test, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { z } from 'zod';
import { resetLegacyNameState } from '../legacyNames';
import {
  clampSttWorkers,
  createEmptySttConfig,
  createSttEngineId,
  defaultSttTimeout,
  getEngineTimeoutMs,
  getNoEngineNoticeCode,
  getSttConfigPath,
  getSttReportLines,
  loadSttConfig,
  migrateLegacySttKeys,
  migrateSttStoredDefaults,
  resetSttConfigCache,
  resolveSttSettings,
  saveSttConfig,
  validateSttConfig,
  type SttConfigFile,
  type SttFacts,
} from '../stt/sttSettings';

let configDir = '';
let configPath = '';

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stt-settings-'));
  configPath = path.join(configDir, 'stt.json');
  resetSttConfigCache();
  resetLegacyNameState();
});

afterEach(() => {
  fs.rmSync(configDir, { recursive: true, force: true });
});

const sampleKey = 'gsk_sampleSecretKey1234567890';

const installedFacts: SttFacts = {
  isGigaamInstalled: true,
  isGigaamInstalling: false,
  isGigaamUnhealthy: false,
  hasOwnerContext: true,
};
const gigaamHook = (): Promise<{ url: string; model: string }> =>
  Promise.resolve({ url: 'http://127.0.0.1:9/v1/audio/transcriptions', model: 'gigaam' });

function createConfig(overrides: Partial<SttConfigFile> = {}): SttConfigFile {
  return { ...createEmptySttConfig(), ...overrides };
}

function writeRaw(text: string): void {
  fs.writeFileSync(configPath, text);
}

function expectInvalid(raw: object): string[] {
  const result = validateSttConfig(raw);
  assert.equal(result.ok, false, 'expected the file to be refused');
  return result.ok ? [] : result.errors;
}

test('the file order is the chain order, and the defaults fill what the file omits', () => {
  const result = validateSttConfig({
    engines: [
      { id: 'g', kind: 'gigaam' },
      { id: 'q1', kind: 'groq', apiKey: sampleKey },
      { id: 'u1', kind: 'url', url: 'http://stt.local/v1/audio/transcriptions' },
    ],
  });
  assert.ok(result.ok);
  assert.deepEqual(result.config.engines.map((engine) => engine.id), ['g', 'q1', 'u1']);
  assert.equal(result.config.language, null);
  assert.deepEqual(result.config.gigaam, { idleMinutes: 60, workers: 4 });
});

test('an empty object is a valid file with no engines', () => {
  const result = validateSttConfig({});
  assert.ok(result.ok);
  assert.deepEqual(result.config, createEmptySttConfig());
});

test('errors name the field: unknown kind, duplicate id, out-of-range number, bad language', () => {
  assert.ok(
    expectInvalid({ engines: [{ id: 'x1', kind: 'whisperx' }] }).some((error) => error.startsWith('stt.json engines.0.kind')),
  );
  assert.deepEqual(
    expectInvalid({ engines: [{ id: 'q1', kind: 'groq', apiKey: 'a' }, { id: 'q1', kind: 'openai', apiKey: 'b' }] }),
    ['stt.json engines.1.id: duplicate id'],
  );
  assert.ok(
    expectInvalid({ engines: [{ id: 'q1', kind: 'groq', timeout: { baseSeconds: 0, percentOfDuration: 25 } }] }).some(
      (error) => error.startsWith('stt.json engines.0.timeout.baseSeconds'),
    ),
  );
  assert.ok(
    expectInvalid({ engines: [{ id: 'q1', kind: 'groq', timeout: { baseSeconds: 10, percentOfDuration: 900 } }] }).some(
      (error) => error.startsWith('stt.json engines.0.timeout.percentOfDuration'),
    ),
  );
  assert.ok(expectInvalid({ language: 'russian' }).some((error) => error.startsWith('stt.json language')));
  assert.ok(expectInvalid({ gigaam: { idleMinutes: -1 } }).some((error) => error.startsWith('stt.json gigaam.idleMinutes')));
  assert.ok(expectInvalid({ gigaam: { workers: 0 } }).some((error) => error.startsWith('stt.json gigaam.workers')));
});

test('a typo in a key, a bad engine id, a bad URL, two local engines and a seventh engine are all refused', () => {
  assert.ok(expectInvalid({ enigines: [] }).some((error) => error.includes('enigines')));
  assert.ok(expectInvalid({ engines: [{ id: 'Q_1', kind: 'groq' }] }).some((error) => error.startsWith('stt.json engines.0.id')));
  assert.deepEqual(
    expectInvalid({ engines: [{ id: 'u1', kind: 'url', url: 'ftp://stt.local/x' }] }),
    ['stt.json engines.0.url: must be an http(s) URL'],
  );
  assert.deepEqual(
    expectInvalid({ engines: [{ id: 'g', kind: 'gigaam' }, { id: 'g2', kind: 'gigaam' }] }),
    ['stt.json engines.1.kind: the local engine can be listed only once'],
  );
  const seven = Array.from({ length: 7 }, (_, index) => ({ id: `u${index + 1}`, kind: 'url', url: 'http://stt.local/x' }));
  assert.ok(expectInvalid({ engines: seven }).some((error) => error.startsWith('stt.json engines')));
});

test('an error never carries a value: a key next to the mistake stays out of every message', () => {
  const errors = expectInvalid({ engines: [{ id: 'q1', kind: 'groq', apiKey: sampleKey, timeout: { baseSeconds: 'x' } }] });
  assert.ok(errors.length > 0);
  for (const error of errors) assert.ok(!error.includes(sampleKey), `leaked the key: ${error}`);
});

test('workers are clamped to the nearest choice, a tie going to the smaller', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 40].map(clampSttWorkers), [1, 2, 2, 4, 4, 4, 8, 8, 8]);
  const result = validateSttConfig({ gigaam: { workers: 3, threads: 3 } });
  assert.ok(result.ok);
  assert.deepEqual(result.config.gigaam, { idleMinutes: 60, workers: 2, threads: 3 });
});

test('save writes mode 0600 through a rename and leaves no temp file; load reads it back', () => {
  const config = createConfig({ engines: [{ id: 'q1', kind: 'groq', apiKey: sampleKey }], language: 'ru' });
  saveSttConfig(configPath, config);
  assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(configDir).sort(), ['stt.defaults-migrated', 'stt.json'], 'the file and the marker beside it — no temp file');
  const load = loadSttConfig(configPath);
  assert.equal(load.status, 'ok');
  assert.deepEqual(load.config, config);
});

function readStored(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

const markerPath = (): string => path.join(configDir, 'stt.defaults-migrated');

/**
 * The schema every RELEASED build reads stt.json with (copied from the commit before the stored-defaults change): strict, so a
 * key it does not know turns voice off on that build. What this build writes must pass it — a rollback, a downgrade and the
 * bot's own boot rollback all end in an older build reading this file.
 */
const releasedTimeoutSchema = z.strictObject({ baseSeconds: z.number().min(1).max(600), percentOfDuration: z.number().min(0).max(400) });
const releasedEngineSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9]{1,8}$/),
  kind: z.enum(['gigaam', 'groq', 'openai', 'url']),
  isDisabled: z.boolean().optional(),
  timeout: releasedTimeoutSchema.optional(),
  url: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  apiKey: z.string().min(1).optional(),
});
const releasedFileSchema = z.strictObject({
  engines: z.array(releasedEngineSchema).max(6).optional(),
  language: z.string().regex(/^[a-z]{2}$/).nullable().optional(),
  gigaam: z.strictObject({
    idleMinutes: z.number().int().min(0).max(24 * 60).optional(),
    workers: z.number().int().min(1).max(64).optional(),
    threads: z.number().int().min(1).max(32).optional(),
  }).optional(),
});

test('what this build writes is read by the strict schema of the released builds — a rollback or a downgrade keeps voice', () => {
  const configs: SttConfigFile[] = [
    createConfig(),
    createConfig({ engines: [{ id: 'g', kind: 'gigaam' }] }),
    createConfig({ engines: [{ id: 'g', kind: 'gigaam' }, { id: 'q1', kind: 'groq', apiKey: sampleKey, timeout: { baseSeconds: 5, percentOfDuration: 50 } }], language: 'ru' }),
    createConfig({ gigaam: { idleMinutes: 15, workers: 4 } }),
    createConfig({ gigaam: { idleMinutes: 0, workers: 8, threads: 3 } }),
  ];
  for (const config of configs) {
    saveSttConfig(configPath, config);
    const verdict = releasedFileSchema.safeParse(readStored());
    assert.ok(verdict.success, `${JSON.stringify(readStored())}: ${verdict.success ? '' : JSON.stringify(verdict.error.issues)}`);
    assert.deepEqual(Object.keys(readStored()).filter((key) => !['engines', 'language', 'gigaam'].includes(key)), [], 'no new key in the file');
  }
});

test('save stores only what differs from the defaults — a default written to the file would look like a choice', () => {
  saveSttConfig(configPath, createConfig({ engines: [{ id: 'g', kind: 'gigaam' }] }));
  assert.deepEqual(readStored(), { engines: [{ id: 'g', kind: 'gigaam' }], language: null }, 'no gigaam block at all');

  saveSttConfig(configPath, createConfig({ gigaam: { idleMinutes: 15, workers: 4 } }));
  assert.deepEqual(readStored().gigaam, { idleMinutes: 15 }, 'a 15 picked on purpose differs from the default and is stored');

  saveSttConfig(configPath, createConfig({ gigaam: { idleMinutes: 60, workers: 8, threads: 3 } }));
  assert.deepEqual(readStored().gigaam, { workers: 8, threads: 3 });
  assert.deepEqual(loadSttConfig(configPath).config?.gigaam, { idleMinutes: 60, workers: 8, threads: 3 }, 'read back, the defaults fill what the file omits');
});

/** What an earlier build saved: the whole gigaam block, the idle default of that time included. */
const earlierBuildFile = { engines: [{ id: 'g', kind: 'gigaam' }], language: null, gigaam: { idleMinutes: 15, workers: 4 } };

test('stored defaults migration: the idle 15 that an earlier build wrote itself is dropped once, mode 0600, and the marker beside the file records it', () => {
  writeRaw(JSON.stringify(earlierBuildFile));
  fs.chmodSync(configPath, 0o644);
  assert.ok(!fs.existsSync(markerPath()));

  assert.deepEqual(migrateSttStoredDefaults(configPath), { status: 'migrated', isIdleMinutesDropped: true });
  assert.deepEqual(readStored(), { engines: [{ id: 'g', kind: 'gigaam' }], language: null }, 'no new key, no stored default');
  assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
  assert.ok(fs.existsSync(markerPath()));
  assert.deepEqual(loadSttConfig(configPath).config?.gigaam, { idleMinutes: 60, workers: 4 }, 'the engine now follows the current default');

  const migratedText = fs.readFileSync(configPath, 'utf8');
  assert.deepEqual(migrateSttStoredDefaults(configPath), { status: 'notNeeded' }, 'one time only');
  assert.equal(fs.readFileSync(configPath, 'utf8'), migratedText, 'and the second run does not touch the file');
});

test('stored defaults migration: a 15 picked AFTER it is a choice — no later boot drops it', () => {
  writeRaw(JSON.stringify(earlierBuildFile));
  migrateSttStoredDefaults(configPath);
  const config = loadSttConfig(configPath).config;
  assert.ok(config);
  saveSttConfig(configPath, { ...config, gigaam: { ...config.gigaam, idleMinutes: 15 } });
  const chosenText = fs.readFileSync(configPath, 'utf8');
  assert.deepEqual(readStored().gigaam, { idleMinutes: 15 }, 'stored without a default next to it');

  assert.deepEqual(migrateSttStoredDefaults(configPath), { status: 'notNeeded' });
  assert.equal(fs.readFileSync(configPath, 'utf8'), chosenText);
  assert.equal(loadSttConfig(configPath).config?.gigaam.idleMinutes, 15);
});

test('stored defaults migration: a 15 saved by a build that has never seen the migration (a fresh install) is a choice too — the save writes the marker', () => {
  assert.ok(!fs.existsSync(markerPath()));
  saveSttConfig(configPath, createConfig({ engines: [{ id: 'g', kind: 'gigaam' }], gigaam: { idleMinutes: 15, workers: 8 } }));
  assert.ok(fs.existsSync(markerPath()));
  assert.deepEqual(migrateSttStoredDefaults(configPath), { status: 'notNeeded' });
  assert.deepEqual(readStored().gigaam, { idleMinutes: 15, workers: 8 });
});

test('stored defaults migration: rollback → an older build saves in /stt → update again: the stored default next to the 15 shows the older build wrote it, so it is dropped again', () => {
  writeRaw(JSON.stringify(earlierBuildFile));
  migrateSttStoredDefaults(configPath); // the first update
  assert.ok(fs.existsSync(markerPath()));
  // The older build reads the new file (it passes its strict schema, see above) and saves: the whole gigaam block, 15 again.
  writeRaw(JSON.stringify({ engines: [{ id: 'g', kind: 'gigaam' }, { id: 'q1', kind: 'groq', apiKey: sampleKey }], language: 'ru', gigaam: { idleMinutes: 15, workers: 4 } }));

  assert.deepEqual(migrateSttStoredDefaults(configPath), { status: 'migrated', isIdleMinutesDropped: true });
  assert.deepEqual(readStored(), { engines: [{ id: 'g', kind: 'gigaam' }, { id: 'q1', kind: 'groq', apiKey: sampleKey }], language: 'ru' });
  assert.deepEqual(migrateSttStoredDefaults(configPath), { status: 'notNeeded' });
});

test('stored defaults migration: with the marker there, a 15 beside a workers count that was changed on purpose stays — no content tells it from a choice', () => {
  saveSttConfig(configPath, createConfig({ engines: [{ id: 'g', kind: 'gigaam' }] })); // the marker is there
  writeRaw(JSON.stringify({ engines: [{ id: 'g', kind: 'gigaam' }], gigaam: { idleMinutes: 15, workers: 2 } }));
  assert.deepEqual(migrateSttStoredDefaults(configPath), { status: 'notNeeded' });
  assert.deepEqual(readStored().gigaam, { idleMinutes: 15, workers: 2 });

  // Without the marker it is dropped like any earlier build's file, and the workers count is kept.
  fs.rmSync(markerPath());
  assert.deepEqual(migrateSttStoredDefaults(configPath), { status: 'migrated', isIdleMinutesDropped: true });
  assert.deepEqual(readStored().gigaam, { workers: 2 });
});

test('stored defaults migration: nothing to drop → no rewrite; a stored default without a 15 changes nothing and is not rewritten on every boot', () => {
  const groqOnly = JSON.stringify({ engines: [{ id: 'q1', kind: 'groq', apiKey: sampleKey }] });
  writeRaw(groqOnly);
  assert.deepEqual(migrateSttStoredDefaults(configPath), { status: 'migrated', isIdleMinutesDropped: false });
  assert.equal(fs.readFileSync(configPath, 'utf8'), groqOnly, 'the file is not touched, only the marker is written');
  assert.ok(fs.existsSync(markerPath()));
  assert.deepEqual(migrateSttStoredDefaults(configPath), { status: 'notNeeded' });

  const storedDefault = JSON.stringify({ engines: [], gigaam: { idleMinutes: 30, workers: 4 } });
  writeRaw(storedDefault);
  assert.deepEqual(migrateSttStoredDefaults(configPath), { status: 'notNeeded' }, 'marked, a stored workers 4 and no 15: nothing to do');
  assert.equal(fs.readFileSync(configPath, 'utf8'), storedDefault);
});

test('stored defaults migration: any other stored value is kept when the 15 is dropped', () => {
  writeRaw(JSON.stringify({ engines: [{ id: 'g', kind: 'gigaam' }], language: 'ru', gigaam: { idleMinutes: 15, workers: 4, threads: 3 } }));
  assert.deepEqual(migrateSttStoredDefaults(configPath), { status: 'migrated', isIdleMinutesDropped: true });
  assert.deepEqual(readStored(), { engines: [{ id: 'g', kind: 'gigaam' }], language: 'ru', gigaam: { threads: 3 } });
});

test('stored defaults migration: a missing, garbage or invalid file is left exactly as it is, with no marker; a directory that cannot be written is reported', () => {
  assert.deepEqual(migrateSttStoredDefaults(configPath), { status: 'notNeeded' });
  assert.ok(!fs.existsSync(configPath), 'no file is created');
  assert.ok(!fs.existsSync(markerPath()), 'and no marker: nothing was handled');

  for (const text of ['{not json', JSON.stringify({ engines: [{ id: 'g', kind: 'gigaam' }, { id: 'h', kind: 'gigaam' }] }), JSON.stringify({ unknownKey: 1 })]) {
    writeRaw(text);
    assert.deepEqual(migrateSttStoredDefaults(configPath), { status: 'notNeeded' });
    assert.equal(fs.readFileSync(configPath, 'utf8'), text);
    assert.ok(!fs.existsSync(markerPath()));
  }

  writeRaw(JSON.stringify(earlierBuildFile));
  fs.chmodSync(configDir, 0o500);
  try {
    const result = migrateSttStoredDefaults(configPath);
    // The permission checks do not apply to root, where the directory is still writable.
    if (process.getuid?.() !== 0) assert.deepEqual(result, { status: 'writeFailed', error: 'EACCES' });
  } finally {
    fs.chmodSync(configDir, 0o700);
  }
});

test('save creates the config dir, and refuses to write an invalid file', () => {
  const nestedPath = path.join(configDir, 'nested', 'dir', 'stt.json');
  saveSttConfig(nestedPath, createConfig());
  assert.ok(fs.existsSync(nestedPath));
  const duplicateIds = createConfig({
    engines: [{ id: 'q1', kind: 'groq', apiKey: 'a' }, { id: 'q1', kind: 'openai', apiKey: 'b' }],
  });
  assert.throws(() => saveSttConfig(configPath, duplicateIds), /duplicate id/);
  assert.ok(!fs.existsSync(configPath), 'nothing is written for a refused config');
});

test('no file → missing with the empty settings, and a deleted file drops the cached ones', () => {
  assert.deepEqual(loadSttConfig(configPath), { status: 'missing', config: createEmptySttConfig() });
  saveSttConfig(configPath, createConfig({ language: 'ru' }));
  assert.equal(loadSttConfig(configPath).status, 'ok');
  fs.rmSync(configPath);
  assert.equal(loadSttConfig(configPath).status, 'missing');
});

test('the load is cached by the file stamp: untouched → same object, a hand edit → picked up', () => {
  saveSttConfig(configPath, createConfig({ language: 'ru' }));
  const first = loadSttConfig(configPath);
  assert.strictEqual(loadSttConfig(configPath), first, 'an untouched file is served from the cache');

  writeRaw(JSON.stringify({ language: 'en', engines: [{ id: 'q1', kind: 'groq', apiKey: sampleKey }] }));
  const second = loadSttConfig(configPath);
  assert.equal(second.status, 'ok');
  assert.equal(second.config?.language, 'en');
  assert.equal(second.config?.engines.length, 1);
});

test('an invalid hand edit keeps the last good settings and reports the error; the fix restores ok', () => {
  saveSttConfig(configPath, createConfig({ engines: [{ id: 'q1', kind: 'groq', apiKey: sampleKey }] }));
  const good = loadSttConfig(configPath);
  assert.equal(good.status, 'ok');

  writeRaw(JSON.stringify({ engines: [{ id: 'q1', kind: 'nope' }] }));
  const broken = loadSttConfig(configPath);
  assert.equal(broken.status, 'invalid');
  assert.ok(broken.status === 'invalid' && broken.errors[0].startsWith('stt.json engines.0.kind'));
  assert.deepEqual(broken.config, good.config, 'the last good settings stay in effect');

  writeRaw(JSON.stringify({ engines: [{ id: 'q1', kind: 'openai', apiKey: sampleKey }] }));
  const fixed = loadSttConfig(configPath);
  assert.equal(fixed.status, 'ok');
  assert.equal(fixed.config?.engines[0].kind, 'openai');
});

test('a garbage file at boot is invalid with no last good, and its errors never quote the content', () => {
  writeRaw(`{ "engines": [ { "apiKey": "${sampleKey}" `);
  const load = loadSttConfig(configPath);
  assert.equal(load.status, 'invalid');
  assert.equal(load.config, null);
  const errors = load.status === 'invalid' ? load.errors : [];
  assert.match(errors[0], /^stt\.json is not valid JSON/);
  for (const error of errors) assert.ok(!error.includes(sampleKey), `leaked the key: ${error}`);

  writeRaw('[1, 2]');
  const array = loadSttConfig(configPath);
  assert.deepEqual(array.status === 'invalid' ? array.errors : [], ['stt.json must hold a JSON object']);
});

test('a file that cannot be read is invalid, naming the OS error code', () => {
  fs.mkdirSync(configPath);
  const load = loadSttConfig(configPath);
  assert.equal(load.status, 'invalid');
  assert.deepEqual(load.status === 'invalid' ? load.errors : [], ['stt.json could not be read (EISDIR)']);
});

test('the config path: stt.json sits in the config directory beside the real env file (the rules are tested with the shared helper)', () => {
  assert.equal(getSttConfigPath({ ENV_FILE: '/srv/instance/.env' }, os.tmpdir()), '/srv/instance/stt.json');
});

test('migration: no file + GROQ_API_KEY and OPENAI_API_KEY → stt.json with Groq first, the deprecation said once', () => {
  const lines: string[] = [];
  const first = migrateLegacySttKeys(configPath, { GROQ_API_KEY: sampleKey, OPENAI_API_KEY: 'sk-other' }, (text) => lines.push(text));
  assert.deepEqual(first, { status: 'migrated', engineNames: ['groq', 'openai'] });
  const load = loadSttConfig(configPath);
  assert.deepEqual(
    load.config?.engines.map((engine) => [engine.id, engine.kind, engine.apiKey]),
    [['q1', 'groq', sampleKey], ['o1', 'openai', 'sk-other']],
  );
  assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
  assert.deepEqual(lines, ['[deprecated] GROQ_API_KEY/OPENAI_API_KEY in .env is deprecated, voice settings now live in stt.json\n']);

  const second = migrateLegacySttKeys(configPath, { GROQ_API_KEY: sampleKey }, (text) => lines.push(text));
  assert.deepEqual(second, { status: 'fileExists' });
  assert.equal(lines.length, 1, 'the deprecation line is printed once per process');
});

test('migration: an existing file wins — the env keys are ignored and the file is not touched', () => {
  saveSttConfig(configPath, createConfig({ engines: [{ id: 'o1', kind: 'openai', apiKey: 'sk-own' }] }));
  const before = fs.readFileSync(configPath, 'utf8');
  const result = migrateLegacySttKeys(configPath, { GROQ_API_KEY: sampleKey }, () => {});
  assert.deepEqual(result, { status: 'fileExists' });
  assert.equal(fs.readFileSync(configPath, 'utf8'), before);
});

test('migration: no keys → nothing is written and nothing is said; one key → just that engine', () => {
  const lines: string[] = [];
  assert.deepEqual(migrateLegacySttKeys(configPath, {}, (text) => lines.push(text)), { status: 'noKeys' });
  assert.deepEqual(migrateLegacySttKeys(configPath, { GROQ_API_KEY: '' }, (text) => lines.push(text)), { status: 'noKeys' });
  assert.ok(!fs.existsSync(configPath));
  assert.deepEqual(lines, []);

  assert.deepEqual(
    migrateLegacySttKeys(configPath, { OPENAI_API_KEY: 'sk-only' }, () => {}),
    { status: 'migrated', engineNames: ['openai'] },
  );
  assert.deepEqual(loadSttConfig(configPath).config?.engines.map((engine) => engine.kind), ['openai']);
});

test('migration: a config dir that cannot be written reports the error code, never the key', () => {
  fs.writeFileSync(path.join(configDir, 'blocker'), '');
  const result = migrateLegacySttKeys(path.join(configDir, 'blocker', 'stt.json'), { GROQ_API_KEY: sampleKey }, () => {});
  assert.equal(result.status, 'writeFailed');
  assert.ok(!JSON.stringify(result).includes(sampleKey));
});

test('engine ids: the local engine is g, the others get their letter and the smallest free number', () => {
  assert.equal(createSttEngineId('gigaam', new Set()), 'g');
  assert.equal(createSttEngineId('groq', new Set()), 'q1');
  assert.equal(createSttEngineId('groq', new Set(['q1', 'q2'])), 'q3');
  assert.equal(createSttEngineId('openai', new Set(['q1'])), 'o1');
  assert.equal(createSttEngineId('url', new Set(['u1'])), 'u2');
});

test('resolve: the chain keeps the file order and each static engine answers with its endpoint at once', async () => {
  const config = createConfig({
    engines: [
      { id: 'u1', kind: 'url', url: 'http://stt.local:8080/v1/audio/transcriptions', model: 'my-model' },
      { id: 'q1', kind: 'groq', apiKey: sampleKey },
      { id: 'o1', kind: 'openai', apiKey: 'sk-own', timeout: { baseSeconds: 5, percentOfDuration: 50 } },
    ],
  });
  const resolved = resolveSttSettings({ status: 'ok', config }, installedFacts);
  assert.deepEqual(resolved.engines.map((engine) => engine.name), ['url:stt.local:8080', 'groq', 'openai']);
  assert.deepEqual(resolved.engines.map((engine) => engine.timeout), [
    defaultSttTimeout,
    defaultSttTimeout,
    { baseSeconds: 5, percentOfDuration: 50 },
  ]);
  assert.deepEqual(await resolved.engines[0].getEndpoint(), {
    url: 'http://stt.local:8080/v1/audio/transcriptions',
    apiKey: undefined,
    model: 'my-model',
  });
  assert.equal((await resolved.engines[1].getEndpoint()).apiKey, sampleKey);
  assert.equal((await resolved.engines[2].getEndpoint()).model, 'whisper-1');
  assert.equal(resolved.source, 'ok');
  assert.deepEqual(resolved.unavailable, []);
});

test('resolve: a disabled engine, a missing key and a missing URL are skipped with their reason', () => {
  const config = createConfig({
    engines: [
      { id: 'q1', kind: 'groq', isDisabled: true, apiKey: sampleKey },
      { id: 'o1', kind: 'openai' },
      { id: 'u1', kind: 'url' },
      { id: 'u2', kind: 'url', url: 'http://stt.local/x' },
    ],
  });
  const resolved = resolveSttSettings({ status: 'ok', config }, installedFacts);
  assert.deepEqual(resolved.engines.map((engine) => engine.id), ['u2']);
  assert.deepEqual(resolved.unavailable, [
    { id: 'q1', kind: 'groq', reason: 'disabled' },
    { id: 'o1', kind: 'openai', reason: 'missingKey' },
    { id: 'u1', kind: 'url', reason: 'missingUrl' },
  ]);
});

test('resolve: the local engine is skipped while it is not installed, installing, unhealthy or has no owner', () => {
  const config = createConfig({ engines: [{ id: 'g', kind: 'gigaam' }, { id: 'q1', kind: 'groq', apiKey: sampleKey }] });
  const reasonOf = (facts: SttFacts, hook = gigaamHook) =>
    resolveSttSettings({ status: 'ok', config }, facts, { getGigaamEndpoint: hook }).unavailable[0]?.reason;

  assert.equal(reasonOf(installedFacts), undefined, 'a ready local engine is available');
  assert.equal(reasonOf({ ...installedFacts, isGigaamInstalled: false }), 'notInstalled');
  assert.equal(reasonOf({ ...installedFacts, isGigaamInstalled: false, isGigaamInstalling: true }), 'installing');
  assert.equal(reasonOf({ ...installedFacts, isGigaamUnhealthy: true }), 'unhealthy');
  assert.equal(reasonOf({ ...installedFacts, hasOwnerContext: false }), 'noOwnerContext');
  const withoutHook = resolveSttSettings({ status: 'ok', config }, installedFacts);
  assert.equal(withoutHook.unavailable[0]?.reason, 'noOwnerContext', 'no way to start it means no owner to start it for');
  assert.deepEqual(withoutHook.engines.map((engine) => engine.id), ['q1']);
});

test('resolve: the local engine knows only Russian — a set language other than ru skips it, ru and auto keep it', () => {
  const engines = [{ id: 'g', kind: 'gigaam' as const }, { id: 'q1', kind: 'groq' as const, apiKey: sampleKey }];
  const resolveWith = (language: string | null) =>
    resolveSttSettings({ status: 'ok', config: createConfig({ engines, language }) }, installedFacts, {
      getGigaamEndpoint: gigaamHook,
    });
  assert.deepEqual(resolveWith('en').unavailable, [{ id: 'g', kind: 'gigaam', reason: 'languageNotSupported' }]);
  assert.deepEqual(resolveWith('ru').engines.map((engine) => engine.id), ['g', 'q1']);
  assert.deepEqual(resolveWith(null).engines.map((engine) => engine.id), ['g', 'q1']);
});

test('resolve: the local engine asks its hook for the endpoint at call time', async () => {
  let asked = 0;
  const hook = async () => {
    asked++;
    return { url: 'http://127.0.0.1:5555/v1/audio/transcriptions', apiKey: 'sidecar-token', model: 'gigaam' };
  };
  const resolved = resolveSttSettings(
    { status: 'ok', config: createConfig({ engines: [{ id: 'g', kind: 'gigaam' }] }) },
    installedFacts,
    { getGigaamEndpoint: hook },
  );
  assert.equal(asked, 0, 'nothing is started when the settings are resolved');
  assert.equal((await resolved.engines[0].getEndpoint()).apiKey, 'sidecar-token');
  assert.equal(asked, 1);
});

test('auto-install is wanted only when the file names an enabled local engine that is not installed', () => {
  const withGigaam = createConfig({ engines: [{ id: 'g', kind: 'gigaam' }] });
  const needs = (config: SttConfigFile, facts: SttFacts) => resolveSttSettings({ status: 'ok', config }, facts).needsAutoInstall;

  assert.equal(needs(withGigaam, { ...installedFacts, isGigaamInstalled: false }), true);
  assert.equal(needs(withGigaam, installedFacts), false, 'already installed');
  assert.equal(needs(withGigaam, { ...installedFacts, isGigaamInstalled: false, isGigaamInstalling: true }), false, 'already underway');
  assert.equal(needs(createConfig({ engines: [{ id: 'q1', kind: 'groq', apiKey: sampleKey }] }), { ...installedFacts, isGigaamInstalled: false }), false);
  assert.equal(needs(createConfig({ engines: [{ id: 'g', kind: 'gigaam', isDisabled: true }] }), { ...installedFacts, isGigaamInstalled: false }), false);
  assert.equal(needs(createEmptySttConfig(), { ...installedFacts, isGigaamInstalled: false }), false);
});

test('resolve: the source tells a valid file, no file, a kept last-good and an unusable file apart', () => {
  const config = createConfig({ engines: [{ id: 'q1', kind: 'groq', apiKey: sampleKey }] });
  assert.equal(resolveSttSettings({ status: 'ok', config }, installedFacts).source, 'ok');
  assert.equal(resolveSttSettings({ status: 'missing', config: createEmptySttConfig() }, installedFacts).source, 'missing');

  const lastGood = resolveSttSettings({ status: 'invalid', config, errors: ['stt.json x'] }, installedFacts);
  assert.equal(lastGood.source, 'lastGood');
  assert.deepEqual(lastGood.errors, ['stt.json x']);
  assert.equal(lastGood.engines.length, 1, 'the last good chain keeps serving voice');

  const unusable = resolveSttSettings({ status: 'invalid', config: null, errors: ['stt.json x'] }, installedFacts);
  assert.equal(unusable.source, 'invalid');
  assert.deepEqual(unusable.engines, []);
  assert.deepEqual(unusable.settings, createEmptySttConfig());
});

test('timeout math: 10 s plus 25 % of the voice by default — 30 s → 17.5 s, 300 s → 85 s; no length, or a 0 Telegram could not read, is unknown → 25 s', () => {
  assert.equal(getEngineTimeoutMs(defaultSttTimeout, 30), 17_500);
  assert.equal(getEngineTimeoutMs(defaultSttTimeout, 300), 85_000);
  assert.equal(getEngineTimeoutMs(defaultSttTimeout, undefined), 25_000);
  assert.equal(getEngineTimeoutMs(defaultSttTimeout, 0), 25_000, 'a voice whose duration is 0 is of unknown length, not a 0-second voice');
  assert.equal(getEngineTimeoutMs(defaultSttTimeout, -3), 25_000);
  assert.equal(getEngineTimeoutMs(defaultSttTimeout, Number.NaN), 25_000);
  assert.equal(getEngineTimeoutMs({ baseSeconds: 5, percentOfDuration: 100 }, 20), 25_000);
  assert.equal(getEngineTimeoutMs({ baseSeconds: 30, percentOfDuration: 25 }, 0), 45_000, 'the unknown-length budget follows the engine\'s own numbers');
});

test('timeout math: the audio queued ahead of the voice is budgeted at the same rate — 9 s behind 300 s → 87.25 s', () => {
  assert.equal(getEngineTimeoutMs(defaultSttTimeout, 9, 300), 87_250);
  assert.equal(getEngineTimeoutMs(defaultSttTimeout, 9, 0), getEngineTimeoutMs(defaultSttTimeout, 9));
  assert.equal(getEngineTimeoutMs(defaultSttTimeout, undefined, 40), 35_000, 'an unknown length still counts as a minute, plus the queue');
});

test('the report: file errors say what the bot does instead, skipped engines say why, a disabled one is silent', () => {
  const config = createConfig({
    engines: [
      { id: 'q1', kind: 'groq', isDisabled: true, apiKey: sampleKey },
      { id: 'o1', kind: 'openai' },
    ],
  });
  const kept = resolveSttSettings({ status: 'invalid', config, errors: ['stt.json language: bad'] }, installedFacts);
  assert.deepEqual(getSttReportLines(kept), [
    '[STT] stt.json language: bad (keeping the last good settings)',
    '[STT] engine o1 (openai) is skipped: no API key',
    '[STT] no speech engine is available: voice notes are refused until one is set up',
  ]);

  const unusable = resolveSttSettings({ status: 'invalid', config: null, errors: ['stt.json is not valid JSON'] }, installedFacts);
  assert.deepEqual(getSttReportLines(unusable), ['[STT] stt.json is not valid JSON (no voice settings loaded)']);

  const healthy = resolveSttSettings({ status: 'ok', config: createConfig({ engines: [{ id: 'q1', kind: 'groq', apiKey: sampleKey }] }) }, installedFacts);
  assert.deepEqual(getSttReportLines(healthy), []);
});

test('the notice a voice gets when no engine can take it names the real cause', () => {
  const resolveWith = (engines: SttConfigFile['engines'], facts: Partial<SttFacts> = {}) =>
    resolveSttSettings({ status: 'ok', config: createConfig({ engines }) }, { ...installedFacts, ...facts }, { getGigaamEndpoint: gigaamHook });

  assert.equal(getNoEngineNoticeCode(resolveWith([])), 'voice.no_api_key', 'nothing set up');
  assert.equal(getNoEngineNoticeCode(resolveWith([{ id: 'q1', kind: 'groq', apiKey: sampleKey, isDisabled: true }])), 'voice.no_api_key', 'everything switched off by the operator');
  assert.equal(
    getNoEngineNoticeCode(resolveWith([{ id: 'g', kind: 'gigaam' }], { isGigaamInstalled: false, isGigaamInstalling: true })),
    'voice.local_installing',
    'GigaAM installing as the only engine is not "set up an engine"',
  );
  assert.equal(getNoEngineNoticeCode(resolveWith([{ id: 'g', kind: 'gigaam' }], { isGigaamInstalled: false })), 'voice.engines_unavailable', 'listed, not installed');
  assert.equal(getNoEngineNoticeCode(resolveWith([{ id: 'g', kind: 'gigaam' }], { isGigaamUnhealthy: true })), 'voice.engines_unavailable', 'listed, paused after failed starts');
  assert.equal(getNoEngineNoticeCode(resolveWith([{ id: 'q1', kind: 'groq' }])), 'voice.engines_unavailable', 'listed without a key');
  assert.equal(getNoEngineNoticeCode({ errors: ['stt.json engines.0: unknown key'], unavailable: [] }), 'voice.config_invalid');
  assert.equal(
    getNoEngineNoticeCode({ errors: ['stt.json broken'], unavailable: [{ id: 'g', kind: 'gigaam', reason: 'installing' }] }),
    'voice.config_invalid',
    'a broken file outranks everything',
  );
});
