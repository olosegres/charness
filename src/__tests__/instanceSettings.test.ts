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
  createBotSkillsSettingsReader,
  createEmptyInstanceSettings,
  createInstanceDefaultEffortReader,
  createRunnerHostReader,
  createTaskAgentsMaxConcurrentReader,
  createUpdateSettingsReader,
  getInstanceSettingsPath,
  instanceSettingsFileName,
  loadInstanceSettings,
  loadInstanceSettingsForUpdate,
  resetInstanceSettingsCache,
  saveInstanceSettings,
  validateInstanceSettings,
  type InstanceSettings,
} from '../instanceSettings';
import { taskAgentsMaxConcurrentUpperBound } from '../trackers/taskAgentLimit';
import { claudeEffortLevels, defaultEffortLevel, getInstanceDefaultEffort, setInstanceDefaultEffortReader } from '../effortLevels';

let configDir = '';
let settingsPath = '';

/** The settings of a file that sets only these fields. */
function createSettings(overrides: Partial<InstanceSettings>): InstanceSettings {
  return { ...createEmptyInstanceSettings(), ...overrides };
}

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
    assert.deepEqual(validateInstanceSettings({ defaultEffort: level }), { ok: true, config: createSettings({ defaultEffort: level }) });
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
  saveInstanceSettings(settingsPath, createSettings({ defaultEffort: 'high' }));
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), { defaultEffort: 'high' });
  assert.deepEqual(fs.readdirSync(configDir), [instanceSettingsFileName]);
  assert.deepEqual(loadInstanceSettings(settingsPath), { status: 'ok', config: createSettings({ defaultEffort: 'high' }) });
});

test('save creates the config dir; a "not set" default is an empty object, not a null the next reader refuses', () => {
  const nestedPath = path.join(configDir, 'nested', 'dir', instanceSettingsFileName);
  saveInstanceSettings(nestedPath, createSettings({ defaultEffort: null }));
  assert.deepEqual(JSON.parse(fs.readFileSync(nestedPath, 'utf8')), {});
  assert.equal(loadInstanceSettings(nestedPath).status, 'ok');
});

test('no file → missing with nothing set', () => {
  assert.deepEqual(loadInstanceSettings(settingsPath), { status: 'missing', config: createEmptyInstanceSettings() });
});

test('a hand edit is picked up by the next load (stamp cache), an untouched file is served from the cache', () => {
  saveInstanceSettings(settingsPath, createSettings({ defaultEffort: 'low' }));
  const first = loadInstanceSettings(settingsPath);
  assert.strictEqual(loadInstanceSettings(settingsPath), first);

  writeRaw('{ "defaultEffort": "max" }');
  assert.deepEqual(loadInstanceSettings(settingsPath), { status: 'ok', config: createSettings({ defaultEffort: 'max' }) });
});

test('loadForUpdate: the file\'s own settings when valid, empty ones for a missing or broken file', () => {
  assert.deepEqual(loadInstanceSettingsForUpdate(settingsPath), createEmptyInstanceSettings());
  saveInstanceSettings(settingsPath, createSettings({ defaultEffort: 'high' }));
  assert.deepEqual(loadInstanceSettingsForUpdate(settingsPath), createSettings({ defaultEffort: 'high' }));
  writeRaw('{ "defaultEffort": "mid" }');
  assert.deepEqual(loadInstanceSettingsForUpdate(settingsPath), createEmptyInstanceSettings(), 'a pick made over a broken file replaces it');
});

test('the effort reader: the file\'s level; null when the file is missing or leaves the field out', () => {
  const logged: string[] = [];
  const readDefault = createInstanceDefaultEffortReader(() => settingsPath, (line) => logged.push(line));
  assert.equal(readDefault(), null, 'no file');
  saveInstanceSettings(settingsPath, createSettings({ defaultEffort: 'xhigh' }));
  assert.equal(readDefault(), 'xhigh');
  writeRaw('{}');
  assert.equal(readDefault(), null, 'the field removed by hand');
  assert.deepEqual(logged, []);
});

