/**
 * @description The WORKER ROLES setting (`/workers`, `settings.json` `workerRoles`): per role of a worker an agent launches
 * (a builder, a reviewer, …), the CLI, the model and the effort the bot gives it as its DEFAULT — what the agent uses when
 * nothing it follows names them. The order that decides a worker's model (the shipped skills say it, the `claude_profiles`
 * answer repeats it):
 *
 * 1. what the user named for this worker (the conversation, a plan, a brief, their own always-loaded instructions);
 * 2. a general delegate skill the session lists that names the role's model;
 * 3. this setting — the bot's default (the built-in table below while the operator changed nothing);
 * 4. a role the bot KNOWS cannot run here (no Claude account signed in, an OpenCode model not in the catalog) → the CLI and
 *    model the conversation itself runs on.
 *
 * The bot cannot see what an agent follows, so it never claims what a worker WILL get: every text says «the bot's default —
 * your own instructions win». One value per role for the whole bot (no per-topic override), read at every `claude_profiles`
 * call: a change reaches the next launch; a resumed worker keeps its first run's model.
 *
 * Pure: no I/O, no zod (the schema of the stored value lives in `instanceSettings.ts`).
 */

import type { ClaudeWorkerEffortLevel } from '../effortLevels';

/** The roles, in the order the screen and the tool name them. */
export const workerRoleIds = ['builder', 'storageBuilder', 'investigator', 'reviewer', 'miniReviewer', 'planner'] as const;

export type WorkerRoleId = (typeof workerRoleIds)[number];

/** @description Whether `value` names a role. */
export function checkIsWorkerRoleId(value: string): value is WorkerRoleId {
  return (workerRoleIds as readonly string[]).includes(value);
}

/** The CLI a worker runs in. */
export type WorkerCli = 'claude' | 'opencode';

/**
 * @name WorkerRoleValue
 * @description What a role's worker launches with: a Claude model alias with an effort, or an OpenCode `provider/model` with one
 * of that model's variants (`null` = none, the model's own default).
 */
export type WorkerRoleValue =
  | { cli: 'claude'; model: string; effort: ClaudeWorkerEffortLevel }
  | { cli: 'opencode'; model: string; effort: string | null };

/** The roles the operator changed; a role it does not name holds its built-in value. */
export type WorkerRolesSetting = Partial<Record<WorkerRoleId, WorkerRoleValue>>;

/** The built-in values (owner, 2026-11-22): Opus for every worker, the effort by how much a mistake of the role costs. */
export const builtInWorkerRoles: Readonly<Record<WorkerRoleId, WorkerRoleValue>> = {
  builder: { cli: 'claude', model: 'opus', effort: 'medium' },
  storageBuilder: { cli: 'claude', model: 'opus', effort: 'xhigh' },
  investigator: { cli: 'claude', model: 'opus', effort: 'xhigh' },
  reviewer: { cli: 'claude', model: 'opus', effort: 'xhigh' },
  miniReviewer: { cli: 'claude', model: 'opus', effort: 'high' },
  planner: { cli: 'claude', model: 'opus', effort: 'xhigh' },
};

/** @description Whether two values launch the same worker. */
export function checkIsSameWorkerRoleValue(a: WorkerRoleValue, b: WorkerRoleValue): boolean {
  return a.cli === b.cli && a.model === b.model && a.effort === b.effort;
}

/** A role's value in force and whether it is the built-in one. */
export interface ResolvedWorkerRole {
  value: WorkerRoleValue;
  isBuiltIn: boolean;
}

/** @description The value `role` holds under `setting`: the operator's when it changed it, else the built-in one. */
export function resolveWorkerRole(setting: WorkerRolesSetting, role: WorkerRoleId): ResolvedWorkerRole {
  const value = setting[role] ?? builtInWorkerRoles[role];
  return { value, isBuiltIn: checkIsSameWorkerRoleValue(value, builtInWorkerRoles[role]) };
}

/**
 * @description `setting` with `role` set to `value` (`null` = back to the built-in value). A value equal to the built-in one is
 * left out, so the file names only the roles the operator really changed.
 */
