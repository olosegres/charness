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
 * @description A registered command handler. Runs for its own side effects; the
 * router does not interpret a return value, so declining is not a handler's
 * choice — a name is either bound or it is not.
 */
export type CommandHandler = (event: InboundEvent, command: InboundCommand) => Promise<void> | void;

export interface CommandRouter {
  /**
   * Bind one or more names to `handler`. Matching is EXACT, including case:
   * Telegram's own command matching is case-sensitive (`/STATUS` is not
   * `/status`), so folding case here would start answering commands that used
   * to fall through to the plain-text path. A surface whose commands really are
   * case-insensitive normalises the name in its own recogniser, where that fact
   * belongs.
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
}

export function createCommandRouter(): CommandRouter {
  const handlers = new Map<string, CommandHandler>();

  function register(names: string | string[], handler: CommandHandler): void {
    for (const name of Array.isArray(names) ? names : [names]) {
      handlers.set(name, handler);
    }
  }

  function checkIsRegistered(name: string): boolean {
    return handlers.has(name);
  }

  async function dispatch(event: InboundEvent): Promise<boolean> {
    const command = event.command;
    if (!command) return false;
    const handler = handlers.get(command.name);
    if (!handler) return false;
    await handler(event, command);
    return true;
  }

  return { register, checkIsRegistered, dispatch };
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
