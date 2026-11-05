import * as fs from 'fs';
import * as path from 'path';
import { getCaughtErrnoCode, writeTextFileAtomically } from '../configDirFile';
import { getOutputTail, type CommandResult, type CommandRunner } from '../selfUpdate/commandRunner';
import { stripControlCharacters } from './isolatedCommand';
import type { PueueState } from './pueueDaemon';
import type { RunnerHomePaths } from './runnerHome';
import { bootOutAndWaitUntilGone, commandTimeoutMs, getGuiAgentFile, restorePreviousDefinitions, writeDefinition } from './serviceCommon';
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
 *                                                          only while no job is running or queued: replacing it cuts the steps it runs — otherwise it
 *                                                          waits for the next look, and the old file is put back if a job appears while it is being replaced)
 *   definition current, session there, agent not loaded   load it
 *   no login session                                       the file stays (launchd loads it at the account's next login); `runners` keeps saying a login is needed
 *   anything fails                                         the reason is kept in `gui/install-failure` with the way out (`login`: the definition is in place,
 *                                                          so logging out and in loads it; `admin`: it is not, only a fresh admin line puts it there) and
 *                                                          `runners` says so instead of «needs a login»
 *
 * MEASURED (2026-11-05, macOS 26.7.1, the owner's always-on Mac, `remote-run exec` = this link's own context: `launchctl managername` → `System`, uid of the account,
 * not root; the account was logged in through Fast User Switching, a background session):
 *   `launchctl print gui/<uid>`                       exit 0 — `type = login`, `session = Aqua`, `creator = loginwindow[<pid>]`, `asid = …`: a System-session process
 *                                                     of the account CAN ask about its own GUI domain
 *   `launchctl print gui/<uid>/<agent label>`         exit 0 — `type = LaunchAgent`, `path = ~/Library/LaunchAgents/<label>.plist`, `state = running`
 *   `launchctl print gui/<uid>/no.such.label`         exit 113 — «Bad request.» / «Could not find service "no.such.label" in domain for user gui: <uid>»
 *   `launchctl print gui/99999` (no such domain)      exit 112 — «Bad request.» / «Could not find domain for user gui: 99999»
 *   `launchctl print gui/<another account's uid>`     exit 1 — «Could not print domain: 1: Operation not permitted»
 *   `launchctl print user/<uid>`                      exit 0 — `session = Background`, `gui asid = <asid of the GUI domain>`
 *   `pgrep -u <uid> -lx 'loginwindow|Dock|Finder'`    exit 0 with one line per process (nothing: exit 1)
 * NOT measured, because it can only be measured by doing it (nothing was loaded or removed on that Mac): `launchctl bootstrap gui/<uid>` from that context, and the
 * answer for an account that is LOGGED OUT. So «no session» is never read off launchd's answer alone: launchd must say «Could not find domain for user gui: <uid>» AND
 * the account must run none of the processes a login session consists of (`loginwindow`, `Dock`, `Finder`). Anything else — another text, a refusal, a domain that is
 * gone while those processes run, an answer that cannot be got — is a FAILURE with the text, never «no session». A `bootstrap` that is refused is a failure whose
 * definition is in place, so logging out and in loads it.
 */

/** The agent looks for its own definition again this often after the first look at the link's start. */
export const guiAgentHealIntervalMs = 60 * 60 * 1000;
const maxFailureReasonChars = 160;
const failureFileMode = 0o644;
/** The processes a GUI login session consists of (measured: all three run as the account while it is logged in, a background session included). */
const loginSessionProcessPattern = 'loginwindow|Dock|Finder';
/** `pgrep` finds nothing: its documented exit code. */
const pgrepNoMatchExitCode = 1;

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
  /** Pueue holds a job that runs or waits to run (or its state cannot be read): the steps of a job go through the agent, and replacing it would cut them. */
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

/**
 * @name GuiAgentCure @description What gets the agent running after a failure. `login`: the definition is in place, so the account logging out and in again loads it
 * (an admin line does too); `admin`: it is not, only a fresh admin line writes and loads it.
 */
export type GuiAgentCure = 'login' | 'admin';

/** @name GuiAgentHealOutcome @description What a look came to (what the link logs, and what a test reads). */
export type GuiAgentHealOutcome =
  | { kind: 'not-applicable' }
  | { kind: 'in-place' }
  | { kind: 'written-without-session' }
  | { kind: 'loaded'; wasReplaced: boolean }
  | { kind: 'waiting-for-idle' }
  | { kind: 'failed'; reason: string; cure: GuiAgentCure };

export interface GuiAgentHealDeps {
  /** Runs `launchctl` and `pgrep`. */
  runner: CommandRunner;
  /** The uid of this process: the account's own `gui/<uid>` domain. */
  uid: number;
  accountName: string;
  /** The folder of the Node that runs the link: the agent's `PATH` starts with it, like the account's own services. */
  nodeDir: string;
  /** `system-service` when an admin's line installed the always-on service (`readServiceKind`); asked at every look, an admin may install it while the link runs. */
  getServiceKind: () => string | null;
  /** What Pueue holds: asked with the queued jobs counted (they start the moment the old agent is gone), and asked again right before the old agent is stopped. */
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

/** @name GuiAgentInstallFailure @description What `gui/install-failure` holds: the way out and why the link could not put the agent in place. */
export interface GuiAgentInstallFailure {
  cure: GuiAgentCure;
  reason: string;
}

/** @description The failure the link recorded (`<cure> <reason>`, one line), or `null` when nothing is wrong. A record without a cure word reads as one that needs the admin line. */
export function readGuiAgentInstallFailure(paths: RunnerHomePaths): GuiAgentInstallFailure | null {
  const text = readFileOrNull(paths.guiInstallFailure)?.trim() ?? '';
  if (text === '') return null;
  const [word, ...rest] = text.split(' ');
  if (word === 'login' || word === 'admin') return { cure: word, reason: rest.join(' ') };
  return { cure: 'admin', reason: text };
}

/** @description Keep (`failure`) or forget (`null`) the failure `runner.sh` reads. Never throws: a record that cannot be written is the lesser problem. */
export function writeGuiAgentInstallFailure(paths: RunnerHomePaths, failure: GuiAgentInstallFailure | null): void {
  try {
    if (failure === null) {
      fs.rmSync(paths.guiInstallFailure, { force: true });
      return;
    }
    fs.mkdirSync(path.dirname(paths.guiInstallFailure), { recursive: true, mode: 0o700 });
    writeTextFileAtomically(paths.guiInstallFailure, `${failure.cure} ${formatInstallFailureReason(failure.reason)}\n`, failureFileMode);
  } catch {
    // Without the record `runners` says «needs a login», as it did before this existed.
  }
}

async function askLaunchctl(deps: GuiAgentHealDeps, args: readonly string[]): Promise<CommandResult> {
  return deps.runner('launchctl', args, { timeoutMs: commandTimeoutMs });
}

function describeCommandFailure(result: CommandResult): string {
  return getOutputTail(result, 1) || (result.isTimedOut ? 'no answer in time' : 'no answer');
}

/** What the account is running of a login session: the processes found, none, or an answer that cannot be got. */
type LoginEvidence = { kind: 'present'; processes: string } | { kind: 'none' } | { kind: 'unknown'; reason: string };

/** Independent of launchd's own word about the domain: does the account run what a GUI login session consists of? */
async function readLoginEvidence(deps: GuiAgentHealDeps): Promise<LoginEvidence> {
  const found = await deps.runner('pgrep', ['-u', deps.uid.toString(), '-lx', loginSessionProcessPattern], { timeoutMs: commandTimeoutMs });
  if (found.ok) {
    const processes = found.stdout.split('\n').map((line) => line.trim().replace(/^\d+\s+/, '')).filter((name) => name !== '').join(', ');
    return processes === '' ? { kind: 'unknown', reason: 'pgrep answered with nothing it could name' } : { kind: 'present', processes };
  }
  return found.exitCode === pgrepNoMatchExitCode && found.stdout.trim() === '' ? { kind: 'none' } : { kind: 'unknown', reason: `pgrep: ${describeCommandFailure(found)}` };
}

/** The state of the account's GUI domain: a session with or without the agent loaded, no session (only on launchd's measured answer AND no sign of a login), or why it cannot be told. */
async function lookAtSession(deps: GuiAgentHealDeps, label: string): Promise<{ hasSession: boolean; isLoaded: boolean } | { failure: string }> {
  const domain = `gui/${deps.uid}`;
  const session = await askLaunchctl(deps, ['print', domain]);
  if (session.ok) return { hasSession: true, isLoaded: (await askLaunchctl(deps, ['print', `${domain}/${label}`])).ok };
  const launchdWord = describeCommandFailure(session);
  if (!new RegExp(`Could not find domain for user gui: ${deps.uid}\\b`, 'i').test(`${session.stderr}\n${session.stdout}`)) {
    return { failure: `launchctl cannot be asked about ${domain} (${launchdWord})` };
  }
  const evidence = await readLoginEvidence(deps);
  if (evidence.kind === 'none') return { hasSession: false, isLoaded: false };
  if (evidence.kind === 'present') return { failure: `launchd says ${domain} does not exist (${launchdWord}), yet the account runs ${evidence.processes}: its login session cannot be reached from here` };
  return { failure: `launchd says ${domain} does not exist (${launchdWord}), and whether the account is logged in could not be confirmed (${evidence.reason})` };
}

function checkIsQueueBusy(queue: PueueState): boolean {
  return queue.kind === 'busy' || queue.kind === 'unreadable';
}

/** The agent is booted out (when it is replaced) and bootstrapped; `null` when it is loaded, else why not. */
async function loadAgent(deps: GuiAgentHealDeps, label: string, file: string, isReplacing: boolean): Promise<string | null> {
  const domain = `gui/${deps.uid}`;
  if (isReplacing && !(await bootOutAndWaitUntilGone(label, domain, deps.runner))) return `the old agent (${label}) is still loaded in ${domain} after being asked to stop`;
  const loaded = await askLaunchctl(deps, ['bootstrap', domain, file]);
  return loaded.ok ? null : `launchctl bootstrap ${domain} failed (${describeCommandFailure(loaded)})`;
}

/**
 * @description One look at the login session's agent, and what it takes to put it in place (see the head of the file). Changes nothing for a runner that is
 * not an always-on service. Writes the definition into the account's own folder only; a failure comes back as {@link GuiAgentHealOutcome} `failed`, never thrown.
 *
 * Replacing a LOADED agent must not cut a job: the queue is looked at (queued jobs count: they start the moment a slot frees) to decide, and again right
 * before the old agent is stopped — if a job turned up, the old definition is put back (the next look sees the difference again) and nothing is stopped. What
 * is left is the second or so between the stop and the new agent's first heartbeat: a job that STARTS then is refused («needs a login») or runs in the daemon,
 * as without a session, and is told so — never cut in the middle of a step, because no step runs through the old agent (the queue was empty).
 */
export async function healGuiAgent(paths: RunnerHomePaths, deps: GuiAgentHealDeps): Promise<GuiAgentHealOutcome> {
  if (deps.getServiceKind() !== 'system-service') return { kind: 'not-applicable' };
  const names = getServiceNames(paths.root);
  const file = getGuiAgentFile(paths.homeDir, names);
  const definition = renderLaunchdPlist(planGuiAgentJob(paths, names, deps.accountName, deps.nodeDir));
  const previousDefinition = readFileOrNull(file);
  const isDefinitionCurrent = previousDefinition === definition;
  const session = await lookAtSession(deps, names.launchdGui);
  // Nothing was written yet: the way out is the login only when a current definition is there to load.
  if ('failure' in session) return { kind: 'failed', reason: session.failure, cure: isDefinitionCurrent ? 'login' : 'admin' };
  const queueAtPlan = !isDefinitionCurrent && session.isLoaded ? await deps.readQueue() : { kind: 'idle' as const };
  const plan = planGuiAgentHeal({ isAlwaysOnService: true, isDefinitionCurrent, hasSession: session.hasSession, isLoaded: session.isLoaded, isQueueBusy: checkIsQueueBusy(queueAtPlan) });
  if (plan === 'none') return { kind: 'in-place' };
  if (plan === 'wait-for-idle') return { kind: 'waiting-for-idle' };
  try {
    // The agent's log goes to the logs folder, which launchd does not make.
    fs.mkdirSync(paths.logsDir, { recursive: true, mode: 0o700 });
    if (plan !== 'load') writeDefinition(file, definition);
  } catch (error) {
    return { kind: 'failed', reason: `the agent's definition ${file} could not be written (${getCaughtErrnoCode(error)})`, cure: 'admin' };
  }
  if (plan === 'write') return { kind: 'written-without-session' };
  if (plan === 'replace' && checkIsQueueBusy(await deps.readQueue())) {
    restorePreviousDefinitions([{ file, content: previousDefinition }]);
    return { kind: 'waiting-for-idle' };
  }
  const failure = await loadAgent(deps, names.launchdGui, file, plan === 'replace');
  // The definition is in place by now, so logging out and in loads it even where this look could not.
  return failure === null ? { kind: 'loaded', wasReplaced: plan === 'replace' } : { kind: 'failed', reason: failure, cure: 'login' };
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
      return 'the login session\'s agent differs from this version\'s, but jobs are running or queued: it is replaced at a look when none is';
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
        outcome = { kind: 'failed', reason: error instanceof Error ? error.message : 'unknown error', cure: 'admin' };
      }
      if (outcome.kind !== 'not-applicable') writeGuiAgentInstallFailure(paths, outcome.kind === 'failed' ? { cure: outcome.cure, reason: outcome.reason } : null);
      const line = describeGuiAgentHealOutcome(outcome);
      if (line !== null && (outcome.kind !== lastKind || outcome.kind === 'loaded')) log(line);
      lastKind = outcome.kind;
      return outcome;
    },
  };
}
