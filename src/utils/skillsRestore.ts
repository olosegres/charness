/**
 * @description What the bot puts back into an agent's context after a compaction so that the skills it had loaded keep
 * applying — the owner's guarantee that a compaction never leaves an agent without the procedures it was following (plan
 * `2026-11-12-skills-reload-after-compaction`, S2). Pure: no file is read here; the Claude hook
 * (`hooks/claudeSkillsRestoreHook.ts`) reads the transcript and the skill files and hands them in, and the OpenCode plugin
 * (`openCodeCompactPlugin.ts`) embeds the self-contained renderers below.
 *
 *   skills   = what the records show was loaded (newest first) ∪ what the summary's block names (OpenCode)
 *   resolve  = each skill's CURRENT text, or "not available now", or "load it with the tool"
 *   payload  = {@link skillsRestoreHeader}, the list (every skill, with where its text is), then each restored skill whole
 *
 * Claude: the transcript records, read back to the previous compaction — a skill loaded with the Skill tool or a slash
 * command (its `Base directory for this skill: <dir>` message), Claude's own re-attach of the previous compaction
 * (`invoked_skills`, which carries older epochs) and the bot's previous restore (which carries what Claude's re-attach
 * dropped). A skill Claude re-attaches whole and current is only named (its text is in the context already).
 */

import path from 'path';
import { skillsRestoreHeader } from './compactOnIdle';
import { checkIsRecord } from './checkIsRecord';

/** How a skill comes back. */
export type SkillsRestoreStatus = 'text' | 'inContext' | 'unavailable' | 'loadWithTool';

/** One skill of the restore: its name, where its text is, and that text when the restore carries it. */
export interface SkillsRestoreEntry {
  name: string;
  status: SkillsRestoreStatus;
  /** The folder of its `SKILL.md`, when known. */
  baseDir: string | null;
  /** The skill's current text (frontmatter stripped), for {@link SkillsRestoreStatus} `text` only. */
  body: string | null;
}

/**
 * The agent-facing wording of the restore (English: an agent reads it, whatever the topic's language). One object, so the
 * OpenCode plugin can carry it as JSON into the self-contained renderers it embeds.
 */
export interface SkillsRestoreTexts {
  header: string;
  /** A part's place among the parts: `{i}` of `{n}`. */
  partLabel: string;
  intro: string;
  /** Added to the intro when the restore comes in more than one part. */
  multiPartNote: string;
  listHeading: string;
  listContinuedHeading: string;
  statuses: Record<SkillsRestoreStatus, string>;
  baseDirSuffix: string;
  sectionHeading: string;
  sectionContinued: string;
  baseDirLine: string;
}

/**
 * The words of the restore. `{tool}` is the backend's skill tool (`Skill` / `skill`), `{dir}` a base directory, `{name}` a
 * skill, `{i}` / `{n}` a part's number and the count, `{previous}` the part a long skill continues from.
 */
export const skillsRestoreTexts: SkillsRestoreTexts = {
  header: skillsRestoreHeader,
  partLabel: '(part {i} of {n})',
  intro: 'These skills were loaded in this conversation before the compaction and stay in force: keep following them. Do not load them again with the {tool} tool, except where a line below says so.',
  multiPartNote: 'This restore comes in several parts, labelled with their numbers, which may appear in any order: a skill too long for one part goes on in the part with the next number.',
  listHeading: 'Skills loaded before the compaction (newest first):',
  listContinuedHeading: 'Skills loaded before the compaction (continued):',
  statuses: {
    text: 'its current full text is below',
    inContext: 'its full text is already in your context',
    unavailable: 'was loaded before but is not available now',
    loadWithTool: 'not restored here: load it with the {tool} tool',
  },
  baseDirSuffix: ' (base directory: {dir})',
  sectionHeading: '## Skill: {name}',
  sectionContinued: '## Skill: {name} (continued from part {previous})',
  baseDirLine: 'Base directory for this skill: {dir}',
};

/** The name of the skill tool of each backend, as the restore tells the agent to use it. */
export const claudeSkillToolName = 'Skill';
export const openCodeSkillToolName = 'skill';

/**
 * @description The lines of the restore's list — the intro and every skill with where its text is — before any skill text.
 * Self-contained (it reads nothing outside its parameters): the OpenCode plugin embeds its source.
 */
