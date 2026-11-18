/**
 * @description `/question_wait` through the REAL module (`connectors/telegram/commands/questionWait.ts`) on a real telegraf instance
 * (`commandModuleHarness.ts`) and the real state store, with a real `settings.json` in a temp folder:
 *
 *   • a topic's screen names the value in force and where it comes from, with ✓ on the topic's own choice — or on «as in General»
 *     (with General's value) when it has none; General's screen has no «as in General» and is the instance default;
 *   • a tap writes what the button names (a topic: its own choice, `null` drops it; General: `settings.json` `questionWait`), tells the
 *     bot the wait changed (so the questions that wait now are timed again), answers with the value in force and re-renders the picker;
 *   • a keyboard that has gone stale still means what it says; General's file that cannot be written says so and changes nothing;
 *     a refused tap changes nothing.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createQuestionWait } from '../connectors/telegram/commands/questionWait';
import { createQuestionWaitSettingsReader, loadInstanceSettings } from '../instanceSettings';
import type { SessionKey } from '../sessionKey';
import { enDict } from '../i18n/en';
import { createCommandHarness, type CommandHarness } from './commandModuleHarness';

const pickerMessageId = 4321;

let harness: CommandHarness;
let settingsDir = '';
let settingsPath = '';
/** What the module told the bot about changed waits, in order (`null`: the instance value). */
let changedWaits: Array<SessionKey | null> = [];

function readSettingsFile(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
}

/** A screen the module put out — a send (`/question_wait`) or an edit (a tap re-renders the picker) — its text, button labels and button data. */
function readScreen(sent: ReturnType<CommandHarness['replies']['at']>): { text: string; labels: string[][]; data: string[][] } {
  assert.ok(sent, 'the module put a screen out');
  return { text: sent.text, labels: harness.getKeyboardLabels(sent), data: harness.getKeyboardData(sent) };
}

/** The screen `/question_wait` sent last. */
const getSentScreen = (): ReturnType<typeof readScreen> => readScreen(harness.replies.at(-1));
/** The screen a tap re-rendered the picker into last. */
const getEditedScreen = (): ReturnType<typeof readScreen> => readScreen(harness.edits.at(-1));

function getLastToast(): string | undefined {
  return harness.fakeTelegram.callbackAnswers.at(-1);
}

