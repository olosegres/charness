import * as fs from 'fs';
import * as path from 'path';
import { keyToString, type SessionKey } from '../sessionKey';
import { checkIsPidAlive } from '../utils/jsonStreamHost';
import { shellSingleQuote } from '../utils/tmuxExec';
import { getTodosDir } from './store';
import type { TodoBoardChanges } from './board';

/**
 * @description Mid-turn delivery of the project board (D21, D22): a working agent learns of another topic's change
 * inside its turn, not only at its next prompt.
 *
 *   Claude    — a `PostToolUse` hook (no matcher) in the launch `--settings` file prints the conversation's INBOX file,
 *               `DATA_DIR/todos/inbox/<session id>.json`, after the agent's next tool call: ready hook JSON whose
 *               `additionalContext` Claude reads with that tool's result (probed on Claude Code 2.1.310). The hook
 *               moves the file before printing it, so a text is delivered once; with no file it prints nothing.
 *   OpenCode  — a note queued INTO the running turn (`AgentAdapter.queueNoteIntoRunningTurn`: `prompt_async`, read
 *               between steps, with nothing of the turn reset), never while a provider retry is waited out.
 *
 * The bot writes the inbox (atomically) only while the session works (busy, its turn not held open) and something
 * changed since the agent last saw it; the changes count as seen once the hook took the file (the next poll finds it
 * gone). A waiting inbox is withdrawn wherever no tool call of the session can take it any more — a turn start the bot
 * makes (that prompt carries the changes itself), a turn's end, a turn held open, the session's start, stop or end —
 * and its changes stay unseen for the next prompt, so the inbox dir is empty between turns. A restart forgets what was
 * written: at worst a change is delivered twice, never lost.
 */

/** What opens the note a running OpenCode turn reads (agent-facing English); the board's changes follow it. */
export const todoRunningTurnNoteHeader = '[Todo] Other topics of your project changed their lists while you work. No reply is needed.';

/** The inbox directory under the store's. */
const inboxDirName = 'inbox';
/** Claude Code caps a hook's `additionalContext`; the text is cut below it. */
export const todoInboxMaxChars = 10_000;
/** A session id names a file: only these characters, so no id can reach outside the inbox. */
const sessionIdRe = /^[A-Za-z0-9_-]+$/;
const inboxFileExtension = '.json';
/** A copy the hook moved aside: `<session id>.json.<the hook's process id>` (never the bot's `….tmp`). */
const takenCopyNameRe = /^[A-Za-z0-9_-]+\.json\.(\d+)$/;
/** Private: what the agents work on. */
const inboxFileMode = 0o600;

/** @description Where the inboxes live: `DATA_DIR/todos/inbox`. */
export function getTodoInboxDir(dataDir: string): string {
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
 * `agent_id` of its own (measured on Claude Code 2.1.310); taken there, the changes would land in the sub-agent's
 * context and count as seen while the main agent never got them.
 */
export function buildTodoInboxHookCommand(inboxDir: string, nodePath: string = process.execPath): string {
  const dir = shellSingleQuote(inboxDir);
  return [
    `[ -n "$(ls -A ${dir} 2>/dev/null)" ] || { cat > /dev/null; exit 0; }`,
    `${shellSingleQuote(nodePath)} -e ${shellSingleQuote(inboxHookScript)} ${dir}`,
    'exit 0',
  ].join('; ');
}

/** @description The hook output Claude reads `text` from: `additionalContext` of a `PostToolUse` hook, within the cap. */
export function buildTodoInboxHookOutput(text: string): string {
  const characters = [...text];
  const fitted = characters.length <= todoInboxMaxChars ? text : `${characters.slice(0, todoInboxMaxChars - 1).join('')}…`;
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: fitted } });
}

/**
 * @name TodoMidTurnDeps
 * @description The board's peek and seen marks, the conversation's live Claude session (`null` = no Claude backend
 * runs it), and the note into a running turn (`false` when the backend takes none, or the turn is not running now).
 */
export interface TodoMidTurnDeps {
  board: {
    peekChanges(key: SessionKey): Promise<TodoBoardChanges | null>;
    markSeenRevisions(key: SessionKey, revisions: Readonly<Record<string, number>>): void;
  };
  inboxDir: string;
  getClaudeSessionId: (key: SessionKey) => string | null;
  postRunningTurnNote: (key: SessionKey, text: string) => Promise<boolean>;
  /** Whether a process runs (the hook that moved an inbox aside, run as the bot's own user); `kill(pid, 0)` by default. */
  checkIsProcessAlive?: (pid: number) => boolean;
}


