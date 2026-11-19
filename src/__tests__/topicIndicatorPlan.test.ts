/**
 * @description The pure plan of the status mark at the end of a topic's name (`utils/topicIndicatorPlan.ts`): which status holds (the
 * priority table, every pair), the name it composes (counts, the 128 cut), the owner's own name back out of a saved name (the marks with
 * and without the variation selector), and when a rename may happen (settle, gap, the ❓ bypass).
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkIsBaseTooLongForMark,
  checkIsTopicIndicatorSwitch,
  composeIndicatorName,
  createTopicStatusPrefsWith,
  defaultTopicStatusPrefs,
  getIndicatorStatusOfName,
  getIndicatorSuffix,
  getOwnerRenameOutcome,
  indicatorMinRenameGapMs,
  indicatorSettleMs,
  planIndicatorRename,
  resolveTopicStatus,
  resolveTopicStatusPrefs,
  stripIndicatorSuffix,
  topicNameMaxLength,
  topicStatuses,
  visibleBaseChars,
  type IndicatorRenameInputs,
  type TopicIndicatorCounts,
  type TopicStatus,
  type TopicStatusInputs,
  type TopicStatusPrefs,
} from '../utils/topicIndicatorPlan';

const noCounts: TopicIndicatorCounts = { agents: 0, queued: 0 };
const nothingHolds: TopicStatusInputs = { hasOpenQuestion: false, isStuck: false, isWorking: false, isFinished: false, isAsleep: false };
/** The input that makes each status hold. */
const inputOf: Record<TopicStatus, keyof TopicStatusInputs> = {
  question: 'hasOpenQuestion',
  stuck: 'isStuck',
  working: 'isWorking',
  finished: 'isFinished',
  asleep: 'isAsleep',
};

function holding(...statuses: TopicStatus[]): TopicStatusInputs {
  return { ...nothingHolds, ...Object.fromEntries(statuses.map((status) => [inputOf[status], true])) };
}

describe('resolveTopicStatus', () => {
  it('shows no status when none holds', () => {
    assert.equal(resolveTopicStatus(nothingHolds, defaultTopicStatusPrefs), null);
  });

  it('shows the one status that holds', () => {
    for (const status of topicStatuses) assert.equal(resolveTopicStatus(holding(status), defaultTopicStatusPrefs), status);
  });

  it('ranks the statuses ❓ ❗️ ⏳ ✅ 💤, highest first (the plan\'s table, not whatever order the list happens to have)', () => {
    assert.deepEqual(topicStatuses, ['question', 'stuck', 'working', 'finished', 'asleep']);
  });

  it('shows the higher status of every pair that holds together (❓ ❗️ ⏳ ✅ 💤)', () => {
    for (const [higherIndex, higher] of topicStatuses.entries()) {
      for (const lower of topicStatuses.slice(higherIndex + 1)) {
        assert.equal(resolveTopicStatus(holding(lower, higher), defaultTopicStatusPrefs), higher, `${higher} beats ${lower}`);
      }
    }
  });

  it('skips a status that is switched off, as if it did not hold', () => {
    const noQuestion = { ...defaultTopicStatusPrefs, question: false };
    assert.equal(resolveTopicStatus(holding('question', 'stuck'), noQuestion), 'stuck');
    assert.equal(resolveTopicStatus(holding('question'), noQuestion), null);
    assert.equal(resolveTopicStatus(holding('working', 'asleep'), { ...defaultTopicStatusPrefs, working: false }), 'asleep');
  });

  it('shows nothing when everything is switched off', () => {
    assert.equal(resolveTopicStatus(holding(...topicStatuses), createTopicStatusPrefsWith(false)), null);
  });
});

