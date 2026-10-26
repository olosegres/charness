/**
 * @description The «Bot skills» switch (`utils/botSkills.ts`, `/bot_skills`): the precedence of its layers — the topic's
 * own choice, then General's value, then `settings.json`'s `botSkills`, then ON — read through the registered reader, with
 * the Jira conversation (no choice of its own) following the instance value, and the state pair that stores the first two.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { StateStore } from '../state';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import { makeJiraKey } from '../connectors/jira/sessionKeyCodec';
import {
  checkIsBotSkillsEnabled,
  createBotSkillsReader,
  readBotSkillsInstanceValue,
  resolveBotSkillsEnabled,
  setBotSkillsReader,
  settingsOnlyBotSkillsReader,
  type BotSkillsSetting,
} from '../utils/botSkills';
import { resetInstanceSettingsCache } from '../instanceSettings';

const topic = makeTelegramKey(-1001111111111, 42);
const otherTopic = makeTelegramKey(-1001111111111, 43);
const jiraConversation = makeJiraKey('PROJ-1');

afterEach(() => {
  setBotSkillsReader(settingsOnlyBotSkillsReader);
});

describe('resolveBotSkillsEnabled', () => {
  it('a topic choice wins in both directions, else the default, ON when nothing is set', () => {
    const cases: Array<[boolean | undefined, boolean | undefined, boolean]> = [
      [undefined, undefined, true],
      [false, undefined, false],
      [true, undefined, true],
      [true, false, false],
      [false, true, true],
      [undefined, false, false],
    ];
    for (const [globalDefault, threadOverride, expected] of cases) {
      assert.equal(resolveBotSkillsEnabled(globalDefault, threadOverride), expected, `global=${globalDefault} override=${threadOverride}`);
    }
  });
});

describe('the reader over its layers: topic choice → General → settings.json → ON', () => {
  interface Layers {
    general?: boolean;
    topicChoices?: Map<string, boolean>;
    settings?: BotSkillsSetting | null;
  }

  function createReader(layers: Layers) {
    return createBotSkillsReader({
      getGeneralValue: () => layers.general,
      getTopicOverride: (key) => layers.topicChoices?.get(key.thread),
      getSettingsValue: () => layers.settings ?? null,
    });
  }

  it('nothing set anywhere is ON', () => {
    const read = createReader({});
    assert.equal(read(topic), true);
    assert.equal(read(null), true);
  });

  it('settings.json seeds the instance default for an instance whose General never chose', () => {
    assert.equal(createReader({ settings: 'off' })(topic), false);
    assert.equal(createReader({ settings: 'off' })(null), false);
    assert.equal(createReader({ settings: 'on' })(topic), true);
  });

  it('the General value wins over settings.json once set, in both directions — and the file is not even read', () => {
    assert.equal(createReader({ general: true, settings: 'off' })(topic), true);
    assert.equal(createReader({ general: false, settings: 'on' })(topic), false);
    assert.equal(createReader({ general: false, settings: 'on' })(null), false);
    let fileReads = 0;
    const read = createBotSkillsReader({
      getGeneralValue: () => false,
      getTopicOverride: () => undefined,
      getSettingsValue: () => {
        fileReads += 1;
        return 'on';
      },
    });
    assert.equal(read(topic), false);
    assert.equal(fileReads, 0, 'General chose: the file has nothing to add');
  });

  it('a topic choice wins over General and settings.json; another topic is not touched by it', () => {
    const read = createReader({ general: true, settings: 'on', topicChoices: new Map([[topic.thread, false]]) });
    assert.equal(read(topic), false);
    assert.equal(read(otherTopic), true);
    const readOn = createReader({ general: false, settings: 'off', topicChoices: new Map([[topic.thread, true]]) });
    assert.equal(readOn(topic), true);
    assert.equal(readOn(otherTopic), false);
  });

  it('a Jira conversation has no choice of its own: it follows the instance value (the settings seed on an instance without General)', () => {
    const jiraOnly = createReader({ settings: 'off', topicChoices: new Map([[topic.thread, true]]) });
    assert.equal(jiraOnly(jiraConversation), false);
    assert.equal(jiraOnly(null), false, 'the instance value is the same');
    assert.equal(createReader({ settings: 'on' })(jiraConversation), true);
  });

  it('the instance value (key null) ignores every topic choice', () => {
    const read = createReader({ general: true, topicChoices: new Map([[topic.thread, false]]) });
    assert.equal(read(null), true);
  });

  it('is read at every call: a change of a layer shows at once', () => {
    const layers: Layers = { general: true };
    const read = createReader(layers);
    assert.equal(read(topic), true);
    layers.general = false;
    assert.equal(read(topic), false);
    layers.general = undefined;
    layers.settings = 'off';
    assert.equal(read(topic), false);
  });
});

describe('the instance value and its source', () => {
  function read(general: boolean | undefined, settings: BotSkillsSetting | null) {
    return readBotSkillsInstanceValue({ getGeneralValue: () => general, getSettingsValue: () => settings });
  }

  it('names the layer that gave it: General\'s own choice, else the settings file, else the built-in default', () => {
    assert.deepEqual(read(false, 'on'), { isEnabled: false, source: 'general' });
    assert.deepEqual(read(true, 'off'), { isEnabled: true, source: 'general' });
    assert.deepEqual(read(undefined, 'off'), { isEnabled: false, source: 'settingsFile' });
    assert.deepEqual(read(undefined, 'on'), { isEnabled: true, source: 'settingsFile' });
    assert.deepEqual(read(undefined, null), { isEnabled: true, source: 'builtInDefault' });
  });
});

describe('the registered reader', () => {
  let configDir = '';
  let originalEnvFile: string | undefined;

  beforeEach(() => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charness-bot-skills-config-'));
    originalEnvFile = process.env.ENV_FILE;
    process.env.ENV_FILE = path.join(configDir, 'instance.env');
    resetInstanceSettingsCache();
  });

  afterEach(() => {
    if (originalEnvFile === undefined) delete process.env.ENV_FILE;
    else process.env.ENV_FILE = originalEnvFile;
    resetInstanceSettingsCache();
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  it('before the bot registers its own, settings.json decides — a start that comes first (the hot supervisor\'s OpenCode pre-start) follows the file', () => {
    assert.equal(checkIsBotSkillsEnabled(null), true, 'no file: ON');
    fs.writeFileSync(path.join(configDir, 'settings.json'), '{ "botSkills": "off" }\n');
    assert.equal(checkIsBotSkillsEnabled(null), false, 'the seed off');
    assert.equal(checkIsBotSkillsEnabled(topic), false, 'a conversation follows the instance value too');
    fs.writeFileSync(path.join(configDir, 'settings.json'), '{ "botSkills": "on" }\n');
    assert.equal(checkIsBotSkillsEnabled(null), true, 'a hand edit applies without a restart');
  });

  it('is replaced by the one the bot registers, which answers for every caller', () => {
    fs.writeFileSync(path.join(configDir, 'settings.json'), '{ "botSkills": "off" }\n');
    assert.equal(checkIsBotSkillsEnabled(topic), false);
    setBotSkillsReader((key) => key !== null && key.thread !== topic.thread);
    assert.equal(checkIsBotSkillsEnabled(topic), false);
    assert.equal(checkIsBotSkillsEnabled(otherTopic), true);
    assert.equal(checkIsBotSkillsEnabled(null), false);
  });
});

describe('the state pair', () => {
  let dataDir = '';
  let store: StateStore;

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charness-bot-skills-'));
    store = new StateStore(dataDir, { saveDebounceMs: 5 });
    await store.init();
  });

  afterEach(async () => {
    await store.flush();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('General has no value until it chooses — «never chose» is not ON, so settings.json can still decide', async () => {
    assert.equal(store.getBotSkillsGlobalValue(), undefined);
    await store.setBotSkillsGlobalValue(false);
    assert.equal(store.getBotSkillsGlobalValue(), false, 'an explicit OFF is kept, not read as unset');
    await store.setBotSkillsGlobalValue(true);
    assert.equal(store.getBotSkillsGlobalValue(), true);
  });

  it('a topic choice is stored per topic, dropped with null (follow General again), and an emptied map leaves no field', async () => {
    await store.setBotSkillsOverride(topic, false);
    await store.setBotSkillsOverride(otherTopic, true);
    assert.equal(store.getBotSkillsOverride(topic), false);
    assert.equal(store.getBotSkillsOverride(otherTopic), true);
    await store.setBotSkillsOverride(topic, null);
    assert.equal(store.getBotSkillsOverride(topic), undefined);
    assert.equal(store.getBotSkillsOverride(otherTopic), true, 'the other topic keeps its choice');
    await store.setBotSkillsOverride(otherTopic, null);
    await store.flush();
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8')) as Record<string, unknown>;
    assert.equal('botSkillsOverrides' in raw, false);
  });

  it('survives a reload, and feeds the reader the way the bot wires it', async () => {
    await store.setBotSkillsGlobalValue(false);
    await store.setBotSkillsOverride(topic, true);
    await store.flush();
    const reloaded = new StateStore(dataDir, { saveDebounceMs: 5 });
    await reloaded.init();
    const read = createBotSkillsReader({
      getGeneralValue: () => reloaded.getBotSkillsGlobalValue(),
      getTopicOverride: (key) => reloaded.getBotSkillsOverride(key),
      getSettingsValue: () => 'on',
    });
    assert.equal(read(topic), true, 'the topic\'s own choice');
    assert.equal(read(otherTopic), false, 'General\'s OFF over the file\'s on');
    assert.equal(read(null), false);
  });
});
