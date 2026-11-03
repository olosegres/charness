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
}

/** Run `work` as a step called `label`. Resolves with its result; a failure is marked and passed on. */
export type RunStep = <T>(label: string, work: () => Promise<T>) => Promise<T>;

/** What every progress line (and every other line of the utility) starts with. */
export const stepLinePrefix = 'charness-runner: ';
const dotFrames: readonly string[] = ['.', '..', '...'];
const defaultDotIntervalMs = 400;

/** @description Is `stream` a terminal a person reads (not a pipe, not a file, not a dumb terminal)? */
export function checkIsTerminal(stream: { isTTY?: boolean }, env: NodeJS.ProcessEnv = process.env): boolean {
  return stream.isTTY === true && env.TERM !== 'dumb';
}

/** @description The step runner for `output`; the dots move every `dotIntervalMs`. */
export function createStepRunner(output: StepOutput, dotIntervalMs: number = defaultDotIntervalMs): RunStep {
  return async (label, work) => {
    const head = `${stepLinePrefix}${label}`;
    if (!output.isTerminal) {
      output.write(`${head}\n`);
      return work();
    }
    let frame = 0;
    const draw = (): void => {
      output.write(`\r${head}${dotFrames[frame % dotFrames.length].padEnd(dotFrames.length)}`);
      frame += 1;
    };
    draw();
    const timer = setInterval(draw, dotIntervalMs);
    timer.unref();
    try {
      const result = await work();
      clearInterval(timer);
      output.write(`\r${head} — done\n`);
      return result;
    } catch (error) {
      clearInterval(timer);
      output.write(`\r${head} — failed\n`);
      throw error;
    }
  };
}
