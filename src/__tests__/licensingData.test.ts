/**
 * @description `licensing.json` is the machine-readable twin of `LICENSE` that people and AI agents read to decide whether
 * Charness needs a licence and what it costs. The binding text is `LICENSE`; these checks fail when the two disagree on a
 * figure or rule (the notice's fixed text URL, the free limits, the band and OEM tables, the rules on models trained on Charness, the
 * discounts, the refund window, the contact, the buying steps), and when an example price in `LICENSE` does not follow
 * from its own discounts or a band does not start where the one before it ends.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

type PriceBand = { name: string; revenuePlusFundingUpToUsd: number | null; groupPeopleUpTo: number | null; pricePerYearUsd: number };
type OemBand = { embeddedProductRevenueUpToUsd: number | null; pricePerYearUsd: number };
type FreeUse = {
  personalUse: boolean;
  organizationGroup: { maxRevenuePlusFundingUsd: number; maxGroupPeople: number; bothRequired: boolean };
  educationAndPublicBenefit: boolean;
  evaluationDaysLessThan: number;
  growthTransitionDays: number;
  earlierMitUsersDays: number;
};
/** Each yes-or-no rule of `licensing.json` about models trained on Charness, and the LICENSE sentence that states it. */
const modelRuleSentences = {
  trainingAllowed: 'Training or fine-tuning a machine-learning model on Charness code or commits is allowed.',
  oneLicenceCoversModels: 'One licence covers Charness and the models trained on it.',
  publishOnlyWithThisLicence: 'Such a model may be published or offered to others, as open weights or as a service, only together with this licence',
  usersFollowCharnessRules: 'follows the same rules as a user of Charness: the use is free where Part 1 makes it free',
  noSecondFeeForUsers: 'owes no second fee for using a model trained on Charness',
  sellersAndOfferersNeedTheirBandLicence: 'holds its organization licence for its band for every year in which it does so, whatever Part 1 would otherwise allow',
  generalModelTrainerPays: 'the organization that trained it pays as in (d) while it sells or offers the model',
  generalModelUsersExempt: 'The groups that only use it, by sending it requests or by running its weights, owe nothing for it.',
  modelsMadeFromSuchAModelAreCovered: 'A model made from such a model — further trained, merged, quantized or distilled from it — is such a model too.',
  furtherTrainingAGeneralModelOnOtherDataExempt: "That stays so when they further train it on other data — the group's own data of (c) included, but not sessions that (c) counts under (a) — and use, sell or offer the result; that does not make them its trainer.",
  pickedOwnSessionsAreTrainingOnPurpose: 'Sessions picked in order to teach a model what Charness gave its agents (its prompts, skills, tool descriptions and guidance, or how its agents follow them) are a training set picked to include Charness: such a model is trained on Charness on purpose, under (a).',
  ownAgentSessionsExempt: "A model trained on the group's own code, documents or agent sessions is not trained on Charness merely because Charness ran those agents",
  serviceUsersFollowCharnessRules: 'Whoever uses it, by running its weights or by sending it requests, follows the same rules as a user of Charness',
  usersOweNothingBeforeTheyKnow: 'A group owes nothing for its use of such a model before it knows, or the licensor tells it in writing, that the model was trained on Charness.',
  runsFromWhenTheGroupKnows: 'the day the group knows, or the licensor tells it in writing, that the model was trained on Charness',
} as const;
type ModelsTrainedOnCharness = Record<keyof typeof modelRuleSentences, boolean> & { summary: string };
type LicensingData = {
  license: string;
  licenseText: string;
  sourceAvailable: boolean;
  openSource: boolean;
  telemetry: boolean;
  free: FreeUse;
  organizationLicence: { perUserOrSeatPricing: boolean; bands: PriceBand[] };
  derivedCode: { codeWrittenWithCharnessIsYours: boolean; generalModelOutputNotDerived: boolean; purposeTrainedModelOutputDerivedOnlyAsAPersonsWouldBe: boolean; terms: string };
  modelsTrainedOnCharness: ModelsTrainedOnCharness;
  oem: { rule: string; bands: OemBand[] };
  discounts: { poweredByCharnessMarkPercent: number; prepaidTwoOrThreeYearsPercent: number; combined: string };
  refundWithinDays: number;
  buy: { contact: string; checkout: string | null; agentsMayBuy: boolean; steps: string[] };
};

const repoRoot = path.resolve(__dirname, '..', '..');
const licenseText = fs.readFileSync(path.join(repoRoot, 'LICENSE'), 'utf8');
const licensingData: LicensingData = JSON.parse(fs.readFileSync(path.join(repoRoot, 'licensing.json'), 'utf8'));
const percentBase = 100;