export function renderSkillsRestoreList(entries: readonly SkillsRestoreEntry[], texts: SkillsRestoreTexts, toolName: string): string[] {
  const lines = [texts.intro.split('{tool}').join(toolName), '', texts.listHeading];
  for (const entry of entries) {
    const status = texts.statuses[entry.status].split('{tool}').join(toolName);
    const suffix = entry.baseDir === null ? '' : texts.baseDirSuffix.split('{dir}').join(entry.baseDir);
    lines.push(`- ${entry.name}: ${status}${suffix}`);
  }
  return lines;
}

/**
 * @description The lines of one restored skill: its heading, its base directory (the line Claude's own skill message opens
 * with, so relative paths in the skill resolve as they did) and its text. Self-contained, as {@link renderSkillsRestoreList}.
 */
export function renderSkillsRestoreSection(entry: SkillsRestoreEntry, texts: SkillsRestoreTexts): string[] {
  const lines = [texts.sectionHeading.split('{name}').join(entry.name)];
  if (entry.baseDir !== null) lines.push(texts.baseDirLine.split('{dir}').join(entry.baseDir));
  lines.push('');
  return lines.concat((entry.body ?? '').split('\n'));
}

/**
 * @description The whole restore as ONE text (OpenCode: no size limit, one part): the header, the list, then every skill
 * whose status is `text`, whole. `''` when there is no skill — nothing is added at all. Self-contained (it calls only the
 * two renderers above), as the plugin embeds it.
 */
export function buildSkillsRestoreText(entries: readonly SkillsRestoreEntry[], texts: SkillsRestoreTexts, toolName: string): string {
  if (entries.length === 0) return '';
  const blocks = [[texts.header].concat(renderSkillsRestoreList(entries, texts, toolName)).join('\n')];
  for (const entry of entries) {
    if (entry.status === 'text') blocks.push(renderSkillsRestoreSection(entry, texts).join('\n'));
  }
  return blocks.join('\n\n');
}

/**
 * How many `SessionStart` hook slots carry the Claude restore, and how long each part may be. Claude Code caps what ONE hook
 * adds at 10,000 characters (a longer one becomes a file and a 2,000-character preview); several hooks of one event each
 * get their own cap. Measured on Claude Code 2.1.322 (`-p`, stream-json, a manual `/compact`): 24 slots of 9,500 characters
 * each, all full, reached the next model request whole — 228,000 characters, no preview, no total cap (the parts arrive in
 * the order the hooks finished, not by slot number: hence the part labels). A slot with nothing to say prints nothing and
 * costs nothing.
 */
export const skillsRestoreSlotCount = 24;
export const skillsRestorePartMaxChars = 9_500;

/** A section of the Claude restore before it is cut into parts: the list, or one skill. */
interface RestoreSection {
  /** `null`: the list. */
  skillName: string | null;
  lines: string[];
}

/** Room a line takes in a part: its characters and its newline. */
function getLineCost(line: string): number {
  return line.length + 1;
}

/**
 * @description Cut `sections` into parts of at most `capacity` characters each (label not included): a section goes whole
 * into the current part when it fits, else whole into a new one; a section longer than a part goes on over several, cut only
 * at line ends — a line too long even for a part of its own is cut where the part ends — and every piece after the first
 * opens with a "continued from part N" heading, since the parts reach the agent in no fixed order. The parts' lines, in
 * order; their count may exceed any slot limit (the caller checks).
 */
function packRestoreSections(sections: readonly RestoreSection[], texts: SkillsRestoreTexts, capacity: number): string[][] {
  const parts: string[][] = [];
  let current: string[] = [];
  let used = 0;
  const push = (line: string): void => {
    current.push(line);
    used += getLineCost(line);
  };
  const flush = (): void => {
    if (current.length === 0) return;
    parts.push(current);
    current = [];
    used = 0;
  };
  for (const section of sections) {
    const separatorCost = current.length > 0 ? getLineCost('') : 0;
    const sectionCost = section.lines.reduce((sum, line) => sum + getLineCost(line), 0);
    if (used + separatorCost + sectionCost <= capacity) {
      if (separatorCost > 0) push('');
      for (const line of section.lines) push(line);
      continue;
    }
    flush();
    const continuedHeading = section.skillName === null ? texts.listContinuedHeading : texts.sectionContinued.split('{name}').join(section.skillName);
    for (const line of section.lines) {
      let rest = line;
      while (used + getLineCost(rest) > capacity) {
        const headingCost = getLineCost(continuedHeading.split('{previous}').join(String(parts.length + 1)));
        // Only a line that would not fit a new part either is cut; any other moves whole to the next part.
        if (getLineCost(rest) + headingCost > capacity) {
          const room = capacity - used - 1;
          if (room > 0) {
            push(rest.slice(0, room));
            rest = rest.slice(room);
          }
        }
        flush();
        push(continuedHeading.split('{previous}').join(String(parts.length)));
      }
      push(rest);
    }
  }
  flush();
  return parts;
}

