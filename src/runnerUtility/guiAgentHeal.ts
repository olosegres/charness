import * as fs from 'fs';
import * as path from 'path';
import { getCaughtErrnoCode, writeTextFileAtomically } from '../configDirFile';
import { getOutputTail, type CommandResult, type CommandRunner } from '../selfUpdate/commandRunner';
import { stripControlCharacters } from './isolatedCommand';
import type { PueueState } from './pueueDaemon';
import type { RunnerHomePaths } from './runnerHome';
import { bootOutAndWaitUntilGone, commandTimeoutMs, getGuiAgentFile, writeDefinition } from './serviceCommon';
import { getServiceNames, planGuiAgentJob, renderLaunchdPlist } from './serviceUnits';

/**
 * @description The link puts the login session's agent (`guiAgent.ts`) of an always-on Mac in place ITSELF, so a Mac paired before the agent existed — or
 * one whose agent definition changed in a newer version — does not need an admin to paste the pairing line again just for that. The agent is a
 * LaunchAgent whose definition is the ACCOUNT's own file (`~/Library/LaunchAgents/com.charness.runner.gui.<hash>.plist`) and which runs in the account's
 * own `gui/<uid>` domain, so writing and loading it needs no root — the admin line only does it for a fresh install, as root, from outside.
 *
 * What the link does when it starts (an update restarts it too) and then once an hour, for a runner kept running as a `system-service` (nothing for any other
 * kind — that kind is written on macOS only):
 *
 *   definition missing or not what this version writes   write it; then, if the account has a login session, load it there (a loaded old one is replaced
 *                                                          only while no job runs: replacing it cuts the steps it runs — otherwise it waits for the next look)
 *   definition current, session there, agent not loaded   load it
 *   no login session                                       the file stays (launchd loads it at the account's next login); `runners` keeps saying a login is needed
 *   anything fails                                         the reason is kept in `gui/install-failure` and `runners` says to paste a fresh admin line (the admin
 *                                                          line loads it as root) instead of «needs a login»
 *
 * Unverifiable on Linux: what launchd answers a process that runs in the System session as the account when it asks for `gui/<uid>` (a session that is
 * there but cannot be reached reads as a failure, never as «no session»), and what `launchctl bootstrap` then does. The decision, every command line and the
 * records are tested against a recording `launchctl`.
 */

/** The agent looks for its own definition again this often after the first look at the link's start. */
export const guiAgentHealIntervalMs = 60 * 60 * 1000;
const maxFailureReasonChars = 160;
const failureFileMode = 0o644;
/** What `launchctl print gui/<uid>` says when the account has no login session (its domain does not exist). */
const noSessionPattern = /could not find|not found|no such|does not exist/i;

/** What the look at the agent found out; the decision is {@link planGuiAgentHeal}'s alone. */
export interface GuiAgentFacts {
  /** The runner is an always-on service (`system-service`): the only kind that has a login session's agent. */
  isAlwaysOnService: boolean;
  /** The definition on disk is exactly what this version would write. */
  isDefinitionCurrent: boolean;
  /** The account has a login session (`gui/<uid>` exists). */
  hasSession: boolean;
  /** The agent is loaded in that session. */
  isLoaded: boolean;
  /** Pueue holds a running job (or its state cannot be read): the steps of a job go through the agent, and replacing it would cut them. */
  isQueueBusy: boolean;
}

/** @name GuiAgentHealPlan @description What to do: nothing; write the file only; write and load it; load the current file; write and replace the loaded one; or wait for an idle moment. */
export type GuiAgentHealPlan = 'none' | 'write' | 'write-and-load' | 'load' | 'replace' | 'wait-for-idle';

/** @description The one decision of the look; pure. */
export function planGuiAgentHeal(facts: GuiAgentFacts): GuiAgentHealPlan {
  if (!facts.isAlwaysOnService) return 'none';
  if (facts.isDefinitionCurrent) return facts.hasSession && !facts.isLoaded ? 'load' : 'none';
  if (!facts.hasSession) return 'write';
  if (!facts.isLoaded) return 'write-and-load';
  return facts.isQueueBusy ? 'wait-for-idle' : 'replace';
}

