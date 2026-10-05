/**
 * @description The Claude Code version gate for the json-stream lifecycle
 * (plan 2026-10-04-claude-process-lifecycle, L-D10). A process may be stopped
 * automatically (idle stop, per-turn stop) ONLY when its CLI reports the
 * `system/background_tasks_changed` list — verified on 2.1.287 and never seen
 * before it. Without that list a stop could kill background work (a background
 * Bash, a Monitor, a background sub-agent): stdin EOF kills them ~5 s later
 * (probe 2026-10-04). An unknown version (no `claude_code_version` on `init`)
 * is treated as too old.
 */

/** The first Claude Code version whose stream-json reports the background-task list. */
export const minAutoStopClaudeCodeVersion = '2.1.287';

const versionRe = /^(\d+)\.(\d+)\.(\d+)/;

/** Parse `major.minor.patch` (a trailing pre-release / build suffix is ignored); `null` for anything else. */
function parseClaudeCodeVersion(version: string): [number, number, number] | null {
  const match = versionRe.exec(version.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * @description Compare two `major.minor.patch` versions numerically (so `2.1.300`
 * sorts after `2.1.287`, which a string compare gets wrong). Returns a negative
 * number, zero, or a positive number like `Array.prototype.sort` expects; `null`
 * when either side does not parse.
 */
export function compareClaudeCodeVersions(left: string, right: string): number | null {
  const leftParts = parseClaudeCodeVersion(left);
  const rightParts = parseClaudeCodeVersion(right);
  if (!leftParts || !rightParts) return null;
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

/** Whether a process reporting `version` may be auto-stopped (L-D10); `null` / unparseable → `false`. */
export function checkIsClaudeAutoStopSupported(version: string | null): boolean {
  if (version === null) return false;
  const comparison = compareClaudeCodeVersions(version, minAutoStopClaudeCodeVersion);
  return comparison !== null && comparison >= 0;
}

/**
 * @description Whether a switch of a conversation to the per-turn lifecycle is
 * REFUSED (L-D10, narrowed): only when its last known Claude Code version — from
 * the live process or the persisted tail record — is below the gate. An unknown
 * version allows the switch: the refusal is only decidable once a version is
 * known, and the stop gate keeps an unknown or old process alive anyway.
 */
export function checkIsPerTurnSwitchRefused(lastKnownVersion: string | null): boolean {
  return lastKnownVersion !== null && !checkIsClaudeAutoStopSupported(lastKnownVersion);
}
