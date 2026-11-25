/**
 * @description The screens of `/workers` (the bot's default CLI, model and effort per worker role, `utils/workerRoles.ts`) as pure
 * data: the overview, a role's screen, the OpenCode provider list, the warnings, and the codec of every button. The words come from
 * the caller's locale (`t`); the setting, the OpenCode catalog and the variants come from the caller too, so every rule is
 * unit-tested. The command is `connectors/telegram/commands/workerRoles.ts`.
 *
 * A REPEATED-USE screen: every tap writes and re-renders in place. A Claude model or effort button carries its value in the data
 * (a stale keyboard still means what it says); an OpenCode button carries an INDEX into the list the command remembered for that
 * message (a provider, a model, a variant), so an old keyboard is refused instead of picking another model.
 */

import { t } from '../i18n';
import { claudeWorkerEffortLevels, type ClaudeWorkerEffortLevel } from '../effortLevels';
import { fallbackClaudeModelAliases, listOpenCodeProviders, parseOpenCodeModelLabel } from './fallbackChain';
import { getModelShortLabel } from './modelPickerPlan';
import { checkHasChangedWorkerRole, resolveWorkerRole, workerRoleIds, type WorkerRoleId, type WorkerRoleValue, type WorkerRolesSetting } from './workerRoles';

/** A button's caption and the data it carries. */
export interface WorkerRolesButton {
  label: string;
  data: string;
}

/** A screen: the message and its buttons, row by row. */
export interface WorkerRolesScreen {
  text: string;
  rows: WorkerRolesButton[][];
}

const callbackPrefix = 'wkr_';
const currentMark = ' ✓';
const warningMark = '⚠️ ';
/** Effort and variant buttons per row: three fit a phone's width. */
const effortButtonsPerRow = 3;
/** Claude model buttons per row: the four aliases in one row. */
const claudeModelButtonsPerRow = 4;

// ── the codec ──

/**
 * What a button asks for. `role` is the role's index in {@link workerRoleIds}; `index` points into the list the command remembered
 * for the message (providers, a provider's models, a model's variants).
 */
export type WorkerRolesTap =
  | { kind: 'overview' }
  | { kind: 'allBuiltIn' }
  | { kind: 'role'; role: WorkerRoleId }
  | { kind: 'roleBuiltIn'; role: WorkerRoleId }
  | { kind: 'claudeModel'; role: WorkerRoleId; model: string }
  | { kind: 'claudeEffort'; role: WorkerRoleId; effort: ClaudeWorkerEffortLevel }
  | { kind: 'openCodeProviders'; role: WorkerRoleId }
  | { kind: 'openCodeProvider'; role: WorkerRoleId; index: number }
  | { kind: 'openCodeModelPage'; role: WorkerRoleId; page: number }
  | { kind: 'openCodeModel'; role: WorkerRoleId; index: number }
  | { kind: 'openCodeVariant'; role: WorkerRoleId; index: number }
  | { kind: 'openCodeNoVariant'; role: WorkerRoleId };

/** Matches every button of the screens (and nothing else). */
export const workerRolesCallbackRe = /^wkr_(o|all|r\d|x\d|oc\d|n\d|m\d_[a-z][a-z0-9._-]{0,31}|e\d_[a-z]+|p\d_\d{1,3}|pg\d_\d{1,3}|k\d_\d{1,3}|v\d_\d{1,3})$/;

/** @description The data of the button for `tap`. */
export function buildWorkerRolesCallbackData(tap: WorkerRolesTap): string {
  const roleIndex = (role: WorkerRoleId): number => workerRoleIds.indexOf(role);
  switch (tap.kind) {
    case 'overview': return `${callbackPrefix}o`;
    case 'allBuiltIn': return `${callbackPrefix}all`;
    case 'role': return `${callbackPrefix}r${roleIndex(tap.role)}`;
    case 'roleBuiltIn': return `${callbackPrefix}x${roleIndex(tap.role)}`;
    case 'claudeModel': return `${callbackPrefix}m${roleIndex(tap.role)}_${tap.model}`;
    case 'claudeEffort': return `${callbackPrefix}e${roleIndex(tap.role)}_${tap.effort}`;
    case 'openCodeProviders': return `${callbackPrefix}oc${roleIndex(tap.role)}`;
    case 'openCodeProvider': return `${callbackPrefix}p${roleIndex(tap.role)}_${tap.index}`;
    case 'openCodeModelPage': return `${callbackPrefix}pg${roleIndex(tap.role)}_${tap.page}`;
    case 'openCodeModel': return `${callbackPrefix}k${roleIndex(tap.role)}_${tap.index}`;
    case 'openCodeVariant': return `${callbackPrefix}v${roleIndex(tap.role)}_${tap.index}`;
    case 'openCodeNoVariant': return `${callbackPrefix}n${roleIndex(tap.role)}`;
  }
}

