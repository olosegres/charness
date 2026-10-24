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

export function createTodoTools(deps: { registry: TodoRegistry; board: TodoBoard }): TodoTools {
  const { registry, board } = deps;

  /** The own-list answer, then the board's delta; a refusal stays as it is (nothing was seen). */
  async function withBoard(key: SessionKey, outcome: TodoToolOutcome): Promise<TodoToolOutcome> {
    if (!outcome.ok) return outcome;
    return { ok: true, message: `${outcome.message}\n\n${await board.takeToolBoard(key)}` };
  }

  return {
    update: (key, args) => withBoard(key, registry.updateTodos(key, args)),
    read: async (key, args) => (args.scope === 'project'
      ? { ok: true, message: await board.takeProjectBoard(key) }
      : withBoard(key, registry.readTodos(key, args))),
  };
}