describe('/question_wait, through the module', () => {
  before(async () => {
    harness = await createCommandHarness();
    settingsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'question-wait-'));
    settingsPath = path.join(settingsDir, 'settings.json');
    const readInstanceQuestionWait = createQuestionWaitSettingsReader(() => settingsPath, () => {});
    const questionWait = createQuestionWait({
      ...harness.core,
      readInstanceQuestionWait,
      getSettingsPath: () => settingsPath,
      noteQuestionWaitChanged: (key) => { changedWaits.push(key); },
    });
    questionWait.registerQuestionWaitCommands();
    questionWait.registerQuestionWaitCallbacks();
  });

  after(async () => {
    await harness.stop();
    fs.rmSync(settingsDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    changedWaits = [];
    harness.replies.length = 0;
    harness.edits.length = 0;
    harness.fakeTelegram.callbackAnswers.length = 0;
    harness.isGeneral = false;
    harness.isAuthorised = true;
    fs.rmSync(settingsPath, { force: true });
    await harness.state.setQuestionWaitOverride(harness.key, null);
  });

  describe('the screen', () => {
    it('in a topic: the value in force and where it comes from, the waits as buttons, and «as in General» (with General\'s value) marked when the topic has no choice', async () => {
      await harness.runCommand('question_wait');

      const screen = getSentScreen();
      assert.ok(screen.text.startsWith('⏳ How long the agent waits for your answer to its question before it goes on without it — this topic: as in General — 30 min'), screen.text);
      assert.ok(screen.text.includes(enDict['questionWait.explanationText']));
      assert.ok(!screen.text.includes(enDict['questionWait.generalScopeNote']), 'the scope note is General\'s');
      assert.deepEqual(screen.data, [['qw_dontWait', 'qw_tenMinutes', 'qw_thirtyMinutes', 'qw_oneHour'], ['qw_untilAnswered'], ['qw_same']]);
      assert.deepEqual(screen.labels, [["Don't wait", '10 min', '30 min', '1 h'], ['Wait for my answer'], ['As in General (30 min) ✓']]);
    });

    it('in a topic with a choice of its own: that choice is named and marked, «as in General» is not', async () => {
      await harness.state.setQuestionWaitOverride(harness.key, 'tenMinutes');
      await harness.runCommand('question_wait');

      const screen = getSentScreen();
      assert.ok(screen.text.includes('— this topic: 10 min'), screen.text);
      assert.deepEqual(screen.labels, [["Don't wait", '10 min ✓', '30 min', '1 h'], ['Wait for my answer'], ['As in General (30 min)']]);
    });

    it('a topic that follows General names General\'s value: from settings.json, not the built-in default', async () => {
      fs.writeFileSync(settingsPath, JSON.stringify({ questionWait: 'oneHour' }));
      await harness.runCommand('question_wait');

      const screen = getSentScreen();
      assert.ok(screen.text.includes('as in General — 1 h'), screen.text);
      assert.deepEqual(screen.labels.at(-1), ['As in General (1 h) ✓']);
    });

    it('in General: the instance default, ✓ on the value in force, no «as in General», and the note that every topic without a choice follows it', async () => {
      harness.isGeneral = true;
      await harness.runCommand('question_wait');

      const screen = getSentScreen();
      assert.ok(screen.text.startsWith('⏳ How long an agent waits for your answer to its question before it goes on without it — the default of ALL topics: 30 min'), screen.text);
      assert.ok(screen.text.endsWith(enDict['questionWait.generalScopeNote']));
      assert.deepEqual(screen.data, [['qw_dontWait', 'qw_tenMinutes', 'qw_thirtyMinutes', 'qw_oneHour'], ['qw_untilAnswered']]);
      assert.deepEqual(screen.labels, [["Don't wait", '10 min', '30 min ✓', '1 h'], ['Wait for my answer']]);
    });
  });

  describe('a tap', () => {
    it('in a topic: its own choice is stored, the bot is told THAT topic\'s wait changed, the toast names the value, and the picker follows', async () => {
      await harness.tapButton(pickerMessageId, 'qw_oneHour');

      assert.equal(harness.state.getQuestionWaitOverride(harness.key), 'oneHour');
      assert.deepEqual(changedWaits, [harness.key]);
      assert.equal(getLastToast(), '✅ 1 h');
      const screen = getEditedScreen();
      assert.equal(harness.edits.at(-1)?.messageId, pickerMessageId, 're-rendered in place');
      assert.deepEqual(screen.labels, [["Don't wait", '10 min', '30 min', '1 h ✓'], ['Wait for my answer'], ['As in General (30 min)']]);
      assert.ok(screen.text.includes('— this topic: 1 h'));
    });

    it('«as in General» drops the topic\'s choice, and the toast says what it follows now', async () => {
      await harness.state.setQuestionWaitOverride(harness.key, 'dontWait');
      await harness.tapButton(pickerMessageId, 'qw_same');

      assert.equal(harness.state.getQuestionWaitOverride(harness.key), undefined);
      assert.deepEqual(changedWaits, [harness.key]);
      assert.equal(getLastToast(), '✅ as in General — 30 min');
      assert.deepEqual(getEditedScreen().labels.at(-1), ['As in General (30 min) ✓']);
    });

    it('«Wait for my answer» and «Don\'t wait» are choices like the others', async () => {
      await harness.tapButton(pickerMessageId, 'qw_untilAnswered');
      assert.equal(harness.state.getQuestionWaitOverride(harness.key), 'untilAnswered');
      await harness.tapButton(pickerMessageId, 'qw_dontWait');
      assert.equal(harness.state.getQuestionWaitOverride(harness.key), 'dontWait');
      assert.equal(getLastToast(), "✅ Don't wait");
    });

    it('a keyboard that has gone stale still means what its button says: the named choice is applied and the picker shows the truth', async () => {
      await harness.state.setQuestionWaitOverride(harness.key, 'oneHour');
      await harness.tapButton(pickerMessageId, 'qw_tenMinutes');

      assert.equal(harness.state.getQuestionWaitOverride(harness.key), 'tenMinutes');
      assert.deepEqual(getEditedScreen().labels[0], ["Don't wait", '10 min ✓', '30 min', '1 h']);
    });

    it('in General: the instance value is written to settings.json beside the other fields, the bot is told every topic\'s wait may have changed, and the picker follows', async () => {
      fs.writeFileSync(settingsPath, JSON.stringify({ autoUpdate: 'off' }));
      harness.isGeneral = true;
      await harness.tapButton(pickerMessageId, 'qw_untilAnswered');

      assert.deepEqual(readSettingsFile(), { autoUpdate: 'off', questionWait: 'untilAnswered' });
      assert.deepEqual(changedWaits, [null]);
      assert.equal(getLastToast(), '✅ Wait for my answer');
      assert.deepEqual(getEditedScreen().labels, [["Don't wait", '10 min', '30 min', '1 h'], ['Wait for my answer ✓']]);
      assert.equal(harness.state.getQuestionWaitOverride(harness.key), undefined, 'General\'s choice is no topic\'s own');
    });

    it('a topic that has no choice of its own follows what General wrote', async () => {
      harness.isGeneral = true;
      await harness.tapButton(pickerMessageId, 'qw_dontWait');
      harness.isGeneral = false;
      await harness.runCommand('question_wait');

      assert.ok(getSentScreen().text.includes("this topic: as in General — Don't wait"));
      assert.deepEqual(getSentScreen().labels.at(-1), ["As in General (Don't wait) ✓"]);
    });

    it('«as in General» tapped in General changes nothing and writes no file', async () => {
      harness.isGeneral = true;
      await harness.tapButton(pickerMessageId, 'qw_same');

      assert.equal(fs.existsSync(settingsPath), false);
      assert.deepEqual(changedWaits, []);
    });

    it('General\'s settings file that cannot be written: the toast says so, nothing changes and the bot is not told', async () => {
      // A directory where the file should be: the atomic rename over it fails.
      fs.mkdirSync(settingsPath);
      try {
        harness.isGeneral = true;
        await harness.tapButton(pickerMessageId, 'qw_oneHour');

        assert.match(getLastToast() ?? '', /could not be saved/);
        assert.deepEqual(changedWaits, []);
        assert.deepEqual(harness.edits, [], 'the picker is left as it was');
      } finally {
        fs.rmSync(settingsPath, { recursive: true, force: true });
      }
    });

    it('a refused tap (not an admin) changes nothing', async () => {
      harness.isAuthorised = false;
      await harness.tapButton(pickerMessageId, 'qw_oneHour');

      assert.equal(getLastToast(), enDict['cb.access_denied']);
      assert.equal(harness.state.getQuestionWaitOverride(harness.key), undefined);
      assert.deepEqual(changedWaits, []);
    });

    it('settings.json stays valid after a General tap: the file loads and holds the choice', async () => {
      harness.isGeneral = true;
      await harness.tapButton(pickerMessageId, 'qw_tenMinutes');

      const load = loadInstanceSettings(settingsPath);
      assert.equal(load.status, 'ok');
      assert.equal(load.status === 'ok' ? load.config.questionWait : null, 'tenMinutes');
    });
  });
});
