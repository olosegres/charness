/**
 * @description `/topic_status` through the REAL module (`connectors/telegram/commands/topicStatus.ts`) on a real telegraf instance
 * (`commandModuleHarness.ts`), the real state store and a real `settings.json` in a temp folder:
 *
 *   • a topic's screen shows the set in force and where it comes from; General's is the instance default and lists the topics whose name
 *     the bot does not know;
 *   • a tap in a topic copies the set it followed into the topic first and flips the one switch; «As General» drops it; «All off» turns
 *     everything off; in General only the switches that differ from the defaults reach `settings.json`;
 *   • every change tells the bot which topic (or all) to look at again; the picker re-renders in place with a toast;
 *   • «Yes, that's its name» makes the candidate the topic's own name (from a topic or from General's list) and a stale one changes nothing;
 *   • the owner's own mark that was dropped is told once; a refused tap and a file that cannot be written change nothing.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createTopicStatus } from '../connectors/telegram/commands/topicStatus';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import { createTopicStatusSettingsReader } from '../instanceSettings';
import type { SessionKey } from '../sessionKey';
import { defaultTopicStatusPrefs } from '../utils/topicIndicatorPlan';
import type { TopicIndicatorHealth } from '../connectors/telegram/topicIndicator';
import { createCommandHarness, harnessGroup, type CommandHarness } from './commandModuleHarness';

const pickerMessageId = 4321;
const otherThreadId = 222;
const otherTopicKey: SessionKey = makeTelegramKey(harnessGroup.id, otherThreadId);

let harness: CommandHarness;
let settingsDir = '';
let settingsPath = '';
/** What the module told the bot to look at again, in order (`null`: every topic). */
let looks: Array<SessionKey | null> = [];
let health: TopicIndicatorHealth = { isRenameRefused: false, isLineDeletionRefused: false };

function readSettingsFile(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
}

function getSentScreen(): { text: string; labels: string[][]; data: string[][] } {
  const sent = harness.replies.at(-1);
  assert.ok(sent, 'the module sent a screen');
  return { text: sent.text, labels: harness.getKeyboardLabels(sent), data: harness.getKeyboardData(sent) };
}

function getEditedScreen(): { text: string; labels: string[][]; data: string[][] } {
  const edited = harness.edits.at(-1);
  assert.ok(edited, 'the module re-rendered the picker');
  return { text: edited.text, labels: harness.getKeyboardLabels(edited), data: harness.getKeyboardData(edited) };
}

const getLastToast = (): string | undefined => harness.fakeTelegram.callbackAnswers.at(-1);

