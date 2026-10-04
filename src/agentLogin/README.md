# `src/agentLogin/` — out-of-band sign-in drivers

`createAgentLogin(ports)` returns the drivers behind the json-stream `/login` (`claude auth login --claudeai`)
and the OpenCode `/connect` OAuth (`opencode auth login`). Each runs its CLI in a pty owned by the bot and relays
it through the topic. `bot.ts` wires the ports (`replyToThread`, `deleteThreadMessage`, `clearAuthNotice`,
`execFileAsync`); nothing here imports `bot.ts` or the Telegram library.

- **The link goes out only once the CLI's "paste the code" prompt (or a device code / wait line) is on screen** —
  never a chunk-split half-URL.
- **The pasted code is a single-use secret:** the user's message is deleted, then the code is typed into the pty.
  Gate on `checkIs…Awaiting…` before taking a plain message for a code: a flow that has not relayed its link yet
  must not swallow the user's text, and an OpenCode reply that is neither a callback link nor a plausible code is
  never consumed (`submitOpenCodeOAuthReply` returns `false`; the flow stays armed).
- **The outcome comes from the CLI itself:** `claude auth status --json` (exit code as the fallback) and OpenCode's
  `auth.json` (plus a provider-auth reload). A success also retires the pinned logged-out notice.
- **A pty is a bot child and is not restart-safe:** a restart drops the flow. `cancel…` (`/quit`, session release,
  teardown) kills the pty and forgets the thread's entry; a cancelled flow never reports.
- The parse and decision helpers are `../utils/claudeAuthLogin.ts` and `../utils/openCodeAuthLogin.ts`.
