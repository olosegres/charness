/**
 * @description Every call the OpenCode adapter makes to the server carries the server's password: its API requests and
 * its one event stream, read per request — each server generation the bot starts has a password of its own, so a header
 * fixed when the adapter was built would be refused after the first restart. The password is the one the bot saved for
 * the server at `OPENCODE_URL` (never one saved for another endpoint); the operator's `OPENCODE_PASSWORD` (user
 * `OPENCODE_USERNAME`) wins over it.
 *
 * Test case: N/A - Charness has no Jira tracker.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import { OpenCodeAdapter } from '../adapters/openCodeAdapter';
import { getOpenCodeServerCredentialFilePath } from '../installManager';
import { OpenCodeApiFailure, useStubbedOpenCodeServer } from './openCodeServerStub';

const server = useStubbedOpenCodeServer();
const serverUrl = 'http://127.0.0.1:4196';
const serviceUnavailableStatus = 503;

let savedEnv: Record<string, string | undefined> = {};

function createBasicAuthorization(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

function saveGenerationPassword(endpoint: string, password: string): void {
  fs.writeFileSync(getOpenCodeServerCredentialFilePath(), JSON.stringify({ endpoint, password }), { mode: 0o600 });
}

/** @description Open the adapter's event stream once: the stubbed server refuses it and the stream is closed, so it never reconnects. */
async function openEventStreamOnce(adapter: OpenCodeAdapter): Promise<void> {
  const stream = { directory: '<global>', controller: null, stallTimer: null, reconnectTimer: null, isClosed: false };
  server.answerApiWith(({ urlPath }) => {
    if (urlPath !== '/global/event') throw new Error(`unexpected request ${urlPath}`);
    stream.isClosed = true;
    throw new OpenCodeApiFailure(serviceUnavailableStatus, 'not now');
  });
  const originalError = console.error;
  console.error = () => {};
  try {
    await adapter['pollSseStream'](stream, `${serverUrl}/global/event`);
  } finally {
    console.error = originalError;
  }
}

beforeEach(() => {
  savedEnv = { OPENCODE_URL: process.env.OPENCODE_URL, OPENCODE_PASSWORD: process.env.OPENCODE_PASSWORD, OPENCODE_USERNAME: process.env.OPENCODE_USERNAME };
  process.env.OPENCODE_URL = serverUrl;
  delete process.env.OPENCODE_PASSWORD;
  delete process.env.OPENCODE_USERNAME;
});

afterEach(() => {
  fs.rmSync(getOpenCodeServerCredentialFilePath(), { force: true });
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe('the OpenCode adapter authenticates to the server', () => {
  it('sends the saved generation password on API requests and the event stream — and the new one after a restart', async () => {
    const adapter = new OpenCodeAdapter();
    saveGenerationPassword(serverUrl, 'first-generation');
    server.answerApiWith(() => ({}));
    await adapter['apiRequest']('GET', '/config');

    saveGenerationPassword(serverUrl, 'second-generation-after-a-restart');
    server.answerApiWith(() => ({}));
    await adapter['apiRequest']('GET', '/config');
    await openEventStreamOnce(adapter);

    assert.deepEqual(server.getRequestAuthorizations(), [
      { urlPath: '/config', authorization: createBasicAuthorization('opencode', 'first-generation') },
      { urlPath: '/config', authorization: createBasicAuthorization('opencode', 'second-generation-after-a-restart') },
      { urlPath: '/global/event', authorization: createBasicAuthorization('opencode', 'second-generation-after-a-restart') },
    ]);
  });

  it('never sends a password saved for another endpoint', async () => {
    const adapter = new OpenCodeAdapter();
    saveGenerationPassword('http://127.0.0.1:4096', 'another-instances-server');
    server.answerApiWith(() => ({}));
    await adapter['apiRequest']('GET', '/config');
    assert.deepEqual(server.getRequestAuthorizations(), [{ urlPath: '/config', authorization: null }]);
  });

  it('sends the operator\'s OPENCODE_PASSWORD, as OPENCODE_USERNAME, over a saved one', async () => {
    process.env.OPENCODE_PASSWORD = 'operator-chosen';
    process.env.OPENCODE_USERNAME = 'operator';
    const adapter = new OpenCodeAdapter();
    saveGenerationPassword(serverUrl, 'generated');
    server.answerApiWith(() => ({}));
    await adapter['apiRequest']('GET', '/config');
    await openEventStreamOnce(adapter);
    assert.deepEqual(server.getRequestAuthorizations(), [
      { urlPath: '/config', authorization: createBasicAuthorization('operator', 'operator-chosen') },
      { urlPath: '/global/event', authorization: createBasicAuthorization('operator', 'operator-chosen') },
    ]);
  });
});
