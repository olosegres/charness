/**
 * @description The mechanics every config-directory JSON file shares: where it lives (beside the REAL env file),
 * a load cached by the file's stamp, an atomic save, and the two checks that say why a save cannot be kept.
 * `stt.json` and `settings.json` are built on it; their own meaning is tested in their own files.
 */

import { test, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  checkIsConfigFileOnContainerDisk,
  createConfigFileLoader,
  getCaughtErrnoCode,
  getConfigDirFilePath,
  getConfigFileWriteBlock,
  writeJsonFileAtomically,
  type ConfigValidation,
} from '../configDirFile';

const sampleFileName = 'sample.json';

interface SampleConfig {
  label: string;
}

/** A validator that wants `{ "label": "<text>" }` and nothing else. */
function validateSample(parsedJson: object): ConfigValidation<SampleConfig> {
  const entries = Object.entries(parsedJson);
  const isValid = entries.length === 1 && entries[0][0] === 'label' && typeof entries[0][1] === 'string';
  return isValid ? { ok: true, config: { label: String(entries[0][1]) } } : { ok: false, errors: [`${sampleFileName} label: expected a string`] };
}

const sampleLoader = createConfigFileLoader<SampleConfig>({
  fileName: sampleFileName,
  createEmpty: () => ({ label: 'empty' }),
  validate: validateSample,
});

let configDir = '';
let configPath = '';

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-dir-file-'));
  configPath = path.join(configDir, sampleFileName);
  sampleLoader.resetCache();
});

afterEach(() => {
  fs.rmSync(configDir, { recursive: true, force: true });
});

function writeRaw(text: string): void {
  fs.writeFileSync(configPath, text);
}

test('the config path: next to the loaded env file, an isolated instance beside its ENV_FILE', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-dir-home-'));
  try {
    assert.equal(getConfigDirFilePath(sampleFileName, {}, homeDir), path.join(homeDir, '.config', 'charness', sampleFileName));
    const legacyDir = path.join(homeDir, '.config', 'telegramcode');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, '.env'), '');
    assert.equal(getConfigDirFilePath(sampleFileName, {}, homeDir), path.join(legacyDir, sampleFileName), 'a pre-rename config dir is kept');
    assert.equal(getConfigDirFilePath(sampleFileName, { ENV_FILE: '/srv/instance/.env' }, homeDir), `/srv/instance/${sampleFileName}`);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

/** A throwaway home dir whose real path is known (a tmp dir may itself sit behind a symlink). */
function withTempHome(run: (homeDir: string) => void): void {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'config-dir-home-')));
  try {
    run(homeDir);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
}

test('the config path: a symlinked .env puts the file beside the REAL env file, not beside the link', () => {
  withTempHome((homeDir) => {
    const secretsDir = path.join(homeDir, 'secrets', 'instance');
    fs.mkdirSync(secretsDir, { recursive: true });
    fs.writeFileSync(path.join(secretsDir, '.env'), 'TELEGRAM_BOT_TOKEN=x\n');
    const linkDir = path.join(homeDir, '.config', 'charness');
    fs.mkdirSync(linkDir, { recursive: true });
    fs.symlinkSync(path.join(secretsDir, '.env'), path.join(linkDir, '.env'));

    const filePath = getConfigDirFilePath(sampleFileName, {}, homeDir);
    assert.equal(filePath, path.join(secretsDir, sampleFileName));

    // The whole round trip lands there too: nothing is written into the config dir that only holds the link.
    writeJsonFileAtomically(filePath, { label: 'x' }, 0o600);
    assert.deepEqual(fs.readdirSync(secretsDir).sort(), ['.env', sampleFileName]);
    assert.deepEqual(fs.readdirSync(linkDir), ['.env']);
    assert.equal(sampleLoader.load(getConfigDirFilePath(sampleFileName, {}, homeDir)).status, 'ok');
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
    assert.equal(getConfigDirFilePath(sampleFileName, {}, homeDir), path.join(secretsDir, sampleFileName));

    const isolatedLink = path.join(homeDir, 'isolated.env');
    fs.symlinkSync(path.join(secretsDir, '.env'), isolatedLink);
    assert.equal(getConfigDirFilePath(sampleFileName, { ENV_FILE: isolatedLink }, homeDir), path.join(secretsDir, sampleFileName));
  });
});

