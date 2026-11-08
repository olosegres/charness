/**
 * @description The views of the Claude profiles as the screens, the ranking and the report read them: a profile's record
 * (usage, marks, spend) plus the operator's credit figure (`utils/claudeApiCredit.ts`), and the credit fields of a report
 * entry that the bot's estimate fills for an API account.
 *
 * WHY this is not in `claudeUsage.ts`: that module is loaded by the connector guards, which run before any env file is read and
 * may load only their own small module set (`connectorGuards.test.ts`); the credit module reads a file and pulls its schema
 * library. The types stay in `claudeUsage.ts`; whatever needs the credit estimate lives here, imported by the bot and the CLI.
 */

import type { ClaudeProfileRecord } from '../state';
import { resolveClaudeProfileDir } from './claudeProfiles';
import { checkIsClaudeApiCreditMarkCurrent, getClaudeApiCreditEstimate, type ClaudeApiCreditAnchor, type ClaudeApiCreditAnchors } from './claudeApiCredit';
import { buildClaudeProfilesReport, type ClaudeLaunchPickOptions, type ClaudeProfileReportEntry, type ClaudeProfilesReport, type ClaudeProfileUsageView } from './claudeUsage';

/** @description One profile's view: its record's usage, marks and spend, plus the operator's credit figure (what `/accounts` and `/limits` render). */
export function buildClaudeProfileUsageView(input: {
  dataDir: string;
  name: string;
  /** The profile's record; `undefined` for a name nothing was recorded for. */
  record: ClaudeProfileRecord | undefined;
  /** The operator's credit figure for it (`readClaudeApiCreditAnchors`); `undefined` = none given. */
  creditAnchor?: ClaudeApiCreditAnchor;
}): ClaudeProfileUsageView {
  const { name, record, creditAnchor } = input;
  return {
    name,
    configDir: resolveClaudeProfileDir(input.dataDir, name),
    loggedIn: record?.loggedIn,
    email: record?.email ?? null,
    subscriptionType: record?.subscriptionType ?? null,
    usage: record?.usage,
    limitedUntil: record?.limitedUntil ?? null,
    billing: record?.billing ?? null,
    // A figure the operator gave after the refusal ends the mark (the bot clears the stored one when it reads the figures; a
    // reader of `state.json` alone, the command line, must see the same).
    creditExhaustedAt: record?.creditExhaustedAt && (!creditAnchor || checkIsClaudeApiCreditMarkCurrent(record.creditExhaustedAt, creditAnchor.anchoredAt)) ? record.creditExhaustedAt : null,
    ...(record?.creditUnconfirmedSince && (!creditAnchor || checkIsClaudeApiCreditMarkCurrent(record.creditUnconfirmedSince, creditAnchor.anchoredAt)) ? { creditUnconfirmedSince: record.creditUnconfirmedSince } : {}),
    ...(record?.apiSpend ? { apiSpend: record.apiSpend } : {}),
    ...(creditAnchor ? { creditAnchor } : {}),
    ...(record?.creditSpend ? { creditSpend: record.creditSpend } : {}),
    ...(record?.creditRenewedAt ? { creditRenewedAt: record.creditRenewedAt } : {}),
  };
}

/**
 * @description The ranking's view of every profile off the registry: `default` (its hidden record, when the
 * bot has written one) first, then the added profiles in creation order. Shared by the bot (live state) and
 * the CLI (`state.json` read directly).
 */
export function buildClaudeProfileUsageViews(input: {
  dataDir: string;
  /** Every record, the hidden `default` one included (`StateStore.getClaudeProfileInfo` / the raw file). */
  records: Readonly<Record<string, ClaudeProfileRecord>>;
  /** The operator's credit figures by profile name (`readClaudeApiCreditAnchors`); none = none given. */
  creditAnchors?: ClaudeApiCreditAnchors;
}): ClaudeProfileUsageView[] {
  // A `default` the operator signed out through /accounts stays out of every ranking until it is signed in again.
  const isDefaultRemoved = input.records.default?.isRemoved === true;
  const toView = (name: string, record: ClaudeProfileRecord | undefined): ClaudeProfileUsageView =>
    buildClaudeProfileUsageView({ dataDir: input.dataDir, name, record, creditAnchor: input.creditAnchors?.[name] });
  const added = Object.entries(input.records)
    .filter(([name]) => name !== 'default')
    .sort(([, a], [, b]) => a.createdAt.localeCompare(b.createdAt));
  return [...(isDefaultRemoved ? [] : [toView('default', input.records.default)]), ...added.map(([name, record]) => toView(name, record))];
}

