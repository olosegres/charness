import { configureSchedulerMcpInjection } from './injection';
import { defaultSchedulerMcpPort, type SchedulerMcpHandle } from './mcpSurface';

/**
 * @description Boot-time bring-up of the bot-owned MCP server, and the ORDER of
 * the session phase around it. Kept out of `bot.ts` so the ordering contract is
 * testable (importing `bot.ts` runs its module-scope `parseEnv()`).
 *
 * The contract: the server is bound and injection is configured BEFORE any
 * session is re-attached or resumed. A session (re)spawned at boot builds its
 * `--mcp-config` / OpenCode registration at that moment; with injection still
 * inert it is born WITHOUT the bot's server, and the Claude heal path never
 * repairs an ABSENT server (`decideMcpHeal` maps it to `skip`). Such a Claude
 * session could not reach the bot's tools for the rest of its life.
 *
 * The heals stay AFTER reattach: they walk only ACTIVE sessions, so run before
 * it they would heal nothing. The schedule re-arm stays after reattach too — a
 * catch-up fire needs the re-attached adapters.
 */

/**
 * @name SchedulerMcpBootDeps
 * @description What {@link startSchedulerMcpForBoot} needs: the server handle,
 * the env-pinned port ({@link defaultSchedulerMcpPort} = not pinned), the
 * persisted port of a prior boot and its writer, and the HMAC secret the
 * injected tokens are signed with.
 */
export interface SchedulerMcpBootDeps {
  handle: SchedulerMcpHandle;
  envPort: number;
  getPersistedPort: () => number | undefined;
  persistPort: (port: number) => Promise<void>;
  getSecret: () => Promise<string>;
}

/**
 * @description Bind the bot MCP server and configure injection toward the bound
 * port. Resolves `true` when the server is up. A bind failure (port busy) is
 * logged and resolves `false`: the bot still boots and injection stays inert,
 * so sessions spawned this run get no bot tools — a Claude one keeps lacking
 * them after a later restart too (its process is adopted, and the heal never
 * adds an absent server). Persisting the port is best-effort: it only serves the
 * NEXT boot, so a failed write is logged and the bound server is still used.
 */
export async function startSchedulerMcpForBoot(deps: SchedulerMcpBootDeps): Promise<boolean> {
  try {
    await deps.handle.start();
  } catch (e) {
    console.error(
      '[scheduler] MCP server failed to start; scheduling tools unavailable this run:',
      e instanceof Error ? e.message : e,
    );
    return false;
  }
  const boundPort = deps.handle.port;
  // Persist the actually-bound port so the next boot reuses it (registrations
  // stay valid). Skip when the operator fixed the port via env (nothing to
  // reuse) or when it is unchanged (avoid a needless flush).
  if (deps.envPort === defaultSchedulerMcpPort && deps.getPersistedPort() !== boundPort) {
    try {
      await deps.persistPort(boundPort);
    } catch (e) {
      console.warn(
        `[scheduler] could not persist MCP port ${boundPort}; the next boot binds a fresh one:`,
        e instanceof Error ? e.message : e,
      );
    }
  }
  configureSchedulerMcpInjection({ getSecret: deps.getSecret, port: boundPort });
  console.log(`[scheduler] MCP server listening on 127.0.0.1:${boundPort}`);
  return true;
}

/**
 * @name SessionBootPhaseSteps
 * @description The boot steps whose relative order {@link runSessionBootPhase}
 * owns. `restoreAfterReattach` is the per-thread state that needs to know which
 * sessions came back (pending questions, armed retries, limit episodes, orphaned
 * status frames); `healActiveSessions` runs only when the server is up and is
 * best-effort — a throw is logged and never aborts the boot.
 */
export interface SessionBootPhaseSteps {
  startBotMcp: () => Promise<boolean>;
  reattachSessions: () => Promise<void>;
  restoreAfterReattach: () => void;
  healActiveSessions: () => void;
  rearmSchedules: () => Promise<void>;
}

/**
 * @description Run the session phase of the boot in the order the module header
 * explains. Resolves whether the bot MCP server started, for the shutdown path.
 */
export async function runSessionBootPhase(steps: SessionBootPhaseSteps): Promise<boolean> {
  const isBotMcpStarted = await steps.startBotMcp();
  await steps.reattachSessions();
  steps.restoreAfterReattach();
  if (isBotMcpStarted) {
    try {
      steps.healActiveSessions();
    } catch (e) {
      console.warn('[scheduler] MCP heal of active sessions failed:', e instanceof Error ? e.message : e);
    }
  }
  await steps.rearmSchedules();
  return isBotMcpStarted;
}
