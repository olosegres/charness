/**
 * Pure decisions of the release's test gate: the `Tests` workflow (`.github/workflows/test.yml`) runs the full suite on every push
 * to main, and the release does not run it again when the exact commit it releases already passed there. What a commit's runs say
 * (`getTestGateVerdict`), what the release does about it (`decideTestGate`), and whether the release commit differs from the tested
 * one only in the version and the CHANGELOG (`getReleaseDeltaProblems`). No network, no git — `cli.ts` feeds and acts. This
 * directory is never built into `dist/` and never shipped.
 */

/** The file name of the workflow whose result the release looks up. */
export const testWorkflowFile = 'test.yml';

/** The part of a GitHub `workflow run` the gate reads. */
export type WorkflowRun = {
  id: number;
  head_sha: string;
  /** `queued`, `in_progress`, `completed`, … */
  status: string;
  /** `success`, `failure`, `cancelled`, … — `null` until the run is completed. */
  conclusion: string | null;
  created_at: string;
  html_url: string;
};

export type TestGateState = 'passed' | 'failed' | 'running' | 'none';

export type TestGateVerdict = {
  state: TestGateState;
  /** One line a person can act on: which run, what it says. */
  reason: string;
};

/** What the release does with a verdict. `isRefusal`: the run fails; otherwise a `proceed: false` ends the run green. */
export type TestGateDecision = {
  proceed: boolean;
  /** No run exists for the commit: the release runs the suite itself. */
  runSuite: boolean;
  isRefusal: boolean;
  message: string;
};

const completedStatus = 'completed';
const successConclusion = 'success';
/** The only event whose run is the daily one: it skips a commit that is not green, every other entry refuses. */
const scheduleEvent = 'schedule';

/**
 * @description The result of the `Tests` workflow for the exact commit `sha`: the NEWEST run of that commit decides (a rerun of a
 * failed run updates the run itself; a separate newer run of the same commit is the more recent word).
 */
export function getTestGateVerdict(runs: WorkflowRun[], sha: string): TestGateVerdict {
  const shortSha = sha.slice(0, 7);
  const runsOfCommit = runs.filter((run) => run.head_sha === sha);
  if (runsOfCommit.length === 0) return { state: 'none', reason: `the Tests workflow has no run for ${shortSha}` };
  const [newest] = [...runsOfCommit].sort((first, second) => second.created_at.localeCompare(first.created_at) || second.id - first.id);
  if (newest.status !== completedStatus) {
    return { state: 'running', reason: `the Tests run for ${shortSha} is still ${newest.status.replaceAll('_', ' ')} (${newest.html_url})` };
  }
  if (newest.conclusion === successConclusion) return { state: 'passed', reason: `the Tests run for ${shortSha} passed (${newest.html_url})` };
  return { state: 'failed', reason: `the Tests run for ${shortSha} did not pass: ${newest.conclusion ?? 'no conclusion'} (${newest.html_url})` };
}

/**
 * @description What a release does about the verdict of the commit it would release. Passed → go on without the suite; no run at all
 * (a manual dispatch before CI ran) → go on and run the suite here; failed or still running → the daily run releases nothing that
 * day and ends green with the reason, any other entry (dispatch, a hand-pushed tag) refuses, so the person who asked sees it fail.
 */
export function decideTestGate(verdict: TestGateVerdict, event: string): TestGateDecision {
  if (verdict.state === 'passed') return { proceed: true, runSuite: false, isRefusal: false, message: `${verdict.reason}; the release does not run the suite again.` };
  if (verdict.state === 'none') return { proceed: true, runSuite: true, isRefusal: false, message: `${verdict.reason}; the release runs the suite itself.` };
  const reasonToWait = verdict.state === 'running' ? 'wait for it to finish, then run the release again' : 'fix the tests (or push a fix) first';
  if (event === scheduleEvent) {
    return { proceed: false, runSuite: false, isRefusal: false, message: `No release today: ${verdict.reason}. The next daily run tries again.` };
  }
  return { proceed: false, runSuite: false, isRefusal: true, message: `Refusing to release: ${verdict.reason}; ${reasonToWait}.` };
}

/** What differs between the tested commit and the release commit. */
export type ReleaseDelta = {
  /** `git diff --name-only` between the two. */
  changedPaths: string[];
  /** `git diff -U0` of `package.json` between the two (empty when it did not change). */
  manifestDiff: string;
};

const manifestPath = 'package.json';
const changelogPath = 'CHANGELOG.md';
const allowedDeltaPaths = [manifestPath, changelogPath];
const versionLinePattern = /^(?<sign>[-+])\s*"version"\s*:\s*"(?<version>\d+\.\d+\.\d+)"\s*,?\s*$/;
const diffFileHeaderPattern = /^(---|\+\+\+) /;
const diffHunkHeaderPattern = /^@@ /;
const changedLinePattern = /^[-+]/;

/**
 * @description Why the release commit is NOT "the tested commit plus its version bump": a path other than `package.json` /
 * `CHANGELOG.md` changed, or `package.json` changed in anything but its `"version"` line. Empty: it is.
 */
export function getReleaseDeltaProblems(delta: ReleaseDelta): string[] {
  const problems = delta.changedPaths.filter((filePath) => !allowedDeltaPaths.includes(filePath)).map((filePath) => `${filePath} differs from the tested commit`);
  if (!delta.changedPaths.includes(manifestPath)) return problems;
  const changedLines = delta.manifestDiff
    .split('\n')
    .filter((line) => changedLinePattern.test(line) && !diffFileHeaderPattern.test(line) && !diffHunkHeaderPattern.test(line));
  const versionLines = changedLines.map((line) => versionLinePattern.exec(line)?.groups);
  const isOnlyVersionBump =
    changedLines.length === 2 &&
    versionLines[0]?.sign === '-' &&
    versionLines[1]?.sign === '+' &&
    versionLines[0].version !== versionLines[1].version;
  if (!isOnlyVersionBump) problems.push(`${manifestPath} differs from the tested commit in more than its "version" line`);
  return problems;
}
