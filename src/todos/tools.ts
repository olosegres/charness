import type { SessionKey } from '../sessionKey';
import type { TodoBoard } from './board';
import type { TodoUpdateArgs } from './merge';
import type { TodoReadArgs, TodoRegistry, TodoToolOutcome } from './registry';

/**
 * @description What `todo_update` and `todo_read` answer (D4, D5): the registry's own-list answer, followed by what
 * changed in the project's other topics since this agent last saw them — every update is an overlap check. With the
 * project scope `todo_read` answers the whole board instead.
 */
export interface TodoTools {
  update(key: SessionKey, args: TodoUpdateArgs): Promise<TodoToolOutcome>;
  read(key: SessionKey, args: TodoReadArgs): Promise<TodoToolOutcome>;
}

/**
 * @name TodoToolsDeps
 * @description The registry, the board, and what to do once a result showed the agent the board's changes: a
 * mid-turn inbox carrying the same changes is withdrawn (`midTurn.ts` `discardInbox`), or the next tool call would
 * print them a second time.
 */
export interface TodoToolsDeps {
  registry: TodoRegistry;
  board: TodoBoard;
  onBoardShown?: (key: SessionKey) => void;
}

export function createTodoTools(deps: TodoToolsDeps): TodoTools {
  const { registry, board, onBoardShown } = deps;

  /** The board text a result carries; the agent has seen it now. */
  async function takeBoard(key: SessionKey, take: (key: SessionKey) => Promise<string>): Promise<string> {
    const text = await take(key);
    onBoardShown?.(key);
    return text;
  }

  /** The own-list answer, then the board's delta; a refusal stays as it is (nothing was seen). */
  async function withBoard(key: SessionKey, outcome: TodoToolOutcome): Promise<TodoToolOutcome> {
    if (!outcome.ok) return outcome;
    return { ok: true, message: `${outcome.message}\n\n${await takeBoard(key, board.takeToolBoard)}` };
  }

  return {
    update: (key, args) => withBoard(key, registry.updateTodos(key, args)),
    read: async (key, args) => (args.scope === 'project'
      ? { ok: true, message: await takeBoard(key, board.takeProjectBoard) }
      : withBoard(key, registry.readTodos(key, args))),
  };
}
