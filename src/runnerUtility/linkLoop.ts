import type { Client } from 'ssh2';
import { restartExitCode } from './appInstall';
import { decideUpdate, updateFromHub, type UpdateOutcome } from './appUpdate';
import { formatLinkCommand, lidRecordedMarkerValue, redeemReplySchema } from '../runners/gateProtocol';
import { unconfirmedRemovalStopAfterMs } from '../runners/removalTiming';
import { callGate, connectToHub, HubConnectionError, requestGateJson, sendLidReport, type HubEndpoint } from './hubClient';
import { readLidPollMs } from './lidPollTiming';
import type { LidWatcher } from './lidState';
import { readRunnerVersionPollMs } from './versionPollTiming';
import { writeRunnerStatus, type LinkState, type RunnerConfig } from './runnerConfig';
import type { RunnerHomePaths } from './runnerHome';
import type { RunnerKeys } from './runnerKeys';
import type { RunnerServers } from './runnerServers';

/**
 * @description The runner's permanent link to the hub: connect (outbound ssh, host key pinned, the runner's own key), run `link`, hand the
 * channel to the built-in ssh server, and when it drops come back — forever. The pairing survives restarts, reboots, sleep and network
 * changes because nothing here is state but `config.json` and the keys.
 *
 *   backoff   1 s, doubling, up to 5 min, ±20 % jitter; a link that held for 30 s starts the series again
 *   removed   the hub no longer knows this runner: its key is refused (twice, a short time apart — one refusal could be a key file being
 *             rewritten), or the gate answers that the runner is not paired. Say so in the status, STOP THE QUEUE'S JOBS (Pueue outlives
 *             the link by design, so a removal must be told apart from an ordinary disconnection and end the work the hub's agents
 *             left running here), and ask again once an hour — never a flood that trips fail2ban
 *   update    the `link` answer names the hub's package id, and a linked runner asks again every few minutes (`version`, over the
 *             connection it holds); an idle runner whose id differs updates and asks the launcher for a restart
 *   lid       a Mac's link carries its lid IN the request that makes the link (`link lid=closed`): the hub records it before the link's socket exists, so a Mac that
 *             woke in the dark for a minute is never online with the lid of the last time. Then it looks at the lid every few seconds and tells the hub when it
 *             changed (`lidState.ts`), over the connection it already holds. A hub that does not know the argument (an older one) gets the plain `link`
 *   closing   the attempt ends when the `link` CHANNEL ends or the connection does — the hub's gate dying, or the link being cut, closes
 *             the channel while the connection to sshd stays up and keeps answering keepalives, so the connection alone proves nothing
 */

const initialBackoffMs = 1000;
const maxBackoffMs = 5 * 60 * 1000;
const jitterRatio = 0.2;
const stableLinkMs = 30 * 1000;
export const removedRetryMs = 60 * 60 * 1000;
/** How long after the first refusal of the key a second one confirms that the runner was removed. */
export const removalConfirmMs = 15 * 1000;

/** @description The wait before attempt number `failures + 1` (0 failures: the first retry); `random` is in [0, 1). */
export function computeBackoffMs(failures: number, random: number): number {
  const base = Math.min(maxBackoffMs, initialBackoffMs * 2 ** Math.max(0, failures));
  return Math.round(base * (1 - jitterRatio + 2 * jitterRatio * random));
}

export interface LinkLoopDeps {
  paths: RunnerHomePaths;
  config: RunnerConfig;
  keys: RunnerKeys;
  servers: RunnerServers;
  now?: () => number;
  /** How often a linked runner asks the hub for its package (default: {@link readRunnerVersionPollMs}). */
  versionPollMs?: number;
  /** Stops the jobs of the queue; called when the runner learns it was removed. */
  stopJobs?: () => Promise<void>;
  /** The wait between the two refusals that confirm a removal (default {@link removalConfirmMs}). */
  removalConfirmMs?: number;
  /** How long a bare refusal of the key must last before it stops the jobs (default {@link unconfirmedRemovalStopAfterMs}). */
  unconfirmedRemovalStopAfterMs?: number;
  /** A Mac's lid watcher (`lidState.ts`); absent off a Mac: such a runner never reports a lid. */
  lid?: LidWatcher;
  /** How often the lid is looked at (default {@link readLidPollMs}). */
  lidPollMs?: number;
  random?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  connect?: typeof connectToHub;
  update?: typeof updateFromHub;
  /** Called when an update of the program, started by this loop, has settled (installed or failed): whoever waited for it may look again. */
  onUpdateSettled?: () => void;
  log?: (line: string) => void;
}

