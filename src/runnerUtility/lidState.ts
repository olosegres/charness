import * as fs from 'fs';
import * as path from 'path';
import { runCommand, type CommandRunner } from '../selfUpdate/commandRunner';

/**
 * @description The lid of a MacBook runner. A Mac whose lid is closed with nothing keeping it awake (no external display: macOS sleeps it about a minute and a half
 * later, and on power wakes it for a minute or two every quarter of an hour to do its housekeeping) cannot run a job to its end — a job that lands in one of those
 * windows is cut when the Mac sleeps again. So the link looks at the lid on a short timer and TELLS THE HUB when what it last told changes; the hub treats such a
 * runner like an offline one for NEW jobs (`runners/linkControl.ts`, `remoteRun/runners.ts`) and never touches a job that already runs.
 *
 * The state is the I/O Registry's own: `ioreg -r -k AppleClamshellState -d 4` prints, for the power-management root,
 *   `"AppleClamshellState" = Yes|No`      the lid is shut (the key is absent on a Mac without a lid)
 *   `"AppleClamshellCausesSleep" = Yes|No`  closing it sleeps the machine (No: an external display keeps it awake — «clamshell mode»)
 * (source: Apple's darwin-dev mailing list on the key, and the Keyboard Maestro forum's use of that exact command; not part of Apple's documented API).
 * Closed means BOTH are Yes. Anything else — a lid that is open, a Mac without one, an external display, a reading that cannot be made — is «open»: this
 * must never take a runner out of use on a guess, and a failed read is told once and never blocks the link.
 *
 * The lid the runner has when it CONNECTS goes in the request that makes the link (`link lid=closed`), so the hub knows it before the link's socket exists: a Mac that wakes
 * in the dark for a minute with its lid shut is never, for even a second, online with the lid of the last time. The looks after that report only a change.
 */

export { lidPollMs } from './lidPollTiming';
const ioregTimeoutMs = 5 * 1000;
const ioregArguments = ['-r', '-k', 'AppleClamshellState', '-d', '4'] as const;
const clamshellStateKey = 'AppleClamshellState';
const clamshellCausesSleepKey = 'AppleClamshellCausesSleep';

const ioregProgramName = 'ioreg';

