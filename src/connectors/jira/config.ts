import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { expandEnvVars } from '../../mcpConfig';
import { BindError, validateSubdir, type BindErrorCode } from '../../validation';
import { defaultOpenCodeUrl, getOpenCodePort } from '../../installManager';
import { claudeJsonStreamAdapterName, claudePerTurnAdapterName, checkIsJsonStreamBackend } from '../../adapters/adapterNames';
import { claudeEffortLevels, type ClaudeEffortLevel } from '../../effortLevels';
import { checkIsJiraProjectKey } from './sessionKeyCodec';
import { getJiraConfigPath } from './configFile';
import type { JiraFieldDefinition, JiraProjectStatus } from './client';
import type { JiraExtraField } from './issueBlocks';

/**
 * @description The Jira connector's configuration (Jira connector plan J4,
 * D10/D11/D16, R4/R9; J4b R12/R14/R15): `DATA_DIR/jira.json`, `${VAR}` placeholders expanded from
 * the environment (the secrets stay in the instance's env file, never in the
 * JSON). Validation names the field that is wrong and never echoes a value.
 */

/** Poll interval bounds and default, seconds (D13). */
export const jiraPollIntervalMinSeconds = 10;
export const jiraPollIntervalMaxSeconds = 600;
export const jiraPollIntervalDefaultSeconds = 90;
/** Requests per issue per rolling 24 h (D12). */
export const jiraRunBudgetDefault = 5;
/** What a Jira session runs on when `jira.json` names neither (C14); either key still overrides its own default. */
export const jiraDefaultModel = 'opus';
export const jiraDefaultEffort: ClaudeEffortLevel = 'high';

/** The backend a Jira session runs on by default (D16, R14); `claude-per-turn` is the other allowed one (L-D12). */
const jiraAdapterName = claudeJsonStreamAdapterName;
/** The json-stream host, under either lifecycle — no TUI trust dialog (R14). */
export type JiraAdapterName = typeof claudeJsonStreamAdapterName | typeof claudePerTurnAdapterName;
/** Backends refused for a Jira project, each with its reason. */
const refusedAdapterReasons: ReadonlyMap<string, string> = new Map([
  ['opencode', 'OpenCode is not available for a Jira project (it cannot be isolated yet)'],
  ['claude', 'the tmux Claude backend is not available for a Jira project (its folder-trust dialog would hold the session)'],
]);

/**
 * What Claude Code loads as project memory from the working folder AND every
 * folder above it (R12): any of these above a Jira folder brings someone's
 * instructions into the session — under HOME that is the operator's own setup.
 */
export const claudeMemoryMarkerNames = ['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', '.claude'] as const;

/** A model name as `claude --model` takes it (`opus`, `claude-opus-5-5`, `opus[1m]`). */
const claudeModelRe = /^[A-Za-z0-9][A-Za-z0-9._:/[\]-]*$/;
const claudeModelMaxLength = 100;

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
/** A tool's name on the agent's PATH: ONE file name (never `.` or `..`, never a path). */
const agentBinaryNameRe = /^(?!\.{1,2}$)[A-Za-z0-9._-]+$/;
/** Hosts the test-only `baseUrl` override may point at. */
const loopbackHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);

// Strict: a misspelled key (`adaptor`, `pollIntervalSecond`) is an error, never a silently applied default.
const projectSchema = z.strictObject({
  folder: z.string().min(1),
  triggerStatuses: z.array(z.string().min(1)).min(1),
  // Fields beyond the standard ones the prompt shows, by id (`customfield_10042`, `duedate`); none by default (C11).
  // Whether the site has the field is checked at boot against its field list, never refused here.
  extraFields: z.array(z.string().min(1)).optional(),
});

const rawConfigSchema = z.strictObject({
  site: z.string().min(1),
  email: z.string().min(1),
  apiToken: z.string().min(1),
  accountId: z.string().min(1),
  projects: z.record(z.string(), projectSchema),
  pollIntervalSeconds: z.number().int().min(jiraPollIntervalMinSeconds).max(jiraPollIntervalMaxSeconds).optional(),
  runBudgetPer24h: z.number().int().min(1).optional(),
  adapter: z.string().min(1).optional(),
  // R15: user settings no longer apply in a Jira session, so its model and effort come from here.
  model: z.string().max(claudeModelMaxLength).regex(claudeModelRe, 'must be a model name like opus or claude-opus-5-5').optional(),
  effort: z.enum(claudeEffortLevels).optional(),
  baseUrl: z.string().min(1).optional(),
  // C11: tools the agent should find on its PATH (`ffmpeg`): name → absolute path of the program.
  agentBinaries: z.record(z.string().regex(agentBinaryNameRe, 'must be one file name'), z.string().min(1)).optional(),
});

/** @name JiraProjectConfig @description One allowlisted project. */
export interface JiraProjectConfig {
  /** The working folder relative to `WORK_ROOT`, canonical (validated to exist), as a binding stores it. */
  folder: string;
  /** Status NAMES that make an assigned issue a request; resolved to ids at boot (D11). */
  triggerStatusNames: string[];
  /** Ids of the extra fields the prompt shows; resolved to names at boot, an unknown one dropped. */
  extraFieldIds: string[];
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
  adapter: JiraAdapterName;
  /** The sessions' model; absent from `jira.json` → {@link jiraDefaultModel}. */
  model: string;
  /** The sessions' reasoning effort; absent from `jira.json` → {@link jiraDefaultEffort}. */
  effort: ClaudeEffortLevel;
  /** Tool name → absolute path of an executable, checked at boot; linked into the agents' PATH (host runtime). */
  agentBinaries: ReadonlyMap<string, string>;
}

export type JiraConfigResult = { ok: true; config: JiraConfig } | { ok: false; errors: string[] };

