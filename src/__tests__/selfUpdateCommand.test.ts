/**
 * @description The `/update` command module end to end, with fake Telegram ports, a fake engine and a real `settings.json` on disk: the
 * screen opens (with controls in General, read-only elsewhere), the text forms and the buttons write `autoUpdate` / `whatsNew` (General
 * only, a write that fails says where and why), a tap re-renders its message, "Check now" asks the engine, "Update now" installs exactly
 * the version printed on the button — a stale one answers "already up to date" — and a hand edit of the file shows on the next render.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Context } from 'telegraf';
import { createSelfUpdate, type SelfUpdatePorts } from '../connectors/telegram/commands/selfUpdate';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import { createUpdateSettingsReader, resetInstanceSettingsCache } from '../instanceSettings';
import type { InstallRequestResult, UpdateEngine, UpdateOffer, UpdateStatus } from '../selfUpdate/updateEngine';
import type { SessionKey } from '../sessionKey';

const generalKey: SessionKey = makeTelegramKey(-1001111111111, 1);
const topicKey: SessionKey = makeTelegramKey(-1001111111111, 77);
const screenMessageId = 900;
const now = 1_800_000_000_000;

interface SentMessage {
  text: string;
  buttons: string[];
}

let directory = '';
let settingsPath = '';
let sent: SentMessage[] = [];
let edits: Array<SentMessage & { id: number }> = [];
let engineCalls: string[] = [];
/** What happened, in order, across the Telegram ports and the engine (answers, engine calls, edits). */
let eventOrder: string[] = [];
let engineOffer: UpdateOffer | null = null;
let installResult: InstallRequestResult = 'started';
let currentKey: SessionKey = generalKey;
let isAuthorised = true;
let hasEngine = true;
let commandHandler: ((ctx: Context, key: SessionKey) => Promise<void>) | null = null;
let actions: Array<{ pattern: RegExp | string; handler: (ctx: Context) => Promise<void> }> = [];

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'update-command-'));
  settingsPath = path.join(directory, 'settings.json');
  resetInstanceSettingsCache();
  sent = [];
  edits = [];
  engineCalls = [];
  eventOrder = [];
  engineOffer = null;
  installResult = 'started';
  currentKey = generalKey;
  isAuthorised = true;
  hasEngine = true;
  commandHandler = null;
  actions = [];
});

afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

function buttonsOf(extra: object | undefined): string[] {
  const markup = extra as { reply_markup?: { inline_keyboard?: Array<Array<{ text: string; callback_data: string }>> } } | undefined;
  return (markup?.reply_markup?.inline_keyboard ?? []).flat().map((button) => `${button.text}|${button.callback_data}`);
}

function createFakeEngine(readSettings: () => UpdateStatus['settings']): UpdateEngine {
  const getStatus = (): UpdateStatus => ({
    running: { version: '3.4.0', commit: null },
    installKind: { kind: 'npmGlobal', prefix: '/home/u/.npm-global' },
    isHotMode: false,
    runningNode: '22.23.3',
    settings: readSettings(),
    lastCheckAt: now - 20 * 60 * 1000,
    observation: { kind: 'npm', latestVersion: '3.4.0', engines: null, isDeprecated: false },
    isCheckFailing: false,
    offer: engineOffer,
    phase: 'idle',
    inProgressTarget: null,
  });
  return {
    start: () => {},
    stop: () => {},
    runBootStep: async () => {},
    checkNow: async () => {
      engineCalls.push('checkNow');
      eventOrder.push('checkNow');
      return getStatus();
    },
    requestInstall: async (target) => {
      engineCalls.push(`requestInstall ${target}`);
      return installResult;
    },
    getStatus,
  };
}

function createFeature(overrides: Partial<SelfUpdatePorts> = {}) {
  const readSettings = createUpdateSettingsReader(() => settingsPath, () => {});
  const engine = createFakeEngine(readSettings);
  const ports: SelfUpdatePorts = {
    bot: {
      action: (pattern: RegExp | string, handler: (ctx: Context) => Promise<void>) => {
        actions.push({ pattern, handler });
      },
    } as unknown as SelfUpdatePorts['bot'],
    command: (_names, handler) => {
      commandHandler = handler as unknown as (ctx: Context, key: SessionKey) => Promise<void>;
    },
    replyToThread: async (_key, text, extra) => {
      sent.push({ text, buttons: buttonsOf(extra) });
      return sent.length;
    },
    editThreadMessage: async (_key, id, text, extra) => {
      eventOrder.push('edit');
      edits.push({ id, text, buttons: buttonsOf(extra) });
      return true;
    },
    authoriseContext: async () => (isAuthorised ? currentKey : null),
    withThreadLocale: (_key, fn) => fn(),
    checkIsGeneral: (key) => key === generalKey,
    getUpdateEngine: () => (hasEngine ? engine : null),
    getSettingsPath: () => settingsPath,
    now: () => now,
    formatClock: () => '14:20',
    ...overrides,
  };
  const feature = createSelfUpdate(ports);
  feature.registerSelfUpdateCommands();
  feature.registerSelfUpdateCallbacks();
  return feature;
}