/** @name GuiAgentHealOutcome @description What a look came to (what the link logs, and what a test reads). */
export type GuiAgentHealOutcome =
  | { kind: 'not-applicable' }
  | { kind: 'in-place' }
  | { kind: 'written-without-session' }
  | { kind: 'loaded'; wasReplaced: boolean }
  | { kind: 'waiting-for-idle' }
  | { kind: 'failed'; reason: string };

export interface GuiAgentHealDeps {
  /** Runs `launchctl`. */
  runner: CommandRunner;
  /** The uid of this process: the account's own `gui/<uid>` domain. */
  uid: number;
  accountName: string;
  /** The folder of the Node that runs the link: the agent's `PATH` starts with it, like the account's own services. */
  nodeDir: string;
  /** `system-service` when an admin's line installed the always-on service (`readServiceKind`); asked at every look, an admin may install it while the link runs. */
  getServiceKind: () => string | null;
  readQueue: () => Promise<PueueState>;
}

function readFileOrNull(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

/** @description One line for `gui/install-failure`: no control characters, no line break, bounded. */
export function formatInstallFailureReason(text: string): string {
  const flat = stripControlCharacters(text).replace(/\s+/g, ' ').trim();
  return flat.length <= maxFailureReasonChars ? flat : `${flat.slice(0, maxFailureReasonChars - 1)}…`;
}

/** @description Why the agent could not be put in place, or `null` when nothing is wrong. */
export function readGuiAgentInstallFailure(paths: RunnerHomePaths): string | null {
  const text = readFileOrNull(paths.guiInstallFailure)?.trim() ?? '';
  return text === '' ? null : text;
}

/** @description Keep (`reason`) or forget (`null`) the failure `runner.sh` reads. Never throws: a record that cannot be written is the lesser problem. */
export function writeGuiAgentInstallFailure(paths: RunnerHomePaths, reason: string | null): void {
  try {
    if (reason === null) {
      fs.rmSync(paths.guiInstallFailure, { force: true });
      return;
    }
    fs.mkdirSync(path.dirname(paths.guiInstallFailure), { recursive: true, mode: 0o700 });
    writeTextFileAtomically(paths.guiInstallFailure, `${formatInstallFailureReason(reason)}\n`, failureFileMode);
  } catch {
    // Without the record `runners` says «needs a login», as it did before this existed.
  }
}

async function askLaunchctl(deps: GuiAgentHealDeps, args: readonly string[]): Promise<CommandResult> {
  return deps.runner('launchctl', args, { timeoutMs: commandTimeoutMs });
}

function describeLaunchctlFailure(result: CommandResult): string {
  return getOutputTail(result, 1) || (result.isTimedOut ? 'no answer in time' : 'no answer');
}

/** The state of the account's GUI domain: a session with or without the agent loaded, no session, or a domain that could not be asked at all. */
async function lookAtSession(deps: GuiAgentHealDeps, label: string): Promise<{ hasSession: boolean; isLoaded: boolean } | { failure: string }> {
  const domain = `gui/${deps.uid}`;
  const session = await askLaunchctl(deps, ['print', domain]);
  if (!session.ok) {
    const answer = `${session.stderr}\n${session.stdout}`;
    return noSessionPattern.test(answer) ? { hasSession: false, isLoaded: false } : { failure: `launchctl cannot be asked about ${domain} (${describeLaunchctlFailure(session)})` };
  }
  return { hasSession: true, isLoaded: (await askLaunchctl(deps, ['print', `${domain}/${label}`])).ok };
}

async function loadAgent(deps: GuiAgentHealDeps, label: string, file: string, isReplacing: boolean): Promise<string | null> {
  const domain = `gui/${deps.uid}`;
  if (isReplacing && !(await bootOutAndWaitUntilGone(label, domain, deps.runner))) return `the old agent (${label}) is still loaded in ${domain} after being asked to stop`;
  const loaded = await askLaunchctl(deps, ['bootstrap', domain, file]);
  return loaded.ok ? null : `launchctl bootstrap ${domain} failed (${describeLaunchctlFailure(loaded)})`;
}

/**
 * @description One look at the login session's agent, and what it takes to put it in place (see the head of the file). Changes nothing for a runner that is
 * not an always-on service. Writes the definition into the account's own folder only; a failure comes back as {@link GuiAgentHealOutcome} `failed`, never thrown.
 */
export async function healGuiAgent(paths: RunnerHomePaths, deps: GuiAgentHealDeps): Promise<GuiAgentHealOutcome> {
  if (deps.getServiceKind() !== 'system-service') return { kind: 'not-applicable' };
  const names = getServiceNames(paths.root);
  const file = getGuiAgentFile(paths.homeDir, names);
  const definition = renderLaunchdPlist(planGuiAgentJob(paths, names, deps.accountName, deps.nodeDir));
  const isDefinitionCurrent = readFileOrNull(file) === definition;
  const session = await lookAtSession(deps, names.launchdGui);
  if ('failure' in session) return { kind: 'failed', reason: session.failure };
  const queue = !isDefinitionCurrent && session.isLoaded ? await deps.readQueue() : { kind: 'idle' as const };
  const plan = planGuiAgentHeal({ isAlwaysOnService: true, isDefinitionCurrent, hasSession: session.hasSession, isLoaded: session.isLoaded, isQueueBusy: queue.kind === 'busy' || queue.kind === 'unreadable' });
  if (plan === 'none') return { kind: 'in-place' };
  if (plan === 'wait-for-idle') return { kind: 'waiting-for-idle' };
  try {
    // The agent's log goes to the logs folder, which launchd does not make.
    fs.mkdirSync(paths.logsDir, { recursive: true, mode: 0o700 });
    if (plan !== 'load') writeDefinition(file, definition);
  } catch (error) {
    return { kind: 'failed', reason: `the agent's definition ${file} could not be written (${getCaughtErrnoCode(error)})` };
  }
  if (plan === 'write') return { kind: 'written-without-session' };
  const failure = await loadAgent(deps, names.launchdGui, file, plan === 'replace');
  return failure === null ? { kind: 'loaded', wasReplaced: plan === 'replace' } : { kind: 'failed', reason: failure };
}

/** @description The line the link logs for an outcome; `null` for one that says nothing new ({@link GuiAgentHealOutcome} `not-applicable` / `in-place`). */
export function describeGuiAgentHealOutcome(outcome: GuiAgentHealOutcome): string | null {
  switch (outcome.kind) {
    case 'not-applicable':
    case 'in-place':
      return null;
    case 'written-without-session':
      return 'the login session\'s agent is written; the account has no login session, so launchd loads it at the next login';
    case 'loaded':
      return outcome.wasReplaced ? 'the login session\'s agent was replaced by the one of this version and loaded again' : 'the login session\'s agent is installed and loaded into the account\'s login session';
    case 'waiting-for-idle':
      return 'the login session\'s agent differs from this version\'s, but jobs are running: it is replaced at a look when none runs';
    case 'failed':
      return `the login session's agent could not be put in place: ${outcome.reason}`;
  }
}

export interface GuiAgentHealer {
  /** One look at the agent, its record and, when something new happened, its line. Never throws. */
  look: () => Promise<GuiAgentHealOutcome>;
}

/**
 * @description The link's looker: each look is recorded for `runners` — a failure in `gui/install-failure`, anything else forgets it, so a login that is still missing
 * reads «needs a login» again and not a stale failure — and `log` hears an outcome once, not at every look that finds the same.
 */
export function createGuiAgentHealer(paths: RunnerHomePaths, deps: GuiAgentHealDeps, log: (line: string) => void): GuiAgentHealer {
  let lastKind: GuiAgentHealOutcome['kind'] | null = null;
  return {
    look: async () => {
      let outcome: GuiAgentHealOutcome;
      try {
        outcome = await healGuiAgent(paths, deps);
      } catch (error) {
        outcome = { kind: 'failed', reason: error instanceof Error ? error.message : 'unknown error' };
      }
      if (outcome.kind !== 'not-applicable') writeGuiAgentInstallFailure(paths, outcome.kind === 'failed' ? outcome.reason : null);
      const line = describeGuiAgentHealOutcome(outcome);
      if (line !== null && (outcome.kind !== lastKind || outcome.kind === 'loaded')) log(line);
      lastKind = outcome.kind;
      return outcome;
    },
  };
}
