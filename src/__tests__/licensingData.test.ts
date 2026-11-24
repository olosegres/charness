/**
 * @description `licensing.json` is the machine-readable twin of `LICENSE` that people and AI agents read to decide whether
 * Charness needs a licence and what it costs. The binding text is `LICENSE`; these checks fail when the two disagree on a
 * figure (the free limits, the band and OEM tables, the discounts, the refund window, the contact),
 * and when an example price in `LICENSE` does not follow from its own discounts.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

type PriceBand = { name: string; revenuePlusFundingUpToUsd: number | null; groupPeopleUpTo: number | null; pricePerYearUsd: number };
type OemBand = { embeddedProductRevenueUpToUsd: number | null; pricePerYearUsd: number };
type LicensingData = {
  license: string;
  free: { organizationGroup: { maxRevenuePlusFundingUsd: number; maxGroupPeople: number }; evaluationDaysLessThan: number; growthTransitionDays: number };
  organizationLicence: { perUserOrSeatPricing: boolean; bands: PriceBand[] };
  oem: { bands: OemBand[] };
  discounts: { poweredByCharnessMarkPercent: number; prepaidTwoOrThreeYearsPercent: number };
  refundWithinDays: number;
  buy: { contact: string; checkout: string | null };
};

const repoRoot = path.resolve(__dirname, '..', '..');
const licenseText = fs.readFileSync(path.join(repoRoot, 'LICENSE'), 'utf8');
const licensingData: LicensingData = JSON.parse(fs.readFileSync(path.join(repoRoot, 'licensing.json'), 'utf8'));
const percentBase = 100;

/** `$1,000,000` / `1,000` → 1000000 / 1000. */
const getAmount = (text: string): number => Number(text.replace(/[$,]/g, ''));

/** The body rows of the first markdown table after `marker`, each split into trimmed cells. */
const getTableRows = (marker: string): string[][] => {
  const start = licenseText.indexOf(marker);
  assert.notEqual(start, -1, `LICENSE has no "${marker}"`);
  const lines = licenseText.slice(start).split('\n');
  const firstRow = lines.findIndex((line) => line.startsWith('|'));
  const tableLines = lines.slice(firstRow);
  const tableEnd = tableLines.findIndex((line) => !line.startsWith('|'));
  return tableLines
    .slice(2, tableEnd)
    .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()));
};

/** The upper bound of a cell such as `over $500,000, up to $2,000,000` or `21–50`; null for an open-ended `over …` cell. */
const getUpperBound = (cell: string): number | null => {
  const upTo = cell.match(/up to \$?([\d,]+)$/);
  if (upTo) return getAmount(upTo[1]);
  const range = cell.match(/^[\d,]+–([\d,]+)$/);
  if (range) return getAmount(range[1]);
  assert.match(cell, /^over /, `unexpected bound cell "${cell}"`);
  return null;
};

test('the title of LICENSE names the licence licensing.json describes', () => {
  assert.match(licenseText, new RegExp(`^# ${licensingData.license}$`, 'm'));
});

test('the free limits of LICENSE Part 1 are the ones in licensing.json', () => {
  const { maxRevenuePlusFundingUsd, maxGroupPeople } = licensingData.free.organizationGroup;
  const smallOrganizations = licenseText.match(/1\.2\. \*\*Small organizations\.\*\*[\s\S]*?USD\s+([\d,]+)\s+\*\*and\*\*[\s\S]*?at most (\d+)\./);
  assert.ok(smallOrganizations, 'LICENSE 1.2 lost its limits');
  assert.equal(getAmount(smallOrganizations[1]), maxRevenuePlusFundingUsd);
  assert.equal(Number(smallOrganizations[2]), maxGroupPeople);
  assert.match(licenseText, new RegExp(`less than ${licensingData.free.evaluationDaysLessThan} consecutive days`));
  assert.match(licenseText, new RegExp(`using\\s+Charness for ${licensingData.free.growthTransitionDays} days`));

  const [freeRow] = getTableRows('3.1. **Organization licence');
  assert.deepEqual(freeRow, ['Free', `up to $${maxRevenuePlusFundingUsd.toLocaleString('en-US')}`, `up to ${maxGroupPeople}`, '$0']);
});