async function runCommand(text: string, key: SessionKey = generalKey): Promise<void> {
  assert.ok(commandHandler, 'the command is registered');
  await commandHandler({ message: { text } } as unknown as Context, key);
}

interface TapResult {
  answers: Array<string | undefined>;
}

async function tap(data: string): Promise<TapResult> {
  const answers: Array<string | undefined> = [];
  const ctx = {
    match: null as RegExpExecArray | null,
    callbackQuery: { data, message: { message_id: screenMessageId } },
    answerCbQuery: async (text?: string) => {
      eventOrder.push('answer');
      answers.push(text);
    },
  };
  const registered = actions.find(({ pattern }) => (typeof pattern === 'string' ? pattern === data : pattern.test(data)));
  assert.ok(registered, `an action handles ${data}`);
  if (typeof registered.pattern !== 'string') ctx.match = registered.pattern.exec(data);
  await registered.handler(ctx as unknown as Context);
  return { answers };
}

const readSettingsFile = (): object => JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
const lastEdit = (): SentMessage & { id: number } => {
  const edit = edits.at(-1);
  assert.ok(edit, 'a message was edited');
  return edit;
};

describe('the screen', () => {
  test('/update in General: a new message with the controls', async () => {
    createFeature();
    await runCommand('/update');
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /^Charness 3\.4\.0 · npm /);
    assert.deepEqual(sent[0].buttons, ['✓ Automatic|upd_mode_on', 'Notify only|upd_mode_notify', 'Off|upd_mode_off', "📰 What's new: ON|upd_notes_off", '🔄 Check now|upd_check']);
  });

  test('in another topic: the same text, no buttons, "Change it in General."', async () => {
    createFeature();
    await runCommand('/update', topicKey);
    assert.deepEqual(sent[0].buttons, []);
    assert.match(sent[0].text, /Change it in General\.$/);
  });

  test('while the engine is not built yet: "still starting", not a crash', async () => {
    hasEngine = false;
    createFeature();
    await runCommand('/update');
    assert.match(sent[0].text, /still starting/);
  });

  test('a hand edit of settings.json shows on the next render', async () => {
    createFeature();
    fs.writeFileSync(settingsPath, '{"autoUpdate":"off","whatsNew":false}');
    await runCommand('/update');
    assert.match(sent[0].text, /^Automatic updates: OFF/m);
    assert.ok(sent[0].buttons.includes('✓ Off|upd_mode_off'));
    assert.ok(sent[0].buttons.includes("📰 What's new: OFF|upd_notes_on"));
  });
});

