import * as path from 'path';
import { createPathMatcher } from './pathPatterns';

/**
 * @description What goes to the runner and how: the file list (git decides, `.remote-run` trims and opts in), the files held back
 * because they look like secrets, and the rsync argument lists. Pure — the git calls and the process spawns are elsewhere.
 *
 * Sent: tracked and untracked-not-ignored files, submodules included. Never sent: what `.gitignore` names (the runner keeps its own
 * `node_modules`, `build`, caches), `.git` unless `--with-git`, `exclude:` paths, and secret-looking files unless `send:` names them —
 * or `--send` does, for the one call.
 */

/**
 * rsync decides a file is unchanged when its size and mtime match, and by default the mtime is compared in WHOLE SECONDS: an edit of the
 * same length within the second of the previous version would be skipped, and the runner would keep the old file. A negative modify
 * window compares the nanoseconds too (rsync 3.1.3 or newer on both ends; older ones fall back to seconds).
 */
export const rsyncNanosecondWindowArg = '--modify-window=-1';

/** A secret-looking file that is only a template of one (`.env.example`) is sent: it holds no secret. */
const templateEnvSuffixes: readonly string[] = ['.example', '.sample', '.template'];
const secretFileExtensions: readonly string[] = ['.pem', '.p12', '.key'];

/** @description Does the NAME of `relativePath` look like a secret (`.env`, `.env.*` but not its templates, `*.pem`, `*.p12`, `*.key`, `.npmrc`)? */
export function checkIsSecretLookingFile(relativePath: string): boolean {
  const name = path.posix.basename(relativePath);
  if (name === '.npmrc' || name === '.env') return true;
  if (name.startsWith('.env.')) return !templateEnvSuffixes.some((suffix) => name.endsWith(suffix));
  return secretFileExtensions.some((extension) => name.endsWith(extension) && name.length > extension.length);
}

export interface SendListInput {
  /** What git lists as sendable: tracked + untracked-not-ignored, submodule files included, relative to the project root, all of them present on disk. */
  files: readonly string[];
  /** Ignored files that exist (git's `-o -i`), consulted ONLY for what `send:` names. */
  ignoredFiles: readonly string[];
  exclude: readonly string[];
  /** `send:` of `.remote-run`: opted in for every call. */
  send: readonly string[];
  /** `--send` of THIS call: opted in for it alone (the same patterns, the same reach — also a file git ignores). */
  callSend?: readonly string[];
}

export interface SendPlan {
  /** What is sent, sorted. */
  files: string[];
  /** Secret-looking files NOT sent (the caller says which and how to opt in). */
  heldBack: string[];
  /** Secret-looking files sent only because THIS call's `--send` named them (`send:` did not): the next call without it holds them back again. */
  sentOnRequest: string[];
  /** Names with a newline that `exclude:` does not drop: the whole run is refused (the runner reads its lists one name per line). */
  refused: string[];
}

/** @description Turn git's lists into the send plan. `exclude:` beats `send:`; a name with a newline that is not excluded is refused. */
export function planSendList(input: SendListInput): SendPlan {
  const isExcluded = createPathMatcher(input.exclude);
  const isOptedIn = createPathMatcher(input.send);
  const isOptedInForCall = createPathMatcher(input.callSend ?? []);
  const candidates = new Set<string>(input.files);
  for (const ignoredFile of input.ignoredFiles) {
    if (isOptedIn(ignoredFile) || isOptedInForCall(ignoredFile)) candidates.add(ignoredFile);
  }
  const plan: SendPlan = { files: [], heldBack: [], sentOnRequest: [], refused: [] };
  for (const file of [...candidates].sort()) {
    if (isExcluded(file)) continue;
    if (file.includes('\n')) plan.refused.push(file);
    else if (checkIsSecretLookingFile(file) && !isOptedIn(file) && !isOptedInForCall(file)) plan.heldBack.push(file);
    else {
      plan.files.push(file);
      if (checkIsSecretLookingFile(file) && !isOptedIn(file)) plan.sentOnRequest.push(file);
    }
  }
  return plan;
}

