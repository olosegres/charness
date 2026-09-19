/**
 * @description The platform-neutral command router.
 *
 * Command dispatch used to be fused to Telegram: every handler was registered
 * through `bot.command(...)`, and each one re-parsed its own arguments out of
 * `ctx.message.text` with an ad-hoc `split(' ').slice(1)`. Neither survives a
 * second surface — a tracker comment (`@ai-dev please review`) carries the same
 * intent with none of Telegram's syntax.
 *
 * So the split is: the CONNECTOR recognises its own trigger syntax and produces
 * an {@link InboundCommand}; the CORE owns the name → handler table and the
 * dispatch. Adding a surface adds a recogniser, not a second command table.
 */

import type { InboundCommand, InboundEvent } from './inbound';

/**
 * @description A registered command handler. Returning `false` declines the
 * command so the caller can fall through to its generic text path, matching
 * what an unregistered name already does.
 */
export type CommandHandler = (event: InboundEvent, command: InboundCommand) => Promise<void> | void;

export interface CommandRouter {
  /**
   * Bind one or more names to `handler`. Names are matched case-insensitively
   * (Telegram lower-cases commands in practice, a tracker need not).
   */
  register(names: string | string[], handler: CommandHandler): void;
  /** Is any handler bound to this name? Used to decide fall-through. */
  checkIsRegistered(name: string): boolean;
  /**
   * Run the handler bound to `event.command`. Resolves `false` when the event
   * carries no command or no handler is bound — the caller then treats the
   * message as plain text, exactly as before.
   */
  dispatch(event: InboundEvent): Promise<boolean>;
  /** Every registered name, in registration order — for `/help` and tests. */
  listNames(): string[];
}

export function createCommandRouter(): CommandRouter {
  const handlers = new Map<string, CommandHandler>();

  function register(names: string | string[], handler: CommandHandler): void {
    for (const name of Array.isArray(names) ? names : [names]) {
      handlers.set(name.toLowerCase(), handler);
    }
  }

  function checkIsRegistered(name: string): boolean {
    return handlers.has(name.toLowerCase());
  }

  async function dispatch(event: InboundEvent): Promise<boolean> {
    const command = event.command;
    if (!command) return false;
    const handler = handlers.get(command.name.toLowerCase());
    if (!handler) return false;
    await handler(event, command);
    return true;
  }

  function listNames(): string[] {
    return [...handlers.keys()];
  }

  return { register, checkIsRegistered, dispatch, listNames };
}

/**
 * @description Split the remainder of a command line into the two argument
 * shapes handlers actually need.
 *
 * Shared by every connector's recogniser so "what counts as an argument" is
 * decided once. `argsText` keeps the user's inner spacing verbatim (a session
 * title or a schedule description must survive intact); `args` is the
 * convenience split for the flag-style commands.
 */
export function splitCommandArgs(remainder: string): Pick<InboundCommand, 'args' | 'argsText'> {
  const argsText = remainder.trim();
  return { argsText, args: argsText.split(/\s+/).filter(Boolean) };
}
