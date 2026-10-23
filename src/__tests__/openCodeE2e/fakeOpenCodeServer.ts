/**
 * @description A stand-in for the `opencode` server and CLI in the process-level tests (the Claude ↔ OpenCode
 * fallback flows), the OpenCode twin of the fake `claude` (`jiraE2e/fakeClaude.ts`). It serves ONLY what the bot
 * calls when it adopts a server, starts or resumes a session and sends a prompt — nothing else:
 *
 *   • `GET /global/health` — the liveness + version probe (the bot adopts a healthy server instead of spawning one);
 *   • `GET /global/event` — the one multiplexed SSE stream: a `server.connected` frame, then a heartbeat;
 *   • `GET /config` (also `?directory=`) — the default model and the plugin list (with the bot's compaction plugin,
 *     so the bot does not recreate the folder's instance); `GET /config/providers` — the models and their variants;
 *   • `GET|POST /mcp?directory=` — the runtime MCP table (the bot registers its `telegramBot` server there);
 *   • `POST /session?directory=`, `GET /session/:id`, `GET /session?directory=`, `GET /session/:id/message` (the prompts it received, as stored user messages),
 *     `GET /session/status`, `GET /question?directory=` (the pending questions: none), `PATCH /session/:id`,
 *     `POST /session/:id/abort`, `POST /session/:id/prompt_async`, `POST /session/:id/summarize`;
 *   • `POST /instance/dispose`.
 *
 * Every request is recorded; one that is none of these is answered `404` AND listed in `unhandled`, so a flow can
 * assert the bot asked for nothing the fake does not model. A prompt is recorded with its text and model, and never
 * answered by itself — a flow decides what the "model" does next: {@link FakeOpenCodeServer.emitUsageLimit} makes the
 * session's turn fail the way a subscription limit does.
 *
 * `writeFakeOpenCodeBinary` writes the `opencode` executable the bot shells out to (`opencode models`, `--version`,
 * and — when a flow asks for it — the `opencode serve` the bot spawns once the server is down), and `writeFakeNpm`
 * the `npm` its install step runs. Loopback only; nothing leaves the machine.
 */

import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { openCodeCompactPluginFileName } from '../../utils/openCodeCompactPlugin';

/** How often the event stream sends a heartbeat (the bot's stall watchdog allows four missed 10 s beats). */
const heartbeatIntervalMs = 5_000;
const okStatus = 200;
const noContentStatus = 204;
const notFoundStatus = 404;
const jsonContentType = 'application/json';

export interface FakeOpenCodeRequest {
  method: string;
  /** The path without its query string. */
  path: string;
  /** The `?directory=` instance selector, `null` when the request names none. */
  directory: string | null;
  body: unknown;
}

/** One `POST /session/:id/prompt_async` the bot sent. */
export interface FakeOpenCodePrompt {
  sessionId: string;
  directory: string | null;
  /** The text parts of the prompt, joined. */
  text: string;
  /** `provider/model` of the prompt's model override, `null` when it names none. */
  model: string | null;
}

export interface FakeOpenCodeSession {
  id: string;
  directory: string | null;
  title: string | null;
}

export interface FakeOpenCodeOptions {
  /** What `GET /global/health` and `opencode --version` report. */
  version: string;
  /** Every `provider/model` the server is authenticated for (what `opencode models` lists). */
  models: readonly string[];
  /** The server's default model, `provider/model`. */
  defaultModel: string;
}

interface PromptBody {
  parts?: Array<{ type?: string; text?: string }>;
  model?: { providerID?: string; modelID?: string };
}

export class FakeOpenCodeServer {
  readonly requests: FakeOpenCodeRequest[] = [];
  readonly unhandled: FakeOpenCodeRequest[] = [];
  readonly prompts: FakeOpenCodePrompt[] = [];
  readonly sessions = new Map<string, FakeOpenCodeSession>();
  /** Per instance directory, the MCP servers registered with `POST /mcp`. */
  readonly mcpRegistrations = new Map<string, string[]>();
  private readonly server: http.Server;
  private readonly eventStreams = new Set<http.ServerResponse>();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private sessionCounter = 0;

  constructor(private readonly options: FakeOpenCodeOptions) {
    this.server = http.createServer((request, response) => {
      this.handle(request, response).catch((error: Error) => {
        response.statusCode = 500;
        response.end(error.message);
      });
    });
  }