describe('the text forms', () => {
  test('/update notify|off|on writes autoUpdate in General and confirms; the other fields stay', async () => {
    fs.writeFileSync(settingsPath, '{"defaultEffort":"high"}');
    createFeature();
    await runCommand('/update notify');
    assert.deepEqual(readSettingsFile(), { defaultEffort: 'high', autoUpdate: 'notify' });
    assert.equal(sent.at(-1)?.text, '✅ Automatic updates: notify only.');
    await runCommand('/update off');
    assert.deepEqual(readSettingsFile(), { defaultEffort: 'high', autoUpdate: 'off' });
    await runCommand('/update on');
    assert.deepEqual(readSettingsFile(), { defaultEffort: 'high', autoUpdate: 'on' });
    assert.equal(sent.at(-1)?.text, '✅ Automatic updates: on.');
  });

  test('/update whatsnew on|off writes whatsNew; anything else is the usage line', async () => {
    createFeature();
    await runCommand('/update whatsnew off');
    assert.deepEqual(readSettingsFile(), { whatsNew: false });
    assert.equal(sent.at(-1)?.text, "✅ What's new after an update: not shown.");
    await runCommand('/update whatsnew on');
    assert.deepEqual(readSettingsFile(), { whatsNew: true });
    await runCommand('/update whatsnew maybe');
    assert.match(sent.at(-1)?.text ?? '', /^Usage: \/update/);
    await runCommand('/update banana');
    assert.match(sent.at(-1)?.text ?? '', /^Usage: \/update/);
  });

  test('a write form in another topic changes nothing and says where to change it', async () => {
    createFeature();
    for (const text of ['/update off', '/update whatsnew off', '/update now']) {
      await runCommand(text, topicKey);
      assert.equal(sent.at(-1)?.text, 'ℹ️ Change it in General.', text);
    }
    assert.equal(fs.existsSync(settingsPath), false);
    assert.deepEqual(engineCalls, []);
  });

  test('a write that fails says which file and why — and nothing is confirmed', async () => {
    const unwritable = path.join(directory, 'a-file-not-a-directory');
    fs.writeFileSync(unwritable, '');
    createFeature({ getSettingsPath: () => path.join(unwritable, 'settings.json') });
    await runCommand('/update off');
    assert.match(sent.at(-1)?.text ?? '', /^⚠️ The setting could not be saved: .*settings\.json cannot be written \(EEXIST\)/);
  });

  test('/update check asks the engine and shows the screen, in any topic', async () => {
    createFeature();
    await runCommand('/update check', topicKey);
    assert.deepEqual(engineCalls, ['checkNow']);
    assert.match(sent.at(-1)?.text ?? '', /^Charness 3\.4\.0/);
  });

  test('/update now installs the version the last check found, and reads the engine\'s answer', async () => {
    engineOffer = { target: '3.5.0', action: 'installWhenIdle', until: null, required: null, skipReason: null, canInstallNow: true };
    createFeature();
    await runCommand('/update now');
    assert.deepEqual(engineCalls, ['requestInstall 3.5.0']);
    assert.equal(sent[0].text, '⬆️ Updating to 3.5.0 — installing as soon as no agent is working.');
    assert.match(sent[1].text, /^Charness 3\.4\.0/, 'and the screen follows');

    sent = [];
    installResult = 'busy';
    await runCommand('/update now');
    assert.equal(sent.at(-1)?.text, 'ℹ️ An update is already in progress.');
    installResult = 'cannotInstall';
    await runCommand('/update now');
    assert.match(sent.at(-1)?.text ?? '', /cannot update itself/);
  });

  test('/update now with an update that cannot be installed now says why — the screen\'s own reason — not "up to date"', async () => {
    createFeature();
    installResult = 'blocked';
    engineOffer = { target: 'd4e5f6a', action: 'skipped', until: null, required: null, skipReason: 'dirty', canInstallNow: false };
    await runCommand('/update now');
    assert.equal(sent.at(-1)?.text, 'ℹ️ Nothing was updated — skipped: local changes in the checkout');
    engineOffer = { target: '3.5.0', action: 'needsNode', until: null, required: '>=24', skipReason: null, canInstallNow: false };
    await runCommand('/update now');
    assert.equal(sent.at(-1)?.text, 'ℹ️ Nothing was updated — 3.5.0 needs Node >=24 (this one runs 22.23.3)');
    const { answers } = await tap('upd_go_3.5.0');
    assert.deepEqual(answers, ['ℹ️ Nothing was updated — 3.5.0 needs Node >=24 (this one runs 22.23.3)'], 'the button answers the same');
  });

  test('/update now with nothing to install says it is up to date — or, for an install that cannot update itself, that it cannot', async () => {
    createFeature();
    installResult = 'alreadyUpToDate';
    await runCommand('/update now');
    assert.equal(sent.at(-1)?.text, 'ℹ️ Already up to date.');
    installResult = 'cannotInstall';
    await runCommand('/update now');
    assert.match(sent.at(-1)?.text ?? '', /cannot update itself/);
    assert.deepEqual(engineCalls, ['requestInstall ', 'requestInstall ']);
  });
});

