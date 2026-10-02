/**
 * @description The per-request header that rides inside the prompt text of every
 * request (request/answer core S3). The standing rule lives in the bot MCP's
 * connect-time instructions; the header is still needed per request because it
 * names THIS request's id, and because whether the requester sees the agent's
 * plain text can change mid-session (a Telegram view switch) or never holds
 * (a tracker). Agent-facing, so English on every surface.
 */

/**
 * @name RequestHeaderOptions
 * @description `originDescription` says where the request came from in a few
 * words ("a message in this topic", "PROJ-123 assigned to you by …").
 * `isPlainTextHidden` adds the line that the requester never sees the agent's
 * ordinary output.
 */
export interface RequestHeaderOptions {
  requestId: string;
  originDescription: string;
  isPlainTextHidden: boolean;
}

/** @description The header block, ending with a blank line before the request's own text. */
export function buildRequestHeader(options: RequestHeaderOptions): string {
  const lines = [
    `[Request ${options.requestId} · from: ${options.originDescription}]`,
    `Answer it with the answer_request tool (requestId "${options.requestId}"): kind "final" with the full result at the end of your turn, ` +
      '"question" if you need the requester before you can go on, "progress" for an interim note.',
  ];
  if (options.isPlainTextHidden) {
    lines.push('The requester does not see your plain text output — only what you send through answer_request reaches them.');
  }
  return `${lines.join('\n')}\n\n`;
}