  /** @description Listen on `port` (loopback); resolves the server's URL. */
  async start(port: number): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(port, '127.0.0.1', resolve));
    this.heartbeatTimer = setInterval(() => this.broadcast({ type: 'server.heartbeat', properties: {} }), heartbeatIntervalMs);
    return `http://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    for (const stream of this.eventStreams) stream.end();
    this.eventStreams.clear();
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** @description Requests with this method and path, in arrival order. */
  listRequests(method: string, requestPath: string): FakeOpenCodeRequest[] {
    return this.requests.filter((request) => request.method === method && request.path === requestPath);
  }

  /**
   * @description Make the session's turn fail the way a subscription limit does: a `session.error` on the event
   * stream whose text names the window and its reset (an ISO instant, which the bot reads as the reset).
   */
  emitUsageLimit(sessionId: string, resetsAtIso: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`no such fake OpenCode session: ${sessionId}`);
    const message = `You've hit your usage limit · resets ${resetsAtIso}`;
    this.broadcast({ type: 'session.error', properties: { sessionID: sessionId, error: { name: 'APIError', data: { message, statusCode: 429, isRetryable: false } } } }, session.directory);
  }

  /**
   * @description OpenCode retrying the provider by itself: the `session.status` of type `retry` it emits between attempts
   * (`message` is the provider's error message, `next` the epoch ms of the next attempt).
   */
  emitProviderRetry(sessionId: string, retry: { attempt: number; message: string; next: number }): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`no such fake OpenCode session: ${sessionId}`);
    this.broadcast({ type: 'session.status', properties: { sessionID: sessionId, status: { type: 'retry', ...retry } } }, session.directory);
  }

  /** @description The session done with its turn: the `session.status` of type `idle` and the `session.idle` OpenCode emits. */
  emitSessionIdle(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`no such fake OpenCode session: ${sessionId}`);
    this.broadcast({ type: 'session.status', properties: { sessionID: sessionId, status: { type: 'idle' } } }, session.directory);
    this.broadcast({ type: 'session.idle', properties: { sessionID: sessionId } }, session.directory);
  }

  /** @description The session working on a turn: the `session.status` of type `busy` OpenCode emits as a turn starts. */
  emitSessionBusy(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`no such fake OpenCode session: ${sessionId}`);
    this.broadcast({ type: 'session.status', properties: { sessionID: sessionId, status: { type: 'busy' } } }, session.directory);
  }

  /**
   * @description A `session.error` carrying `error` as OpenCode relays it (`{ name: 'APIError', data: { message,
   * statusCode, responseHeaders, responseBody, … } }`), for the session `sessionId` — which may be one the fake never
   * created (a sub-agent's child session, a foreign session in the same folder): `directory` routes it then.
   */
  emitSessionError(sessionId: string, error: Record<string, unknown>, directory: string | null = this.sessions.get(sessionId)?.directory ?? null): void {
    this.broadcast({ type: 'session.error', properties: { sessionID: sessionId, error } }, directory);
  }

  /**
   * @description The turn's assistant message stored with its failure: the `message.updated` whose `info.error` is
   * `error` — what OpenCode publishes beside (before or after) the `session.error` of the same failure, and alone for a
   * failed compaction.
   */
  emitFailedAssistantMessage(sessionId: string, messageId: string, error: Record<string, unknown>): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`no such fake OpenCode session: ${sessionId}`);
    this.broadcast({ type: 'message.updated', properties: { info: { id: messageId, sessionID: sessionId, role: 'assistant', error, time: { created: Date.now() } } } }, session.directory);
  }

  /**
   * @description A sub-agent's child session appearing: the `session.updated` whose `info.parentID` names the parent —
   * how OpenCode tells the bot a session's lineage. The child is not added to {@link sessions}: the bot never created it.
   */
  emitChildSession(parentSessionId: string, childSessionId: string): void {
    const parent = this.sessions.get(parentSessionId);
    if (!parent) throw new Error(`no such fake OpenCode session: ${parentSessionId}`);
    this.broadcast({ type: 'session.updated', properties: { info: { id: childSessionId, parentID: parentSessionId, title: 'sub-agent' } } }, parent.directory);
  }

  private broadcast(payload: { type: string; properties: Record<string, unknown> }, directory: string | null = null): void {
    const frame = `data: ${JSON.stringify(directory === null ? { payload } : { directory, payload })}\n\n`;
    for (const stream of this.eventStreams) stream.write(frame);
  }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const method = request.method ?? 'GET';
    const record: FakeOpenCodeRequest = { method, path: url.pathname, directory: url.searchParams.get('directory'), body: await readJsonBody(request) };
    this.requests.push(record);
    const reply = (body: unknown): void => {
      response.writeHead(okStatus, { 'content-type': jsonContentType });
      response.end(JSON.stringify(body));
    };
    const sessionMatch = /^\/session\/([^/]+)(\/[a-z_]+)?$/.exec(record.path);

    if (method === 'GET' && record.path === '/global/health') return reply({ healthy: true, version: this.options.version });
    if (method === 'GET' && record.path === '/global/event') return this.openEventStream(response);
    if (method === 'GET' && record.path === '/config') return reply(this.buildConfig());
    if (method === 'GET' && record.path === '/config/providers') return reply(this.buildProviders());
    if (method === 'GET' && record.path === '/mcp') return reply(this.buildMcpStatus(record.directory));
    if (method === 'POST' && record.path === '/mcp') return reply(this.registerMcp(record));
    if (method === 'GET' && record.path === '/question') return reply([]);
    if (method === 'GET' && record.path === '/session/status') return reply({});
    if (method === 'GET' && record.path === '/session') return reply([...this.sessions.values()].filter((session) => session.directory === record.directory).map(toApiSession));
    if (method === 'POST' && record.path === '/session') return reply(toApiSession(this.createSession(record)));
    if (method === 'POST' && record.path === '/instance/dispose') return reply(true);
    if (sessionMatch) {
      const session = this.sessions.get(sessionMatch[1]);
      const action = sessionMatch[2] ?? '';
      if (session && method === 'GET' && action === '') return reply(toApiSession(session));
      if (session && method === 'GET' && action === '/message') return reply(this.buildStoredMessages(session));
      if (session && method === 'PATCH' && action === '') {
        const title = (record.body as { title?: string } | null)?.title;
        if (typeof title === 'string') session.title = title;
        return reply(toApiSession(session));
      }
      if (session && method === 'POST' && action === '/abort') return reply(true);
      // A compaction (`/compact`): accepted and recorded; what the model then does is the flow's to emit.
      if (session && method === 'POST' && action === '/summarize') return reply(true);
      if (session && method === 'POST' && action === '/prompt_async') {
        this.recordPrompt(session, record.body as PromptBody | null);
        response.writeHead(noContentStatus);
        response.end();
        return;
      }
    }
    this.unhandled.push(record);
    response.writeHead(notFoundStatus, { 'content-type': jsonContentType });
    response.end(JSON.stringify({ error: `the fake OpenCode does not model ${method} ${record.path}` }));
  }

  private openEventStream(response: http.ServerResponse): void {
    response.writeHead(okStatus, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    response.write(`data: ${JSON.stringify({ payload: { type: 'server.connected', properties: {} } })}\n\n`);
    this.eventStreams.add(response);
    response.on('close', () => this.eventStreams.delete(response));
  }

  private buildConfig(): { defaultModel: { providerID: string; modelID: string }; plugin: string[] } {
    const [providerID, ...rest] = this.options.defaultModel.split('/');
    return { defaultModel: { providerID, modelID: rest.join('/') }, plugin: [`file:///fake-opencode/plugins/${openCodeCompactPluginFileName}`] };
  }

  private buildProviders(): { providers: Array<{ id: string; models: Record<string, { variants: Record<string, object> }> }> } {
    const byProvider = new Map<string, Record<string, { variants: Record<string, object> }>>();
    for (const label of this.options.models) {
      const [providerId, ...rest] = label.split('/');
      const models = byProvider.get(providerId) ?? {};
      models[rest.join('/')] = { variants: { low: {}, medium: {}, high: {} } };
      byProvider.set(providerId, models);
    }
    return { providers: [...byProvider].map(([id, models]) => ({ id, models })) };
  }

  private buildMcpStatus(directory: string | null): Record<string, { status: string }> {
    return Object.fromEntries((this.mcpRegistrations.get(directory ?? '') ?? []).map((name) => [name, { status: 'connected' }]));
  }

  private registerMcp(record: FakeOpenCodeRequest): Record<string, { status: string }> {
    const name = (record.body as { name?: string } | null)?.name;
    if (typeof name === 'string') {
      const directory = record.directory ?? '';
      this.mcpRegistrations.set(directory, [...new Set([...(this.mcpRegistrations.get(directory) ?? []), name])]);
    }
    return this.buildMcpStatus(record.directory);
  }

  private createSession(record: FakeOpenCodeRequest): FakeOpenCodeSession {
    this.sessionCounter += 1;
    const title = (record.body as { title?: string } | null)?.title;
    const session: FakeOpenCodeSession = { id: `ses_fake${this.sessionCounter}`, directory: record.directory, title: typeof title === 'string' ? title : null };
    this.sessions.set(session.id, session);
    return session;
  }

  /** What `GET /session/:id/message` returns: the prompts the bot sent into the session, as stored user messages. */
  private buildStoredMessages(session: FakeOpenCodeSession): Array<{ info: { id: string; role: 'user' }; parts: Array<{ type: 'text'; text: string }> }> {
    return this.prompts
      .filter((prompt) => prompt.sessionId === session.id)
      .map((prompt, index) => ({ info: { id: `msg_${session.id}_${index}`, role: 'user' as const }, parts: [{ type: 'text' as const, text: prompt.text }] }));
  }

  private recordPrompt(session: FakeOpenCodeSession, body: PromptBody | null): void {
    const text = (body?.parts ?? []).filter((part) => part.type === 'text').map((part) => part.text ?? '').join('\n');
    const model = body?.model?.providerID && body.model.modelID ? `${body.model.providerID}/${body.model.modelID}` : null;
    this.prompts.push({ sessionId: session.id, directory: session.directory, text, model });
  }
}

