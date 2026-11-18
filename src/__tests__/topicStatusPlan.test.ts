/**
 * @description The pure half of `/topic_status` (`utils/topicStatusPlan.ts`): the button codec (what a tap says, a stale or foreign
 * keyboard read as none, every data under Telegram's 64 bytes), what a tap does to a set of switches, the two screens (a topic's with its
 * hints, General's with the topics whose name the bot does not know), and the words in every locale.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getKeyInLang, localeCodes } from '../i18n';
import { enDict } from '../i18n/en';
import {
  defaultTopicStatusPrefs,
  topicIndicatorSwitches,
  visibleBaseChars,
  type TopicStatusPrefs,
} from '../utils/topicIndicatorPlan';
import {
  applyTopicStatusTap,
  buildTopicStatusGeneralScreen,
  buildTopicStatusNameCallback,
  buildTopicStatusSwitchCallback,
  buildTopicStatusTopicScreen,
  parseTopicStatusCallback,
  topicStatusAllOffCallback,
  topicStatusCallbackRe,
  topicStatusSameAsGeneralCallback,
  topicStatusUnknownNameButtonLimit,
  type TopicStatusScreen,
  type TopicStatusTopicView,
} from '../utils/topicStatusPlan';

const maxCallbackDataBytes = 64;

const topicView: TopicStatusTopicView = {
  prefs: defaultTopicStatusPrefs,
  isOwnSet: false,
  isBound: true,
  base: 'Deploy',
  candidate: undefined,
  threadId: 4242,
  isRenameRefused: false,
  isLineDeletionRefused: false,
  droppedMark: undefined,
};

const getLabels = (screen: TopicStatusScreen): string[][] => screen.keyboard.map((row) => row.map((button) => button.label));
const getData = (screen: TopicStatusScreen): string[][] => screen.keyboard.map((row) => row.map((button) => button.callbackData));

describe('the button codec', () => {
  it('a switch\'s data names the switch and its NEW value; it reads back as that', () => {
    assert.equal(buildTopicStatusSwitchCallback('asleep', false), 'tst_asleep_0');
    assert.deepEqual(parseTopicStatusCallback('tst_asleep_0'), { kind: 'switch', name: 'asleep', isOn: false });
    assert.deepEqual(parseTopicStatusCallback(buildTopicStatusSwitchCallback('queued', true)), { kind: 'switch', name: 'queued', isOn: true });
  });

  it('«All off», «As General» and a name confirmation read back too', () => {
    assert.deepEqual(parseTopicStatusCallback(topicStatusAllOffCallback), { kind: 'allOff' });
    assert.deepEqual(parseTopicStatusCallback(topicStatusSameAsGeneralCallback), { kind: 'sameAsGeneral' });
    assert.deepEqual(parseTopicStatusCallback(buildTopicStatusNameCallback(4242)), { kind: 'confirmName', threadId: 4242 });
  });

  it('data that is none of ours reads as none: an unknown switch, a bad value, a name without an id', () => {
    for (const stale of ['tst_flashing_1', 'tst_asleep_2', 'tst_asleep', 'tsn_', 'tsn_x', 'tst_', 'qw_dontWait']) assert.equal(parseTopicStatusCallback(stale), null, stale);
  });

  it('the pattern the module registers matches exactly the data a screen can carry', () => {
    for (const name of topicIndicatorSwitches) {
      for (const isOn of [true, false]) assert.match(buildTopicStatusSwitchCallback(name, isOn), topicStatusCallbackRe);
    }
    for (const data of [topicStatusAllOffCallback, topicStatusSameAsGeneralCallback, buildTopicStatusNameCallback(123456789)]) assert.match(data, topicStatusCallbackRe);
    assert.doesNotMatch('tst_flash', topicStatusCallbackRe);
  });

  it('every data is far under Telegram\'s 64 bytes, a thread id of any size included', () => {
    const everyData = [
      ...topicIndicatorSwitches.flatMap((name) => [buildTopicStatusSwitchCallback(name, true), buildTopicStatusSwitchCallback(name, false)]),
      topicStatusAllOffCallback,
      topicStatusSameAsGeneralCallback,
      buildTopicStatusNameCallback(Number.MAX_SAFE_INTEGER),
    ];
    for (const data of everyData) assert.ok(Buffer.byteLength(data) <= maxCallbackDataBytes, data);
  });
});

describe('what a tap does to a set of switches', () => {
  it('a switch tap sets that switch to the value its button names and leaves the rest', () => {
    const next = applyTopicStatusTap(defaultTopicStatusPrefs, { kind: 'switch', name: 'queued', isOn: true });
    assert.deepEqual(next, { ...defaultTopicStatusPrefs, queued: true });
    assert.deepEqual(applyTopicStatusTap(next, { kind: 'switch', name: 'asleep', isOn: false }), { ...defaultTopicStatusPrefs, queued: true, asleep: false });
  });

  it('a stale keyboard applies what its button says, not a flip of what is now', () => {
    const alreadyOff: TopicStatusPrefs = { ...defaultTopicStatusPrefs, asleep: false };
    assert.deepEqual(applyTopicStatusTap(alreadyOff, { kind: 'switch', name: 'asleep', isOn: false }), alreadyOff);
  });

  it('«All off» turns every switch off, the counts included', () => {
    const next = applyTopicStatusTap({ ...defaultTopicStatusPrefs, agents: true }, { kind: 'allOff' });
    assert.ok(topicIndicatorSwitches.every((name) => next[name] === false));
  });

  it('a tap that is no switch changes nothing', () => {
    assert.deepEqual(applyTopicStatusTap(defaultTopicStatusPrefs, { kind: 'sameAsGeneral' }), defaultTopicStatusPrefs);
    assert.deepEqual(applyTopicStatusTap(defaultTopicStatusPrefs, { kind: 'confirmName', threadId: 1 }), defaultTopicStatusPrefs);
  });
});

describe('a topic\'s screen', () => {
  it('names where the set comes from, lists the five marks two to a row with ✓ on those that are on, the two counts, and the two ways out', () => {
    const screen = buildTopicStatusTopicScreen(topicView);
    assert.ok(screen.text.startsWith('Topic status in the topic list — this topic: as in General'), screen.text);
    assert.ok(screen.text.includes(enDict['topicStatus.statusesIntroText']) && screen.text.includes(enDict['topicStatus.countsIntroText']));
    assert.deepEqual(getLabels(screen), [
      ['✓ ❓ Question', '✓ ❗️ Stuck'],
      ['✓ ⏳ Working', '✓ ✅ Finished'],
      ['✓ 💤 Asleep'],
      ['⚙️ Agents at work', '📋 Tasks queued'],
      ['All off', 'As General ✓'],
    ]);
    assert.deepEqual(getData(screen)[0], ['tst_question_0', 'tst_stuck_0'], 'a button that is on turns it off');
    assert.deepEqual(getData(screen)[3], ['tst_agents_1', 'tst_queued_1'], 'a button that is off turns it on');
  });

  it('a topic with a set of its own says so, and «As General» loses its ✓', () => {
    const screen = buildTopicStatusTopicScreen({ ...topicView, isOwnSet: true, prefs: { ...defaultTopicStatusPrefs, asleep: false } });
    assert.ok(screen.text.includes('this topic: its own set'));
    assert.deepEqual(getLabels(screen).at(-1), ['All off', 'As General']);
    assert.deepEqual(getLabels(screen)[2], ['💤 Asleep']);
  });

  it('shows no hint when nothing is wrong', () => {
    const screen = buildTopicStatusTopicScreen(topicView);
    for (const key of ['unknownNameCandidateHintText', 'unknownNameHintText', 'manageTopicsRightHintText', 'longNameHintText', 'droppedMarkHintText', 'lineDeletionHintText']) {
      assert.ok(!screen.text.includes(enDict[`topicStatus.${key}` as keyof typeof enDict].split('{')[0]), key);
    }
    assert.equal(screen.keyboard.length, 5);
  });

  it('a name the bot does not know and a candidate for it: asks «Is it …?» with the tap that says yes', () => {
    const screen = buildTopicStatusTopicScreen({ ...topicView, base: undefined, candidate: 'Deploy' });
    assert.ok(screen.text.includes('⚠️ I don\'t know this topic\'s name. Is it «Deploy»?'), screen.text);
    assert.deepEqual(getLabels(screen).at(-1), ['✓ Yes, that\'s its name']);
    assert.deepEqual(getData(screen).at(-1), ['tsn_4242']);
  });

  it('a name the bot does not know and no candidate: asks to rename the topic once, and offers no button', () => {
    const screen = buildTopicStatusTopicScreen({ ...topicView, base: undefined });
    assert.ok(screen.text.includes('rename it once (any change) and the marks appear'), screen.text);
    assert.equal(screen.keyboard.length, 5);
  });

  it('an unbound topic gets no hint about its name', () => {
    const screen = buildTopicStatusTopicScreen({ ...topicView, isBound: false, base: undefined });
    assert.ok(!screen.text.includes('I don\'t know this topic\'s name'));
  });

  it('says the right is missing, the name is long, the owner\'s own mark was dropped, and the «renamed» lines stay — each only when it holds', () => {
    const screen = buildTopicStatusTopicScreen({ ...topicView, base: 'x'.repeat(visibleBaseChars + 1), isRenameRefused: true, droppedMark: '✅', isLineDeletionRefused: true });
    assert.ok(screen.text.includes('⚠️ Needs the «Manage topics» admin right.'));
    assert.ok(screen.text.includes(`ℹ️ This name is long: on a phone the mark may be cut off — shorten it to ${visibleBaseChars} characters.`));
    assert.ok(screen.text.includes('ℹ️ «✅» at the end of your name reads as my mark, so I dropped it from the name.'));
    assert.ok(screen.text.includes('ℹ️ Without «Delete messages» each change leaves a «renamed» line in the topic.'));
    const fitting = buildTopicStatusTopicScreen({ ...topicView, base: 'x'.repeat(visibleBaseChars) });
    assert.ok(!fitting.text.includes('This name is long'));
  });
});

describe('General\'s screen', () => {
  const generalView = { prefs: defaultTopicStatusPrefs, unknownNameTopics: [], isRenameRefused: false };

  it('is the default of all topics: the switches and «All off», no «As General», and no list when every name is known', () => {
    const screen = buildTopicStatusGeneralScreen(generalView);
    assert.ok(screen.text.startsWith('Topic status in the topic list — the default of ALL topics'), screen.text);
    assert.deepEqual(getLabels(screen), [['✓ ❓ Question', '✓ ❗️ Stuck'], ['✓ ⏳ Working', '✓ ✅ Finished'], ['✓ 💤 Asleep'], ['⚙️ Agents at work', '📋 Tasks queued'], ['All off']]);
    assert.ok(!screen.text.includes('Names I don\'t know yet'));
  });

  it('lists the topics whose name the bot does not know: a button for each that has a candidate, the rest counted', () => {
    const screen = buildTopicStatusGeneralScreen({
      ...generalView,
      unknownNameTopics: [
        { threadId: 11, candidate: 'Deploy' },
        { threadId: 22, candidate: 'Billing API' },
        { threadId: 33, candidate: 'Research' },
        { threadId: 44, candidate: undefined },
        { threadId: 55, candidate: undefined },
      ],
    });
    assert.ok(screen.text.includes('Names I don\'t know yet (no marks there until I do):'));
    assert.ok(screen.text.includes('2 more: rename them once (any change).'));
    assert.deepEqual(getLabels(screen).slice(5), [['✓ «Deploy»', '✓ «Billing API»'], ['✓ «Research»']]);
    assert.deepEqual(getData(screen).slice(5), [['tsn_11', 'tsn_22'], ['tsn_33']]);
  });

  it('shows at most a handful of name buttons, counts the rest, and cuts a long name for its button', () => {
    const topics = Array.from({ length: topicStatusUnknownNameButtonLimit + 3 }, (_unused, index) => ({ threadId: index + 1, candidate: `Topic ${index + 1} ${'y'.repeat(40)}` }));
    const screen = buildTopicStatusGeneralScreen({ ...generalView, unknownNameTopics: topics });
    const nameButtons = screen.keyboard.slice(5).flat();
    assert.equal(nameButtons.length, topicStatusUnknownNameButtonLimit);
    assert.ok(nameButtons.every((button) => Array.from(button.label).length <= 30), 'a button\'s caption stays short');
    assert.ok(nameButtons[0].label.includes('…'));
    assert.ok(screen.text.includes('3 more: rename them once (any change).'));
  });

  it('says the right is missing', () => {
    assert.ok(buildTopicStatusGeneralScreen({ ...generalView, isRenameRefused: true }).text.includes('⚠️ Needs the «Manage topics» admin right.'));
  });
});

describe('the words', () => {
  const topicStatusKeys = Object.keys(enDict).filter((key) => key.startsWith('topicStatus.'));

  it('every locale has every key, translated (not the English text) except the captions that are the same word in a language', () => {
    assert.ok(topicStatusKeys.length > 20);
    for (const locale of localeCodes) {
      for (const key of topicStatusKeys) {
        const text = getKeyInLang(locale, key);
        assert.ok(text !== undefined && text.length > 0, `${locale} ${key}`);
      }
    }
  });

  it('every locale keeps the placeholders of the English text, and invents none', () => {
    const placeholders = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    for (const locale of localeCodes) {
      for (const key of topicStatusKeys) {
        assert.deepEqual(placeholders(getKeyInLang(locale, key) ?? ''), placeholders(enDict[key as keyof typeof enDict]), `${locale} ${key}`);
      }
    }
  });

  it('every locale lists /topic_status in its help', () => {
    for (const locale of localeCodes) assert.ok((getKeyInLang(locale, 'help.thread_bound') ?? '').includes('/topic_status'), locale);
  });
});
