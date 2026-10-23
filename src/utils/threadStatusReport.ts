import { t } from '../i18n';
import type { AgentRuntimeInfo } from '../types';
import { formatClaudeUsageResetAt } from './claudeUsage';
import type { ClaudeProfileBilling } from './claudeProfiles';
import type { ClaudeApiSpend } from './claudeApiSpend';
import { formatClaudeApiSpendWords } from './claudeProfileUsageLines';

/** One Claude account profile as `/status` names it. */
export interface ThreadStatusAccountSource {
  name: string;
  /** What the last `claude auth status` read said; `null` when never probed. */
  email: string | null;
  /** That read's sign-in answer; `undefined` when never probed. A signed-out profile may keep an old email. */
  loggedIn: boolean | undefined;
  /** Raw ISO limit mark of the profile record; a mark in the past reads as no limit. */
  limitedUntil: string | null;
  /** How the account pays; `api` is marked on the row (every request costs money). Absent / `null`: a subscription. */
  billing?: ClaudeProfileBilling | null;
  /** When its API credits were found used up (marked on the row while it holds); absent / `null`: not marked. */
  creditExhaustedAt?: string | null;
  /** What an account billed to API credits spent through the bot (a line of its own under the row). */
  apiSpend?: ClaudeApiSpend;
}

export interface ThreadStatusAccount {
  /** The account the live process runs on — or, with no live process, the one its next start uses. */
  current: ThreadStatusAccountSource;
  /** The account the topic is now set to while the live process still runs on another (a deferred switch). */
  pending: ThreadStatusAccountSource | null;
  nowMs: number;
}

export interface ThreadStatusReportInput {
  agentLine: string;
  subdir: string;
  isActive: boolean;
  /** No live process, but the session is kept: the next message resumes it (lifecycle plan L3). */
  isSleeping: boolean;
  workDir: string | null;
  model: string | null;
  effort: string | null;
  /** The level the next start will use when it differs from `effort` (the default changed under the running session). */
  effortNextStart?: string | null;
  startedAt: string | null;
  runtime: AgentRuntimeInfo | null;
  /**
   * The Claude profile the topic's agent runs on; `null`/absent for a topic with no agent or a non-Claude one
   * (an OpenCode model label already names its provider).
   */
  account?: ThreadStatusAccount | null;
  /** The topic's view, already localized (`verbosity.view.*`). */
  view: string;
  /** Instance timezone, already resolved (stored pick, else the host zone). */
  timezone: string;
  /** That zone's current wall clock, e.g. `18:42 (+03:00)`. */
  timezoneNow: string;
}

/**
 * @description Render the per-topic `/status` report. Pure (locale comes from
 * the caller's async i18n context) and kept OUT of `bot.ts` so it is unit-testable
 * without importing the bot module, whose module-scope `parseEnv()` exits the
 * process when `TELEGRAM_BOT_TOKEN` is unset.
 *
 * Model / effort / start date / runtime rows are session properties: they are
 * meaningless once the session stopped, so a stopped thread renders only the
 * header, the bound working directory, the topic's view and the timezone.
 */
