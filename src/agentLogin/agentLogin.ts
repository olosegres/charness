/**
 * Out-of-band sign-in drivers: `claude auth login` (json-stream `/login`) and `opencode auth login`
 * (`/connect` OAuth) in a pty, relayed through the topic. See README.md in this folder.
 */
import { promises as fsp } from 'fs';
import * as os from 'os';
import { getAdapter } from '../adapters/createAdapter';
import type { SessionKey } from '../sessionKey';
import { keyToString } from '../sessionKey';
import { getOpenCodeChildEnv } from '../installManager';
import { t } from '../i18n';
import { type IPty, spawn as spawnPty } from 'node-pty';
import { resolveClaudeBinary, resolveOpenCodeBinary } from '../utils/resolveBinary';
import {
  checkIsClaudeAuthLoginCodePrompt,
  parseClaudeAuthLoginUrl,
  checkIsAuthLoginSucceeded,
} from '../utils/claudeAuthLogin';
import {
  checkIsAnthropicSecretLike,
  claudeConfigDirVariableName,
  extractAnthropicApiKey,
  parseClaudeAuthStatus,
  readProcessErrorStdout,
  type ClaudeAuthStatus,
  type ClaudeProfileBilling,
} from '../utils/claudeProfiles';
import {
  getOpenCodeAuthFilePath,
  checkProviderAuthed,
  buildOpenCodeAuthLoginArgs,
  checkIsOAuthInfoReady,
  parseOpenCodeOAuthUrl,
  parseOpenCodeDeviceCode,
  checkIsOpenCodeOAuthPastePrompt,
  checkIsLoopbackOAuthFlow,
  parseOAuthAuthorizeDetails,
  classifyOpenCodeOAuthReply,
  buildLoopbackCompletionUrl,
  checkIsOpenCodeOAuthSucceeded,
  checkIsPlausibleOAuthCode,
} from '../utils/openCodeAuthLogin';

/**
 * @description Every message that leaves a sign-in flow waiting for pasted input ends with the
 * localized `/esc to cancel` line — the way out of a pending login (Telegram renders the bare
 * `/esc` as a tappable command).
 */
