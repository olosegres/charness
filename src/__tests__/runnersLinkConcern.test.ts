/**
 * @description `runners/linkConcern.ts`: where a runner's link comes from, and when that is worth telling the operator. A job on the runner's machine
 * can read the runner's key, and «newest link wins» means a second connection with it silently replaces the first — so the gate records the address
 * of each link (`SSH_CLIENT`), and `charness runners ls` and the Telegram screen say when the SOURCE CHANGED (and whether the new link took the place
 * of one that was still up) or when links FIGHT (several changes within minutes).
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatLinkConcernNote,
  getLinkConcern,
  linkFightChangeCount,
  linkFightWindowMs,
  maxRecordedSourceChanges,
  parseSshClientSource,
  recordLinkSource,
  sourceChangeNoticeWindowMs,
  type LinkSourceChange,
  type PreviousLinkRecord,
} from '../runners/linkConcern';

const nowMs = Date.UTC(2026, 10, 3, 12, 0, 0);
const homeAddress = '198.51.100.7';
const otherAddress = '203.0.113.9';
const thirdAddress = '2001:db8::5';

function change(fromSource: string, toSource: string, ageMs: number, isLiveReplacement = false): LinkSourceChange {
  return { fromSource, toSource, atMs: nowMs - ageMs, isLiveReplacement };
}

describe('the address in SSH_CLIENT', () => {
  it('is the first word — an IPv4 or IPv6 address — and nothing else is ever recorded', () => {
    assert.equal(parseSshClientSource('198.51.100.7 51820 22'), homeAddress);
    assert.equal(parseSshClientSource('2001:db8::5 51820 22'), thirdAddress);
    assert.equal(parseSshClientSource('  198.51.100.7 51820 22\n'), homeAddress);
    assert.equal(parseSshClientSource('198.51.100.7'), homeAddress, 'the ports may be absent');
  });

  it('is nothing for an absent value, a name, an address with more in it, or text a client could have shaped', () => {
    for (const bad of [undefined, '', 'localhost 1 2', '198.51.100.7 51820', '198.51.100.7 x 22', '198.51.100.7; rm -rf / 1 2', '$(id) 1 2', `${'1'.repeat(80)} 1 2`, '\u001b[2J 1 2']) {
      assert.equal(parseSshClientSource(bad), null, JSON.stringify(bad));
    }
  });
});

describe('recording where a link comes from', () => {
  it('the first link, or one from the address of the one before it, changes nothing', () => {
    assert.deepEqual(recordLinkSource(null, homeAddress, nowMs, false), { source: homeAddress, sourceChanges: [] });
    assert.deepEqual(recordLinkSource({ source: homeAddress, sourceChanges: [] }, homeAddress, nowMs, true), { source: homeAddress, sourceChanges: [] });
  });

  it('another address is a change, with the address it came from, when, and whether the link before it was still up', () => {
    assert.deepEqual(recordLinkSource({ source: homeAddress, sourceChanges: [] }, otherAddress, nowMs, true), {
      source: otherAddress,
      sourceChanges: [{ fromSource: homeAddress, toSource: otherAddress, atMs: nowMs, isLiveReplacement: true }],
    });
    assert.equal(recordLinkSource({ source: homeAddress, sourceChanges: [] }, otherAddress, nowMs, false).sourceChanges[0].isLiveReplacement, false);
  });

  it('an unknown address — on either side — is no change: a file an older gate wrote, or sshd that told nothing, must not raise an alarm', () => {
    assert.deepEqual(recordLinkSource({ source: null, sourceChanges: [] }, otherAddress, nowMs, true).sourceChanges, []);
    assert.deepEqual(recordLinkSource({ source: homeAddress, sourceChanges: [] }, null, nowMs, true), { source: null, sourceChanges: [] });
  });

  it('keeps the earlier changes and only the last few', () => {
    let previous: PreviousLinkRecord = { source: homeAddress, sourceChanges: [] };
    const sources = [otherAddress, homeAddress, otherAddress, homeAddress, otherAddress, homeAddress, otherAddress];
    sources.forEach((source, index) => {
      previous = recordLinkSource(previous, source, nowMs + index, true);
    });
    assert.equal(previous.sourceChanges.length, maxRecordedSourceChanges);
    assert.equal(previous.sourceChanges.at(-1)?.atMs, nowMs + sources.length - 1, 'the newest is kept');
  });
});

describe('what is worth telling', () => {
  it('nothing without a change, or when the change is older than a day', () => {
    assert.equal(getLinkConcern(undefined, nowMs), null);
    assert.equal(getLinkConcern([], nowMs), null);
    assert.equal(getLinkConcern([change(homeAddress, otherAddress, sourceChangeNoticeWindowMs)], nowMs), null);
    assert.notEqual(getLinkConcern([change(homeAddress, otherAddress, sourceChangeNoticeWindowMs - 1)], nowMs), null);
  });

  it('one change within a day: the source changed — newest change, from where, to where, and whether it took a live link\'s place', () => {
    assert.deepEqual(getLinkConcern([change('192.0.2.1', homeAddress, 3 * 60 * 60 * 1000), change(homeAddress, otherAddress, 60 * 60 * 1000, true)], nowMs), {
      kind: 'sourceChanged',
      fromSource: homeAddress,
      toSource: otherAddress,
      atMs: nowMs - 60 * 60 * 1000,
      isLiveReplacement: true,
    });
  });

  it('three changes within ten minutes are a fight — the two addresses and how many times', () => {
    const burst = [change(homeAddress, otherAddress, 8 * 60 * 1000), change(otherAddress, homeAddress, 5 * 60 * 1000), change(homeAddress, otherAddress, 60 * 1000)];
    assert.equal(burst.length, linkFightChangeCount);
    assert.deepEqual(getLinkConcern(burst, nowMs), { kind: 'fighting', sources: [homeAddress, otherAddress], changeCount: 3 });
  });

  it('the same changes spread over hours are only a change — a machine that moved between networks twice is no fight', () => {
    const spread = [change(homeAddress, otherAddress, 5 * 60 * 60 * 1000), change(otherAddress, homeAddress, 3 * 60 * 60 * 1000), change(homeAddress, otherAddress, 60 * 60 * 1000)];
    assert.equal(getLinkConcern(spread, nowMs)?.kind, 'sourceChanged');
    const edge = [change(homeAddress, otherAddress, linkFightWindowMs), change(otherAddress, homeAddress, 5 * 60 * 1000), change(homeAddress, otherAddress, 60 * 1000)];
    assert.equal(getLinkConcern(edge, nowMs)?.kind, 'sourceChanged', 'a change just outside the window is not in the burst');
  });

  it('names at most three addresses of a fight', () => {
    const burst = [change(homeAddress, otherAddress, 4 * 60 * 1000), change(otherAddress, thirdAddress, 3 * 60 * 1000), change(thirdAddress, '192.0.2.1', 2 * 60 * 1000)];
    const concern = getLinkConcern(burst, nowMs);
    assert.equal(concern?.kind === 'fighting' ? concern.sources.length : -1, 3);
  });
});

describe('the note of `charness runners ls`', () => {
  const formatTime = (epochMs: number): string => `T${epochMs - nowMs}`;

  it('says where the link comes from now and where it did, and when', () => {
    const note = formatLinkConcernNote({ kind: 'sourceChanged', fromSource: homeAddress, toSource: otherAddress, atMs: nowMs - 5, isLiveReplacement: false }, formatTime);
    assert.equal(note, `(its link now comes from ${otherAddress}, before from ${homeAddress}, T-5)`);
  });

  it('says when it took the place of a link that was still up, and what to do', () => {
    const note = formatLinkConcernNote({ kind: 'sourceChanged', fromSource: homeAddress, toSource: otherAddress, atMs: nowMs, isLiveReplacement: true }, formatTime);
    assert.match(note, /taking the place of a link that was still up — if that is not a change of network of yours, remove this runner and pair it again: its key may be in use elsewhere\)$/);
  });

  it('says that links keep replacing each other, with the addresses and the number, and what to do', () => {
    const note = formatLinkConcernNote({ kind: 'fighting', sources: [homeAddress, otherAddress], changeCount: 4 }, formatTime);
    assert.equal(note, `(links from ${homeAddress}, ${otherAddress} keep replacing each other: 4 switches in 10 minutes — two machines may be using this runner's key; remove it and pair it again if that is not intended)`);
  });
});
