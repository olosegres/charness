/**
 * @description Reading a charness instance's console output in the process-level
 * Jira tests (J7 against the fake Jira, J8 against a live site): what its polls
 * decided and which projects its poll's JQL names.
 */

import { jiraPollJqlLogPrefix } from '../../connectors/jira/connector';

const pollDecisionLinePrefix = '[jira] poll: ';
/** `project in ("A", "B") AND …` — the allowlist part of the poll's JQL. */
const jqlProjectListRe = /^project in \(([^)]*)\)/;

/** @description Every `issue decision` pair the polls logged, in order (`[jira] poll: KEY decision, …`). */
export function getPolledDecisions(output: string): Array<{ issueKey: string; decision: string }> {
  return output.split('\n')
    .filter((line) => line.startsWith(pollDecisionLinePrefix))
    .flatMap((line) => line.slice(pollDecisionLinePrefix.length).split(', '))
    .map((entry) => {
      const [issueKey, decision] = entry.split(' ');
      return { issueKey, decision };
    });
}

/** @description The issues the polls opened a request for. */
export function getPolledRequestIssueKeys(output: string): string[] {
  return getPolledDecisions(output).filter(({ decision }) => decision === 'request').map(({ issueKey }) => issueKey);
}

/**
 * @description The project keys of every poll JQL the output logged, one list per
 * start of polling; a JQL whose allowlist part does not parse yields `null`, so an
 * unexpected shape fails the caller's assertion instead of reading as "no project".
 */
export function getPollJqlProjectKeys(output: string): Array<string[] | null> {
  return output.split('\n')
    .filter((line) => line.startsWith(jiraPollJqlLogPrefix))
    .map((line) => {
      const match = jqlProjectListRe.exec(line.slice(jiraPollJqlLogPrefix.length));
      return match ? match[1].split(',').map((projectKey) => projectKey.trim().replace(/^"|"$/g, '')) : null;
    });
}
