/**
 * @description A healthy OpenCode server for adapter tests, without a server: the health probe
 * (`/global/health`, read by `checkIsOpenCodeServerRunning` / `ensureOpenCodeServer`) answers 200 and
 * `OPENCODE_BIN` makes `checkIsInstalled('opencode')` true without a lookup. Nothing is started, installed or
 * reached: without it an adapter test that starts or resumes a session asks whatever listens on the default
 * port — on a dev box the live bot's server (an outdated one would even be restarted) — and where nothing
 * listens it starts a real `opencode serve`, whose piped output keeps the test process alive for good.
 * Any other fetch fails loudly, so a test cannot reach the network unnoticed.
 *
 * A test that needs the server's API to answer registers a handler (`answerApiWith`): it is called for every
 * request the adapter sends, at the HTTP boundary, so the adapter's own `apiRequest` runs unchanged — the
 * handler's return value is the JSON the server replies with, `undefined` an empty 204, and an
 * {@link OpenCodeApiFailure} an HTTP error status. The health probe answers a bare `ok` unless a test needs
 * its payload (the server version) and registers `answerHealthWith`.
 *
 * Matches neither runner glob; imported by the OpenCode adapter tests.
 */

import { afterEach, beforeEach } from 'node:test';

const healthPath = '/global/health';
/** A binary that exists everywhere and does nothing: `checkIsInstalled` only needs the path to exist. */
const stubOpenCodeBinary = '/usr/bin/true';
/** `http://host:port` in front of the path the adapter asked for. */
const urlOriginPattern = /^[a-z]+:\/\/[^/]+/i;
const jsonContentType = 'application/json';
const noContentStatus = 204;
const okStatus = 200;

/**
 * @description A JSON document — the only thing the OpenCode HTTP API speaks. An object property may be
 * `undefined`: `JSON.stringify` drops it, which is how a test says "the server omits this field".
 */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue | undefined };

/** @description One request the adapter sent to the stubbed server; `urlPath` includes the query string. */
export interface OpenCodeApiRequest {
  method: string;
  urlPath: string;
  body: JsonValue | undefined;
}

/** @description The server's reply: its JSON, or `undefined` for an empty `204`. May be async. */
export type OpenCodeApiHandler = (request: OpenCodeApiRequest) => JsonValue | undefined | Promise<JsonValue | undefined>;

/** @description Thrown by a handler to make the stubbed server answer with an HTTP error status. */
export class OpenCodeApiFailure extends Error {
  constructor(readonly status: number, readonly responseText: string) {
    super(`stubbed OpenCode API failure ${status}: ${responseText}`);
  }
}

/** @description The health probe's reply: the JSON `GET /global/health` returns. May be async. */
export type OpenCodeHealthHandler = () => JsonValue | Promise<JsonValue>;

/** @description What {@link useStubbedOpenCodeServer} hands back to the calling file. */
export interface StubbedOpenCodeServer {
  /** Answer every API request of the CURRENT test with `handler` (dropped again after the test). */
  answerApiWith(handler: OpenCodeApiHandler): void;
  /** Answer the health probe of the CURRENT test with `handler` (dropped again after the test). */
  answerHealthWith(handler: OpenCodeHealthHandler): void;
}

/** @description Register the stub around every test of the calling file. */
export function useStubbedOpenCodeServer(): StubbedOpenCodeServer {
  let originalFetch: typeof fetch;
  let originalOpenCodeBin: string | undefined;
  let apiHandler: OpenCodeApiHandler | null = null;
  let healthHandler: OpenCodeHealthHandler | null = null;

  const answerHealthRequest = async (): Promise<Response> => {
    if (!healthHandler) return new Response('ok', { status: okStatus });
    return new Response(JSON.stringify(await healthHandler()), { status: okStatus, headers: { 'content-type': jsonContentType } });
  };

  const answerApiRequest = async (url: string, init: RequestInit | undefined): Promise<Response> => {
    if (!apiHandler) throw new Error(`unexpected fetch in test: ${url}`);
    const requestBody: JsonValue | undefined = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    try {
      const reply = await apiHandler({
        method: init?.method ?? 'GET',
        urlPath: url.replace(urlOriginPattern, ''),
        body: requestBody,
      });
      if (reply === undefined) return new Response(null, { status: noContentStatus });
      return new Response(JSON.stringify(reply), { status: okStatus, headers: { 'content-type': jsonContentType } });
    } catch (error) {
      if (error instanceof OpenCodeApiFailure) return new Response(error.responseText, { status: error.status });
      throw error;
    }
  };

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalOpenCodeBin = process.env.OPENCODE_BIN;
    process.env.OPENCODE_BIN = stubOpenCodeBinary;
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith(healthPath)) return answerHealthRequest();
      return answerApiRequest(url, init);
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    apiHandler = null;
    healthHandler = null;
    if (originalOpenCodeBin === undefined) delete process.env.OPENCODE_BIN;
    else process.env.OPENCODE_BIN = originalOpenCodeBin;
  });

  return {
    answerApiWith(handler) {
      apiHandler = handler;
    },
    answerHealthWith(handler) {
      healthHandler = handler;
    },
  };
}