/** @description The label line a part opens with: the header, and `(part i of n)` when the restore has more than one part. */
function renderRestorePartLabel(texts: SkillsRestoreTexts, partNumber: number, partCount: number): string {
  return partCount > 1 ? `${texts.header} ${texts.partLabel.split('{i}').join(String(partNumber)).split('{n}').join(String(partCount))}` : texts.header;
}

/**
 * @description The Claude restore as the parts its `SessionStart` hook slots print, each at most `partMaxChars` long, label
 * included. Every restored skill goes in WHOLE, newest first; one that would no longer fit into `slotCount` parts gets the
 * "load it with the tool" line instead (the newer skills are kept first). `[]` when there is no skill.
 */
export function buildClaudeSkillsRestoreParts(entries: readonly SkillsRestoreEntry[], texts: SkillsRestoreTexts, slotCount: number, partMaxChars: number): string[] {
  if (entries.length === 0) return [];
  // The label is counted at its longest (the slot count as the part count), then written exact.
  const capacity = partMaxChars - getLineCost(renderRestorePartLabel(texts, slotCount, slotCount));
  const pack = (decided: readonly SkillsRestoreEntry[], isWithMultiPartNote: boolean): string[][] => {
    const list = renderSkillsRestoreList(decided, texts, claudeSkillToolName);
    if (isWithMultiPartNote) list.splice(1, 0, texts.multiPartNote);
    const sections: RestoreSection[] = [{ skillName: null, lines: list }];
    for (const entry of decided) {
      if (entry.status === 'text') sections.push({ skillName: entry.name, lines: renderSkillsRestoreSection(entry, texts) });
    }
    return packRestoreSections(sections, texts, capacity);
  };
  const countParts = (decided: readonly SkillsRestoreEntry[]): number => pack(decided, true).length;
  const withoutText = (entry: SkillsRestoreEntry): SkillsRestoreEntry => ({ ...entry, status: 'loadWithTool', body: null });
  // Newest first: a skill keeps its text only while the restore with it (and the newer ones kept) still fits the slots.
  let decided = entries.map((entry) => ({ ...entry }));
  for (let index = 0; index < decided.length; index += 1) {
    if (decided[index].status !== 'text') continue;
    const tried = decided.map((entry, entryIndex) => (entryIndex > index && entry.status === 'text' ? withoutText(entry) : entry));
    if (countParts(tried) > slotCount) decided[index] = withoutText(decided[index]);
  }
  // The list lines changed with the statuses; should that tip the count over, the oldest restored skills go.
  while (countParts(decided) > slotCount) {
    const oldestTextIndex = decided.map((entry) => entry.status).lastIndexOf('text');
    if (oldestTextIndex < 0) break;
    decided = decided.map((entry, entryIndex) => (entryIndex === oldestTextIndex ? withoutText(entry) : entry));
  }
  // The note only matters with several parts; without it a restore that took several could fit one, and then needs none.
  const noted = pack(decided, true);
  const parts = noted.length > 1 ? noted : pack(decided, false);
  return parts.map((lines, index) => `${renderRestorePartLabel(texts, index + 1, parts.length)}\n${lines.join('\n')}`);
}

// ── Claude: what the transcript shows ──

/** The line Claude's own skill message opens with (and the content of its re-attach). */
export const claudeSkillBaseDirPrefix = 'Base directory for this skill: ';

/**
 * What Claude's own re-attach writes in place of the rest of a skill it cut. Measured on Claude Code 2.1.322: a
 * 23,890-character skill was re-attached as its first 20,000 characters ending in
 * `\n\n[... skill content truncated for compaction; use Read on the skill path if you need the full text]`.
 */
const claudeReattachTruncationNotice = '[... skill content truncated for compaction';

