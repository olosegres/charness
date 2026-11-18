/**
 * @description The Claude profile registry (`state.claudeProfiles`) kept in step with the DISK and with the CLI's own word, with no
 * Telegram in the way — the one place both the `/accounts` screen and the bot's usage poll go through, so an instance that serves only
 * a tracker (`CONNECTORS=jira`) sees every signed-in account too:
 *
 *   - **adopt**: a folder under `DATA_DIR/claude-profiles/` with a valid profile name and no record gets one (`createdAt` from the
 *     folder, `loggedIn: false` until the probe says otherwise) — an account signed in by hand with
 *     `CLAUDE_CONFIG_DIR=<that folder> claude auth login` is picked up like one added from `/accounts` (and given the links back into
 *     `~/.claude` it may lack — `projects/` above all, or a conversation could not resume under it). A removal leaves no
 *     folder behind (`removeClaudeProfileLayout`), so it is never adopted back; the hidden `default` record of a signed-out
 *     `~/.claude` (`isRemoved`) is never probed by the scan — only a sign-in through `/accounts` or an operator's screen brings it back.
 *   - **probe**: `claude auth status --json` under each profile's directory (`readStatus`) and the answer on its record
 *     ({@link recordClaudeProfileStatus}). A scan probes only what is DUE: a profile never probed, one that was not signed in (a
 *     sign-in by hand must show up), or a signed-in one whose status is older than {@link claudeAuthStatusMaxAgeMs}; and no profile
 *     more than once per {@link claudeAuthStatusRetryMs}, whatever the outcome (a CLI that does not answer is not asked again at
 *     every poll). The `/accounts` screen forces a probe of everything, as it always did.
 *
 * Every dependency is injected, so the unit test drives it over a temp folder and a fake store.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ClaudeProfileRecord } from '../state';
import {
  checkClaudeProfileDirExists,
  checkIsValidClaudeProfileName,
  claudeConsoleLoginKeySource,
  defaultClaudeProfileName,
  resolveClaudeProfileDir,
  resolveClaudeProfilesRoot,
  type ClaudeAuthStatus,
} from './claudeProfiles';

/** A signed-in profile's status is read again after this long (a sign-out or a plan change made outside the bot shows up within it). */
export const claudeAuthStatusMaxAgeMs = 60 * 60_000;

/** The least time between two probes of the same profile by a scan that is not forced (an unanswered or signed-out one is asked again no sooner). */
export const claudeAuthStatusRetryMs = 5 * 60_000;

/** The part of `StateStore` the sync reads and writes. */
export interface ClaudeProfileSyncStore {
  /** The added profiles by name (`default` is never among them). */
  getClaudeProfileRecords(): Readonly<Record<string, ClaudeProfileRecord>>;
  /** An ADDED profile's record; `undefined` for an unknown name and for `default`. */
  getClaudeProfileRecord(name: string): ClaudeProfileRecord | undefined;
  /** What is known about ANY profile, `default`'s hidden record included. */
  getClaudeProfileInfo(name: string): ClaudeProfileRecord | undefined;
  upsertClaudeProfileRecord(name: string, patch: Partial<ClaudeProfileRecord>): Promise<void>;
}

/**
 * @description Persist a probe's answer on the profile's record (nothing for a failed probe). `default` gets its hidden record, so
 * the usage ranking and the CLI twin know whether it is signed in and as whom; an added profile removed meanwhile gets none.
 */
export async function recordClaudeProfileStatus(
  store: Pick<ClaudeProfileSyncStore, 'getClaudeProfileRecord' | 'upsertClaudeProfileRecord'>,
  name: string,
  status: ClaudeAuthStatus | null,
  nowMs: number = Date.now(),
): Promise<void> {
  if (status === null) return;
  if (name !== defaultClaudeProfileName && store.getClaudeProfileRecord(name) === undefined) return; // removed meanwhile
  await store.upsertClaudeProfileRecord(name, {
    // A removed `default` comes back by itself the moment it is signed in again.
    ...(name === defaultClaudeProfileName && status.loggedIn ? { isRemoved: undefined } : {}),
    // The CLI's word on how the account pays wins over the kind it was added as, both ways.
    ...(status.billing !== null ? { billing: status.billing } : {}),
    // Which key the sessions use decides whether the stored one may be asked on (the daily credit recheck of `default`).
    isConsoleLoginKey: status.apiKeySource === claudeConsoleLoginKeySource,
    loggedIn: status.loggedIn,
    email: status.email ?? undefined,
    subscriptionType: status.subscriptionType ?? undefined,
    orgName: status.orgName ?? undefined,
    statusCheckedAt: new Date(nowMs).toISOString(),
  });
}

/** A profile folder on disk: its name and when it was created (the folder's own birth, else its last change). */
export interface ClaudeProfileFolder {
  name: string;
  createdAt: string;
}

/**
 * @description The folders under `DATA_DIR/claude-profiles/` that can be profiles, by name: a valid profile name
 * (`checkIsValidClaudeProfileName` — never `default`, no dotfile, no upper case) naming a directory (a link to one counts). An
 * unreadable root is no folders.
 */
export function listClaudeProfileFolders(dataDir: string): ClaudeProfileFolder[] {
  const root = resolveClaudeProfilesRoot(dataDir);
  let names: string[];
  try {
    names = fs.readdirSync(root).sort();
  } catch {
    return [];
  }
  const folders: ClaudeProfileFolder[] = [];
  for (const name of names) {
    if (!checkIsValidClaudeProfileName(name)) continue;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(path.join(root, name));
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    folders.push({ name, createdAt: new Date(stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs).toISOString() });
  }
  return folders;
}

