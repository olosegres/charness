import { npmHoldMs } from './constants';
import { checkSatisfiesRange, compareSemVer, parseSemVer, checkIsPrerelease } from './semver';
import type { AutoUpdateMode } from './updateModes';
import type { GitCheckStatus, GitSkipReason } from './types';

/**
 * The update decisions as pure functions of what the engine observed — no clock, no filesystem, no network.
 * What to do (`install`, `notify`, …) is decided here; whether the bot is idle, how the install runs and what
 * is said in General belong to the engine.
 */

/** What `npm view charness@latest` said. */
export interface NpmLatest {
  version: string;
  /** The `engines.node` range of that version, `null` when it names none. */
  engines: string | null;
  isDeprecated: boolean;
}

export interface NpmPolicyInput {
  runningVersion: string;
  runningNode: string;
  latest: NpmLatest;
  /** When the bot first saw `latest.version` (ms); `undefined` = just now (the engine records it). */
  firstSeenAt: number | undefined;
  now: number;
  mode: AutoUpdateMode;
  /** Targets whose install failed: skipped unless the install was asked for. */
  failedTargets: readonly string[];
  /** False for an install that can only notify: every `install` becomes `notify`. */
  canInstall: boolean;
  /** «Update now»: no hold, a major goes, a failed target is retried. */
  isUserRequested: boolean;
}

export type NpmPolicyDecision =
  | { action: 'none' }
  | { action: 'waitHold'; until: number }
  | { action: 'install' }
  | { action: 'notify' }
  | { action: 'offerMajor' }
  | { action: 'needsNode'; required: string };

/**
 * @description What to do about npm's `latest`: never a downgrade or a prerelease; a deprecated version is skipped
 * (silently, even when it was deprecated during the hold); a version the running Node cannot run is not installed
 * (`needsNode`); the hold counts from the first time it was seen and applies to the install, the notice, a major's
 * offer and the "needs Node" notice alike; after it, `on` installs a patch / minor by itself, `notify` only says so, and a major is only offered.
 */
export function decideNpmUpdate(input: NpmPolicyInput): NpmPolicyDecision {
  const running = parseSemVer(input.runningVersion);
  const latest = parseSemVer(input.latest.version);
  if (!running || !latest || checkIsPrerelease(latest) || compareSemVer(latest, running) <= 0) return { action: 'none' };
  if (input.latest.isDeprecated) return { action: 'none' };
  if (input.mode === 'off' && !input.isUserRequested) return { action: 'none' };
  if (!input.isUserRequested && input.failedTargets.includes(input.latest.version)) return { action: 'none' };

  if (!input.isUserRequested) {
    const until = (input.firstSeenAt ?? input.now) + npmHoldMs;
    if (input.now < until) return { action: 'waitHold', until };
  }

  const node = parseSemVer(input.runningNode);
  if (input.latest.engines !== null && node && checkSatisfiesRange(node, input.latest.engines) === false) {
    return { action: 'needsNode', required: input.latest.engines };
  }

  if (input.isUserRequested) return input.canInstall ? { action: 'install' } : { action: 'notify' };
  if (latest.major > running.major) return { action: 'offerMajor' };
  return input.mode === 'on' && input.canInstall ? { action: 'install' } : { action: 'notify' };
}

/** What `scripts/self-update.sh --check` said. */
export interface GitCheck {
  status: GitCheckStatus;
  reason: GitSkipReason | null;
  from: string;
  to: string;
  behind: number;
  /** `MIGRATION_*.md` files the incoming range ADDS. */
  migrationGuides: string[];
}

export interface GitPolicyInput {
  check: GitCheck;
  mode: AutoUpdateMode;
  failedTargets: readonly string[];
  canInstall: boolean;
  isUserRequested: boolean;
}

export type GitPolicyDecision =
  | { action: 'none' }
  | { action: 'install' }
  | { action: 'notify' }
  | { action: 'offerBreaking'; migrationGuides: string[] }
  | { action: 'skipped'; reason: GitSkipReason | null };

/**
 * @description What to do about a checkout that is behind its upstream: no hold, the whole tracked branch; a range that
 * ADDS a `MIGRATION_*.md` is the checkout's "major" (offered, not merged by itself); a target commit whose install
 * failed is not retried until upstream moves; a checkout the script leaves alone is `skipped` with its reason (shown on
 * `/update` only).
 */
export function decideGitUpdate(input: GitPolicyInput): GitPolicyDecision {
  const { check } = input;
  if (check.status === 'skip') return { action: 'skipped', reason: check.reason };
  if (check.status === 'upToDate') return { action: 'none' };
  if (input.mode === 'off' && !input.isUserRequested) return { action: 'none' };
  if (!input.isUserRequested && input.failedTargets.includes(check.to)) return { action: 'none' };
  if (input.isUserRequested) return input.canInstall ? { action: 'install' } : { action: 'notify' };
  if (check.migrationGuides.length > 0) return { action: 'offerBreaking', migrationGuides: check.migrationGuides };
  return input.mode === 'on' && input.canInstall ? { action: 'install' } : { action: 'notify' };
}

/** What decides whether the bot may be restarted right now. */
export interface IdleInput {
  isAnyAgentWorking: boolean;
  hasUnconsumedInput: boolean;
  hasBufferedStartupPrompt: boolean;
  isSignInRunning: boolean;
  isWizardOpen: boolean;
  /** Epoch ms of the last human message, `null` when none since the start. */
  lastHumanMessageAt: number | null;
  now: number;
  quietMs: number;
  /** «Update now» skips the quiet rule, never the work / sign-in rules. */
  isUserRequested: boolean;
}

export type IdleVerdict = { isIdle: true } | { isIdle: false; reason: 'working' | 'unconsumedInput' | 'startupBuffer' | 'signIn' | 'wizard' | 'recentMessage' };

/**
 * @description May the bot restart now? Only when no agent works, no input waits to be consumed, no sign-in or
 * wizard is in progress, and no human wrote for the quiet period. A sleeping or idle-but-alive agent session is fine:
 * it survives the restart. «Update now» still waits for work and sign-ins, not for the quiet period.
 */
export function getIdleVerdict(input: IdleInput): IdleVerdict {
  if (input.isAnyAgentWorking) return { isIdle: false, reason: 'working' };
  if (input.isSignInRunning) return { isIdle: false, reason: 'signIn' };
  if (input.hasUnconsumedInput) return { isIdle: false, reason: 'unconsumedInput' };
  if (input.hasBufferedStartupPrompt) return { isIdle: false, reason: 'startupBuffer' };
  if (input.isWizardOpen) return { isIdle: false, reason: 'wizard' };
  const isQuiet = input.lastHumanMessageAt === null || input.now - input.lastHumanMessageAt >= input.quietMs;
  if (!isQuiet && !input.isUserRequested) return { isIdle: false, reason: 'recentMessage' };
  return { isIdle: true };
}
