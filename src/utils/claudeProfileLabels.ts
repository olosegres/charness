/**
 * @description The DISPLAY NAME of a Claude account (`/accounts`), apart from its fixed internal id. The id names the account's folder
 * (`DATA_DIR/claude-profiles/<id>/`), its button data, the `/limits` list's rungs, every topic's pick and the name agents record — so it
 * never changes once the account exists. The display name is free text the operator gives at ➕ and changes with ✏️ «Rename»:
 * capitals, dots, spaces, `@`, Cyrillic, emoji, up to {@link claudeProfileLabelMaxLength} characters. The bot derives the id from it
 * ({@link deriveClaudeProfileId}) and shows the display name wherever it names the account; an account with no display name (one
 * added before display names existed, one adopted from a folder made by hand) shows its id, and `default` (`~/.claude`) shows «Main»
 * in the reader's language until it is renamed — nothing is migrated.
 *
 * Rules that keep a typed name unambiguous ({@link checkClaudeProfileLabel}): no two accounts share a display name (case ignored) and no
 * display name equals another account's id, so `/accounts use|login|remove <name>` finds one account by either
 * ({@link findClaudeProfileByTypedName}); a derived id never equals another account's display name either.
 *
 * The rules are pure. The resolver every screen calls ({@link getClaudeProfileLabel}) reads the stored names through the reader the bot
 * registers at start-up ({@link setClaudeProfileLabelReader}); the views the ranking, `claude_profiles` and `charness claude-profiles`
 * read carry the name themselves (`utils/claudeProfileUsageViews.ts`). Not loaded by the connector guards: it reads the locale.
 */

import { t } from '../i18n';
import { checkIsValidClaudeProfileName, claudeProfileNameMaxLength, defaultClaudeProfileName } from './claudeProfiles';

/** The longest display name, in characters (code points). */
export const claudeProfileLabelMaxLength = 40;

/** The longest display name a BUTTON shows; a longer one is cut there with `…` (the message text shows it whole). */
export const claudeProfileButtonLabelMaxLength = 24;

/** What a derived id falls back to when nothing of the display name survives (`Работа` keeps `rabota`; `🚀` keeps nothing). */
const derivedIdFallback = 'account';

/** The ellipsis a cut label ends with. */
const ellipsis = '…';

/** Control and format characters (zero-width, bidi overrides), except the zero-width joiner emoji sequences are made of. */
const invisibleCharactersRe = /[\p{Cc}\p{Cf}]/gu;
const zeroWidthJoiner = '‍';

/**
 * Letters written as Latin for the derived id, looked up BEFORE accents are dropped (`й` must not become `и`): Cyrillic (Russian,
 * Ukrainian, Belarusian) — `Работа` → `rabota` — and the Latin letters no decomposition reaches. Anything else outside `a–z0-9` (after
 * accents are dropped) becomes a `-`.
 */
const transliteration: Readonly<Record<string, string>> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o',
  п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu',
  я: 'ya', і: 'i', ї: 'yi', є: 'ye', ґ: 'g', ў: 'u',
  ß: 'ss', æ: 'ae', œ: 'oe', ø: 'o', ł: 'l', đ: 'd', þ: 'th',
};

/** One account as the name rules see it: its id and the display names it answers to (the first is the one shown). */
export interface ClaudeProfileNameEntry {
  name: string;
  /** The shown display name first; `default` with no name of its own also answers to «Main» in English. Never empty. */
  labels: readonly string[];
}

/** Why a display name is refused. */
export type ClaudeProfileLabelProblem =
  | { kind: 'empty' }
  | { kind: 'tooLong'; max: number }
  /** Another account already shows this name (case ignored); `label` is that account's own spelling. */
  | { kind: 'taken'; label: string }
  /** The name is another account's id (case ignored): a typed command could not tell the two apart. */
  | { kind: 'isId'; label: string };

