import * as fs from 'fs';
import * as path from 'path';
import { getTodosDir } from '../todos/store';
import { keyToString, type SessionKey } from '../sessionKey';
import { checkIsPidAlive } from './jsonStreamHost';
import { shellSingleQuote } from './tmuxExec';

/**
 * @description The per-session mid-turn INBOX of a running Claude agent: text the bot wants the agent to read inside its turn, not
 * only at its next prompt. A `PostToolUse` hook (no matcher) in the launch `--settings` file prints the session's inbox file,
 * `DATA_DIR/todos/inbox/<session id>.json`, after the agent's next tool call: ready hook JSON whose `additionalContext` Claude reads
 * with that tool's result (probed on Claude Code 2.1.310). The hook moves the file before printing it, so a text is delivered once;
 * with no file it prints nothing. The directory is the project board's (it predates the accounts note); the hook command and the
 * single `PostToolUse` entry that carries it are unchanged by there being more than one kind of text in it.
 *
 * One file holds one or more SECTIONS, joined by a blank line: the accounts note (`limitNotes/`) and the project board's changes
 * (`todos/midTurn.ts`). Each section is offered and withdrawn on its own rules — a section's withdrawal never touches another's, and
 * a section is withdrawn wherever no tool call of the session can take it any more (a turn start the bot makes, a turn's end, a turn
 * held open, the session's start, stop or end) — but the FILE is taken whole: when the hook moved it, every section it held counts as
 * taken, and each section's `onTaken` fires once. A section withdrawn unseen keeps its owner's state (the board's changes stay unseen,
 * the note stays due), so the inbox dir is empty between turns. A restart forgets what was written: at worst a text is delivered
 * twice, never lost.
 *
 * Nothing here writes to an agent's input, stamps activity, wakes a session or opens a request: it writes and removes files.
 */

/** The sections of an inbox, in the order they are joined: the short accounts note first, so the cut of an over-long board never takes it. */
export const midTurnInboxSections = ['accounts', 'todoBoard'] as const;
export type MidTurnInboxSection = (typeof midTurnInboxSections)[number];

/** The inbox directory under the todos' (`DATA_DIR/todos/inbox`). */
const inboxDirName = 'inbox';
/** Claude Code caps a hook's `additionalContext`; the text is cut below it. */
export const midTurnInboxMaxChars = 10_000;
/** A session id names a file: only these characters, so no id can reach outside the inbox. */
const sessionIdRe = /^[A-Za-z0-9_-]+$/;
const inboxFileExtension = '.json';
/** A copy the hook moved aside: `<session id>.json.<the hook's process id>` (never the bot's `….tmp`). */
const takenCopyNameRe = /^[A-Za-z0-9_-]+\.json\.(\d+)$/;
/** Private: what the agents work on. */
const inboxFileMode = 0o600;
/** What joins the sections of one inbox. */
const sectionSeparator = '\n\n';

/** @description Where the inboxes live: `DATA_DIR/todos/inbox`. */
export function getMidTurnInboxDir(dataDir: string): string {
  return path.join(getTodosDir(dataDir), inboxDirName);
}

/**
 * The parse of a hook input, run by the bot's own `node` with the inbox dir as its argument: the input's TOP-LEVEL
 * fields alone decide, in whatever order they come — a tool's own input or output naming `agent_id` or `session_id`
 * is never mistaken for them. A sub-agent's call (an `agent_id`) and an id outside {@link sessionIdRe} print nothing;
 * otherwise the session's inbox is moved aside, printed and removed.
 */
const inboxHookScript = [
  'const fs = require("fs"), path = require("path");',
  'let text = "";',
  'process.stdin.setEncoding("utf8").on("data", (chunk) => { text += chunk; }).on("end", () => {',
  '  try {',
  '    const input = JSON.parse(text);',
  '    if (input === null || typeof input !== "object" || "agent_id" in input) return;',
  `    if (typeof input.session_id !== "string" || !${sessionIdRe.toString()}.test(input.session_id)) return;`,
  `    const file = path.join(process.argv[1], input.session_id + "${inboxFileExtension}"), taken = file + "." + process.pid;`,
  '    try { fs.renameSync(file, taken); } catch { return; }',
  '    process.stdout.write(fs.readFileSync(taken, "utf8"));',
  '    fs.rmSync(taken, { force: true });',
  '  } catch {}',
  '});',
].join(' ');

