import {
  registerSessionKeyCodec,
  type PlatformId,
  type SessionKey,
  type SessionKeyCodec,
} from '../../sessionKey';

/** The platform id this connector answers to. */
const jiraPlatform: PlatformId = 'jira';

/** What the serialized key joins its parts with; a slug swaps it for its own separator. */
const keySeparator = ':';

/**
 * @description A Jira conversation is one issue: `space` is the project key,
 * `thread` the issue key, spelled `jira:<PROJECT>:<ISSUE-KEY>` (`jira:PROJ:PROJ-12`).
 * The `jira:` prefix keeps it apart from Telegram's all-numeric shape.
 *
 * A project key is an upper-case letter followed by upper-case letters, digits
 * or `_`; the issue key must be that SAME project key, `-` and a number without
 * leading zeros (the back-reference `\1`; Jira numbers issues from 1, so
 * `PROJ-012` would be a second spelling of `PROJ-12`). The back-reference is
 * also what makes the slug readable: with `_` as the separator
 * `jira_MY_PROJ_MY_PROJ-12` has several candidate split points, and only the one
 * where both halves name the same project matches.
 */
const projectKeyPattern = '[A-Z][A-Z0-9_]*';
const issueNumberPattern = '[1-9]\\d*';
const issueKeyRe = new RegExp(`^(${projectKeyPattern})-${issueNumberPattern}$`);
const projectKeyRe = new RegExp(`^${projectKeyPattern}$`);

/** @description Whether `projectKey` is spelled like a Jira project key (`PROJ`, `MY_PROJ`). */
export function checkIsJiraProjectKey(projectKey: string): boolean {
  return projectKeyRe.test(projectKey);
}

/** Escape a slug separator for use inside a regular expression. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The key's shape with `separator` between its parts — `:` for the key itself. */
function createJiraKeyRe(separator: string): RegExp {
  const escaped = escapeRegExp(separator);
  return new RegExp(`^${jiraPlatform}${escaped}(${projectKeyPattern})${escaped}(\\1-${issueNumberPattern})$`);
}

const jiraKeyRe = createJiraKeyRe(keySeparator);

/** Slug separators are a handful of fixed characters (tmux `-`, directory `_`). */
const slugKeyRes = new Map<string, RegExp>();

function getSlugKeyRe(separator: string): RegExp {
  let keyRe = slugKeyRes.get(separator);
  if (!keyRe) {
    keyRe = createJiraKeyRe(separator);
    slugKeyRes.set(separator, keyRe);
  }
  return keyRe;
}

function getJiraKeyFromMatch(match: RegExpExecArray | null): SessionKey | null {
  return match ? { platform: jiraPlatform, space: match[1], thread: match[2] } : null;
}

/**
 * @description Jira's {@link SessionKeyCodec}, including the slug inverse: a
 * key with two `:` cannot be read back from a tmux session or directory name by
 * splitting on one position (D5 of the Jira connector plan).
 */
export const jiraSessionKeyCodec: SessionKeyCodec = {
  platform: jiraPlatform,

  // Refuses a key it could not decode again: `state.json` would otherwise drop
  // its fields silently at the next load, and its tmux session would be neither
  // re-adopted nor reaped.
  encode(key: SessionKey): string {
    const serialized = [jiraPlatform, key.space, key.thread].join(keySeparator);
    if (!jiraKeyRe.test(serialized)) throw new Error(`Invalid Jira SessionKey: "${serialized}"`);
    return serialized;
  },

  decode(serialized: string): SessionKey {
    const key = getJiraKeyFromMatch(jiraKeyRe.exec(serialized));
    if (!key) throw new Error(`Invalid Jira SessionKey string: "${serialized}"`);
    return key;
  },

  matches(serialized: string): boolean {
    return jiraKeyRe.test(serialized);
  },

  decodeSlug(slug: string, separator: string): SessionKey | null {
    return getJiraKeyFromMatch(getSlugKeyRe(separator).exec(slug));
  },
};

/**
 * Self-registering on import, like the Telegram codec; the composition roots
 * (`bot.ts`, the test bootstrap) import it so a Jira key read back from
 * `state.json` or a tmux name decodes even before any Jira module loads.
 */
registerSessionKeyCodec(jiraSessionKeyCodec);

/**
 * @description Build a Jira {@link SessionKey} for an issue. The project key is
 * the issue key's own prefix, so it is derived rather than passed separately.
 * Throws for a string that is not an issue key.
 */
export function makeJiraKey(issueKey: string): SessionKey {
  const match = issueKeyRe.exec(issueKey);
  if (!match) throw new Error(`Invalid Jira issue key: "${issueKey}"`);
  return { platform: jiraPlatform, space: match[1], thread: issueKey };
}
