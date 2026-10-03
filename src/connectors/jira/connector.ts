import * as path from 'path';
import { createJiraClient, JiraAuthError, JiraHttpError, type JiraClient } from './client';
import { createJiraAnswerSink, type JiraAnswerSink } from './answerSink';
import { loadJiraConfig, resolveTriggerStatusIds, type JiraConfig } from './config';
import { buildJiraTriggerJql, getJiraRetryDelayMs, JiraInbound, type JiraInboundDeps, type JiraProjectTrigger } from './inbound';
import { JiraTriggerLog, jiraTriggerLogFileName } from './triggerLog';
import { JiraUnconfirmedPosts, jiraUnconfirmedPostsFileName } from './unconfirmedPosts';
import { sleep } from '../../utils';

/**
 * @description The Jira connector's entry point, loaded by `bot.ts` through a
 * dynamic `import()` only when `CONNECTORS` lists `jira` (R20). Preparing it
 * reads and checks everything a poll depends on BEFORE the boot goes on — the
 * config, that the API token belongs to the configured AI account, each
 * project's trigger status ids, the trigger log — so a broken setup stops the
 * start with every reason at once instead of failing on the first poll.
 */

export class JiraConnectorStartError extends Error {
  constructor(readonly reasons: string[]) {
    super(`the Jira connector cannot start: ${reasons.join('; ')}`);
    this.name = 'JiraConnectorStartError';
  }
}

/** What the connector needs from the core to open and post requests. */
export type JiraConnectorSessionDeps = Pick<JiraInboundDeps, 'bindConversation' | 'createRequest' | 'postRequest'>;

export interface JiraConnector {
  /** The backend Jira sessions run on (D16, R14). */
  adapterName: JiraConfig['adapter'];
  /** `jira.json`'s model and effort for new sessions (R15). */
  launchDefaults: { model: string | null; effort: string | null };
  /** Where answers, alerts and park notices go: comments on the issue (J6). */
  answerSink: JiraAnswerSink;
  /** Start polling (the session side is ready: the boot restored the sessions). */
  start(deps: JiraConnectorSessionDeps): void;
  stop(): void;
}

/**
 * @description R22: a failure that says nothing about the setup — no answer, a
 * 5xx, a 429 after the client's own retries. A refused token (401/403) or any
 * other 4xx (an unknown project) is the setup's fault.
 */
export function checkIsTransientJiraFailure(error: Error): boolean {
  if (error instanceof JiraAuthError) return false;
  if (error instanceof JiraHttpError) return error.status === 0 || error.status === 429 || error.status >= 500;
  return true;
}

/**
 * @name JiraSetupCheck
 * @description `ready` — every project resolved; `refused` — the setup itself is
 * wrong (every reason); `unreachable` — Jira did not answer well enough to tell.
 */
type JiraSetupCheck =
  | { kind: 'ready'; projects: ReadonlyMap<string, JiraProjectTrigger> }
  | { kind: 'refused'; reasons: string[] }
  | { kind: 'unreachable'; detail: string };

type SettledLookup<T> = { ok: true; value: T } | { ok: false; error: Error };

/** A lookup's result or its failure, so independent lookups can run together and all be reported. */
async function settle<T>(lookup: Promise<T>): Promise<SettledLookup<T>> {
  try {
    return { ok: true, value: await lookup };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
  }
}

/** What the setup check reads from Jira: the token's account, every project's statuses. */
async function checkJiraSetup(client: JiraClient, config: JiraConfig): Promise<JiraSetupCheck> {
  const projectEntries = [...config.projects];
  // Independent lookups, made together; one project's failure does not hide the others' problems.
  const [myself, statusLookups] = await Promise.all([
    settle(client.getMyself()),
    Promise.all(projectEntries.map(([projectKey]) => settle(client.getProjectStatuses(projectKey)))),
  ]);
  const reasons: string[] = [];
  const transientDetails: string[] = [];
  const noteFailure = (error: Error): void => {
    (checkIsTransientJiraFailure(error) ? transientDetails : reasons).push(error.message);
  };
  if (!myself.ok) noteFailure(myself.error);
  else if (myself.value.accountId !== config.accountId) reasons.push('jira.json accountId is not the account its apiToken belongs to');
  const projects = new Map<string, JiraProjectTrigger>();
  projectEntries.forEach(([projectKey, project], index) => {
    const lookup = statusLookups[index];
    if (!lookup.ok) {
      noteFailure(lookup.error);
      return;
    }
    const resolved = resolveTriggerStatusIds(projectKey, project.triggerStatusNames, lookup.value);
    if (resolved.ok) projects.set(projectKey, { folder: project.folder, triggerStatusIds: new Set(resolved.statusIds) });
    else reasons.push(resolved.error);
  });
  if (reasons.length > 0) return { kind: 'refused', reasons };
  if (transientDetails.length > 0) return { kind: 'unreachable', detail: transientDetails.join('; ') };
  return { kind: 'ready', projects };
}

