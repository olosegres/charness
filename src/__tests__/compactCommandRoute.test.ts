/**
 * @description Routing of the bot-owned `/compact` command
 * (`getCompactCommandRoute`).
 *
 * The locked three-way contract:
 *   - a backend with a server-side compaction endpoint (OpenCode, which
 *     implements the optional `compactContext`) → `adapterCompact`. This is the
 *     bug fix: OpenCode's prompt transport does no slash-command parsing, so
 *     forwarding the literal `/compact` text burned a model turn and compacted
 *     nothing;
 *   - the raw-shell backend → `notSupported` (a shell has no context, and
 *     `/compact` typed into it is a meaningless command);
 *   - anything else — BOTH Claude backends, whose TUI/CLI parses `/compact`
 *     natively → `forwardToAgent`, i.e. today's behaviour is preserved.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getCompactCommandRoute } from '../utils/compactCommandRoute';
import { claudeJsonStreamAdapterName } from '../adapters/adapterNames';

const terminalAdapterName = 'terminal';

describe('getCompactCommandRoute', () => {
  it('routes a backend implementing compactContext to the adapter call (OpenCode)', () => {
    assert.equal(
      getCompactCommandRoute({
        hasCompactContext: true,
        adapterName: 'opencode',
        terminalAdapterName,
      }),
      'adapterCompact',
    );
  });

  it('routes the terminal backend to the not-supported notice', () => {
    assert.equal(
      getCompactCommandRoute({
        hasCompactContext: false,
        adapterName: terminalAdapterName,
        terminalAdapterName,
      }),
      'notSupported',
    );
  });

  it('keeps the verbatim forward for BOTH Claude backends (no regression)', () => {
    for (const adapterName of ['claude', claudeJsonStreamAdapterName]) {
      assert.equal(
        getCompactCommandRoute({
          hasCompactContext: false,
          adapterName,
          terminalAdapterName,
        }),
        'forwardToAgent',
        `expected a verbatim forward for "${adapterName}"`,
      );
    }
  });

  it('the adapter capability wins over the terminal name check', () => {
    // Defensive: if a shell-like backend ever gained a real compaction endpoint,
    // the capability must be used instead of the "not supported" reply.
    assert.equal(
      getCompactCommandRoute({
        hasCompactContext: true,
        adapterName: terminalAdapterName,
        terminalAdapterName,
      }),
      'adapterCompact',
    );
  });

  it('an unknown backend falls back to the verbatim forward', () => {
    assert.equal(
      getCompactCommandRoute({
        hasCompactContext: false,
        adapterName: 'some-future-backend',
        terminalAdapterName,
      }),
      'forwardToAgent',
    );
  });
});
