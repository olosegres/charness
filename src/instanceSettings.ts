import * as os from 'os';
import { z } from 'zod';
import {
  createConfigFileLoader,
  getCaughtErrnoCode,
  getConfigDirFilePath,
  writeJsonFileAtomically,
  type ConfigFileLoad,
  type ConfigValidation,
} from './configDirFile';
import { claudeEffortLevels, claudeWorkerEffortLevels, type ClaudeEffortLevel } from './effortLevels';
import { claudeModelAliasRe, openCodeProviderIdRe } from './utils/fallbackChain';
import { workerRoleIds, type WorkerRoleId, type WorkerRoleValue, type WorkerRolesSetting } from './utils/workerRoles';
import { botSkillsSettingValues, type BotSkillsSetting } from './utils/botSkillsSetting';
import { taskAgentsMaxConcurrentUpperBound } from './trackers/taskAgentLimit';
import { hubHostSchema, hubPortSchema } from './runners/hubIds';
import type { HubAddress } from './runners/hubAddress';
import { autoUpdateModes, defaultAutoUpdateMode, defaultWhatsNew, type AutoUpdateMode, type UpdateSettings } from './selfUpdate/updateModes';
import { checkIsLimitReminderChoice, limitReminderChoices, type LimitReminderChoice } from './limitNotes/reminderChoices';
import { todoReminderDefaultMinutes, type TodoReminderSettings } from './todos/nag';
import { questionWaitChoices, type QuestionWaitChoice } from './utils/questionWaitChoices';
import type { TopicStatusPrefs } from './utils/topicIndicatorPlan';

/**
 * @description The instance-wide settings: ONE JSON file, `settings.json`, in the charness config directory
 * (beside the instance's real `.env`, like `stt.json`). `/effort` in the General topic writes it; an operator may
 * hand-edit it and the next read sees the edit (the load is cached by file stamp, no restart). More instance
 * settings will move here later; today it holds `defaultEffort`, `autoUpdate`, `whatsNew`, `botSkills` (whether the bot's
 * own skills reach the agents: the way an instance without General sets it), `taskAgents` (the cap on tracker task agents
 * running at once — the way an instance without General sets it), `questionWait` (how long an unanswered agent question waits before it is set aside — the instance default a topic's own choice overrides), `topicStatus` (which status marks and counts the topic list shows after a topic's name — the instance default a topic's own set overrides), `todo` (the shared todo lists: on / off and the
 * staleness reminder's interval — also the way an instance without General sets them), `limitReminders` (how often an agent
 * that launches workers is told where the account limits stand: General's interval, the one a topic's own choice overrides) and
 * `runnerHost` (the address paired runners dial, chosen once in `/runners`) and `workerRoles` (the bot's default CLI, model and
 * effort per worker role, `/workers` — only the roles the operator changed, `utils/workerRoles.ts`).
 *
 * Validation is strict and all-or-nothing, like `stt.json`: a typo is an error that NAMES the field. Unlike
 * `stt.json`, an invalid file is NOT served from its last good copy — the built-in defaults apply and one error
 * line says why, so what runs is what the file visibly says or what the code says, never a stale third thing.
 */

/** The file in the config dir. */
export const instanceSettingsFileName = 'settings.json';

/** Not secret: readable by the group, like any config file. */
const settingsFileMode = 0o644;

/** @name InstanceSettings @description The whole of `settings.json`; `null` = not set, the built-in default applies. */
export interface InstanceSettings {
  /** The reasoning effort of every topic that has no `/effort` pick of its own (see `getInstanceDefaultEffort`). */
  defaultEffort: ClaudeEffortLevel | null;
  /** Whether the bot updates itself (`on`), only says a new version is out (`notify`) or never looks (`off`); `null` = `on`. */
  autoUpdate: AutoUpdateMode | null;
  /** Whether the list of changes is posted after a version change; `null` = yes. */
  whatsNew: boolean | null;
  /** The instance default of the «Bot skills» switch (`/bot_skills`) for an instance whose General never chose; `null` = `on`. */
  botSkills: BotSkillsSetting | null;
  /** The question wait of every topic that has none of its own (`utils/questionWaitPlan.ts`): how long an unanswered agent question waits before it is set aside; `null` = the built-in default (30 min). */
  questionWait: QuestionWaitChoice | null;
  /** The switches the owner changed for the status mark after every topic's name that has no set of its own (`utils/topicIndicatorPlan.ts`); a switch it does not name keeps its default. */
  topicStatus: Partial<TopicStatusPrefs>;
  /** The tracker task agents (`trackers/`): `maxConcurrent` is the cap for the whole bot, `0` = no limit; `null` = not set, the built-in default (5). */
  taskAgents: { maxConcurrent: number | null };
  /** The shared todo lists (`todos/`); a field that is `null` = its default (on, a reminder every hour). */
  todo: { isEnabled: boolean | null; reminderMinutes: number | null };
  /** The limit reminders (`limitNotes/`): `everyMinutes` is the interval of every topic that has none of its own (`0` = Off); `null` = not set, the built-in default (1 h). */
  limitReminders: { everyMinutes: LimitReminderChoice | null };
  /** The address paired runners dial to reach this machine's sshd (`/runners` asks once); `null` = not chosen yet. */
  runnerHost: HubAddress | null;
  /** The worker roles the operator changed (`/workers`, `utils/workerRoles.ts`); a role it does not name holds its built-in value. */
  workerRoles: WorkerRolesSetting;
}

