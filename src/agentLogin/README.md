# `src/agentLogin/` — out-of-band sign-in drivers

`createAgentLogin(ports)` returns the drivers behind the json-stream `/login` (`claude auth login --claudeai`, or
`--console` for an API account) and the OpenCode `/connect` OAuth (`opencode auth login`). Each runs its CLI in a pty
owned by the bot and relays it through the topic. `bot.ts` wires the ports (`replyToThread`, `deleteThreadMessage`, `clearAuthNotice`,
`execFileAsync`); nothing here imports `bot.ts` or the Telegram library.

- **The link goes out only once the CLI's "paste the code" prompt (or a device code / wait line) is on screen** —
  never a chunk-split half-URL.
- **The pasted code is a single-use secret:** the user's message is deleted, then the code is typed into the pty.
  Gate on `checkIs…Awaiting…` before taking a plain message for a code: a flow that has not relayed its link yet
  must not swallow the user's text, and an OpenCode reply that is neither a callback link nor a plausible code is
  never consumed (`submitOpenCodeOAuthReply` returns `false`; the flow stays armed).
- **A pending flow never swallows the topic.** Every message that leaves a flow waiting for pasted input (the link,
  the paste / loopback prompt, a rejected reply) ends with the localized `/esc to cancel` line; a plain message that
  is not a plausible code is answered with the waiting hint and kept (`submitClaudeAuthLoginCode` returns `false`).
  `cancelPendingLogin(key)` is the one `/esc` step for every flow: it kills whichever pty the thread has and returns
  whether one was pending — `/esc` with nothing pending keeps its ordinary meaning (interrupt the agent).
- **The outcome comes from the CLI itself:** `claude auth status --json` (exit code as the fallback) and OpenCode's
  `auth.json` (plus a provider-auth reload). A success also retires the pinned logged-out notice.
- **A pty is a bot child and is not restart-safe:** a restart drops the flow. `cancel…` (`/quit`, session release,
  teardown) kills the pty and forgets the thread's entry; a cancelled flow never reports.
- **A Claude sign-in may target an account profile** (`startClaudeAuthLogin(key, { name, configDir })`, from
  `/accounts`): the pty AND the `claude auth status` probe run with that profile's `CLAUDE_CONFIG_DIR`, the link
  message tells the operator to open it as the other account, the confirmation names the account (email, plan),
  and the parsed status goes to the bot through the optional `onClaudeProfileAuthStatus` port. Only the
  `default` profile (no directory of its own) retires the pinned logged-out notice — it IS the `~/.claude` login.
- **An API account** (`{ billing: 'api' }`, billed to a Claude Console organization's API credits) signs in with
  `claude auth login --console` (`buildClaudeAuthLoginArgs`) — the subcommand always CREATES an API key and keeps it
  in the profile's own `.claude.json`; it never takes the keyless Console sign-in, which lives outside
  `CLAUDE_CONFIG_DIR` and signs the subscriptions out. Its paste may be an existing API key instead of the code.
- **Any text that carries an Anthropic credential (`sk-ant-…`, also inside `ANTHROPIC_API_KEY=…` or a sentence — such
  a text would otherwise pass as a code or be left in the topic) is a secret in EVERY Claude sign-in:** the message
  is deleted before anything else and never typed into the pty. An API account hands the one usable key it carries
  (`sk-ant-api…`) to the bot through the optional `onClaudeProfileApiKey` port (which verifies and stores it for that
  profile only) and the Console login is stopped; any other credential, or a key in a subscription sign-in, is refused
  and the flow stays armed.
- The parse and decision helpers are `../utils/claudeAuthLogin.ts` and `../utils/openCodeAuthLogin.ts`.
