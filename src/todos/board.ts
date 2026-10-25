import { keyToString, tryKeyFromString, type SessionKey } from '../sessionKey';
import { formatLocalClock } from '../utils/localClock';
import { checkIsTodoListViewEmpty, formatOwnTodoList, getTodoListView, getTrimmedTodoTitle } from './format';
import type { TodoProject } from './projects';
import type { TodoStore } from './store';
import type { TodoTopicFile } from './types';

/**
 * @description The project board (D17–D21): what the agents of one project see of each other's lists. Every turn
 * start the bot makes carries the WHOLE board (and the agent's own list) on a fresh context, else only the peers whose
 * list changed since this agent last saw them — and nothing when none did; every `todo_*` result carries the same
 * delta. What each agent has seen is stored with ITS list (`boardSeen`), so sleep, restarts and hot reloads keep it;
 * a fresh context forgets it. A peer's change never starts a turn by itself (D21).
 */

/** D18 trimming: per peer at most this many in-work items, queued items and done items; titles cut; the block capped. */
export const boardMaxInWorkPerPeer = 5;
export const boardMaxQueuedPerPeer = 5;
export const boardMaxDonePerPeer = 5;
export const boardTitleMaxLength = 120;
export const boardMaxChars = 3000;
/** `todo_read` with the project scope asks for the board on purpose: it may be longer. */
export const boardReadMaxChars = 10_000;
/** A peer's list older than this says how old it is. */
const listAgeShownAfterMs = 60 * 60 * 1000;
const msPerMinute = 60 * 1000;
const minutesPerHour = 60;
const hoursPerDay = 24;

/**
 * @name TodoSessionActivity
 * @description How a peer's session stands: working on a turn now, live and idle, or asleep (no process).
 */
export type TodoSessionActivity = 'working' | 'idle' | 'asleep';

/** @name TodoBoardDeps @description The store, the project grouping and how the bot names and sees conversations. */
export interface TodoBoardDeps {
  store: TodoStore;
  /** The project `key`'s conversation belongs to, waiting for git where a folder's read is due (a tool call, `/todo`); `null` when it is in none (unbound). */
  getProjectOf: (key: SessionKey) => Promise<TodoProject | null>;
  /**
   * The project as known NOW, never waiting for git and never yielding (a prompt, the mid-turn poll): `null` when the
   * conversation is in none; `undefined` while the grouping is not known — a bound folder was never read.
   */
  peekProjectOf: (key: SessionKey) => TodoProject | null | undefined;
  /** How a peer is named on a board: `#topic (folder)`, `PROJ-123 «summary»`. */
  getPeerLabel: (conversationKey: string) => string;
  getSessionActivity: (conversationKey: string) => TodoSessionActivity;
  getNowMs: () => number;
}

/**
 * @name TodoBoardChanges
 * @description What changed in the project since the agent last saw it, not yet marked seen: the text a mid-turn
 * delivery carries and the peer revisions it shows.
 */
export interface TodoBoardChanges {
  text: string;
  revisions: Record<string, number>;
}

/** @name TodoBoard @description The board's deliveries; each one counts as seen. */
export interface TodoBoard {
  /**
   * The block a bot-made turn start carries (D20), or `null` when nothing is due. While the grouping is not known
   * without waiting for git, no board: a fresh context gets its own list alone, and nothing counts as seen.
   * SYNCHRONOUS on purpose: it runs between the decision to forward a prompt and the write to the agent, where an await
   * would let a stop queued meanwhile (the per-turn stop at a turn's end) begin first and take the prompt with it.
   */
  takePromptBoard(key: SessionKey): string | null;
  /** What a `todo_*` result adds after the agent's own list: the delta, or that nothing changed (D4). */
  takeToolBoard(key: SessionKey): Promise<string>;
  /** `todo_read` with the project scope: the whole board. */
  takeProjectBoard(key: SessionKey): Promise<string>;
  /** The agent lost its context (a fresh session, a compaction, `/clear`): the next board is the whole one. */
  noteFreshContext(key: SessionKey): void;
  /**
   * The changes since the agent last saw the board, WITHOUT marking them seen (a mid-turn delivery marks them once it
   * reached the agent); `null` when nothing changed, when the agent has seen no board yet (its next prompt carries
   * the whole one), or when the grouping is not known without waiting for git.
   */
  peekChanges(key: SessionKey): TodoBoardChanges | null;
  /** These peer revisions reached the agent (a mid-turn delivery). */
  markSeenRevisions(key: SessionKey, revisions: Readonly<Record<string, number>>): void;
}