/** The longest reminder interval a hand-edited `settings.json` may name: a day. */
const todoReminderMaxMinutes = 24 * 60;

/** The longest OpenCode model id or variant a hand-edited `workerRoles` may name. */
const workerRoleOpenCodePartMaxLength = 128;

/** An OpenCode `provider/model` of a worker role: a provider id, a slash, a bounded model id. */
const workerRoleOpenCodeModelSchema = z.string().max(workerRoleOpenCodePartMaxLength * 2).refine((label) => {
  const index = label.indexOf('/');
  return index > 0 && openCodeProviderIdRe.test(label.slice(0, index)) && label.length - index - 1 > 0 && label.length - index - 1 <= workerRoleOpenCodePartMaxLength;
}, { message: 'must be provider/model (an OpenCode model id)' });

const workerRoleValueSchema = z.discriminatedUnion('cli', [
  z.strictObject({ cli: z.literal('claude'), model: z.string().regex(claudeModelAliasRe, 'must be a Claude model alias (fable, opus, sonnet, haiku) or id'), effort: z.enum(claudeWorkerEffortLevels) }),
  z.strictObject({ cli: z.literal('opencode'), model: workerRoleOpenCodeModelSchema, effort: z.string().min(1).max(workerRoleOpenCodePartMaxLength).optional() }),
]);

/** One optional value per role; `satisfies` keeps the keys in step with `workerRoleIds`. */
const workerRolesSchema = z.strictObject({
  builder: workerRoleValueSchema.optional(),
  storageBuilder: workerRoleValueSchema.optional(),
  investigator: workerRoleValueSchema.optional(),
  reviewer: workerRoleValueSchema.optional(),
  miniReviewer: workerRoleValueSchema.optional(),
  planner: workerRoleValueSchema.optional(),
} satisfies Record<WorkerRoleId, z.ZodOptional<typeof workerRoleValueSchema>>);

/** The stored shape of a role's value: an OpenCode role without a variant leaves `effort` out. */
type StoredWorkerRoleValue = z.infer<typeof workerRoleValueSchema>;

function readStoredWorkerRoles(stored: Partial<Record<WorkerRoleId, StoredWorkerRoleValue | undefined>> | undefined): WorkerRolesSetting {
  const setting: WorkerRolesSetting = {};
  for (const role of workerRoleIds) {
    const value = stored?.[role];
    if (value === undefined) continue;
    setting[role] = value.cli === 'claude' ? value : { cli: 'opencode', model: value.model, effort: value.effort ?? null };
  }
  return setting;
}

function writeStoredWorkerRoleValue(value: WorkerRoleValue): StoredWorkerRoleValue {
  if (value.cli === 'claude') return { cli: 'claude', model: value.model, effort: value.effort };
  return { cli: 'opencode', model: value.model, ...(value.effort === null ? {} : { effort: value.effort }) };
}

const rawSettingsSchema = z.strictObject({
  defaultEffort: z.enum(claudeEffortLevels).optional(),
  autoUpdate: z.enum(autoUpdateModes).optional(),
  whatsNew: z.boolean().optional(),
  botSkills: z.enum(botSkillsSettingValues).optional(),
  questionWait: z.enum(questionWaitChoices).optional(),
  topicStatus: z.strictObject({
    question: z.boolean().optional(),
    stuck: z.boolean().optional(),
    working: z.boolean().optional(),
    finished: z.boolean().optional(),
    asleep: z.boolean().optional(),
    agents: z.boolean().optional(),
    queued: z.boolean().optional(),
  }).optional(),
  taskAgents: z.strictObject({
    /** `0` = no limit. */
    maxConcurrent: z.number().int().min(0).max(taskAgentsMaxConcurrentUpperBound).optional(),
  }).optional(),
  todo: z.strictObject({
    isEnabled: z.boolean().optional(),
    /** `0` = no staleness reminder. */
    reminderMinutes: z.number().int().min(0).max(todoReminderMaxMinutes).optional(),
  }).optional(),
  limitReminders: z.strictObject({
    /** `0` = Off; otherwise one of the intervals the `/limits_reminders` picker offers. */
    everyMinutes: z.number().refine(checkIsLimitReminderChoice, { message: `must be one of ${limitReminderChoices.join(', ')} (minutes; 0 = off)` }).optional(),
  }).optional(),
  runnerHost: z.strictObject({ host: hubHostSchema, port: hubPortSchema }).optional(),
  workerRoles: workerRolesSchema.optional(),
});