test('the config path: a plain .env behaves as before, and a dangling link keeps the directory it was named in', () => {
  withTempHome((homeDir) => {
    const canonicalDir = path.join(homeDir, '.config', 'charness');
    fs.mkdirSync(canonicalDir, { recursive: true });
    fs.writeFileSync(path.join(canonicalDir, '.env'), '');
    assert.equal(getConfigDirFilePath(sampleFileName, {}, homeDir), path.join(canonicalDir, sampleFileName));

    fs.rmSync(path.join(canonicalDir, '.env'));
    fs.symlinkSync(path.join(homeDir, 'nowhere', '.env'), path.join(canonicalDir, '.env'));
    assert.equal(getConfigDirFilePath(sampleFileName, {}, homeDir), path.join(canonicalDir, sampleFileName));
  });
});

test('the config path: a pre-rename config dir that is now a link to the canonical one resolves to the canonical dir', () => {
  withTempHome((homeDir) => {
    const canonicalDir = path.join(homeDir, '.config', 'charness');
    fs.mkdirSync(canonicalDir, { recursive: true });
    fs.writeFileSync(path.join(canonicalDir, '.env'), '');
    fs.symlinkSync('charness', path.join(homeDir, '.config', 'telegramcode'));
    const envFile = path.join(homeDir, '.config', 'telegramcode', '.env');
    assert.equal(getConfigDirFilePath(sampleFileName, { ENV_FILE: envFile }, homeDir), path.join(canonicalDir, sampleFileName));
  });
});

test('load: no file → missing with the empty config, and a deleted file drops the cached one', () => {
  assert.deepEqual(sampleLoader.load(configPath), { status: 'missing', config: { label: 'empty' } });
  writeJsonFileAtomically(configPath, { label: 'one' }, 0o644);
  assert.equal(sampleLoader.load(configPath).status, 'ok');
  fs.rmSync(configPath);
  assert.equal(sampleLoader.load(configPath).status, 'missing');
});

test('load: cached by the file stamp — untouched → the same object, a hand edit → picked up', () => {
  writeJsonFileAtomically(configPath, { label: 'one' }, 0o644);
  const first = sampleLoader.load(configPath);
  assert.strictEqual(sampleLoader.load(configPath), first, 'an untouched file is served from the cache');

  writeRaw(JSON.stringify({ label: 'second, longer' }));
  const second = sampleLoader.load(configPath);
  assert.equal(second.status, 'ok');
  assert.equal(second.config?.label, 'second, longer');
});

test('load: an invalid edit reports the file\'s errors and hands back the last good config; the fix restores ok', () => {
  writeJsonFileAtomically(configPath, { label: 'good' }, 0o644);
  assert.equal(sampleLoader.load(configPath).status, 'ok');

  writeRaw(JSON.stringify({ label: 4 }));
  const broken = sampleLoader.load(configPath);
  assert.deepEqual(broken, { status: 'invalid', config: { label: 'good' }, errors: [`${sampleFileName} label: expected a string`] });

  writeRaw(JSON.stringify({ label: 'fixed' }));
  assert.deepEqual(sampleLoader.load(configPath), { status: 'ok', config: { label: 'fixed' } });
});

test('load: a garbage file is invalid with no last good, and its errors name the file and the position, never the content', () => {
  writeRaw('{ "label": "a-secret-value" ');
  const load = sampleLoader.load(configPath);
  assert.equal(load.status, 'invalid');
  assert.equal(load.config, null);
  const errors = load.status === 'invalid' ? load.errors : [];
  assert.match(errors[0], /^sample\.json is not valid JSON/);
  for (const error of errors) assert.ok(!error.includes('a-secret-value'), `leaked the content: ${error}`);

  writeRaw('[1, 2]');
  const array = sampleLoader.load(configPath);
  assert.deepEqual(array.status === 'invalid' ? array.errors : [], ['sample.json must hold a JSON object']);
});

test('load: a file that cannot be read is invalid, naming the OS error code', () => {
  fs.mkdirSync(configPath);
  const load = sampleLoader.load(configPath);
  assert.deepEqual(load.status === 'invalid' ? load.errors : [], ['sample.json could not be read (EISDIR)']);
});