export function updateWorkerRolesSetting(setting: WorkerRolesSetting, role: WorkerRoleId, value: WorkerRoleValue | null): WorkerRolesSetting {
  const next: WorkerRolesSetting = { ...setting };
  if (value === null || checkIsSameWorkerRoleValue(value, builtInWorkerRoles[role])) delete next[role];
  else next[role] = value;
  return next;
}

/** @description Whether any role differs from its built-in value. */
export function checkHasChangedWorkerRole(setting: WorkerRolesSetting): boolean {
  return workerRoleIds.some((role) => !resolveWorkerRole(setting, role).isBuiltIn);
}

// ── what an agent is told ──

/**
 * Why the bot knows a role cannot run here: `noClaudeAccount` — no Claude account is signed in on the host; `openCodeModelMissing`
 * — the role's OpenCode model is not in the catalog (its provider disconnected, or the model is gone).
 */
export type WorkerRoleUnavailability = 'noClaudeAccount' | 'openCodeModelMissing';

/** @name WorkerRoleReport @description The `worker` of a `claude_profiles` answer asked with a `role` (also `charness claude-profiles --role --json`). */
export interface WorkerRoleReport {
  role: WorkerRoleId;
  cli: WorkerCli;
  model: string;
  /** The Claude effort, or the OpenCode variant (`null` = the model's own default). */
  effort: string | null;
  /** The value nobody changed (the built-in table). */
  isBuiltIn: boolean;
  /** Set when the bot knows the role cannot run here: launch it on the conversation's own CLI and model instead. */
  unavailable: WorkerRoleUnavailability | null;
}

/** @description The report of `role` under `setting`, with what the caller found about whether it can run here. */
export function buildWorkerRoleReport(setting: WorkerRolesSetting, role: WorkerRoleId, unavailable: WorkerRoleUnavailability | null): WorkerRoleReport {
  const { value, isBuiltIn } = resolveWorkerRole(setting, role);
  return { role, cli: value.cli, model: value.model, effort: value.effort, isBuiltIn, unavailable };
}

/** @description The launch flags of a worker: `claude -p --model opus --effort medium`, `opencode run --model openai/gpt-5 --variant high`. */
export function describeWorkerLaunchFlags(worker: Pick<WorkerRoleReport, 'cli' | 'model' | 'effort'>): string {
  if (worker.cli === 'claude') return `claude -p --model ${worker.model} --effort ${worker.effort ?? ''}`.trimEnd();
  return `opencode run --model ${worker.model}${worker.effort === null ? '' : ` --variant ${worker.effort}`}`;
}

/** The fallback of a role that cannot run here — the last step of the order. */
const workerOwnModelFallback = 'launch it on the CLI, model and effort this conversation runs on';

/** Why a role cannot run here, in words. */
const workerUnavailabilityWords: Readonly<Record<WorkerRoleUnavailability, string>> = {
  noClaudeAccount: 'no Claude account is signed in on this host',
  openCodeModelMissing: 'its OpenCode model is not in the catalog (provider disconnected or model gone)',
};

/** The words that say whose value it is and that the agent's own instructions win. */
export const workerDefaultWords = 'the bot\'s default for this role; a model the user or your general delegate skill names wins';

/**
 * @description The head of the first line of a `claude_profiles` answer asked with a `role` (also the CLI's line): the launch
 * and «the bot's default — your own instructions win», or that the role cannot run here and the agent launches it on its own.
 * The account part (Claude) or «no Claude account needed» (OpenCode) follows it.
 */
export function describeWorkerRole(worker: WorkerRoleReport): string {
  if (worker.unavailable !== null) {
    return `${worker.role}: the bot's default is ${describeWorkerLaunchFlags(worker)}, but ${workerUnavailabilityWords[worker.unavailable]} → ${workerOwnModelFallback}`;
  }
  return `${worker.role}: ${describeWorkerLaunchFlags(worker)} — ${workerDefaultWords}`;
}

/** The tail of an OpenCode role's line: it runs on no Claude account. */
export const workerNoClaudeAccountNeededWords = 'no Claude account needed';
