import { getPathPatternProblem } from './pathPatterns';

/**
 * @description `.remote-run` in the project root: what a project tells remote-run about itself. Optional; `key: value` lines, `#`
 * starts a comment at the start of a line or after whitespace, blank lines are ignored. An unknown key or a bad value is an error
 * that names the line.
 *
 *   pull: e2e/artifacts test-results                    files that come back (only what the job created or changed)
 *   install: yarn install --immutable                   replaces the detected dependencies command; `install: none` turns the step off
 *   install-key: yarn.lock package.json patches         what the dependencies step is keyed on (replaces the default)
 *   exclude: fixtures/huge                              more paths that are never sent
 *   send: .env.test                                     secret-looking files that ARE sent (also when git ignores them)
 *
 * The list keys (`pull`, `exclude`, `send`, `install-key`) take whitespace-separated patterns (`pathPatterns.ts`) and may repeat;
 * `install` and `install-key` may each appear once.
 */

/** The value of `install:` that turns the dependencies step off. */
export const installNone = 'none';

export interface ProjectConfig {
  pull: string[];
  /** The command, `none` for no step, `null` when the file says nothing (the lockfile's default applies). */
  install: string | null;
  /** The patterns the dependencies step is keyed on; `null` = the default key set. */
  installKey: string[] | null;
  exclude: string[];
  send: string[];
}

export type ProjectConfigParse = { ok: true; config: ProjectConfig } | { ok: false; errors: string[] };

const projectConfigFileName = '.remote-run';
const listKeys = ['pull', 'exclude', 'send', 'install-key'] as const;
const commentPattern = /(^|\s)#.*$/;

export function createEmptyProjectConfig(): ProjectConfig {
  return { pull: [], install: null, installKey: null, exclude: [], send: [] };
}

/** @description The file name, for messages. */
export const projectConfigName = projectConfigFileName;

/** @description Parse the text of a `.remote-run`; every problem is reported (not just the first), each naming its line. */
export function parseProjectConfig(text: string): ProjectConfigParse {
  const config = createEmptyProjectConfig();
  const errors: string[] = [];
  const seenKeys = new Set<string>();
  text.split(/\r?\n/).forEach((rawLine, index) => {
    const lineNumber = index + 1;
    const line = rawLine.replace(commentPattern, '$1').trim();
    if (line === '') return;
    const separator = line.indexOf(':');
    if (separator <= 0) {
      errors.push(`${projectConfigFileName} line ${lineNumber}: expected "key: value"`);
      return;
    }
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    const fail = (message: string): void => {
      errors.push(`${projectConfigFileName} line ${lineNumber}: ${message}`);
    };
    if (key !== 'install' && !listKeys.some((listKey) => listKey === key)) {
      fail(`unknown key "${key}" (known: pull, install, install-key, exclude, send)`);
      return;
    }
    if ((key === 'install' || key === 'install-key') && seenKeys.has(key)) {
      fail(`"${key}" is given twice`);
      return;
    }
    seenKeys.add(key);
    if (value === '') {
      fail(`"${key}" has no value`);
      return;
    }
    if (key === 'install') {
      config.install = value;
      return;
    }
    const patterns = value.split(/\s+/);
    for (const pattern of patterns) {
      const problem = getPathPatternProblem(pattern);
      if (problem !== null) {
        fail(`"${key}" pattern ${problem}`);
        return;
      }
    }
    if (key === 'install-key') config.installKey = patterns;
    else if (key === 'pull') config.pull.push(...patterns);
    else if (key === 'exclude') config.exclude.push(...patterns);
    else config.send.push(...patterns);
  });
  return errors.length === 0 ? { ok: true, config } : { ok: false, errors };
}