/** Why a typed id is refused ({@link describeClaudeProfileIdProblem}). */
export type ClaudeProfileIdProblem =
  | { kind: 'empty' }
  | { kind: 'reserved' }
  | { kind: 'tooLong'; max: number }
  /** The first character is not a letter `a–z` or a digit (a `-` or `_` may not start an id). */
  | { kind: 'firstCharacter'; character: string }
  | { kind: 'character'; character: string };

/** The number of characters (code points) of a text. */
function countCharacters(text: string): number {
  return Array.from(text).length;
}

/** The lowercase key two names are compared by: case and Unicode composition ignored. */
function getComparisonKey(text: string): string {
  return text.normalize('NFC').toLowerCase();
}

/**
 * @description A typed display name as it is kept: Unicode-composed, invisible characters (controls, zero-width marks, bidi overrides)
 * removed — the joiner of an emoji sequence stays —, every run of whitespace (a line break too) one space, trimmed. So a name is always
 * one line and never pretends to be another by an invisible difference.
 */
export function normaliseClaudeProfileLabel(raw: string): string {
  return raw
    .normalize('NFC')
    .replace(invisibleCharactersRe, (character) => (character === zeroWidthJoiner ? character : ''))
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * @description Why `label` (already {@link normaliseClaudeProfileLabel}d) cannot be the display name of the account `selfName` (`null`
 * for an account about to be added), `null` when it can. `accounts` is every account, `default` included and `selfName` too (it is
 * skipped). Its own id is allowed — renaming an account back to its id gives it no display name of its own.
 */
export function checkClaudeProfileLabel(input: { label: string; selfName: string | null; accounts: readonly ClaudeProfileNameEntry[] }): ClaudeProfileLabelProblem | null {
  const { label } = input;
  if (label === '') return { kind: 'empty' };
  if (countCharacters(label) > claudeProfileLabelMaxLength) return { kind: 'tooLong', max: claudeProfileLabelMaxLength };
  const key = getComparisonKey(label);
  for (const account of input.accounts) {
    if (account.name === input.selfName) continue;
    if (getComparisonKey(account.name) === key) return { kind: 'isId', label: account.labels[0] ?? account.name };
    const taken = account.labels.find((known) => getComparisonKey(known) === key);
    if (taken !== undefined) return { kind: 'taken', label: account.labels[0] ?? taken };
  }
  return null;
}

/** The slug of a display name: Latin letters (Cyrillic transliterated, accents dropped), digits and single `-` between them. */
function slugifyClaudeProfileLabel(label: string): string {
  const latin = Array.from(label.normalize('NFC').toLowerCase(), (character) => transliteration[character] ?? character)
    .join('')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '');
  return latin.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** `base` cut so that `suffix` still fits in an id, with no `-` left dangling at the cut. */
function fitIdBase(base: string, suffix: string): string {
  return base.slice(0, claudeProfileNameMaxLength - suffix.length).replace(/-+$/, '');
}

/**
 * @description The id (folder name) a new account with the display name `label` gets: its slug (`Sergei.Solo@work` →
 * `sergei-solo-work`, `Работа` → `rabota`), `account` when nothing of it survives, cut to {@link claudeProfileNameMaxLength}; on a clash
 * — `isTaken` says so: a known account's id, `default`, another account's display name, a folder already on disk — a number is added
 * (`work-2`, `work-3`, …). Always a valid id ({@link checkIsValidClaudeProfileName}).
 */
export function deriveClaudeProfileId(label: string, isTaken: (id: string) => boolean): string {
  const base = fitIdBase(slugifyClaudeProfileLabel(label), '') || derivedIdFallback;
  const isFree = (id: string): boolean => checkIsValidClaudeProfileName(id) && !isTaken(id);
  if (isFree(base)) return base;
  for (let number = 2; ; number += 1) {
    const suffix = `-${number}`;
    const candidate = `${fitIdBase(base, suffix) || derivedIdFallback}${suffix}`;
    if (isFree(candidate)) return candidate;
  }
}

/**
 * @description The account a typed name means (`/accounts use|login|remove <name>`): an id or a display name, case and spacing ignored;
 * an id wins over a display name (the rules keep them from clashing, an older state may not). `null` when none matches.
 */
export function findClaudeProfileByTypedName(typed: string, accounts: readonly ClaudeProfileNameEntry[]): string | null {
  const key = getComparisonKey(normaliseClaudeProfileLabel(typed));
  if (key === '') return null;
  const byId = accounts.find((account) => getComparisonKey(account.name) === key);
  if (byId) return byId.name;
  return accounts.find((account) => account.labels.some((label) => getComparisonKey(label) === key))?.name ?? null;
}

/** @description A display name as a button shows it: whole up to `max` characters, else cut there and ended with `…` (cut between characters, never inside one). */
export function shortenClaudeProfileLabel(label: string, max: number = claudeProfileButtonLabelMaxLength): string {
  const characters = Array.from(label);
  if (characters.length <= max) return label;
  return `${characters.slice(0, max - 1).join('').trimEnd()}${ellipsis}`;
}

/**
 * @description Why `name` cannot be an account id, `null` when it can: one typed by hand (`/accounts add <name> id:<id>`) is lowercased
 * first, so a capital letter is never the problem — the answer names the first character an id cannot hold.
 */
export function describeClaudeProfileIdProblem(name: string): ClaudeProfileIdProblem | null {
  if (name === '') return { kind: 'empty' };
  if (name === defaultClaudeProfileName) return { kind: 'reserved' };
  const characters = Array.from(name);
  if (!/^[a-z0-9]$/.test(characters[0])) return { kind: 'firstCharacter', character: characters[0] };
  const bad = characters.find((character) => !/^[a-z0-9_-]$/.test(character));
  if (bad !== undefined) return { kind: 'character', character: bad };
  if (characters.length > claudeProfileNameMaxLength) return { kind: 'tooLong', max: claudeProfileNameMaxLength };
  return null;
}

// ── what the screens show ──

/** «Main» — what `default` (`~/.claude`) is called until the operator renames it, in the reader's language. */
export function getMainClaudeProfileLabel(): string {
  return t('account.mainLabel');
}

/** A stored display name as it is trusted: a non-empty string (a hand-edited `state.json` may hold anything), else none. */
export function readStoredClaudeProfileLabel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const label = normaliseClaudeProfileLabel(value);
  return label === '' ? undefined : label;
}

