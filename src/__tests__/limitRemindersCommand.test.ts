/**
 * `/limits_reminders` through the REAL module (`connectors/telegram/commands/limitReminders.ts`) on a real telegraf instance
 * (`commandModuleHarness.ts`) and the real state store, with a real `settings.json` in a temp folder:
 *
 *   • the command and its hidden alias, the one button pattern;
 *   • the screen: General's marks the value in force; a topic's names where it comes from — «as General» with General's value, or its
 *     own — with ✓ on «As General» or on its own choice;
 *   • a ONE-SHOT picker: a tap writes what the button names (a topic: its own choice, `general` drops it; General: `settings.json`
 *     `limitReminders.everyMinutes`) and edits the picker into the confirmation, the keyboard gone;
 *   • a keyboard that has gone stale still means what it says; a settings file that cannot be written says so and changes nothing; a
 *     refused tap changes nothing;
 *   • what the `/limits` board's row asks for: the opener and the label (the value in force).
 *
 * The value the screens show is the one the notes read (`resolveLimitRemindersMinutes`, over the same settings reader).
 *
 * One check, one level: what the built bot shows an operator — General's first screen, a topic's own choice and its confirmation, Off
 * written as 0, a topic's choice beating General's both ways, «As General», the board's row, a Russian chat — is
 * `limitRemindersE2e.test.ts`'s. This file keeps what a flow cannot reach cheaply: the settings file beside other fields, a file that
 * cannot be written, a refused tap, a hand-made callback, a stale keyboard, «As General» in General, the row label's cases.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createLimitReminders } from '../connectors/telegram/commands/limitReminders';
import { createLimitRemindersSettingsReader, loadInstanceSettings } from '../instanceSettings';
import { resolveLimitRemindersMinutes } from '../limitNotes/reminderChoices';
import { enDict } from '../i18n/en';
import { createCommandHarness, type CommandHarness } from './commandModuleHarness';

const pickerMessageId = 4321;
const noButtons: string[][] = [];

let harness: CommandHarness;
let settingsDir = '';
let settingsPath = '';
let limitReminders: ReturnType<typeof createLimitReminders>;
let readSettingsValue: ReturnType<typeof createLimitRemindersSettingsReader>;

function readSettingsFile(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
}

/** A screen the module put out — a send (`/limits_reminders`) or an edit (a tap) — its text, button labels and button data. */
function readScreen(sent: ReturnType<CommandHarness['replies']['at']>): { text: string; labels: string[][]; data: string[][] } {
  assert.ok(sent, 'the module put a screen out');
  return { text: sent.text, labels: harness.getKeyboardLabels(sent), data: harness.getKeyboardData(sent) };
}

const getSentScreen = (): ReturnType<typeof readScreen> => readScreen(harness.replies.at(-1));
const getEditedScreen = (): ReturnType<typeof readScreen> => readScreen(harness.edits.at(-1));
const getLastToast = (): string | undefined => harness.fakeTelegram.callbackAnswers.at(-1);

/** The interval the notes would run under for the harness topic — the real resolver over the real settings reader and the topic's stored choice. */
function getEffectiveMinutes(): number | null {
  return resolveLimitRemindersMinutes(readSettingsValue(), harness.state.getLimitRemindersOverride(harness.key));
}

