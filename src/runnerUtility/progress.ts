/**
 * @description The «what is happening now» lines of the runner utility's long steps (installing the program's dependencies, checking the
 * machine, pairing, installing Pueue and rsync, installing the always-on service). BUILTINS ONLY: the first step of a pairing and the root
 * step of the admin line run from a package that has no `node_modules`.
 *
 * Each step is named in ONE line. On a terminal the line is redrawn while the step runs — the name followed by dots that cycle (`.`, `..`,
 * `...`) — and ends with `— done` or `— failed`; anywhere else (a pipe, a file, a flow) the step is one plain line when it starts. The
 * work of a step must be asynchronous: a blocking call (`spawnSync`) would stop the dots.
 */

/** Where the lines go, and whether a person is watching them. */
export interface StepOutput {
  write: (text: string) => void;
  /** A terminal: the step line is redrawn in place. */
  isTerminal: boolean;
  /** The terminal's width in characters, asked at EVERY redraw (a window can be resized meanwhile); absent when it is not known. */
  getColumns?: () => number | undefined;
}

/**
 * Run `work` as a step called `label`. Resolves with its result; a failure is marked and passed on. `checkIsFailure`: a work that REPORTS its
 * failure in the result it returns instead of throwing (`{ ok: false }`) says so, and the step ends «— failed» — the result is still returned.
 */
export type RunStep = <T>(label: string, work: () => Promise<T>, checkIsFailure?: (result: T) => boolean) => Promise<T>;

/** What every progress line (and every other line of the utility) starts with. */
export const stepLinePrefix = 'charness-runner: ';
const dotFrames: readonly string[] = ['.', '..', '...'];
const defaultDotIntervalMs = 400;
const doneText = ' — done';
const failedText = ' — failed';
/** What may follow the step's name on a drawn line: the dots, or the result that replaces them. */
const reservedForEnding = Math.max(dotFrames.length, doneText.length, failedText.length);
/** Narrower than this, a redrawn line leaves no room for a name: plain lines instead. */
const minRedrawColumns = 40;

/**
 * The names of the long steps. Short on purpose: with the prefix and the longest ending each fits an 80-column terminal (macOS Terminal's
 * default) whole — a line that does not fit would wrap, and a redraw that wraps leaves a new row behind at every move of the dots.
 */
export const stepLabels = {
  installProgram: 'installing the runner program (npm)',
  checkMachine: 'checking this machine',
  pair: 'pairing with the hub',
  getPueue: 'getting Pueue (a checked download)',
  findRsync: 'finding rsync (or building it)',
  installService: (account: string): string => `installing the always-on service for ${account}`,
} as const;

/** @description Is `stream` a terminal a person reads (not a pipe, not a file, not a dumb terminal)? */
export function checkIsTerminal(stream: { isTTY?: boolean }, env: NodeJS.ProcessEnv = process.env): boolean {
  return stream.isTTY === true && env.TERM !== 'dumb';
}

/** The step line cut to fit `columns` with its ending, an ellipsis where it was cut. One column stays free: a line that fills the last column wraps with the next character. */
function fitHead(head: string, columns: number): string {
  const room = columns - 1 - reservedForEnding;
  return head.length <= room ? head : `${head.slice(0, room - 1)}…`;
}

/** @description The step runner for `output`; the dots move every `dotIntervalMs`. */
export function createStepRunner(output: StepOutput, dotIntervalMs: number = defaultDotIntervalMs): RunStep {
  return async (label, work, checkIsFailure) => {
    const head = `${stepLinePrefix}${label}`;
    const columnsAtStart = output.getColumns?.();
    // Not a terminal, or one whose width is not known or too small to redraw in: one plain line when the step starts.
    if (!output.isTerminal || columnsAtStart === undefined || columnsAtStart < minRedrawColumns) {
      output.write(`${head}\n`);
      return work();
    }
    const fitted = (): string => fitHead(head, Math.max(output.getColumns?.() ?? columnsAtStart, minRedrawColumns));
    let frame = 0;
    const draw = (): void => {
      output.write(`\r${fitted()}${dotFrames[frame % dotFrames.length].padEnd(dotFrames.length)}`);
      frame += 1;
    };
    draw();
    const timer = setInterval(draw, dotIntervalMs);
    timer.unref();
    try {
      const result = await work();
      clearInterval(timer);
      output.write(`\r${fitted()}${checkIsFailure?.(result) === true ? failedText : doneText}\n`);
      return result;
    } catch (error) {
      clearInterval(timer);
      output.write(`\r${fitted()}${failedText}\n`);
      throw error;
    }
  };
}
