import * as os from 'os';
import type { ConfigFileLoad } from '../configDirFile';
import { loadPairedRunners } from './pairedRunners';
import { loadRunnersConfig, type RunnerConfig, type RunnersConfig } from './runnersConfig';

/**
 * @description Every runner `remote-run` may use: the hand-made ones of `runners.json` (plain ssh, phase 1) and the paired ones of the
 * hub's registry (`pairedRunners.ts`), as one list with the hand-made first — the order `pickRunner` walks. A name in both is an error
 * that names it (a runner is addressed by name, in job ids too); pairing itself avoids the clash by renaming a newcomer (`-2`), so it can
 * only come from a hand edit made afterwards. This is the only place that knows both sources; it is kept apart from `runnersConfig.ts`
 * because the hub registry's schemas import that file.
 *
 * Both loads are stamp-cached, so the bot MCP can read the runners (`runnerSummary.ts`) on every connect for the cost of two `stat` calls.
 */

/** @description The runners of the user whose home is `homeDir`. `missing` = neither a `runners.json` nor a paired runner; `invalid` carries every problem and, when there is one, the last good (or best-effort) list. */
export function loadRunnersCatalog(homeDir: string = os.homedir()): ConfigFileLoad<RunnersConfig> {
  const handMade = loadRunnersConfig(homeDir);
  const paired = loadPairedRunners(homeDir);
  const handMadeRunners: RunnerConfig[] = handMade.config?.runners ?? [];
  const pairedRunners: RunnerConfig[] = paired.config?.runners ?? [];
  const handMadeNames = new Set(handMadeRunners.map((runner) => runner.name));
  const clashes = pairedRunners.filter((runner) => handMadeNames.has(runner.name));
  const errors = [
    ...(handMade.status === 'invalid' ? handMade.errors : []),
    ...(paired.status === 'invalid' ? paired.errors : []),
    ...clashes.map((runner) => `runner "${runner.name}" is in runners.json and also paired — rename the runners.json entry (or remove the pairing)`),
  ];
  const clashingNames = new Set(clashes.map((runner) => runner.name));
  const config: RunnersConfig = { runners: [...handMadeRunners, ...pairedRunners.filter((runner) => !clashingNames.has(runner.name))] };
  if (errors.length > 0) return { status: 'invalid', config: config.runners.length > 0 ? config : null, errors };
  return { status: handMade.status === 'missing' && paired.status === 'missing' ? 'missing' : 'ok', config };
}