/** @description `3 min ago`, `2 h ago`, `4 d ago`; under a minute: `just now`. */
export function formatTodoAge(ageMs: number): string {
  const minutes = Math.floor(ageMs / msPerMinute);
  if (minutes < 1) return 'just now';
  if (minutes < minutesPerHour) return `${minutes} min ago`;
  const hours = Math.floor(minutes / minutesPerHour);
  return hours < hoursPerDay ? `${hours} h ago` : `${Math.floor(hours / hoursPerDay)} d ago`;
}

/** @description What a peer's line says about its session and how old its list is. */
function formatPeerActivity(file: TodoTopicFile, activity: TodoSessionActivity, nowMs: number): string {
  const lastTurnEndAt = file.lastTurnEndAt;
  const sessionText = activity === 'working'
    ? 'working now'
    : activity === 'idle'
      ? `active ${lastTurnEndAt === undefined ? 'recently' : formatTodoAge(nowMs - lastTurnEndAt)}`
      : `asleep${lastTurnEndAt === undefined ? '' : ` since ${formatLocalClock(lastTurnEndAt)}`}`;
  const isListOld = file.lastUpdateAt !== undefined && nowMs - file.lastUpdateAt > listAgeShownAfterMs;
  return isListOld ? `${sessionText}, list ${formatTodoAge(nowMs - (file.lastUpdateAt ?? nowMs)).replace(' ago', '')} old` : sessionText;
}

/** @description One peer's block (D17, D18 per-peer caps). */
export function formatTodoBoardPeerBlock(label: string, file: TodoTopicFile, activity: TodoSessionActivity, nowMs: number): string {
  const view = getTodoListView(file.items, nowMs);
  const title = (text: string): string => getTrimmedTodoTitle(text, boardTitleMaxLength);
  const lines = [`${label} — ${formatPeerActivity(file, activity, nowMs)}`];
  for (const item of view.inWork.slice(0, boardMaxInWorkPerPeer)) {
    lines.push(`  ▶ ${title(item.title)}${item.startedAt === undefined ? '' : ` — since ${formatLocalClock(item.startedAt)}`}`);
  }
  if (view.inWork.length > boardMaxInWorkPerPeer) lines.push(`  ▶ (+${view.inWork.length - boardMaxInWorkPerPeer} more in work)`);
  if (view.queue.length > 0) {
    const shown = view.queue.slice(0, boardMaxQueuedPerPeer).map((item, index) => `${index + 1}. ${title(item.title)}`).join(' · ');
    const more = view.queue.length > boardMaxQueuedPerPeer ? ` (+${view.queue.length - boardMaxQueuedPerPeer} more)` : '';
    lines.push(`  ▷ queue: ${shown}${more}`);
  }
  let doneLeft = boardMaxDonePerPeer;
  for (const day of view.doneDays) {
    if (doneLeft === 0) break;
    const shown = day.items.slice(0, doneLeft);
    doneLeft -= shown.length;
    lines.push(`  ✓ ${day.date}: ${shown.map((item) => `${title(item.title)} (${formatLocalClock(item.closedAt ?? item.updatedAt)})`).join(' · ')}`);
  }
  if (checkIsTodoListViewEmpty(view)) lines.push('  nothing in work, nothing queued');
  return lines.join('\n');
}