describe('the switches', () => {
  it('start with the five marks on and both counts off', () => {
    assert.deepEqual(defaultTopicStatusPrefs, { question: true, stuck: true, working: true, finished: true, asleep: true, agents: false, queued: false });
  });

  it('a topic with its own set uses it whole; one without follows the instance over the defaults', () => {
    const own: TopicStatusPrefs = { ...defaultTopicStatusPrefs, asleep: false, queued: true };
    assert.deepEqual(resolveTopicStatusPrefs({ agents: true }, own), own, 'the instance is not mixed into a topic\'s own set');
    assert.deepEqual(resolveTopicStatusPrefs({ agents: true, working: false }, undefined), { ...defaultTopicStatusPrefs, agents: true, working: false });
    assert.deepEqual(resolveTopicStatusPrefs(null, undefined), defaultTopicStatusPrefs);
  });

  it('knows its own names, and no others', () => {
    assert.ok(checkIsTopicIndicatorSwitch('asleep'));
    assert.ok(checkIsTopicIndicatorSwitch('queued'));
    assert.ok(!checkIsTopicIndicatorSwitch('flashing'));
    assert.ok(!checkIsTopicIndicatorSwitch(undefined));
  });
});

describe('composeIndicatorName', () => {
  const allCountsOn: TopicStatusPrefs = { ...defaultTopicStatusPrefs, agents: true, queued: true };

  it('is the base, unchanged, when nothing holds', () => {
    assert.equal(composeIndicatorName('Deploy', null, noCounts, defaultTopicStatusPrefs), 'Deploy');
  });

  it('puts the status after the base, one space between', () => {
    assert.equal(composeIndicatorName('Deploy', 'working', noCounts, defaultTopicStatusPrefs), 'Deploy ⏳');
    assert.equal(composeIndicatorName('Деплой бота', 'asleep', noCounts, defaultTopicStatusPrefs), 'Деплой бота 💤');
    assert.equal(composeIndicatorName('Deploy', 'stuck', noCounts, defaultTopicStatusPrefs), 'Deploy ❗️');
  });

  it('puts the counts after the status, each only when switched on and at least 1', () => {
    assert.equal(composeIndicatorName('Deploy', 'working', { agents: 3, queued: 5 }, allCountsOn), 'Deploy ⏳ ⚙️3 📋5');
    assert.equal(composeIndicatorName('Research', 'asleep', { agents: 0, queued: 2 }, allCountsOn), 'Research 💤 📋2');
    assert.equal(composeIndicatorName('Research', null, { agents: 0, queued: 2 }, allCountsOn), 'Research 📋2', 'a count stands alone without a status');
    assert.equal(composeIndicatorName('Landing page', 'finished', noCounts, allCountsOn), 'Landing page ✅', 'both zero: no numbers');
    assert.equal(composeIndicatorName('Deploy', 'working', { agents: 3, queued: 5 }, defaultTopicStatusPrefs), 'Deploy ⏳', 'counts off by default: never a number');
    assert.equal(composeIndicatorName('Deploy', 'working', { agents: 3, queued: 5 }, { ...allCountsOn, queued: false }), 'Deploy ⏳ ⚙️3');
  });

  it('never exceeds the name limit: the base is cut and ends in «…», the suffix stays whole', () => {
    const base = 'x'.repeat(200);
    const name = composeIndicatorName(base, 'question', { agents: 12, queued: 34 }, allCountsOn);
    assert.equal(name.length, topicNameMaxLength);
    assert.ok(name.endsWith('… ❓ ⚙️12 📋34'), name);
    assert.equal(composeIndicatorName(base, null, noCounts, allCountsOn), base, 'no suffix, nothing to cut for');
  });

  it('keeps a base that fits exactly and cuts one unit over', () => {
    const suffix = ' ⏳';
    const fits = 'y'.repeat(topicNameMaxLength - suffix.length);
    assert.equal(composeIndicatorName(fits, 'working', noCounts, defaultTopicStatusPrefs), `${fits}${suffix}`);
    const cut = composeIndicatorName(`${fits}y`, 'working', noCounts, defaultTopicStatusPrefs);
    assert.equal(cut.length, topicNameMaxLength);
    assert.equal(cut, `${'y'.repeat(topicNameMaxLength - suffix.length - 1)}…${suffix}`);
  });

  it('cuts a base between characters, never inside a surrogate pair', () => {
    const suffix = ' ⏳';
    const room = topicNameMaxLength - suffix.length - 1;
    // A pair straddles the cut: the cut base drops it whole instead of leaving half of it.
    const base = `${'a'.repeat(room - 1)}😀${'b'.repeat(40)}`;
    const name = composeIndicatorName(base, 'working', noCounts, defaultTopicStatusPrefs);
    assert.equal(name, `${'a'.repeat(room - 1)}… ⏳`);
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u.test(name), 'no lone surrogate');
    // A pair that fits is kept whole.
    const fitting = composeIndicatorName(`${'a'.repeat(room - 2)}😀${'b'.repeat(40)}`, 'working', noCounts, defaultTopicStatusPrefs);
    assert.equal(fitting, `${'a'.repeat(room - 2)}😀… ⏳`);
  });
});

