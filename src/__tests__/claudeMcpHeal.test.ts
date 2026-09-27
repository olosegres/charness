/**
 * @description The reverse-engineered MCP heal layer (`utils/claudeMcpHeal.ts`):
 * the `mcp_status` / `mcp_reconnect` control-request shapes, reading one
 * server's status out of a status payload, and the heal decision.
 *
 * Load-bearing intent (per `.claude/rules/tests.md`):
 *   - the two builders must produce BYTE-EXACT the frames measured against a
 *     live `claude` process (a renamed field — `server_name` for `serverName`,
 *     a wrong `subtype` — is a silent no-op the session never recovers from);
 *   - `getMcpServerStatus` must return the status of the NAMED server only, and
 *     `null` for every shape it cannot read, because `null` is what makes the
 *     decision refuse to act;
 *   - the decision table is the safety boundary: `failed` is the ONLY status
 *     that may trigger a reconnect inside a live session.
 *
 * Test case: n/a (no Jira tracker for this project).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMcpReconnectControlRequest,
  buildMcpStatusControlRequest,
  decideMcpHeal,
  getMcpServerStatus,
  mcpControlRequestTimeoutMs,
} from '../utils/claudeMcpHeal';
import { schedulerMcpServerName } from '../scheduler/injection';

describe('buildMcpStatusControlRequest / buildMcpReconnectControlRequest', () => {
  it('builds the exact measured mcp_status frame', () => {
    assert.deepEqual(buildMcpStatusControlRequest('mcp_status_720b9e6d'), {
      type: 'control_request',
      request_id: 'mcp_status_720b9e6d',
      request: { subtype: 'mcp_status' },
    });
  });

  it('builds the exact measured mcp_reconnect frame (serverName is camelCase on the wire)', () => {
    assert.deepEqual(buildMcpReconnectControlRequest('mcp_reconnect_59e1646e', schedulerMcpServerName), {
      type: 'control_request',
      request_id: 'mcp_reconnect_59e1646e',
      request: { subtype: 'mcp_reconnect', serverName: 'telegramBot' },
    });
  });

  it('serialises byte-identically to the captured stdin lines', () => {
    // The CLI reads newline-delimited JSON, so the serialised form — key order
    // included — is what actually goes on the wire.
    assert.equal(
      JSON.stringify(buildMcpStatusControlRequest('mcp_status_720b9e6d')),
      '{"type":"control_request","request_id":"mcp_status_720b9e6d","request":{"subtype":"mcp_status"}}',
    );
    assert.equal(
      JSON.stringify(buildMcpReconnectControlRequest('mcp_reconnect_59e1646e', 'telegramBot')),
      '{"type":"control_request","request_id":"mcp_reconnect_59e1646e","request":{"subtype":"mcp_reconnect","serverName":"telegramBot"}}',
    );
  });

  it('bounds one control round-trip generously but finitely', () => {
    assert.ok(mcpControlRequestTimeoutMs >= 5000 && mcpControlRequestTimeoutMs <= 60000,
      `a loopback stdio round-trip bound must stay in seconds, got ${mcpControlRequestTimeoutMs}`);
  });
});

describe('getMcpServerStatus', () => {
  /** The measured `mcp_status` payload: one failed bot server next to a healthy one. */
  const payload = {
    mcpServers: [
      { name: 'someOtherServer', status: 'connected', serverInfo: { name: 'other', version: '1.0.0' } },
      {
        name: 'telegramBot',
        status: 'failed',
        error: 'ECONNREFUSED: Unable to connect. Is the computer able to access the url?',
        config: { type: 'http', url: 'http://127.0.0.1:12345/mcp' },
      },
    ],
  };

  it('returns the named server status, not the first entry in the list', () => {
    assert.equal(getMcpServerStatus(payload, 'telegramBot'), 'failed');
    assert.equal(getMcpServerStatus(payload, 'someOtherServer'), 'connected');
  });

  it('reads a connected telegramBot (the post-reconnect payload)', () => {
    const healed = {
      mcpServers: [{ name: 'telegramBot', status: 'connected', serverInfo: { name: 'telegram-bot-scheduler', version: '1.0.0' } }],
    };
    assert.equal(getMcpServerStatus(healed, 'telegramBot'), 'connected');
  });

  it('returns null when no entry carries that name', () => {
    assert.equal(getMcpServerStatus(payload, 'notRegistered'), null);
  });

  it('returns null for a payload with no / non-array mcpServers, and for a null payload', () => {
    assert.equal(getMcpServerStatus({}, 'telegramBot'), null);
    assert.equal(getMcpServerStatus({ mcpServers: 'telegramBot' }, 'telegramBot'), null);
    assert.equal(getMcpServerStatus(null, 'telegramBot'), null);
  });

  it('returns null when the matching entry has no string status', () => {
    assert.equal(getMcpServerStatus({ mcpServers: [{ name: 'telegramBot' }] }, 'telegramBot'), null);
    assert.equal(getMcpServerStatus({ mcpServers: [{ name: 'telegramBot', status: 3 }] }, 'telegramBot'), null);
  });

  it('skips non-record entries instead of throwing on them', () => {
    assert.equal(
      getMcpServerStatus({ mcpServers: [null, 'telegramBot', { name: 'telegramBot', status: 'failed' }] }, 'telegramBot'),
      'failed',
    );
  });
});

describe('decideMcpHeal — the full table', () => {
  it('connected → healthy (a working server is never touched)', () => {
    assert.equal(decideMcpHeal('connected'), 'healthy');
  });

  it('failed → reconnect (the latched state this whole path exists for)', () => {
    assert.equal(decideMcpHeal('failed'), 'reconnect');
  });

  it('needs-auth → skip (a human must authorise it; reconnecting would loop)', () => {
    assert.equal(decideMcpHeal('needs-auth'), 'skip');
  });

  it('an unknown status → skip, never guessed into a live session', () => {
    assert.equal(decideMcpHeal('connecting'), 'skip');
    assert.equal(decideMcpHeal('pending'), 'skip');
    assert.equal(decideMcpHeal(''), 'skip');
    assert.equal(decideMcpHeal('Failed'), 'skip'); // status matching is exact
  });

  it('null (server absent / status unreadable) → skip', () => {
    assert.equal(decideMcpHeal(null), 'skip');
  });
});
