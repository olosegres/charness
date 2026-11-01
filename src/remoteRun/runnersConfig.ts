import * as os from 'os';
import * as path from 'path';
import { z } from 'zod';
import { createConfigFileLoader, type ConfigFileLoad } from '../configDirFile';
import { resolveGlobalConfigEnvPath } from '../legacyNames';

/**
 * @description `~/.config/charness/runners.json` — the machines `charness remote-run` may use, written by hand (phase 1). ONE file per
 * OS user, deliberately NOT in an instance's `DATA_DIR`: an agent's environment does not say which instance it belongs to (a Jira agent
 * has neither `ENV_FILE` nor `DATA_DIR`), so every charness instance of the user shares it.
 *
 *   { "runners": [{ "name": "box1", "ssh": "runner@box1.example", "workDir": "/home/runner/charness-runner",
 *                   "sshOptions": ["-i", "/home/user/.ssh/runner_key"],
 *                   "pueue": { "bin": "/home/runner/.local/bin/pueue", "config": "/home/runner/.config/pueue/pueue.yml" },
 *                   "groups": { "default": 2, "emulator": 1 } }] }
 *
 * Validation is strict (an unknown key, a bad name, a duplicate is an error that names the field and echoes no value). The loader is
 * the shared stamp-cached one, so the bot's MCP can ask "is any runner listed?" on every connect for the cost of one `stat`.
 */

const configFileName = 'runners.json';
/** @description What a runner's name may be: lowercase letters and digits, single dashes between. */
export const runnerNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const groupNamePattern = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
/** The group every runner has; its parallel limit may be set, it never needs `group add`. */
export const defaultPueueGroup = 'default';

/** @description A runner's work folder: an absolute path on the runner, or one the runner's shell expands from `~`. */
export const runnerWorkDirSchema = z.string().min(1).refine((workDir) => workDir.startsWith('/') || workDir === '~' || workDir.startsWith('~/'), 'must be an absolute path on the runner or start with ~/');

const runnerSchema = z.strictObject({
  name: z.string().regex(runnerNamePattern, 'must be lowercase letters, digits and single dashes'),
  ssh: z.string().min(1).refine((destination) => !destination.startsWith('-') && !/\s/.test(destination), 'must be an ssh destination (user@host or a host alias): no spaces, not an option'),
  sshOptions: z.array(z.string()).optional(),
  workDir: runnerWorkDirSchema,
  pueue: z.strictObject({ bin: z.string().min(1).optional(), config: z.string().min(1).optional() }).optional(),
  groups: z.record(z.string().regex(groupNamePattern, 'is not a valid group name'), z.number().int().positive()).optional(),
});

const runnersConfigSchema = z.strictObject({
  runners: z.array(runnerSchema),
}).refine((config) => new Set(config.runners.map((runner) => runner.name)).size === config.runners.length, { path: ['runners'], message: 'runner names must be unique' });

/**
 * @name PairedRunnerLink
 * @description What only a PAIRED runner has (`pairedRunners.ts` fills it; the file never can): where the hub keeps its link on this
 * machine and whether the hub paused it. A runner without it is a hand-made one, reached by plain ssh.
 */
export interface PairedRunnerLink {
  runnerId: string;
  /** The registry folder (`~/.config/charness/runners`): `link/<id>.sock` / `link/<id>.json` say whether the runner is connected. */
  hubDir: string;
  /** Paused from the hub (`charness runners pause`, `/runners`): the runner stays attached but is never picked for a job. */
  isPausedByHub: boolean;
}

/** @name RunnerConfig @description One runner: an entry of the file, or a paired runner built from the hub's registry. */
export type RunnerConfig = z.infer<typeof runnerSchema> & { paired?: PairedRunnerLink };
/** @name RunnersConfig @description Every runner `remote-run` may use (see `runnersCatalog.ts`); the file alone holds only the hand-made ones. */
export interface RunnersConfig {
  runners: RunnerConfig[];
}

/** @description Where the file lives: beside the user's global charness env file, whatever `ENV_FILE` says (it is per OS user, not per instance). */
export function getRunnersConfigPath(homeDir: string = os.homedir()): string {
  return path.join(path.dirname(resolveGlobalConfigEnvPath(homeDir)), configFileName);
}

const loader = createConfigFileLoader<RunnersConfig>({
  fileName: configFileName,
  createEmpty: () => ({ runners: [] }),
  validate: (parsedJson) => {
    const parsed = runnersConfigSchema.safeParse(parsedJson);
    if (parsed.success) return { ok: true, config: parsed.data };
    return { ok: false, errors: parsed.error.issues.map((issue) => `${configFileName} ${issue.path.join('.') || '(root)'}: ${issue.message}`) };
  },
});

/** @description The content of the runners file at `filePath` (stamp-cached): missing = no runners, invalid = its errors and the last good config of this process, if any. */
export function loadRunnersConfigAt(filePath: string): ConfigFileLoad<RunnersConfig> {
  return loader.load(filePath);
}

/** @description The user's `runners.json` right now. */
export function loadRunnersConfig(homeDir: string = os.homedir()): ConfigFileLoad<RunnersConfig> {
  return loadRunnersConfigAt(getRunnersConfigPath(homeDir));
}

/** @description Forget the cached loads (tests that swap files under one path). */
export function resetRunnersConfigCache(): void {
  loader.resetCache();
}

/** @description The parallel limits of a runner's groups as the `name=n,name=n` string the runner script applies, in the order of the file (the runner applies each pair on its own, so the order carries no meaning). */
export function formatGroupLimits(groups: RunnerConfig['groups']): string {
  return Object.entries(groups ?? {}).map(([groupName, parallel]) => `${groupName}=${parallel}`).join(',');
}
