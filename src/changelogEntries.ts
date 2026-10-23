/**
 * One entry of a CHANGELOG section: a top-level paragraph or a top-level list item.
 *
 * `subsection` is the `###` heading in force (`Upgrading`, `Added`, …), `null` before the first one.
 * `text` is the entry's lines joined by a space, list marker removed; `leadLine` is its first line as
 * written, for quoting it in a message.
 */
export type ChangelogEntry = {
  subsection: string | null;
  text: string;
  leadLine: string;
};

const headingPattern = /^(#{1,6})\s+(.*)$/;
const subsectionHeadingLevel = 3;
const listMarkerPattern = /^(?:[-*+]|\d+[.)])\s+/;
const fencePattern = /^(?:```|~~~)/;
const boldLeadPattern = /^\*\*(?=\S)[\s\S]*?\S\*\*/;

/**
 * @description Splits the body of a CHANGELOG section into its entries.
 *
 * A top-level line (no indent) starts an entry when it opens a list item, or a paragraph after a blank
 * line / heading; an indented line and a wrapped paragraph line continue the entry above. A fenced block at
 * column 0 holds no entry. Shared by the release gate (bold-lead check) and the what's-new summary, so both
 * read the same text the same way.
 */
export function getChangelogEntries(sectionText: string): ChangelogEntry[] {
  const entries: ChangelogEntry[] = [];
  let subsection: string | null = null;
  let current: ChangelogEntry | null = null;
  let isInFence = false;

  for (const line of sectionText.split('\n')) {
    if (fencePattern.test(line)) {
      isInFence = !isInFence;
      current = null;
      continue;
    }
    if (isInFence) continue;

    if (line.trim() === '') {
      current = null;
      continue;
    }

    const heading = headingPattern.exec(line);
    if (heading) {
      if (heading[1].length >= subsectionHeadingLevel) subsection = heading[2].trim();
      current = null;
      continue;
    }

    if (/^\s/.test(line)) {
      if (current) current.text = `${current.text} ${line.trim()}`;
      continue;
    }

    const marker = listMarkerPattern.exec(line);
    if (marker) {
      current = { subsection, text: line.slice(marker[0].length).trim(), leadLine: line };
      entries.push(current);
      continue;
    }

    if (current) {
      current.text = `${current.text} ${line.trim()}`;
      continue;
    }
    current = { subsection, text: line.trim(), leadLine: line };
    entries.push(current);
  }
  return entries;
}

/** @description Whether an entry's text opens with a bold first sentence (`**…**`). */
export function checkHasBoldLead(entryText: string): boolean {
  return boldLeadPattern.test(entryText);
}
