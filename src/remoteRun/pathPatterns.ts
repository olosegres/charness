/**
 * @description The ONE definition of what a path pattern of `.remote-run` (`pull:`, `exclude:`, `send:`, `install-key:`) means, as
 * extended regular expressions: the main box applies them with `RegExp` and the runner script with bash's `=~` over the very same
 * strings, so the two can never disagree about which files a pattern names.
 *
 * A pattern is relative to the project root. `*` is any run of characters inside one path segment, `?` one character, `**` a whole
 * segment of any depth (`**` + `/` before a name, `/` + `**` at the end). A pattern names a file OR a directory: a directory brings
 * everything below it (`test-results` is `test-results/a/b.png` too). Nothing floats: `snapshots` is the folder at the root only,
 * `**` + `/snapshots` any `snapshots` folder.
 */

const regexSpecialCharacters = /[.[\]{}()*+?|^$\\]/g;
const anyDepthPrefix = '(.*/)?';
const anyDepthSuffix = '.*';
const singleSegmentRun = '[^/]*';
const singleCharacter = '[^/]';
/** Control characters (a newline would split the pattern file the runner reads one pattern per line). */
const controlCharacters = /[\x00-\x1f\x7f]/;

function escapeLiteral(text: string): string {
  return text.replace(regexSpecialCharacters, '\\$&');
}

/** The parts of a pattern between slashes, without `./` prefixes, trailing slashes or empty parts; consecutive `**` parts are one (they mean the same, and nested any-depth groups backtrack badly). */
function splitPatternSegments(pattern: string): string[] {
  const segments = pattern.replace(/^(\.\/)+/, '').replace(/\/+$/, '').split('/').filter((segment) => segment !== '' && segment !== '.');
  return segments.filter((segment, index) => !(segment === '**' && segments[index - 1] === '**'));
}

/** @description Why `pattern` cannot be used, or `null` when it can: not empty, relative, inside the project, no control characters. */
export function getPathPatternProblem(pattern: string): string | null {
  if (pattern.trim() === '') return 'is empty';
  if (controlCharacters.test(pattern)) return 'holds a control character';
  if (pattern.startsWith('/')) return 'must be relative to the project root, not absolute';
  if (pattern.startsWith('~')) return 'must be relative to the project root, not start with ~';
  if (pattern.split('/').includes('..')) return 'must stay inside the project (no ".." part)';
  if (splitPatternSegments(pattern).length === 0) return 'names no path (name a file or a folder of the project)';
  return null;
}

/** @description The extended regular expression (anchored) a project-relative path must match to be named by `pattern`. */
export function compilePathPattern(pattern: string): string {
  const problem = getPathPatternProblem(pattern);
  if (problem !== null) throw new Error(`a path pattern ${problem}`);
  const segments = splitPatternSegments(pattern);
  let source = '';
  segments.forEach((segment, index) => {
    const isLast = index === segments.length - 1;
    if (segment === '**') {
      source += isLast ? anyDepthSuffix : anyDepthPrefix;
      return;
    }
    let escaped = '';
    for (const character of segment) {
      if (character === '*') escaped += singleSegmentRun;
      else if (character === '?') escaped += singleCharacter;
      else escaped += escapeLiteral(character);
    }
    source += isLast ? escaped : `${escaped}/`;
  });
  // A trailing `**` already ends in `.*` after a slash; a trailing name may be a directory with files below it.
  const needsDirectoryTail = segments[segments.length - 1] !== '**';
  return `^${source}${needsDirectoryTail ? '(/.*)?' : ''}$`;
}

/** @description The compiled expressions of `patterns`, in order (the form the runner script receives, one per line). */
export function compilePathPatterns(patterns: readonly string[]): string[] {
  return patterns.map(compilePathPattern);
}

/** @description A predicate over project-relative paths: does any of `patterns` name it? No pattern names nothing. */
export function createPathMatcher(patterns: readonly string[]): (relativePath: string) => boolean {
  const expressions = compilePathPatterns(patterns).map((source) => new RegExp(source));
  return (relativePath) => expressions.some((expression) => expression.test(relativePath));
}