/** Why `binaryPath` cannot serve as a tool, or `null`: it must be an absolute path to an executable regular file. */
function getAgentBinaryError(binaryPath: string): string | null {
  if (!path.isAbsolute(binaryPath)) return 'must be an absolute path';
  try {
    if (!fs.statSync(binaryPath).isFile()) return 'is not a file';
    fs.accessSync(binaryPath, fs.constants.X_OK);
  } catch (e) {
    return e instanceof Error && 'code' in e && e.code === 'ENOENT' ? 'does not exist' : 'is not executable';
  }
  return null;
}

/**
 * @description R12: the marker of Claude memory nearest a folder — in the folder
 * itself or any folder above it, up to the filesystem root — with how many
 * levels up it was found; `null` when the ancestry is clean.
 */
export function getClaudeMemoryAbove(folderPath: string): { markerName: string; levelsUp: number } | null {
  let current = path.resolve(folderPath);
  for (let levelsUp = 0; ; levelsUp += 1) {
    const markerName = claudeMemoryMarkerNames.find((name) => fs.existsSync(path.join(current, name)));
    if (markerName) return { markerName, levelsUp };
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
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
  const adapterName = raw.adapter ?? jiraAdapterName;
  const refusedReason = refusedAdapterReasons.get(adapterName);
  if (refusedReason) {
    errors.push(`jira.json adapter: ${refusedReason}`);
  } else if (!checkIsJsonStreamBackend(adapterName)) {
    errors.push(`jira.json adapter must be ${jiraAdapterName} or ${claudePerTurnAdapterName}`);
  }
  const openCodeError = getOpenCodeIsolationError(context.openCodeUrl);
  if (openCodeError) errors.push(openCodeError);

  const agentBinaries = new Map<string, string>();
  for (const [name, binaryPath] of Object.entries(raw.agentBinaries ?? {})) {
    const binaryError = getAgentBinaryError(binaryPath);
    if (binaryError) errors.push(`jira.json agentBinaries.${name}: ${binaryError}`);
    else agentBinaries.set(name, binaryPath);
  }

  const projects = new Map<string, JiraProjectConfig>();
  const projectEntries = Object.entries(raw.projects);
  if (projectEntries.length === 0) errors.push('jira.json projects names no project');
  for (const [projectKey, project] of projectEntries) {
    if (!checkIsJiraProjectKey(projectKey)) {
      errors.push(`jira.json projects.${projectKey}: not a Jira project key`);
      continue;
    }
    let folder: string;
    try {
      folder = validateSubdir(context.workRoot, project.folder);
    } catch (e) {
      const reason = e instanceof BindError ? folderErrorTexts[e.code] : 'cannot be resolved';
      errors.push(`jira.json projects.${projectKey}.folder: ${reason}`);
      continue;
    }
    const memory = getClaudeMemoryAbove(path.join(fs.realpathSync(context.workRoot), folder));
    if (memory) {
      const where = memory.levelsUp === 0 ? 'in it' : `${memory.levelsUp} folder(s) above it`;
      errors.push(`jira.json projects.${projectKey}.folder: Claude would load ${memory.markerName} found ${where} — pick a folder outside HOME and any repository`);
      continue;
    }
    projects.set(projectKey, { folder, triggerStatusNames: project.triggerStatuses, extraFieldIds: [...new Set(project.extraFields ?? [])] });
  }

  if (errors.length > 0) return { ok: false, errors };
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
      adapter: adapterName === claudePerTurnAdapterName ? claudePerTurnAdapterName : jiraAdapterName,
      model: raw.model ?? jiraDefaultModel,
      effort: raw.effort ?? jiraDefaultEffort,
      agentBinaries,
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

/**
 * @description Resolve a project's trigger status NAMES to the ids changelog
 * items carry (D11): matched case-insensitively against every status the
 * project's workflows list. A name the project does not have is an error, so a
 * typo never silently disables the trigger; a name several statuses share
 * (one per issue type's workflow) yields all their ids.
 */
export function resolveTriggerStatusIds(
  projectKey: string,
  statusNames: readonly string[],
  projectStatuses: readonly JiraProjectStatus[],
): { ok: true; statusIds: string[] } | { ok: false; error: string } {
  const idsByName = new Map<string, string[]>();
  for (const status of projectStatuses) {
    const name = status.name.toLowerCase();
    idsByName.set(name, [...(idsByName.get(name) ?? []), status.id]);
  }
  const missing = statusNames.filter((name) => !idsByName.has(name.toLowerCase()));
  if (missing.length > 0) {
    return { ok: false, error: `project ${projectKey} has no status named ${missing.map((name) => `"${name}"`).join(', ')}` };
  }
  const statusIds = statusNames.flatMap((name) => idsByName.get(name.toLowerCase()) ?? []);
  return { ok: true, statusIds: [...new Set(statusIds)] };
}

/**
 * @description Name a project's `extraFields` ids from the site's field list. An
 * id the site does not list is `unknown`: the connector logs it once at boot and
 * leaves it out of every prompt (C11) — a typo must not stop the whole instance.
 */
export function resolveExtraFields(
  extraFieldIds: readonly string[],
  fieldDefinitions: readonly JiraFieldDefinition[],
): { extraFields: JiraExtraField[]; unknownFieldIds: string[] } {
  const nameById = new Map(fieldDefinitions.map((definition) => [definition.id, definition.name]));
  const extraFields: JiraExtraField[] = [];
  const unknownFieldIds: string[] = [];
  for (const id of extraFieldIds) {
    const name = nameById.get(id);
    if (name === undefined) unknownFieldIds.push(id);
    else extraFields.push({ id, name });
  }
  return { extraFields, unknownFieldIds };
}