/**
 * Claude Code's own re-attach after a compaction ({@link https://code.claude.com/docs/en/skills#skill-content-lifecycle}:
 * "keeping the first 5,000 tokens of each", "a combined budget of 25,000 tokens", "starting from the most recently invoked
 * skill"), measured in characters on Claude Code 2.1.322: a skill's message (the `Base directory…` line and the body) of
 * 13,838 characters came back whole and one of 23,890 was cut to 20,000; of six 18,798-character skills the five newest came
 * back (93,990 characters) and the oldest was dropped. The bot's estimate: whole up to 20,000 characters each, newest first,
 * while the running sum (a cut skill counted at 20,000) stays within 100,000 — and it stops at the first that does not fit,
 * so a skill the estimate is unsure of gets its full text from the bot rather than none.
 */
export const claudeReattachSkillMaxChars = 20_000;
export const claudeReattachBudgetChars = 100_000;

/** One load of a skill the transcript shows: its name, folder, and the text the session holds for it. */
export interface ClaudeSkillLoad {
  name: string;
  baseDir: string;
  /** Claude's skill message: the `Base directory…` line, a blank line and the body — whole, or cut by a re-attach. */
  heldContent: string;
}

/** A skill the bot's previous restore named. */
export interface RestoredSkillMention {
  name: string;
  baseDir: string | null;
}

/** What the records since the previous compaction show about the skills. */
export interface ClaudeEpochSkills {
  /** Loads since the previous compaction (Skill tool or slash command), newest first, one per skill. */
  loads: ClaudeSkillLoad[];
  /** Claude's own re-attach at the previous compaction (`invoked_skills`), in its order (newest first). */
  reattached: ClaudeSkillLoad[];
  /** The bot's previous restore, in its order. */
  previousRestore: RestoredSkillMention[];
}

/**
 * The keys a transcript line must carry to matter to {@link collectClaudeEpochSkills} — checked on the raw line before
 * `JSON.parse`, as a transcript can be a hundred megabytes and almost none of it is about skills.
 */
const claudeSkillRecordKeys = ['"Skill"', claudeSkillBaseDirPrefix, '<command-name>', '"invoked_skills"', '"hook_additional_context"'];

/** @description Whether a raw transcript line can matter to {@link collectClaudeEpochSkills}. */
export function checkIsClaudeSkillRecordLine(line: string): boolean {
  return claudeSkillRecordKeys.some((key) => line.includes(key));
}

const commandNameRe = /<command-name>\/?([^<\s]+)<\/command-name>/;

/** The text of a message's content: a string, or its `text` blocks joined. */
function readMessageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((block) => (checkIsRecord(block) && block.type === 'text' && typeof block.text === 'string' ? block.text : '')).join('');
}

/** @description The folder a skill message names in its first line, or `null` when the text is no skill message. */
export function readSkillMessageBaseDir(text: string): string | null {
  if (!text.startsWith(claudeSkillBaseDirPrefix)) return null;
  const firstLine = text.slice(claudeSkillBaseDirPrefix.length).split('\n')[0].trim();
  return firstLine === '' ? null : firstLine;
}

/** @description The body of a skill message: what follows its `Base directory…` line and the blank line after it. */
export function readSkillMessageBody(text: string): string {
  const newlineAt = text.indexOf('\n');
  return newlineAt < 0 ? '' : text.slice(newlineAt + 1).replace(/^\n+/, '');
}

