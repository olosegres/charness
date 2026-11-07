/**
 * @description The bonus API credit of an account billed to API credits (`utils/claudeApiCredit.ts`): the period its spend is
 * counted in (the operator's figure, the bot's detected renewal — the newer wins — else the first counted turn), the estimate
 * (spent; left when a figure or a grant is known; probably used up after a refusal that came inside the period; expired
 * past the operator's expiry day), the spend count that restarts with a new period, the day parser, and the anchors file —
 * read stamp-cached, written atomically by the command line, never overwritten when broken.
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
  getClaudeApiCreditPeriod,
  listProfilesWithSupersededCreditEvidence,
  parseClaudeApiCreditDay,
  readClaudeApiCreditAnchors,
  resetClaudeApiCreditCache,
  writeClaudeApiCreditAnchor,
  type ClaudeApiCreditAnchor,
  type ClaudeApiCreditInput,
} from '../utils/claudeApiCredit';

const nowMs = Date.parse('2026-11-07T10:00:00Z');
const anchor: ClaudeApiCreditAnchor = { remainingUsd: 67.71, grantUsd: 200, anchoredAt: '2026-11-07T08:00:00.000Z', expiresOn: '2026-11-15' };
const apiSpend = { since: '2026-11-01T00:00:00.000Z', totalUsd: 39.12 };
const renewedAt = '2026-11-07T09:00:00.000Z';

function estimate(overrides: Partial<ClaudeApiCreditInput> = {}) {
  return getClaudeApiCreditEstimate({ anchor, renewedAt: null, spend: undefined, apiSpend: undefined, creditExhaustedAt: null, nowMs, ...overrides });
}

describe('getClaudeApiCreditPeriod', () => {
  it('starts at the operator\'s figure, the bot\'s detected renewal — whichever is NEWER — else the account\'s first counted turn', () => {
    assert.deepEqual(getClaudeApiCreditPeriod({ anchor, renewedAt: null, apiSpend }), { basis: 'anchor', since: anchor.anchoredAt });
    assert.deepEqual(getClaudeApiCreditPeriod({ anchor, renewedAt: '2026-11-06T00:00:00.000Z', apiSpend }), { basis: 'anchor', since: anchor.anchoredAt }, 'a figure given after the renewal is newer news');
    assert.deepEqual(getClaudeApiCreditPeriod({ anchor, renewedAt, apiSpend }), { basis: 'renewal', since: renewedAt });
    assert.deepEqual(getClaudeApiCreditPeriod({ anchor: undefined, renewedAt, apiSpend }), { basis: 'renewal', since: renewedAt }, 'a renewal needs no figure');
    assert.deepEqual(getClaudeApiCreditPeriod({ anchor: undefined, renewedAt: null, apiSpend }), { basis: 'firstTurn', since: apiSpend.since });
    assert.deepEqual(getClaudeApiCreditPeriod({ anchor: undefined, renewedAt: null, apiSpend: undefined }), { basis: 'none', since: null });
    assert.deepEqual(getClaudeApiCreditPeriod({ anchor, renewedAt: anchor.anchoredAt, apiSpend }), { basis: 'anchor', since: anchor.anchoredAt }, 'at the same instant the figure wins');
  });
});

describe('getClaudeApiCreditEstimate: the operator\'s figure', () => {
  it('is the figure minus what the bot saw spent since, with the grant and the expiry the operator gave', () => {
    assert.deepEqual(estimate({ spend: { since: anchor.anchoredAt, usd: 6.51 } }), {
      status: 'available', basis: 'anchor', since: anchor.anchoredAt, spentUsd: 6.51, leftUsd: 61.2, grantUsd: 200, expiresOn: '2026-11-15', renewedAt: null, isProbablyUsedUp: false, unconfirmedSince: null,
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

  it('never goes below zero when the bot saw more spent than was left — only a refusal says «probably used up»', () => {
    assert.equal(estimate({ spend: { since: anchor.anchoredAt, usd: 80 } })?.leftUsd, 0);
    assert.equal(estimate({ spend: { since: anchor.anchoredAt, usd: 80 } })?.status, 'available');
  });

  it('ignores spend counted in an earlier period: a new figure starts the count over', () => {
    const stale = estimate({ spend: { since: '2026-11-01T00:00:00.000Z', usd: 40 } });
    assert.equal(stale?.spentUsd, 0);
    assert.equal(stale?.leftUsd, 67.71);
  });

  it('is probably used up after a refusal that came AFTER the figure, and not after an older one', () => {
    const after = estimate({ spend: { since: anchor.anchoredAt, usd: 6.51 }, creditExhaustedAt: '2026-11-07T09:00:00.000Z' });
    assert.equal(after?.status, 'probablyUsedUp');
    assert.equal(after?.leftUsd, 0);
    assert.equal(after?.spentUsd, 6.51, 'what it spent is still told');
    assert.equal(estimate({ creditExhaustedAt: '2026-11-06T09:00:00.000Z' })?.status, 'available', 'the refusal of the balance the figure replaced');
    assert.equal(estimate({ creditExhaustedAt: anchor.anchoredAt })?.status, 'available', 'at the very instant of the figure is not after it');
  });

  it('is expired once the expiry day is over — through the whole of that day it is not — and expired wins over probably used up', () => {
    assert.equal(estimate({ nowMs: Date.parse('2026-11-15T23:59:59Z') })?.status, 'available', 'the last day, last second');
    const over = estimate({ nowMs: Date.parse('2026-11-16T00:00:00Z'), spend: { since: anchor.anchoredAt, usd: 1 } });
    assert.equal(over?.status, 'expired');
    assert.equal(over?.leftUsd, 0);
    assert.equal(over?.expiresOn, '2026-11-15');
    assert.equal(estimate({ nowMs: Date.parse('2026-11-20T00:00:00Z'), creditExhaustedAt: '2026-11-07T09:00:00.000Z' })?.status, 'expired');
  });

  it('never expires without an expiry day', () => {
    const open = estimate({ anchor: { remainingUsd: 10, anchoredAt: anchor.anchoredAt }, nowMs: Date.parse('2030-01-01T00:00:00Z') });
    assert.equal(open?.status, 'available');
  });
});

describe('getClaudeApiCreditEstimate: a renewal the bot detected', () => {
  it('re-anchors on the LAST GIVEN grant: the counter is at zero, the expiry is unknown — never the figure\'s old one', () => {
    assert.deepEqual(estimate({ renewedAt, spend: { since: renewedAt, usd: 0 } }), {
      status: 'available', basis: 'renewal', since: renewedAt, spentUsd: 0, leftUsd: 200, grantUsd: 200, expiresOn: null, renewedAt, isProbablyUsedUp: false, unconfirmedSince: null,
    });
    assert.equal(estimate({ renewedAt, spend: { since: renewedAt, usd: 0.25 } })?.leftUsd, 199.75);
  });

  it('ignores the spend counted before the renewal', () => {
    const afterRenewal = estimate({ renewedAt, spend: { since: anchor.anchoredAt, usd: 6.51 } });
    assert.equal(afterRenewal?.spentUsd, 0);
    assert.equal(afterRenewal?.leftUsd, 200);
  });

  it('knows no remainder when no grant was ever given — only the renewal and the spend since', () => {
    const noGrant = estimate({ anchor: { remainingUsd: 10, anchoredAt: '2026-11-01T00:00:00.000Z' }, renewedAt, spend: { since: renewedAt, usd: 0.5 } });
    assert.equal(noGrant?.leftUsd, null);
    assert.equal(noGrant?.grantUsd, null);
    assert.equal(noGrant?.spentUsd, 0.5);
    assert.equal(estimate({ anchor: undefined, renewedAt, spend: { since: renewedAt, usd: 0.5 } })?.leftUsd, null, 'no figure at all');
  });

  it('is never expired by the old figure\'s expiry day', () => {
    assert.equal(estimate({ renewedAt, nowMs: Date.parse('2026-12-31T00:00:00Z') })?.status, 'available');
  });

  it('can be used up again: a refusal after the renewal', () => {
    const again = estimate({ renewedAt, creditExhaustedAt: '2026-11-07T09:30:00.000Z', spend: { since: renewedAt, usd: 1 } });
    assert.equal(again?.status, 'probablyUsedUp');
    assert.equal(again?.spentUsd, 1);
    assert.equal(again?.renewedAt, renewedAt);
  });
});

describe('getClaudeApiCreditEstimate: no figure', () => {
  it('tells the spend since the account\'s first counted turn', () => {
    assert.deepEqual(estimate({ anchor: undefined, apiSpend }), {
      status: 'available', basis: 'firstTurn', since: apiSpend.since, spentUsd: 39.12, leftUsd: null, grantUsd: null, expiresOn: null, renewedAt: null, isProbablyUsedUp: false, unconfirmedSince: null,
    });
  });

  it('is probably used up after a refusal, with or without anything counted', () => {
    const counted = estimate({ anchor: undefined, apiSpend, creditExhaustedAt: '2026-11-07T09:00:00.000Z' });
    assert.equal(counted?.status, 'probablyUsedUp');
    assert.equal(counted?.spentUsd, 39.12);
    const nothing = estimate({ anchor: undefined, creditExhaustedAt: '2026-11-07T09:00:00.000Z' });
    assert.deepEqual([nothing?.status, nothing?.since, nothing?.spentUsd, nothing?.leftUsd], ['probablyUsedUp', null, 0, null]);
  });

  it('has nothing to say with no figure, no renewal, no spend and no refusal', () => {
    assert.equal(estimate({ anchor: undefined }), null);
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

  it('lists the profiles whose evidence a figure has superseded — the mark or the refusal the operator acted on — and only those', () => {
    const records = {
      older: { creditExhaustedAt: '2026-11-06T09:00:00.000Z' },
      newer: { creditExhaustedAt: '2026-11-07T09:00:00.000Z' },
      noMark: {},
      noFigure: { creditExhaustedAt: '2026-11-01T09:00:00.000Z' },
      olderUnconfirmed: { creditUnconfirmedSince: '2026-11-06T09:00:00.000Z' },
      newerUnconfirmed: { creditUnconfirmedSince: '2026-11-07T09:00:00.000Z' },
    };
    const anchors = { older: anchor, newer: anchor, noMark: anchor, olderUnconfirmed: anchor, newerUnconfirmed: anchor };
    assert.deepEqual(listProfilesWithSupersededCreditEvidence(records, anchors), ['older', 'olderUnconfirmed'], 'a mark with no figure beside it stays');
    assert.deepEqual(listProfilesWithSupersededCreditEvidence(records, {}), []);
  });
});

describe('getClaudeApiCreditEstimate: the refusal the operator acted on', () => {
  const refusedAt = '2026-11-07T09:00:00.000Z';

  it('is «unconfirmed»: no claim of «used up», no stale remainder — the spend is still told', () => {
    const unconfirmed = estimate({ spend: { since: anchor.anchoredAt, usd: 6.51 }, creditUnconfirmedSince: refusedAt });
    assert.equal(unconfirmed?.status, 'unconfirmed');
    assert.equal(unconfirmed?.isProbablyUsedUp, false, 'the exclusion is lifted: an agent must not read it as refused');
    assert.equal(unconfirmed?.unconfirmedSince, refusedAt);
    assert.equal(unconfirmed?.leftUsd, null, 'the remainder the refusal just contradicted is not shown');
    assert.equal(unconfirmed?.spentUsd, 6.51);
  });

  it('the mark wins when both are there (a new refusal replaces it), an older refusal than the figure is ignored, and with nothing counted it still speaks', () => {
    assert.equal(estimate({ creditExhaustedAt: refusedAt, creditUnconfirmedSince: '2026-11-07T08:30:00.000Z' })?.status, 'probablyUsedUp');
    assert.equal(estimate({ creditUnconfirmedSince: '2026-11-06T09:00:00.000Z' })?.status, 'available');
    const bare = estimate({ anchor: undefined, creditUnconfirmedSince: refusedAt });
    assert.deepEqual([bare?.status, bare?.since], ['unconfirmed', null]);
  });

  it('expired outranks it on the line, and after a renewal a refusal older than the renewal is no news', () => {
    assert.equal(estimate({ creditUnconfirmedSince: refusedAt, nowMs: Date.parse('2026-11-20T00:00:00Z') })?.status, 'expired');
    assert.equal(estimate({ renewedAt: '2026-11-07T09:30:00.000Z', creditUnconfirmedSince: refusedAt })?.status, 'available');
  });
});

describe('getClaudeApiCreditEstimate: probably used up is read from the refusal, not from the line', () => {
  it('an expired credit with a pending refusal is still refused: the line says expired, isProbablyUsedUp says used up', () => {
    const both = estimate({ nowMs: Date.parse('2026-11-20T00:00:00Z'), creditExhaustedAt: '2026-11-07T09:00:00.000Z' });
    assert.equal(both?.status, 'expired');
    assert.equal(both?.isProbablyUsedUp, true);
    assert.equal(estimate({ nowMs: Date.parse('2026-11-20T00:00:00Z') })?.isProbablyUsedUp, false);
    assert.equal(estimate({ creditExhaustedAt: '2026-11-06T09:00:00.000Z' })?.isProbablyUsedUp, false, 'a refusal older than the figure is no refusal');
  });
});

describe('addClaudeApiCreditSpend', () => {
  const anchorPeriod = { basis: 'anchor', since: anchor.anchoredAt } as const;

  it('adds a turn to the count of the same period and starts over for another', () => {
    const first = addClaudeApiCreditSpend(undefined, anchorPeriod, 0.25);
    assert.deepEqual(first, { since: anchor.anchoredAt, usd: 0.25 });
    assert.deepEqual(addClaudeApiCreditSpend(first, anchorPeriod, 0.5), { since: anchor.anchoredAt, usd: 0.75 });
    const renewal = { basis: 'renewal', since: renewedAt } as const;
    assert.deepEqual(addClaudeApiCreditSpend(first, renewal, 0.5), { since: renewedAt, usd: 0.5 }, 'the old count belongs to the old period');
  });

  it('keeps no count of its own for a period that reads the account\'s whole spend, or none', () => {
    assert.equal(addClaudeApiCreditSpend(undefined, { basis: 'firstTurn', since: apiSpend.since }, 0.25), null);
    assert.equal(addClaudeApiCreditSpend(undefined, { basis: 'none', since: null }, 0.25), null);
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