/** @description The settings of an instance that has no `settings.json`: nothing set. */
export function createEmptyInstanceSettings(): InstanceSettings {
  return { defaultEffort: null, autoUpdate: null, whatsNew: null, botSkills: null, questionWait: null, topicStatus: {}, taskAgents: { maxConcurrent: null }, todo: { isEnabled: null, reminderMinutes: null }, limitReminders: { everyMinutes: null }, runnerHost: null, workerRoles: {} };
}

/**
 * @description Validate a parsed `settings.json` object. Every error names its field
 * (`settings.json defaultEffort: …`).
 */
export function validateInstanceSettings(parsedJson: object): ConfigValidation<InstanceSettings> {
  const parsed = rawSettingsSchema.safeParse(parsedJson);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => `${instanceSettingsFileName} ${issue.path.join('.') || '(root)'}: ${issue.message}`),
    };
  }
  return {
    ok: true,
    config: {
      defaultEffort: parsed.data.defaultEffort ?? null,
      autoUpdate: parsed.data.autoUpdate ?? null,
      whatsNew: parsed.data.whatsNew ?? null,
      botSkills: parsed.data.botSkills ?? null,
      questionWait: parsed.data.questionWait ?? null,
      topicStatus: { ...parsed.data.topicStatus },
      taskAgents: { maxConcurrent: parsed.data.taskAgents?.maxConcurrent ?? null },
      todo: { isEnabled: parsed.data.todo?.isEnabled ?? null, reminderMinutes: parsed.data.todo?.reminderMinutes ?? null },
      limitReminders: { everyMinutes: parsed.data.limitReminders?.everyMinutes ?? null },
      runnerHost: parsed.data.runnerHost ?? null,
      workerRoles: readStoredWorkerRoles(parsed.data.workerRoles),
    },
  };
}

/** @description Where `settings.json` lives: the config directory of the instance's REAL env file (`getConfigDirFilePath`). */
export function getInstanceSettingsPath(env: NodeJS.ProcessEnv = process.env, homeDir: string = os.homedir()): string {
  return getConfigDirFilePath(instanceSettingsFileName, env, homeDir);
}

export type InstanceSettingsLoad = ConfigFileLoad<InstanceSettings>;

const instanceSettingsLoader = createConfigFileLoader<InstanceSettings>({
  fileName: instanceSettingsFileName,
  createEmpty: createEmptyInstanceSettings,
  validate: validateInstanceSettings,
});

/**
 * @description Read and validate `settings.json`, cached by the file's stamp (mtime, size, inode) so a repeated call
 * costs one `stat`. A missing file is the empty settings; an invalid one reports its errors (its `config` is the
 * last good copy, which {@link createInstanceDefaultEffortReader} deliberately ignores).
 */
export const loadInstanceSettings = instanceSettingsLoader.load;

/** @description Forget every cached load — for tests, which swap files under one path. */
export const resetInstanceSettingsCache = instanceSettingsLoader.resetCache;

