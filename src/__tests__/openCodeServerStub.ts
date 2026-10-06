/**
 * @description A healthy OpenCode server for adapter tests, without a server: the health probe
 * (`/global/health`, read by `checkIsOpenCodeServerRunning` / `ensureOpenCodeServer`) answers 200 and
 * `OPENCODE_BIN` makes `checkIsInstalled('opencode')` true without a lookup. Nothing is started, installed or
 * reached: without it an adapter test that starts or resumes a session asks whatever listens on the default
 * port — on a dev box the live bot's server (an outdated one would even be restarted) — and where nothing
 * listens it starts a real `opencode serve`, whose piped output keeps the test process alive for good.
 * Any other fetch fails loudly, so a test cannot reach the network unnoticed.
 *
 * Matches neither runner glob; imported by the OpenCode adapter tests.
 */

import { afterEach, beforeEach } from 'node:test';

const healthPath = '/global/health';
/** A binary that exists everywhere and does nothing: `checkIsInstalled` only needs the path to exist. */
const stubOpenCodeBinary = '/usr/bin/true';

/** @description Register the stub around every test of the calling file. */
export function useStubbedOpenCodeServer(): void {
  let originalFetch: typeof fetch;
  let originalOpenCodeBin: string | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalOpenCodeBin = process.env.OPENCODE_BIN;
    process.env.OPENCODE_BIN = stubOpenCodeBinary;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith(healthPath)) return new Response('ok', { status: 200 });
      throw new Error(`unexpected fetch in test: ${url}`);
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalOpenCodeBin === undefined) delete process.env.OPENCODE_BIN;
    else process.env.OPENCODE_BIN = originalOpenCodeBin;
  });
}
