# `src/platform/` — the core-side seam contracts

The core never speaks to a chat or tracker platform. It consumes normalized inbound events and emits semantic
outbound content, both addressed by a platform-agnostic `SessionKey`; a connector under `../connectors/`
implements the other side. No platform library may be imported here (the architecture diagram is in
`DEVELOPMENT.md`).

| File | Contract |
|------|----------|
| `inbound.ts` | `InboundEvent`, `NormalizedAttachment`, `PlatformMember`, `ConnectorInbound` |
| `outbound.ts` | `OutboundContent`, `OutboundHints`, `ActivityState`, `ConnectorCapabilities`, `ConnectorOutbound`, and `getConnectorOutbound(outbounds, key)` — the ONE lookup by `key.platform` |
| `answerSink.ts` | `AnswerSink`: `deliverAnswer`, `deliverAlert`, `releaseAlert`; found through the ONE lookup `getAnswerSink` |
| `capabilityFallback.ts` | `getDegradedContent`, `checkNeedsOwnMessage` — how content degrades when a surface cannot express it |
| `commandRouter.ts` | The neutral name → handler table |
| `connectorSet.ts` | `CONNECTORS` parsing and `getServedConversations` |
| `unservedStateGuard.ts` | Refuses to boot on another platform's persisted state |

## Rules that are not obvious from the types

- **No `isAdmin` on an inbound author.** `AdminCache` stays the single authority on that answer, so a connector
  cannot grant rights by how it fills an event. A membership lookup that cannot be answered must REJECT; an
  empty resolve is a valid "no elevated members" answer that the cache would store as fresh.
- **The answer sink is separate from `ConnectorOutbound` on purpose.** The outbound stream is fire-and-forget;
  an answer must report whether it landed (the agent retries on a failure). One sink per platform, built once
  at boot and shared by `answer_request`, the wake-up alerts and the ledger's `releaseAlert`, which rejects when
  no sink serves the platform so the alert stays listed for a start that can.
- **A platform with no registered outbound or sink throws** — a wiring bug, never a silent drop.
- **Degradation is one shared rule** applied by every connector (a tracker has no pinning and no tappable
  buttons, so options stay as the enumerated text the body already carries and the user answers by index);
  the core never branches on a platform. `../connectors/test/` makes the degraded half reachable from tests.
- **Boot scans walk only served platforms.** Every scan that adopts, resumes, heals or KILLS sessions goes
  through `getServedConversations`, so a Telegram instance never touches a Jira conversation's session nor the
  reverse. `unservedStateGuard` is the second line: the state file is shared, so a save by one instance would
  rewrite the other platform's conversations, and two instances on one `DATA_DIR` would fight over it.
- **The command router matches names EXACTLY, case included** (telegraf's own match is case-sensitive). The
  connector recognises its trigger syntax; the core owns dispatch.

## Boundary status

`__tests__/platformBoundary.test.ts` fails when a module outside `connectors/telegram/` imports the Telegram
library; its exemption ledger (currently `bot.ts` alone) may only shrink and the test rejects a stale entry.
Residual debt: `bot.ts` still mixes the telegraf composition with platform-neutral orchestration (session
lifecycle, scheduling, MCP wiring), so it has to be split rather than moved; `threadRouting.ts`,
`rateLimiter.ts` and `outputTrace.ts` still import the Telegram key accessors from the connector, which
points the dependency the wrong way.