/** @description What `data` asks for; `null` for anything that is no button of the screens (an unknown role, model or effort). */
export function parseWorkerRolesCallbackData(data: string): WorkerRolesTap | null {
  const match = workerRolesCallbackRe.exec(data);
  if (match === null) return null;
  const body = match[1];
  if (body === 'o') return { kind: 'overview' };
  if (body === 'all') return { kind: 'allBuiltIn' };
  const parts = /^([a-z]+)(\d)(?:_(.+))?$/.exec(body);
  if (parts === null) return null;
  const [, verb, roleDigit, argument] = parts;
  const role = workerRoleIds[Number(roleDigit)];
  if (role === undefined) return null;
  const index = argument === undefined ? Number.NaN : Number(argument);
  switch (verb) {
    case 'r': return { kind: 'role', role };
    case 'x': return { kind: 'roleBuiltIn', role };
    case 'oc': return { kind: 'openCodeProviders', role };
    case 'n': return { kind: 'openCodeNoVariant', role };
    case 'm': return argument !== undefined && fallbackClaudeModelAliases.includes(argument) ? { kind: 'claudeModel', role, model: argument } : null;
    case 'e': {
      const effort = claudeWorkerEffortLevels.find((level) => level === argument);
      return effort === undefined ? null : { kind: 'claudeEffort', role, effort };
    }
    case 'p': return { kind: 'openCodeProvider', role, index };
    case 'pg': return { kind: 'openCodeModelPage', role, page: index };
    case 'k': return { kind: 'openCodeModel', role, index };
    case 'v': return { kind: 'openCodeVariant', role, index };
    default: return null;
  }
}

// ── the words ──

/** @description The role's name in the caller's language (`Builder`, `Reviewer`, …). */
export function formatWorkerRoleName(role: WorkerRoleId): string {
  return t(`workerRoles.role.${role}`);
}

/** A Claude alias as a button shows it (`opus` → `Opus`); any other id as it is. */
function formatClaudeModel(model: string): string {
  return fallbackClaudeModelAliases.includes(model) ? `${model.charAt(0).toUpperCase()}${model.slice(1)}` : model;
}

/** The model id of an OpenCode `provider/model` without its provider, as the model page shortens it. */
function formatOpenCodeModel(model: string): string {
  const parsed = parseOpenCodeModelLabel(model);
  return parsed === null ? model : getModelShortLabel(parsed.modelId, parsed.providerId);
}

/** @description A role's value in words: `Opus · medium`, `OpenCode · gpt-6-astra · medium` (`model's default` without a variant). */
export function formatWorkerRoleValue(value: WorkerRoleValue): string {
  if (value.cli === 'claude') return `${formatClaudeModel(value.model)} · ${value.effort}`;
  return `${t('fallback.backendOpenCode')} · ${formatOpenCodeModel(value.model)} · ${value.effort ?? t('workerRoles.modelDefault')}`;
}

/** Why an OpenCode role cannot run now, judged by a catalog that was read: its provider is not connected, or its model is gone. */
type OpenCodeRoleProblem = 'providerMissing' | 'modelMissing';

function getOpenCodeRoleProblem(value: WorkerRoleValue, openCodeModels: readonly string[] | null): OpenCodeRoleProblem | null {
  if (value.cli !== 'opencode' || openCodeModels === null || openCodeModels.length === 0 || openCodeModels.includes(value.model)) return null;
  const parsed = parseOpenCodeModelLabel(value.model);
  return parsed !== null && listOpenCodeProviders(openCodeModels).includes(parsed.providerId) ? 'modelMissing' : 'providerMissing';
}

function buildOpenCodeRoleWarning(role: WorkerRoleId, value: WorkerRoleValue, problem: OpenCodeRoleProblem): string {
  const roleName = formatWorkerRoleName(role);
  if (problem === 'modelMissing') return t('workerRoles.modelMissingWarning', { role: roleName, model: formatOpenCodeModel(value.model) });
  return t('workerRoles.providerMissingWarning', { role: roleName, provider: parseOpenCodeModelLabel(value.model)?.providerId ?? value.model });
}

