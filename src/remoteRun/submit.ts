import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { RemoteRunOptions } from './cliArgs';
import { defaultTimeoutSeconds } from './cliArgs';
import { computeDepsKey, hashContent, planDepsStep } from './depsPlan';
import { createJobId, getProjectKey } from './jobId';
import type { JobMeta } from './jobMeta';
import { writeLocalJobRecord } from './jobRecords';
import { recordHeldBackFiles } from './heldBackNotice';
import { compilePathPatterns, createPathMatcher, getPathPatternSearchRoots } from './pathPatterns';
import { planProjectSend, readProjectRootCommit, type ProjectContext } from './project';
import { RemoteRunError } from './remoteRunError';
import { describePrepareTimeout, diskTooLowRunnerExitCode, formatPrunedCopyLine, formatPruneHeadsUp, formatRemovalStopLine, parsePrunedCopies, parseRemovalStop } from './pruneReport';
import { runRsync } from './rsync';
import { readLastProbe } from './runners';
import { describeCallFailure, describeRunnerRefusal, prepareCallTimeoutMs, type RunnerClient } from './runnerClient';
import { defaultPueueGroup, formatGroupLimits } from './runnersConfig';
import { buildRsyncGitArgs, buildRsyncMetaArgs, buildRsyncSendArgs, formatHeldBackNotice, formatManifest, formatNulSeparatedList, formatSentOnRequestNotice } from './sendPlan';

/**
 * @description Stage a job on a runner: send the project's files into `stage/<job>/` (only what changed crosses the network — unchanged
 * files are copied from the runner's own copy), write the job's small files next to it, and leave it there. The job itself is added to
 * Pueue by the caller (`lease` for a foreground run, `submit` for `--bg`); applying the files to the runner's copy is the JOB's step, so
 * two runs of one project queue and each runs the tree as it was when IT was staged.
 */

export interface StagedJob {
  jobId: string;
  slug: string;
  group: string;
  timeoutSeconds: number;
  /** The runner's work dir, absolute. */
  workDir: string;
}

const unreadableKeyFileHash = 'unreadable';

export function getJobOwner(): string {
  return `${os.hostname()}:${os.userInfo().uid}`;
}

/** The content hash of a dependency key file; one that cannot be read (a dangling symlink) counts as that, so it changes the key instead of failing the submit. */
function hashKeyFile(filePath: string): string {
  try {
    return hashContent(fs.readFileSync(filePath));
  } catch {
    return unreadableKeyFileHash;
  }
}

function writeJobFiles(directory: string, files: Readonly<Record<string, string>>): void {
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(directory, name), content);
}

