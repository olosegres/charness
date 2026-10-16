/**
 * @description A fake OpenAI-compatible speech-to-text server on loopback for the process-level voice tests: it
 * answers `POST /v1/audio/transcriptions` the way Groq / OpenAI / a self-hosted server do (`{ "text": … }`), after
 * a scripted failure if the flow asks for one, and records what the bot sent — the bearer token, the model and
 * language fields and the size of the audio part — so a test proves the whole path rather than the answer alone.
 *
 * Nothing leaves the machine: it listens on 127.0.0.1 only.
 */

import * as http from 'http';
import type { AddressInfo } from 'net';

/** What one transcription request carried. */
export interface FakeSpeechRequest {
  method: string;
  path: string;
  /** The `Authorization` header as sent; absent for a keyless server. */
  authorization?: string;
  model?: string;
  language?: string;
  /** Size of the uploaded audio part, in bytes. */
  audioBytes: number;
}

/** How the fake answers one request: a transcript, or a failing status with a body. */
export type FakeSpeechReply = { status: 200; text: string } | { status: number; body: string };

const transcriptionsPath = '/v1/audio/transcriptions';
const multipartFieldRe = (name: string): RegExp => new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)\\r\\n`);
const audioPartRe = /name="file"[^\r]*\r\n(?:[^\r\n]+\r\n)*\r\n/;

export class FakeSpeechEngine {
  /** Every request in order. */
  readonly requests: FakeSpeechRequest[] = [];
  private server: http.Server | null = null;

  /** @param respond decides the answer of the n-th request (0-based). */
  constructor(private readonly respond: (requestIndex: number) => FakeSpeechReply) {}

  /** @description Listen on a free loopback port; resolves the full transcription endpoint URL. */
  async start(): Promise<string> {
    const server = http.createServer((request, response) => {
      void this.handle(request, response);
    });
    this.server = server;
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return `http://127.0.0.1:${port}${transcriptionsPath}`;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    // latin1 keeps every byte one character, so the audio part's length is its byte length.
    const body = Buffer.concat(chunks).toString('latin1');
    const requestIndex = this.requests.length;
    this.requests.push({
      method: request.method ?? '',
      path: request.url ?? '',
      authorization: request.headers.authorization,
      model: multipartFieldRe('model').exec(body)?.[1],
      language: multipartFieldRe('language').exec(body)?.[1],
      audioBytes: this.measureAudioPart(body),
    });
    const reply = this.respond(requestIndex);
    if (reply.status === 200 && 'text' in reply) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ text: reply.text }));
      return;
    }
    response.writeHead(reply.status, { 'content-type': 'application/json' });
    response.end('body' in reply ? reply.body : '');
  }

  /** The bytes between the audio part's headers and the next boundary. */
  private measureAudioPart(body: string): number {
    const headers = audioPartRe.exec(body);
    if (!headers) return 0;
    const start = headers.index + headers[0].length;
    const end = body.indexOf('\r\n--', start);
    return (end === -1 ? body.length : end) - start;
  }
}
