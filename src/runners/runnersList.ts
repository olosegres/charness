import type { RunnerLinkStatus } from './linkControl';
import type { PairedRunner, PendingPairing, RunnerServiceKind } from './hubRegistry';

/**
 * @description The text of `charness runners ls`: one line per paired runner (name, online or offline since when, paused, OS, how it
 * is kept running, version) and a line for each pairing code still open. Pure: the status is read by the caller.
 */

export const serviceKindLabels: Record<RunnerServiceKind, string> = {
  foreground: 'run by hand',
  'user-service': 'user service',
  'system-service': 'system service',
  unknown: 'service unknown',
};

export interface RunnerListEntry {
  runner: PairedRunner;
  status: RunnerLinkStatus;
}

/** @description `2026-11-01 14:05` in the zone of this process. */
export function formatListTimestamp(epochMs: number): string {
  const date = new Date(epochMs);
  const pad = (value: number): string => value.toString().padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function describeConnection(status: RunnerLinkStatus): string {
  if (status.isOnline) return 'online';
  return status.lastSeenMs === null ? 'offline, never connected' : `offline since ${formatListTimestamp(status.lastSeenMs)}`;
}

export function formatRunnerListLine(entry: RunnerListEntry): string {
  const { runner, status } = entry;
  const parts = [
    describeConnection(status),
    ...(runner.isPaused ? ['paused'] : []),
    `${runner.os} (${runner.arch})`,
    serviceKindLabels[runner.serviceKind],
    `charness ${runner.version}`,
    `paired ${formatListTimestamp(runner.pairedAtMs)}`,
  ];
  return `${runner.name} — ${parts.join(' · ')}`;
}

/** @description The whole `ls` output. */
export function formatRunnerList(entries: readonly RunnerListEntry[], pending: readonly PendingPairing[], nowMs: number): string {
  const lines = entries.length === 0 ? ['No runners paired yet. `charness runners pair --host <address>` makes a pairing line.'] : entries.map(formatRunnerListLine);
  const open = pending.filter((pairing) => pairing.expiresAtMs > nowMs);
  if (open.length > 0) {
    lines.push('', ...open.map((pairing) => `Pairing code open until ${formatListTimestamp(pairing.expiresAtMs)} (${pairing.host}:${pairing.port})`));
  }
  return `${lines.join('\n')}\n`;
}
