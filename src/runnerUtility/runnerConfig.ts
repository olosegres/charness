import * as fs from 'fs';
import { z } from 'zod';
import { getCaughtErrnoCode, writeJsonFileAtomically } from '../configDirFile';
import { hubHostKeySchema, hubHostSchema, hubIdSchema, hubPortSchema, hubSshUserSchema } from '../runners/hubIds';
import { checkIsEd25519PublicKey } from '../runners/sshKeys';
import type { RunnerHomePaths } from './runnerHome';

/**
 * @description The runner's two files: `config.json` (who it serves — written once at pairing, changed only by an update's package id) and
 * `status.json` (what the link is doing — written by `run`, read by `status`). Strict, and an invalid file names the problem without
 * echoing a value.
 */

const fileMode = 0o600;
const maxTextLength = 200;

const runnerConfigSchema = z.strictObject({
  runnerId: hubIdSchema,
  name: z.string().min(1).max(maxTextLength),
  hub: z.strictObject({
    host: hubHostSchema,
    port: hubPortSchema,
    user: hubSshUserSchema,
    /** Pinned: the link and every call to the hub verify exactly this key. */
    hostKey: hubHostKeySchema,
    /** The only key the built-in server accepts. */
    publicKey: z.string().refine(checkIsEd25519PublicKey, 'must be an ed25519 public key'),
    /** Whose charness it is, as the hub named itself (`@ExampleBot`). */
    label: z.string().min(1).max(maxTextLength),
  }),
  /** The id of the hub package this runner runs; compared with the one the hub names at every link. */
  packageId: z.string().max(maxTextLength).nullable(),
  pairedAtMs: z.number().int().nonnegative(),
});

/** @name RunnerConfig @description `config.json`. */
export type RunnerConfig = z.infer<typeof runnerConfigSchema>;

export const linkStates = ['connecting', 'linked', 'removed', 'error'] as const;
/** @name LinkState @description What the link is doing. */
export type LinkState = (typeof linkStates)[number];

const runnerStatusSchema = z.strictObject({
  pid: z.number().int().positive(),
  state: z.enum(linkStates),
  /** When the state began. */
  sinceMs: z.number().int().nonnegative(),
  updatedAtMs: z.number().int().nonnegative(),
  lastError: z.string().max(maxTextLength * 2).nullable(),
  activeJobs: z.number().int().nonnegative(),
  packageId: z.string().max(maxTextLength).nullable(),
});

/** @name RunnerStatus @description `status.json`. */
export type RunnerStatus = z.infer<typeof runnerStatusSchema>;

export class RunnerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunnerConfigError';
  }
}

function readJsonFile<TFile>(filePath: string, fileName: string, schema: z.ZodType<TFile>): TFile | null {
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (getCaughtErrnoCode(error) === 'ENOENT') return null;
    throw new RunnerConfigError(`${fileName} could not be read (${getCaughtErrnoCode(error)})`);
  }
  let parsedJson: object;
  try {
    parsedJson = JSON.parse(text);
  } catch {
    throw new RunnerConfigError(`${fileName} is not valid JSON`);
  }
  const parsed = schema.safeParse(parsedJson);
  if (parsed.success) return parsed.data;
  throw new RunnerConfigError(`${fileName} is invalid: ${parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'} ${issue.message}`).join('; ')}`);
}

/** @description `config.json`, or `null` when this account is not paired. */
export function readRunnerConfig(paths: RunnerHomePaths): RunnerConfig | null {
  return readJsonFile(paths.config, 'config.json', runnerConfigSchema);
}

export function writeRunnerConfig(paths: RunnerHomePaths, config: RunnerConfig): void {
  writeJsonFileAtomically(paths.config, runnerConfigSchema.parse(config), fileMode);
}

/** @description `status.json`, or `null` when `run` never wrote one (an unreadable one reads as none: it is only a report). */
export function readRunnerStatus(paths: RunnerHomePaths): RunnerStatus | null {
  try {
    return readJsonFile(paths.status, 'status.json', runnerStatusSchema);
  } catch {
    return null;
  }
}

export function writeRunnerStatus(paths: RunnerHomePaths, status: RunnerStatus): void {
  writeJsonFileAtomically(paths.status, runnerStatusSchema.parse(status), fileMode);
}
