import { randomBytes } from 'node:crypto';
import type { StateStore } from '../state';
import { keyToString, type ThreadKey } from '../types';
import { checkIsReminderSchedule } from './deliveryKind';
import { getNextRunAt } from './recurrence';
import type {
  ScheduleCreatedBy,
  ScheduleDeliveryKind,
  ScheduleRecord,
  ScheduleSpec,
} from './types';

/**
 * @description Scheduler store helpers — id generation and the cap-enforcing
 * create path. The persisted collection itself lives on {@link StateStore}
 * (`schedules` field + getters/setters), following the `traceConfig` pattern;
 * this module owns the bits the store shouldn't know about: how an id is
 * minted from a name, and the per-thread cap of each delivery kind.
 */

/**
 * Hard cap on AGENT-PROMPT schedules per thread (records with no `deliveryKind`).
 * Enforced in {@link createScheduleForThread}. This cap exists FOR the agent:
 * `schedule_create` is in the model's hands and a looping one can mint junk jobs,
 * so 30 is the muzzle.
 */
export const maxSchedulesPerThread = 30;

/**
 * Hard cap on `/reminders` schedules per thread, counted SEPARATELY from
 * {@link maxSchedulesPerThread} so neither creator can eat the other's slots.
 * It is far higher because a reminder costs four button taps — a human cannot
 * mint 100 by accident — and bounded at all only because every record lives in
 * the single `state.json` (rewritten whole on every change) and arms one timer at
 * boot, so a runaway code path must not be able to write records without end.
 */
export const maxRemindersPerThread = 100;

/** Length of the random suffix appended to a slug to keep ids unique. */
const idSuffixLength = 6;

/** Max characters kept from the slugified name before the suffix. */
const slugMaxLength = 40;

/**
 * @description Turn a free-text name into a lowercase ascii-ish slug: lowercase,
 * non-alphanumerics collapsed to single hyphens, edge hyphens trimmed, bounded
 * length. Returns `'job'` as a stable fallback when nothing usable survives
 * (e.g. a name of only emoji/punctuation) so an id is always well-formed.
 */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .slice(0, slugMaxLength)
    .replace(/-+$/, '');
  return slug || 'job';
}

/**
 * @description Mint a schedule id: `slugify(name)` + `-` + a 6-char lowercase
 * alphanumeric random suffix. The suffix makes the id collision-resistant
 * without the create-time uniqueness check the spec calls out as bad UX.
 */
export function generateScheduleId(name: string): string {
  // base36 of random bytes yields [0-9a-z]; pad+slice to a fixed-length suffix.
  const suffix = randomBytes(8).toString('hex');
  const alnum = parseInt(suffix, 16).toString(36).padStart(idSuffixLength, '0').slice(-idSuffixLength);
  return `${slugify(name)}-${alnum}`;
}

/**
 * @name CreateScheduleArgs
 * @description Inputs of the create path. Defined ONCE and shared by
 * {@link createScheduleRecord} and {@link createScheduleForThread} so a new field
 * cannot be added to one and forgotten on the other.
 */
export interface CreateScheduleArgs {
  threadKey: ThreadKey;
  name: string;
  spec: ScheduleSpec;
  /** Prompt for the agent, or the posted text when `deliveryKind` is `'reminder'`. */
  prompt: string;
  createdBy: ScheduleCreatedBy;
  nowMs: number;
  lastAdapterName?: string;
  isPinSilent?: boolean;
  /** Omit for the agent-prompt default; `'reminder'` for a bot-local reminder. */
  deliveryKind?: ScheduleDeliveryKind;
}

/**
 * @description Build a fresh {@link ScheduleRecord} from its inputs, computing
 * the initial `nextRunAt` for the spec. Pure (besides id randomness): callers
 * pass `nowMs` so creation time and the first `nextRunAt` are deterministic in
 * tests. Does NOT persist — the caller (or {@link createScheduleForThread})
 * writes it to the store.
 */
export function createScheduleRecord(args: CreateScheduleArgs): ScheduleRecord {
  const { threadKey, name, spec, prompt, createdBy, nowMs, lastAdapterName, isPinSilent } = args;
  const nowIso = new Date(nowMs).toISOString();
  const record: ScheduleRecord = {
    id: generateScheduleId(name),
    threadKey: keyToString(threadKey),
    name,
    spec,
    prompt,
    createdBy,
    createdAt: nowIso,
    updatedAt: nowIso,
    nextRunAt: getNextRunAt(spec, nowMs),
  };
  if (lastAdapterName !== undefined) record.lastAdapterName = lastAdapterName;
  if (isPinSilent) record.isPinSilent = true;
  // Absent means the agent-prompt kind, so the field is written only when set.
  if (args.deliveryKind !== undefined) record.deliveryKind = args.deliveryKind;
  return record;
}

/**
 * @name CreateScheduleResult
 * @description Typed outcome of {@link createScheduleForThread} — a result
 * object rather than a thrown string, so the cap rejection is handled
 * explicitly at the call site (plan S2: "typed error/result, not a throw").
 */
export type CreateScheduleResult =
  | { ok: true; record: ScheduleRecord }
  | { ok: false; reason: 'cap-reached'; limit: number };

/**
 * @description Create and persist a schedule for a thread, enforcing the cap of
 * the record's OWN delivery kind: a reminder counts only the thread's reminders
 * against {@link maxRemindersPerThread}, an agent-prompt job only the thread's
 * agent-prompt jobs against {@link maxSchedulesPerThread}. Counting the kinds
 * apart is what keeps each rejection actionable — a shared counter let the two
 * steal slots from each other and told the agent it had hit a limit it could not
 * reach, because `schedule_list` hides reminders and `schedule_cancel` refuses
 * their ids. `limit` in the result is the one that actually applied, since callers
 * render it.
 */
export async function createScheduleForThread(
  store: StateStore,
  args: CreateScheduleArgs,
): Promise<CreateScheduleResult> {
  const isReminder = checkIsReminderSchedule(args);
  const limit = isReminder ? maxRemindersPerThread : maxSchedulesPerThread;
  const sameKindCount = store
    .getThreadSchedules(args.threadKey)
    .filter((record) => checkIsReminderSchedule(record) === isReminder).length;
  if (sameKindCount >= limit) {
    return { ok: false, reason: 'cap-reached', limit };
  }
  const record = createScheduleRecord(args);
  await store.upsertSchedule(record);
  return { ok: true, record };
}
