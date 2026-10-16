/**
 * @description `settings.json` is the ONE source of truth for the instance-wide settings (today the default
 * effort of every topic without its own pick): `/effort` in General writes it, a hand edit is picked up without a
 * restart, a typo is a named error and the code fallback applies (never a stale copy of an earlier valid file).
 */

import { test, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  createEmptyInstanceSettings,
  createInstanceDefaultEffortReader,
  getInstanceSettingsPath,
  instanceSettingsFileName,
  loadInstanceSettings,
  loadInstanceSettingsForUpdate,
  resetInstanceSettingsCache,
  saveInstanceSettings,
  validateInstanceSettings,
} from '../instanceSettings';
import { claudeEffortLevels, defaultEffortLevel, getInstanceDefaultEffort, setInstanceDefaultEffortReader } from '../effortLevels';

let configDir = '';
let settingsPath = '';

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instance-settings-'));
  settingsPath = path.join(configDir, instanceSettingsFileName);
  resetInstanceSettingsCache();
});

afterEach(() => {
  setInstanceDefaultEffortReader(() => null);
  fs.rmSync(configDir, { recursive: true, force: true });
});

/**
 * A hand edit the way an editor saves it: a new file renamed over the old. The cache key is (mtime, size, inode), and
 * an in-place rewrite of the same size within one clock tick of the last write would keep all three — which no human
 * edit can do, but a test can.
 */
function writeRaw(text: string): void {
  const tempPath = `${settingsPath}.by-hand`;
  fs.writeFileSync(tempPath, text);
  fs.renameSync(tempPath, settingsPath);
}

test('the path: next to the real env file — the same directory stt.json uses', () => {
  assert.equal(getInstanceSettingsPath({ ENV_FILE: '/srv/instance/instance.env' }, os.tmpdir()), '/srv/instance/settings.json');
});

test('every Claude level is a valid default; the empty object and the missing field mean "not set"', () => {
  for (const level of claudeEffortLevels) {
    assert.deepEqual(validateInstanceSettings({ defaultEffort: level }), { ok: true, config: { defaultEffort: level } });
  }
  assert.deepEqual(validateInstanceSettings({}), { ok: true, config: createEmptyInstanceSettings() });
  assert.equal(createEmptyInstanceSettings().defaultEffort, null);
});

test('errors name the file and the field: an unknown level, a wrong type, a typo\'d key', () => {
  const unknownLevel = validateInstanceSettings({ defaultEffort: 'mid' });
  assert.ok(!unknownLevel.ok);
  assert.match(unknownLevel.errors[0], /^settings\.json defaultEffort: /);
  assert.ok(!unknownLevel.errors[0].includes('mid'), 'the offending value is not echoed');

  const wrongType = validateInstanceSettings({ defaultEffort: 5 });
  assert.ok(!wrongType.ok && wrongType.errors[0].startsWith('settings.json defaultEffort: '));

  const typo = validateInstanceSettings({ defaultEfort: 'high' });
  assert.ok(!typo.ok && /^settings\.json \(root\): /.test(typo.errors[0]) && typo.errors[0].includes('defaultEfort'));
});

test('save writes the field through a rename and leaves no temp file; load reads it back', () => {
  saveInstanceSettings(settingsPath, { defaultEffort: 'high' });
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), { defaultEffort: 'high' });
  assert.deepEqual(fs.readdirSync(configDir), [instanceSettingsFileName]);
  assert.deepEqual(loadInstanceSettings(settingsPath), { status: 'ok', config: { defaultEffort: 'high' } });
});

test('save creates the config dir; a "not set" default is an empty object, not a null the next reader refuses', () => {
  const nestedPath = path.join(configDir, 'nested', 'dir', instanceSettingsFileName);
  saveInstanceSettings(nestedPath, { defaultEffort: null });
  assert.deepEqual(JSON.parse(fs.readFileSync(nestedPath, 'utf8')), {});
  assert.equal(loadInstanceSettings(nestedPath).status, 'ok');
});