/** The credit fields of a report entry: the bot's estimate for an API account, empty for any other. */
function getClaudeProfileReportCredit(profile: ClaudeProfileUsageView, nowMs: number): Pick<ClaudeProfileReportEntry, 'spentUsd' | 'remainingEstimateUsd' | 'expiresOn' | 'probablyUsedUp' | 'renewedAt'> {
  const estimate = profile.billing === 'api'
    ? getClaudeApiCreditEstimate({
      anchor: profile.creditAnchor,
      renewedAt: profile.creditRenewedAt,
      spend: profile.creditSpend,
      apiSpend: profile.apiSpend,
      creditExhaustedAt: profile.creditExhaustedAt,
      creditUnconfirmedSince: profile.creditUnconfirmedSince,
      nowMs,
    })
    : null;
  return {
    // Nothing counted yet (no figure, no renewal, no turn) is no count, not a count of zero.
    spentUsd: estimate && estimate.basis !== 'none' ? estimate.spentUsd : null,
    remainingEstimateUsd: estimate?.leftUsd ?? null,
    expiresOn: estimate?.expiresOn ?? null,
    // From the refusal itself, not from the line: an expired credit with a pending refusal is still refused.
    probablyUsedUp: estimate?.isProbablyUsedUp ?? false,
    renewedAt: estimate?.renewedAt ?? null,
  };
}

/**
 * @description `report` with the credit fields of every API account filled from its view (`views`, as the report was built from
 * them): `buildClaudeProfilesReport` leaves them empty. Entries keep their order; an entry without a view keeps its empty fields.
 */
export function addClaudeApiCreditToReport(report: ClaudeProfilesReport, views: readonly ClaudeProfileUsageView[], nowMs: number): ClaudeProfilesReport {
  return {
    ...report,
    profiles: report.profiles.map((entry): ClaudeProfileReportEntry => {
      const view = views.find((candidate) => candidate.name === entry.name);
      return view === undefined ? entry : { ...entry, ...getClaudeProfileReportCredit(view, nowMs) };
    }),
  };
}

/**
 * @description THE report an agent, the CLI or any other reader of the credit gets: {@link buildClaudeProfilesReport} (the
 * launch pick, the windows) with the credit fields of the API accounts filled from their views. `claude_profiles` (the bot) and
 * `charness claude-profiles` (the CLI) both call exactly this, so the CLI's end-to-end run proves the code the MCP tool runs —
 * never assemble "build + fill" by hand at a call site.
 */
export function buildClaudeProfilesCreditReport(
  views: readonly ClaudeProfileUsageView[],
  model: string | null,
  nowMs: number,
  options: ClaudeLaunchPickOptions = {},
): ClaudeProfilesReport {
  return addClaudeApiCreditToReport(buildClaudeProfilesReport(views, model, nowMs, options), views, nowMs);
}

/**
 * @description The API account a resumed agent's stop means the used-up credit of: the stop (`isStoppedByLimit`) came from an
 * account billed to API credits, which has no window to hit — its limit is the balance — and is not marked yet. `null` for any
 * other stop, or without one. The bot marks it (`creditExhaustedAt`) so the next pick moves on instead of sending every new
 * worker to the refused balance; the daily credit recheck ends a mark that turns out wrong.
 */
export function getApiProfileStoppedByAgent(
  views: readonly ClaudeProfileUsageView[],
  query: { currentProfile: string | null; isStoppedByLimit: boolean },
): string | null {
  if (!query.isStoppedByLimit || query.currentProfile === null) return null;
  const stopped = views.find((view) => view.name === query.currentProfile);
  return stopped !== undefined && stopped.billing === 'api' && stopped.creditExhaustedAt === null ? stopped.name : null;
}