function appendEscToCancelHint(text: string): string {
  return `${text}\n${t('login.esc_hint')}`;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  json-stream `/login` — out-of-band OAuth via `claude auth login` in a pty
// ═══════════════════════════════════════════════════════════════════════════════
//
// The json-stream Claude backend has no TUI to host Claude's interactive `/login`,
// so the bot drives `claude auth login --claudeai` in a pty and relays it through
// the topic: sign-in URL out → pasted code in (the code message is deleted, with
// the 🔐 ack — same secret-handling as the tmux login-paste + /connect flows). An
// API account (`billing: 'api'`) runs `--console` instead — the Claude Console
// login that creates an API key in the profile's own directory — and its paste
// may be an existing API key instead of the code (handed to the bot, never typed
// into the pty). On
// success the pinned logged-out notice clears (the normal recovery path). Pure
// parse/decision helpers live in `utils/claudeAuthLogin.ts`; this is the impure
// pty driver + per-thread state (mirrors the apiErrorRetry pure-layer / manager
// split). The pty is a bot child, NOT restart-safe — a bot restart kills it and
// drops the in-flight login, which is correct (a half-done login has no state to
// preserve; the user just re-runs /login).

interface PendingAuthLogin {
  readonly pty: IPty;
  /** The account profile being signed in (`null` = the default `~/.claude` login). */
  readonly profile: ClaudeLoginProfile | null;
  /** Accumulated pty output (ANSI included) — re-parsed on each chunk. */
  output: string;
  /** The sign-in URL has been relayed to the topic. */
  urlRelayed: boolean;
  /** Fires if no sign-in URL appears in the window (OAuth-init call blocked). */
  readonly timeoutTimer: NodeJS.Timeout;
}

/**
 * How long to wait for the sign-in URL before giving up. The host egress firewall
 * can hold the OAuth-init network call (decision window up to ~2 min), so this is
 * generous; a permitted call returns the URL sub-second.
 */
const authLoginUrlTimeoutMs = 120_000;
const authLoginPtyCols = 100;
const authLoginPtyRows = 40;
const authStatusProbeTimeoutMs = 5_000;

// ── OpenCode `/connect` OAuth (subscription) — out-of-band pty flow ───────────
// Mirrors the Claude `/login` driver above but drives `opencode auth login
// -p <id> -m <label>`. Two shapes, auto-detected from the pty output: a DEVICE
// flow (relay URL + code, wait for the process to exit when the user authorises
// in a browser) and a PASTE flow (relay URL, then the next plain text is the
// code written into the pty). Pure parse/decision helpers live in
// `utils/openCodeAuthLogin.ts`; success is read from the on-disk `auth.json`.

interface PendingOpenCodeOAuth {
  readonly pty: IPty;
  readonly providerId: string;
  readonly methodLabel: string;
  /** Accumulated pty output (ANSI included) — re-parsed on each chunk. */
  output: string;
  /** The sign-in URL/code has been relayed to the topic. */
  infoRelayed: boolean;
  /**
   * Paste OR loopback flow: the next plain text is the OAuth reply — either a
   * pasted callback URL or a bare code. A device flow never sets this (it
   * self-completes when the user authorises at the URL — nothing is pasted).
   */
  awaitingReply: boolean;
  /**
   * The flow redirects to a loopback callback (`redirect_uri=localhost:<port>`)
   * that the user's remote browser can't reach — the bot must replay the pasted
   * callback on the host to complete it (see {@link submitOpenCodeOAuthReply}).
   */
  isLoopback: boolean;
  /** Loopback completion target parsed from the authorize URL. */
  redirectPort: number | null;
  redirectPath: string | null;
  /** `state` the CLI generated — needed to complete a bare-code loopback reply. */
  oauthState: string | null;
  /** Fires if no sign-in URL appears in the window (OAuth-init call blocked). */
  readonly timeoutTimer: NodeJS.Timeout;
}

/**
 * @description Read the provider's credential type out of OpenCode's on-disk
 * `auth.json` after the flow exits. Returns `true` when the provider is authed
 * as `oauth` (a fresh success — distinct from a stale `api` entry left by an
 * earlier key-based `/connect`), `false` when it isn't, `null` when the file
 * can't be read (caller falls back to the exit code).
 */
async function readOpenCodeProviderAuthed(providerId: string): Promise<boolean | null> {
  try {
    const authPath = getOpenCodeAuthFilePath({
      XDG_DATA_HOME: process.env.XDG_DATA_HOME,
      HOME: os.homedir(),
    });
    const raw = await fsp.readFile(authPath, 'utf8');
    return checkProviderAuthed(JSON.parse(raw), providerId, 'oauth');
  } catch {
    return null;
  }
}

/**
 * A Claude account profile a `/login` signs in (`utils/claudeProfiles.ts`): its name for the confirmation and
 * the config directory the CLI must write the login into (`null` = the default `~/.claude`).
 */
export interface ClaudeLoginProfile {
  name: string;
  configDir: string | null;
  /**
   * `api`: an account billed to a Claude Console organization's API balance — the sign-in is `claude auth login
   * --console` (it creates an API key and keeps it in `configDir`), and a pasted API key is accepted in place of the
   * code. Absent: the subscription login (`--claudeai`).
   */
  billing?: ClaudeProfileBilling;
}

/**
 * @description The `claude auth login` arguments of a sign-in: `--console` for an API account, the subscription
 * otherwise. Never the keyless Console sign-in — that one lives outside `CLAUDE_CONFIG_DIR` (machine-wide) and signs
 * the claude.ai logins out; the subcommand never offers it.
 */
export function buildClaudeAuthLoginArgs(profile: ClaudeLoginProfile | null): string[] {
  return ['auth', 'login', profile?.billing === 'api' ? '--console' : '--claudeai'];
}

/**
 * What the sign-in drivers need from the bot: the topic's send/delete, retiring the pinned logged-out
 * notice, a process runner for the `claude auth status` probe (run with the profile's `CLAUDE_CONFIG_DIR` when
 * one is signed in), and — optionally — a sink for the auth status a profile sign-in ends with, so the bot can
 * record the account's email and plan.
 */
export interface AgentLoginPorts {
  replyToThread: (key: SessionKey, text: string) => Promise<number | null>;
  deleteThreadMessage: (key: SessionKey, messageId: number) => Promise<void>;
  clearAuthNotice: (key: SessionKey) => void;
  execFileAsync: (
    file: string,
    args: readonly string[],
    options: { timeout: number; env?: NodeJS.ProcessEnv },
  ) => Promise<{ stdout: string }>;
  onClaudeProfileAuthStatus?: (key: SessionKey, profile: ClaudeLoginProfile, status: ClaudeAuthStatus | null) => Promise<void>;
  /**
   * An API key pasted into an API account's sign-in (the pty is already stopped, the message deleted): the bot
   * verifies and stores it for that profile only, and returns the line to post. Absent: a pasted key is refused.
   */
  onClaudeProfileApiKey?: (key: SessionKey, profile: ClaudeLoginProfile, apiKey: string) => Promise<string>;
}

/**
 * @description Build the sign-in drivers over their ports. The in-flight flows (one per
 * thread, per sign-in kind) are state of the returned instance, not of the module.
 */
export function createAgentLogin(ports: AgentLoginPorts) {
  const { replyToThread, deleteThreadMessage, clearAuthNotice, execFileAsync, onClaudeProfileAuthStatus, onClaudeProfileApiKey } = ports;

  /** Per-thread in-flight `claude auth login` flows, keyed by `keyToString(key)`. */
  const pendingAuthLogins = new Map<string, PendingAuthLogin>();

  /**
   * @description Whether the thread's `/login` flow has reached the "paste code"
   * stage — the sign-in URL was relayed and the next plain text is the OAuth code.
   * Mirrors the tmux backend's `isLoginPastePending` (true only once the paste
   * prompt is live), so a message typed in the pre-URL boot window is NOT
   * swallowed/deleted as a code. Teardown still keys off the map itself, not this.
   */
  function checkIsAuthLoginAwaitingCode(key: SessionKey): boolean {
    return pendingAuthLogins.get(keyToString(key))?.urlRelayed === true;
  }

  /** Kill + forget a thread's in-flight login (idempotent). Reports nothing. */
  function cancelClaudeAuthLogin(key: SessionKey): void {
    const k = keyToString(key);
    const pending = pendingAuthLogins.get(k);
    if (!pending) return;
    pendingAuthLogins.delete(k);
    clearTimeout(pending.timeoutTimer);
    try {
      pending.pty.kill();
    } catch {
      /* already exited */
    }
  }

  /**
   * @description The environment a `claude auth …` process runs with: the bot's own minus `ANTHROPIC_API_KEY`
   * (the subscription login, never the metered console path), plus the profile's `CLAUDE_CONFIG_DIR` when one
   * is signed in — the login must land in THAT directory, and the status probe must read the same one.
   */
  function buildClaudeAuthEnv(configDir: string | null): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    if (configDir !== null) env[claudeConfigDirVariableName] = configDir;
    return env;
  }

  /** Read `claude auth status --json` under `configDir`, or `null` if the probe fails or prints something else. */
  async function readAuthLoginStatus(configDir: string | null): Promise<ClaudeAuthStatus | null> {
    try {
      const { stdout } = await execFileAsync(
        resolveClaudeBinary(),
        ['auth', 'status', '--json'],
        { timeout: authStatusProbeTimeoutMs, env: buildClaudeAuthEnv(configDir) },
      );
      return parseClaudeAuthStatus(stdout);
    } catch (e) {
      // A logged-out directory makes the CLI exit non-zero WITH its JSON on stdout (probed on 2.1.296):
      // that is the answer, not a failed probe.
      return parseClaudeAuthStatus(readProcessErrorStdout(e));
    }
  }

  /**
   * @description Start the out-of-band `/login` flow for a json-stream thread: spawn
   * `claude auth login --claudeai` in a pty, relay the sign-in URL when it appears,
   * and arm the pending-code state (the thread's next plain text is written into the
   * pty as the code). Re-running `/login` while a flow is pending restarts it. With a
   * `profile` the CLI signs THAT account profile in (`CLAUDE_CONFIG_DIR` set on the
   * pty), the link message tells the operator to open it as the other account, and
   * the confirmation names the account; the default login is unchanged. An API
   * account's sign-in is `--console` ({@link buildClaudeAuthLoginArgs}) and its link
   * message offers pasting an existing API key instead.
   */
  async function startClaudeAuthLogin(key: SessionKey, profile: ClaudeLoginProfile | null = null): Promise<void> {
    const k = keyToString(key);
    cancelClaudeAuthLogin(key); // clean restart on a repeated /login

    let child: IPty;
    try {
      // A subscription login unless the profile is an API account (`--console`, metered by
      // design): `--claudeai` picks the Claude subscription, and dropping ANTHROPIC_API_KEY
      // keeps a stray key out of either login. cwd is irrelevant — login writes to the
      // config directory (`~/.claude`, or the profile's own).
      child = spawnPty(resolveClaudeBinary(), buildClaudeAuthLoginArgs(profile), {
        name: 'xterm-256color',
        cols: authLoginPtyCols,
        rows: authLoginPtyRows,
        cwd: process.cwd(),
        env: buildClaudeAuthEnv(profile?.configDir ?? null),
      });
    } catch (e) {
      console.warn(`[login] ${k} pty spawn failed:`, e);
      await replyToThread(key, t('agent.login_failed'));
      return;
    }

    const pending: PendingAuthLogin = {
      pty: child,
      profile,
      output: '',
      urlRelayed: false,
      timeoutTimer: setTimeout(() => {
        void onAuthLoginUrlTimeout(key, child);
      }, authLoginUrlTimeoutMs),
    };
    pendingAuthLogins.set(k, pending);

    child.onData((chunk) => {
      const current = pendingAuthLogins.get(k);
      if (!current || current.pty !== child) return; // cancelled/replaced
      current.output += chunk;
      // Relay the URL only once the "paste code" prompt is up — that guarantees the
      // full URL block already rendered (never a chunk-split half-URL).
      if (!current.urlRelayed && checkIsClaudeAuthLoginCodePrompt(current.output)) {
        const url = parseClaudeAuthLoginUrl(current.output);
        if (url) {
          current.urlRelayed = true;
          clearTimeout(current.timeoutTimer);
          const linkText = current.profile
            ? t(current.profile.billing === 'api' ? 'account.login_url_api' : 'account.login_url', { name: current.profile.name, url })
            : t('agent.login_url', { url });
          void replyToThread(key, appendEscToCancelHint(linkText));
        }
      }
    });

    child.onExit(({ exitCode }) => {
      void onAuthLoginExit(key, child, exitCode);
    });
  }

  /**
   * @description The pending flow's next plain text is the OAuth code: type it into
   * the pty, delete the user's message (the code is a single-use secret), and post
   * the 🔐 ack. The final success/failure notice comes from {@link onAuthLoginExit}.
   * A message that is not a plausible code (an ordinary sentence) is NOT consumed:
   * the flow stays armed and the topic is told it is still waiting, with `/esc` as
   * the way out — a pending login must never silently swallow the topic. Anything
   * that carries an Anthropic credential (`sk-ant-…`, also inside other text) is a
   * secret: deleted at once and never typed into the pty — see {@link submitClaudeApiKey}.
   * @returns `true` when the message was consumed (as the code, or as a key),
   *   `false` when it was answered with the waiting hint instead.
   */
  async function submitClaudeAuthLoginCode(
    key: SessionKey,
    code: string,
    messageId: number,
  ): Promise<boolean> {
    const pending = pendingAuthLogins.get(keyToString(key));
    if (!pending) return false;
    if (checkIsAnthropicSecretLike(code)) return submitClaudeApiKey(key, pending, code, messageId);
    if (!checkIsPlausibleOAuthCode(code)) {
      await replyToThread(key, appendEscToCancelHint(t('login.waiting_code')));
      return false;
    }
    pending.pty.write(`${code.trim()}\r`);
    await deleteThreadMessage(key, messageId);
    await replyToThread(key, t('agent.login_code_relayed'));
    return true;
  }

  /**
   * @description A pasted text carrying `sk-ant-…` in a pending Claude sign-in. It is a secret whatever it is: the
   * message is deleted first. An API account takes the one usable API key it carries (bare, or inside
   * `ANTHROPIC_API_KEY=…` and the like) in place of the code: the console login is stopped and the
   * key goes to the bot ({@link AgentLoginPorts.onClaudeProfileApiKey}), which verifies and stores it for that profile
   * only. A subscription sign-in, or a credential that is not an API key (an admin key, an OAuth token), is refused
   * and the flow stays armed.
   */
  async function submitClaudeApiKey(key: SessionKey, pending: PendingAuthLogin, text: string, messageId: number): Promise<boolean> {
    await deleteThreadMessage(key, messageId);
    const profile = pending.profile;
    if (!profile || profile.billing !== 'api' || !onClaudeProfileApiKey) {
      await replyToThread(key, appendEscToCancelHint(t('account.apiKeyNotApiAccount')));
      return true;
    }
    const apiKey = extractAnthropicApiKey(text);
    if (apiKey === null) {
      await replyToThread(key, appendEscToCancelHint(t('account.apiKeyInvalidShape')));
      return true;
    }
    cancelClaudeAuthLogin(key); // the key replaces the console login: its pty must not report a failure later
    await replyToThread(key, t('agent.login_code_relayed'));
    await replyToThread(key, await onClaudeProfileApiKey(key, profile, apiKey));
    return true;
  }

  /** No sign-in URL within the window → the OAuth-init call was likely blocked. */
  async function onAuthLoginUrlTimeout(key: SessionKey, child: IPty): Promise<void> {
    const k = keyToString(key);
    const pending = pendingAuthLogins.get(k);
    if (!pending || pending.pty !== child || pending.urlRelayed) return;
    cancelClaudeAuthLogin(key);
    await replyToThread(key, t('agent.login_failed'));
  }

  /**
   * @description The `claude auth login` process exited. If the thread's flow is
   * still active (not cancelled/replaced), report the outcome: `claude auth status`
   * is authoritative, exit code is the fallback. On success clear the pinned
   * logged-out notice (recovery). A cancelled flow already dropped its entry, so
   * this no-ops for it (never reports a false "success" on a teardown kill).
   */
  async function onAuthLoginExit(
    key: SessionKey,
    child: IPty,
    exitCode: number,
  ): Promise<void> {
    const k = keyToString(key);
    const pending = pendingAuthLogins.get(k);
    if (!pending || pending.pty !== child) return; // cancelled/replaced → no report
    clearTimeout(pending.timeoutTimer);
    pendingAuthLogins.delete(k);
    const status = await readAuthLoginStatus(pending.profile?.configDir ?? null);
    const isSucceeded = checkIsAuthLoginSucceeded({ exitCode, loggedIn: status?.loggedIn ?? null });
    if (pending.profile) {
      // The bot records the account (email, plan) whatever the outcome — a failed sign-in reads as logged out.
      await onClaudeProfileAuthStatus?.(key, pending.profile, status);
      // The `default` profile IS the `~/.claude` login: a success retires the pinned logged-out notice, as `/login` does.
      if (isSucceeded && pending.profile.configDir === null) clearAuthNotice(key);
      await replyToThread(key, isSucceeded ? formatProfileLoginSuccess(pending.profile, status) : t('account.login_failed', { name: pending.profile.name }));
      return;
    }
    if (isSucceeded) {
      clearAuthNotice(key); // recovery → retire any pinned logged-out notice
      await replyToThread(key, t('agent.login_success'));
    } else {
      await replyToThread(key, t('agent.login_failed'));
    }
  }

  /** The confirmation of a profile sign-in: the email and plan, or — billed to the API — the email and Console organization. */
  function formatProfileLoginSuccess(profile: ClaudeLoginProfile, status: ClaudeAuthStatus | null): string {
    if (status?.billing === 'api') {
      return t('account.login_success_api', { name: profile.name, email: status.email ?? '?', org: status.orgName ?? '?' });
    }
    return t('account.login_success', { name: profile.name, email: status?.email ?? '?', plan: status?.subscriptionType ?? '?' });
  }

  /** Per-thread in-flight `opencode auth login` OAuth flows, keyed by `keyToString(key)`. */
  const pendingOpenCodeOAuth = new Map<string, PendingOpenCodeOAuth>();

  /**
   * @description Whether the thread's OAuth flow has reached a stage where the next
   * plain text is the OAuth reply (a paste-style code OR a loopback callback URL).
   * A device flow never sets this (nothing is pasted back — it self-completes).
   */
  function checkIsOpenCodeOAuthAwaitingReply(key: SessionKey): boolean {
    return pendingOpenCodeOAuth.get(keyToString(key))?.awaitingReply === true;
  }

  /** Kill + forget a thread's in-flight OAuth login (idempotent). Reports nothing. */
  function cancelOpenCodeOAuthLogin(key: SessionKey): void {
    const k = keyToString(key);
    const pending = pendingOpenCodeOAuth.get(k);
    if (!pending) return;
    pendingOpenCodeOAuth.delete(k);
    clearTimeout(pending.timeoutTimer);
    try {
      pending.pty.kill();
    } catch {
      /* already exited */
    }
  }

  /**
   * @description Start the out-of-band OAuth flow for `/connect <provider>`: spawn
   * `opencode auth login -p <id> -m <label>` in a pty, relay the sign-in URL (+ the
   * device code, for a device flow) once it's fully rendered, and — for a paste
   * flow — arm the pending-code state. Re-running restarts a pending flow.
   */
  async function startOpenCodeOAuthLogin(
    key: SessionKey,
    providerId: string,
    methodLabel: string,
  ): Promise<void> {
    const k = keyToString(key);
    cancelOpenCodeOAuthLogin(key); // clean restart on a repeat

    let child: IPty;
    try {
      // Drop provider API-key envs so the login uses the subscription/account path
      // and can't be short-circuited by an ambient key. cwd is irrelevant — login
      // writes to OpenCode's global auth.json.
      const env: Record<string, string | undefined> = getOpenCodeChildEnv();
      delete env.OPENAI_API_KEY;
      delete env.ANTHROPIC_API_KEY;
      child = spawnPty(resolveOpenCodeBinary(), buildOpenCodeAuthLoginArgs(providerId, methodLabel), {
        name: 'xterm-256color',
        cols: authLoginPtyCols,
        rows: authLoginPtyRows,
        cwd: process.cwd(),
        env,
      });
    } catch (e) {
      console.warn(`[connect] ${k} opencode oauth pty spawn failed:`, e);
      await replyToThread(key, t('connect.oauth_failed', { provider: providerId }));
      return;
    }

    const pending: PendingOpenCodeOAuth = {
      pty: child,
      providerId,
      methodLabel,
      output: '',
      infoRelayed: false,
      awaitingReply: false,
      isLoopback: false,
      redirectPort: null,
      redirectPath: null,
      oauthState: null,
      timeoutTimer: setTimeout(() => {
        void onOpenCodeOAuthUrlTimeout(key, child);
      }, authLoginUrlTimeoutMs),
    };
    pendingOpenCodeOAuth.set(k, pending);

    child.onData((chunk) => {
      const current = pendingOpenCodeOAuth.get(k);
      if (!current || current.pty !== child) return; // cancelled/replaced
      current.output += chunk;
      if (current.infoRelayed) return;
      // Relay only once the URL block is fully rendered (a device code, the poll,
      // or a paste prompt is present) — never a chunk-split half-URL.
      if (!checkIsOAuthInfoReady(current.output)) return;
      const url = parseOpenCodeOAuthUrl(current.output);
      if (!url) return;
      current.infoRelayed = true;
      clearTimeout(current.timeoutTimer);
      const deviceCode = parseOpenCodeDeviceCode(current.output);
      const isPaste = checkIsOpenCodeOAuthPastePrompt(current.output) && !deviceCode;
      // Loopback (browser) flow: the CLI redirects to localhost, which a REMOTE
      // browser can't reach — so we relay the URL and bridge the callback the user
      // pastes back (either the full callback URL or the bare code, completed with
      // the stored state). Parse the completion target now, while the authorize
      // URL (with state) is fully rendered.
      const isLoopback = !deviceCode && !isPaste && checkIsLoopbackOAuthFlow(current.output);
      if (deviceCode) {
        void replyToThread(key, t('connect.oauth_device', { provider: providerId, url, code: deviceCode }));
      } else {
        void replyToThread(key, t('connect.oauth_url_only', { provider: providerId, url }));
      }
      if (isPaste) {
        current.awaitingReply = true;
        void replyToThread(key, appendEscToCancelHint(t('connect.oauth_paste')));
      } else if (isLoopback) {
        const details = parseOAuthAuthorizeDetails(current.output);
        current.isLoopback = true;
        current.redirectPort = details.redirectPort;
        current.redirectPath = details.redirectPath;
        current.oauthState = details.state;
        current.awaitingReply = true;
        void replyToThread(key, appendEscToCancelHint(t('connect.oauth_loopback')));
      } else {
        void replyToThread(key, t('connect.oauth_waiting'));
      }
    });

    child.onExit(({ exitCode }) => {
      void onOpenCodeOAuthExit(key, child, exitCode);
    });
  }

  /**
   * @description Handle the user's reply to a pending OAuth flow. The reply is
   * classified URL-FIRST, then as a bare code (requested behaviour): recognise a
   * pasted callback link first, otherwise a validated code — a value that is
   * neither (an ordinary chat message like "я перезагрузил") is NEVER consumed as
   * a credential, so a stale "awaiting reply" state can't swallow unrelated text.
   *
   *  - LOOPBACK (browser) flow: the pasted callback URL (or a bare code + the
   *    stored `state`) is replayed against the CLI's local callback server on the
   *    host (`127.0.0.1:<port>/auth/callback?…`) — the bot bridges what the remote
   *    browser could not reach. The CLI then exchanges the code and exits.
   *  - PASTE flow: the code is typed into the pty verbatim.
   *
   * The user's message is deleted (single-use secret); success/failure comes from
   * {@link onOpenCodeOAuthExit} once the CLI process exits.
   * @returns `true` when the reply was consumed as an OAuth reply, `false` when it
   *   was not recognised (caller keeps the flow armed and hints).
   */
  async function submitOpenCodeOAuthReply(
    key: SessionKey,
    text: string,
    messageId: number,
  ): Promise<boolean> {
    const pending = pendingOpenCodeOAuth.get(keyToString(key));
    if (!pending) return false;
    const reply = classifyOpenCodeOAuthReply(text);
    if (reply === null) {
      // Not a link, not a plausible code → do not consume it as a credential.
      await replyToThread(key, appendEscToCancelHint(t('connect.oauth_invalid_reply')));
      return false;
    }

    if (pending.isLoopback) {
      // Complete the loopback exchange on the host. Prefer values from the pasted
      // callback URL; fall back to the stored port/path/state for a bare code.
      const completionUrl = buildLoopbackCompletionUrl({
        port: (reply.kind === 'callback' ? reply.port : null) ?? pending.redirectPort,
        path: (reply.kind === 'callback' ? reply.path : null) ?? pending.redirectPath,
        code: reply.code,
        state: (reply.kind === 'callback' ? reply.state : null) ?? pending.oauthState,
      });
      if (!completionUrl) {
        await replyToThread(key, appendEscToCancelHint(t('connect.oauth_invalid_reply')));
        return false;
      }
      await deleteThreadMessage(key, messageId);
      await replyToThread(key, t('agent.login_code_relayed'));
      try {
        // The CLI's local callback server exchanges the code and lets the pty exit.
        const res = await fetch(completionUrl, { signal: AbortSignal.timeout(30_000) });
        // Drain the body so the connection closes cleanly; ignore its content.
        await res.text().catch(() => '');
      } catch (e) {
        console.warn(`[connect] ${keyToString(key)} loopback callback replay failed:`, e);
        // The pty is still waiting; onExit will report the eventual outcome, but a
        // transport failure here means it likely won't — surface it now.
        await replyToThread(key, t('connect.oauth_failed', { provider: pending.providerId }));
      }
      return true;
    }

    // Paste flow: type the code into the pty verbatim.
    await deleteThreadMessage(key, messageId);
    await replyToThread(key, t('agent.login_code_relayed'));
    pending.pty.write(`${reply.code}\r`);
    return true;
  }

  /** No sign-in URL within the window → the OAuth-init call was likely blocked. */
  async function onOpenCodeOAuthUrlTimeout(key: SessionKey, child: IPty): Promise<void> {
    const k = keyToString(key);
    const pending = pendingOpenCodeOAuth.get(k);
    if (!pending || pending.pty !== child || pending.infoRelayed) return;
    cancelOpenCodeOAuthLogin(key);
    await replyToThread(key, t('connect.oauth_failed', { provider: pending.providerId }));
  }

  /**
   * @description The `opencode auth login` process exited. If the thread's flow is
   * still active, report the outcome: `auth.json` is authoritative (the provider's
   * entry flips to `oauth`), exit code is the fallback. A cancelled flow already
   * dropped its entry, so this no-ops for it.
   */
  async function onOpenCodeOAuthExit(
    key: SessionKey,
    child: IPty,
    exitCode: number,
  ): Promise<void> {
    const k = keyToString(key);
    const pending = pendingOpenCodeOAuth.get(k);
    if (!pending || pending.pty !== child) return; // cancelled/replaced → no report
    clearTimeout(pending.timeoutTimer);
    pendingOpenCodeOAuth.delete(k);
    const authed = await readOpenCodeProviderAuthed(pending.providerId);
    if (checkIsOpenCodeOAuthSucceeded({ exitCode, authed })) {
      const adapter = getAdapter('opencode');
      const isProviderAuthReloaded = adapter.reloadProviderAuth
        ? await adapter.reloadProviderAuth()
        : false;
      if (isProviderAuthReloaded) {
        await replyToThread(key, t('connect.oauth_success', { provider: pending.providerId }));
      } else {
        await replyToThread(key, t('connect.oauth_failed', { provider: pending.providerId }));
      }
    } else {
      await replyToThread(key, t('connect.oauth_failed', { provider: pending.providerId }));
    }
  }

  /**
   * @description `/esc` while a sign-in waits for pasted input: cancel whichever flow the
   * thread has (the json-stream `/login`, the `/connect` OAuth) in one shared step — the
   * caller confirms to the topic. Returns `false` when nothing was pending, so `/esc`
   * keeps its ordinary meaning (interrupt the agent) in that case.
   */
  function cancelPendingLogin(key: SessionKey): boolean {
    const k = keyToString(key);
    const hadPending = pendingAuthLogins.has(k) || pendingOpenCodeOAuth.has(k);
    cancelClaudeAuthLogin(key);
    cancelOpenCodeOAuthLogin(key);
    return hadPending;
  }

  /** Whether any topic has a sign-in flow in flight — the bot must not restart under it (the updater waits). */
  function checkIsAnyLoginInProgress(): boolean {
    return pendingAuthLogins.size > 0 || pendingOpenCodeOAuth.size > 0;
  }

  return {
    cancelPendingLogin,
    checkIsAnyLoginInProgress,
    checkIsAuthLoginAwaitingCode,
    cancelClaudeAuthLogin,
    startClaudeAuthLogin,
    submitClaudeAuthLoginCode,
    checkIsOpenCodeOAuthAwaitingReply,
    cancelOpenCodeOAuthLogin,
    startOpenCodeOAuthLogin,
    submitOpenCodeOAuthReply,
  };
}