export interface ClaudeProfileSyncDeps {
  store: ClaudeProfileSyncStore;
  getDataDir: () => string;
  /** `claude auth status --json` under `configDir` (`null` = `~/.claude`); `null` when the probe gives no answer. */
  readStatus: (configDir: string | null) => Promise<ClaudeAuthStatus | null>;
  /**
   * Called for a folder about to be adopted: give it the links back into `~/.claude` that a profile needs (`createClaudeProfileLayout` —
   * idempotent: the login and the account's state stay, an entry of the folder's own that stands in a link's place is moved aside). Without `projects/` linked a conversation could not be resumed under
   * the account. A throw is logged and the folder adopted all the same.
   */
  ensureLayout?: (name: string) => void;
  /** {@link claudeAuthStatusMaxAgeMs} unless a test sets it. */
  statusMaxAgeMs?: number;
  /** {@link claudeAuthStatusRetryMs} unless a test sets it. */
  retryMs?: number;
  now?: () => number;
  log?: (line: string) => void;
}

export interface ClaudeProfileSyncResult {
  /** The names given a record by this scan, in order. */
  adopted: string[];
  /** The names whose status was probed by this scan (`default` included), in order. */
  probed: string[];
  /** The probe of `default` — `null` when it was not probed or gave no answer. */
  defaultStatus: ClaudeAuthStatus | null;
}

export interface ClaudeProfileSync {
  /**
   * Adopt the folders without a record, then probe the profiles that are due (`isForced`: every profile, the removed `default`
   * included — the `/accounts` screen). A scan already under way is joined by one that is not forced. Never throws.
   */
  sync: (options?: { isForced?: boolean }) => Promise<ClaudeProfileSyncResult>;
}

export function createClaudeProfileSync(deps: ClaudeProfileSyncDeps): ClaudeProfileSync {
  const { store, readStatus } = deps;
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? ((line: string) => console.log(line));
  const statusMaxAgeMs = deps.statusMaxAgeMs ?? claudeAuthStatusMaxAgeMs;
  const retryMs = deps.retryMs ?? claudeAuthStatusRetryMs;
  const lastAttemptMsByName = new Map<string, number>();
  let inFlight: Promise<ClaudeProfileSyncResult> | null = null;

  /** Give every folder without a record one — the check and the write in one tick, so a profile `/accounts` is adding right now is never adopted twice. */
  async function adoptFolders(): Promise<string[]> {
    const adopted: string[] = [];
    for (const folder of listClaudeProfileFolders(deps.getDataDir())) {
      if (store.getClaudeProfileRecord(folder.name) !== undefined) continue;
      if (!checkClaudeProfileDirExists(deps.getDataDir(), folder.name)) continue; // removed since the listing
      try {
        deps.ensureLayout?.(folder.name);
      } catch (e) {
        log(`[accounts] profile ${folder.name}: its links into ~/.claude could not be made: ${e instanceof Error ? e.message : String(e)}`);
      }
      // Not signed in until the probe below says so: a folder the CLI cannot vouch for is never offered.
      await store.upsertClaudeProfileRecord(folder.name, { createdAt: folder.createdAt, loggedIn: false });
      adopted.push(folder.name);
      log(`[accounts] profile ${folder.name}: its folder had no record — adopted`);
    }
    return adopted;
  }

  function checkIsProbeDue(name: string, nowMs: number): boolean {
    const lastAttemptMs = lastAttemptMsByName.get(name);
    if (lastAttemptMs !== undefined && nowMs - lastAttemptMs < retryMs) return false;
    const record = store.getClaudeProfileInfo(name);
    // A `default` the operator signed out through `/accounts` stays out until a screen or a sign-in of the operator's brings it back.
    if (name === defaultClaudeProfileName && record?.isRemoved === true) return false;
    if (record?.statusCheckedAt === undefined || record.loggedIn !== true) return true;
    const checkedAtMs = Date.parse(record.statusCheckedAt);
    return !Number.isFinite(checkedAtMs) || nowMs - checkedAtMs >= statusMaxAgeMs;
  }

  async function probe(name: string): Promise<ClaudeAuthStatus | null> {
    try {
      return await readStatus(resolveClaudeProfileDir(deps.getDataDir(), name));
    } catch (e) {
      log(`[accounts] profile ${name}: the auth status probe threw: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  async function run(isForced: boolean): Promise<ClaudeProfileSyncResult> {
    const adopted = await adoptFolders();
    const nowMs = now();
    const names = [defaultClaudeProfileName, ...Object.keys(store.getClaudeProfileRecords())]
      .filter((name) => isForced || checkIsProbeDue(name, nowMs));
    for (const name of names) lastAttemptMsByName.set(name, nowMs);
    const statuses = await Promise.all(names.map(probe));
    await Promise.all(names.map((name, index) => recordClaudeProfileStatus(store, name, statuses[index], now())));
    const defaultIndex = names.indexOf(defaultClaudeProfileName);
    return { adopted, probed: names, defaultStatus: defaultIndex === -1 ? null : statuses[defaultIndex] };
  }

  async function sync(options: { isForced?: boolean } = {}): Promise<ClaudeProfileSyncResult> {
    const isForced = options.isForced === true;
    if (!isForced && inFlight) return inFlight;
    const scan = run(isForced).catch((e): ClaudeProfileSyncResult => {
      log(`[accounts] the profile scan failed: ${e instanceof Error ? e.message : String(e)}`);
      return { adopted: [], probed: [], defaultStatus: null };
    });
    if (isForced) return scan;
    inFlight = scan.finally(() => { inFlight = null; });
    return inFlight;
  }

  return { sync };
}