test('the effort reader: an unknown level or invalid JSON → null (the code fallback) and ONE named error per broken state; a fix then a new break is reported again', () => {
  const logged: string[] = [];
  const readDefault = createInstanceDefaultEffortReader(() => settingsPath, (line) => logged.push(line));
  saveInstanceSettings(settingsPath, createSettings({ defaultEffort: 'high' }));
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

  saveInstanceSettings(settingsPath, createSettings({ defaultEffort: 'high' }));
  assert.equal(getInstanceDefaultEffort(), 'high');
  writeRaw('{ "defaultEffort": "low" }');
  assert.equal(getInstanceDefaultEffort(), 'low');
  writeRaw('not json at all');
  assert.equal(getInstanceDefaultEffort(), 'medium');
  fs.rmSync(settingsPath);
  assert.equal(getInstanceDefaultEffort(), 'medium');
});

test('autoUpdate takes on / notify / off and whatsNew a boolean; both are "not set" in an empty file', () => {
  for (const mode of ['on', 'notify', 'off'] as const) {
    assert.deepEqual(validateInstanceSettings({ autoUpdate: mode }), { ok: true, config: createSettings({ autoUpdate: mode }) });
  }
  assert.deepEqual(validateInstanceSettings({ whatsNew: false }), { ok: true, config: createSettings({ whatsNew: false }) });
  assert.equal(createEmptyInstanceSettings().autoUpdate, null);
  assert.equal(createEmptyInstanceSettings().whatsNew, null);
});

test('a wrong autoUpdate or whatsNew value is an error naming its field', () => {
  const badMode = validateInstanceSettings({ autoUpdate: 'sometimes' });
  assert.equal(badMode.ok, false);
  assert.match(badMode.ok ? '' : badMode.errors.join('\n'), /^settings\.json autoUpdate: /);
  const badFlag = validateInstanceSettings({ whatsNew: 'yes' });
  assert.equal(badFlag.ok, false);
  assert.match(badFlag.ok ? '' : badFlag.errors.join('\n'), /^settings\.json whatsNew: /);
});

test('the file holds only the fields that are set; a change keeps the others', () => {
  saveInstanceSettings(settingsPath, createSettings({ autoUpdate: 'notify', whatsNew: false }));
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), { autoUpdate: 'notify', whatsNew: false });
  saveInstanceSettings(settingsPath, { ...loadInstanceSettingsForUpdate(settingsPath), defaultEffort: 'high' });
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), { defaultEffort: 'high', autoUpdate: 'notify', whatsNew: false });
  saveInstanceSettings(settingsPath, createEmptyInstanceSettings());
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), {});
});

test('a hand edit of autoUpdate shows on the next read', () => {
  saveInstanceSettings(settingsPath, createSettings({ autoUpdate: 'on' }));
  assert.deepEqual(loadInstanceSettings(settingsPath), { status: 'ok', config: createSettings({ autoUpdate: 'on' }) });
  writeRaw('{"autoUpdate":"off","whatsNew":true}');
  assert.deepEqual(loadInstanceSettings(settingsPath), { status: 'ok', config: createSettings({ autoUpdate: 'off', whatsNew: true }) });
});

test('the update settings reader fills the defaults in (on, shown), follows a hand edit, and reports a broken file once', () => {
  const errors: string[] = [];
  const read = createUpdateSettingsReader(() => settingsPath, (line) => errors.push(line));
  assert.deepEqual(read(), { autoUpdate: 'on', whatsNew: true }, 'no file');
  saveInstanceSettings(settingsPath, createSettings({ autoUpdate: 'notify' }));
  assert.deepEqual(read(), { autoUpdate: 'notify', whatsNew: true });
  writeRaw('{"whatsNew":false}');
  assert.deepEqual(read(), { autoUpdate: 'on', whatsNew: false }, 'a field that is not set falls back, the other stays');
  writeRaw('{"autoUpdate":"sometimes"}');
  assert.deepEqual(read(), { autoUpdate: 'on', whatsNew: true }, 'a broken file reads as the defaults');
  read();
  read();
  assert.equal(errors.length, 1, 'one line per distinct broken state');
  assert.match(errors[0], /autoUpdate/);
  writeRaw('{"autoUpdate":"off"}');
  assert.deepEqual(read(), { autoUpdate: 'off', whatsNew: true });
});