describe('stripIndicatorSuffix', () => {
  it('takes the owner\'s own name out of a name that carries a mark', () => {
    assert.equal(stripIndicatorSuffix('Deploy ⏳', 'Deploy ⏳', undefined), 'Deploy');
    assert.equal(stripIndicatorSuffix('Deploy v2 ⏳', 'Deploy ⏳', 'Deploy'), 'Deploy v2', 'edited around the mark');
    assert.equal(stripIndicatorSuffix('Деплой бота 💤', 'Деплой бота ⏳', 'Деплой бота'), 'Деплой бота', 'saved while the mark flipped under him');
  });

  it('takes the whole trailing run, the counts too, with or without the variation selector', () => {
    assert.equal(stripIndicatorSuffix('Deploy ⏳ ⚙️3 📋5', 'x', undefined), 'Deploy');
    assert.equal(stripIndicatorSuffix('Deploy ⏳ ⚙3 📋5', 'x', undefined), 'Deploy', 'a client that dropped the selector');
    assert.equal(stripIndicatorSuffix('Deploy ❗ ', 'x', undefined), 'Deploy');
    assert.equal(stripIndicatorSuffix('Deploy ❗️', 'x', undefined), 'Deploy');
    assert.equal(stripIndicatorSuffix('Research 📋2', 'x', undefined), 'Research');
    assert.equal(stripIndicatorSuffix('Deploy ✅ 💤', 'x', undefined), 'Deploy');
  });

  it('leaves a mark that is not at the end, or has no space before it, or is no mark of ours', () => {
    assert.equal(stripIndicatorSuffix('✅ Release notes', 'x', undefined), '✅ Release notes');
    assert.equal(stripIndicatorSuffix('Release✅', 'x', undefined), 'Release✅');
    assert.equal(stripIndicatorSuffix('Ship it 🚀', 'x', undefined), 'Ship it 🚀');
    assert.equal(stripIndicatorSuffix('Q3 ⚙️ plan', 'x', undefined), 'Q3 ⚙️ plan');
    assert.equal(stripIndicatorSuffix('Deploy 📋', 'x', undefined), 'Deploy 📋', 'a count mark with no number is the owner\'s');
  });

  it('costs an owner\'s own ending mark: «Release ✅» typed by the owner is «Release»', () => {
    assert.equal(stripIndicatorSuffix('Release ✅', 'Release ⏳', 'Release'), 'Release');
  });

  it('keeps the whole stored base when the name saved is the one the bot applied (it may be a cut of it)', () => {
    const wholeBase = 'z'.repeat(150);
    const applied = composeIndicatorName(wholeBase.slice(0, 128), 'working', noCounts, defaultTopicStatusPrefs);
    assert.equal(stripIndicatorSuffix(applied, applied, wholeBase), wholeBase);
    assert.notEqual(stripIndicatorSuffix(applied, `${applied}!`, wholeBase), wholeBase, 'a name that differs from the applied one is read as typed');
  });

  it('is the name itself when it ends in no mark', () => {
    assert.equal(stripIndicatorSuffix('Notes', 'Notes ⏳', 'Notes'), 'Notes');
  });
});

