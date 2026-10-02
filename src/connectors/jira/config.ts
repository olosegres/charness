import * as fs from 'fs';
import { z } from 'zod';
import { expandEnvVars } from '../../mcpConfig';
import { BindError, validateSubdir, type BindErrorCode } from '../../validation';
import { defaultOpenCodeUrl, getOpenCodePort } from '../../installManager';
import { claudeJsonStreamAdapterName } from '../../adapters/claudeJsonStreamAdapter';
import { checkIsJiraProjectKey } from './sessionKeyCodec';
import { getJiraConfigPath } from './configFile';

/**
 * @description The Jira connector's configuration (Jira connector plan J4,
 * D10/D11/D16, R4/R9): `DATA_DIR/jira.json`, `${VAR}` placeholders expanded from
 * the environment (the secrets stay in the instance's env file, never in the
 * JSON). Validation names the field that is wrong and never echoes a value.
 */

/** Poll interval bounds and default, seconds (D13). */
export const jiraPollIntervalMinSeconds = 10;
export const jiraPollIntervalMaxSeconds = 600;
export const jiraPollIntervalDefaultSeconds = 90;
/** Requests per issue per rolling 24 h (D12). */
export const jiraRunBudgetDefault = 5;

/** The Claude backends a Jira project may use (D16); OpenCode is refused (R4). */
const jiraAdapterNames = [claudeJsonStreamAdapterName, 'claude'] as const;
const openCodeAdapterName = 'opencode';

/** A Jira Cloud site: a bare `<name>.atlassian.net` host — no scheme, port or path. */
const atlassianSiteRe = /^[a-z0-9][a-z0-9-]*\.atlassian\.net$/;
const unexpandedPlaceholderRe = /\$\{([A-Z_][A-Z0-9_]*)\}/;
/** Fixed wording per bind failure: `BindError` messages embed the folder, a value. */
const folderErrorTexts: Record<BindErrorCode, string> = {
  BIND_INVALID_CHARS: 'is empty or holds control characters',
  BIND_NOT_FOUND: 'does not exist under WORK_ROOT',
  BIND_OUTSIDE_ROOT: 'is outside WORK_ROOT',
  BIND_NOT_DIRECTORY: 'is not a directory',
};
/** Hosts the test-only `baseUrl` override may point at. */
const loopbackHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);

const projectSchema = z.object({
  folder: z.string().min(1),
  triggerStatuses: z.array(z.string().min(1)).min(1),
});

const rawConfigSchema = z.object({
  site: z.string().min(1),
  email: z.string().min(1),
  apiToken: z.string().min(1),
  accountId: z.string().min(1),
  projects: z.record(z.string(), projectSchema),
  pollIntervalSeconds: z.number().int().min(jiraPollIntervalMinSeconds).max(jiraPollIntervalMaxSeconds).optional(),
  runBudgetPer24h: z.number().int().min(1).optional(),
  adapter: z.string().min(1).optional(),
  baseUrl: z.string().min(1).optional(),
});

/** @name JiraProjectConfig @description One allowlisted project. */
export interface JiraProjectConfig {
  /** The working folder, a subfolder of `WORK_ROOT` (validated to exist). */
  folder: string;
  /** Status NAMES that make an assigned issue a request; resolved to ids at boot (D11). */
  triggerStatusNames: string[];
}

/** @name JiraConfig @description The validated configuration. */
export interface JiraConfig {
  site: string;
  /** `https://<site>`, or the test-only loopback override. */
  baseUrl: string;
  email: string;
  apiToken: string;
  accountId: string;
  /** The allowlist: project key → its config. */
  projects: ReadonlyMap<string, JiraProjectConfig>;
  pollIntervalMs: number;
  runBudgetPer24h: number;
  adapter: (typeof jiraAdapterNames)[number];
}

export type JiraConfigResult = { ok: true; config: JiraConfig } | { ok: false; errors: string[] };

function checkIsJiraAdapterName(name: string): name is (typeof jiraAdapterNames)[number] {
  return jiraAdapterNames.some((adapterName) => adapterName === name);
}

/** Names of the fields that still hold a `${VAR}` placeholder — a variable the env file does not set. */
function getUnexpandedFields(node: object, pathPrefix: string): string[] {
  const fields: string[] = [];
  for (const [name, value] of Object.entries(node)) {
    const fieldPath = pathPrefix ? `${pathPrefix}.${name}` : name;
    if (typeof value === 'string') {
      const match = unexpandedPlaceholderRe.exec(value);
      if (match) fields.push(`${fieldPath} (\${${match[1]}} is not set)`);
    } else if (value !== null && typeof value === 'object') {
      fields.push(...getUnexpandedFields(value, fieldPath));
    }
  }
  return fields;
}

/** The test-only override: http(s) on a loopback host, else an error. */
function getBaseUrlError(baseUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return 'baseUrl is not a URL';
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !loopbackHosts.has(url.hostname)) {
    return 'baseUrl is a test-only override and must point at a loopback host';
  }
  return null;
}

/**
 * @description R9: a Jira instance must not share the default OpenCode server —
 * every other instance on the host (another bot's included) uses it by default,
 * and an OpenCode start may stop a stale server it finds on that port.
 */