test('botSkills takes on / off and is "not set" in an empty file; a wrong value is an error naming the field', () => {
  for (const value of ['on', 'off'] as const) {
    assert.deepEqual(validateInstanceSettings({ botSkills: value }), { ok: true, config: createSettings({ botSkills: value }) });
  }
  assert.equal(createEmptyInstanceSettings().botSkills, null);
  assert.deepEqual(validateInstanceSettings({}), { ok: true, config: createEmptyInstanceSettings() });
  for (const wrong of ['yes', true, 'OFF']) {
    const bad = validateInstanceSettings({ botSkills: wrong });
    assert.equal(bad.ok, false, String(wrong));
    assert.match(bad.ok ? '' : bad.errors.join('\n'), /^settings\.json botSkills: /);
  }
});

test('botSkills is written only when set and a change keeps it', () => {
  saveInstanceSettings(settingsPath, createSettings({ botSkills: 'off', autoUpdate: 'off' }));
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), { autoUpdate: 'off', botSkills: 'off' });
  saveInstanceSettings(settingsPath, { ...loadInstanceSettingsForUpdate(settingsPath), defaultEffort: 'high' });
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), { defaultEffort: 'high', autoUpdate: 'off', botSkills: 'off' });
});

test('the bot-skills reader: null with no file or field, the file\'s value, a hand edit with no restart, a broken file as null with ONE named error', () => {
  const errors: string[] = [];
  const read = createBotSkillsSettingsReader(() => settingsPath, (line) => errors.push(line));
  assert.equal(read(), null, 'no file');
  writeRaw('{"autoUpdate":"off"}');
  assert.equal(read(), null, 'the field left out');
  writeRaw('{"botSkills":"off"}');
  assert.equal(read(), 'off');
  writeRaw('{"botSkills":"on"}');
  assert.equal(read(), 'on');
  writeRaw('{"botSkills":"maybe"}');
  assert.equal(read(), null, 'a broken file says nothing');
  read();
  assert.equal(errors.length, 1);
  assert.match(errors[0], /botSkills/);
});

test('taskAgents.maxConcurrent takes 0 (no limit) up to the bound and is "not set" in an empty file; anything else is an error naming the field', () => {
  assert.equal(createEmptyInstanceSettings().taskAgents.maxConcurrent, null);
  for (const value of [0, 1, 5, taskAgentsMaxConcurrentUpperBound]) {
    assert.deepEqual(validateInstanceSettings({ taskAgents: { maxConcurrent: value } }), { ok: true, config: createSettings({ taskAgents: { maxConcurrent: value } }) }, String(value));
  }
  assert.deepEqual(validateInstanceSettings({ taskAgents: {} }), { ok: true, config: createEmptyInstanceSettings() }, 'a section without the field says nothing');
  for (const wrong of [-1, 1.5, taskAgentsMaxConcurrentUpperBound + 1, '5', true]) {
    const bad = validateInstanceSettings({ taskAgents: { maxConcurrent: wrong } });
    assert.equal(bad.ok, false, String(wrong));
    assert.match(bad.ok ? '' : bad.errors.join('\n'), /^settings\.json taskAgents\.maxConcurrent: /);
  }
  const unknownKey = validateInstanceSettings({ taskAgents: { maxConcurent: 3 } });
  assert.equal(unknownKey.ok, false, 'a typo in the key is an error, not silently the default');
  assert.match(unknownKey.ok ? '' : unknownKey.errors.join('\n'), /^settings\.json taskAgents: /);
});

