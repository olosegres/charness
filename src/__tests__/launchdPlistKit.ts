/**
 * What the launchd tests read out of a property list this program renders (`runnerUtility/serviceUnits.ts`): the plain `<key>…</key><string>…</string>`
 * entries of the top level, and the `ProgramArguments` array. The text is the renderer's own, so a line-based reading is enough. Not a test itself.
 */

export interface ParsedPlist {
  /** Every top-level `key → string` entry. */
  strings: Map<string, string>;
  /** Every top-level key, whatever its value. */
  keys: string[];
  programArguments: string[];
}

function unescapeXml(text: string): string {
  return text.replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
}

export function parseLaunchdPlist(text: string): ParsedPlist {
  const strings = new Map<string, string>();
  const keys: string[] = [];
  const programArguments: string[] = [];
  let isInArguments = false;
  let isInEnvironment = false;
  for (const line of text.split('\n')) {
    if (line.trim() === '<array>') isInArguments = true;
    else if (line.trim() === '</array>') isInArguments = false;
    else if (line.trim() === '<dict>' && line.startsWith('  ')) isInEnvironment = true;
    else if (line.trim() === '</dict>' && line.startsWith('  ')) isInEnvironment = false;
    else if (isInArguments) programArguments.push(unescapeXml(/<string>(.*)<\/string>/.exec(line)?.[1] ?? ''));
    else if (!isInEnvironment) {
      const key = /^ {2}<key>([^<]+)<\/key>/.exec(line)?.[1];
      if (key !== undefined) {
        keys.push(key);
        const value = /<key>[^<]+<\/key><string>(.*)<\/string>/.exec(line)?.[1];
        if (value !== undefined) strings.set(key, unescapeXml(value));
      }
    }
  }
  return { strings, keys, programArguments };
}

/** The top-level keys launchd opens or enters ITSELF (before or after it hands the job to its user, which it does not document). */
export const launchdOwnPathKeys: readonly string[] = ['StandardOutPath', 'StandardErrorPath', 'StandardInPath', 'WorkingDirectory', 'RootDirectory'];