/** A skill name as the CLI writes it in a slash command or the Skill tool's input: without the leading slash. */
function normalizeSkillName(name: string): string {
  return name.trim().replace(/^\//, '');
}

/**
 * @description The skills named by the list of a restore the bot wrote earlier ({@link renderSkillsRestoreList}), from the
 * texts the hook gave (`hook_additional_context`): every `- <name>: …` line under the list's heading, with its base directory
 * when the line gives one. Lines of a skill's text never count — they come after the list. `[]` for texts that hold no
 * restore of ours.
 */
export function parseSkillsRestoreList(contextTexts: readonly string[], texts: SkillsRestoreTexts = skillsRestoreTexts): RestoredSkillMention[] {
  const mentions: RestoredSkillMention[] = [];
  const suffixParts = texts.baseDirSuffix.split('{dir}');
  for (const contextText of contextTexts) {
    if (!contextText.startsWith(texts.header)) continue;
    const lines = contextText.split('\n');
    let isInList = false;
    for (const line of lines) {
      if (line === texts.listHeading || line === texts.listContinuedHeading) {
        isInList = true;
        continue;
      }
      if (!isInList) continue;
      if (!line.startsWith('- ')) {
        if (line.trim() === '') isInList = false;
        continue;
      }
      const nameEnd = line.indexOf(': ', 2);
      if (nameEnd < 0) continue;
      const name = line.slice(2, nameEnd);
      if (name === '' || /\s/.test(name) || mentions.some((mention) => mention.name === name)) continue;
      const suffixAt = line.lastIndexOf(suffixParts[0]);
      const baseDir = suffixAt > nameEnd && line.endsWith(suffixParts[1]) ? line.slice(suffixAt + suffixParts[0].length, line.length - suffixParts[1].length) : null;
      mentions.push({ name, baseDir: baseDir === '' ? null : baseDir });
    }
  }
  return mentions;
}

/** A load collected in the order the records come, before the newest-first ordering. */
interface OrderedLoad {
  name: string;
  baseDir: string;
  heldContent: string;
}

/** @description Keep the LAST load of each name (the records come oldest first) and order them newest first. */
function getNewestFirstLoads(orderedLoads: readonly OrderedLoad[]): ClaudeSkillLoad[] {
  const seen = new Set<string>();
  const newestFirst: ClaudeSkillLoad[] = [];
  for (let index = orderedLoads.length - 1; index >= 0; index -= 1) {
    const load = orderedLoads[index];
    if (seen.has(load.name)) continue;
    seen.add(load.name);
    newestFirst.push(load);
  }
  return newestFirst;
}

/**
 * @description Read the skills out of the transcript lines since the previous compaction (oldest first, as in the file).
 * A load is the skill message the CLI writes after a SUCCESSFUL load — `isMeta`, opening `Base directory for this skill:
 * <dir>` — so a failed Skill call (no such message) counts for nothing. Its name: the Skill tool's `skill` input of the call
 * the message answers (`sourceToolUseID`), else the slash command the message follows (`<command-name>/name</command-name>`
 * in the record its `parentUuid` names — measured on Claude Code 2.1.322), else the folder's name. A sub-agent's records
 * (`isSidechain`) and lines that are no records are skipped.
 */
export function collectClaudeEpochSkills(epochLines: readonly string[]): ClaudeEpochSkills {
  const toolSkillNames = new Map<string, string>();
  const loads: OrderedLoad[] = [];
  let reattached: ClaudeSkillLoad[] = [];
  let previousRestore: RestoredSkillMention[] = [];
  /** The slash command each user record holds, by the record's `uuid`: what a skill message's `parentUuid` points at. */
  const commandNamesByUuid = new Map<string, string>();
  for (const line of epochLines) {
    if (!checkIsClaudeSkillRecordLine(line)) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!checkIsRecord(record) || record.isSidechain === true) continue;
    const message = checkIsRecord(record.message) ? record.message : null;
    if (record.type === 'assistant' && message && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (!checkIsRecord(block) || block.type !== 'tool_use' || block.name !== claudeSkillToolName || typeof block.id !== 'string') continue;
        const input = checkIsRecord(block.input) ? block.input : null;
        if (input && typeof input.skill === 'string') toolSkillNames.set(block.id, normalizeSkillName(input.skill));
      }
      continue;
    }
    if (record.type === 'user' && message) {
      const text = readMessageText(message.content);
      const baseDir = record.isMeta === true ? readSkillMessageBaseDir(text) : null;
      if (baseDir !== null) {
        const toolName = typeof record.sourceToolUseID === 'string' ? toolSkillNames.get(record.sourceToolUseID) : undefined;
        const commandName = typeof record.parentUuid === 'string' ? commandNamesByUuid.get(record.parentUuid) : undefined;
        loads.push({ name: toolName ?? commandName ?? path.basename(baseDir), baseDir, heldContent: text });
        continue;
      }
      const commandName = record.isMeta === true ? undefined : commandNameRe.exec(text)?.[1];
      if (commandName !== undefined && typeof record.uuid === 'string') commandNamesByUuid.set(record.uuid, normalizeSkillName(commandName));
      continue;
    }
    if (record.type !== 'attachment' || !checkIsRecord(record.attachment)) continue;
    const attachment = record.attachment;
    if (attachment.type === 'invoked_skills' && Array.isArray(attachment.skills)) {
      reattached = getNewestFirstLoads(
        attachment.skills
          .flatMap((skill): OrderedLoad[] => {
            if (!checkIsRecord(skill) || typeof skill.name !== 'string' || typeof skill.content !== 'string') return [];
            const skillBaseDir = readSkillMessageBaseDir(skill.content);
            return skillBaseDir === null ? [] : [{ name: normalizeSkillName(skill.name), baseDir: skillBaseDir, heldContent: skill.content }];
          })
          .reverse(),
      );
    }
    if (attachment.type === 'hook_additional_context' && Array.isArray(attachment.content)) {
      const restored = parseSkillsRestoreList(attachment.content.filter((item): item is string => typeof item === 'string'));
      if (restored.length > 0) previousRestore = restored;
    }
  }
  return { loads: getNewestFirstLoads(loads), reattached, previousRestore };
}

