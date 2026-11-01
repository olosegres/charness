import * as os from 'os';
import { runnerCapabilities, type RunnerCapability, type RunnerProbe } from './probe';
import { readLastProbe } from './runners';
import { loadRunnersCatalog } from './runnersCatalog';
import type { RunnerConfig } from './runnersConfig';
import { getRemoteRunCacheDir } from './ssh';

/**
 * @description The one line per runner that the bot MCP's instructions give an agent — `mac — macOS 15.1, android, playwright`: the name, the
 * OS and what the runner could do when it was last probed (`remote-run`'s own snapshot, so a runner nobody has probed yet shows only its name
 * and the OS it reported at pairing). It is a hint for choosing `--needs`, read once per connect; the live state — online, load, jobs — stays
 * in `charness remote-run runners`, which the bullet tells the agent to look at first.
 *
 * What a runner machine reported (its OS name) goes into an agent's instructions, so it is reduced to a short plain label here: a runner is
 * code the operator attached, not a voice the agent should obey.
 */

const maxOsLabelLength = 40;
const unsafeLabelCharacters = /[^A-Za-z0-9 ._+()-]/g;

/** @description The OS text of a runner as a short plain label: letters, digits and a few signs; no line break, no markup, 40 characters at most. */
export function sanitizeOsLabel(reportedOs: string): string {
  return reportedOs.replace(unsafeLabelCharacters, '').replace(/\s+/g, ' ').trim().slice(0, maxOsLabelLength).trim();
}

/** @name RunnerSummary @description What the instructions say of one runner. */
export interface RunnerSummary {
  name: string;
  osLabel: string;
  /** The capabilities it had when last probed, in the order `--needs` lists them. */
  capabilities: RunnerCapability[];
  /** Paused from the hub, or on the runner itself when last seen: not used for new jobs. */
  isPaused: boolean;
}

/** @description The summary of `runner`; `probe` is its last snapshot, if it has one. */
export function summarizeRunner(runner: RunnerConfig, probe: RunnerProbe | null): RunnerSummary {
  const probedOs = probe === null ? '' : [probe.osName, probe.osVersion].filter((part) => part !== '').join(' ');
  return {
    name: runner.name,
    osLabel: sanitizeOsLabel(probedOs !== '' ? probedOs : (runner.paired?.os ?? '')),
    capabilities: probe === null ? [] : runnerCapabilities.filter((capability) => probe.capabilities[capability].isAvailable),
    isPaused: runner.paired?.isPausedByHub === true || probe?.isPaused === true,
  };
}

/** @description `mac — macOS 15.1, android, playwright`; `box1 (paused) — Ubuntu 24.04`; just the name when nothing else is known. */
export function formatRunnerSummaryLine(summary: RunnerSummary): string {
  const details = [...(summary.osLabel === '' ? [] : [summary.osLabel]), ...summary.capabilities];
  return `${summary.name}${summary.isPaused ? ' (paused)' : ''}${details.length === 0 ? '' : ` — ${details.join(', ')}`}`;
}

/**
 * @description The lines for the instructions of a session that connects now: one per runner of the catalog (hand-made first, then paired; a
 * catalog with an error still gives the runners that last loaded). Empty = no runner, and remote-run is not mentioned.
 */
export function getRunnerSummaryLines(homeDir: string = os.homedir(), env: NodeJS.ProcessEnv = process.env): string[] {
  const runners = loadRunnersCatalog(homeDir).config?.runners ?? [];
  const cacheDir = getRemoteRunCacheDir(env, homeDir);
  return runners.map((runner) => formatRunnerSummaryLine(summarizeRunner(runner, readLastProbe(cacheDir, runner.name)?.probe ?? null)));
}