test('save: writes with the given mode through a rename, leaves no temp file, creates missing directories', () => {
  writeJsonFileAtomically(configPath, { label: 'x' }, 0o600);
  assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(configDir), [sampleFileName]);

  const nestedPath = path.join(configDir, 'nested', 'dir', sampleFileName);
  writeJsonFileAtomically(nestedPath, { label: 'y' }, 0o644);
  assert.deepEqual(JSON.parse(fs.readFileSync(nestedPath, 'utf8')), { label: 'y' });
});

test('save: a write that fails throws and leaves neither a temp file nor a half-written target', () => {
  fs.mkdirSync(configPath); // a directory where the file should go: the rename fails
  assert.throws(() => writeJsonFileAtomically(configPath, { label: 'x' }, 0o644));
  assert.deepEqual(fs.readdirSync(configDir), [sampleFileName], 'the temp file is gone');
});

test('error code: an Error carries its errno, anything else is "unknown"', () => {
  let caught: unknown = null;
  try {
    fs.readFileSync(path.join(configDir, 'absent.json'));
  } catch (e) {
    caught = e;
  }
  assert.equal(getCaughtErrnoCode(caught), 'ENOENT');
  assert.equal(getCaughtErrnoCode(new Error('no code')), 'unknown');
  assert.equal(getCaughtErrnoCode('a string'), 'unknown');
});

test('write block: a writable directory — existing or still to be created — has none; a file in the way and a read-only directory name their errno', () => {
  assert.equal(getConfigFileWriteBlock(configPath), null);
  assert.equal(getConfigFileWriteBlock(path.join(configDir, 'not', 'yet', 'there', sampleFileName)), null, 'the save creates the missing directories');

  fs.writeFileSync(path.join(configDir, 'plainFile'), '');
  assert.equal(getConfigFileWriteBlock(path.join(configDir, 'plainFile', sampleFileName)), 'ENOTDIR');
  assert.equal(getConfigFileWriteBlock(path.join(configDir, 'plainFile', 'deeper', sampleFileName)), 'ENOTDIR', 'a file anywhere on the way blocks it');
});

test('write block: a read-only directory is EACCES (a permission check root passes, so it is skipped there)', { skip: process.getuid?.() === 0 }, () => {
  const readOnlyDir = path.join(configDir, 'readOnly');
  fs.mkdirSync(readOnlyDir);
  fs.chmodSync(readOnlyDir, 0o500);
  try {
    assert.equal(getConfigFileWriteBlock(path.join(readOnlyDir, sampleFileName)), 'EACCES');
    assert.equal(getConfigFileWriteBlock(path.join(readOnlyDir, 'sub', sampleFileName)), 'EACCES', 'the nearest existing directory decides');
  } finally {
    fs.chmodSync(readOnlyDir, 0o700);
  }
});

test('container disk: only inside a container, and only when the config directory shares the device of / (no mount of its own)', () => {
  const insideContainer = (candidate: string): boolean => candidate === '/.dockerenv';
  const onHost = (): boolean => false;
  const deviceOf = (devices: Record<string, number>) => (directory: string): number => {
    const match = Object.keys(devices).filter((mounted) => directory === mounted || directory.startsWith(`${mounted}/`) || mounted === '/').sort((a, b) => b.length - a.length)[0];
    return devices[match];
  };
  const unmounted = deviceOf({ '/': 10 });
  const mounted = deviceOf({ '/': 10, [configDir]: 20 });

  assert.equal(checkIsConfigFileOnContainerDisk(configPath, insideContainer, unmounted), true, 'the old single-file mount: the directory is the container\'s own disk');
  assert.equal(checkIsConfigFileOnContainerDisk(configPath, insideContainer, mounted), false, 'a mounted config directory is fine');
  assert.equal(checkIsConfigFileOnContainerDisk(configPath, onHost, unmounted), false, 'a host is never reported');
  assert.equal(checkIsConfigFileOnContainerDisk(configPath, (candidate) => candidate === '/run/.containerenv', unmounted), true, 'Podman marks its containers too');
  assert.equal(checkIsConfigFileOnContainerDisk(path.join(configDir, 'not', 'yet', 'there', sampleFileName), insideContainer, mounted), false, 'a directory the save will create sits on the nearest existing one\'s mount');
  assert.equal(checkIsConfigFileOnContainerDisk(configPath, insideContainer, () => { throw new Error('EIO'); }), false, 'what cannot be read is not guessed');
  assert.equal(checkIsConfigFileOnContainerDisk(configPath, onHost), false, 'the real device check is not reached without a container marker');
});