/** @description Write `settings` to `filePath`: validated first, then through a temp file and a rename. */
export function saveInstanceSettings(filePath: string, settings: InstanceSettings): void {
  // A field that is not set is left out of the file, so the file says only what the operator chose.
  const body = {
    ...(settings.defaultEffort === null ? {} : { defaultEffort: settings.defaultEffort }),
    ...(settings.autoUpdate === null ? {} : { autoUpdate: settings.autoUpdate }),
    ...(settings.whatsNew === null ? {} : { whatsNew: settings.whatsNew }),
    ...(settings.botSkills === null ? {} : { botSkills: settings.botSkills }),
    ...(settings.questionWait === null ? {} : { questionWait: settings.questionWait }),
    ...(Object.keys(settings.topicStatus).length === 0 ? {} : { topicStatus: settings.topicStatus }),
    ...(settings.taskAgents.maxConcurrent === null ? {} : { taskAgents: { maxConcurrent: settings.taskAgents.maxConcurrent } }),
    ...(settings.todo.isEnabled === null && settings.todo.reminderMinutes === null
      ? {}
      : {
        todo: {
          ...(settings.todo.isEnabled === null ? {} : { isEnabled: settings.todo.isEnabled }),
          ...(settings.todo.reminderMinutes === null ? {} : { reminderMinutes: settings.todo.reminderMinutes }),
        },
      }),
    ...(settings.limitReminders.everyMinutes === null ? {} : { limitReminders: { everyMinutes: settings.limitReminders.everyMinutes } }),
    ...(settings.runnerHost === null ? {} : { runnerHost: { host: settings.runnerHost.host, port: settings.runnerHost.port } }),
    ...(Object.keys(settings.workerRoles).length === 0
      ? {}
      : { workerRoles: Object.fromEntries(workerRoleIds.flatMap((role) => {
        const value = settings.workerRoles[role];
        return value === undefined ? [] : [[role, writeStoredWorkerRoleValue(value)]];
      })) }),
  };
  const validation = validateInstanceSettings(body);
  if (!validation.ok) throw new Error(`refusing to write an invalid ${instanceSettingsFileName}: ${validation.errors.join('; ')}`);
  writeJsonFileAtomically(filePath, body, settingsFileMode);
}

/**
 * @description Write `change` on top of what `settings.json` at `filePath` holds (a broken file is replaced — the
 * button the operator tapped is the fix). `null` on success, else the errno code of the failed write (logged).
 */
export function saveInstanceSettingsChange(filePath: string, change: Partial<InstanceSettings>): string | null {
  try {
    saveInstanceSettings(filePath, { ...loadInstanceSettingsForUpdate(filePath), ...change });
    return null;
  } catch (error) {
    const code = getCaughtErrnoCode(error);
    console.warn(`[Settings] could not write ${filePath} (${code})`);
    return code;
  }
}

/**
 * @description The settings a change starts from: the file's own when it is valid, else the empty ones. A change
 * made on top of a broken file replaces it — the button the operator tapped is the fix.
 */
export function loadInstanceSettingsForUpdate(filePath: string): InstanceSettings {
  const load = loadInstanceSettings(filePath);
  return load.status === 'invalid' ? createEmptyInstanceSettings() : load.config;
}

/**
 * The broken states of the file already logged. The load is cached by the file's stamp, so every reader of one broken
 * state holds the SAME load object: one line per broken state for the whole process, however many readers read it.
 */
const reportedInvalidLoads = new WeakSet<InstanceSettingsLoad>();

/**
 * @description A reader of one part of `settings.json`, re-read when the file changes: `select` picks it out of the
 * file's settings. An invalid file reads as the empty settings (so `select` fills in the defaults), and ONE line per
 * distinct broken state of the file is logged — not one per read, not one per reader.
 */
function createSettingsPartReader<TPart>(
  getFilePath: () => string,
  logError: (line: string) => void,
  select: (settings: InstanceSettings) => TPart,
): () => TPart {
  return () => {
    const load = loadInstanceSettings(getFilePath());
    if (load.status === 'invalid') {
      if (!reportedInvalidLoads.has(load)) {
        reportedInvalidLoads.add(load);
        logError(`[Settings] ${load.errors.join('; ')} (the built-in defaults apply until it is fixed)`);
      }
      return select(createEmptyInstanceSettings());
    }
    return select(load.config);
  };
}

/**
 * @description The reader that `effortLevels.setInstanceDefaultEffortReader` takes: `settings.json`'s
 * `defaultEffort`, re-read when the file changes. A missing file, or a file without the field, is `null` (the
 * code fallback). An invalid file is `null` too, and `logError` gets ONE line per distinct broken state of the
 * file — not one per session start.
 */
export function createInstanceDefaultEffortReader(
  getFilePath: () => string,
  logError: (line: string) => void,
): () => ClaudeEffortLevel | null {
  return createSettingsPartReader(getFilePath, logError, (settings) => settings.defaultEffort);
}

/**
 * @description The reader the update engine and the `/update` screen use: `settings.json`'s `autoUpdate` and `whatsNew` with the
 * defaults (`on`, shown) filled in, re-read when the file changes — a hand edit applies at the next check. An invalid file reads
 * as the defaults, and `logError` gets ONE line per distinct broken state (not one per read).
 */
export function createUpdateSettingsReader(getFilePath: () => string, logError: (line: string) => void): () => UpdateSettings {
  return createSettingsPartReader(getFilePath, logError, (settings) => ({
    autoUpdate: settings.autoUpdate ?? defaultAutoUpdateMode,
    whatsNew: settings.whatsNew ?? defaultWhatsNew,
  }));
}