/** @name TodoMidTurn @description What the reminder poll and the prompt choke point call. */
export interface TodoMidTurn {
  /** The session is busy: deliver what changed since the agent last saw the board, if anything did. */
  deliverIfPending(key: SessionKey): Promise<void>;
  /** Inboxes the hook took since the last look count as seen. */
  reconcile(): void;
  /**
   * No tool call of the session can take its inbox any more (a turn start the bot makes, a turn's end, a turn held
   * open, the session's start, stop or end): a waiting inbox is withdrawn — counted as seen if the hook took it
   * meanwhile — and the copies hooks that are gone moved aside and never removed go with it.
   */
  discardInbox(key: SessionKey): void;
  /**
   * At boot: every inbox left is withdrawn — this process does not know what it carries, and a session that ended
   * never takes its own. What it carried is still unseen, so the next prompt (or poll) delivers it again.
   */
  clearInboxes(): void;
}

/** One inbox written and not yet seen taken: where, and the peer revisions it carries. */
interface PendingInbox {
  key: SessionKey;
  filePath: string;
  revisions: Readonly<Record<string, number>>;
}

/** @description Whether two revision maps name the same peers at the same revisions. */
function checkIsSameRevisions(left: Readonly<Record<string, number>>, right: Readonly<Record<string, number>>): boolean {
  const leftEntries = Object.entries(left);
  return leftEntries.length === Object.keys(right).length && leftEntries.every(([conversationKey, revision]) => right[conversationKey] === revision);
}

export function createTodoMidTurn(deps: TodoMidTurnDeps): TodoMidTurn {
  const { board, inboxDir, getClaudeSessionId, postRunningTurnNote, checkIsProcessAlive = checkIsPidAlive } = deps;
  const pendingInboxes = new Map<string, PendingInbox>();

  function reconcileOne(conversationKey: string, pending: PendingInbox): void {
    if (fs.existsSync(pending.filePath)) return;
    pendingInboxes.delete(conversationKey);
    board.markSeenRevisions(pending.key, pending.revisions);
  }

  /**
   * A copy the hook moved aside and never removed (its `node` ended between the move and the removal) would keep the
   * inbox dir non-empty until boot. Any session's copy goes — but only once the hook that moved it is gone: a live one
   * may be reading it this very moment, and its change already counts as seen.
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

  function writeInbox(filePath: string, text: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const tempPath = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tempPath, buildTodoInboxHookOutput(text), { mode: inboxFileMode });
    fs.renameSync(tempPath, filePath);
  }

  return {
    async deliverIfPending(key) {
      const conversationKey = keyToString(key);
      const pending = pendingInboxes.get(conversationKey);
      if (pending) reconcileOne(conversationKey, pending);
      const changes = await board.peekChanges(key);
      if (changes === null) return;
      const sessionId = getClaudeSessionId(key);
      if (sessionId === null) {
        // Seen only once the note is in: a refused one (no running turn, a provider retry) waits for the next poll.
        if (await postRunningTurnNote(key, `${todoRunningTurnNoteHeader}\n\n${changes.text}`)) board.markSeenRevisions(key, changes.revisions);
        return;
      }
      if (!sessionIdRe.test(sessionId)) return;
      const waiting = pendingInboxes.get(conversationKey);
      // The same changes already wait for the agent's next tool call.
      if (waiting && checkIsSameRevisions(waiting.revisions, changes.revisions)) return;
      const filePath = path.join(inboxDir, `${sessionId}${inboxFileExtension}`);
      writeInbox(filePath, changes.text);
      pendingInboxes.set(conversationKey, { key, filePath, revisions: changes.revisions });
    },

    reconcile() {
      for (const [conversationKey, pending] of pendingInboxes) reconcileOne(conversationKey, pending);
    },

    clearInboxes() {
      pendingInboxes.clear();
      fs.rmSync(inboxDir, { recursive: true, force: true });
    },

    discardInbox(key) {
      removeTakenLeftovers();
      const conversationKey = keyToString(key);
      const pending = pendingInboxes.get(conversationKey);
      if (!pending) return;
      reconcileOne(conversationKey, pending);
      if (!pendingInboxes.has(conversationKey)) return;
      pendingInboxes.delete(conversationKey);
      fs.rmSync(pending.filePath, { force: true });
    },
  };
}