/** How many names the notices about secret-looking files spell out before «and N more». */
const noticeNamesShown = 5;

function formatFileCount(files: readonly string[]): string {
  return `${files.length} secret-looking file${files.length === 1 ? '' : 's'}`;
}

function formatNoticeNames(files: readonly string[]): string {
  const rest = files.length - noticeNamesShown;
  return rest > 0 ? `${files.slice(0, noticeNamesShown).join(', ')} and ${rest} more` : files.join(', ');
}

/** @description The line about secret-looking files that stay home: what they are and the two ways to send them (this call, every call). */
export function formatHeldBackNotice(heldBack: readonly string[]): string {
  return `held back ${formatFileCount(heldBack)}: ${formatNoticeNames(heldBack)} — send them for this call with --send <path>, or for every call with "send: <path>" in .remote-run (this line is said again only when the list changes)`;
}

/** @description The line about secret-looking files that go because this call's `--send` named them. */
export function formatSentOnRequestNotice(sentOnRequest: readonly string[]): string {
  return `sending ${formatFileCount(sentOnRequest)} named by --send: ${formatNoticeNames(sentOnRequest)}`;
}

/** @description The NUL-separated list `rsync --files-from=- --from0` reads. */
export function formatNulSeparatedList(files: readonly string[]): string {
  return files.map((file) => `${file}\0`).join('');
}

/** @description The list the runner diffs between two submits to find deletions: one path per line. */
export function formatManifest(files: readonly string[]): string {
  return files.map((file) => `${file}\n`).join('');
}

export interface RsyncSendParams {
  /** The ssh command rsync runs (`-e`), already joined. */
  sshCommand: string;
  /** The project root on this machine. */
  sourceRoot: string;
  /** `host:/path/stage/<job>/` */
  destination: string;
  /** The runner's current copy, so unchanged files are copied locally instead of sent again; `null` on a first send. */
  copyDestination: string | null;
}

/**
 * @description `rsync` of the listed files into the job's stage dir. `--copy-dest` (not `--link-dest`): a staged file is a real copy,
 * so a job that rewrites a file in place (`jest -u`) can never change what a queued job of the same project is going to apply.
 */
export function buildRsyncSendArgs(params: RsyncSendParams): string[] {
  return [
    '-a',
    rsyncNanosecondWindowArg,
    '--from0',
    '--files-from=-',
    ...(params.copyDestination === null ? [] : [`--copy-dest=${params.copyDestination}`]),
    '-e',
    params.sshCommand,
    `${params.sourceRoot}/`,
    params.destination,
  ];
}

/** @description `rsync` of the project's `.git` directory into the stage dir (`--with-git`). */
export function buildRsyncGitArgs(params: RsyncSendParams): string[] {
  return [
    '-a',
    rsyncNanosecondWindowArg,
    ...(params.copyDestination === null ? [] : [`--copy-dest=${params.copyDestination}`]),
    '-e',
    params.sshCommand,
    `${params.sourceRoot}/.git/`,
    `${params.destination}.git/`,
  ];
}

/** @description `rsync` of a small local folder (the job's meta files) to `destination`. */
export function buildRsyncMetaArgs(params: { sshCommand: string; sourceDirectory: string; destination: string }): string[] {
  return ['-rt', '-e', params.sshCommand, `${params.sourceDirectory}/`, params.destination];
}

/** @description `rsync` of a job's result files into a local temp folder: no symlinks at all, the runner is not trusted to write into the main box. */
export function buildRsyncFetchArgs(params: { sshCommand: string; source: string; destinationDirectory: string }): string[] {
  return ['-rt', '--no-links', '-e', params.sshCommand, `${params.source}/`, `${params.destinationDirectory}/`];
}