export interface LinkLoopHandle {
  /** Run until aborted (resolves 0) or until an update asks for a restart (resolves {@link restartExitCode}). */
  run: (signal: AbortSignal) => Promise<number>;
  /** The built-in server calls this whenever the number of running commands changes. */
  notifyActiveCountChange: () => void;
  /** Is an update of the program being downloaded or installed right now? Leaving then would orphan its `npm ci` and have the whole update done again. */
  isUpdating: () => boolean;
}

function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

type AttemptResult = { kind: 'closed'; lastedMs: number } | { kind: 'removed'; isConfirmed: boolean } | { kind: 'failed'; reason: string } | { kind: 'restart' };

export function createLinkLoop(deps: LinkLoopDeps): LinkLoopHandle {
  const now = deps.now ?? Date.now;
  const random = deps.random ?? Math.random;
  const sleep = deps.sleep ?? sleepUnlessAborted;
  const connect = deps.connect ?? connectToHub;
  const update = deps.update ?? updateFromHub;
  const log = deps.log ?? (() => undefined);
  const versionPollMs = deps.versionPollMs ?? readRunnerVersionPollMs(process.env);
  const lidLookMs = deps.lidPollMs ?? readLidPollMs(process.env);
  const confirmMs = deps.removalConfirmMs ?? removalConfirmMs;
  const stopAfterMs = deps.unconfirmedRemovalStopAfterMs ?? unconfirmedRemovalStopAfterMs;
  const endpoint: HubEndpoint = { host: deps.config.hub.host, port: deps.config.hub.port, user: deps.config.hub.user, hostKey: deps.config.hub.hostKey };
  let installedPackageId = deps.config.packageId;
  /** Cleared while the hub that answers does not know the lid argument (its marker names no epoch): asking again would only be refused. Set again by the first marker that names one (the hub was updated). */
  let isLinkLidAccepted = true;
  let state: LinkState = 'connecting';
  let stateSinceMs = now();
  let lastError: string | null = null;
  let failedUpdate: { packageId: string; atMs: number } | null = null;
  let updatesInProgress = 0;
  let pendingUpdateId: string | null = null;
  let onIdleUpdate: (() => void) | null = null;

  const writeStatus = (nextState: LinkState, error: string | null): void => {
    if (nextState !== state) {
      state = nextState;
      stateSinceMs = now();
    }
    lastError = error;
    try {
      writeRunnerStatus(deps.paths, { pid: process.pid, state, sinceMs: stateSinceMs, updatedAtMs: now(), lastError, activeJobs: deps.servers.getActiveExecCount(), packageId: installedPackageId });
    } catch (writeError) {
      log(`cannot write status.json (${writeError instanceof Error ? writeError.message : 'unknown'})`);
    }
  };

  const tryUpdate = async (hubPackageId: string, signal: AbortSignal): Promise<UpdateOutcome | null> => {
    log(`updating to the hub's package ${hubPackageId}`);
    updatesInProgress += 1;
    try {
      const outcome = await update({ paths: deps.paths, config: { ...deps.config, packageId: installedPackageId }, clientPrivateKey: deps.keys.client.privateKey });
      if (outcome.ok) installedPackageId = outcome.packageId;
      else failedUpdate = { packageId: hubPackageId, atMs: now() };
      return signal.aborted ? null : outcome;
    } finally {
      updatesInProgress -= 1;
      deps.onUpdateSettled?.();
    }
  };

  const runOnce = async (signal: AbortSignal): Promise<AttemptResult> => {
    writeStatus('connecting', lastError);
    let client: Client;
    try {
      client = await connect(endpoint, deps.keys.client.privateKey);
    } catch (error) {
      if (error instanceof HubConnectionError && error.failure === 'auth') return { kind: 'removed', isConfirmed: false };
      return { kind: 'failed', reason: error instanceof Error ? error.message : 'could not connect' };
    }
    let answer: Awaited<ReturnType<typeof callGate>>;
    // A Mac says where its lid is in the request that makes the link; the hub records it before it binds the link's socket.
    const lidAtConnect = deps.lid === undefined ? null : await deps.lid.look();
    try {
      answer = await callGate(client, 'link', null, formatLinkCommand(deps.lid === undefined || !isLinkLidAccepted ? null : lidAtConnect));
      if (answer === null && deps.lid !== undefined && isLinkLidAccepted) {
        // Refused. A hub that does not know the argument (an older one) refuses it like any other word — but so does a hub that knows it and had a hiccup, or one that refuses the
        // runner altogether (it refuses the plain `link` too). So the plain `link` is asked once; whether the argument is given up is decided from the marker of whatever answers.
        answer = await callGate(client, 'link', null);
      }
      // A marker with an epoch comes from a hub that knows the argument, whatever it did with one request; one without comes from an older hub. Decided from EVERY answer, in both
      // directions: an older hub that is updated while this runner lives is found out by the plain `link` it is still asked, and the next link carries the lid again.
      if (answer !== null && deps.lid !== undefined) isLinkLidAccepted = answer.marker.fields.epoch !== undefined;
    } catch (error) {
      client.end();
      return { kind: 'failed', reason: error instanceof Error ? error.message : 'the link request failed' };
    }
    // A stop that came during the connect or the handshake fired before anything listened for it, and the listener added further down would
    // never hear it: the link would stay up and `run` would never return. So the stop is looked at HERE, right after the awaited answer and
    // before anything else is started on it — a refusal's follow-up request, an update (a download and a blocking install), the link itself.
    // The branches that wait further (the follow-up request, the update) end the attempt, and on the way to the listener nothing waits.
    if (signal.aborted) {
      answer?.channel.destroy();
      client.end();
      return { kind: 'closed', lastedMs: 0 };
    }
    if (answer === null) {
      // The gate refused (no marker). If the hub says it does not know this runner, that is a removal whose key line outlived the registry entry.
      const identity = await requestGateJson(client, 'identity', null, redeemReplySchema).catch(() => null);
      client.end();
      if (identity !== null && !identity.ok) return { kind: 'removed', isConfirmed: true };
      return { kind: 'failed', reason: 'the hub did not start the link' };
    }
    let hubPackageId = answer.marker.fields.package;
    const decide = (): ReturnType<typeof decideUpdate> => decideUpdate({
      hubPackageId,
      installedPackageId,
      activeExecCount: deps.servers.getActiveExecCount(),
      failedPackageId: failedUpdate?.packageId ?? null,
      failedAtMs: failedUpdate?.atMs ?? 0,
      nowMs: now(),
    });
    if (decide() === 'update-now' && hubPackageId !== undefined) {
      answer.channel.destroy();
      client.end();
      const outcome = await tryUpdate(hubPackageId, signal);
      return outcome?.ok === true ? { kind: 'restart' } : { kind: 'failed', reason: outcome === null ? 'stopped' : `update failed: ${outcome.reason}` };
    }
    deps.servers.acceptLinkStream(answer.channel);
    answer.channel.resume();
    writeStatus('linked', null);
    // What the hub says of this link's start; a report names it, so one that is delivered after a newer link has begun is known for what it is.
    const linkEpoch = answer.marker.fields.epoch ?? null;
    // The lid the hub says it recorded from the request that made this link; nothing, when the request could not carry it or the hub could not record it — the first look then tells it.
    const lidTold = answer.marker.fields.lid === lidRecordedMarkerValue ? lidAtConnect : null;
    const linkedAtMs = now();
    return new Promise<AttemptResult>((resolve) => {
      let isDone = false;
      // While an update is being installed the link is deliberately closed: its closing is not the attempt ending, and the attempt
      // ends only with the update's outcome — otherwise the loop would reconnect and run the next attempt beside the install.
      let isUpdating = false;
      let pollTimer: NodeJS.Timeout | null = null;
      let lidTimer: NodeJS.Timeout | null = null;
      const closedResult = (): AttemptResult => ({ kind: 'closed', lastedMs: now() - linkedAtMs });
      const finish = (result: AttemptResult): void => {
        if (isDone) return;
        isDone = true;
        if (pollTimer !== null) clearInterval(pollTimer);
        if (lidTimer !== null) clearInterval(lidTimer);
        onIdleUpdate = null;
        signal.removeEventListener('abort', onAbort);
        client.end();
        resolve(result);
      };
      const onAbort = (): void => finish(closedResult());
      const onLost = (): void => {
        if (!isUpdating) finish(closedResult());
      };
      const startUpdate = (targetId: string): void => {
        isUpdating = true;
        pendingUpdateId = null;
        onIdleUpdate = null;
        if (pollTimer !== null) clearInterval(pollTimer);
        if (lidTimer !== null) clearInterval(lidTimer);
        client.end();
        void tryUpdate(targetId, signal).then((outcome) => finish(outcome?.ok === true ? { kind: 'restart' } : closedResult()));
      };
      const considerUpdate = (): void => {
        const decision = decide();
        if (decision === 'update-now' && hubPackageId !== undefined) {
          startUpdate(hubPackageId);
        } else if (decision === 'wait-until-idle' && hubPackageId !== undefined) {
          pendingUpdateId = hubPackageId;
          onIdleUpdate = (): void => {
            if (pendingUpdateId !== null && decide() === 'update-now') startUpdate(pendingUpdateId);
          };
        }
      };
      const askHubForPackage = async (): Promise<void> => {
        if (isUpdating || isDone) return;
        try {
          const versionAnswer = await callGate(client, 'version', null);
          if (versionAnswer === null) return;
          versionAnswer.channel.resume();
          if (isUpdating || isDone) return;
          hubPackageId = versionAnswer.marker.fields.package;
          considerUpdate();
        } catch (error) {
          log(`could not ask the hub for its package (${error instanceof Error ? error.message : 'unknown'})`);
        }
      };
      const lookAtLid = (): void => {
        if (!isUpdating && !isDone) void deps.lid?.beat((isClosed) => sendLidReport(client, isClosed, linkEpoch));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      client.once('close', onLost);
      client.once('error', onLost);
      answer.channel.once('close', onLost);
      answer.channel.once('error', onLost);
      considerUpdate();
      if (!isUpdating) pollTimer = setInterval(() => { void askHubForPackage(); }, versionPollMs);
      if (!isUpdating && deps.lid !== undefined) {
        deps.lid.startLink(lidTold);
        lookAtLid();
        lidTimer = setInterval(lookAtLid, lidLookMs);
      }
    });
  };

  return {
    notifyActiveCountChange: () => {
      if (deps.servers.getActiveExecCount() === 0) onIdleUpdate?.();
    },
    isUpdating: () => updatesInProgress > 0,
    run: async (signal) => {
      let failures = 0;
      let firstRefusalAtMs: number | null = null;
      while (!signal.aborted) {
        const result = await runOnce(signal);
        if (result.kind === 'restart') return restartExitCode;
        // A stop that came while the attempt was under way (any of its awaits: the connect, the answers, an update) is not an event of the link:
        // whatever the attempt ended with — a refusal read as a removal, a failure, a closed link — is not acted on. No «removed» status, no
        // job stopped on a hub's answer to a runner that was already leaving, no error line.
        if (signal.aborted) return 0;
        if (result.kind === 'removed') {
          const now0 = now();
          firstRefusalAtMs ??= now0;
          if (!result.isConfirmed && now0 - firstRefusalAtMs < confirmMs) {
            writeStatus('error', 'the hub refused the key; asking once more before taking this for a removal');
            await sleep(confirmMs, signal);
            continue;
          }
          writeStatus('removed', `removed by ${deps.config.hub.label}`);
          if (result.isConfirmed || now0 - firstRefusalAtMs >= stopAfterMs) {
            log(`the hub no longer knows this runner: removed by ${deps.config.hub.label}; stopping its jobs, then asking again in an hour`);
            await deps.stopJobs?.().catch((error) => log(`could not stop the jobs (${error instanceof Error ? error.message : 'unknown error'})`));
          } else {
            log(`the hub refuses this runner's key (removed by ${deps.config.hub.label}?); its jobs are left alone unless that lasts ${Math.round(stopAfterMs / 3_600_000)} hours without the hub saying more, asking again in an hour`);
          }
          await sleep(removedRetryMs, signal);
          continue;
        }
        firstRefusalAtMs = null;
        if (result.kind === 'failed') {
          writeStatus('error', result.reason);
          log(`link failed: ${result.reason}`);
          failures += 1;
        } else {
          failures = result.lastedMs >= stableLinkMs ? 0 : failures + 1;
          writeStatus('connecting', null);
        }
        await sleep(computeBackoffMs(Math.max(0, failures - 1), random()), signal);
      }
      return 0;
    },
  };
}