// ── the screens ──

/** What the overview is built from. */
export interface WorkerRolesOverviewInput {
  setting: WorkerRolesSetting;
  /** The OpenCode catalog (`provider/model`); `null` or empty when it was not read — then no role is warned about. */
  openCodeModels: readonly string[] | null;
  /** The bot-wide «Bot skills» value: off → agents may not ask the bot for these values. */
  isBotSkillsEnabled: boolean;
}

/**
 * @description The overview: the title, what the values mean, that a running worker keeps its own, a warning per OpenCode role that
 * cannot run and one when the bot's skills are off; a button per role with its value (⚠️ on a role that cannot run), and «All to
 * built-in values» only when a role differs.
 */
export function buildWorkerRolesOverview(input: WorkerRolesOverviewInput): WorkerRolesScreen {
  const warnings: string[] = [];
  const rows: WorkerRolesButton[][] = workerRoleIds.map((role) => {
    const { value } = resolveWorkerRole(input.setting, role);
    const problem = getOpenCodeRoleProblem(value, input.openCodeModels);
    if (problem !== null) warnings.push(buildOpenCodeRoleWarning(role, value, problem));
    const label = t('workerRoles.roleRow', { role: formatWorkerRoleName(role), value: formatWorkerRoleValue(value) });
    return [{ label: `${problem === null ? '' : warningMark}${label}`, data: buildWorkerRolesCallbackData({ kind: 'role', role }) }];
  });
  if (!input.isBotSkillsEnabled) warnings.push(t('workerRoles.skillsOffWarning'));
  if (checkHasChangedWorkerRole(input.setting)) rows.push([{ label: t('workerRoles.allBuiltInButton'), data: buildWorkerRolesCallbackData({ kind: 'allBuiltIn' }) }]);
  const text = [t('workerRoles.title'), t('workerRoles.explanationText'), t('workerRoles.runningWorkerNote'), ...warnings].join('\n\n');
  return { text, rows };
}

/** What a role's screen is built from. */
export interface WorkerRoleScreenInput {
  role: WorkerRoleId;
  setting: WorkerRolesSetting;
  /** The OpenCode catalog; the «OpenCode model…» row is offered only when it lists a model (or the role already runs on OpenCode). */
  openCodeModels: readonly string[] | null;
  /** The variants of the role's OpenCode model, in the order the variant buttons index; ignored for a Claude role. */
  variants: readonly string[];
}

/** `items` cut into rows of `size`. */
function splitIntoRows<TItem>(items: readonly TItem[], size: number): TItem[][] {
  const rows: TItem[][] = [];
  for (let start = 0; start < items.length; start += size) rows.push(items.slice(start, start + size));
  return rows;
}

/**
 * @description A role's screen: its name, what it covers, the value now («(built-in)» while nobody changed it) and that the user's
 * own instructions win; the Claude models, the OpenCode row, the efforts (a Claude role) or «model's default» and the model's variants
 * (an OpenCode role, none when it has none), then «Built-in» (only when the role differs) and «Back».
 */
