import * as path from 'path';
import { describeJobState, type JobFacts, type JobOutcome } from './jobState';
import type { JobMeta } from './jobMeta';

/**
 * @description How `ls` and `status` show a job: one aligned line per job newest first, and a short block for one. Times are UTC and
 * written out (`2026-10-31 22:10 UTC`), ages and durations short (`3m12s`, `2h ago`).
 */

const secondsPerMinute = 60;
const secondsPerHour = 3600;
const secondsPerDay = 86400;
const commandColumnLimit = 70;
const twoDigits = 2;

/** @description `45s`, `3m12s`, `2h05m`, `1d3h`. */
export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  if (seconds < secondsPerMinute) return `${seconds}s`;
  if (seconds < secondsPerHour) return `${Math.floor(seconds / secondsPerMinute)}m${(seconds % secondsPerMinute).toString().padStart(twoDigits, '0')}s`;
  if (seconds < secondsPerDay) return `${Math.floor(seconds / secondsPerHour)}h${Math.floor((seconds % secondsPerHour) / secondsPerMinute).toString().padStart(twoDigits, '0')}m`;
  return `${Math.floor(seconds / secondsPerDay)}d${Math.floor((seconds % secondsPerDay) / secondsPerHour)}h`;
}

/** @description `just now`, `5m ago`, `2h ago`, `3d ago`. */
export function formatAge(elapsedSeconds: number): string {
  const seconds = Math.max(0, Math.round(elapsedSeconds));
  if (seconds < secondsPerMinute) return 'just now';
  if (seconds < secondsPerHour) return `${Math.floor(seconds / secondsPerMinute)}m ago`;
  if (seconds < secondsPerDay) return `${Math.floor(seconds / secondsPerHour)}h ago`;
  return `${Math.floor(seconds / secondsPerDay)}d ago`;
}

function formatTimestamp(milliseconds: number): string {
  return `${new Date(milliseconds).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

export interface JobEntry {
  meta: JobMeta;
  facts: JobFacts;
  outcome: JobOutcome;
}

function getProjectLabel(meta: JobMeta): string {
  const name = path.basename(meta.projectRoot);
  return meta.subfolder === '' ? name : `${name}/${meta.subfolder}`;
}

/** The seconds the job has run (or ran): from its own start to its end, or to now while it runs. */
function getRunSeconds(entry: JobEntry, nowMs: number): number | null {
  if (entry.facts.startedAtSeconds === null) return null;
  const endSeconds = entry.facts.finishedAtSeconds ?? Math.floor(nowMs / 1000);
  return endSeconds - entry.facts.startedAtSeconds;
}

function getExitText(outcome: JobOutcome): string {
  return outcome.state === 'done' ? `exit ${outcome.code}` : '';
}

function truncate(text: string, limit: number): string {
  const singleLine = text.replace(/\s+/g, ' ');
  return singleLine.length > limit ? `${singleLine.slice(0, limit - 1)}…` : singleLine;
}

/** @description The lines of `ls`: columns aligned, newest job first. */
export function formatJobList(entries: readonly JobEntry[], nowMs: number): string[] {
  const sorted = [...entries].sort((first, second) => second.meta.submittedAtMs - first.meta.submittedAtMs);
  const rows = sorted.map((entry) => {
    const runSeconds = getRunSeconds(entry, nowMs);
    return [
      entry.meta.id,
      describeJobState(entry.outcome),
      getExitText(entry.outcome),
      runSeconds === null ? '' : formatDuration(runSeconds),
      formatAge((nowMs - entry.meta.submittedAtMs) / 1000),
      getProjectLabel(entry.meta),
      truncate(entry.meta.command, commandColumnLimit),
    ];
  });
  const widths = rows.length === 0 ? [] : rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)));
  return rows.map((row) => row.map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column]))).join('  ').trimEnd());
}

/** @description The block of `status <id>`. */
export function formatJobStatus(entry: JobEntry, nowMs: number): string {
  const runSeconds = getRunSeconds(entry, nowMs);
  const state = describeJobState(entry.outcome);
  const exitText = getExitText(entry.outcome);
  const times = [
    `submitted ${formatTimestamp(entry.meta.submittedAtMs)}`,
    entry.facts.startedAtSeconds === null ? 'not started' : `started ${formatTimestamp(entry.facts.startedAtSeconds * 1000)}`,
    runSeconds === null ? null : `${entry.outcome.state === 'running' ? 'running for' : 'took'} ${formatDuration(runSeconds)}`,
  ].filter((part) => part !== null);
  return [
    `job ${entry.meta.id} — ${state}${exitText === '' ? '' : ` (${exitText})`}`,
    `  runner: ${entry.meta.runner}`,
    `  project: ${getProjectLabel(entry.meta)}`,
    `  command: ${entry.meta.command}`,
    `  ${times.join(' · ')}`,
  ].join('\n');
}
