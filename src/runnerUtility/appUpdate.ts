import * as fs from 'fs';
import * as path from 'path';
import { noPackageMarker } from '../runners/gateProtocol';
import { callGate, connectToHub, type HubEndpoint } from './hubClient';
import { getPackageIdOfArchive } from './packageId';
import { installAppFromArchive, removeOldApps, switchCurrentApp } from './appInstall';
import { writeRunnerConfig, type RunnerConfig } from './runnerConfig';
import type { RunnerHomePaths } from './runnerHome';

/**
 * @description Updating the runner to the hub's current package: the hub's `link` answer names the package id; when it is not the one
 * installed, an IDLE runner fetches the package with the `package` request (a connection of its own), checks that the archive hashes to
 * the id the hub announced, installs it next to the running copy, points `current` at it and records the id. The caller then exits with
 * the restart code and the launcher starts the new copy. Nothing is changed in the running copy.
 */

export type UpdateOutcome = { ok: true; packageId: string } | { ok: false; reason: string };

export interface UpdateParams {
  paths: RunnerHomePaths;
  config: RunnerConfig;
  clientPrivateKey: string;
  connect?: typeof connectToHub;
}

/** @description Fetch, verify and install the hub's package; on success `current` and `config.json` point at it. */
export async function updateFromHub(params: UpdateParams): Promise<UpdateOutcome> {
  const endpoint: HubEndpoint = { host: params.config.hub.host, port: params.config.hub.port, user: params.config.hub.user, hostKey: params.config.hub.hostKey };
  const archivePath = path.join(params.paths.root, `package.${process.pid}.tgz`);
  try {
    const client = await (params.connect ?? connectToHub)(endpoint, params.clientPrivateKey);
    try {
      const answer = await callGate(client, 'package', null);
      const expectedId = answer?.marker.fields.id;
      if (answer === null || expectedId === undefined) return { ok: false, reason: 'the hub did not send the package' };
      const chunks: Buffer[] = [];
      for await (const chunk of answer.channel) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const archive = Buffer.concat(chunks);
      if (getPackageIdOfArchive(archive) !== expectedId) return { ok: false, reason: 'the package the hub sent does not match the id it announced' };
      fs.writeFileSync(archivePath, archive, { mode: 0o600 });
      const appDir = await installAppFromArchive(archivePath, params.paths);
      switchCurrentApp(params.paths, appDir);
      writeRunnerConfig(params.paths, { ...params.config, packageId: expectedId });
      removeOldApps(params.paths);
      return { ok: true, packageId: expectedId };
    } finally {
      client.end();
    }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'the update failed' };
  } finally {
    fs.rmSync(archivePath, { force: true });
  }
}

export interface UpdateDecisionInputs {
  /** What the hub named in the `link` answer (`none`: it could not pack one). */
  hubPackageId: string | undefined;
  installedPackageId: string | null;
  activeExecCount: number;
  /** The id of an update that already failed, and when — it is not tried again for {@link updateRetryDelayMs}. */
  failedPackageId: string | null;
  failedAtMs: number;
  nowMs: number;
}

export const updateRetryDelayMs = 10 * 60 * 1000;

export type UpdateDecision = 'none' | 'wait-until-idle' | 'update-now';

/** @description Update only to a package the hub named and the runner does not have; only while no command runs; not again right after a failure. */
export function decideUpdate(inputs: UpdateDecisionInputs): UpdateDecision {
  if (inputs.hubPackageId === undefined || inputs.hubPackageId === noPackageMarker || inputs.hubPackageId === inputs.installedPackageId) return 'none';
  if (inputs.failedPackageId === inputs.hubPackageId && inputs.nowMs - inputs.failedAtMs < updateRetryDelayMs) return 'none';
  return inputs.activeExecCount === 0 ? 'update-now' : 'wait-until-idle';
}