/** @description Stage the project for `command` on `client`'s runner; progress lines go through `say` (stderr). */
export async function stageJob(params: {
  client: RunnerClient;
  project: ProjectContext;
  command: string;
  options: RemoteRunOptions;
  /** An empty folder the job's small files are written to before they are sent; the CALLER removes it (also when an interrupt ends the run). */
  metaDirectory: string;
  say: (line: string) => void;
}): Promise<StagedJob> {
  const { client, project, options } = params;
  const runner = client.runner;
  // First of all: it is a fact about this folder alone, and found out late it would be found out after the whole project was sent.
  if (options.isWithGit && !fs.statSync(path.join(project.root, '.git')).isDirectory()) {
    throw new RemoteRunError('--with-git needs the project\'s .git to be a directory (a worktree or submodule checkout keeps it elsewhere)');
  }
  const group = options.group ?? defaultPueueGroup;
  if (group !== defaultPueueGroup && runner.groups?.[group] === undefined) {
    throw new RemoteRunError(`runner "${runner.name}" has no Pueue group "${group}" (its groups in runners.json: ${Object.keys(runner.groups ?? {}).join(', ') || 'none besides default'})`);
  }
  const plan = planProjectSend(project, options.send);
  if (plan.refused.length > 0) {
    throw new RemoteRunError(`file names with a newline cannot be sent: ${plan.refused.map((file) => JSON.stringify(file)).join(', ')} — rename them or list them under "exclude:" in .remote-run`);
  }
  for (const pattern of options.send) {
    if (![...plan.files, ...plan.heldBack].some(createPathMatcher([pattern]))) {
      params.say(`--send ${pattern} matched no file that can be sent (patterns are relative to the project root, as in "send:" of .remote-run; "exclude:" wins)`);
    }
  }
  if (plan.sentOnRequest.length > 0) params.say(formatSentOnRequestNotice(plan.sentOnRequest));
  const isHeldBackNews = recordHeldBackFiles(client.cacheDir, project.slug, [...plan.heldBack, ...plan.sentOnRequest]);
  if (plan.heldBack.length > 0 && isHeldBackNews) params.say(formatHeldBackNotice(plan.heldBack));
  const deps = planDepsStep(plan.files, project.config);
  const depsKey = deps === null
    ? null
    : computeDepsKey(deps.command, deps.keyFiles.map((file) => ({ path: file, contentHash: hashKeyFile(path.join(project.root, file)) })));

  // Which copies on the runner are of this repository (a worktree or another checkout has another folder name, so the slug cannot say): none without a root commit.
  const rootCommit = await readProjectRootCommit(project.root);
  const projectKey = rootCommit === null ? null : getProjectKey(getJobOwner(), rootCommit);

  const jobId = createJobId(runner.name);
  const timeoutSeconds = options.timeoutSeconds ?? defaultTimeoutSeconds;
  const meta: JobMeta = {
    id: jobId,
    runner: runner.name,
    slug: project.slug,
    projectRoot: project.root,
    subfolder: project.subfolder,
    command: params.command,
    submittedAtMs: Date.now(),
    timeoutSeconds,
    owner: getJobOwner(),
    group,
    isBackground: options.isBackground,
  };

  const { metaDirectory } = params;
  // The main box's own note of where this job came from: `wait` / `fetch` bring the files back there and nowhere else.
  writeLocalJobRecord(client.cacheDir, jobId, { projectRoot: project.root, slug: project.slug, submittedAtMs: meta.submittedAtMs, timeoutSeconds });
  writeJobFiles(metaDirectory, {
    manifest: formatManifest(plan.files),
    cmd: params.command,
    subfolder: project.subfolder,
    'timeout-sec': `${timeoutSeconds}`,
    env: options.env.map((entry) => `${entry.name}=${entry.value}\n`).join(''),
    'pull.ere': compilePathPatterns(project.config.pull).map((expression) => `${expression}\n`).join(''),
    'pull.roots': getPathPatternSearchRoots(project.config.pull).map((root) => `${root}\n`).join(''),
    // What the runner removes from its copy after this job, if it succeeds (`clean-after-success:` of .remote-run): the same two files as `pull:`, patterns and the folders to walk.
    'clean-after-success.ere': compilePathPatterns(project.config.cleanAfterSuccess).map((expression) => `${expression}\n`).join(''),
    'clean-after-success.roots': getPathPatternSearchRoots(project.config.cleanAfterSuccess).map((root) => `${root}\n`).join(''),
    'meta.json': `${JSON.stringify(meta)}\n`,
    ...(deps === null || depsKey === null ? {} : { 'install-command': deps.command, 'install-key': depsKey }),
    // The copy this job applies to remembers it (`p/<slug>/project-key`): a NEW copy is seeded from a copy of the same repository only.
    ...(projectKey === null ? {} : { 'project-key': projectKey }),
    // An always-on Mac runs such a job in the account's login session, or refuses it with the reason (`runner.sh`, «the login session»).
    ...(options.needs === 'ios' ? { 'needs-ios': '' } : {}),
  });

  // The runner prunes before it accepts the job, which can take minutes (a project copy is tens of GB) and says nothing until it is done: when its probe of a moment ago found the disk short, say what is
  // about to happen; what it removed is said afterwards, also when it then refuses the job.
  const headsUp = formatPruneHeadsUp(runner.name, readLastProbe(client.cacheDir, runner.name, runner.paired?.pairedAtMs)?.probe ?? null);
  if (headsUp !== null) params.say(headsUp);
  // The repository and the install key go to `prepare` too: its prune must not remove the copy this job's first run would be seeded from (`runner.sh`, «seeding a new copy»).
  const preparing = await client.call('prepare', [project.slug, jobId, formatGroupLimits(runner.groups), projectKey ?? '', depsKey ?? ''], { timeoutMs: prepareCallTimeoutMs });
  for (const removed of parsePrunedCopies(preparing.stdout)) params.say(formatPrunedCopyLine(runner.name, removed));
  const removalStop = parseRemovalStop(preparing.stdout);
  if (removalStop !== null) params.say(formatRemovalStopLine(runner.name, removalStop));
  if (preparing.isTimedOut) throw new RemoteRunError(describePrepareTimeout(runner.name, prepareCallTimeoutMs));
  if (preparing.exitCode === diskTooLowRunnerExitCode) throw new RemoteRunError(`runner "${runner.name}": ${describeRunnerRefusal(preparing.stderr, 'its disk is too full for a new job')}`);
  if (preparing.exitCode !== 0) throw describeCallFailure(runner.name, 'prepare', preparing);
  const workDirLine = preparing.stdout.split('\n').find((line) => line.startsWith('work='));
  if (workDirLine === undefined) throw new RemoteRunError(`runner "${runner.name}": prepare did not report its work dir`);
  const workDir = workDirLine.slice('work='.length);

  const projectDirectory = `${workDir}/p/${project.slug}`;
  const destination = `${runner.ssh}:${projectDirectory}/stage/${jobId}/`;
  const copyDestination = `${projectDirectory}/tree`;
  params.say(`sending ${plan.files.length} files to ${runner.name}`);
  const sent = await runRsync(
    buildRsyncSendArgs({ sshCommand: client.rsyncSshCommand, sourceRoot: project.root, destination, copyDestination }),
    { input: formatNulSeparatedList(plan.files) },
  );
  if (!sent.isOk) throw new RemoteRunError(`sending the files to "${runner.name}" failed — ${sent.errorTail}`);
  if (options.isWithGit) {
    const sentGit = await runRsync(buildRsyncGitArgs({ sshCommand: client.rsyncSshCommand, sourceRoot: project.root, destination, copyDestination: `${copyDestination}/.git/` }));
    if (!sentGit.isOk) throw new RemoteRunError(`sending .git to "${runner.name}" failed — ${sentGit.errorTail}`);
  }
  const sentMeta = await runRsync(buildRsyncMetaArgs({ sshCommand: client.rsyncSshCommand, sourceDirectory: metaDirectory, destination: `${runner.ssh}:${projectDirectory}/jobs/${jobId}/` }));
  if (!sentMeta.isOk) throw new RemoteRunError(`sending the job description to "${runner.name}" failed — ${sentMeta.errorTail}`);
  return { jobId, slug: project.slug, group, timeoutSeconds, workDir };
}