test('no file → missing with nothing set', () => {
  assert.deepEqual(loadInstanceSettings(settingsPath), { status: 'missing', config: createEmptyInstanceSettings() });
});

test('a hand edit is picked up by the next load (stamp cache), an untouched file is served from the cache', () => {
  saveInstanceSettings(settingsPath, { defaultEffort: 'low' });
  const first = loadInstanceSettings(settingsPath);
  assert.strictEqual(loadInstanceSettings(settingsPath), first);

  writeRaw('{ "defaultEffort": "max" }');
  assert.deepEqual(loadInstanceSettings(settingsPath), { status: 'ok', config: { defaultEffort: 'max' } });
});

test('loadForUpdate: the file\'s own settings when valid, empty ones for a missing or broken file', () => {
  assert.deepEqual(loadInstanceSettingsForUpdate(settingsPath), createEmptyInstanceSettings());
  saveInstanceSettings(settingsPath, { defaultEffort: 'high' });
  assert.deepEqual(loadInstanceSettingsForUpdate(settingsPath), { defaultEffort: 'high' });
  writeRaw('{ "defaultEffort": "mid" }');
  assert.deepEqual(loadInstanceSettingsForUpdate(settingsPath), createEmptyInstanceSettings(), 'a pick made over a broken file replaces it');
});

test('the effort reader: the file\'s level; null when the file is missing or leaves the field out', () => {
  const logged: string[] = [];
  const readDefault = createInstanceDefaultEffortReader(() => settingsPath, (line) => logged.push(line));
  assert.equal(readDefault(), null, 'no file');
  saveInstanceSettings(settingsPath, { defaultEffort: 'xhigh' });
  assert.equal(readDefault(), 'xhigh');
  writeRaw('{}');
  assert.equal(readDefault(), null, 'the field removed by hand');
  assert.deepEqual(logged, []);
});

test('the effort reader: an unknown level or invalid JSON → null (the code fallback) and ONE named error per broken state; a fix then a new break is reported again', () => {
  const logged: string[] = [];
  const readDefault = createInstanceDefaultEffortReader(() => settingsPath, (line) => logged.push(line));
  saveInstanceSettings(settingsPath, { defaultEffort: 'high' });
  assert.equal(readDefault(), 'high');

  writeRaw('{ "defaultEffort": "mid" }');
  assert.equal(readDefault(), null, 'not the last good copy: what the file says is wrong, so the code default applies');
  assert.equal(readDefault(), null);
  assert.equal(readDefault(), null);
  assert.equal(logged.length, 1, 'read three times, reported once');
  assert.match(logged[0], /^\[Settings\] settings\.json defaultEffort: .* \(the built-in defaults apply until it is fixed\)$/);

  writeRaw('{ "defaultEffort": ');
  assert.equal(readDefault(), null);
  assert.equal(logged.length, 2);
  assert.match(logged[1], /^\[Settings\] settings\.json is not valid JSON/);

  writeRaw('{ "defaultEffort": "low" }');
  assert.equal(readDefault(), 'low', 'the fix applies at once');
  writeRaw('{ "defaultEffort": "mid" }');
  assert.equal(readDefault(), null);
  assert.equal(logged.length, 3, 'a new break after a fix is a new report');
});

test('registered as the instance default: the code fallback is medium, the file overrides it, the resolver follows a hand edit', () => {
  setInstanceDefaultEffortReader(createInstanceDefaultEffortReader(() => settingsPath, () => {}));
  assert.equal(getInstanceDefaultEffort(), defaultEffortLevel);
  assert.equal(defaultEffortLevel, 'medium');

  saveInstanceSettings(settingsPath, { defaultEffort: 'high' });
  assert.equal(getInstanceDefaultEffort(), 'high');
  writeRaw('{ "defaultEffort": "low" }');
  assert.equal(getInstanceDefaultEffort(), 'low');
  writeRaw('not json at all');
  assert.equal(getInstanceDefaultEffort(), 'medium');
  fs.rmSync(settingsPath);
  assert.equal(getInstanceDefaultEffort(), 'medium');
});
