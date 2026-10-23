import { checkIntervalMs, bootConfirmMs, firstCheckDelayMs, hotBuildDeadlineMs, idlePollIntervalMs } from './constants';
import type { GitApplyResult, GitSource } from './gitSource';
import type { HostLock } from './hostLock';
import { getReexecProblems, type ReexecTarget } from './restart';
import type { HotSupervisorRecord, SupervisorSignalResult } from './hotSupervisor';
import { npmManualCommand, type InstallKind } from './installKind';
import { UpdateSourceError, type NpmSource } from './npmSource';
import { getCheckoutReleaseNotes, getNpmReleaseNotes, type WhatsNewSummary } from './releaseNotes';
import { compareVersionTexts, parseSemVer } from './semver';
import type { LastRunVersion, SelfUpdateRecord, UpdateObservation } from './types';
import type { UpdateFailureReason, UpdateMessage } from './updateMessages';
import type { AutoUpdateMode, UpdateSettings } from './updateModes';
import type { UpdatePendingMarker } from './updatePending';
import {
  decideGitUpdate,
  decideNpmUpdate,
  type GitCheck,
  type GitPolicyDecision,
  type IdleVerdict,
  type NpmPolicyDecision,
} from './updatePolicy';

/**
 * The update engine: finds a new version, installs it when nobody is using the bot, restarts invisibly and says in General
 * what happened. It decides nothing itself — `updatePolicy.ts` does — and touches nothing directly: every effect (the clock,
 * the registry, the checkout, the process, Telegram) is a port, so the whole flow runs in a test against fakes.
 *
 * One engine per process. `runBootStep` is what a start does (confirm or settle the last update, announce a version change,
 * notice a newer install on disk or a stale supervisor); `start` arms the hourly check; the idle loop installs / restarts /
 * signals the supervisor at the first idle moment.
 */

const maxRememberedTargets = 50;
const maxRememberedFirstSeen = 20;

/** What `setTimer` hands back: a Node timer, or any number a fake clock uses. */
export type TimerHandle = number | NodeJS.Timeout;

export interface UpdateEngineDeps {
  now: () => number;
  setTimer: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer: (handle: TimerHandle) => void;
  log: (line: string) => void;
  /** Read at every use: a hand edit of `settings.json` applies at the next check. */
  getSettings: () => UpdateSettings;
  state: {
    getRecord: () => SelfUpdateRecord;
    setRecord: (record: SelfUpdateRecord) => void;
    getLastRun: () => LastRunVersion | undefined;
    setLastRun: (lastRun: LastRunVersion) => Promise<void>;
  };
  /** The version (and commit, for a checkout) this process STARTED as. */
  running: LastRunVersion;
  runningNode: string;
  installKind: InstallKind;
  isHotMode: boolean;
  npm: NpmSource | null;
  git: GitSource | null;
  hostLock: { acquire: () => HostLock | null } | null;
  /** The version `package.json` on disk says now — newer than `running` after a manual `npm i -g` or another instance's install. */
  readInstalledVersion: () => string | null;
  /** `CHANGELOG.md` of the installed package, for the what's-new list. */
  readInstalledChangelog: () => string | null;
  /** Commits `from`..`to` of a checkout, for "(12 commits)"; `null` when unknown. */
  countCommits: (from: string, to: string) => Promise<number | null>;
  getIdleVerdict: (isUserRequested: boolean) => IdleVerdict;
  postToGeneral: (message: UpdateMessage) => Promise<void>;
  /** The self-check of a new install, run as a child process of it. */
  runSelfCheck: (expectVersion: string | null) => Promise<{ ok: boolean; detail: string }>;
  /** Replace this process with a fresh image of the same install; never returns on success. Throws when it cannot. */
  restartInPlace: () => Promise<void>;
  reexecTarget: ReexecTarget;
  marker: {
    read: () => UpdatePendingMarker | null;
    write: (marker: UpdatePendingMarker) => void;
    clear: () => void;
  };
  supervisor: {
    readRecord: () => HotSupervisorRecord | null;
    getStaleModules: (record: HotSupervisorRecord) => string[];
    requestReexec: (record: HotSupervisorRecord) => SupervisorSignalResult;
  };
}

export type UpdatePhase = 'idle' | 'waitingForIdle' | 'installing' | 'restartPending';