function toApiSession(session: FakeOpenCodeSession): { id: string; title?: string; time: { created: number; updated: number } } {
  const now = Date.now();
  return { id: session.id, ...(session.title === null ? {} : { title: session.title }), time: { created: now, updated: now } };
}

async function readJsonBody(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  if (text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** @description What the fake `opencode` executable does besides `--version` and `models`. */
export interface FakeOpenCodeBinaryOptions extends Pick<FakeOpenCodeOptions, 'version' | 'models'> {
  /**
   * When set, `opencode serve` appends its pid to this file and then stays up (it serves nothing: the flow starts
   * the {@link FakeOpenCodeServer} again on the port once it sees the pid). Unset, `serve` fails like any other command.
   */
  servePidFile?: string;
}

/**
 * @description Write the `opencode` executable the bot shells out to into `binDir` (the instance's private PATH):
 * `opencode --version` prints the version, `opencode models` lists the models, `opencode serve` is what
 * {@link FakeOpenCodeBinaryOptions.servePidFile} says, anything else fails loudly.
 */
export function writeFakeOpenCodeBinary(binDir: string, options: FakeOpenCodeBinaryOptions): string {
  const binaryPath = path.join(binDir, 'opencode');
  fs.writeFileSync(binaryPath, [
    '#!/bin/sh',
    'case "$1" in',
    `  --version) echo '${options.version}' ;;`,
    `  models) printf '%s\\n' ${options.models.map((model) => `'${model}'`).join(' ')} ;;`,
    ...(options.servePidFile ? [`  serve) echo "$$" >> '${options.servePidFile}'; exec sleep 3600 ;;`] : []),
    '  *) echo "fake opencode: unsupported command: $*" >&2; exit 2 ;;',
    'esac',
    '',
  ].join('\n'), { mode: 0o755 });
  return binaryPath;
}

/** @description What the fake `npm` does on `npm install -g opencode-ai`. */
export interface FakeNpmOptions {
  /** Each install call appends a line here, so a flow can count them. */
  callLogFile: string;
  /** How many install calls fail first (the way a concurrent upgrade's lock makes npm fail) before one succeeds. */
  failingCalls: number;
  /** The executable a successful install puts in `$NPM_CONFIG_PREFIX/bin/opencode`, as real npm would. */
  installedBinaryTemplate: string;
  /** While this file exists every install call fails, whatever {@link failingCalls} says (an install that cannot succeed). */
  failWhileFile?: string;
}

/**
 * @description Write the `npm` executable the bot's install step runs (`NPM_CONFIG_PREFIX=… npm install -g
 * opencode-ai`) into `binDir`, so a flow can install OpenCode without the network: the first
 * {@link FakeNpmOptions.failingCalls} calls fail, later ones copy the template into the prefix's `bin`.
 */
export function writeFakeNpm(binDir: string, options: FakeNpmOptions): string {
  const npmPath = path.join(binDir, 'npm');
  fs.writeFileSync(npmPath, [
    '#!/bin/sh',
    `echo "$*" >> '${options.callLogFile}'`,
    ...(options.failWhileFile ? [`if [ -e '${options.failWhileFile}' ]; then echo 'npm ERR! code E404 (fake: the package cannot be installed)' >&2; exit 1; fi`] : []),
    `calls=$(wc -l < '${options.callLogFile}')`,
    `if [ "$calls" -le ${options.failingCalls} ]; then echo 'npm ERR! code ENOTEMPTY (fake: another install is running)' >&2; exit 1; fi`,
    'mkdir -p "$NPM_CONFIG_PREFIX/bin"',
    `cp '${options.installedBinaryTemplate}' "$NPM_CONFIG_PREFIX/bin/opencode"`,
    'chmod 755 "$NPM_CONFIG_PREFIX/bin/opencode"',
    '',
  ].join('\n'), { mode: 0o755 });
  return npmPath;
}