describe('getOwnerRenameOutcome', () => {
  it('reads the base out of a rename around the bot\'s own mark, with no news for the owner', () => {
    assert.deepEqual(getOwnerRenameOutcome('Deploy v2 ⏳', 'Deploy ⏳', 'Deploy'), { base: 'Deploy v2', droppedMark: null });
    assert.deepEqual(getOwnerRenameOutcome('Deploy v2 ⏳ ⚙️3', 'Deploy ⏳ ⚙️3', 'Deploy'), { base: 'Deploy v2', droppedMark: null });
  });

  it('reports the owner\'s own ending mark that was dropped, so the picker can say so once', () => {
    assert.deepEqual(getOwnerRenameOutcome('Release ✅', 'Release ⏳', 'Release'), { base: 'Release', droppedMark: '✅' });
    assert.deepEqual(getOwnerRenameOutcome('Release ✅', undefined, undefined), { base: 'Release', droppedMark: '✅' }, 'a topic the bot never marked');
  });

  it('a mark the bot wrote a moment ago is not the owner\'s: he opened «Deploy ⏳», the bot wrote «Deploy ✅», he saved «Deploy v2 ⏳»', () => {
    assert.deepEqual(getOwnerRenameOutcome('Deploy v2 ⏳', 'Deploy ✅', 'Deploy', ['Deploy ✅', 'Deploy ⏳']), { base: 'Deploy v2', droppedMark: null });
    assert.deepEqual(getOwnerRenameOutcome('Deploy v2 ⏳ 📋2', 'Deploy ✅', 'Deploy', ['Deploy ✅', 'Deploy ⏳ 📋2']), { base: 'Deploy v2', droppedMark: null }, 'a count that changed meanwhile');
    assert.deepEqual(getOwnerRenameOutcome('Deploy v2 💤', 'Deploy ✅', 'Deploy', ['Deploy ✅', 'Deploy ⏳']), { base: 'Deploy v2', droppedMark: '💤' }, 'a mark the bot did not write recently is the owner\'s');
  });

  it('a plain rename drops nothing', () => {
    assert.deepEqual(getOwnerRenameOutcome('New', 'Deploy ⏳', 'Deploy'), { base: 'New', droppedMark: null });
  });

  it('a name saved equal to the applied one keeps the stored whole base and reports nothing', () => {
    const wholeBase = 'w'.repeat(140);
    assert.deepEqual(getOwnerRenameOutcome('wwww… ⏳', 'wwww… ⏳', wholeBase), { base: wholeBase, droppedMark: null });
  });
});

describe('the marks a name ends in', () => {
  it('reads the status and the suffix, selector or not', () => {
    assert.equal(getIndicatorStatusOfName('Deploy ❓'), 'question');
    assert.equal(getIndicatorStatusOfName('Deploy ❗'), 'stuck');
    assert.equal(getIndicatorStatusOfName('Deploy ❗️ ⚙️2'), 'stuck');
    assert.equal(getIndicatorStatusOfName('Deploy 📋2'), null, 'a count is no status');
    assert.equal(getIndicatorStatusOfName('Deploy'), null);
    assert.equal(getIndicatorSuffix('Deploy ⏳ ⚙️3'), '⏳ ⚙️3');
    assert.equal(getIndicatorSuffix('Deploy'), '');
  });
});

