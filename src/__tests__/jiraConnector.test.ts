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
import { checkIsTransientJiraFailure, JiraConnectorStartError, prepareJiraConnector, type JiraConnector } from '../connectors/jira/connector';
import { JiraAuthError, JiraHttpError } from '../connectors/jira/client';
import { getJiraConfigPath } from '../connectors/jira/configFile';
import { keyToString } from '../sessionKey';
import { makeJiraKey } from '../connectors/jira/sessionKeyCodec';

const aiAccountId = 'ai-account';
const isolatedOpenCodeUrl = 'http://127.0.0.1:4196';

let server: http.Server;
let baseUrl = '';
let myselfAccountId = aiAccountId;
/** How many more `/myself` calls answer with this status instead (a Jira outage or a refused token). */
let myselfFailures = { count: 0, status: 503 };
/** Status of the project-statuses lookup; 200 serves the statuses. */
let projectStatusesStatus = 200;
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
        if (url === '/rest/api/3/myself' && myselfFailures.count > 0) {
          myselfFailures.count -= 1;
          response.writeHead(myselfFailures.status);
          response.end();
          return;
        }
        if (url === '/rest/api/3/myself') return sendJson(response, { accountId: myselfAccountId });
        if (url === '/rest/api/3/project/PROJ/statuses' && projectStatusesStatus !== 200) {
          response.writeHead(projectStatusesStatus, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ errorMessages: ['No project could be found'] }));
          return;
        }
        if (url === '/rest/api/3/project/PROJ/statuses') return sendJson(response, [{ statuses: [{ id: '10001', name: 'To Do' }, { id: '3', name: 'Done' }] }]);
        if (url === '/rest/api/3/search/jql') return sendJson(response, { issues: [issue], isLast: true });
        if (url.startsWith('/rest/api/3/issue/PROJ-1?')) return sendJson(response, issue);
        if (request.method === 'POST' && url === '/rest/api/3/issue/PROJ-1/comment') {
          response.writeHead(201, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ id: '20001' }));
          return;
        }
        if (request.method === 'PUT' && url === '/rest/api/3/issue/PROJ-1/assignee') {
          response.writeHead(204);
          response.end();
          return;
        }
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
    myselfFailures = { count: 0, status: 503 };
    projectStatusesStatus = 200;
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

  it('R22: Jira unreachable at start does not refuse it — the setup is checked again, then polling starts', { timeout: 5_000 }, async () => {
    writeConfig();
    // Every attempt the client retries: two boot checks' worth of 503s.
    myselfFailures = { count: 6, status: 503 };
    connector = await prepareJiraConnector({
      dataDir, workRoot, openCodeUrl: isolatedOpenCodeUrl, testTiming: { setupRetryBaseMs: 10, sleep: async () => {} },
    });
    const isPosted = new Promise<boolean>((resolve) => {
      connector?.start({
        bindConversation: async () => {},
        createRequest: async () => ({ id: 'req_1' }),
        postRequest: async () => resolve(true),
      });
    });
    assert.equal(await isPosted, true);
    assert.equal(myselfFailures.count, 0, 'the outage was waited out');
  });

  it('R22: a refused token and an unknown project are the setup\'s fault — the start is refused', async () => {
    writeConfig();
    myselfFailures = { count: 1, status: 401 };
    projectStatusesStatus = 404;
    await assert.rejects(prepare(), (error: Error) =>
      error instanceof JiraConnectorStartError && error.reasons.length === 2
      && /refused GET \/rest\/api\/3\/myself with 401/.test(error.reasons.join('\n'))
      && /No project could be found/.test(error.reasons.join('\n')));
  });

  it('R22: what counts as transient', () => {
    assert.equal(checkIsTransientJiraFailure(new JiraHttpError(0, 'GET', '/x', 'fetch failed')), true);
    assert.equal(checkIsTransientJiraFailure(new JiraHttpError(503, 'GET', '/x', 'down')), true);
    assert.equal(checkIsTransientJiraFailure(new JiraHttpError(429, 'GET', '/x', 'slow down')), true);
    assert.equal(checkIsTransientJiraFailure(new JiraHttpError(404, 'GET', '/x', 'no project')), false);
    assert.equal(checkIsTransientJiraFailure(new JiraAuthError(401, 'GET', '/x')), false);
  });

  it('J6: an answer through the real client — the comment, the assignee read, the hand-back', async () => {
    writeConfig();
    connector = await prepare();
    requestPaths.length = 0;
    const result = await connector.answerSink.deliverAnswer(makeJiraKey('PROJ-1'), {
      requestId: 'req_1',
      kind: 'final',
      body: 'Done.',
      origin: { kind: 'trackerEvent', attributes: { issueKey: 'PROJ-1', triggerId: '100', requesterAccountId: 'requester-account' } },
      isRequestOpen: true,
    });
    assert.deepEqual(result, { ok: true });
    assert.deepEqual(requestPaths, ['POST /rest/api/3/issue/PROJ-1/comment', 'GET /rest/api/3/issue/PROJ-1', 'PUT /rest/api/3/issue/PROJ-1/assignee']);
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
    const watch = deps.indexOf('if (!posted.isHeld) await requestWakeUpEngine?.trackForwardedTurn(key, requestId, { isRequestPrompt: true });');
    assert.ok(post > 0 && watch > post);
  });

  it('a post that failed is handed to the wake-up engine\'s retries before the failure is reported (R28)', () => {
    const deps = botSource.slice(botSource.indexOf('function createJiraSessionDeps('), botSource.indexOf('export async function startBot('));
    assert.match(deps, /if \(!posted\.ok\) \{\s*\/\/[^\n]*\n\s*await requestWakeUpEngine\?\.notePostFailed\(key, requestId\);\s*throw new Error\(/);
  });

  it('a retried post of an issue that never had a session starts one with the Jira adapter; a reminder or a topic only resumes (R28)', () => {
    assert.match(startBody, /prepareWakeUpSession: \(key, message\) =>\s*prepareRequestWakeUpSession\(key, message, key\.platform === 'jira' \? jiraConnector\?\.adapterName : undefined\),/);
    const prepare = botSource.slice(botSource.indexOf('async function prepareRequestWakeUpSession('), botSource.indexOf('async function forwardRequestWakeUp('));
    const resume = prepare.indexOf('if (await ensureSessionByResume(key)) return true;');
    const onlyTrackerPrompt = prepare.indexOf('if (checkIsTelegramKey(key) || !message.isRequestPrompt) return false;');
    const start = prepare.indexOf('await ensureAgentSession(key, { fallbackAdapterName });');
    assert.ok(resume > 0 && onlyTrackerPrompt > resume && start > onlyTrackerPrompt, 'resumed first; started only for a tracker request\'s own prompt');
    assert.match(prepare, /return getThreadAdapter\(key\)\.checkIsActive\(key\);\n\}/, 'a start still under way is not ready');
  });

  it('an issue\'s next request resumes the issue\'s own session (D5), never a fresh one in its place', () => {
    const deps = botSource.slice(botSource.indexOf('function createJiraSessionDeps('), botSource.indexOf('export async function startBot('));
    assert.match(deps, /resumeSession: \(conversationKey\) => resumeOwnSessionUnlessStarting\(keyFromString\(conversationKey\)\),/);
    const helper = botSource.slice(botSource.indexOf('async function resumeOwnSessionUnlessStarting('));
    assert.match(helper, /^[^]*?if \(!startupPromptBuffer\.checkIsStarting\(keyToString\(key\)\)\) await ensureSessionByResume\(key\);/);
  });

  it('a Jira issue bound to a topic\'s folder is never in that folder\'s `dir:` scope, nor named to the topic as a peer', () => {
    assert.match(botSource, /getThreadsForDirectory: \(directory\) =>[^]{0,300}getThreadKeysForDirectory\(getTelegramConversations\(state\.listBindings\(\)\), ENV\.workRoot, directory\)/);
    assert.match(botSource, /const peers = state\.listKeysForSubdir\(subdir\)\.filter\(k => checkIsTelegramKey\(k\) && /);
  });
});

describe('bot.ts wires the Jira answer sink (J6)', () => {
  const botSource = fs.readFileSync(path.join(__dirname, '..', 'bot.ts'), 'utf8');

  it('the connector is prepared before the sinks are built, and its sink answers for jira', () => {
    const startBody = botSource.slice(botSource.indexOf('export async function startBot('));
    assert.ok(startBody.indexOf('await prepareJiraConnectorOrExit()') < startBody.indexOf('const answerSinks = createAnswerSinks(jiraConnector?.answerSink ?? null);'));
    assert.match(botSource, /if \(jiraAnswerSink\) sinks\.set\('jira', jiraAnswerSink\);/);
  });

  it('the "auto-resume is off" answer names no Telegram command outside Telegram', () => {
    assert.match(botSource, /answerBody: checkIsTelegramKey\(key\) \? text : t\('requests\.limit\.answerAutoResumeOffNotice'\)/);
  });
});