describe('/topic_status, through the module', () => {
  before(async () => {
    harness = await createCommandHarness();
    settingsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'topic-status-'));
    settingsPath = path.join(settingsDir, 'settings.json');
    const readInstanceTopicStatus = createTopicStatusSettingsReader(() => settingsPath, () => {});
    const topicStatus = createTopicStatus({
      ...harness.core,
      readInstanceTopicStatus,
      getSettingsPath: () => settingsPath,
      getHealth: () => health,
      noteTopicStatusChanged: (key) => { looks.push(key); },
    });
    topicStatus.registerTopicStatusCommands();
    topicStatus.registerTopicStatusCallbacks();
  });

  after(async () => {
    await harness.stop();
    fs.rmSync(settingsDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    looks = [];
    health = { isRenameRefused: false, isLineDeletionRefused: false };
    harness.replies.length = 0;
    harness.edits.length = 0;
    harness.fakeTelegram.callbackAnswers.length = 0;
    harness.isGeneral = false;
    harness.isAuthorised = true;
    fs.rmSync(settingsPath, { force: true });
    await harness.state.setTopicStatusOverride(harness.key, null);
    await harness.state.setBinding(harness.key, 'alpha', { topicName: 'Deploy' });
    await harness.state.setBindingTopicNaming(harness.key, { topicNameCandidate: null, indicatorDroppedMark: null });
    await harness.state.removeBinding(otherTopicKey);
  });

  describe('the screen', () => {
    it('in a topic that follows General: the set in force with its marks, where it comes from, and no hint', async () => {
      await harness.runCommand('topic_status');
      const screen = getSentScreen();
      assert.ok(screen.text.startsWith('Topic status in the topic list — this topic: as in General'), screen.text);
      assert.deepEqual(screen.labels.at(-1), ['All off', 'As General ✓']);
      assert.deepEqual(screen.data[0], ['tst_question_0', 'tst_stuck_0']);
      assert.ok(!screen.text.includes('⚠️') && !screen.text.includes('ℹ️'), screen.text);
    });

    it('the set General holds in settings.json shows in a topic that follows it', async () => {
      fs.writeFileSync(settingsPath, JSON.stringify({ topicStatus: { asleep: false, queued: true } }));
      await harness.runCommand('topic_status');
      const screen = getSentScreen();
      assert.ok(screen.labels.flat().includes('💤 Asleep'), 'off: no ✓');
      assert.ok(screen.labels.flat().includes('✓ 📋 Tasks queued'), 'on: ✓');
    });

    it('a topic whose name is not known offers its candidate; one with no candidate asks for a rename', async () => {
      await harness.state.setBinding(otherTopicKey, 'beta');
      harness.isGeneral = false;
      await harness.state.setBindingTopicNaming(harness.key, { topicName: 'Deploy' });
      await harness.state.setBindingTopicNaming(otherTopicKey, { topicNameCandidate: 'Created as' });
      // The harness runs the command as `harness.key`; a topic with an unknown name is another binding, shown through its own key.
      await harness.state.removeBinding(harness.key);
      await harness.state.setBinding(harness.key, 'alpha');
      await harness.runCommand('topic_status');
      assert.ok(getSentScreen().text.includes('rename it once (any change) and the marks appear'));
      await harness.state.setBindingTopicNaming(harness.key, { topicNameCandidate: 'Deploy' });
      await harness.runCommand('topic_status');
      const withCandidate = getSentScreen();
      assert.ok(withCandidate.text.includes('Is it «Deploy»?'));
      assert.deepEqual(withCandidate.data.at(-1), [`tsn_${harness.key.thread}`]);
    });

    it('the hints for the right, a long name and the «renamed» lines show when they hold', async () => {
      health = { isRenameRefused: true, isLineDeletionRefused: true };
      await harness.state.setBindingTopicNaming(harness.key, { topicName: 'A very long name of a topic indeed' });
      await harness.runCommand('topic_status');
      const screen = getSentScreen();
      assert.ok(screen.text.includes('Needs the «Manage topics» admin right.'));
      assert.ok(screen.text.includes('This name is long'));
      assert.ok(screen.text.includes('each change leaves a «renamed» line'));
    });

    it('a mark of the owner\'s own that was dropped is told ONCE, then forgotten', async () => {
      await harness.state.setBindingTopicNaming(harness.key, { indicatorDroppedMark: '✅' });
      await harness.runCommand('topic_status');
      assert.ok(getSentScreen().text.includes('«✅» at the end of your name reads as my mark'));
      assert.equal(harness.state.getBinding(harness.key)?.indicatorDroppedMark, undefined);
      await harness.runCommand('topic_status');
      assert.ok(!getSentScreen().text.includes('at the end of your name'));
    });

    it('in General: the default of all topics, no «As General», and the topics whose name the bot does not know', async () => {
      harness.isGeneral = true;
      await harness.state.setBinding(otherTopicKey, 'beta');
      await harness.state.setBindingTopicNaming(otherTopicKey, { topicNameCandidate: 'Research' });
      await harness.state.setBindingTopicNaming(harness.key, { topicName: 'Deploy' });
      await harness.runCommand('topic_status');
      const screen = getSentScreen();
      assert.ok(screen.text.startsWith('Topic status in the topic list — the default of ALL topics'), screen.text);
      assert.ok(screen.text.includes('Names I don\'t know yet'));
      assert.deepEqual(screen.labels.at(-1), ['✓ «Research»']);
      assert.deepEqual(screen.data.at(-1), [`tsn_${otherThreadId}`]);
      assert.ok(!screen.labels.flat().some((label) => label.startsWith('As General')));
    });
  });

  describe('a tap in a topic', () => {
    it('copies the set the topic followed into it, flips the one switch, tells the bot to look at THAT topic, toasts and re-renders in place', async () => {
      fs.writeFileSync(settingsPath, JSON.stringify({ topicStatus: { queued: true } }));
      await harness.tapButton(pickerMessageId, 'tst_asleep_0');
      assert.deepEqual(harness.state.getTopicStatusOverride(harness.key), { ...defaultTopicStatusPrefs, queued: true, asleep: false }, 'General\'s set was copied, then the one switch flipped');
      assert.deepEqual(looks, [harness.key]);
      assert.equal(getLastToast(), '✅ Saved');
      const screen = getEditedScreen();
      assert.equal(harness.edits.at(-1)?.messageId, pickerMessageId, 're-rendered in place');
      assert.ok(screen.text.includes('this topic: its own set'));
      assert.deepEqual(screen.labels.at(-1), ['All off', 'As General']);
    });

    it('a later change of General does not reach a topic that has its own set', async () => {
      await harness.tapButton(pickerMessageId, 'tst_working_0');
      fs.writeFileSync(settingsPath, JSON.stringify({ topicStatus: { agents: true } }));
      await harness.runCommand('topic_status');
      assert.ok(getSentScreen().labels.flat().includes('⚙️ Agents at work'), 'the topic\'s own set keeps agents off');
    });

    it('«As General» drops the topic\'s own set', async () => {
      await harness.state.setTopicStatusOverride(harness.key, { ...defaultTopicStatusPrefs, working: false });
      await harness.tapButton(pickerMessageId, 'tst_same');
      assert.equal(harness.state.getTopicStatusOverride(harness.key), undefined);
      assert.deepEqual(looks, [harness.key]);
      assert.deepEqual(getEditedScreen().labels.at(-1), ['All off', 'As General ✓']);
    });

    it('«All off» turns every mark and count off in the topic', async () => {
      await harness.tapButton(pickerMessageId, 'tst_off');
      const own = harness.state.getTopicStatusOverride(harness.key);
      assert.ok(own && Object.values(own).every((isOn) => isOn === false));
    });

    it('a stale keyboard applies what its button says: the switch is set to the value on it', async () => {
      await harness.state.setTopicStatusOverride(harness.key, { ...defaultTopicStatusPrefs, asleep: false });
      await harness.tapButton(pickerMessageId, 'tst_asleep_0');
      assert.equal(harness.state.getTopicStatusOverride(harness.key)?.asleep, false);
    });

    it('data that is none of ours is answered as out of date and changes nothing', async () => {
      await harness.tapButton(pickerMessageId, 'tst_flashing_1');
      assert.equal(harness.state.getTopicStatusOverride(harness.key), undefined);
      assert.equal(getLastToast(), 'This is out of date — open the screen again.');
      assert.deepEqual(looks, []);
    });

    it('a tap that is refused (not an admin) changes nothing', async () => {
      harness.isAuthorised = false;
      await harness.tapButton(pickerMessageId, 'tst_asleep_0');
      assert.equal(harness.state.getTopicStatusOverride(harness.key), undefined);
      assert.deepEqual(looks, []);
      assert.equal(harness.edits.length, 0);
    });
  });

  describe('a tap in General', () => {
    it('writes only the switches that differ from the defaults to settings.json and tells the bot every topic changed', async () => {
      harness.isGeneral = true;
      await harness.tapButton(pickerMessageId, 'tst_queued_1');
      assert.deepEqual(readSettingsFile(), { topicStatus: { queued: true } });
      assert.deepEqual(looks, [null]);
      await harness.tapButton(pickerMessageId, 'tst_asleep_0');
      assert.deepEqual(readSettingsFile(), { topicStatus: { asleep: false, queued: true } });
      await harness.tapButton(pickerMessageId, 'tst_queued_0');
      assert.deepEqual(readSettingsFile(), { topicStatus: { asleep: false } });
      await harness.tapButton(pickerMessageId, 'tst_asleep_1');
      assert.equal('topicStatus' in readSettingsFile(), false, 'back to the defaults leaves no field');
    });

    it('«All off» switches all five marks off for every topic', async () => {
      harness.isGeneral = true;
      await harness.tapButton(pickerMessageId, 'tst_off');
      assert.deepEqual(readSettingsFile(), { topicStatus: { question: false, stuck: false, working: false, finished: false, asleep: false } });
    });

    it('a settings.json that cannot be written says so and changes nothing', async () => {
      harness.isGeneral = true;
      // A path below a regular file can never be a directory: the write fails, whoever runs the test.
      const regularFile = path.join(settingsDir, 'a-file');
      fs.writeFileSync(regularFile, 'x');
      const blocked = path.join(regularFile, 'settings.json');
      const original = settingsPath;
      settingsPath = blocked;
      try {
        await harness.tapButton(pickerMessageId, 'tst_queued_1');
        assert.deepEqual(looks, []);
        assert.match(getLastToast() ?? '', /The setting could not be saved: .*cannot be written \((ENOTDIR|EEXIST)\)/);
        assert.equal(harness.edits.length, 0);
      } finally {
        settingsPath = original;
      }
    });
  });

  describe('«Yes, that\'s its name»', () => {
    it('from the topic: the candidate becomes its own name, the topic shows it now, and the bot looks at the topic at once', async () => {
      await harness.state.removeBinding(harness.key);
      await harness.state.setBinding(harness.key, 'alpha');
      await harness.state.setBindingTopicNaming(harness.key, { topicNameCandidate: 'Deploy' });
      await harness.tapButton(pickerMessageId, `tsn_${harness.key.thread}`);
      const binding = harness.state.getBinding(harness.key);
      assert.equal(binding?.topicName, 'Deploy');
      assert.equal(binding?.indicatorAppliedName, 'Deploy');
      assert.equal(binding?.topicNameCandidate, undefined);
      assert.deepEqual(looks, [harness.key]);
      assert.equal(getLastToast(), '✅ Saved');
    });

    it('from General: confirms ANOTHER topic of the chat by its thread id, and the list loses it', async () => {
      harness.isGeneral = true;
      await harness.state.setBinding(otherTopicKey, 'beta');
      await harness.state.setBindingTopicNaming(otherTopicKey, { topicNameCandidate: 'Research' });
      await harness.tapButton(pickerMessageId, `tsn_${otherThreadId}`);
      assert.equal(harness.state.getBinding(otherTopicKey)?.topicName, 'Research');
      assert.deepEqual(looks, [otherTopicKey]);
      assert.ok(!getEditedScreen().text.includes('Names I don\'t know yet'));
    });

    it('a stale button changes nothing: the topic is gone, already named, or has no candidate any more', async () => {
      await harness.tapButton(pickerMessageId, 'tsn_999999');
      assert.equal(getLastToast(), 'This is out of date — open the screen again.');
      await harness.state.setBinding(otherTopicKey, 'beta', { topicName: 'Known' });
      await harness.state.setBindingTopicNaming(otherTopicKey, { topicNameCandidate: 'Other guess' });
      await harness.tapButton(pickerMessageId, `tsn_${otherThreadId}`);
      assert.equal(harness.state.getBinding(otherTopicKey)?.topicName, 'Known', 'a name the bot already knows is never replaced by a guess');
      assert.deepEqual(looks, []);
    });
  });
});
