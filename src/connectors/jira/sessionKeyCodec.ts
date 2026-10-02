import {
  registerSessionKeyCodec,
  type PlatformId,
  type SessionKey,
  type SessionKeyCodec,
} from '../../sessionKey';

/** The platform id this connector answers to. */
const jiraPlatform: PlatformId = 'jira';

/**
 * @description A Jira conversation is one issue: `space` is the project key,
 * `thread` the issue key, spelled `jira:<PROJECT>:<ISSUE-KEY>` (`jira:PROJ:PROJ-12`).
 * The `jira:` prefix keeps it apart from Telegram's all-numeric shape.
 *
 * A project key is an upper-case letter followed by upper-case letters, digits
 * or `_`; the issue key must be that SAME project key, `-` and a number (the
 * back-reference `\1`). The back-reference is also what makes the slug
 * readable: with `_` as the separator `jira_MY_PROJ_MY_PROJ-12` has several
 * candidate split points, and only the one where both halves name the same
 * project matches.
 */
const projectKeyPattern = '[A-Z][A-Z0-9_]*';
const jiraKeyRe = new RegExp(`^jira:(${projectKeyPattern}):(\\1-\\d+)$`);

/** Escape a slug separator for use inside a regular expression. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function decodeJiraKey(serialized: string): SessionKey | null {
  const match = jiraKeyRe.exec(serialized);
  return match ? { platform: jiraPlatform, space: match[1], thread: match[2] } : null;
}

/**
 * @description Jira's {@link SessionKeyCodec}, including the slug inverse: a
 * key with two `:` cannot be read back from a tmux session or directory name by
 * splitting on one position (D5 of the Jira connector plan).
 */
export const jiraSessionKeyCodec: SessionKeyCodec = {
  platform: jiraPlatform,

  encode(key: SessionKey): string {
    return `jira:${key.space}:${key.thread}`;
  },

  decode(serialized: string): SessionKey {
    const key = decodeJiraKey(serialized);
    if (!key) throw new Error(`Invalid Jira SessionKey string: "${serialized}"`);
    return key;
  },

  matches(serialized: string): boolean {
    return jiraKeyRe.test(serialized);
  },

  decodeSlug(slug: string, separator: string): SessionKey | null {
    const escaped = escapeRegExp(separator);
    const match = new RegExp(`^jira${escaped}(${projectKeyPattern})${escaped}(\\1-\\d+)$`).exec(slug);
    return match ? { platform: jiraPlatform, space: match[1], thread: match[2] } : null;
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
  return jiraSessionKeyCodec.decode(`jira:${issueKey.slice(0, issueKey.lastIndexOf('-'))}:${issueKey}`);
}