describe('/limits_reminders, through the module', () => {
  before(async () => {
    harness = await createCommandHarness();
    settingsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'limit-reminders-'));
    settingsPath = path.join(settingsDir, 'settings.json');
    readSettingsValue = createLimitRemindersSettingsReader(() => settingsPath, () => {});
    limitReminders = createLimitReminders({ ...harness.core, readInstanceLimitReminders: readSettingsValue, getSettingsPath: () => settingsPath });
    limitReminders.registerLimitRemindersCommands();
    limitReminders.registerLimitRemindersCallbacks();
  });

  after(async () => {
    await harness.stop();
    fs.rmSync(settingsDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    harness.replies.length = 0;
    harness.edits.length = 0;
    harness.fakeTelegram.callbackAnswers.length = 0;
    harness.isGeneral = false;
    harness.isAuthorised = true;
    fs.rmSync(settingsPath, { force: true });
    await harness.state.setLimitRemindersOverride(harness.key, null);
  });

  it('registers the command with its hidden alias and ONE button pattern covering every button — and nothing else', () => {
    assert.deepEqual(harness.registeredCommandNames, ['limits_reminders', 'limit_reminders']);
    assert.equal(harness.registeredActionPatterns.length, 1);
    assert.equal(harness.registeredActionPatterns[0], String(/^lrm_(g|0|60|120|240)$/));
  });

  describe('the screen', () => {
    it('in General with a chosen value: no «(default)», ✓ on that value; Off is marked on Off', async () => {
      fs.writeFileSync(settingsPath, JSON.stringify({ limitReminders: { everyMinutes: 240 } }));
      harness.isGeneral = true;
      await harness.runCommand('limits_reminders');
      assert.ok(getSentScreen().text.endsWith('Now: every 4 h'), getSentScreen().text);
      assert.deepEqual(getSentScreen().labels, [['1 h', '2 h', '4 h ✓', 'Off']]);

      fs.writeFileSync(settingsPath, JSON.stringify({ limitReminders: { everyMinutes: 0 } }));
      await harness.runCommand('limits_reminders');
      assert.ok(getSentScreen().text.endsWith('Now: off'), getSentScreen().text);
      assert.deepEqual(getSentScreen().labels, [['1 h', '2 h', '4 h', 'Off ✓']]);
    });

    it('in a topic that follows General: «as General (every 1 h)», ✓ on «As General», no interval marked; the alias opens the same screen', async () => {
      await harness.runCommand('limit_reminders');

      const screen = getSentScreen();
      assert.equal(screen.text, ['🔔 Limit reminders to agents — this topic', enDict['limitReminders.explanationText'], 'Now: as General (every 1 h)'].join('\n\n'));
      assert.deepEqual(screen.labels, [['As General ✓'], ['1 h', '2 h', '4 h', 'Off']]);
      assert.deepEqual(screen.data, [['lrm_g'], ['lrm_60', 'lrm_120', 'lrm_240', 'lrm_0']]);
    });

    it('a topic that follows General names General\'s value from settings.json — Off included', async () => {
      fs.writeFileSync(settingsPath, JSON.stringify({ limitReminders: { everyMinutes: 0 } }));
      await harness.runCommand('limits_reminders');
      assert.ok(getSentScreen().text.endsWith('Now: as General (off)'), getSentScreen().text);
    });

    it('in a topic with a choice of its own: that choice is named and marked, «As General» is not', async () => {
      await harness.state.setLimitRemindersOverride(harness.key, 120);
      await harness.runCommand('limits_reminders');

      const screen = getSentScreen();
      assert.ok(screen.text.endsWith('Now: every 2 h'), screen.text);
      assert.deepEqual(screen.labels, [['As General'], ['1 h', '2 h ✓', '4 h', 'Off']]);
    });
  });

  describe('a tap — the picker is consumed', () => {
    it('«Off» in a topic is its own choice (stored as 0) and reads «off»', async () => {
      await harness.tapButton(pickerMessageId, 'lrm_0');

      assert.equal(harness.state.getLimitRemindersOverride(harness.key), 0);
      assert.equal(getEditedScreen().text, '🔔 Limit reminders: off (this topic).');
      assert.equal(getEffectiveMinutes(), null, 'the notes read it as Off');
    });

    it('in General: the value is written to settings.json beside the other fields and the picker says «… (all topics without their own choice).»', async () => {
      fs.writeFileSync(settingsPath, JSON.stringify({ autoUpdate: 'off' }));
      harness.isGeneral = true;
      await harness.tapButton(pickerMessageId, 'lrm_240');

      assert.deepEqual(readSettingsFile(), { autoUpdate: 'off', limitReminders: { everyMinutes: 240 } });
      assert.equal(getEditedScreen().text, '🔔 Limit reminders: every 4 h (all topics without their own choice).');
      assert.deepEqual(getEditedScreen().labels, noButtons);
      assert.equal(harness.state.getLimitRemindersOverride(harness.key), undefined, 'General\'s choice is no topic\'s own');
      const load = loadInstanceSettings(settingsPath);
      assert.equal(load.status, 'ok', 'the file stays valid');
    });

    it('«As General» tapped in General changes nothing and writes no file', async () => {
      harness.isGeneral = true;
      await harness.tapButton(pickerMessageId, 'lrm_g');

      assert.equal(fs.existsSync(settingsPath), false);
      assert.deepEqual(getEditedScreen().labels, noButtons);
    });

    it('a keyboard that has gone stale still means what its button says: the named choice is applied, whatever is stored now', async () => {
      await harness.state.setLimitRemindersOverride(harness.key, 240);
      await harness.tapButton(pickerMessageId, 'lrm_60');
      assert.equal(harness.state.getLimitRemindersOverride(harness.key), 60);
      await harness.tapButton(pickerMessageId, 'lrm_60');
      assert.equal(harness.state.getLimitRemindersOverride(harness.key), 60, 'idempotent');
      assert.equal(getEditedScreen().text, '🔔 Limit reminders: every 1 h (this topic).');
    });

    it('General\'s settings file that cannot be written: the toast says so, nothing changes and the picker is left as it was', async () => {
      // A directory where the file should be: the atomic rename over it fails.
      fs.mkdirSync(settingsPath);
      try {
        harness.isGeneral = true;
        await harness.tapButton(pickerMessageId, 'lrm_120');

        assert.match(getLastToast() ?? '', /could not be saved/);
        assert.deepEqual(harness.edits, [], 'the picker keeps its buttons: the tap can be repeated');
      } finally {
        fs.rmSync(settingsPath, { recursive: true, force: true });
      }
    });

    it('a refused tap (not an admin) changes nothing', async () => {
      harness.isAuthorised = false;
      await harness.tapButton(pickerMessageId, 'lrm_120');

      assert.equal(getLastToast(), enDict['cb.access_denied']);
      assert.equal(harness.state.getLimitRemindersOverride(harness.key), undefined);
      assert.deepEqual(harness.edits, []);
    });

    it('a button that is none of the picker\'s (a hand-made callback) is never matched', async () => {
      await harness.tapButton(pickerMessageId, 'lrm_90');
      await harness.tapButton(pickerMessageId, 'lrm_');
      assert.equal(harness.state.getLimitRemindersOverride(harness.key), undefined);
      assert.deepEqual(harness.edits, []);
    });
  });

  describe('what the /limits board\'s row asks for', () => {
    it('the label is the value in force for the topic: its own, General\'s, the default, Off', async () => {
      assert.equal(limitReminders.getRowLabel(harness.key), '🔔 Reminders: every 1 h');
      fs.writeFileSync(settingsPath, JSON.stringify({ limitReminders: { everyMinutes: 240 } }));
      assert.equal(limitReminders.getRowLabel(harness.key), '🔔 Reminders: every 4 h', 'General\'s, for a topic that follows it');
      await harness.state.setLimitRemindersOverride(harness.key, 0);
      assert.equal(limitReminders.getRowLabel(harness.key), '🔔 Reminders: off', 'its own beats General\'s');
      await harness.state.setLimitRemindersOverride(harness.key, 120);
      assert.equal(limitReminders.getRowLabel(harness.key), '🔔 Reminders: every 2 h');
    });

    it('in General the label is the instance value', () => {
      harness.isGeneral = true;
      assert.equal(limitReminders.getRowLabel(harness.key), '🔔 Reminders: every 1 h');
      fs.writeFileSync(settingsPath, JSON.stringify({ limitReminders: { everyMinutes: 0 } }));
      assert.equal(limitReminders.getRowLabel(harness.key), '🔔 Reminders: off');
    });

    it('the opener posts the very picker the command does, as a new message of its own', async () => {
      await harness.runCommand('limits_reminders');
      const fromCommand = getSentScreen();
      harness.replies.length = 0;
      await limitReminders.openPicker(harness.key);
      assert.equal(harness.replies.length, 1);
      assert.deepEqual(getSentScreen(), fromCommand);
    });
  });
});