/**
 * @description The reader of the «Bot skills» default the file seeds (`utils/botSkills.ts`): `botSkills`, re-read when the
 * file changes — a hand edit applies to the next agent start. `null` = the file does not say. An invalid file reads as `null`,
 * and `logError` gets ONE line per distinct broken state (not one per read).
 */
export function createBotSkillsSettingsReader(getFilePath: () => string, logError: (line: string) => void): () => BotSkillsSetting | null {
  return createSettingsPartReader(getFilePath, logError, (settings) => settings.botSkills);
}

/**
 * @description The reader of the instance's question wait (`utils/questionWaitPlan.ts`): `questionWait`, re-read when the file
 * changes — a hand edit applies to the next question. `null` = the file does not say (the built-in default applies). An invalid file
 * reads as `null`, and `logError` gets ONE line per distinct broken state (not one per read).
 */
export function createQuestionWaitSettingsReader(getFilePath: () => string, logError: (line: string) => void): () => QuestionWaitChoice | null {
  return createSettingsPartReader(getFilePath, logError, (settings) => settings.questionWait);
}

/**
 * @description The reader of the instance's status-mark switches (`utils/topicIndicatorPlan.ts`): `topicStatus`, re-read when the file
 * changes — a hand edit applies at the next look at a topic. An empty object = the file names none (every default applies). An invalid
 * file reads as the empty one, and `logError` gets ONE line per distinct broken state (not one per read).
 */
export function createTopicStatusSettingsReader(getFilePath: () => string, logError: (line: string) => void): () => Partial<TopicStatusPrefs> {
  return createSettingsPartReader(getFilePath, logError, (settings) => settings.topicStatus);
}

/**
 * @description The reader of the cap on tracker task agents the file seeds (`trackers/taskAgentLimit.ts`): `taskAgents.maxConcurrent`,
 * re-read when the file changes — a hand edit applies to the next hand-over. `null` = the file does not say. An invalid file reads
 * as `null`, and `logError` gets ONE line per distinct broken state (not one per read).
 */
export function createTaskAgentsMaxConcurrentReader(getFilePath: () => string, logError: (line: string) => void): () => number | null {
  return createSettingsPartReader(getFilePath, logError, (settings) => settings.taskAgents.maxConcurrent);
}

/**
 * @description The reader the todo registry uses: `settings.json`'s `todo` with the defaults (on, a reminder every
 * hour) filled in, re-read when the file changes. An invalid file reads as the defaults, and `logError` gets ONE line
 * per distinct broken state (not one per read).
 */
export function createTodoSettingsReader(getFilePath: () => string, logError: (line: string) => void): () => TodoReminderSettings {
  return createSettingsPartReader(getFilePath, logError, (settings) => ({
    isEnabled: settings.todo.isEnabled ?? true,
    reminderMinutes: settings.todo.reminderMinutes ?? todoReminderDefaultMinutes,
  }));
}

/**
 * @description The reader of the instance's limit-reminder interval (`limitNotes/reminderChoices.ts`): `limitReminders.everyMinutes`,
 * re-read when the file changes — a hand edit applies to the next note. `null` = the file does not say (the built-in default
 * applies). An invalid file reads as `null`, and `logError` gets ONE line per distinct broken state (not one per read).
 */
export function createLimitRemindersSettingsReader(getFilePath: () => string, logError: (line: string) => void): () => LimitReminderChoice | null {
  return createSettingsPartReader(getFilePath, logError, (settings) => settings.limitReminders.everyMinutes);
}

/**
 * @description The reader of the address paired runners dial (`/runners`): `runnerHost`, re-read when the file changes — a hand
 * edit applies to the next pairing. `null` = not chosen yet. An invalid file reads as `null`, and `logError` gets ONE line per
 * distinct broken state (not one per read).
 */
export function createRunnerHostReader(getFilePath: () => string, logError: (line: string) => void): () => HubAddress | null {
  return createSettingsPartReader(getFilePath, logError, (settings) => settings.runnerHost);
}

/**
 * @description The reader of the worker roles (`/workers`, `utils/workerRoles.ts`): `workerRoles`, re-read when the file changes — a
 * hand edit applies at the next `claude_profiles` call. An empty object = the file names none (every built-in value applies). An
 * invalid file reads as the empty one, and `logError` gets ONE line per distinct broken state (not one per read).
 */
export function createWorkerRolesSettingsReader(getFilePath: () => string, logError: (line: string) => void): () => WorkerRolesSetting {
  return createSettingsPartReader(getFilePath, logError, (settings) => settings.workerRoles);
}