/** @description Whether Claude's re-attach cut this skill message. */
function checkIsReattachCut(heldContent: string): boolean {
  return heldContent.includes(claudeReattachTruncationNotice);
}

/**
 * @description The skills Claude's own re-attach will carry WHOLE after this compaction, by the measured rule
 * ({@link claudeReattachSkillMaxChars}, {@link claudeReattachBudgetChars}): the most recent load of each skill — this epoch's,
 * then the previous re-attach's — newest first, until the first that does not fit. Name → the text Claude holds for it.
 */
export function getClaudeReattachedWholeSkills(epoch: ClaudeEpochSkills): Map<string, string> {
  const whole = new Map<string, string>();
  const seen = new Set<string>();
  let usedChars = 0;
  for (const load of [...epoch.loads, ...epoch.reattached]) {
    if (seen.has(load.name)) continue;
    seen.add(load.name);
    usedChars += Math.min(load.heldContent.length, claudeReattachSkillMaxChars);
    if (usedChars > claudeReattachBudgetChars) break;
    if (load.heldContent.length <= claudeReattachSkillMaxChars && !checkIsReattachCut(load.heldContent)) whole.set(load.name, load.heldContent);
  }
  return whole;
}

/** @description A `SKILL.md`'s body as the CLI loads it: the frontmatter (between the first two `---` lines) and the blank lines after it dropped. */
export function stripSkillFrontmatter(fileText: string): string {
  const text = fileText.replace(/\r\n/g, '\n');
  if (!text.startsWith('---\n')) return text.replace(/^\n+/, '');
  const closingAt = text.indexOf('\n---', 3);
  if (closingAt < 0) return text;
  const afterClosing = text.indexOf('\n', closingAt + 4);
  return afterClosing < 0 ? '' : text.slice(afterClosing + 1).replace(/^\n+/, '');
}

/** What the hook can learn about a skill's folder now. */
export interface SkillFolderReader {
  /** The `SKILL.md` of `baseDir`, or `null` when it is gone or unreadable. */
  readSkillFile(baseDir: string): string | null;
}

/**
 * @description The Claude restore's entries, newest first: every skill this epoch loaded, Claude's previous re-attach carried
 * and the bot's previous restore named. A skill whose folder is inside `unavailableDir` (the bot's own skills, when this
 * process was started without them) or whose `SKILL.md` is gone is "not available now"; one Claude re-attaches whole with the
 * text that is on disk now is only named; any other comes back with its CURRENT text; a name with no known folder gets the
 * "load it with the tool" line.
 */
export function planClaudeSkillsRestore(epoch: ClaudeEpochSkills, folders: SkillFolderReader, unavailableDir: string | null): SkillsRestoreEntry[] {
  const reattachedWhole = getClaudeReattachedWholeSkills(epoch);
  const candidates: RestoredSkillMention[] = [];
  for (const mention of [...epoch.loads, ...epoch.reattached, ...epoch.previousRestore]) {
    const known = candidates.find((candidate) => candidate.name === mention.name);
    if (known === undefined) candidates.push({ name: mention.name, baseDir: mention.baseDir });
    else if (known.baseDir === null) known.baseDir = mention.baseDir;
  }
  return candidates.map((candidate): SkillsRestoreEntry => {
    const { name, baseDir } = candidate;
    if (baseDir === null) return { name, status: 'loadWithTool', baseDir: null, body: null };
    const isInUnavailableDir = unavailableDir !== null && (baseDir === unavailableDir || baseDir.startsWith(`${unavailableDir}${path.sep}`));
    const fileText = isInUnavailableDir ? null : folders.readSkillFile(baseDir);
    if (fileText === null) return { name, status: 'unavailable', baseDir, body: null };
    const body = stripSkillFrontmatter(fileText);
    const held = reattachedWhole.get(name);
    if (held !== undefined && readSkillMessageBody(held).trim() === body.trim()) return { name, status: 'inContext', baseDir, body: null };
    return { name, status: 'text', baseDir, body };
  });
}

