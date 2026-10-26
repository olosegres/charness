import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { getBotMcpServer } from '../jiraE2e/fakeClaudeContract';

/**
 * @description The instructions the bot MCP gave the agent launched with `argv`: a connect with the server and token of the
 * launch's own `--mcp-config` — what the agent's CLI does at its start. The config file lives as long as the session does,
 * so a per-turn conversation (stopped after its turn) cannot be read this way. Throws when the launch has no bot MCP.
 */
export async function readBotMcpInstructions(argv: readonly string[]): Promise<string> {
  const server = getBotMcpServer(argv);
  if (!server?.url) throw new Error(`no bot MCP server in the --mcp-config of ${argv.join(' ')}`);
  const client = new Client({ name: 'instructions-reader', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.headers ?? {} } }));
  try {
    return client.getInstructions() ?? '';
  } finally {
    await client.close();
  }
}