/**
 * @description The `PostToolUse` hook's shell command. With the inbox dir empty — nearly every tool call — it reads
 * the input whole (the CLI must never write into a closed pipe) and exits; only while an inbox waits does it start
 * `nodePath` (the bot's own, written at every launch) to parse the input ({@link inboxHookScript}). It always exits 0 —
 * a hook failure must never stop the agent's tool.
 *
 * Only the MAIN agent takes the inbox. A sub-agent's tool call fires the hook too, with the SAME `session_id` and an
 * `agent_id` of its own (measured on Claude Code 2.1.310); taken there, the text would land in the sub-agent's
 * context and count as delivered while the main agent never got it.
 */
export function buildMidTurnInboxHookCommand(inboxDir: string, nodePath: string = process.execPath): string {
  const dir = shellSingleQuote(inboxDir);
  return [
    `[ -n "$(ls -A ${dir} 2>/dev/null)" ] || { cat > /dev/null; exit 0; }`,
    `${shellSingleQuote(nodePath)} -e ${shellSingleQuote(inboxHookScript)} ${dir}`,
    'exit 0',
  ].join('; ');
}

/** @description The hook output Claude reads `text` from: `additionalContext` of a `PostToolUse` hook, within the cap. */
export function buildMidTurnInboxHookOutput(text: string): string {
  const characters = [...text];
  const fitted = characters.length <= midTurnInboxMaxChars ? text : `${characters.slice(0, midTurnInboxMaxChars - 1).join('')}…`;
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: fitted } });
}

/**
 * @name MidTurnInboxOffer
 * @description A section's text and what its owner does about it: `onTaken` — the hook took the file, the text reached the agent;
 * `onWithdrawn` — it was taken back unseen (a turn start, a turn's end, the session's end, a newer offer, boot).
 */
export interface MidTurnInboxOffer {
  text: string;
  onTaken: () => void;
  onWithdrawn?: () => void;
}

/** @name MidTurnInbox @description What the todo board's mid-turn path and the accounts engine call. */
export interface MidTurnInbox {
  /**
   * Offer `section` to the Claude session `sessionId` of the conversation, replacing the text it already waits with (the replaced
   * offer is withdrawn). `false`, nothing written, for a session id that is no file name.
   */
  offer: (key: SessionKey, sessionId: string, section: MidTurnInboxSection, offer: MidTurnInboxOffer) => boolean;
  /** Whether `section` of the conversation waits for the agent's next tool call. */
  checkIsWaiting: (key: SessionKey, section: MidTurnInboxSection) => boolean;
  /** The files the hook took since the last look: the sections they held count as taken, each `onTaken` once. One conversation's, or every one's. */
  reconcile: (key?: SessionKey) => void;
  /**
   * No tool call of the session can take `section` any more: withdrawn — counted as taken if the hook took the file meanwhile — and
   * the copies hooks that are gone moved aside and never removed go with it. Another section of the same file stays and is written
   * again without it.
   */
  withdraw: (key: SessionKey, section: MidTurnInboxSection) => void;
  /**
   * At boot: every inbox left is withdrawn — this process does not know what it carries, and a session that ended never takes its
   * own. What they carried is still unseen or still due, so the next prompt (or poll) delivers it again.
   */
  clearAll: () => void;
}

/** @name MidTurnInboxDeps @description `checkIsProcessAlive` — whether a process runs (the hook that moved a file aside, run as the bot's own user); `kill(pid, 0)` by default. */
export interface MidTurnInboxDeps {
  inboxDir: string;
  checkIsProcessAlive?: (pid: number) => boolean;
}

/** One conversation's inbox: its session's file, and the sections written into it, not yet seen taken. */
interface PendingInbox {
  sessionId: string;
  filePath: string;
  sections: Map<MidTurnInboxSection, MidTurnInboxOffer>;
}

