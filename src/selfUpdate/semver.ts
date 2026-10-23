/**
 * Just enough semver for the update decisions — parse, compare, and the range forms `engines.node` uses. No
 * dependency: the full `semver` package is not one of ours, and none of these forms is exotic.
 */

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

const versionPattern = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const comparatorPattern = /^(>=|<=|>|<|=|\^|~)?\s*v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?$/;
const wildcardPattern = /^[xX*]$/;

/** @description `3.4.0`, `v3.4.0`, `3.5.0-beta.1` → its parts; null for anything else (`3.4`, `latest`). */
export function parseSemVer(text: string): SemVer | null {
  const match = versionPattern.exec(text.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

export function checkIsPrerelease(version: SemVer): boolean {
  return version.prerelease.length > 0;
}

function comparePrereleaseIdentifier(left: string, right: string): number {
  const isLeftNumeric = /^\d+$/.test(left);
  const isRightNumeric = /^\d+$/.test(right);
  if (isLeftNumeric && isRightNumeric) return Math.sign(Number(left) - Number(right));
  if (isLeftNumeric) return -1;
  if (isRightNumeric) return 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

/** @description -1 / 0 / 1; a prerelease sorts below its release, identifiers compare as semver says. */
export function compareSemVer(left: SemVer, right: SemVer): number {
  for (const field of ['major', 'minor', 'patch'] as const) {
    if (left[field] !== right[field]) return Math.sign(left[field] - right[field]);
  }
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0;
  if (left.prerelease.length === 0) return 1;
  if (right.prerelease.length === 0) return -1;
  const shared = Math.min(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < shared; index += 1) {
    const result = comparePrereleaseIdentifier(left.prerelease[index], right.prerelease[index]);
    if (result !== 0) return result;
  }
  return Math.sign(left.prerelease.length - right.prerelease.length);
}

/** @description `compareSemVer` on two version texts; null when either is not a version. */
export function compareVersionTexts(left: string, right: string): number | null {
  const leftVersion = parseSemVer(left);
  const rightVersion = parseSemVer(right);
  return leftVersion && rightVersion ? compareSemVer(leftVersion, rightVersion) : null;
}

type Bound = { op: '>=' | '>' | '<=' | '<'; version: SemVer };

function createVersion(major: number, minor: number, patch: number, prerelease: string[] = []): SemVer {
  return { major, minor, patch, prerelease };
}

/** A comparator such as `^20.17`, `~22.1`, `22.x`, `>=22.12` as the bounds it means; null when unreadable. */
function getComparatorBounds(text: string): Bound[] | null {
  const match = comparatorPattern.exec(text);
  if (!match) return null;
  const [, operator = '', majorText, minorText, patchText, prerelease] = match;
  if (wildcardPattern.test(majorText)) return operator === '' || operator === '=' ? [] : null;
  const major = Number(majorText);
  const isMinorOpen = minorText === undefined || wildcardPattern.test(minorText);
  const minor = isMinorOpen ? 0 : Number(minorText);
  const isPatchOpen = patchText === undefined || wildcardPattern.test(patchText);
  const patch = isPatchOpen ? 0 : Number(patchText);
  const base = createVersion(major, minor, patch, prerelease ? prerelease.split('.') : []);
  switch (operator) {
    case '>=':
      return [{ op: '>=', version: base }];
    case '>':
      return isMinorOpen
        ? [{ op: '>=', version: createVersion(major + 1, 0, 0) }]
        : isPatchOpen
          ? [{ op: '>=', version: createVersion(major, minor + 1, 0) }]
          : [{ op: '>', version: base }];
    case '<=':
      return isMinorOpen
        ? [{ op: '<', version: createVersion(major + 1, 0, 0) }]
        : isPatchOpen
          ? [{ op: '<', version: createVersion(major, minor + 1, 0) }]
          : [{ op: '<=', version: base }];
    case '<':
      return [{ op: '<', version: base }];
    case '^': {
      // Same left-most non-zero part: ^1.2.3 → <2.0.0, ^0.2.3 → <0.3.0, ^0.0.3 → <0.0.4.
      const upper =
        major > 0 || isMinorOpen
          ? createVersion(major + 1, 0, 0)
          : minor > 0 || isPatchOpen
            ? createVersion(0, minor + 1, 0)
            : createVersion(0, 0, patch + 1);
      return [{ op: '>=', version: base }, { op: '<', version: upper }];
    }
    case '~': {
      const upper = isMinorOpen ? createVersion(major + 1, 0, 0) : createVersion(major, minor + 1, 0);
      return [{ op: '>=', version: base }, { op: '<', version: upper }];
    }
    default: {
      if (isMinorOpen) return [{ op: '>=', version: base }, { op: '<', version: createVersion(major + 1, 0, 0) }];
      if (isPatchOpen) return [{ op: '>=', version: base }, { op: '<', version: createVersion(major, minor + 1, 0) }];
      return [{ op: '>=', version: base }, { op: '<=', version: base }];
    }
  }
}

function checkSatisfiesBound(version: SemVer, bound: Bound): boolean {
  const result = compareSemVer(version, bound.version);
  switch (bound.op) {
    case '>=':
      return result >= 0;
    case '>':
      return result > 0;
    case '<=':
      return result <= 0;
    default:
      return result < 0;
  }
}

/** Joins a lone operator to the version that follows it (`>= 22.12` → `>=22.12`). */
function splitComparators(clause: string): string[] {
  return clause.replace(/(>=|<=|>|<|=|\^|~)\s+/g, '$1').split(/\s+/).filter((part) => part !== '');
}

/**
 * @description Whether `version` satisfies an npm range: comparators (`>=22.12`, `<25`), `^`, `~`, `x` ranges
 * (`22.x`), joined by spaces (and) and `||` (or). An empty range accepts everything; null when the range cannot be
 * read, so the caller can tell "no" from "unknown" — a version is never refused over a range we cannot parse.
 */
export function checkSatisfiesRange(version: SemVer, range: string): boolean | null {
  if (range.trim() === '') return true;
  let isUnreadable = false;
  const isAnyClauseSatisfied = range.split('||').some((clause) => {
    const bounds: Bound[] = [];
    for (const comparator of splitComparators(clause.trim())) {
      const comparatorBounds = getComparatorBounds(comparator);
      if (comparatorBounds === null) {
        isUnreadable = true;
        return false;
      }
      bounds.push(...comparatorBounds);
    }
    return bounds.every((bound) => checkSatisfiesBound(version, bound));
  });
  if (isAnyClauseSatisfied) return true;
  return isUnreadable ? null : false;
}