/** @description Peer blocks under `header`, the most recently active first, within `maxChars` (D18). */
export function formatTodoBoardBlocks(header: string, blocks: ReadonlyArray<{ text: string; lastActivityAt: number }>, maxChars: number): string {
  const ordered = [...blocks].sort((left, right) => right.lastActivityAt - left.lastActivityAt);
  const shown: string[] = [];
  let length = header.length;
  for (const [index, block] of ordered.entries()) {
    const leftAfter = ordered.length - index - 1;
    const overflowLine = `… ${leftAfter} more topics: todo_read`;
    // Room for this block, and for the overflow line if more come after it.
    if (length + block.text.length + 1 + (leftAfter > 0 ? overflowLine.length + 1 : 0) > maxChars) {
      shown.push(`… ${ordered.length - index} more topics: todo_read`);
      break;
    }
    shown.push(block.text);
    length += block.text.length + 1;
  }
  return [header, ...shown].join('\n');
}

export function createTodoBoard(deps: TodoBoardDeps): TodoBoard {
  const { store, getProjectOf, peekProjectOf, getPeerLabel, getSessionActivity, getNowMs } = deps;

  /** What `project` shows `key`: its peers with a list to show (a peer that never published is left out, not listed empty), and their revisions now. */
  function locatePeers(key: SessionKey, project: TodoProject): { projectName: string; peers: Array<{ conversationKey: string; file: TodoTopicFile }> } {
    const ownKey = keyToString(key);
    const peers = project.memberKeys.flatMap((conversationKey) => {
      if (conversationKey === ownKey) return [];
      const peerKey = tryKeyFromString(conversationKey);
      if (!peerKey) return [];
      const file = store.getTopic(peerKey);
      return file.lastUpdateAt === undefined ? [] : [{ conversationKey, file }];
    });
    return { projectName: project.name, peers };
  }

  /** The peers of `key`'s project, waiting for git where a read is due; `null` = no project. */
  async function getPeers(key: SessionKey): Promise<ReturnType<typeof locatePeers> | null> {
    const project = await getProjectOf(key);
    return project === null ? null : locatePeers(key, project);
  }

  /** The peers as known now, never waiting; `null` = no project, `undefined` = not known yet. */
  function peekPeers(key: SessionKey): ReturnType<typeof locatePeers> | null | undefined {
    const project = peekProjectOf(key);
    return project === null || project === undefined ? project : locatePeers(key, project);
  }

  function renderBlocks(peers: ReadonlyArray<{ conversationKey: string; file: TodoTopicFile }>, nowMs: number) {
    return peers.map(({ conversationKey, file }) => ({
      text: formatTodoBoardPeerBlock(getPeerLabel(conversationKey), file, getSessionActivity(conversationKey), nowMs),
      lastActivityAt: Math.max(file.lastTurnEndAt ?? 0, file.changedAt ?? 0),
    }));
  }

  function formatFullBoard(projectName: string, peers: ReadonlyArray<{ conversationKey: string; file: TodoTopicFile }>, nowMs: number, maxChars: number): string {
    const header = `[Project board · ${projectName} · ${peers.length} other ${peers.length === 1 ? 'topic' : 'topics'}]`;
    return peers.length === 0 ? `${header}\nNo other topic of the project has published a list yet.` : formatTodoBoardBlocks(header, renderBlocks(peers, nowMs), maxChars);
  }

  /** Remember what `key`'s agent was just shown. */
  function markSeen(key: SessionKey, peers: ReadonlyArray<{ conversationKey: string; file: TodoTopicFile }>, nowMs: number): void {
    const revisions = Object.fromEntries(peers.map(({ conversationKey, file }) => [conversationKey, file.revision]));
    store.saveTopic(key, { ...store.getTopic(key), boardSeen: { revisions, at: nowMs } });
  }

  /** The peers whose list changed since `key`'s agent last saw them. */
  function getChangedPeers(key: SessionKey, peers: ReadonlyArray<{ conversationKey: string; file: TodoTopicFile }>) {
    const seen = store.getTopic(key).boardSeen?.revisions ?? {};
    return peers.filter(({ conversationKey, file }) => file.revision > (seen[conversationKey] ?? 0));
  }

  return {
    takePromptBoard(key) {
      // A prompt never waits for git: while the grouping is unknown it carries no board, and nothing counts as seen.
      const located = peekPeers(key);
      if (located === null) return null;
      const nowMs = getNowMs();
      const own = store.getTopic(key);
      const ownList = own.boardSeen === undefined && !checkIsTodoListViewEmpty(getTodoListView(own.items, nowMs)) ? formatOwnTodoList(own.items, nowMs) : null;
      // A fresh context still gets its own list: that needs no grouping.
      if (located === undefined) return ownList;
      if (own.boardSeen === undefined) {
        const board = located.peers.length === 0 ? null : formatFullBoard(located.projectName, located.peers, nowMs, boardMaxChars);
        markSeen(key, located.peers, nowMs);
        const parts = [board, ownList].filter((part): part is string => part !== null);
        return parts.length === 0 ? null : parts.join('\n\n');
      }
      const changed = getChangedPeers(key, located.peers);
      if (changed.length === 0) return null;
      const header = `[Project board — changes since ${formatLocalClock(own.boardSeen.at)}]`;
      const text = formatTodoBoardBlocks(header, renderBlocks(changed, nowMs), boardMaxChars);
      markSeen(key, located.peers, nowMs);
      return text;
    },

    async takeToolBoard(key) {
      const located = await getPeers(key);
      if (!located) return 'This topic is in no project (no folder bound).';
      const nowMs = getNowMs();
      const seen = store.getTopic(key).boardSeen;
      if (seen === undefined) {
        const text = formatFullBoard(located.projectName, located.peers, nowMs, boardMaxChars);
        markSeen(key, located.peers, nowMs);
        return text;
      }
      const changed = getChangedPeers(key, located.peers);
      const text = changed.length === 0
        ? `No changes in the project's other topics since ${formatLocalClock(seen.at)}.`
        : formatTodoBoardBlocks(`[Project board — changes since ${formatLocalClock(seen.at)}]`, renderBlocks(changed, nowMs), boardMaxChars);
      markSeen(key, located.peers, nowMs);
      return text;
    },

    async takeProjectBoard(key) {
      const located = await getPeers(key);
      if (!located) return 'This topic is in no project (no folder bound).';
      const nowMs = getNowMs();
      const text = formatFullBoard(located.projectName, located.peers, nowMs, boardReadMaxChars);
      markSeen(key, located.peers, nowMs);
      return text;
    },

    peekChanges(key) {
      const seen = store.getTopic(key).boardSeen;
      if (seen === undefined) return null;
      const located = peekPeers(key);
      if (!located) return null;
      const changed = getChangedPeers(key, located.peers);
      if (changed.length === 0) return null;
      return {
        text: formatTodoBoardBlocks(`[Project board — changes since ${formatLocalClock(seen.at)}]`, renderBlocks(changed, getNowMs()), boardMaxChars),
        revisions: Object.fromEntries(changed.map(({ conversationKey, file }) => [conversationKey, file.revision])),
      };
    },

    markSeenRevisions(key, revisions) {
      const file = store.getTopic(key);
      if (file.boardSeen === undefined) return;
      store.saveTopic(key, { ...file, boardSeen: { revisions: { ...file.boardSeen.revisions, ...revisions }, at: getNowMs() } });
    },

    noteFreshContext(key) {
      const file = store.getTopic(key);
      if (file.boardSeen === undefined) return;
      const withoutSeen = { ...file };
      delete withoutSeen.boardSeen;
      store.saveTopic(key, withoutSeen);
    },
  };
}
