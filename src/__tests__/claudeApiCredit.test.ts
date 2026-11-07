/**
 * @description The bonus API credit of an account billed to API credits (`utils/claudeApiCredit.ts`): the estimate
 * (`anchored amount − spend since`, used up after a refusal that came later, expired past its day), the spend count that
 * restarts with a new anchor, the day parser, and the anchors file — read stamp-cached, written atomically by the command
 * line, never overwritten when broken.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  addClaudeApiCreditSpend,
  checkIsClaudeApiCreditExpired,
  checkIsClaudeApiCreditMarkCurrent,
  claudeApiCreditFileName,
  getClaudeApiCreditEstimate,
  listProfilesWithSupersededCreditMark,
  parseClaudeApiCreditDay,
  readClaudeApiCreditAnchors,
  resetClaudeApiCreditCache,
  writeClaudeApiCreditAnchor,
  type ClaudeApiCreditAnchor,
} from '../utils/claudeApiCredit';

const nowMs = Date.parse('2026-11-07T10:00:00Z');
const anchor: ClaudeApiCreditAnchor = { remainingUsd: 67.71, grantUsd: 200, anchoredAt: '2026-11-07T08:00:00.000Z', expiresOn: '2026-11-15' };

function estimate(overrides: { anchor?: ClaudeApiCreditAnchor | undefined; spendUsd?: number; spendAnchoredAt?: string; creditExhaustedAt?: string | null; nowMs?: number } = {}) {
  const usedAnchor = 'anchor' in overrides ? overrides.anchor : anchor;
  return getClaudeApiCreditEstimate({
    anchor: usedAnchor,
    spend: overrides.spendUsd === undefined ? undefined : { anchoredAt: overrides.spendAnchoredAt ?? anchor.anchoredAt, usd: overrides.spendUsd },
    creditExhaustedAt: overrides.creditExhaustedAt ?? null,
    nowMs: overrides.nowMs ?? nowMs,
  });
}

describe('getClaudeApiCreditEstimate', () => {
  it('has no estimate without an anchor', () => {
    assert.equal(estimate({ anchor: undefined, spendUsd: 3 }), null);
  });

  it('is the anchored amount minus what the bot saw spent since, with the grant and the expiry the operator gave', () => {
    assert.deepEqual(estimate({ spendUsd: 6.51 }), {
      status: 'available', leftUsd: 61.2, grantUsd: 200, spentUsd: 6.51, anchoredAt: anchor.anchoredAt, expiresOn: '2026-11-15',
    }, '67.71 − 6.51');
    assert.equal(estimate()?.spentUsd, 0, 'nothing spent yet');
    assert.equal(estimate()?.leftUsd, 67.71);
  });

  it('leaves out the grant and the expiry when the operator gave neither', () => {
    const bare = estimate({ anchor: { remainingUsd: 10, anchoredAt: anchor.anchoredAt } });
    assert.equal(bare?.grantUsd, null);
    assert.equal(bare?.expiresOn, null);
    assert.equal(bare?.status, 'available');
  });

  it('never goes below zero when the bot saw more spent than was left', () => {
    assert.equal(estimate({ spendUsd: 80 })?.leftUsd, 0);
    assert.equal(estimate({ spendUsd: 80 })?.status, 'available', 'only a refusal marks it used up');
  });

  it('ignores spend counted from an earlier anchor: a new figure starts the count over', () => {
    const stale = estimate({ spendUsd: 40, spendAnchoredAt: '2026-11-01T00:00:00.000Z' });
    assert.equal(stale?.spentUsd, 0);
    assert.equal(stale?.leftUsd, 67.71);
  });

  it('is used up by a refusal that came AFTER the anchor, and not by an older one', () => {
    const after = estimate({ spendUsd: 6.51, creditExhaustedAt: '2026-11-07T09:00:00.000Z' });
    assert.equal(after?.status, 'usedUp');
    assert.equal(after?.leftUsd, 0);
    assert.equal(after?.spentUsd, 6.51, 'what it spent is still told');
    assert.equal(after?.expiresOn, '2026-11-15');
    assert.equal(estimate({ creditExhaustedAt: '2026-11-06T09:00:00.000Z' })?.status, 'available', 'the refusal of the balance the figure replaced');
    assert.equal(estimate({ creditExhaustedAt: anchor.anchoredAt })?.status, 'available', 'at the very instant of the figure is not after it');
  });

  it('is expired once the expiry day is over — through the whole of that day it is not', () => {
    assert.equal(estimate({ nowMs: Date.parse('2026-11-15T23:59:59Z') })?.status, 'available', 'the last day, last second');
    const over = estimate({ nowMs: Date.parse('2026-11-16T00:00:00Z'), spendUsd: 1 });
    assert.equal(over?.status, 'expired');
    assert.equal(over?.leftUsd, 0);
    assert.equal(over?.expiresOn, '2026-11-15');
  });

  it('expired wins over used up', () => {
    assert.equal(estimate({ nowMs: Date.parse('2026-11-20T00:00:00Z'), creditExhaustedAt: '2026-11-07T09:00:00.000Z' })?.status, 'expired');
  });

  it('never expires without an expiry day', () => {
    const open = estimate({ anchor: { remainingUsd: 10, anchoredAt: anchor.anchoredAt }, nowMs: Date.parse('2030-01-01T00:00:00Z') });
    assert.equal(open?.status, 'available');
  });
});

describe('the used-up mark next to the operator\'s figure', () => {
  it('is current only when the refusal came after the figure', () => {
    assert.equal(checkIsClaudeApiCreditMarkCurrent('2026-11-07T09:00:00.000Z', anchor.anchoredAt), true);
    assert.equal(checkIsClaudeApiCreditMarkCurrent(anchor.anchoredAt, anchor.anchoredAt), false, 'the same instant is not after it');
    assert.equal(checkIsClaudeApiCreditMarkCurrent('2026-11-06T09:00:00.000Z', anchor.anchoredAt), false);
    assert.equal(checkIsClaudeApiCreditMarkCurrent(undefined, anchor.anchoredAt), false);
    assert.equal(checkIsClaudeApiCreditMarkCurrent(null, anchor.anchoredAt), false);
  });

  it('lists the profiles whose mark a figure has superseded — and only those', () => {
    const records = {
      older: { creditExhaustedAt: '2026-11-06T09:00:00.000Z' },
      newer: { creditExhaustedAt: '2026-11-07T09:00:00.000Z' },
      noMark: {},
      noFigure: { creditExhaustedAt: '2026-11-01T09:00:00.000Z' },
    };
    const anchors = { older: anchor, newer: anchor, noMark: anchor };
    assert.deepEqual(listProfilesWithSupersededCreditMark(records, anchors), ['older'], 'a mark with no figure beside it stays');
    assert.deepEqual(listProfilesWithSupersededCreditMark(records, {}), []);
  });
});

describe('addClaudeApiCreditSpend', () => {
  it('adds a turn to the count of the same anchor and starts over for another', () => {
    const first = addClaudeApiCreditSpend(undefined, anchor, 0.25);
    assert.deepEqual(first, { anchoredAt: anchor.anchoredAt, usd: 0.25 });
    assert.deepEqual(addClaudeApiCreditSpend(first, anchor, 0.5), { anchoredAt: anchor.anchoredAt, usd: 0.75 });
    const newAnchor = { ...anchor, anchoredAt: '2026-11-08T08:00:00.000Z' };
    assert.deepEqual(addClaudeApiCreditSpend(first, newAnchor, 0.5), { anchoredAt: newAnchor.anchoredAt, usd: 0.5 }, 'the old count belongs to the old figure');
  });
});

describe('checkIsClaudeApiCreditExpired and parseClaudeApiCreditDay', () => {
  it('reads the expiry as a UTC day: expired from its next midnight', () => {
    assert.equal(checkIsClaudeApiCreditExpired('2026-11-15', Date.parse('2026-11-15T12:00:00Z')), false);
    assert.equal(checkIsClaudeApiCreditExpired('2026-11-15', Date.parse('2026-11-16T00:00:00Z')), true);
    assert.equal(checkIsClaudeApiCreditExpired('not a day', nowMs), false, 'an unreadable day never expires a credit');
  });

  it('accepts a real calendar day only', () => {
    assert.equal(parseClaudeApiCreditDay('2026-11-15'), '2026-11-15');
    assert.equal(parseClaudeApiCreditDay('2028-02-29'), '2028-02-29', 'a leap day');
    for (const text of ['2026-02-30', '2026-13-01', '2026-11-5', '15.11.2026', '2026-11-15T00:00:00Z', '', ' 2026-11-15']) {
      assert.equal(parseClaudeApiCreditDay(text), null, text);
    }
  });
});

describe('the anchors file', () => {
  let dataDir = '';
  const filePath = () => path.join(dataDir, claudeApiCreditFileName);

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-api-credit-'));
    resetClaudeApiCreditCache();
  });

  afterEach(() => {
    mock.restoreAll();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('reads as no anchors when the file is missing', () => {
    assert.deepEqual(readClaudeApiCreditAnchors(dataDir), {});
  });

  it('writes an anchor per profile, keeps the others, replaces one, and removes one', () => {
    writeClaudeApiCreditAnchor(dataDir, 'work', anchor);
    writeClaudeApiCreditAnchor(dataDir, 'spare', { remainingUsd: 5, anchoredAt: '2026-11-07T09:00:00.000Z' });
    assert.deepEqual(readClaudeApiCreditAnchors(dataDir), { work: anchor, spare: { remainingUsd: 5, anchoredAt: '2026-11-07T09:00:00.000Z' } });

    const replaced = { ...anchor, remainingUsd: 12 };
    writeClaudeApiCreditAnchor(dataDir, 'work', replaced);
    assert.deepEqual(readClaudeApiCreditAnchors(dataDir).work, replaced, 'a re-written file shows at once, no restart');

    writeClaudeApiCreditAnchor(dataDir, 'work', null);
    assert.deepEqual(Object.keys(readClaudeApiCreditAnchors(dataDir)), ['spare']);
    assert.equal(fs.statSync(filePath()).mode & 0o777, 0o600, 'owner-only');
  });

  it('removing a profile that has no anchor writes nothing and says so', () => {
    assert.equal(writeClaudeApiCreditAnchor(dataDir, 'work', null), false);
    assert.equal(fs.existsSync(filePath()), false);
    assert.equal(writeClaudeApiCreditAnchor(dataDir, 'work', anchor), true);
    assert.equal(writeClaudeApiCreditAnchor(dataDir, 'work', null), true);
  });

  it('serves the last good anchors from a file that broke, and says why ONCE — never the value', () => {
    writeClaudeApiCreditAnchor(dataDir, 'work', anchor);
    assert.deepEqual(readClaudeApiCreditAnchors(dataDir), { work: anchor });
    const warnings: string[] = [];
    mock.method(console, 'warn', (line: string) => warnings.push(line));
    fs.writeFileSync(filePath(), JSON.stringify({ work: { ...anchor, remainingUsd: -3 } }));
    assert.deepEqual(readClaudeApiCreditAnchors(dataDir), { work: anchor }, 'the last good copy');
    readClaudeApiCreditAnchors(dataDir);
    assert.equal(warnings.length, 1, 'one line per broken state, not per read');
    assert.match(warnings[0], /claudeApiCredit\.json work\.remainingUsd/);
    assert.ok(!warnings[0].includes('-3'), 'the field is named, the value is not');
  });

  it('shows nothing from a file that was never valid', () => {
    mock.method(console, 'warn', () => undefined);
    fs.writeFileSync(filePath(), '{ not json');
    assert.deepEqual(readClaudeApiCreditAnchors(dataDir), {});
  });

  it('rejects what the command line would never write: a remainder over the grant, a bad day, an unknown field', () => {
    mock.method(console, 'warn', () => undefined);
    for (const broken of [
      { remainingUsd: 300, grantUsd: 200, anchoredAt: anchor.anchoredAt },
      { remainingUsd: 10, anchoredAt: anchor.anchoredAt, expiresOn: '2026-02-30' },
      { remainingUsd: 10, anchoredAt: 'yesterday' },
      { remainingUsd: 10, anchoredAt: anchor.anchoredAt, note: 'x' },
      { remainingUsd: 10, grantUsd: 0, anchoredAt: anchor.anchoredAt },
    ]) {
      resetClaudeApiCreditCache();
      fs.writeFileSync(filePath(), JSON.stringify({ work: broken }));
      assert.deepEqual(readClaudeApiCreditAnchors(dataDir), {}, JSON.stringify(broken));
    }
  });

  it('never overwrites a broken file: it holds the other profiles\' figures', () => {
    mock.method(console, 'warn', () => undefined);
    fs.writeFileSync(filePath(), '{ not json');
    assert.throws(() => writeClaudeApiCreditAnchor(dataDir, 'work', anchor), /fix or delete/);
    assert.throws(() => writeClaudeApiCreditAnchor(dataDir, 'work', null), /fix or delete/, 'removing is no exception: «no figure» would be a lie about a file that may hold it');
    assert.equal(fs.readFileSync(filePath(), 'utf8'), '{ not json');
  });

  it('refuses to write an invalid anchor', () => {
    assert.throws(() => writeClaudeApiCreditAnchor(dataDir, 'work', { ...anchor, remainingUsd: 500 }), /refusing to write an invalid/);
    assert.equal(fs.existsSync(filePath()), false);
  });
});