export function createMidTurnInbox(deps: MidTurnInboxDeps): MidTurnInbox {
  const { inboxDir, checkIsProcessAlive = checkIsPidAlive } = deps;
  const pendingInboxes = new Map<string, PendingInbox>();

  function getInboxFilePath(sessionId: string): string {
    return path.join(inboxDir, `${sessionId}${inboxFileExtension}`);
  }

  function writeInbox(pending: PendingInbox): void {
    const text = midTurnInboxSections.flatMap((section) => pending.sections.get(section)?.text ?? []).join(sectionSeparator);
    fs.mkdirSync(path.dirname(pending.filePath), { recursive: true, mode: 0o700 });
    const tempPath = `${pending.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tempPath, buildMidTurnInboxHookOutput(text), { mode: inboxFileMode });
    fs.renameSync(tempPath, pending.filePath);
  }

  /** The hook took the file: every section it held counts as taken. */
  function reconcileOne(conversationKey: string): void {
    const pending = pendingInboxes.get(conversationKey);
    if (pending === undefined || fs.existsSync(pending.filePath)) return;
    pendingInboxes.delete(conversationKey);
    for (const section of midTurnInboxSections) pending.sections.get(section)?.onTaken();
  }

  /**
   * A copy the hook moved aside and never removed (its `node` ended between the move and the removal) would keep the inbox dir
   * non-empty until boot. Any session's copy goes — but only once the hook that moved it is gone: a live one may be reading it this
   * very moment, and its text already counts as taken.
   */
  function removeTakenLeftovers(): void {
    let names: string[];
    try {
      names = fs.readdirSync(inboxDir);
    } catch {
      return;
    }
    for (const name of names) {
      const hookPid = takenCopyNameRe.exec(name)?.[1];
      if (hookPid !== undefined && !checkIsProcessAlive(Number(hookPid))) fs.rmSync(path.join(inboxDir, name), { force: true });
    }
  }

  /** Withdraw every section of the conversation's inbox and remove its file. */
  function withdrawAll(conversationKey: string): void {
    const pending = pendingInboxes.get(conversationKey);
    if (pending === undefined) return;
    pendingInboxes.delete(conversationKey);
    fs.rmSync(pending.filePath, { force: true });
    for (const section of midTurnInboxSections) pending.sections.get(section)?.onWithdrawn?.();
  }

  return {
    offer(key, sessionId, section, offer) {
      if (!sessionIdRe.test(sessionId)) return false;
      const conversationKey = keyToString(key);
      reconcileOne(conversationKey);
      // Another session of the conversation (a restart, a resume under a new id) never takes the old session's file.
      if (pendingInboxes.get(conversationKey)?.sessionId !== sessionId) withdrawAll(conversationKey);
      const pending = pendingInboxes.get(conversationKey) ?? { sessionId, filePath: getInboxFilePath(sessionId), sections: new Map<MidTurnInboxSection, MidTurnInboxOffer>() };
      const replaced = pending.sections.get(section);
      pending.sections.set(section, offer);
      try {
        writeInbox(pending);
      } catch (error) {
        // The file kept its old text, so the old offer stays what the agent will read; the new one is the caller's to give back.
        if (replaced === undefined) pending.sections.delete(section);
        else pending.sections.set(section, replaced);
        throw error;
      }
      pendingInboxes.set(conversationKey, pending);
      replaced?.onWithdrawn?.();
      return true;
    },

    checkIsWaiting(key, section) {
      const conversationKey = keyToString(key);
      reconcileOne(conversationKey);
      return pendingInboxes.get(conversationKey)?.sections.has(section) === true;
    },

    reconcile(key) {
      if (key !== undefined) {
        reconcileOne(keyToString(key));
        return;
      }
      for (const conversationKey of [...pendingInboxes.keys()]) reconcileOne(conversationKey);
    },

    withdraw(key, section) {
      removeTakenLeftovers();
      const conversationKey = keyToString(key);
      reconcileOne(conversationKey);
      const pending = pendingInboxes.get(conversationKey);
      const withdrawn = pending?.sections.get(section);
      if (pending === undefined || withdrawn === undefined) return;
      pending.sections.delete(section);
      if (pending.sections.size === 0) {
        pendingInboxes.delete(conversationKey);
        fs.rmSync(pending.filePath, { force: true });
      } else {
        writeInbox(pending);
      }
      withdrawn.onWithdrawn?.();
    },

    clearAll() {
      const pendings = [...pendingInboxes.values()];
      pendingInboxes.clear();
      fs.rmSync(inboxDir, { recursive: true, force: true });
      for (const pending of pendings) for (const section of midTurnInboxSections) pending.sections.get(section)?.onWithdrawn?.();
    },
  };
}
