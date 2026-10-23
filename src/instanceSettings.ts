import * as os from 'os';
import { z } from 'zod';
import {
  createConfigFileLoader,
  getConfigDirFilePath,
  writeJsonFileAtomically,
  type ConfigFileLoad,
  type ConfigValidation,
} from './configDirFile';
import { claudeEffortLevels, type ClaudeEffortLevel } from './effortLevels';
import { autoUpdateModes, type AutoUpdateMode } from './selfUpdate/updateModes';

/**
 * @description The instance-wide settings: ONE JSON file, `settings.json`, in the charness config directory
 * (beside the instance's real `.env`, like `stt.json`). `/effort` in the General topic writes it; an operator may
 * hand-edit it and the next read sees the edit (the load is cached by file stamp, no restart). More instance
 * settings will move here later; today it holds `defaultEffort`, `autoUpdate` and `whatsNew`.
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
}

const rawSettingsSchema = z.strictObject({
  defaultEffort: z.enum(claudeEffortLevels).optional(),
  autoUpdate: z.enum(autoUpdateModes).optional(),
  whatsNew: z.boolean().optional(),
});

/** @description The settings of an instance that has no `settings.json`: nothing set. */
export function createEmptyInstanceSettings(): InstanceSettings {
  return { defaultEffort: null, autoUpdate: null, whatsNew: null };
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
  };
  const validation = validateInstanceSettings(body);
  if (!validation.ok) throw new Error(`refusing to write an invalid ${instanceSettingsFileName}: ${validation.errors.join('; ')}`);
  writeJsonFileAtomically(filePath, body, settingsFileMode);
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
 * @description The reader that `effortLevels.setInstanceDefaultEffortReader` takes: `settings.json`'s
 * `defaultEffort`, re-read when the file changes. A missing file, or a file without the field, is `null` (the
 * code fallback). An invalid file is `null` too, and `logError` gets ONE line per distinct broken state of the
 * file — not one per session start.
 */
export function createInstanceDefaultEffortReader(
  getFilePath: () => string,
  logError: (line: string) => void,
): () => ClaudeEffortLevel | null {
  let lastReportedLoad: InstanceSettingsLoad | null = null;
  return () => {
    const load = loadInstanceSettings(getFilePath());
    if (load.status === 'invalid') {
      if (load !== lastReportedLoad) {
        lastReportedLoad = load;
        logError(`[Settings] ${load.errors.join('; ')} (the built-in defaults apply until it is fixed)`);
      }
      return null;
    }
    lastReportedLoad = null;
    return load.config.defaultEffort;
  };
}