describe('planIndicatorRename', () => {
  const nowMs = 1_000_000;
  const quietSince = nowMs - 10 * indicatorMinRenameGapMs;

  function plan(overrides: Partial<IndicatorRenameInputs>): ReturnType<typeof planIndicatorRename> {
    return planIndicatorRename({
      desiredName: 'Deploy ✅',
      desiredStatus: 'finished',
      appliedName: 'Deploy 💤',
      heldSinceMs: quietSince,
      lastRenameAtMs: quietSince,
      isOwnerChange: false,
      nowMs,
      settleMs: indicatorSettleMs,
      minGapMs: indicatorMinRenameGapMs,
      ...overrides,
    });
  }

  it('does nothing when the topic already shows the desired name', () => {
    assert.deepEqual(plan({ desiredName: 'Deploy 💤', desiredStatus: 'asleep' }), { kind: 'none' });
  });

  it('renames at once when the name has held long enough and the last rename is long ago, and on the very first', () => {
    assert.deepEqual(plan({}), { kind: 'now' });
    assert.deepEqual(plan({ lastRenameAtMs: null }), { kind: 'now' });
  });

  it('waits out the gap since the last rename, and asks again exactly when it ends', () => {
    const lastRenameAtMs = nowMs - 20_000;
    assert.deepEqual(plan({ lastRenameAtMs }), { kind: 'at', atMs: lastRenameAtMs + indicatorMinRenameGapMs });
    assert.deepEqual(plan({ lastRenameAtMs: nowMs - indicatorMinRenameGapMs }), { kind: 'now' }, 'at the boundary the gap is over');
  });

  it('shows a name only once it has been the wanted one for the settle time: ⏳ after the turn ran that long, never a ✅ on the way', () => {
    const workingNow = { desiredName: 'Deploy ⏳', desiredStatus: 'working' as const, appliedName: 'Deploy ✅' };
    assert.deepEqual(plan({ ...workingNow, heldSinceMs: nowMs - 5_000 }), { kind: 'at', atMs: nowMs - 5_000 + indicatorSettleMs });
    assert.deepEqual(plan({ ...workingNow, heldSinceMs: nowMs - indicatorSettleMs }), { kind: 'now' });
    // A session that wakes for a prompt wants ✅ for an instant before its turn runs: the instant is not enough to show it.
    assert.deepEqual(plan({ desiredName: 'Deploy ✅', desiredStatus: 'finished', appliedName: 'Deploy 💤', heldSinceMs: nowMs - 100 }), { kind: 'at', atMs: nowMs - 100 + indicatorSettleMs });
  });

  it('takes the later of the settle time and the gap', () => {
    const heldSinceMs = nowMs - 5_000;
    const lastRenameAtMs = nowMs - 5_000;
    assert.deepEqual(
      plan({ desiredName: 'Deploy ⏳', desiredStatus: 'working', appliedName: 'Deploy ✅', heldSinceMs, lastRenameAtMs }),
      { kind: 'at', atMs: lastRenameAtMs + indicatorMinRenameGapMs },
    );
    assert.deepEqual(plan({ heldSinceMs: nowMs - 100, lastRenameAtMs: nowMs - 59_000 }), { kind: 'at', atMs: nowMs - 100 + indicatorSettleMs });
  });

  it('lets the edges of ❓ skip the wait and the gap: the question appearing, and the question answered', () => {
    const lastRenameAtMs = nowMs - 1_000;
    const justWanted = { heldSinceMs: nowMs, lastRenameAtMs };
    assert.deepEqual(plan({ desiredName: 'Deploy ❓', desiredStatus: 'question', appliedName: 'Deploy ⏳', ...justWanted }), { kind: 'now' });
    assert.deepEqual(plan({ desiredName: 'Deploy ⏳', desiredStatus: 'working', appliedName: 'Deploy ❓', ...justWanted }), { kind: 'now' });
    assert.deepEqual(plan({ desiredName: 'Deploy ✅', desiredStatus: 'finished', appliedName: 'Deploy ❓', ...justWanted }), { kind: 'now' });
  });

  it('lets a change the owner just made skip the wait and the gap', () => {
    assert.deepEqual(plan({ desiredName: 'Deploy', desiredStatus: null, appliedName: 'Deploy ✅', heldSinceMs: nowMs, lastRenameAtMs: nowMs - 1_000, isOwnerChange: true }), { kind: 'now' });
  });

  it('does not let any other change skip them', () => {
    const lastRenameAtMs = nowMs - 1_000;
    assert.deepEqual(plan({ desiredName: 'Deploy ❗️', desiredStatus: 'stuck', appliedName: 'Deploy ⏳', lastRenameAtMs }), { kind: 'at', atMs: lastRenameAtMs + indicatorMinRenameGapMs });
  });
});

describe('names too long for the mark', () => {
  it('flags a base longer than the list shows with a mark after it', () => {
    assert.ok(!checkIsBaseTooLongForMark('x'.repeat(visibleBaseChars)));
    assert.ok(checkIsBaseTooLongForMark('x'.repeat(visibleBaseChars + 1)));
  });

  it('counts characters, not UTF-16 units', () => {
    assert.ok(!checkIsBaseTooLongForMark('😀'.repeat(visibleBaseChars)), 'an emoji is one character on a phone');
  });
});