test('taskAgents is written only when set — 0 included — and a change keeps it', () => {
  saveInstanceSettings(settingsPath, createSettings({ taskAgents: { maxConcurrent: 0 }, autoUpdate: 'off' }));
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), { autoUpdate: 'off', taskAgents: { maxConcurrent: 0 } });
  saveInstanceSettings(settingsPath, { ...loadInstanceSettingsForUpdate(settingsPath), defaultEffort: 'high' });
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), { defaultEffort: 'high', autoUpdate: 'off', taskAgents: { maxConcurrent: 0 } });
  saveInstanceSettings(settingsPath, createSettings({}));
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), {}, 'not set: left out');
});

test('the task-agents reader: null with no file or field, the file\'s value (0 included), a hand edit with no restart, a broken file as null with ONE named error', () => {
  const errors: string[] = [];
  const read = createTaskAgentsMaxConcurrentReader(() => settingsPath, (line) => errors.push(line));
  assert.equal(read(), null, 'no file');
  writeRaw('{"autoUpdate":"off"}');
  assert.equal(read(), null, 'the field left out');
  writeRaw('{"taskAgents":{"maxConcurrent":3}}');
  assert.equal(read(), 3);
  writeRaw('{"taskAgents":{"maxConcurrent":0}}');
  assert.equal(read(), 0, 'no limit is a value, not «not set»');
  writeRaw('{"taskAgents":{"maxConcurrent":"many"}}');
  assert.equal(read(), null, 'a broken file says nothing');
  read();
  assert.equal(errors.length, 1);
  assert.match(errors[0], /taskAgents\.maxConcurrent/);
});

test('runnerHost: the address paired runners dial — absent is null, a host and port round-trip through the file, a bad one is a named error', () => {
  assert.equal(createEmptyInstanceSettings().runnerHost, null);
  assert.deepEqual(validateInstanceSettings({}), { ok: true, config: createSettings({}) });
  assert.deepEqual(
    validateInstanceSettings({ runnerHost: { host: 'host.example', port: 2222 } }),
    { ok: true, config: createSettings({ runnerHost: { host: 'host.example', port: 2222 } }) },
  );

  saveInstanceSettings(settingsPath, createSettings({ runnerHost: { host: '203.0.113.5', port: 22 } }));
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), { runnerHost: { host: '203.0.113.5', port: 22 } });
  resetInstanceSettingsCache();
  assert.deepEqual(createRunnerHostReader(() => settingsPath, () => {})(), { host: '203.0.113.5', port: 22 });

  for (const wrong of [{ host: 'bad host', port: 22 }, { host: 'host.example', port: 0 }, { host: 'host.example', port: 70000 }, { host: 'host.example' }, '203.0.113.5:22']) {
    const bad = validateInstanceSettings({ runnerHost: wrong });
    assert.equal(bad.ok, false, JSON.stringify(wrong));
    if (!bad.ok) assert.ok(bad.errors.every((error) => error.startsWith('settings.json runnerHost')), bad.errors.join('; '));
  }
});

test('runnerHost: an invalid file reads as not chosen, and a change keeps the other settings', () => {
  const logged: string[] = [];
  writeRaw('{ "runnerHost": { "host": "x y", "port": 22 } }\n');
  assert.equal(createRunnerHostReader(() => settingsPath, (line) => logged.push(line))(), null);
  assert.equal(logged.length, 1);

  saveInstanceSettings(settingsPath, createSettings({ autoUpdate: 'off', runnerHost: { host: 'host.example', port: 22 } }));
  assert.deepEqual(loadInstanceSettingsForUpdate(settingsPath).runnerHost, { host: 'host.example', port: 22 });
  assert.equal(loadInstanceSettingsForUpdate(settingsPath).autoUpdate, 'off');
});