/** What a new version is, for the `/update` screen. */
export interface UpdateOffer {
  /** The npm version or the checkout's target commit. */
  target: string;
  action: 'waitHold' | 'installWhenIdle' | 'notify' | 'offerMajor' | 'offerBreaking' | 'needsNode' | 'skipped';
  /** `waitHold`: when the bot may install it by itself. */
  until: number | null;
  required: string | null;
  skipReason: string | null;
  /** Whether «Update to X now» makes sense: there is something to install and this install can install it. */
  canInstallNow: boolean;
}

export interface UpdateStatus {
  running: LastRunVersion;
  installKind: InstallKind;
  /** Run as a hot worker (`charness hot`): the watcher, not a restart, brings an update in. */
  isHotMode: boolean;
  runningNode: string;
  settings: UpdateSettings;
  lastCheckAt: number | null;
  observation: UpdateObservation | null;
  isCheckFailing: boolean;
  offer: UpdateOffer | null;
  phase: UpdatePhase;
  /** The target being installed or waiting to restart onto. */
  inProgressTarget: string | null;
}

export type InstallRequestResult = 'started' | 'alreadyUpToDate' | 'busy' | 'cannotInstall';

export interface UpdateEngine {
  /** Arm the hourly check. */
  start: () => void;
  stop: () => void;
  /** What a boot does about updates; call once, when Telegram is about to launch. */
  runBootStep: () => Promise<void>;
  /** A check that posts nothing to General (the «Check now» button, the text form) — also with `autoUpdate: off`. */
  checkNow: () => Promise<UpdateStatus>;
  /** «Update to X now»: skips the hold and the quiet period, still waits for running work. */
  requestInstall: (target: string) => Promise<InstallRequestResult>;
  getStatus: () => UpdateStatus;
}

interface PendingInstall {
  target: string;
  isUserRequested: boolean;
  /** git: the range's migration guide was allowed by a tap. */
  isBreakingAllowed: boolean;
}

function getManualCommand(installKind: InstallKind): string {
  if (installKind.kind === 'notifyOnly') return installKind.manualCommand;
  if (installKind.kind === 'checkout') return `${installKind.root}/scripts/self-update.sh`;
  return npmManualCommand;
}

function limitLength<TItem>(items: readonly TItem[], limit: number): TItem[] {
  return items.slice(-limit);
}