function checkIsExecutableOnPath(programName: string, pathVariable: string | undefined): boolean {
  return (pathVariable ?? '').split(path.delimiter).some((folder) => {
    // An empty entry of PATH means the current folder, which is nobody's choice of where a runner finds its tools.
    if (folder === '') return false;
    try {
      fs.accessSync(path.join(folder, programName), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * @description Does this runner report a lid? A Mac does — whatever its `PATH` — and so does a runner that has an `ioreg` on its `PATH` (a Mac's own tool, which no other system
 * ships): that is how a flow on another system plays a Mac with a stand-in `ioreg`. Any other runner never reports one.
 */
export function checkCanReadLid(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): boolean {
  return platform === 'darwin' || checkIsExecutableOnPath(ioregProgramName, env.PATH);
}

/** What `ioreg` says of the lid: shut and sleeping the Mac, or anything else (`no-lid`: the key is not there at all). */
export type LidReading = 'closed' | 'open' | 'no-lid';

/** `"Key" = Yes` → `true`, `= No` → `false`, no such line → `null`. */
function readYesNo(output: string, key: string): boolean | null {
  const match = new RegExp(`"${key}"\\s*=\\s*(Yes|No)\\b`, 'i').exec(output);
  return match === null ? null : match[1].toLowerCase() === 'yes';
}

/** @description The lid as the output of `ioreg -r -k AppleClamshellState -d 4` says it. */
export function parseLidReading(output: string): LidReading {
  const isShut = readYesNo(output, clamshellStateKey);
  if (isShut === null) return 'no-lid';
  return isShut && readYesNo(output, clamshellCausesSleepKey) === true ? 'closed' : 'open';
}

/** @description The reader of the real machine: `ioreg`'s output, or `null` when it could not be run or did not end in time. */
export function createIoregReader(runner: CommandRunner = runCommand): () => Promise<string | null> {
  return async () => {
    const result = await runner(ioregProgramName, ioregArguments, { timeoutMs: ioregTimeoutMs });
    return result.ok ? result.stdout : null;
  };
}

/** What the hub did with a report: took it; answered and refused it (an older gate that does not know the word, a body it will not take) — a retry now would be refused the same; or could not be reached. */
export type LidReportResult = 'taken' | 'refused' | 'failed';

/** After a refusal the same report is not sent again for this long, doubling with every further refusal up to {@link lidRefusalMaxBackoffMs}. */
export const lidRefusalFirstBackoffMs = 30 * 1000;
/** As long as the hub's own question about its package: five minutes. */
export const lidRefusalMaxBackoffMs = 5 * 60 * 1000;

export interface LidWatcherDeps {
  /** The registry's output (`null`: it could not be read). */
  readRegistry: () => Promise<string | null>;
  log: (line: string) => void;
  now?: () => number;
}

export interface LidWatcher {
  /** The lid right now — the one look; a failure to read it is an open lid, said once per run of failures. Never throws. */
  look: () => Promise<boolean>;
  /** A link began and told the hub `toldIsClosed` in its own request (`null`: the request could not carry it): the looks of THIS link report only a change from it. Whatever an earlier link had under way no longer counts. */
  startLink: (toldIsClosed: boolean | null) => void;
  /** One look at the lid for the link in force; `report` tells the hub and is called only when the hub was last told something else (and is not being given time after a refusal). Never throws. */
  beat: (report: (isClosed: boolean) => Promise<LidReportResult>) => Promise<void>;
}

/**
 * @description The watcher: reads the lid, compares it with what the hub was last told, tells the hub on a change. A report the hub could not be reached with is made again at the
 * next look; one it REFUSED is made again after a growing wait (30 s, doubling to 5 min) — a hub that does not know the word must not get an ssh exec and a process at every look —
 * until the hub takes one or a new link begins. A failure is said once per run of failures. A look or a report that belongs to a link that has ended since it began (`startLink`
 * came in between) changes nothing: the new link's own first look is never held back by the old one's report still on its way.
 */
export function createLidWatcher(deps: LidWatcherDeps): LidWatcher {
  const now = deps.now ?? Date.now;
  let generation = 0;
  let lastTold: boolean | null = null;
  let beatingGeneration: number | null = null;
  let isReadFailing = false;
  let isReportFailing = false;
  let refusals = 0;
  let retryAfterMs = 0;

  const look = async (): Promise<boolean> => {
    let output: string | null;
    try {
      output = await deps.readRegistry();
    } catch {
      output = null;
    }
    if (output === null && !isReadFailing) deps.log('the lid state cannot be read (ioreg did not answer): the lid is taken as open, and the runner takes jobs as usual');
    isReadFailing = output === null;
    return output !== null && parseLidReading(output) === 'closed';
  };

  const noteRefusal = (): void => {
    refusals += 1;
    const waitMs = Math.min(lidRefusalMaxBackoffMs, lidRefusalFirstBackoffMs * 2 ** (refusals - 1));
    retryAfterMs = now() + waitMs;
    if (!isReportFailing) deps.log(`the hub did not take the report of the lid (it refused it): trying again in ${Math.round(waitMs / 1000)} s, and at longer waits while it does`);
    isReportFailing = true;
  };

  return {
    look,
    startLink: (toldIsClosed) => {
      generation += 1;
      lastTold = toldIsClosed;
      isReportFailing = false;
      refusals = 0;
      retryAfterMs = 0;
    },
    beat: async (report) => {
      const own = generation;
      if (beatingGeneration === own) return;
      beatingGeneration = own;
      try {
        const isClosed = await look();
        if (own !== generation || isClosed === lastTold || now() < retryAfterMs) return;
        let result: LidReportResult;
        try {
          result = await report(isClosed);
        } catch {
          result = 'failed';
        }
        if (own !== generation) return;
        if (result === 'taken') {
          lastTold = isClosed;
          isReportFailing = false;
          refusals = 0;
          retryAfterMs = 0;
        } else if (result === 'refused') {
          noteRefusal();
        } else if (!isReportFailing) {
          isReportFailing = true;
          deps.log('the hub could not be reached with the report of the lid; trying again at the next look');
        }
      } finally {
        if (beatingGeneration === own) beatingGeneration = null;
      }
    },
  };
}
