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
 */

/** How often the link looks at the lid: as often as the hub's gate takes its own heartbeat. */
export const lidPollMs = 10 * 1000;
const ioregTimeoutMs = 5 * 1000;
const ioregArguments = ['-r', '-k', 'AppleClamshellState', '-d', '4'] as const;
const clamshellStateKey = 'AppleClamshellState';
const clamshellCausesSleepKey = 'AppleClamshellCausesSleep';

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
    const result = await runner('ioreg', ioregArguments, { timeoutMs: ioregTimeoutMs });
    return result.ok ? result.stdout : null;
  };
}

export interface LidWatcherDeps {
  /** The registry's output (`null`: it could not be read). */
  readRegistry: () => Promise<string | null>;
  log: (line: string) => void;
}

export interface LidWatcher {
  /** One look at the lid; `report` tells the hub (`true`: it took the report) and is called only when the hub was last told something else. Never throws. */
  beat: (report: (isClosed: boolean) => Promise<boolean>) => Promise<void>;
  /** A new link starts from «the hub was told nothing»: the first look of it reports, whatever the last link said. */
  reset: () => void;
}

/** @description The watcher: reads the lid, tells the hub on a change, keeps trying while the hub has not taken it, and says a failure once per run of failures. */
export function createLidWatcher(deps: LidWatcherDeps): LidWatcher {
  let lastTold: boolean | null = null;
  let isBeating = false;
  let isReadFailing = false;
  let isReportFailing = false;
  return {
    reset: () => {
      lastTold = null;
      isReportFailing = false;
    },
    beat: async (report) => {
      if (isBeating) return;
      isBeating = true;
      try {
        let output: string | null = null;
        try {
          output = await deps.readRegistry();
        } catch {
          output = null;
        }
        if (output === null && !isReadFailing) deps.log('the lid state cannot be read (ioreg did not answer): the lid is taken as open, and the runner takes jobs as usual');
        isReadFailing = output === null;
        const isClosed = output !== null && parseLidReading(output) === 'closed';
        if (isClosed === lastTold) return;
        let isTold = false;
        try {
          isTold = await report(isClosed);
        } catch {
          isTold = false;
        }
        if (isTold) {
          lastTold = isClosed;
          isReportFailing = false;
        } else if (!isReportFailing) {
          isReportFailing = true;
          deps.log('the hub did not take the report of the lid; trying again at the next look');
        }
      } finally {
        isBeating = false;
      }
    },
  };
}