export function createUpdateEngine(deps: UpdateEngineDeps): UpdateEngine {
  let checkTimer: TimerHandle | null = null;
  let idleTimer: TimerHandle | null = null;
  let confirmTimer: TimerHandle | null = null;
  let hotDeadlineTimer: TimerHandle | null = null;
  let isCheckRunning = false;
  let phase: UpdatePhase = 'idle';
  let pendingInstall: PendingInstall | null = null;
  let inProgressTarget: string | null = null;
  /** The newer install on disk (another instance's, or a manual one) this process will restart onto at its idle point. */
  let isRestartOntoDiskWanted = false;
  let isSupervisorReexecWanted = false;
  let isRestartBlocked = false;

  const canInstall = deps.installKind.kind === 'npmGlobal' || deps.installKind.kind === 'checkout';
  /** A checkout that cannot update itself is not watched either: `/update` names the reason and the command. */
  const isUnwatchedCheckout = deps.installKind.kind === 'notifyOnly' && deps.installKind.isCheckout;

  function updateRecord(change: (record: SelfUpdateRecord) => SelfUpdateRecord): void {
    deps.state.setRecord(change({ ...deps.state.getRecord() }));
  }

  function rememberTarget(listName: 'failedTargets' | 'notifiedTargets', target: string): void {
    updateRecord((record) => ({ ...record, [listName]: limitLength([...(record[listName] ?? []).filter((entry) => entry !== target), target], maxRememberedTargets) }));
  }

  async function say(message: UpdateMessage): Promise<void> {
    try {
      await deps.postToGeneral(message);
    } catch (error) {
      deps.log(`[update] posting to General failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ── observing ──

  function recordObservation(observation: UpdateObservation, isFailure: boolean): void {
    updateRecord((record) => ({
      ...record,
      lastCheckAt: deps.now(),
      lastResult: { at: deps.now(), observation },
      isCheckFailing: isFailure,
    }));
  }

  /** Remember when this bot first saw `version`; forget the versions the running one has caught up with. */
  function noteFirstSeen(version: string): number {
    const record = deps.state.getRecord();
    const firstSeen = record.firstSeenAt ?? {};
    if (firstSeen[version] !== undefined) return firstSeen[version];
    const current = Object.fromEntries(
      Object.entries(firstSeen)
        .filter(([seenVersion]) => (compareVersionTexts(seenVersion, deps.running.version) ?? 1) > 0)
        .slice(-maxRememberedFirstSeen),
    );
    deps.state.setRecord({ ...record, firstSeenAt: { ...current, [version]: deps.now() } });
    return deps.now();
  }

  /** What the screen shows is what is out, also with the mode `off` (which only silences the schedule): `off` reads as `notify` there. */
  function getEffectiveMode(isForDisplay: boolean): AutoUpdateMode {
    const mode = deps.getSettings().autoUpdate;
    return isForDisplay && mode === 'off' ? 'notify' : mode;
  }

  function decideNpm(latest: { version: string; engines: string | null; isDeprecated: boolean }, isUserRequested: boolean, isForDisplay = false): NpmPolicyDecision {
    const record = deps.state.getRecord();
    return decideNpmUpdate({
      runningVersion: deps.running.version,
      runningNode: deps.runningNode,
      latest,
      firstSeenAt: record.firstSeenAt?.[latest.version],
      now: deps.now(),
      mode: getEffectiveMode(isForDisplay),
      failedTargets: record.failedTargets ?? [],
      canInstall,
      isUserRequested,
    });
  }

  function decideGit(check: GitCheck, isUserRequested: boolean, isForDisplay = false): GitPolicyDecision {
    return decideGitUpdate({
      check,
      mode: getEffectiveMode(isForDisplay),
      failedTargets: deps.state.getRecord().failedTargets ?? [],
      canInstall,
      isUserRequested,
    });
  }

  /** Act on what an automatic check saw: record it, announce it once, queue the install. `isManual` posts nothing. */
  async function actOnNpm(latest: { version: string; engines: string | null; isDeprecated: boolean }, isManual: boolean): Promise<void> {
    noteFirstSeen(latest.version);
    const decision = decideNpm(latest, false);
    if (isManual) return;
    const notified = deps.state.getRecord().notifiedTargets ?? [];
    switch (decision.action) {
      case 'install':
        queueInstall({ target: latest.version, isUserRequested: false, isBreakingAllowed: false });
        break;
      case 'notify':
        if (notified.includes(latest.version)) break;
        rememberTarget('notifiedTargets', latest.version);
        await say({ kind: 'notify', version: latest.version, running: deps.running.version, canInstall, manualCommand: getManualCommand(deps.installKind) });
        break;
      case 'offerMajor':
        if (notified.includes(latest.version)) break;
        rememberTarget('notifiedTargets', latest.version);
        await say({ kind: 'offerMajor', version: latest.version, running: deps.running.version });
        break;
      case 'needsNode':
        if (notified.includes(latest.version)) break;
        rememberTarget('notifiedTargets', latest.version);
        await say({ kind: 'needsNode', version: latest.version, required: decision.required, runningNode: deps.runningNode });
        break;
      case 'waitHold':
      case 'none':
        break;
    }
  }

  async function actOnGit(check: GitCheck, isManual: boolean): Promise<void> {
    const decision = decideGit(check, false);
    if (isManual) return;
    const notified = deps.state.getRecord().notifiedTargets ?? [];
    switch (decision.action) {
      case 'install':
        queueInstall({ target: check.to, isUserRequested: false, isBreakingAllowed: false });
        break;
      case 'notify':
        if (notified.includes(check.to)) break;
        rememberTarget('notifiedTargets', check.to);
        await say({ kind: 'notify', version: check.to, running: deps.running.commit ?? deps.running.version, canInstall, manualCommand: getManualCommand(deps.installKind) });
        break;
      case 'offerBreaking':
        if (notified.includes(check.to)) break;
        rememberTarget('notifiedTargets', check.to);
        await say({ kind: 'offerBreaking', from: check.from, to: check.to, migrationGuides: decision.migrationGuides });
        break;
      case 'skipped':
      case 'none':
        break;
    }
  }

  async function runCheck(options: { isManual: boolean }): Promise<void> {
    if (isCheckRunning) return;
    isCheckRunning = true;
    try {
      noteInstalledVersion();
      if (getPendingKind() !== null) armIdleLoop();
      if (deps.installKind.kind === 'ephemeral') return;
      const isFailing = deps.state.getRecord().isCheckFailing === true;
      try {
        if (deps.installKind.kind === 'checkout' && deps.git) {
          const check = await deps.git.check();
          const observation: UpdateObservation = { kind: 'git', status: check.status, reason: check.reason, from: check.from, to: check.to, behind: check.behind, migrationGuides: check.migrationGuides };
          if (check.status === 'skip' && check.reason === 'fetchFailed') throw new UpdateSourceError('the remote did not answer');
          recordObservation(observation, false);
          await actOnGit(check, options.isManual);
        } else if (deps.installKind.kind !== 'checkout' && !isUnwatchedCheckout && deps.npm) {
          const latest = await deps.npm.getLatest();
          recordObservation({ kind: 'npm', latestVersion: latest.version, engines: latest.engines, isDeprecated: latest.isDeprecated }, false);
          await actOnNpm(latest, options.isManual);
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        deps.log(`[update] check failed: ${reason}`);
        recordObservation({ kind: 'error', reason }, true);
        if (!isFailing && !options.isManual) await say({ kind: 'checkFailing', reason });
      }
    } finally {
      isCheckRunning = false;
    }
  }

  // ── scheduling ──

  function scheduleNextCheck(delayMs: number): void {
    if (checkTimer !== null) deps.clearTimer(checkTimer);
    checkTimer = deps.setTimer(() => {
      checkTimer = null;
      void runScheduledCheck();
    }, delayMs);
  }

  async function runScheduledCheck(): Promise<void> {
    try {
      // A newer install on disk is no update decision, only the running process catching up with its own install, so it is
      // noticed whatever the mode. `off` makes no registry or git traffic: the timer keeps ticking so a hand edit to `on` applies.
      noteInstalledVersion();
      if (deps.getSettings().autoUpdate !== 'off') await runCheck({ isManual: false });
    } finally {
      if (getPendingKind() !== null) armIdleLoop();
      scheduleNextCheck(checkIntervalMs);
    }
  }

  function getFirstCheckDelayMs(): number {
    const lastCheckAt = deps.state.getRecord().lastCheckAt;
    const sinceLastCheck = lastCheckAt === undefined ? Infinity : deps.now() - lastCheckAt;
    return Math.max(firstCheckDelayMs, checkIntervalMs - sinceLastCheck);
  }

  function armIdleLoop(): void {
    if (idleTimer !== null) return;
    idleTimer = deps.setTimer(() => {
      idleTimer = null;
      void runIdleStep();
    }, idlePollIntervalMs);
  }

  function queueInstall(request: PendingInstall): void {
    if (phase === 'installing' || phase === 'restartPending') return;
    pendingInstall = request;
    inProgressTarget = request.target;
    phase = 'waitingForIdle';
    armIdleLoop();
  }

  function getPendingKind(): 'install' | 'restart' | 'supervisor' | null {
    // In hot mode nodemon replaces the worker by itself after a pull: there is no restart to perform, only the deadline to watch.
    if (!isRestartBlocked && ((phase === 'restartPending' && !deps.isHotMode) || isRestartOntoDiskWanted)) return 'restart';
    if (pendingInstall !== null && phase === 'waitingForIdle') return 'install';
    if (isSupervisorReexecWanted) return 'supervisor';
    return null;
  }

  /** One tick of the idle loop: do whichever pending thing the bot's idleness now allows. */
  async function runIdleStep(): Promise<void> {
    if (phase === 'installing') return;
    // Another instance's install (or a manual one) may have landed on disk since the last tick.
    noteInstalledVersion();
    const pending = getPendingKind();
    if (pending === null) return;
    const isUserRequested = (pending === 'install' || pending === 'restart') && (pendingInstall?.isUserRequested ?? false);
    const verdict = deps.getIdleVerdict(isUserRequested);
    if (!verdict.isIdle) {
      armIdleLoop();
      return;
    }
    if (pending === 'install' && pendingInstall) {
      await performInstall(pendingInstall);
      // The install took minutes: whether the bot is STILL idle is asked at once — not a poll interval later.
      if (phase === 'restartPending' && !deps.isHotMode) {
        await runIdleStep();
        return;
      }
    } else if (pending === 'restart') {
      await performRestart();
    } else {
      await performSupervisorReexec();
    }
    if (getPendingKind() !== null) armIdleLoop();
  }

  function noteInstalledVersion(): void {
    // A root-owned prefix is updated by hand (`sudo npm i -g`): the restart onto it is the bot's to do, the install is not.
    const isNpmInstall = deps.installKind.kind === 'npmGlobal' || (deps.installKind.kind === 'notifyOnly' && deps.installKind.reason === 'readOnlyPrefix');
    if (!isNpmInstall) return;
    const installed = deps.readInstalledVersion();
    if (installed !== null && (compareVersionTexts(installed, deps.running.version) ?? 0) > 0) isRestartOntoDiskWanted = true;
  }

  // ── installing ──

  function createMarker(kind: 'npm' | 'git', to: LastRunVersion, isUserRequested: boolean): UpdatePendingMarker {
    return { kind, status: 'pending', from: deps.running, to, attempts: 0, isUserRequested };
  }

  /** The install failed or did not start: the target is never retried by itself, one line says so. */
  async function failInstall(target: string, reason: UpdateFailureReason, detail: string, rollbackFailure: string | null): Promise<void> {
    deps.log(`[update] ${target} failed (${reason}): ${detail}${rollbackFailure ? `; going back failed: ${rollbackFailure}` : ''}`);
    deps.marker.clear();
    rememberTarget('failedTargets', target);
    pendingInstall = null;
    inProgressTarget = null;
    phase = 'idle';
    if (rollbackFailure !== null) {
      await say({ kind: 'rollbackFailed', target, reason, manualCommand: getManualCommand(deps.installKind) });
    } else {
      await say({ kind: 'installFailed', target, reason, stillRunning: deps.running.commit ?? deps.running.version, manualCommand: getManualCommand(deps.installKind) });
    }
  }

  async function installNpm(request: PendingInstall): Promise<void> {
    if (!deps.npm || deps.installKind.kind !== 'npmGlobal') return;
    const lock = deps.hostLock?.acquire() ?? null;
    if (lock === null) {
      // Another instance on this install is installing: we will find the new version on disk and restart onto it.
      deps.log('[update] another instance holds the install lock — waiting for it to finish');
      phase = 'waitingForIdle';
      armIdleLoop();
      return;
    }
    phase = 'installing';
    try {
      try {
        // An operator's own `npm i -g` may already have put the target there: it is checked and restarted onto, not installed twice.
        if (deps.readInstalledVersion() !== request.target) await deps.npm.install(request.target);
      } catch (error) {
        await failInstall(request.target, 'install', error instanceof Error ? error.message : String(error), null);
        return;
      }
      const check = await deps.runSelfCheck(request.target);
      if (!check.ok) {
        let rollbackFailure: string | null = null;
        try {
          await deps.npm.install(deps.running.version, { isRollback: true });
        } catch (error) {
          rollbackFailure = error instanceof Error ? error.message : String(error);
        }
        await failInstall(request.target, 'start', check.detail, rollbackFailure);
        return;
      }
      deps.marker.write(createMarker('npm', { version: request.target, commit: null }, request.isUserRequested));
      phase = 'restartPending';
    } finally {
      lock.release();
    }
  }

  async function installGit(request: PendingInstall): Promise<void> {
    if (!deps.git || deps.installKind.kind !== 'checkout') return;
    phase = 'installing';
    deps.marker.write(createMarker('git', { version: deps.running.version, commit: request.target }, request.isUserRequested));
    let result: GitApplyResult;
    try {
      result = await deps.git.apply({ holdBreaking: !request.isBreakingAllowed });
    } catch (error) {
      // The script may have fast-forwarded before its install or build failed: put the checkout back on the commit that ran.
      // Resetting to where it already is changes nothing, so a failure before the pull needs no special case.
      let rollbackFailure: string | null = null;
      if (deps.running.commit !== null) {
        try {
          await deps.git.rollback({ from: deps.running.commit, to: request.target, isHot: deps.isHotMode });
        } catch (rollbackError) {
          rollbackFailure = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
        }
      }
      await failInstall(request.target, 'install', error instanceof Error ? error.message : String(error), rollbackFailure);
      return;
    }
    if (result.status === 'held') {
      deps.marker.clear();
      phase = 'idle';
      pendingInstall = null;
      inProgressTarget = null;
      const notified = deps.state.getRecord().notifiedTargets ?? [];
      if (!notified.includes(result.to)) {
        rememberTarget('notifiedTargets', result.to);
        await say({ kind: 'offerBreaking', from: result.from, to: result.to, migrationGuides: result.migrationGuides });
      }
      return;
    }
    if (result.status !== 'updated') {
      deps.marker.clear();
      phase = 'idle';
      pendingInstall = null;
      inProgressTarget = null;
      return;
    }
    const marker = createMarker('git', { version: deps.running.version, commit: result.to }, request.isUserRequested);
    deps.marker.write({ ...marker, from: { version: deps.running.version, commit: result.from } });
    if (deps.isHotMode) {
      // The watcher rebuilds and nodemon replaces this worker by itself. If no new worker has replaced us by the deadline,
      // the build is taken as failed and the checkout goes back.
      phase = 'restartPending';
      hotDeadlineTimer = deps.setTimer(() => {
        hotDeadlineTimer = null;
        void rollBackHotBuild(result.from, result.to);
      }, hotBuildDeadlineMs);
      return;
    }
    const check = await deps.runSelfCheck(null);
    if (!check.ok) {
      let rollbackFailure: string | null = null;
      try {
        await deps.git.rollback({ from: result.from, to: result.to, isHot: false });
      } catch (error) {
        rollbackFailure = error instanceof Error ? error.message : String(error);
      }
      await failInstall(result.to, 'start', check.detail, rollbackFailure);
      return;
    }
    phase = 'restartPending';
  }

  async function rollBackHotBuild(from: string, to: string): Promise<void> {
    if (!deps.git) return;
    let rollbackFailure: string | null = null;
    try {
      await deps.git.rollback({ from, to, isHot: true });
    } catch (error) {
      rollbackFailure = error instanceof Error ? error.message : String(error);
    }
    await failInstall(to, 'build', 'no new worker started after the pull', rollbackFailure);
  }

  async function performInstall(request: PendingInstall): Promise<void> {
    if (deps.installKind.kind === 'checkout') await installGit(request);
    else await installNpm(request);
  }

  async function performRestart(): Promise<void> {
    const problems = getReexecProblems(deps.reexecTarget);
    if (problems.length > 0) {
      isRestartBlocked = true;
      deps.log(`[update] cannot restart: ${problems.join('; ')}`);
      return;
    }
    if (phase !== 'restartPending') {
      // A newer install already on disk (a manual `npm i -g`, another instance's install): probed first, like one this bot
      // made — a broken one is not restarted onto — and the restart gets the same marker, so the new boot says "Updated" and a
      // version that cannot start is rolled back.
      const installed = deps.readInstalledVersion();
      if (installed !== null) {
        const check = await deps.runSelfCheck(installed);
        if (!check.ok) {
          isRestartBlocked = true;
          deps.log(`[update] the install on disk (${installed}) fails its self-check, not restarting onto it: ${check.detail}`);
          return;
        }
        deps.marker.write(createMarker('npm', { version: installed, commit: null }, pendingInstall?.isUserRequested ?? false));
      }
    }
    phase = 'restartPending';
    try {
      await deps.restartInPlace();
    } catch (error) {
      isRestartBlocked = true;
      deps.log(`[update] restart failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function performSupervisorReexec(): Promise<void> {
    const record = deps.supervisor.readRecord();
    if (record === null) {
      isSupervisorReexecWanted = false;
      return;
    }
    const result = deps.supervisor.requestReexec(record);
    isSupervisorReexecWanted = false;
    deps.log(`[update] supervisor re-exec requested: ${result}`);
    // The re-exec ends this boot ON PURPOSE (and runs synchronously before the supervisor's signal reaches this worker): it is not a
    // start that failed, so it must not use up the boots the update may fail — a restart soon after would roll a healthy version back.
    if (result === 'signaled') releaseBootAttempt();
  }

  function releaseBootAttempt(): void {
    const marker = deps.marker.read();
    if (marker?.status === 'pending' && marker.attempts > 0) deps.marker.write({ ...marker, attempts: marker.attempts - 1 });
  }

  // ── booting ──

  function scheduleBootConfirmation(): void {
    confirmTimer = deps.setTimer(() => {
      confirmTimer = null;
      const marker = deps.marker.read();
      if (marker?.status === 'pending') {
        deps.marker.clear();
        deps.log('[update] the new version is confirmed');
      }
    }, bootConfirmMs);
  }

  async function getNotes(from: LastRunVersion, to: LastRunVersion): Promise<{ summary: WhatsNewSummary | null; commitCount: number | null }> {
    if (!deps.getSettings().whatsNew) return { summary: null, commitCount: await getCommitCount(from, to) };
    if (to.commit !== null && from.commit !== null && deps.git) {
      try {
        return { summary: getCheckoutReleaseNotes(await deps.git.getChangelogDiff(from.commit, to.commit)), commitCount: await getCommitCount(from, to) };
      } catch (error) {
        deps.log(`[update] no what's-new list: ${error instanceof Error ? error.message : String(error)}`);
        return { summary: null, commitCount: null };
      }
    }
    const changelog = deps.readInstalledChangelog();
    return { summary: changelog === null ? null : getNpmReleaseNotes(changelog, from.version, to.version), commitCount: null };
  }

  async function getCommitCount(from: LastRunVersion, to: LastRunVersion): Promise<number | null> {
    return from.commit !== null && to.commit !== null ? deps.countCommits(from.commit, to.commit) : null;
  }

  function describeVersionPoint(point: LastRunVersion, isCheckout: boolean): string {
    return isCheckout && point.commit !== null ? point.commit : point.version;
  }

  async function announceVersionChange(lastRun: LastRunVersion, marker: UpdatePendingMarker | null): Promise<void> {
    const isCheckout = deps.running.commit !== null;
    const { summary, commitCount } = await getNotes(lastRun, deps.running);
    const from = describeVersionPoint(lastRun, isCheckout);
    const to = describeVersionPoint(deps.running, isCheckout);
    // A bot that updated itself ALWAYS says so; a version change someone else made says only what changed, when asked to.
    const isSelfUpdate = marker !== null && marker.status === 'pending';
    if (isSelfUpdate) {
      await say({ kind: 'updated', from, to, commitCount, summary });
      return;
    }
    if (summary !== null) await say({ kind: 'nowRunning', from, to, summary });
  }

  async function settleFailedUpdate(marker: UpdatePendingMarker): Promise<void> {
    const target = marker.to.commit ?? marker.to.version;
    rememberTarget('failedTargets', target);
    deps.marker.clear();
    const reason: UpdateFailureReason = 'boot';
    if (marker.status === 'rollbackFailed') {
      await say({ kind: 'rollbackFailed', target, reason, manualCommand: getManualCommand(deps.installKind) });
    } else {
      await say({ kind: 'installFailed', target, reason, stillRunning: deps.running.commit ?? deps.running.version, manualCommand: getManualCommand(deps.installKind) });
    }
  }

  async function runBootStep(): Promise<void> {
    const marker = deps.marker.read();
    if (marker !== null && marker.status !== 'pending') {
      await settleFailedUpdate(marker);
    } else if (marker !== null) {
      scheduleBootConfirmation();
    }

    const lastRun = deps.state.getLastRun();
    const isFirstRun = lastRun === undefined;
    const hasChanged = lastRun !== undefined && (lastRun.version !== deps.running.version || lastRun.commit !== deps.running.commit);
    await deps.state.setLastRun(deps.running);
    if (hasChanged && marker?.status !== 'rolledBack' && marker?.status !== 'rollbackFailed') {
      await announceVersionChange(lastRun, marker);
    }

    const settings = deps.getSettings();
    const record = deps.state.getRecord();
    if (isFirstRun && !record.isFeatureAnnounced && settings.autoUpdate !== 'off') {
      updateRecord((current) => ({ ...current, isFeatureAnnounced: true }));
      await say({ kind: 'featureAnnounced', mode: settings.autoUpdate });
    }

    noteInstalledVersion();
    await noteSupervisor(hasChanged);
    if (getPendingKind() !== null) armIdleLoop();
  }

  /** A hot supervisor that loaded a file the update changed must be replaced; an old one cannot be, and says so once. */
  async function noteSupervisor(hasVersionChanged: boolean): Promise<void> {
    if (!deps.isHotMode) return;
    const record = deps.supervisor.readRecord();
    if (record === null) {
      if (hasVersionChanged) await say({ kind: 'restartSupervisor' });
      return;
    }
    if (deps.supervisor.getStaleModules(record).length > 0) isSupervisorReexecWanted = true;
  }

  // ── the screen ──

  function getOffer(): UpdateOffer | null {
    const observation = deps.state.getRecord().lastResult?.observation;
    if (observation?.kind === 'npm') {
      const latest = { version: observation.latestVersion, engines: observation.engines, isDeprecated: observation.isDeprecated };
      // What a TAP could do now (no hold, a major allowed) decides the button — a version this Node cannot run has none — and a
      // Node that is too old is said at once, not after the hold that only delays what the bot itself would announce.
      const tapDecision = decideNpm(latest, true, true);
      const base = { target: latest.version, until: null, required: null, skipReason: null, canInstallNow: canInstall && tapDecision.action === 'install' };
      if (tapDecision.action === 'needsNode') return { ...base, action: 'needsNode', required: tapDecision.required, canInstallNow: false };
      const decision = decideNpm(latest, false, true);
      const isMajor = (parseSemVer(latest.version)?.major ?? 0) > (parseSemVer(deps.running.version)?.major ?? 0);
      switch (decision.action) {
        case 'none':
          return null;
        case 'waitHold':
          // A major is never installed by itself, hold or not: say that, not "will install by itself".
          return isMajor ? { ...base, action: 'offerMajor' } : { ...base, action: 'waitHold', until: decision.until };
        case 'install':
          return { ...base, action: 'installWhenIdle' };
        case 'notify':
          return { ...base, action: 'notify' };
        case 'offerMajor':
          return { ...base, action: 'offerMajor' };
        case 'needsNode':
          return { ...base, action: 'needsNode', required: decision.required, canInstallNow: false };
      }
    }
    if (observation?.kind === 'git') {
      const check: GitCheck = { status: observation.status, reason: observation.reason, from: observation.from, to: observation.to, behind: observation.behind, migrationGuides: observation.migrationGuides };
      const decision = decideGit(check, false, true);
      const base = { target: check.to, until: null, required: null, skipReason: null, canInstallNow: canInstall };
      switch (decision.action) {
        case 'none':
          return null;
        case 'skipped':
          return { ...base, action: 'skipped', skipReason: decision.reason, canInstallNow: false };
        case 'install':
          return { ...base, action: 'installWhenIdle' };
        case 'notify':
          return { ...base, action: 'notify' };
        case 'offerBreaking':
          return { ...base, action: 'offerBreaking' };
      }
    }
    return null;
  }

  function getStatus(): UpdateStatus {
    const record = deps.state.getRecord();
    return {
      running: deps.running,
      installKind: deps.installKind,
      isHotMode: deps.isHotMode,
      runningNode: deps.runningNode,
      settings: deps.getSettings(),
      lastCheckAt: record.lastCheckAt ?? null,
      observation: record.lastResult?.observation ?? null,
      isCheckFailing: record.isCheckFailing === true,
      offer: getOffer(),
      phase,
      inProgressTarget,
    };
  }

  return {
    start() {
      scheduleNextCheck(getFirstCheckDelayMs());
    },
    stop() {
      for (const timer of [checkTimer, idleTimer, confirmTimer, hotDeadlineTimer]) if (timer !== null) deps.clearTimer(timer);
      checkTimer = idleTimer = confirmTimer = hotDeadlineTimer = null;
    },
    runBootStep,
    async checkNow() {
      await runCheck({ isManual: true });
      return getStatus();
    },
    async requestInstall(target) {
      const offer = getOffer();
      if (phase === 'installing' || phase === 'restartPending') return 'busy';
      if (!canInstall) return 'cannotInstall';
      if (offer === null || offer.target !== target || !offer.canInstallNow) return 'alreadyUpToDate';
      queueInstall({ target, isUserRequested: true, isBreakingAllowed: true });
      // Do not wait a poll interval for an idle bot: try at once.
      if (idleTimer !== null) {
        deps.clearTimer(idleTimer);
        idleTimer = null;
      }
      void runIdleStep();
      return 'started';
    },
    getStatus,
  };
}