describe('the buttons', () => {
  test('a mode tap in General saves, answers with the confirmation and re-renders its own message with the ✓ moved', async () => {
    createFeature();
    const { answers } = await tap('upd_mode_notify');
    assert.deepEqual(readSettingsFile(), { autoUpdate: 'notify' });
    assert.deepEqual(answers, ['✅ Automatic updates: notify only.']);
    assert.equal(lastEdit().id, screenMessageId);
    assert.ok(lastEdit().buttons.includes('✓ Notify only|upd_mode_notify'));
    assert.match(lastEdit().text, /^Automatic updates: NOTIFY ONLY/m);
  });

  test('the what\'s-new button sets the value printed in its callback', async () => {
    createFeature();
    await tap('upd_notes_off');
    assert.deepEqual(readSettingsFile(), { whatsNew: false });
    assert.ok(lastEdit().buttons.includes("📰 What's new: OFF|upd_notes_on"));
    await tap('upd_notes_on');
    assert.deepEqual(readSettingsFile(), { whatsNew: true });
  });

  test('a tap in another topic, or an unauthorised one, writes nothing and re-renders nothing', async () => {
    createFeature();
    currentKey = topicKey;
    const refused = await tap('upd_mode_off');
    assert.deepEqual(refused.answers, ['ℹ️ Change it in General.']);
    isAuthorised = false;
    const denied = await tap('upd_mode_off');
    assert.equal(denied.answers.length, 1);
    assert.notEqual(denied.answers[0], 'ℹ️ Change it in General.');
    assert.equal(fs.existsSync(settingsPath), false);
    assert.deepEqual(edits, []);
  });

  test('a write that fails is answered on the button and never re-rendered as done', async () => {
    const unwritable = path.join(directory, 'blocker');
    fs.writeFileSync(unwritable, '');
    createFeature({ getSettingsPath: () => path.join(unwritable, 'settings.json') });
    const { answers } = await tap('upd_mode_off');
    assert.match(answers[0] ?? '', /cannot be written \(EEXIST\)/);
    assert.deepEqual(edits, []);
  });

  test('"Check now" runs one check in any topic: the tap is answered FIRST (a check takes up to two minutes), the screen follows', async () => {
    createFeature();
    currentKey = topicKey;
    const { answers } = await tap('upd_check');
    assert.deepEqual(engineCalls, ['checkNow']);
    assert.deepEqual(answers, ['Checking…']);
    assert.deepEqual(eventOrder, ['answer', 'checkNow', 'edit']);
    assert.equal(edits.length, 1);
    assert.deepEqual(lastEdit().buttons, [], 'the topic keeps its read-only screen');
  });

  test('"Update to X now" installs exactly the version on the button — not what the screen offers by now — and re-renders', async () => {
    engineOffer = { target: '3.6.0', action: 'installWhenIdle', until: null, required: null, skipReason: null, canInstallNow: true };
    createFeature();
    const { answers } = await tap('upd_go_3.5.0');
    assert.deepEqual(engineCalls, ['requestInstall 3.5.0']);
    assert.deepEqual(answers, ['⬆️ Updating to 3.5.0 — installing as soon as no agent is working.']);
    assert.equal(edits.length, 1);
  });

  test('the same tap under an announcement in General installs the version and answers, but leaves the announcement as it is', async () => {
    createFeature();
    const { answers } = await tap('upd_ann_4.0.0');
    assert.deepEqual(engineCalls, ['requestInstall 4.0.0']);
    assert.deepEqual(answers, ['⬆️ Updating to 4.0.0 — installing as soon as no agent is working.']);
    assert.deepEqual(edits, [], 'the announcement keeps its text and its button — it is not overwritten with the /update screen');
    assert.deepEqual(sent, []);
  });

  test('an announcement\'s tap is the same install as the screen\'s: General only, stale answers "already up to date"', async () => {
    createFeature();
    installResult = 'alreadyUpToDate';
    assert.deepEqual((await tap('upd_ann_3.4.9')).answers, ['ℹ️ Already up to date.']);
    engineCalls = [];
    currentKey = topicKey;
    assert.deepEqual((await tap('upd_ann_3.5.0')).answers, ['ℹ️ Change it in General.']);
    assert.deepEqual(engineCalls, []);
    assert.deepEqual(edits, []);
  });

  test('a keyboard gone stale answers "already up to date"; a tap outside General installs nothing', async () => {
    createFeature();
    installResult = 'alreadyUpToDate';
    const stale = await tap('upd_go_3.4.9');
    assert.deepEqual(stale.answers, ['ℹ️ Already up to date.']);
    engineCalls = [];
    currentKey = topicKey;
    const refused = await tap('upd_go_3.5.0');
    assert.deepEqual(refused.answers, ['ℹ️ Change it in General.']);
    assert.deepEqual(engineCalls, []);
  });
});
