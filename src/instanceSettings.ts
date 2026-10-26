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
import { claudeEffortLevels, type ClaudeEffortLevel } from './effortLevels';
import { botSkillsSettingValues, type BotSkillsSetting } from './utils/botSkillsSetting';
import { taskAgentsMaxConcurrentUpperBound } from './trackers/taskAgentLimit';
import { autoUpdateModes, defaultAutoUpdateMode, defaultWhatsNew, type AutoUpdateMode, type UpdateSettings } from './selfUpdate/updateModes';
import { todoReminderDefaultMinutes, type TodoReminderSettings } from './todos/nag';

/**
 * @description The instance-wide settings: ONE JSON file, `settings.json`, in the charness config directory
 * (beside the instance's real `.env`, like `stt.json`). `/effort` in the General topic writes it; an operator may
 * hand-edit it and the next read sees the edit (the load is cached by file stamp, no restart). More instance
 * settings will move here later; today it holds `defaultEffort`, `autoUpdate`, `whatsNew`, `botSkills` (whether the bot's
 * own skills reach the agents: the way an instance without General sets it), `taskAgents` (the cap on tracker task agents
 * running at once — the way an instance without General sets it) and `todo` (the shared todo lists: on / off and the
 * staleness reminder's interval — also the way an instance without General sets them).
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
  /** The tracker task agents (`trackers/`): `maxConcurrent` is the cap for the whole bot, `0` = no limit; `null` = not set, the built-in default (5). */
  taskAgents: { maxConcurrent: number | null };
  /** The shared todo lists (`todos/`); a field that is `null` = its default (on, a reminder every hour). */
  todo: { isEnabled: boolean | null; reminderMinutes: number | null };
}

/** The longest reminder interval a hand-edited `settings.json` may name: a day. */
const todoReminderMaxMinutes = 24 * 60;

const rawSettingsSchema = z.strictObject({
  defaultEffort: z.enum(claudeEffortLevels).optional(),
  autoUpdate: z.enum(autoUpdateModes).optional(),
  whatsNew: z.boolean().optional(),
  botSkills: z.enum(botSkillsSettingValues).optional(),
  taskAgents: z.strictObject({
    /** `0` = no limit. */
    maxConcurrent: z.number().int().min(0).max(taskAgentsMaxConcurrentUpperBound).optional(),
  }).optional(),
  todo: z.strictObject({
    isEnabled: z.boolean().optional(),
    /** `0` = no staleness reminder. */
    reminderMinutes: z.number().int().min(0).max(todoReminderMaxMinutes).optional(),
  }).optional(),
});

/** @description The settings of an instance that has no `settings.json`: nothing set. */
export function createEmptyInstanceSettings(): InstanceSettings {
  return { defaultEffort: null, autoUpdate: null, whatsNew: null, botSkills: null, taskAgents: { maxConcurrent: null }, todo: { isEnabled: null, reminderMinutes: null } };
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
      taskAgents: { maxConcurrent: parsed.data.taskAgents?.maxConcurrent ?? null },
      todo: { isEnabled: parsed.data.todo?.isEnabled ?? null, reminderMinutes: parsed.data.todo?.reminderMinutes ?? null },
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
    ...(settings.taskAgents.maxConcurrent === null ? {} : { taskAgents: { maxConcurrent: settings.taskAgents.maxConcurrent } }),
    ...(settings.todo.isEnabled === null && settings.todo.reminderMinutes === null
      ? {}
      : {
        todo: {
          ...(settings.todo.isEnabled === null ? {} : { isEnabled: settings.todo.isEnabled }),
          ...(settings.todo.reminderMinutes === null ? {} : { reminderMinutes: settings.todo.reminderMinutes }),
        },
      }),
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
