import * as path from 'path';
import type { RunnerProbe } from '../remoteRun/probe';
import { readLastProbe } from '../remoteRun/runners';
import { getLaunchdFiles } from '../runnerUtility/serviceCommon';
import { getRunnerHomePaths } from '../runnerUtility/runnerHome';
import { getServiceNames } from '../runnerUtility/serviceUnits';
import type { HubContext } from './hubPaths';
import { findPairedRunner } from './hubPairing';
import { readPairedFile, type PairedRunner, type RunnerServiceKind } from './hubRegistry';
import { getCurrentServiceKind } from './runnerServiceKind';

/**
 * @description The commands that remove a runner's ALWAYS-ON service (the two LaunchDaemons the admin line installs on a Mac), built by the HUB from
 * what the hub knows of the machine. Nothing of charness runs as root on a runner machine to do it — an admin runs plain `launchctl` and `rm` — and
 * the commands must not come from the runner account's own program either: the account runs the agents' code and can change what that program prints,
 * so a line it printed could be anything an admin would then run with `sudo`. The hub derives the two labels itself (a short hash of the account's state
 * folder, `serviceUnits.ts`) from the work folder the runner reported when it was paired — which only picks WHICH two labels: a hash in hex and a
 * fixed path, never text the account chose — and shows them where the operator removes a runner (`charness runners remove`, the `/runners` Remove
 * button), in `charness runners service-removal`, and in `docs/remote-run.md`.
 */

/** Where the admin line puts the daemons' definitions. */
export const launchDaemonsDir = '/Library/LaunchDaemons';

/**
 * @description The admin's commands that remove `runner`'s two LaunchDaemons — stop them, then delete their definitions; `null` when the hub cannot say
 * which they are (the runner reported a work folder that is not the state folder's own).
 */
export function getSystemServiceRemovalCommands(runner: PairedRunner): string[] | null {
  const homeDir = path.dirname(path.dirname(runner.workDir));
  const paths = getRunnerHomePaths(homeDir);
  if (paths.workDir !== runner.workDir) return null;
  const names = getServiceNames(paths.root);
  const files = getLaunchdFiles(true, homeDir, names, launchDaemonsDir);
  return [
    `sudo launchctl bootout system/${names.launchdLink}`,
    `sudo launchctl bootout system/${names.launchdPueued}`,
    `sudo rm ${files.link} ${files.pueued}`,
  ];
}

/**
 * @description What to tell the operator who removes `runner` (or asks): the removal commands when it runs as an always-on service now — by its probe,
 * else by the registry's word (`getCurrentServiceKind`) — else `[]`.
 */
export function getServiceRemovalLines(runner: PairedRunner, probe: RunnerProbe | null): string[] {
  return getCurrentServiceKind(runner, probe) === 'system-service' ? (getSystemServiceRemovalCommands(runner) ?? []) : [];
}

/** What an always-on service's removal needs, for one runner: how the machine is kept running now, and the admin's commands (`[]` when there are none to give). */
export interface ServiceRemovalFacts {
  runner: PairedRunner;
  kind: RunnerServiceKind;
  commands: string[];
}

/**
 * @description The ONE reading behind every place that tells an admin how to remove a runner's always-on service (`charness runners remove` and
 * `service-removal`, the Remove button of `/runners`): the registry's runner `nameOrId` and its last report, nothing else — no link probe, no pairing
 * codes, so a slow or damaged part of the hub cannot get in the way of the removal it accompanies. `null` when no runner is paired by that name or id.
 * Read BEFORE the removal, which deletes the runner's last report.
 */
export function readServiceRemovalForRunner(ctx: HubContext, cacheDir: string, nameOrId: string): ServiceRemovalFacts | null {
  const runner = findPairedRunner(readPairedFile(ctx.dir).runners, nameOrId);
  if (runner === undefined) return null;
  const probe = readLastProbe(cacheDir, runner.name, runner.pairedAtMs)?.probe ?? null;
  return { runner, kind: getCurrentServiceKind(runner, probe), commands: getServiceRemovalLines(runner, probe) };
}

/** The way to find the daemons by hand, for the machine the hub cannot name them for. */
const findDaemonsByHandCommand = `ls ${launchDaemonsDir} | grep com.charness.runner`;

/** @description The note `charness runners remove` and `service-removal` print for an always-on service (English, plain text): what it is, who may stop it, the commands, where they come from. */
export function formatServiceRemovalNote(runnerName: string, commands: readonly string[]): string {
  return [
    `"${runnerName}" runs as an always-on service on that machine (two LaunchDaemons), which only an admin there can stop — nothing of charness runs as root. As an admin on that machine, run:`,
    ...commands.map((command) => `  ${command}`),
    'These commands come from this charness host, not from the machine itself.',
    '',
  ].join('\n');
}

/** @description What `charness runners service-removal <name>` says for a runner that runs as an always-on service whose daemons the hub cannot name. */
export function formatServiceRemovalUnknownNote(runnerName: string): string {
  return `"${runnerName}" runs as an always-on service on that machine, but it reported a work folder that is not the state folder's own, so this charness host cannot say which daemons are its. On that machine, as an admin, \`${findDaemonsByHandCommand}\` lists them (a charness runner has two: the link and its queue); remove each with \`sudo launchctl bootout system/<label>\`, then \`sudo rm ${launchDaemonsDir}/<label>.plist\`.\n`;
}