/** @description What an account is called: its display name, else «Main» for `default`, else its id. */
export function resolveClaudeProfileLabel(name: string, storedLabel: unknown): string {
  return readStoredClaudeProfileLabel(storedLabel) ?? (name === defaultClaudeProfileName ? getMainClaudeProfileLabel() : name);
}

/** Where {@link getClaudeProfileLabel} reads an account's stored display name from (`state.json`); `undefined` = none. */
export type ClaudeProfileLabelReader = (name: string) => unknown;

let labelReader: ClaudeProfileLabelReader = () => undefined;

/** @description Register where {@link getClaudeProfileLabel} reads the stored display names from (the bot, once, at start-up). Until then every account shows its id (`default` «Main»). */
export function setClaudeProfileLabelReader(reader: ClaudeProfileLabelReader): void {
  labelReader = reader;
}

/** @description What the account `name` is called on a screen, in the active locale ({@link resolveClaudeProfileLabel} of its stored name). */
export function getClaudeProfileLabel(name: string): string {
  return resolveClaudeProfileLabel(name, labelReader(name));
}

/**
 * @description The name-rule entry of an account ({@link ClaudeProfileNameEntry}): its shown name, and — for `default` with no name of
 * its own — the English «Main» besides the localised one, so a typed `main` finds it and no other account takes that name in any UI.
 */
export function buildClaudeProfileNameEntry(name: string, storedLabel: unknown, englishMainLabel: string): ClaudeProfileNameEntry {
  const shown = resolveClaudeProfileLabel(name, storedLabel);
  const isMainShown = name === defaultClaudeProfileName && readStoredClaudeProfileLabel(storedLabel) === undefined;
  return { name, labels: isMainShown && shown !== englishMainLabel ? [shown, englishMainLabel] : [shown] };
}
