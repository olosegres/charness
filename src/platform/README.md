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

## Requests and answers (`../requests/`)

A **request** is the core's unit of "someone is owed an answer": a message in an answers-only Telegram topic,
a Jira hand-over, a scheduled run. A connector opens it with an **origin** (`kind` plus connector-owned string
`attributes`) and a prompt; the agent answers through the `answer_request` tool and the platform's `AnswerSink`
delivers it. Rules every connector relies on:

- **Grouping (`requestGroup.ts`).** A new request supersedes an earlier OPEN one only within the same group:
  the conversation (`SessionKey`) AND the **requester** — the origin attribute named by
  `requestRequesterAttribute`. A connector that wants per-person requests puts the sender there (a Telegram
  user id, a Jira account id); an origin without it reads as the empty requester, so every such request in a
  conversation shares one group. The newer request's prompt header names the ids it replaced and asks for only
  what it adds (the agent may already have answered them: Claude Code delivers a message written mid-turn only
  after the turn ends). Two requesters in one conversation hold two open requests, each woken and alerted on
  its own.
- **Answer kinds.** `progress` keeps the request open; `question` and `final` close it. An answer to a request
  that is already closed is still delivered (the agent may be late) but changes nothing — a Jira sink, for
  one, never hands an issue back for it.
- **Wake-ups.** A turn that ends with the request still open is reminded; a progress note defers the follow-up;
  a request nobody has worked on for `REQUEST_BACKSTOP_MINUTES` is re-posted; when the rules give up the sink
  gets `deliverAlert`, and a later answer or supersede `releaseAlert`.

## Adding a connector

1. A `SessionKey` codec (`sessionKey.ts` registry) for the platform's conversation id, with an exact inverse.
2. `ConnectorInbound` → normalized events / requests; `ConnectorOutbound` + `AnswerSink`, registered by
   `key.platform` at boot; `ConnectorCapabilities` so the shared degradation rule applies.
3. Its name in `CONNECTORS` (`connectorSet.ts`), guards in `cli/connectorGuards.ts` if it needs isolation, and a
   lazy `import()` so an instance that does not serve it never loads its packages.
4. A process-level e2e against a fake of the platform (`__tests__/e2e/isolatedCharness.ts` boots the built CLI
   as an isolated instance; `__tests__/jiraE2e/` is the reference).

## Boundary status

`__tests__/platformBoundary.test.ts` fails when a module outside `connectors/telegram/` imports the Telegram
library; its exemption ledger (currently `bot.ts` alone) may only shrink and the test rejects a stale entry.
Residual debt: `bot.ts` still mixes the telegraf composition with platform-neutral orchestration (session
lifecycle, scheduling, MCP wiring), so it has to be split rather than moved; `threadRouting.ts`,
`rateLimiter.ts` and `outputTrace.ts` still import the Telegram key accessors from the connector, which
points the dependency the wrong way.
