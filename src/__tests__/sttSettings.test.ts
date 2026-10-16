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
import { resetLegacyNameState } from '../legacyNames';
import {
  clampSttWorkers,
  createEmptySttConfig,
  createSttEngineId,
  defaultSttTimeout,
  getEngineTimeoutMs,
  getSttConfigPath,
  getSttConfigWriteBlock,
  getSttReportLines,
  loadSttConfig,
  migrateLegacySttKeys,
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
  assert.deepEqual(result.config.gigaam, { idleMinutes: 15, workers: 4 });
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
  assert.deepEqual(result.config.gigaam, { idleMinutes: 15, workers: 2, threads: 3 });
});

test('save writes mode 0600 through a rename and leaves no temp file; load reads it back', () => {
  const config = createConfig({ engines: [{ id: 'q1', kind: 'groq', apiKey: sampleKey }], language: 'ru' });
  saveSttConfig(configPath, config);
  assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(configDir), ['stt.json']);
  const load = loadSttConfig(configPath);
  assert.equal(load.status, 'ok');
  assert.deepEqual(load.config, config);
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

test('the config path: next to the loaded env file, an isolated instance beside its ENV_FILE', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stt-home-'));
  try {
    assert.equal(getSttConfigPath({}, homeDir), path.join(homeDir, '.config', 'charness', 'stt.json'));
    const legacyDir = path.join(homeDir, '.config', 'telegramcode');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, '.env'), '');
    assert.equal(getSttConfigPath({}, homeDir), path.join(legacyDir, 'stt.json'), 'a pre-rename config dir is kept');
    assert.equal(getSttConfigPath({ ENV_FILE: '/srv/instance/.env' }, homeDir), '/srv/instance/stt.json');
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

/** A throwaway home dir whose real path is known (a tmp dir may itself sit behind a symlink). */
function withTempHome(run: (homeDir: string) => void): void {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stt-home-')));
  try {
    run(homeDir);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
}

test('the config path: a symlinked .env puts stt.json beside the REAL file, not beside the link', () => {
  withTempHome((homeDir) => {
    const secretsDir = path.join(homeDir, 'secrets', 'instance');
    fs.mkdirSync(secretsDir, { recursive: true });
    fs.writeFileSync(path.join(secretsDir, '.env'), 'TELEGRAM_BOT_TOKEN=x\n');
    const configDir = path.join(homeDir, '.config', 'charness');
    fs.mkdirSync(configDir, { recursive: true });
    fs.symlinkSync(path.join(secretsDir, '.env'), path.join(configDir, '.env'));

    const sttPath = getSttConfigPath({}, homeDir);
    assert.equal(sttPath, path.join(secretsDir, 'stt.json'));

    // The whole round trip lands there too: nothing is written into the config dir that only holds the link.
    saveSttConfig(sttPath, createConfig({ engines: [{ id: 'q1', kind: 'groq', apiKey: sampleKey }] }));
    assert.deepEqual(fs.readdirSync(secretsDir).sort(), ['.env', 'stt.json']);
    assert.deepEqual(fs.readdirSync(configDir), ['.env']);
    assert.equal(loadSttConfig(getSttConfigPath({}, homeDir)).status, 'ok');
  });
});

test('the config path: the link may sit in a pre-rename config dir, and an ENV_FILE link is followed too', () => {
  withTempHome((homeDir) => {
    const secretsDir = path.join(homeDir, 'secrets');
    fs.mkdirSync(secretsDir);
    fs.writeFileSync(path.join(secretsDir, '.env'), '');
    const legacyDir = path.join(homeDir, '.config', 'telegram-code');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.symlinkSync(path.join(secretsDir, '.env'), path.join(legacyDir, '.env'));
    assert.equal(getSttConfigPath({}, homeDir), path.join(secretsDir, 'stt.json'));

    const isolatedLink = path.join(homeDir, 'isolated.env');
    fs.symlinkSync(path.join(secretsDir, '.env'), isolatedLink);
    assert.equal(getSttConfigPath({ ENV_FILE: isolatedLink }, homeDir), path.join(secretsDir, 'stt.json'));
  });
});

test('the config path: a plain .env behaves as before, and a dangling link keeps the directory it was named in', () => {
  withTempHome((homeDir) => {
    const configDir = path.join(homeDir, '.config', 'charness');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, '.env'), '');
    assert.equal(getSttConfigPath({}, homeDir), path.join(configDir, 'stt.json'));

    fs.rmSync(path.join(configDir, '.env'));
    fs.symlinkSync(path.join(homeDir, 'nowhere', '.env'), path.join(configDir, '.env'));
    assert.equal(getSttConfigPath({}, homeDir), path.join(configDir, 'stt.json'));
  });
});

test('the config path: a pre-rename config dir that is now a link to the canonical one resolves to the canonical dir', () => {
  withTempHome((homeDir) => {
    const canonicalDir = path.join(homeDir, '.config', 'charness');
    fs.mkdirSync(canonicalDir, { recursive: true });
    fs.writeFileSync(path.join(canonicalDir, '.env'), '');
    fs.symlinkSync('charness', path.join(homeDir, '.config', 'telegramcode'));
    assert.equal(getSttConfigPath({ ENV_FILE: path.join(homeDir, '.config', 'telegramcode', '.env') }, homeDir), path.join(canonicalDir, 'stt.json'));
  });
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

test('timeout math: 10 s plus 25 % of the voice by default — 0 s → 10 s, 30 s → 17.5 s, 300 s → 85 s, unknown → 25 s', () => {
  assert.equal(getEngineTimeoutMs(defaultSttTimeout, 0), 10_000);
  assert.equal(getEngineTimeoutMs(defaultSttTimeout, 30), 17_500);
  assert.equal(getEngineTimeoutMs(defaultSttTimeout, 300), 85_000);
  assert.equal(getEngineTimeoutMs(defaultSttTimeout, undefined), 25_000);
  assert.equal(getEngineTimeoutMs({ baseSeconds: 5, percentOfDuration: 100 }, 20), 25_000);
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

test('write block: a writable directory — existing or still to be created — has none; a file in the way and a read-only directory name their errno', () => {
  assert.equal(getSttConfigWriteBlock(configPath), null);
  assert.equal(getSttConfigWriteBlock(path.join(configDir, 'not', 'yet', 'there', 'stt.json')), null, 'the save creates the missing directories');

  fs.writeFileSync(path.join(configDir, 'plainFile'), '');
  assert.equal(getSttConfigWriteBlock(path.join(configDir, 'plainFile', 'stt.json')), 'ENOTDIR');
  assert.equal(getSttConfigWriteBlock(path.join(configDir, 'plainFile', 'deeper', 'stt.json')), 'ENOTDIR', 'a file anywhere on the way blocks it');
});

test('write block: a read-only directory is EACCES (a permission check root passes, so it is skipped there)', { skip: process.getuid?.() === 0 }, () => {
  const readOnlyDir = path.join(configDir, 'readOnly');
  fs.mkdirSync(readOnlyDir);
  fs.chmodSync(readOnlyDir, 0o500);
  try {
    assert.equal(getSttConfigWriteBlock(path.join(readOnlyDir, 'stt.json')), 'EACCES');
    assert.equal(getSttConfigWriteBlock(path.join(readOnlyDir, 'sub', 'stt.json')), 'EACCES', 'the nearest existing directory decides');
  } finally {
    fs.chmodSync(readOnlyDir, 0o700);
  }
});