export function buildWorkerRoleScreen(input: WorkerRoleScreenInput): WorkerRolesScreen {
  const { role } = input;
  const { value, isBuiltIn } = resolveWorkerRole(input.setting, role);
  const valueWords = formatWorkerRoleValue(value);
  const text = [
    t('workerRoles.roleTitle', { role: formatWorkerRoleName(role) }),
    t(`workerRoles.roleDescription.${role}`),
    `${t('workerRoles.nowLine', { value: isBuiltIn ? t('workerRoles.builtInMark', { value: valueWords }) : valueWords })}\n${t('workerRoles.ownInstructionsWin')}`,
  ].join('\n\n');
  const mark = (isCurrent: boolean): string => (isCurrent ? currentMark : '');
  const modelButtons = fallbackClaudeModelAliases.map((model) => ({
    label: `${formatClaudeModel(model)}${mark(value.cli === 'claude' && value.model === model)}`,
    data: buildWorkerRolesCallbackData({ kind: 'claudeModel', role, model }),
  }));
  const rows: WorkerRolesButton[][] = splitIntoRows(modelButtons, claudeModelButtonsPerRow);
  const hasOpenCodeModels = input.openCodeModels !== null && input.openCodeModels.length > 0;
  if (value.cli === 'opencode') {
    rows.push([{ label: t('workerRoles.openCodeCurrentButton', { model: formatOpenCodeModel(value.model) }), data: buildWorkerRolesCallbackData({ kind: 'openCodeProviders', role }) }]);
  } else if (hasOpenCodeModels) {
    rows.push([{ label: t('workerRoles.openCodeButton'), data: buildWorkerRolesCallbackData({ kind: 'openCodeProviders', role }) }]);
  }
  if (value.cli === 'claude') {
    const effortButtons = claudeWorkerEffortLevels.map((effort) => ({ label: `${effort}${mark(value.effort === effort)}`, data: buildWorkerRolesCallbackData({ kind: 'claudeEffort', role, effort }) }));
    rows.push(...splitIntoRows(effortButtons, effortButtonsPerRow));
  } else {
    rows.push(...buildOpenCodeEffortRows(role, value.effort, input.variants));
  }
  const backRow: WorkerRolesButton[] = [];
  if (!isBuiltIn) backRow.push({ label: t('workerRoles.roleBuiltInButton'), data: buildWorkerRolesCallbackData({ kind: 'roleBuiltIn', role }) });
  backRow.push({ label: t('workerRoles.backButton'), data: buildWorkerRolesCallbackData({ kind: 'overview' }) });
  rows.push(backRow);
  return { text, rows };
}

/**
 * The effort rows of an OpenCode role: «model's default» (no variant: the model's own) on a row of its own — the words do not fit a
 * third of a phone's width — then the model's variants (indexes into `variants`), the one in force marked ✓. None when the model has no
 * variants: there is nothing to choose.
 */
function buildOpenCodeEffortRows(role: WorkerRoleId, effort: string | null, variants: readonly string[]): WorkerRolesButton[][] {
  if (variants.length === 0) return [];
  const mark = (isCurrent: boolean): string => (isCurrent ? currentMark : '');
  const variantButtons = variants.map((variant, index) => ({ label: `${variant}${mark(effort === variant)}`, data: buildWorkerRolesCallbackData({ kind: 'openCodeVariant', role, index }) }));
  return [
    [{ label: `${t('workerRoles.modelDefault')}${mark(effort === null)}`, data: buildWorkerRolesCallbackData({ kind: 'openCodeNoVariant', role }) }],
    ...splitIntoRows(variantButtons, effortButtonsPerRow),
  ];
}

/** @description The OpenCode providers a role may pick from (the catalog's, in its order), each button an index into `providers`, then «Back» to the role. */
export function buildWorkerRoleProvidersScreen(role: WorkerRoleId, providers: readonly string[]): WorkerRolesScreen {
  const rows: WorkerRolesButton[][] = providers.map((providerId, index) => [{ label: providerId, data: buildWorkerRolesCallbackData({ kind: 'openCodeProvider', role, index }) }]);
  rows.push([{ label: t('workerRoles.backButton'), data: buildWorkerRolesCallbackData({ kind: 'role', role }) }]);
  return { text: t('workerRoles.providersTitle', { role: formatWorkerRoleName(role) }), rows };
}

/** @description The title of a provider's model page for a role (`🛠 Reviewer · openai`). */
export function buildWorkerRoleModelsTitle(role: WorkerRoleId, providerId: string): string {
  return t('workerRoles.modelsTitle', { role: formatWorkerRoleName(role), provider: providerId });
}

// ── the moves ──

/**
 * @description The value after a Claude model tap: the model changes, the effort stays when it is a Claude launch level (an
 * OpenCode role's variant may not be one), else the role's built-in effort when that is Claude's, else `medium`.
 */
export function getValueAfterClaudeModelPick(current: WorkerRoleValue, builtIn: WorkerRoleValue, model: string): WorkerRoleValue {
  const keep = claudeWorkerEffortLevels.find((level) => level === current.effort);
  const fallback = builtIn.cli === 'claude' ? builtIn.effort : 'medium';
  return { cli: 'claude', model, effort: keep ?? fallback };
}

/** @description The value after an OpenCode model pick: the model changes, the effort stays when the new model offers it as a variant, else none. */
export function getValueAfterOpenCodeModelPick(current: WorkerRoleValue, model: string, variants: readonly string[]): WorkerRoleValue {
  return { cli: 'opencode', model, effort: current.effort !== null && variants.includes(current.effort) ? current.effort : null };
}