/** The start-of-polling log line that carries the poll's JQL. */
export const jiraPollJqlLogPrefix = '[jira] poll JQL: ';

export async function prepareJiraConnector(context: {
  dataDir: string;
  workRoot: string;
  openCodeUrl: string | undefined;
  /** Tests only: a shorter base for the setup re-check's backoff (default: the poll interval) and the client's retry sleep. */
  testTiming?: { setupRetryBaseMs: number; sleep: (ms: number) => Promise<void> };
}): Promise<JiraConnector> {
  const loaded = loadJiraConfig(context);
  if (!loaded.ok) throw new JiraConnectorStartError(loaded.errors);
  const { config } = loaded;
  const client = createJiraClient({
    baseUrl: config.baseUrl,
    email: config.email,
    apiToken: config.apiToken,
    ...(context.testTiming ? { sleepImpl: context.testTiming.sleep } : {}),
  });

  // R22: a wrong setup refuses the start; a Jira that does not answer does not —
  // the connector starts and checks again before its first poll.
  const firstCheck = await checkJiraSetup(client, config);
  if (firstCheck.kind === 'refused') throw new JiraConnectorStartError(firstCheck.reasons);
  if (firstCheck.kind === 'unreachable') console.warn(`[jira] Jira unreachable at start (${firstCheck.detail}); polling starts once it answers`);

  const triggerLog = JiraTriggerLog.createForDataDir(path.join(context.dataDir, jiraTriggerLogFileName));
  await triggerLog.load();
  const now = (): number => Date.now();
  const unconfirmedPosts = JiraUnconfirmedPosts.createForDataDir(path.join(context.dataDir, jiraUnconfirmedPostsFileName), now);
  await unconfirmedPosts.load();

  const answerSink = createJiraAnswerSink({
    client,
    aiAccountId: config.accountId,
    runBudgetPer24h: config.runBudgetPer24h,
    now,
    wait: sleep,
    unconfirmedPosts,
  });
  let inbound: JiraInbound | null = null;
  let setupRetryTimer: NodeJS.Timeout | null = null;
  let isStarted = false;

  const startPolling = (deps: JiraConnectorSessionDeps, projects: ReadonlyMap<string, JiraProjectTrigger>): void => {
    inbound = new JiraInbound({
      ...deps,
      client,
      aiAccountId: config.accountId,
      siteUrl: config.baseUrl,
      projects,
      runBudgetPer24h: config.runBudgetPer24h,
      pollIntervalMs: config.pollIntervalMs,
      triggerLog,
      now: () => Date.now(),
      parkIssue: (issueKey, requester) => answerSink.parkIssue(issueKey, requester),
    });
    inbound.start();
    console.log(`[jira] polling ${[...projects.keys()].join(', ')} every ${config.pollIntervalMs / 1000} s`);
    // The allowlist as Jira receives it — what an operator reads to see which projects the AI account may act in.
    console.log(`${jiraPollJqlLogPrefix}${buildJiraTriggerJql(projects)}`);
  };

  /** Check the setup again, with backoff, until Jira answers; then poll — or, if the setup turns out wrong, stop loudly (the process stays up). */
  const retrySetupCheck = (deps: JiraConnectorSessionDeps, failureCount: number): void => {
    // Not unref'd: in a Jira-only instance this timer keeps the process alive (D9).
    setupRetryTimer = setTimeout(() => {
      void checkJiraSetup(client, config).then((check) => {
        if (!isStarted) return;
        if (check.kind === 'ready') startPolling(deps, check.projects);
        else if (check.kind === 'refused') for (const reason of check.reasons) console.error(`[jira] polling NOT started: ${reason}`);
        else retrySetupCheck(deps, failureCount + 1);
      });
    }, getJiraRetryDelayMs(context.testTiming?.setupRetryBaseMs ?? config.pollIntervalMs, failureCount));
  };

  return {
    adapterName: config.adapter,
    launchDefaults: { model: config.model, effort: config.effort },
    answerSink,
    start: (deps) => {
      if (isStarted) return;
      isStarted = true;
      if (firstCheck.kind === 'ready') startPolling(deps, firstCheck.projects);
      else retrySetupCheck(deps, 0);
    },
    stop: () => {
      isStarted = false;
      if (setupRetryTimer) clearTimeout(setupRetryTimer);
      setupRetryTimer = null;
      inbound?.stop();
      inbound = null;
    },
  };
}
