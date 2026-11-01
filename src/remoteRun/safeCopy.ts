import * as fs from 'fs';
import * as path from 'path';
import { createPathMatcher } from './pathPatterns';
import { projectConfigName } from './projectConfig';

/**
 * @description Bring a job's result files into the project, from a temp folder the runner's files were rsynced into. The runner is not
 * trusted to write into the main box: only REGULAR files whose project-relative path a `pull:` pattern names are copied — never one that
 * {@link getProtectedPathReason} protects; a symlink,
 * a special file, a path no pattern names, or a destination that would pass through a symlink or over a directory of the project is
 * refused and only counted. Nothing outside the project root can be reached: paths come from walking the temp folder, and every
 * destination directory is checked component by component.
 */

export interface SafeCopyResult {
  copied: string[];
  /** Files seen in the fetched folder that were not copied (symlinks, special files, paths no pattern names, unsafe destinations). */
  refusedCount: number;
}

const copiedFileModeMask = 0o777;

function listFetchedEntries(directory: string, relativeDirectory: string, found: Array<{ relativePath: string; kind: 'file' | 'other' }>): void {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const relativePath = relativeDirectory === '' ? entry.name : path.posix.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) listFetchedEntries(path.join(directory, entry.name), relativePath, found);
    else found.push({ relativePath, kind: entry.isFile() ? 'file' : 'other' });
  }
}

/** Create the directories of `relativeDirectory` under `rootReal`, refusing a symlink or a non-directory on the way. `false` = unsafe. */
function ensureSafeDirectory(rootReal: string, relativeDirectory: string): boolean {
  let current = rootReal;
  for (const part of relativeDirectory.split('/').filter((segment) => segment !== '')) {
    current = path.join(current, part);
    let stat: fs.Stats | null;
    try {
      stat = fs.lstatSync(current);
    } catch {
      stat = null;
    }
    if (stat === null) fs.mkdirSync(current);
    else if (!stat.isDirectory()) return false;
  }
  return true;
}

const gitDirectoryName = '.git';

/** Is `relativePath` the folder `directory` or inside it? `''` is the project root: everything. Case-insensitive, like the disks that make `.Git` the same as `.git`. */
function checkIsInsideDirectory(relativePath: string, directory: string): boolean {
  if (directory === '') return true;
  const lowerPath = relativePath.toLowerCase();
  const lowerDirectory = directory.toLowerCase();
  return lowerPath === lowerDirectory || lowerPath.startsWith(`${lowerDirectory}/`);
}

/**
 * @description Why a path may never be copied in, whatever a `pull:` pattern says — or `null`. A broad pattern (`**`) is a trust in the
 * runner for what it names, but some files turn that into code running on the MAIN box: anything under a `.git` (a hook, or
 * `core.hooksPath` / `fsmonitor` in its `config`, run at the next git command), the project's own `.remote-run` (it decides what is sent,
 * installed and pulled next time), and anything in a folder git takes hooks from (`hookDirectories`: `getHookDirectories` in `project.ts` —
 * husky's `.husky`, a `core.hooksPath` inside the project). Compared case-insensitively: on a case-insensitive disk `.Git/hooks` IS
 * `.git/hooks`. Other tools that run commands at commit (lint-staged and lefthook configs, `package.json` scripts) are not recognised:
 * that is what keeping `pull:` narrow is for.
 */
export function getProtectedPathReason(relativePath: string, hookDirectories: readonly string[] = []): string | null {
  if (relativePath.split('/').some((part) => part.toLowerCase() === gitDirectoryName)) return 'inside a .git';
  if (relativePath.toLowerCase() === projectConfigName) return "the project's .remote-run";
  const hookDirectory = hookDirectories.find((directory) => checkIsInsideDirectory(relativePath, directory));
  if (hookDirectory !== undefined) return hookDirectory === '' ? 'in a project whose git hooks folder is the project root' : `inside the git hooks folder ${hookDirectory}`;
  return null;
}

/** @description Copy the files of `fetchedRoot` that `patterns` name into `projectRoot`, as the module comment says. */
export function copyFetchedFiles(params: { fetchedRoot: string; projectRoot: string; patterns: readonly string[]; hookDirectories?: readonly string[] }): SafeCopyResult {
  const isNamed = createPathMatcher(params.patterns);
  const rootReal = fs.realpathSync(params.projectRoot);
  const entries: Array<{ relativePath: string; kind: 'file' | 'other' }> = [];
  listFetchedEntries(params.fetchedRoot, '', entries);
  const result: SafeCopyResult = { copied: [], refusedCount: 0 };
  for (const entry of entries) {
    const isInside = !entry.relativePath.split('/').includes('..') && !path.isAbsolute(entry.relativePath);
    if (entry.kind !== 'file' || !isInside || !isNamed(entry.relativePath) || getProtectedPathReason(entry.relativePath, params.hookDirectories) !== null) {
      result.refusedCount += 1;
      continue;
    }
    const destination = path.join(rootReal, entry.relativePath);
    if (!ensureSafeDirectory(rootReal, path.posix.dirname(entry.relativePath) === '.' ? '' : path.posix.dirname(entry.relativePath))) {
      result.refusedCount += 1;
      continue;
    }
    let existing: fs.Stats | null;
    try {
      existing = fs.lstatSync(destination);
    } catch {
      existing = null;
    }
    if (existing !== null && !existing.isFile()) {
      result.refusedCount += 1;
      continue;
    }
    const source = path.join(params.fetchedRoot, entry.relativePath);
    const temporary = `${destination}.remote-run-${process.pid}.tmp`;
    fs.copyFileSync(source, temporary);
    fs.chmodSync(temporary, fs.statSync(source).mode & copiedFileModeMask);
    fs.renameSync(temporary, destination);
    result.copied.push(entry.relativePath);
  }
  return result;
}
