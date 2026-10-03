/**
 * @description The Jira connector's start (plan J5): from a real `jira.json`
 * through the real client to a fake Jira on loopback — a broken setup stops the
 * start with every reason, a good one polls and posts a request.
 */

/** Test case: N/A — TelegramCode has no Jira tracker. */

import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import type { AddressInfo } from 'net';
import { JiraConnectorStartError, prepareJiraConnector, type JiraConnector } from '../connectors/jira/connector';
import { getJiraConfigPath } from '../connectors/jira/configFile';
import { keyToString } from '../sessionKey';

const aiAccountId = 'ai-account';
const isolatedOpenCodeUrl = 'http://127.0.0.1:4196';

let server: http.Server;
let baseUrl = '';
let myselfAccountId = aiAccountId;
const requestPaths: string[] = [];

function sendJson(response: http.ServerResponse, body: object): void {
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

const issue = {
  id: '10100',
  key: 'PROJ-1',
  fields: {
    summary: 'Do it',
    status: { id: '10001', name: 'To Do' },
    assignee: { accountId: aiAccountId },
    reporter: { accountId: 'reporter-account', accountType: 'atlassian' },
  },
  changelog: {
    startAt: 0, maxResults: 100, total: 1,
    histories: [{ id: '100', created: '2026-10-03T09:00:00.000+0000', author: { accountId: 'requester-account', accountType: 'atlassian' }, items: [{ field: 'assignee', to: aiAccountId }] }],
  },
};

describe('prepareJiraConnector', () => {
  let dataDir = '';
  let workRoot = '';
  let connector: JiraConnector | null = null;

  before(async () => {
    server = http.createServer((request, response) => {
      const url = request.url ?? '';
      requestPaths.push(`${request.method} ${url.split('?')[0]}`);
      request.resume();
      request.on('end', () => {
        if (url === '/rest/api/3/myself') return sendJson(response, { accountId: myselfAccountId });
        if (url === '/rest/api/3/project/PROJ/statuses') return sendJson(response, [{ statuses: [{ id: '10001', name: 'To Do' }, { id: '3', name: 'Done' }] }]);
        if (url === '/rest/api/3/search/jql') return sendJson(response, { issues: [issue], isLast: true });
        if (url.startsWith('/rest/api/3/issue/PROJ-1?')) return sendJson(response, issue);
        response.writeHead(404);
        response.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address: AddressInfo | string | null = server.address();
    assert.ok(address !== null && typeof address === 'object');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });
  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jira-connector-data-'));
    workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jira-connector-work-'));
    fs.mkdirSync(path.join(workRoot, 'proj-work'));
    myselfAccountId = aiAccountId;
    requestPaths.length = 0;
  });
  afterEach(() => {
    connector?.stop();
    connector = null;
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(workRoot, { recursive: true, force: true });
  });

  function writeConfig(overrides: object = {}): void {
    fs.writeFileSync(getJiraConfigPath(dataDir), JSON.stringify({
      site: 'example.atlassian.net',
      baseUrl,
      email: 'ai-account@example.com',
      apiToken: 'placeholder-token',
      accountId: aiAccountId,
      projects: { PROJ: { folder: 'proj-work', triggerStatuses: ['To Do'] } },
      pollIntervalSeconds: 600,
      model: 'opus',
      effort: 'high',
      ...overrides,
    }));
  }

  const prepare = (): Promise<JiraConnector> => prepareJiraConnector({ dataDir, workRoot, openCodeUrl: isolatedOpenCodeUrl });

  it('a good setup polls at once and posts the issue as a request in the project folder', async () => {
    writeConfig();
    connector = await prepare();
    assert.equal(connector.adapterName, 'claude-json-stream');
    assert.deepEqual(connector.launchDefaults, { model: 'opus', effort: 'high' });
    const posted = new Promise<string>((resolve) => {
      connector?.start({
        bindConversation: async (key, folder) => {
          assert.equal(`${keyToString(key)} ${folder}`, 'jira:PROJ:PROJ-1 proj-work');
        },
        createRequest: async () => ({ id: 'req_1' }),
        postRequest: async (key, requestId, prompt) => resolve(`${keyToString(key)} ${requestId} ${prompt.split('\n')[0]}`),
      });
    });
    assert.equal(await posted, 'jira:PROJ:PROJ-1 req_1 [Request req_1 · from: PROJ-1 assigned to you by someone]');
    // The trigger is recorded once the post settled.
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(fs.existsSync(path.join(dataDir, 'jira-triggers.jsonl')), 'the trigger was recorded');
  });

  it('a token of another account and an unknown trigger status stop the start, with both reasons', async () => {
    writeConfig({ projects: { PROJ: { folder: 'proj-work', triggerStatuses: ['AI To Do'] } } });
    myselfAccountId = 'another-account';
    await assert.rejects(prepare(), (error: Error) =>
      error instanceof JiraConnectorStartError && error.reasons.length === 2
      && error.reasons[0] === 'jira.json accountId is not the account its apiToken belongs to'
      && error.reasons[1] === 'project PROJ has no status named "AI To Do"');
    assert.ok(!requestPaths.includes('POST /rest/api/3/search/jql'), 'nothing was polled');
  });

  it('a project Jira does not know is one more reason, not the only one', async () => {
    fs.mkdirSync(path.join(workRoot, 'ops-work'));
    writeConfig({
      projects: {
        PROJ: { folder: 'proj-work', triggerStatuses: ['AI To Do'] },
        OPS: { folder: 'ops-work', triggerStatuses: ['To Do'] },
      },
    });
    await assert.rejects(prepare(), (error: Error) =>
      error instanceof JiraConnectorStartError && error.reasons.length === 2
      && error.reasons[0] === 'project PROJ has no status named "AI To Do"'
      && /GET \/rest\/api\/3\/project\/OPS\/statuses failed with 404/.test(error.reasons[1]));
  });

  it('an invalid config stops the start before any request reaches Jira', async () => {
    writeConfig({ adapter: 'opencode' });
    await assert.rejects(prepare(), (error: Error) => error instanceof JiraConnectorStartError && /OpenCode is not available/.test(error.reasons.join('\n')));
    assert.deepEqual(requestPaths, []);
  });
});

describe('bot.ts wires the Jira connector (J5)', () => {
  const botSource = fs.readFileSync(path.join(__dirname, '..', 'bot.ts'), 'utf8');
  const startBody = botSource.slice(botSource.indexOf('export async function startBot('));

  it('loads it only when CONNECTORS lists jira, through a dynamic import (R20)', () => {
    assert.match(startBody, /const jiraConnector = ENV\.servedPlatforms\.has\('jira'\) \? await prepareJiraConnectorOrExit\(\) : null;/);
    assert.match(botSource, /await import\('\.\/connectors\/jira\/connector'\)/);
  });

  it('prepares it before the sessions come back (launch defaults apply to a resume), starts polling after, stops it on shutdown', () => {
    const prepared = startBody.indexOf('await prepareJiraConnectorOrExit()');
    const launchDefaults = startBody.indexOf("registerSessionLaunchDefaultsReader((key) => (key.platform === 'jira' ? launchDefaults : null));");
    const bootPhase = startBody.indexOf('await runSessionBootPhase(');
    assert.ok(prepared > 0 && launchDefaults > prepared && bootPhase > launchDefaults, 'prepared and its defaults registered before the boot phase');
    const restored = startBody.slice(startBody.indexOf('onSessionsRestored: () => {'), startBody.indexOf('healActiveSessions:'));
    assert.match(restored, /jiraConnector\?\.start\(createJiraSessionDeps\(requestLedger, jiraConnector\.adapterName\)\);/);
    assert.match(startBody.slice(startBody.indexOf('cleanupTimers: () => {')), /jiraConnector\?\.stop\(\);/);
  });

  it('a posted request is watched by the wake-up engine, after the post', () => {
    const deps = botSource.slice(botSource.indexOf('function createJiraSessionDeps('), botSource.indexOf('export async function startBot('));
    const post = deps.indexOf('await postToSession(sessionPostDeps, keyToString(key), prompt, adapterName);');
    const watch = deps.indexOf('await requestWakeUpEngine?.trackForwardedTurn(key, requestId);');
    assert.ok(post > 0 && watch > post);
  });

  it('an issue\'s next request resumes the issue\'s own session (D5), never a fresh one in its place', () => {
    const deps = botSource.slice(botSource.indexOf('function createJiraSessionDeps('), botSource.indexOf('export async function startBot('));
    assert.match(deps, /resumeSession: async \(conversationKey\) => \{\s*if \(!startupPromptBuffer\.checkIsStarting\(conversationKey\)\) await ensureSessionByResume\(keyFromString\(conversationKey\)\);/);
  });

  it('a Jira issue bound to a topic\'s folder is never in that folder\'s `dir:` scope, nor named to the topic as a peer', () => {
    assert.match(botSource, /getThreadsForDirectory: \(directory\) =>[^]{0,300}getThreadKeysForDirectory\(getTelegramConversations\(state\.listBindings\(\)\), ENV\.workRoot, directory\)/);
    assert.match(botSource, /const peers = state\.listKeysForSubdir\(subdir\)\.filter\(k => checkIsTelegramKey\(k\) && /);
  });
});
