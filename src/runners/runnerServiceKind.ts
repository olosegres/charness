import type { RunnerProbe } from '../remoteRun/probe';
import type { PairedRunner, RunnerServiceKind } from './hubRegistry';

/**
 * @description How a runner is kept running as it is NOW. What the machine reported in its latest probe comes first (the live one while it is
 * online, the last snapshot for a machine that is off): the registry holds only what the runner said when it was paired — «run by hand», since
 * `service install` comes after — and never learns of an install, an uninstall or a move to a system service. The registry's own word stands
 * where the probe has none (never probed, or a runner too old to report it). The one rule behind `/runners` and `charness runners ls`.
 */
export function getCurrentServiceKind(runner: PairedRunner, probe: RunnerProbe | null): RunnerServiceKind {
  return probe?.serviceKind ?? runner.serviceKind;
}
