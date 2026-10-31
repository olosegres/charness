import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RemoteRunError } from './remoteRunError';
import { getProjectSlug } from './jobId';
import { parseProjectConfig, projectConfigName, type ProjectConfig, createEmptyProjectConfig } from './projectConfig';
import { planSendList, type SendPlan } from './sendPlan';

/**
 * @description The local side of a submit: which project the command is run in, what `.remote-run` says, and which files git says
 * are sendable. The project is the git working tree the command runs in; the command later runs in the same subfolder on the runner.
 */

const gitDeadlineMs = 60 * 1000;
const gitOutputLimitBytes = 512 * 1024 * 1024;
/** A gitlink (submodule) entry's mode in `git ls-files -s`. */
const gitlinkMode = '160000';

function runGit(directory: string, args: readonly string[]): string {
  const result = spawnSync('git', ['-C', directory, ...args], { encoding: 'utf8', timeout: gitDeadlineMs, maxBuffer: gitOutputLimitBytes });
  if (result.error !== undefined || result.status !== 0) {
    throw new RemoteRunError(`git ${args[0]} failed in ${directory}: ${(result.stderr ?? '').trim().split('\n')[0] || result.error?.message || 'no output'}`);
  }
  return result.stdout;
}

export interface ProjectContext {
  /** The git working tree's root, absolute and real. */
  root: string;
  /** The folder the command runs in, relative to the root (`''` for the root itself), with `/` separators. */
  subfolder: string;
  config: ProjectConfig;
  slug: string;
}

/** @description The project of `cwd`: refused with a clear message when `cwd` is not inside a git working tree. */
export function getProjectContext(cwd: string): ProjectContext {
  const probe = spawnSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: gitDeadlineMs });
  if (probe.error !== undefined || probe.status !== 0) {
    throw new RemoteRunError(`${cwd} is not inside a git working tree — remote-run sends the project's files as git lists them (tracked and untracked, not ignored), so it needs a git project`);
  }
  const root = fs.realpathSync(probe.stdout.trim());
  const relative = path.relative(root, fs.realpathSync(cwd));
  const subfolder = relative === '' ? '' : relative.split(path.sep).join('/');
  return { root, subfolder, config: readProjectConfig(root), slug: getProjectSlug(root, { hostname: os.hostname(), uid: os.userInfo().uid }) };
}

/** @description `.remote-run` of the project, or the empty config when there is none; a bad file is an error naming its lines. */
export function readProjectConfig(root: string): ProjectConfig {
  const configPath = path.join(root, projectConfigName);
  let text: string;
  try {
    text = fs.readFileSync(configPath, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return createEmptyProjectConfig();
    throw new RemoteRunError(`${projectConfigName} could not be read`);
  }
  const parsed = parseProjectConfig(text);
  if (!parsed.ok) throw new RemoteRunError(parsed.errors.join('\n'));
  return parsed.config;
}

interface GitFileLists {
  files: string[];
  gitlinks: string[];
}

function splitNul(output: string): string[] {
  return output.split('\0').filter((entry) => entry !== '');
}

function listGitDirectory(directory: string): GitFileLists {
  const files = splitNul(runGit(directory, ['ls-files', '-co', '--exclude-standard', '-z', '--deduplicate']));
  const staged = splitNul(runGit(directory, ['ls-files', '-s', '-z']));
  const gitlinks = staged.filter((entry) => entry.startsWith(`${gitlinkMode} `)).map((entry) => entry.slice(entry.indexOf('\t') + 1));
  return { files, gitlinks };
}

/** Every sendable path of `directory` and of its checked-out submodules (recursively), relative to `directory`, prefixed with `prefix`. */
function listFilesRecursively(directory: string, prefix: string): string[] {
  const { files, gitlinks } = listGitDirectory(directory);
  const result = files.filter((file) => !gitlinks.includes(file)).map((file) => `${prefix}${file}`);
  for (const gitlink of gitlinks) {
    const submodule = path.join(directory, gitlink);
    if (fs.existsSync(path.join(submodule, '.git'))) result.push(...listFilesRecursively(submodule, `${prefix}${gitlink}/`));
  }
  return result;
}

/** A file git lists but that is gone from the disk (deleted, not yet staged) or is not a file or a link is not sent: the runner's copy loses it. */
function checkIsSendable(root: string, relativePath: string): boolean {
  try {
    const stat = fs.lstatSync(path.join(root, relativePath));
    return stat.isFile() || stat.isSymbolicLink();
  } catch {
    return false;
  }
}

/** Ignored files that exist, consulted only for what `send:` opts in; a collapsed ignored DIRECTORY (`node_modules/`) is never one of them. */
function listIgnoredFiles(root: string): string[] {
  return splitNul(runGit(root, ['ls-files', '-o', '-i', '--exclude-standard', '--directory', '-z'])).filter((entry) => !entry.endsWith('/'));
}

/** @description What goes to the runner for this project: git's lists, trimmed and opted in by `.remote-run` (`planSendList`). */
export function planProjectSend(project: ProjectContext): SendPlan {
  const files = listFilesRecursively(project.root, '').filter((file) => checkIsSendable(project.root, file));
  const ignoredFiles = project.config.send.length === 0 ? [] : listIgnoredFiles(project.root).filter((file) => checkIsSendable(project.root, file));
  return planSendList({ files, ignoredFiles, exclude: project.config.exclude, send: project.config.send });
}
