/**
 * @description The Jira connector's start (plan J5): from a real `jira.json`
 * through the real client to a fake Jira on loopback — a broken setup stops the
 * start with every reason, a good one polls and posts a request.
 */

/** Test case: N/A — TelegramCode has no Jira tracker. */

import { after, afterEach, before, beforeEach, describe, it, mock } from 'node:test';
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
import { resolveThreadFilesDir } from '../botFileStorage';
import { convertMarkdownToAdf } from '../connectors/jira/adf';
import { jiraCommentSpillMinChars } from '../connectors/jira/promptSpill';
import { JiraContextLedger } from '../connectors/jira/contextLedger';
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
/** The site's fields (`GET /field`) and the custom values the issue returns. */
let siteFields: Array<{ id: string; name: string }> = [];
let issueCustomFields: Record<string, string> = {};
/** The comments the issue answers with. */
let issueComments: object[] = [];
/** Status of the field list; 200 serves `siteFields`. */
let fieldsStatus = 200;

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
        if (url.startsWith('/rest/api/3/issue/PROJ-1?')) return sendJson(response, { ...issue, fields: { ...issue.fields, ...issueCustomFields } });
        if (url.startsWith('/rest/api/3/issue/PROJ-1/comment?')) return sendJson(response, { total: issueComments.length, comments: issueComments });
        if (url === '/rest/api/3/issue/PROJ-1/remotelink') return sendJson(response, []);
        if (url === '/rest/api/3/field' && fieldsStatus !== 200) {
          response.writeHead(fieldsStatus, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ errorMessages: ['bad field request'] }));
          return;
        }
        if (url === '/rest/api/3/field') return sendJson(response, siteFields);
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
    siteFields = [];
    issueCustomFields = {};
    issueComments = [];
    fieldsStatus = 200;
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
  const startAndWaitForPrompt = (): Promise<string> => new Promise<string>((resolve) => {
    connector?.start({
      bindConversation: async () => {},
      createRequest: async () => ({ id: 'req_1' }),
      postRequest: async (_key, _requestId, prompt) => resolve(prompt.buildText({ isFresh: true })),
    });
  });

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
        postRequest: async (key, requestId, prompt) => resolve(`${keyToString(key)} ${requestId} ${prompt.fullText.split('\n')[0]}`),
      });
    });
    assert.equal(await posted, 'jira:PROJ:PROJ-1 req_1 [Request req_1 · from: PROJ-1 assigned to you by someone]');
    // The trigger is recorded once the post settled.
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(fs.existsSync(path.join(dataDir, 'jira-triggers.jsonl')), 'the trigger was recorded');
  });

  it('C14: a jira.json with neither model nor effort launches its sessions on opus with high effort', async () => {
    writeConfig({ model: undefined, effort: undefined });
    connector = await prepare();
    assert.deepEqual(connector.launchDefaults, { model: 'opus', effort: 'high' });
    connector.stop();
    writeConfig({ model: 'sonnet', effort: undefined });
    connector = await prepare();
    assert.deepEqual(connector.launchDefaults, { model: 'sonnet', effort: 'high' });
  });

  it('C8: a comment over the limit is written whole under the conversation\'s files dir (jira/text), and the prompt points at it', async () => {
    const longText = `${'k'.repeat(jiraCommentSpillMinChars)} the end`;
    issueComments = [{ id: '77', author: { accountId: 'a', displayName: 'Ann' }, created: '2026-10-05T10:00:00.000+0000', body: convertMarkdownToAdf(longText) }];
    writeConfig();
    connector = await prepare();
    const prompt = await startAndWaitForPrompt();
    const spillPath = /written whole to (\S+) \(\d+ chars\) — read it/.exec(prompt)?.[1];
    assert.ok(spillPath, prompt);
    assert.equal(path.dirname(spillPath), path.join(resolveThreadFilesDir(dataDir, makeJiraKey('PROJ-1')), 'jira', 'text'));
    assert.equal(fs.readFileSync(spillPath, 'utf8'), longText);
  });

  it('C4: the ledger\'s word on a prompt reaches the issue\'s sent-state — taken in counts it as sent, dropped never does', async () => {
    writeConfig();
    connector = await prepare();
    await startAndWaitForPrompt();
    const key = makeJiraKey('PROJ-1');
    const sentKeys = (): string[] => Object.keys(JiraContextLedger.createForDataDir(dataDir).getSnapshot('PROJ-1').sent);
    assert.deepEqual(sentKeys(), [], 'built and posted, not yet taken in');
    connector.onPromptSettled(key, 'req_1', 'dropped');
    connector.onPromptSettled(key, 'req_1', 'takenIn');
    assert.deepEqual(sentKeys(), [], 'a dropped build is gone');
  });

  it('C4: a prompt taken in counts as sent, on disk', async () => {
    writeConfig();
    connector = await prepare();
    await startAndWaitForPrompt();
    connector.onPromptSettled(makeJiraKey('PROJ-1'), 'req_1', 'takenIn');
    assert.deepEqual(Object.keys(JiraContextLedger.createForDataDir(dataDir).getSnapshot('PROJ-1').sent).sort(), ['attachments', 'description', 'fields', 'hierarchy', 'links']);
  });

  it('C6: a context reset of an issue forgets what its conversation was told, on disk, and says so in the log', async () => {
    writeConfig();
    connector = await prepare();
    await startAndWaitForPrompt();
    const key = makeJiraKey('PROJ-1');
    connector.onPromptSettled(key, 'req_1', 'takenIn');
    const logs = mock.method(console, 'log', () => {});
    try {
      connector.onContextReset(key, 'compaction (auto)');
      assert.ok(logs.mock.calls.some((call) => String(call.arguments[0]) === '[jira] PROJ-1: its context was reset (compaction (auto)); the next prompt carries the whole issue'));
    } finally {
      logs.mock.restore();
    }
    assert.deepEqual(JiraContextLedger.createForDataDir(dataDir).getSnapshot('PROJ-1'), { generation: 1, sent: {} });
  });

  describe('extraFields (C11)', () => {
    const extraFieldProjects = { PROJ: { folder: 'proj-work', triggerStatuses: ['To Do'], extraFields: ['customfield_10042', 'customfield_99999'] } };

    it('a known id is asked for and shown under the site\'s name; an unknown one is logged ONCE at start and never shown', async () => {
      writeConfig({ projects: extraFieldProjects });
      siteFields = [{ id: 'customfield_10042', name: 'Acceptance criteria' }, { id: 'summary', name: 'Summary' }];
      issueCustomFields = { customfield_10042: 'must pass in CI', customfield_99999: 'a value the site never listed' };
      const warnings = mock.method(console, 'warn', () => {});
      try {
        connector = await prepare();
        const prompt = await startAndWaitForPrompt();
        assert.ok(prompt.includes('Acceptance criteria: must pass in CI'), prompt);
        assert.ok(!prompt.includes('a value the site never listed'), 'an id the site does not list is rendered absent');
        const fieldWarnings = warnings.mock.calls.map((call) => String(call.arguments[0])).filter((line) => line.includes('extraFields'));
        assert.deepEqual(fieldWarnings, ['[jira] PROJ: extraFields the site does not list are left out of every prompt: customfield_99999']);
      } finally {
        warnings.mock.restore();
      }
      assert.equal(requestPaths.filter((requestPath) => requestPath === 'GET /rest/api/3/field').length, 1, 'the site\'s fields were listed once, at start');
    });

    it('without extraFields the site\'s fields are never listed', async () => {
      writeConfig();
      connector = await prepare();
      const prompt = await startAndWaitForPrompt();
      assert.ok(prompt.includes('Fields:\nSummary: Do it\nStatus: To Do'), prompt);
      assert.ok(!requestPaths.includes('GET /rest/api/3/field'));
    });

    it('a site that refuses to list its fields stops the start, naming the call', async () => {
      writeConfig({ projects: extraFieldProjects });
      fieldsStatus = 400;
      await assert.rejects(prepare(), (error: Error) =>
        error instanceof JiraConnectorStartError && /GET \/rest\/api\/3\/field failed with 400/.test(error.reasons.join('\n')));
    });
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
      origin: { kind: 'trackerEvent', attributes: { issueKey: 'PROJ-1', triggerId: '100', requester: 'requester-account' } },
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

  it('C4: the request ledger tells the connector of the conversation what became of each prompt', () => {
    assert.match(startBody, /onPromptSettled: \(key, requestId, outcome\) => connectorConversationHooks\.get\(key\.platform\)\?\.onPromptSettled\(key, requestId, outcome\),/);
    assert.ok(startBody.indexOf('const connectorConversationHooks = createConnectorConversationHooks(jiraConnector);') < startBody.indexOf('const requestLedger = new RequestLedger({'));
    assert.match(botSource, /hooks\.set\('jira', \{\s*onPromptSettled: \(key, requestId, outcome\) => jiraConnector\.onPromptSettled\(key, requestId, outcome\),/);
  });

  it('C6: a fresh session start and every completed compaction reset the conversation\'s context — an idle stop, a resume or a restart does not', () => {
    const start = botSource.slice(botSource.indexOf('async function startAgentSession('), botSource.indexOf('async function startAgentSession(') + 3000);
    assert.match(start, /clearThreadContextMarker\(key\);\n(?:\s*\/\/[^\n]*\n)*\s*noteConversationContextReset\(key, 'fresh session'\);/, 'at the start, right after the preamble marker');
    assert.match(startBody, /onContextCompacted: \(key, trigger\) => dispatchAdapterEvent\(key, 'contextCompacted', \(\) => noteConversationContextReset\(key, `compaction \(\$\{trigger \?\? 'bot'\}\)`\)\),/);
    assert.match(botSource, /onContextReset: \(key, reason\) => jiraConnector\.onContextReset\(key, reason\),/);
    assert.equal((botSource.match(/noteConversationContextReset\(key, /g) ?? []).length, 2, 'only the start and the compaction reset');
    const resume = botSource.slice(botSource.indexOf('async function resumeSleepingSession('), botSource.indexOf('async function resumeSleepingSession(') + 3000);
    assert.ok(!resume.includes('noteConversationContextReset'), 'a resume continues the conversation');
  });

  it('C5: a Jira post is told whether its session is fresh — a fresh start or a failed resume\'s fallback start is, a running or resumed one is not', () => {
    const ensure = botSource.slice(botSource.indexOf('async function ensureAgentSessionNow('), botSource.indexOf('function getResumableSessionId('));
    assert.match(ensure, /case 'ready':\s*return \{ ok: true, message: '', isFresh: false \};/);
    assert.match(ensure, /if \(await resumeSleepingSession\(key, plan\.sessionId\)\) return \{ ok: true, message: '', isFresh: false \};/);
    assert.equal((ensure.match(/\? \{ ok: true, message, isFresh: true \}/g) ?? []).length, 2, 'both starts are fresh');
    assert.match(botSource, /if \(result\.ok\) return \{ ok: true, isFresh: result\.isFresh \};/);
  });

  it('a post that failed is handed to the wake-up engine\'s retries before the failure is reported (R28)', () => {
    const deps = botSource.slice(botSource.indexOf('function createJiraSessionDeps('), botSource.indexOf('export async function startBot('));
    assert.match(deps, /if \(!posted\.ok\) \{\s*\/\/[^\n]*\n\s*await requestWakeUpEngine\?\.notePostFailed\(key, requestId\);\s*throw new Error\(/);
  });

  it('a retried post of an issue that never had a session starts one with the Jira adapter; a reminder or a topic only resumes (R28)', () => {
    assert.match(startBody, /prepareWakeUpSession: \(key, message\) =>\s*prepareRequestWakeUpSession\(key, message, key\.platform === 'jira' \? jiraConnector\?\.adapterName : undefined\),/);
    const prepare = botSource.slice(botSource.indexOf('async function prepareRequestWakeUpSession('), botSource.indexOf('async function forwardRequestWakeUp('));
    // L-D4: the one ensure resumes a sleeping session; a fresh start is allowed only for a tracker request's own prompt.
    assert.ok(prepare.includes("const isFreshStartAllowed = !checkIsTelegramKey(key) && message.isRequestPrompt;"), 'a reminder and a topic only resume');
    assert.ok(prepare.includes('await ensureAgentSession(key, { fallbackAdapterName, isResumeOnly: !isFreshStartAllowed });'));
    assert.match(prepare, /return ensured\.ok && getThreadAdapter\(key\)\.checkIsActive\(key\);\n\}/, 'a start still under way is not ready');
  });

  it('an issue\'s next request resumes the issue\'s own session (D5) through the shared ensure, and counts as its user message (L-D5)', () => {
    const deps = botSource.slice(botSource.indexOf('function createJiraSessionDeps('), botSource.indexOf('export async function startBot('));
    assert.ok(!deps.includes('resumeSession:'), 'no Jira-only resume path: the ensure resumes a sleeping conversation for every platform');
    assert.ok(deps.includes('const sessionPostDeps = createSessionPostDeps();'));
    const postRequest = deps.slice(deps.indexOf('postRequest: async (key, requestId, prompt) => {'));
    const latchClear = postRequest.indexOf('noteThreadUserActivity(key);');
    const post = postRequest.indexOf('await postToSession(sessionPostDeps, keyToString(key), prompt, adapterName);');
    assert.ok(latchClear > 0 && post > latchClear, 'the idle-compaction latch is cleared before the request is posted');
    assert.ok(!botSource.includes('async function ensureSessionByResume('), 'the separate resume helper is gone');
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