/** `LICENSE` with every run of whitespace as one space, so a check does not depend on where the text wraps. */
const flatLicenseText = licenseText.replace(/\s+/g, ' ');

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

/** The lower bound of a cell such as `over $500,000, up to $2,000,000` (exclusive) or `21–50` (inclusive), as the last value
 * of the band below it; null for a first-row `up to …` cell. */
const getPreviousUpperBound = (cell: string): number | null => {
  const over = cell.match(/^over \$?([\d,]+)/);
  if (over) return getAmount(over[1]);
  const range = cell.match(/^([\d,]+)–/);
  if (range) return getAmount(range[1]) - 1;
  assert.match(cell, /^up to /, `unexpected bound cell "${cell}"`);
  return null;
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

test('the title and the Required Notice of LICENSE name the licence and the fixed text licensing.json points at', () => {
  assert.match(licenseText, new RegExp(`^# ${licensingData.license}$`, 'm'));
  assert.ok(licenseText.includes(`Required Notice: Licensed under the ${licensingData.license}: ${licensingData.licenseText}\n`), 'the notice names another text');
});

test('the free limits of LICENSE Part 1 are the ones in licensing.json', () => {
  const { maxRevenuePlusFundingUsd, maxGroupPeople } = licensingData.free.organizationGroup;
  const smallOrganizations = licenseText.match(/1\.2\. \*\*Small organizations\.\*\*[\s\S]*?USD\s+([\d,]+)\s+\*\*and\*\*[\s\S]*?at most (\d+)\./);
  assert.ok(smallOrganizations, 'LICENSE 1.2 lost its limits');
  assert.equal(getAmount(smallOrganizations[1]), maxRevenuePlusFundingUsd);
  assert.equal(Number(smallOrganizations[2]), maxGroupPeople);
  assert.match(licenseText, new RegExp(`less than ${licensingData.free.evaluationDaysLessThan} consecutive days`));
  assert.match(licenseText, new RegExp(`using\\s+Charness for ${licensingData.free.growthTransitionDays} days`));
  assert.match(flatLicenseText, new RegExp(`may use releases under the Charness License for ${licensingData.free.earlierMitUsersDays} days from that first use`));

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
  const allRows = getTableRows('3.1. **Organization licence');
  for (const [index, [name, revenueCell, peopleCell]] of allRows.entries()) {
    const [, previousRevenueCell, previousPeopleCell] = allRows[index - 1] ?? [];
    assert.equal(getPreviousUpperBound(revenueCell), previousRevenueCell === undefined ? null : getUpperBound(previousRevenueCell), `${name}: R starts where the band below ends`);
    assert.equal(getPreviousUpperBound(peopleCell), previousPeopleCell === undefined ? null : getUpperBound(previousPeopleCell), `${name}: H starts where the band below ends`);
  }
  assert.equal(licensingData.organizationLicence.perUserOrSeatPricing, false);
  assert.match(licenseText, /never priced per user or per\s+seat/);
});

test('the OEM table of LICENSE 3.4 is the one in licensing.json', () => {
  const bandsFromLicense = getTableRows('3.4. **Embedded products').map(([revenueCell, priceCell]): OemBand => ({
    embeddedProductRevenueUpToUsd: getUpperBound(revenueCell),
    pricePerYearUsd: getAmount(priceCell),
  }));
  assert.deepEqual(bandsFromLicense, licensingData.oem.bands);
  assert.match(licensingData.oem.rule, /greater of its organization licence fee and the OEM amount, never their sum/);
  assert.match(flatLicenseText, /pays the \*\*greater\*\* of its organization licence fee \(section 3\.1\) and the OEM amount, never their sum/);
});

test('the rules on models trained on Charness (LICENSE 2.5 and 3.3) are the ones in licensing.json', () => {
  const { summary, ...rules } = licensingData.modelsTrainedOnCharness;
  assert.match(summary, /LICENSE 2\.5 and 3\.3/, 'the summary points at the clauses it summarises');
  assert.deepEqual(Object.keys(rules).sort(), Object.keys(modelRuleSentences).sort(), 'every rule has its LICENSE sentence');
  const sentences = new Map<string, string>(Object.entries(modelRuleSentences));
  for (const [rule, isStated] of Object.entries(rules)) {
    const sentence = sentences.get(rule);
    assert.ok(sentence !== undefined, `${rule} has no LICENSE sentence`);
    assert.equal(isStated, flatLicenseText.includes(sentence), `${rule}: ${sentence}`);
  }
  assert.ok(!flatLicenseText.includes('on top of the organization licence'), 'no second fee on top of the licence');
  assert.ok(flatLicenseText.includes('Keep the paid invoice or its receipt: either is your licence'), 'LICENSE 3.7 asks for more than one proof');
});

test('the discounts of LICENSE 3.6 are the ones in licensing.json, and every example price follows from them', () => {
  const { poweredByCharnessMarkPercent, prepaidTwoOrThreeYearsPercent } = licensingData.discounts;
  assert.match(licenseText, new RegExp(`\\*\\*Mark, ${poweredByCharnessMarkPercent} %\\.\\*\\*`));
  assert.match(licenseText, new RegExp(`\\*\\*Prepayment, ${prepaidTwoOrThreeYearsPercent} %\\.\\*\\*`));

  const markFactor = 1 - poweredByCharnessMarkPercent / percentBase;
  const prepaidFactor = 1 - prepaidTwoOrThreeYearsPercent / percentBase;
  const bothFactor = markFactor * prepaidFactor;
  assert.match(licenseText, new RegExp(`times ${markFactor.toFixed(2)} times ${prepaidFactor.toFixed(2)}, that is ${Math.round(bothFactor * percentBase)} %`));
  assert.equal(licensingData.discounts.combined, `multiply: ${markFactor.toFixed(2)} × ${prepaidFactor.toFixed(2)} = ${Math.round(bothFactor * percentBase)} % of the price`);

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

test('the buying steps of licensing.json are the numbered steps of LICENSE 3.7, word for word', () => {
  const howToBuy = licenseText.slice(licenseText.indexOf('3.7. **How to buy.**'), licenseText.indexOf('3.8. **Refunds.**'));
  const stepsFromLicense = [...howToBuy.matchAll(/^\d+\. ([\s\S]*?)(?=\n\d+\. |\n\n|(?![\s\S]))/gm)].map(([, step]) => step.replace(/\s+/g, ' ').trim());
  assert.ok(stepsFromLicense.length > 0, 'LICENSE 3.7 lost its steps');
  assert.deepEqual(licensingData.buy.steps, stepsFromLicense);
});

test('the yes-or-no facts of licensing.json are what LICENSE says', () => {
  const { free, buy } = licensingData;
  assert.equal(licensingData.sourceAvailable, flatLicenseText.includes('Charness is **source available**, not open source'));
  assert.equal(licensingData.openSource, !flatLicenseText.includes('not open source'));
  assert.equal(licensingData.telemetry, !flatLicenseText.includes('There are no licence keys, activation, compliance telemetry or remote shutdown'));
  assert.equal(free.personalUse, flatLicenseText.includes('1.1. **Personal use.**'));
  assert.equal(free.organizationGroup.bothRequired, flatLicenseText.includes('Both must hold'));
  assert.equal(free.educationAndPublicBenefit, flatLicenseText.includes('1.3. **Education and public benefit.**'));
  assert.equal(buy.agentsMayBuy, flatLicenseText.includes('An agent may buy on its own when the organization lets it spend'));
  assert.equal(licensingData.derivedCode.codeWrittenWithCharnessIsYours, flatLicenseText.includes('2.4. **Your own work.** Using Charness to write code never makes that code derived from Charness.'));
  assert.equal(licensingData.derivedCode.terms, 'LICENSE 2.3–2.4');
  assert.equal(licensingData.derivedCode.generalModelOutputNotDerived, flatLicenseText.includes("Nor does an AI model's having learned from a general collection of public code that merely includes Charness (section 3.3(b)) make what it writes derived."));
  assert.equal(licensingData.derivedCode.purposeTrainedModelOutputDerivedOnlyAsAPersonsWouldBe, flatLicenseText.includes("is derived only where section 2.3 would reach the same work written by a person who had read Charness's code; ordinary code written with such a model stays the user's."));
});

test("LICENSE says plainly that using Charness to write code never makes that code derived (the owner's rule)", () => {
  assert.ok(flatLicenseText.includes('2.4. **Your own work.** Using Charness to write code never makes that code derived from Charness.'));
  assert.ok(flatLicenseText.includes('never because Charness was used to write it'));
  assert.ok(flatLicenseText.includes("What Charness itself gives an agent while it runs — its prompts, skills, tool descriptions, instructions and compaction guidance — and the agent's following them never make the agent's work derived, even where that work applies the approaches they describe"));
  assert.ok(flatLicenseText.includes("Section 2.3 reaches only work built on Charness code or commits, and a copy or adaptation of the texts of Charness's own prompts, skills or descriptions as such (for example a skill or prompt made from them)."));
  assert.ok(flatLicenseText.includes('The commands, settings and files an agent writes while following them, in the work they guide, are following them, not a copy.'));
  assert.ok(flatLicenseText.includes('**Charness code or commits:** the source and the commit history the licensor publishes for Charness.'));
});
