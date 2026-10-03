import * as path from 'path';
import { createJiraClient, type JiraAccount, type JiraClient } from './client';
import { loadJiraConfig, resolveTriggerStatusIds, type JiraConfig } from './config';
import { JiraInbound, type JiraInboundDeps, type JiraProjectTrigger } from './inbound';
import { JiraTriggerLog, jiraTriggerLogFileName } from './triggerLog';

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
  /** Start polling (the session side is ready: the boot restored the sessions). */
  start(deps: JiraConnectorSessionDeps): void;
  stop(): void;
}

/** Until the answer side lands (J6), a parked trigger is only logged. */
async function logParkedIssue(issueKey: string, requester: JiraAccount | null): Promise<void> {
  console.warn(`[jira] ${issueKey} parked: over its run budget (requester ${requester ? 'known' : 'unknown'}); no request opened`);
}

/** A project's trigger status ids; a failed lookup is that project's reason, like an unknown name. */
async function getTriggerStatusIds(
  client: JiraClient,
  projectKey: string,
  statusNames: readonly string[],
): Promise<ReturnType<typeof resolveTriggerStatusIds>> {
  try {
    return resolveTriggerStatusIds(projectKey, statusNames, await client.getProjectStatuses(projectKey));
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function prepareJiraConnector(context: {
  dataDir: string;
  workRoot: string;
  openCodeUrl: string | undefined;
}): Promise<JiraConnector> {
  const loaded = loadJiraConfig(context);
  if (!loaded.ok) throw new JiraConnectorStartError(loaded.errors);
  const { config } = loaded;
  const client = createJiraClient({ baseUrl: config.baseUrl, email: config.email, apiToken: config.apiToken });

  // Independent lookups, made together; a project's failed lookup is one more
  // reason, so a misspelled key does not hide the other projects' problems.
  const [myself, resolvedProjects] = await Promise.all([
    client.getMyself(),
    Promise.all([...config.projects].map(async ([projectKey, project]) => ({
      projectKey,
      project,
      resolved: await getTriggerStatusIds(client, projectKey, project.triggerStatusNames),
    }))),
  ]);
  const reasons: string[] = [];
  if (myself.accountId !== config.accountId) {
    reasons.push('jira.json accountId is not the account its apiToken belongs to');
  }
  const projects = new Map<string, JiraProjectTrigger>();
  for (const { projectKey, project, resolved } of resolvedProjects) {
    if (resolved.ok) projects.set(projectKey, { folder: project.folder, triggerStatusIds: new Set(resolved.statusIds) });
    else reasons.push(resolved.error);
  }
  if (reasons.length > 0) throw new JiraConnectorStartError(reasons);

  const triggerLog = JiraTriggerLog.createForDataDir(path.join(context.dataDir, jiraTriggerLogFileName));
  await triggerLog.load();

  let inbound: JiraInbound | null = null;
  return {
    adapterName: config.adapter,
    launchDefaults: { model: config.model, effort: config.effort },
    start: (deps) => {
      inbound?.stop();
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
        parkIssue: logParkedIssue,
      });
      inbound.start();
      console.log(`[jira] polling ${[...projects.keys()].join(', ')} every ${config.pollIntervalMs / 1000} s`);
    },
    stop: () => {
      inbound?.stop();
      inbound = null;
    },
  };
}
