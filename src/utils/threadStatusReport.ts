import { t } from '../i18n';
import type { AgentRuntimeInfo } from '../types';

export interface ThreadStatusReportInput {
  agentLine: string;
  subdir: string;
  isActive: boolean;
  /** No live process, but the session is kept: the next message resumes it (lifecycle plan L3). */
  isSleeping: boolean;
  workDir: string | null;
  model: string | null;
  effort: string | null;
  startedAt: string | null;
  runtime: AgentRuntimeInfo | null;
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
  startedAt,
  runtime,
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
  if (workDir !== null) lines.push(t('status.thread_workdir', { workDir }));
  // A topic property, not a session one (S6): named whether or not an agent runs.
  lines.push(t('status.thread_view', { view }));
  // Instance-wide, not a session property: it belongs ABOVE the early return so
  // a stopped thread still reports which clock its schedules will fire on.
  lines.push(t('timezone.status', { zone: timezone, now: timezoneNow }));
  if (!isActive) return lines.join('\n');

  if (model) lines.push(t('status.thread_model', { model }));
  if (effort) lines.push(t('status.thread_effort', { effort }));
  if (startedAt) lines.push(t('status.thread_started', { started: startedAt }));
  const unavailable = t('version.unknown');
  lines.push(t('status.thread_runtime_version', { version: runtime?.version ?? unavailable }));
  lines.push(t('status.thread_context', {
    used: runtime?.contextUsedTokens ?? unavailable,
    limit: runtime?.contextWindowTokens ?? unavailable,
  }));

  return lines.join('\n');
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