// ── OpenCode: what the session's history and the server show ──

/** One part of an OpenCode message, as far as the restore reads it: a `skill` tool call and how it ended. */
export interface OpenCodeRestorePart {
  type?: string;
  tool?: string;
  state?: { status?: string; input?: { name?: string }; metadata?: { name?: string; dir?: string } };
}

/** One message of an OpenCode session (the server's `{info, parts}`), as far as the restore reads it. */
export interface OpenCodeRestoreMessage {
  info?: { role?: string };
  parts?: OpenCodeRestorePart[];
}

/** A skill the OpenCode server offers now (`GET /skill`): its name, the path of its `SKILL.md`, its body. */
export interface OpenCodeAvailableSkill {
  name: string;
  location: string;
  content: string;
}

/** A skill a session loaded: its name and folder (when the call recorded it). */
export interface LoadedSkillMention {
  name: string;
  baseDir: string | null;
}

/**
 * @description The skills an OpenCode session loaded, newest first, one per name: every COMPLETED `skill` tool call in
 * `messages` (a failed one loaded nothing), named by the call's own record (`metadata.name`, else its input) with the folder
 * it recorded. Self-contained (it reads nothing outside its parameters): the OpenCode plugin embeds its source.
 */
export function getOpenCodeLoadedSkills(messages: readonly OpenCodeRestoreMessage[]): LoadedSkillMention[] {
  const loaded: LoadedSkillMention[] = [];
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const parts = messages[messageIndex].parts ?? [];
    for (let partIndex = parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = parts[partIndex];
      if (part.type !== 'tool' || part.tool !== 'skill' || part.state?.status !== 'completed') continue;
      const name = part.state.metadata?.name ?? part.state.input?.name;
      if (typeof name !== 'string' || name === '' || loaded.some((mention) => mention.name === name)) continue;
      const dir = part.state.metadata?.dir;
      loaded.push({ name, baseDir: typeof dir === 'string' && dir !== '' ? dir : null });
    }
  }
  return loaded;
}

/**
 * @description The OpenCode restore's entries: the skills the history shows loaded (newest first), then the ones only the
 * summary's block names. A skill whose call is already in what the model sees after the summary (the compaction's retained
 * tail, or loaded again since) is only named; one the server offers now comes back with its CURRENT text; one it does not
 * offer is "not available now"; with no answer from the server (`available` `null`) every other skill gets the "load it with
 * the tool" line. Self-contained, as {@link getOpenCodeLoadedSkills}.
 */
export function planOpenCodeSkillsRestore(input: {
  loaded: readonly LoadedSkillMention[];
  blockNames: readonly string[];
  inContextNames: readonly string[];
  available: readonly OpenCodeAvailableSkill[] | null;
}): SkillsRestoreEntry[] {
  const mentions: LoadedSkillMention[] = input.loaded.slice();
  for (const name of input.blockNames) {
    if (!mentions.some((mention) => mention.name === name)) mentions.push({ name, baseDir: null });
  }
  return mentions.map((mention): SkillsRestoreEntry => {
    const offered = input.available === null ? undefined : input.available.find((skill) => skill.name === mention.name);
    const offeredDir = offered === undefined ? null : offered.location.slice(0, Math.max(offered.location.lastIndexOf('/'), 0)) || null;
    const baseDir = offeredDir ?? mention.baseDir;
    if (input.inContextNames.includes(mention.name)) return { name: mention.name, status: 'inContext', baseDir, body: null };
    if (input.available === null) return { name: mention.name, status: 'loadWithTool', baseDir, body: null };
    if (offered === undefined) return { name: mention.name, status: 'unavailable', baseDir, body: null };
    return { name: mention.name, status: 'text', baseDir, body: offered.content };
  });
}
