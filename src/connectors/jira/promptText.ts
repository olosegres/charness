import type { JiraAccount } from './client';

/**
 * @description The two rules every piece of issue text follows on its way into
 * a prompt (plan J5, D15): a name or title stays on ONE line, and a body of text
 * is quoted line by line. Both keep what people wrote in the tracker from
 * passing for a block of this bot (`[Request …]`, `[Jira issue context]`, …),
 * which always starts a line.
 */

const quotedLinePrefix = '> ';
const unnamedAccount = 'someone';

/** Issue text that must stay on its line: any run of whitespace, line breaks included, becomes one space. */
export function getSingleLineText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Every line quoted — a carriage return or a Unicode line separator starts a line too. */
export function getQuotedText(text: string): string {
  return text.split(/\r\n|[\r\n\u2028\u2029]/).map((line) => `${quotedLinePrefix}${line}`).join('\n');
}

export function getAccountName(account: JiraAccount | null | undefined): string {
  return getSingleLineText(account?.displayName ?? '') || unnamedAccount;
}
