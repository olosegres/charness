import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { JobFacts } from './jobState';
import { sayOwn, type CliIo } from './output';
import { readProjectConfig } from './project';
import { RemoteRunError } from './remoteRunError';
import { runRsync } from './rsync';
import type { RunnerClient } from './runnerClient';
import { copyFetchedFiles } from './safeCopy';
import { buildRsyncFetchArgs } from './sendPlan';
import type { LocalJobRecord } from './jobRecords';

/**
 * @description Bring a finished job's result files back. The job kept them on the runner under `jobs/<job>/artifacts/` (only what it
 * created or changed and `pull:` names); they are rsynced without symlinks into a temp folder and copied into the project by
 * `safeCopy.ts`. The project is the one the job was submitted from, as the MAIN BOX recorded it (`jobRecords.ts`) — never what the
 * runner says — and the `pull:` patterns are those of that project's LOCAL `.remote-run`.
 */

export interface FetchTarget {
  root: string;
  /** The project's folder name on the runner, from the local record. */
  slug: string;
  patterns: string[];
}

/** @description The local project a job's files go back to, from the local record; an error says why there is none. */
export function resolveFetchTarget(record: LocalJobRecord | null): FetchTarget {
  if (record === null) throw new RemoteRunError('this machine did not submit the job as this user (or its record is gone) — its files are not fetched');
  if (!fs.existsSync(record.projectRoot) || !fs.statSync(record.projectRoot).isDirectory()) throw new RemoteRunError(`the job's project folder is gone from this machine: ${record.projectRoot}`);
  return { root: record.projectRoot, slug: record.slug, patterns: readProjectConfig(record.projectRoot).pull };
}

/** @description Fetch `jobId`'s result files into `target`; says how many came back. A job with none, or a project that names none, is not an error. */
export async function fetchJobFiles(params: { client: RunnerClient; facts: JobFacts; jobId: string; target: FetchTarget; io: Pick<CliIo, 'stderr'> }): Promise<void> {
  const { client, facts, target } = params;
  if (!facts.isWithArtifacts || target.patterns.length === 0) return;
  const workDir = await client.getAbsoluteWorkDir();
  const fetchedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-run-files-'));
  try {
    const fetched = await runRsync(buildRsyncFetchArgs({
      sshCommand: client.rsyncSshCommand,
      source: `${client.runner.ssh}:${workDir}/p/${target.slug}/jobs/${params.jobId}/artifacts`,
      destinationDirectory: fetchedRoot,
    }));
    if (!fetched.isOk) throw new RemoteRunError(`fetching the result files from "${client.runner.name}" failed — ${fetched.errorTail}`);
    const copied = copyFetchedFiles({ fetchedRoot, projectRoot: target.root, patterns: target.patterns });
    if (copied.copied.length > 0 || copied.refusedCount > 0) {
      sayOwn(params.io, `${copied.copied.length} result file${copied.copied.length === 1 ? '' : 's'} came back${copied.refusedCount > 0 ? `, ${copied.refusedCount} refused (not a regular file a "pull:" pattern names, or inside a .git, or the project's .remote-run)` : ''}`);
    }
  } finally {
    fs.rmSync(fetchedRoot, { recursive: true, force: true });
  }
}