export function getOpenCodeIsolationError(openCodeUrl: string | undefined): string | null {
  let port: string;
  try {
    port = getOpenCodePort(new URL(openCodeUrl || defaultOpenCodeUrl));
  } catch {
    return 'OPENCODE_URL is not a URL';
  }
  if (port === getOpenCodePort(new URL(defaultOpenCodeUrl))) {
    return `OPENCODE_URL must name a port of its own, not the default ${defaultOpenCodeUrl} other instances use`;
  }
  return null;
}

/**
 * @description Validate an already-parsed `jira.json` object against the rules
 * of plan J4. `workRoot` resolves each project's folder; `openCodeUrl` is the
 * instance's `OPENCODE_URL`.
 */
export function validateJiraConfig(
  parsedJson: object,
  context: { workRoot: string; openCodeUrl: string | undefined },
): JiraConfigResult {
  const expanded = expandEnvVars(parsedJson);
  const errors = getUnexpandedFields(expanded, '').map((field) => `jira.json ${field}`);
  const parsed = rawConfigSchema.safeParse(expanded);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      errors.push(`jira.json ${issue.path.join('.') || '(root)'}: ${issue.message}`);
    }
    return { ok: false, errors };
  }
  const raw = parsed.data;
  if (!atlassianSiteRe.test(raw.site)) errors.push('jira.json site must be a bare <name>.atlassian.net host');
  if (raw.baseUrl !== undefined) {
    const baseUrlError = getBaseUrlError(raw.baseUrl);
    if (baseUrlError) errors.push(`jira.json ${baseUrlError}`);
  }
  const adapterName = raw.adapter ?? claudeJsonStreamAdapterName;
  if (adapterName === openCodeAdapterName) {
    errors.push('jira.json adapter: OpenCode is not available for a Jira project (it cannot be isolated yet)');
  } else if (!checkIsJiraAdapterName(adapterName)) {
    errors.push(`jira.json adapter must be one of ${jiraAdapterNames.join(', ')}`);
  }
  const openCodeError = getOpenCodeIsolationError(context.openCodeUrl);
  if (openCodeError) errors.push(openCodeError);

  const projects = new Map<string, JiraProjectConfig>();
  const projectEntries = Object.entries(raw.projects);
  if (projectEntries.length === 0) errors.push('jira.json projects names no project');
  for (const [projectKey, project] of projectEntries) {
    if (!checkIsJiraProjectKey(projectKey)) {
      errors.push(`jira.json projects.${projectKey}: not a Jira project key`);
      continue;
    }
    try {
      validateSubdir(context.workRoot, project.folder);
    } catch (e) {
      const reason = e instanceof BindError ? folderErrorTexts[e.code] : 'cannot be resolved';
      errors.push(`jira.json projects.${projectKey}.folder: ${reason}`);
      continue;
    }
    projects.set(projectKey, { folder: project.folder, triggerStatusNames: project.triggerStatuses });
  }

  if (errors.length > 0 || !checkIsJiraAdapterName(adapterName)) return { ok: false, errors };
  return {
    ok: true,
    config: {
      site: raw.site,
      baseUrl: raw.baseUrl ?? `https://${raw.site}`,
      email: raw.email,
      apiToken: raw.apiToken,
      accountId: raw.accountId,
      projects,
      pollIntervalMs: (raw.pollIntervalSeconds ?? jiraPollIntervalDefaultSeconds) * 1000,
      runBudgetPer24h: raw.runBudgetPer24h ?? jiraRunBudgetDefault,
      adapter: adapterName,
    },
  };
}

/** @description Read and validate `DATA_DIR/jira.json`. */
export function loadJiraConfig(context: { dataDir: string; workRoot: string; openCodeUrl: string | undefined }): JiraConfigResult {
  const configPath = getJiraConfigPath(context.dataDir);
  let text: string;
  try {
    text = fs.readFileSync(configPath, 'utf8');
  } catch {
    return { ok: false, errors: [`cannot read ${configPath}`] };
  }
  let parsedJson: object;
  try {
    const value: object | null = JSON.parse(text);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, errors: [`${configPath} must hold a JSON object`] };
    }
    parsedJson = value;
  } catch {
    return { ok: false, errors: [`${configPath} is not valid JSON`] };
  }
  return validateJiraConfig(parsedJson, context);
}

/** @name JiraProjectStatus @description A status as `GET /project/{key}/statuses` lists it. */
export interface JiraProjectStatus {
  id: string;
  name: string;
}

/**
 * @description Resolve a project's trigger status NAMES to the ids changelog
 * items carry (D11): matched case-insensitively against every status the
 * project's workflows list. A name the project does not have is an error, so a
 * typo never silently disables the trigger.
 */
export function resolveTriggerStatusIds(
  projectKey: string,
  statusNames: readonly string[],
  projectStatuses: readonly JiraProjectStatus[],
): { ok: true; statusIds: string[] } | { ok: false; error: string } {
  const idsByName = new Map<string, string>();
  for (const status of projectStatuses) idsByName.set(status.name.toLowerCase(), status.id);
  const missing = statusNames.filter((name) => !idsByName.has(name.toLowerCase()));
  if (missing.length > 0) {
    return { ok: false, error: `project ${projectKey} has no status named ${missing.map((name) => `"${name}"`).join(', ')}` };
  }
  const statusIds = statusNames.flatMap((name) => {
    const statusId = idsByName.get(name.toLowerCase());
    return statusId === undefined ? [] : [statusId];
  });
  return { ok: true, statusIds: [...new Set(statusIds)] };
}
