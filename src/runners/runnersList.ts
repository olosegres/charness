import type { PendingPairing, RunnerServiceKind } from './hubRegistry';
import { formatLinkConcernNote } from './linkConcern';
import { getCurrentServiceKind } from './runnerServiceKind';
import type { OverviewEntry } from './runnersOverview';

/**
 * @description The text of `charness runners ls`: one line per paired runner (name, online or offline since when, paused, OS, how it
 * is kept running, version) and a line for each pairing code still open. Pure: the entries — the same ones the `/runners` screen is built
 * from, with the probe — are read by the caller, and how a runner is kept running is the one rule of `getCurrentServiceKind`.
 */

export const serviceKindLabels: Record<RunnerServiceKind, string> = {
  foreground: 'run by hand',
  'user-service': 'user service',
  'system-service': 'system service',
  unknown: 'service unknown',
};

/** @description `2026-11-01 14:05` in the zone of this process. */
export function formatListTimestamp(epochMs: number): string {
  const date = new Date(epochMs);
  const pad = (value: number): string => value.toString().padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function describeConnection(entry: OverviewEntry): string {
  if (entry.isOnline) return 'online';
  return entry.lastSeenMs === null ? 'offline, never connected' : `offline since ${formatListTimestamp(entry.lastSeenMs)}`;
}

/** What stands beside a row whose «how it is kept running» may be out of date: the machine is online but its report is older than its link (or missing) and it did not answer. */
function describeDoubtfulReport(entry: OverviewEntry): string {
  return `(${entry.probe === null ? 'no report yet' : 'last report from before its link started'}; it did not answer)`;
}

export function formatRunnerListLine(entry: OverviewEntry): string {
  const { runner, probe } = entry;
  const parts = [
    describeConnection(entry),
    ...(runner.isPaused ? ['paused'] : []),
    `${runner.os} (${runner.arch})`,
    serviceKindLabels[getCurrentServiceKind(runner, probe)],
    `charness ${runner.version}`,
    `paired ${formatListTimestamp(runner.pairedAtMs)}`,
  ];
  const notes = [...(entry.isOnline && entry.isReportDoubtful === true ? [describeDoubtfulReport(entry)] : []), ...(entry.linkConcern == null ? [] : [formatLinkConcernNote(entry.linkConcern, formatListTimestamp)])];
  return `${runner.name} — ${parts.join(' · ')}${notes.map((note) => ` ${note}`).join('')}`;
}

/** @description The whole `ls` output. */
export function formatRunnerList(entries: readonly OverviewEntry[], pending: readonly PendingPairing[], nowMs: number): string {
  const lines = entries.length === 0 ? ['No runners paired yet. `charness runners pair --host <address>` makes a pairing line.'] : entries.map(formatRunnerListLine);
  const open = pending.filter((pairing) => pairing.expiresAtMs > nowMs);
  if (open.length > 0) {
    lines.push('', ...open.map((pairing) => `Pairing code open until ${formatListTimestamp(pairing.expiresAtMs)} (${pairing.host}:${pairing.port})`));
  }
  return `${lines.join('\n')}\n`;
}