export function getThreadStatusReport({
  agentLine,
  subdir,
  isActive,
  isSleeping,
  workDir,
  model,
  effort,
  effortNextStart,
  startedAt,
  runtime,
  account,
  view,
  timezone,
  timezoneNow,
}: ThreadStatusReportInput): string {
  const lines = [
    t('status.thread_report', {
      agent: agentLine,
      subdir,
      session: isActive ? t('status.thread_running') : isSleeping ? t('status.thread_sleeping') : t('status.thread_stopped'),
    }),
  ];
  // A topic property like the folder: a stopped Claude topic still names the profile its next start uses.
  if (account) lines.push(...formatThreadStatusAccountLines(account, timezone));
  if (workDir !== null) lines.push(t('status.thread_workdir', { workDir }));
  // A topic property, not a session one (S6): named whether or not an agent runs.
  lines.push(t('status.thread_view', { view }));
  // Instance-wide, not a session property: it belongs ABOVE the early return so
  // a stopped thread still reports which clock its schedules will fire on.
  lines.push(t('timezone.status', { zone: timezone, now: timezoneNow }));
  if (!isActive) return lines.join('\n');

  if (model) lines.push(t('status.thread_model', { model }));
  if (effort) {
    lines.push(effortNextStart ? t('status.thread_effort_next_start', { effort, next: effortNextStart }) : t('status.thread_effort', { effort }));
  }
  if (startedAt) lines.push(t('status.thread_started', { started: startedAt }));
  const unavailable = t('version.unknown');
  lines.push(t('status.thread_runtime_version', { version: runtime?.version ?? unavailable }));
  lines.push(t('status.thread_context', {
    used: runtime?.contextUsedTokens ?? unavailable,
    limit: runtime?.contextWindowTokens ?? unavailable,
  }));

  return lines.join('\n');
}

/**
 * @description `name · email` like an `/accounts` row (`name · not signed in` once a probe said so, the name
 * alone when never probed), `· 💳 API` for an account billed to the API, plus the `/accounts` limit mark while it lies
 * in the future, reset in the instance zone.
 */
function formatAccount({ name, email, loggedIn, limitedUntil, billing, creditExhaustedAt }: ThreadStatusAccountSource, timezone: string, nowMs: number): string {
  const detail = loggedIn === false ? t('account.row.loggedOut') : email;
  const metered = billing === 'api' ? `${t('status.thread_account_api')}${creditExhaustedAt ? t('status.thread_account_exhausted') : ''}` : '';
  const limited = limitedUntil !== null && Date.parse(limitedUntil) > nowMs
    ? t('status.thread_account_limited', { until: formatClaudeUsageResetAt(limitedUntil, timezone, nowMs) })
    : '';
  return `${detail ? `${name} · ${detail}` : name}${metered}${limited}`;
}

/**
 * @description The `Account:` row of the `/status` report, the spend line of an account billed to API credits, and a
 * pending-switch row.
 */
export function formatThreadStatusAccountLines({ current, pending, nowMs }: ThreadStatusAccount, timezone: string): string[] {
  const lines = [t('status.thread_account', { account: formatAccount(current, timezone, nowMs) })];
  if (current.billing === 'api' && current.apiSpend) {
    lines.push(t('status.thread_api_spend', { name: current.name, ...formatClaudeApiSpendWords(current.apiSpend, timezone, nowMs) }));
  }
  if (pending !== null) lines.push(t('status.thread_account_pending', { account: formatAccount(pending, timezone, nowMs) }));
  return lines;
}

export interface ThreadStatusModelSources {
  /** Live model the adapter itself can name right now (`getCurrentModel`). */
  adapterModel: string | null;
  /** Model the runtime reports it ACTUALLY ran last ({@link AgentRuntimeInfo.model}). */
  runtimeModel: string | null;
  /** Model persisted on the agent row when the session was started. */
  persistedModel: string | null;
}

/**
 * @description Resolve the model `/status` names for a live session, most
 * authoritative source first.
 *
 * The runtime report sits in the MIDDLE on purpose: the Claude tmux backend
 * keeps its model inside the TUI, so its `getCurrentModel` is permanently null
 * and the runtime's self-report is the only model source there — without this
 * step `/status` named no model at all on that whole backend. It must still lose
 * to a live adapter value, which knows about a model switch the runtime has not
 * yet written a turn for.
 *
 * Each step falls through on any FALSY value, not just `null`: an adapter that
 * answers with an empty string knows no model either, and `??` let that empty
 * string win over a real runtime-reported one, rendering a blank `/status` row.
 */
export function getThreadStatusModel({
  adapterModel,
  runtimeModel,
  persistedModel,
}: ThreadStatusModelSources): string | null {
  return adapterModel || runtimeModel || persistedModel || null;
}