test('the band table of LICENSE 3.1 is the one in licensing.json', () => {
  const paidRows = getTableRows('3.1. **Organization licence').slice(1);
  const bandsFromLicense = paidRows.map(([name, revenueCell, peopleCell, priceCell]): PriceBand => ({
    name,
    revenuePlusFundingUpToUsd: getUpperBound(revenueCell),
    groupPeopleUpTo: getUpperBound(peopleCell),
    pricePerYearUsd: getAmount(priceCell),
  }));
  assert.deepEqual(bandsFromLicense, licensingData.organizationLicence.bands);
  assert.equal(licensingData.organizationLicence.perUserOrSeatPricing, false);
  assert.match(licenseText, /never priced per user or per\s+seat/);
});

test('the OEM table of LICENSE 3.4 is the one in licensing.json', () => {
  const bandsFromLicense = getTableRows('3.4. **Embedded products').map(([revenueCell, priceCell]): OemBand => ({
    embeddedProductRevenueUpToUsd: getUpperBound(revenueCell),
    pricePerYearUsd: getAmount(priceCell),
  }));
  assert.deepEqual(bandsFromLicense, licensingData.oem.bands);
});


test('the discounts of LICENSE 3.6 are the ones in licensing.json, and every example price follows from them', () => {
  const { poweredByCharnessMarkPercent, prepaidTwoOrThreeYearsPercent } = licensingData.discounts;
  assert.match(licenseText, new RegExp(`\\*\\*Mark, ${poweredByCharnessMarkPercent} %\\.\\*\\*`));
  assert.match(licenseText, new RegExp(`\\*\\*Prepayment, ${prepaidTwoOrThreeYearsPercent} %\\.\\*\\*`));

  const markFactor = 1 - poweredByCharnessMarkPercent / percentBase;
  const prepaidFactor = 1 - prepaidTwoOrThreeYearsPercent / percentBase;
  const bothFactor = markFactor * prepaidFactor;
  assert.match(licenseText, new RegExp(`times ${markFactor.toFixed(2)} times ${prepaidFactor.toFixed(2)}, that is ${Math.round(bothFactor * percentBase)} %`));

  const examples = [...licenseText.matchAll(/\$([\d,]+) becomes \$([\d,]+)(?: with the\s+mark)?, \$([\d,]+)(?: prepaid)?,? (?:or )?\$([\d,]+)/g)];
  assert.equal(examples.length, 2, 'LICENSE 3.6 should give two worked examples');
  for (const [, listPrice, withMark, prepaid, withBoth] of examples) {
    const price = getAmount(listPrice);
    assert.equal(getAmount(withMark), Math.round(price * markFactor));
    assert.equal(getAmount(prepaid), Math.round(price * prepaidFactor));
    assert.equal(getAmount(withBoth), Math.round(price * bothFactor));
  }
  const threeYears = licenseText.match(/\$([\d,]+) a year \(\$([\d,]+) for three prepaid years\)/);
  assert.ok(threeYears, 'LICENSE 3.6 lost its three-year example');
  assert.equal(getAmount(threeYears[2]), getAmount(threeYears[1]) * 3);
});

test('the refund window, the contact and the checkout of LICENSE are the ones in licensing.json', () => {
  assert.match(licenseText, new RegExp(`A full refund within ${licensingData.refundWithinDays} days`));
  assert.ok(licenseText.includes(`Send an order to ${licensingData.buy.contact} with:`), 'LICENSE 3.7 names another contact');
  const checkoutLine = licenseText.match(/^Checkout: (.+)$/m);
  assert.ok(checkoutLine, 'LICENSE 3.7 lost its "Checkout:" line');
  if (licensingData.buy.checkout === null) assert.match(checkoutLine[1], /^none yet/);
  else assert.equal(checkoutLine[1], licensingData.buy.checkout);
});
