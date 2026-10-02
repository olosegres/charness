/**
 * @description The Jira connector's configuration (plan J4, D10/D11/D16, R4/R9):
 * `DATA_DIR/jira.json` with `${VAR}` placeholders, validated field by field —
 * every error names the field and never echoes a value — plus the boot-time
 * resolution of trigger status names to ids.
 */

/** Test case: N/A — TelegramCode has no Jira tracker. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  getOpenCodeIsolationError,
  jiraPollIntervalDefaultSeconds,
  jiraRunBudgetDefault,
  loadJiraConfig,
  resolveTriggerStatusIds,
  validateJiraConfig,
} from '../connectors/jira/config';
import { getJiraConfigPath } from '../connectors/jira/configFile';
import { defaultOpenCodeUrl } from '../installManager';

const tokenVarName = 'CHARNESS_TEST_JIRA_TOKEN';
const tokenValue = 'token-value-never-echoed';
const isolatedOpenCodeUrl = 'http://127.0.0.1:4196';

let workRoot = '';
let dataDir = '';

function createConfig(overrides: Record<string, string | number | object | undefined> = {}): object {
  return {
    site: 'example.atlassian.net',
    email: 'ai-account@example.com',
    apiToken: `\${${tokenVarName}}`,
    accountId: 'placeholder-account',
    projects: { CHRN: { folder: 'charness-work', triggerStatuses: ['AI To Do'] } },
    ...overrides,
  };
}

function getErrors(parsedJson: object, context: { openCodeUrl: string | undefined } = { openCodeUrl: isolatedOpenCodeUrl }): string[] {
  const result = validateJiraConfig(parsedJson, { workRoot, openCodeUrl: context.openCodeUrl });
  assert.equal(result.ok, false, 'the config must be refused');
  return result.ok ? [] : result.errors;
}

describe('validateJiraConfig', () => {
  before(() => {
    workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jira-config-work-'));
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jira-config-data-'));
    fs.mkdirSync(path.join(workRoot, 'charness-work'));
    process.env[tokenVarName] = tokenValue;
  });
  after(() => {
    delete process.env[tokenVarName];
    fs.rmSync(workRoot, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('a valid config: placeholders expanded, defaults applied, https base URL', () => {
    const result = validateJiraConfig(createConfig(), { workRoot, openCodeUrl: isolatedOpenCodeUrl });
    assert.ok(result.ok, result.ok ? '' : result.errors.join('\n'));
    const { config } = result;
    assert.equal(config.apiToken, tokenValue);
    assert.equal(config.baseUrl, 'https://example.atlassian.net');
    assert.equal(config.pollIntervalMs, jiraPollIntervalDefaultSeconds * 1000);
    assert.equal(config.runBudgetPer24h, jiraRunBudgetDefault);
    assert.equal(config.adapter, 'claude-json-stream');
    assert.deepEqual([...config.projects], [['CHRN', { folder: 'charness-work', triggerStatusNames: ['AI To Do'] }]]);
  });

  it('explicit poll interval, budget and the tmux Claude backend are taken', () => {
    const result = validateJiraConfig(
      createConfig({ pollIntervalSeconds: 30, runBudgetPer24h: 2, adapter: 'claude' }),
      { workRoot, openCodeUrl: isolatedOpenCodeUrl },
    );
    assert.ok(result.ok);
    assert.equal(result.config.pollIntervalMs, 30_000);
    assert.equal(result.config.runBudgetPer24h, 2);
    assert.equal(result.config.adapter, 'claude');
  });

  it('a placeholder whose variable is unset names the field and the variable, never a value', () => {
    const errors = getErrors(createConfig({ email: '${CHARNESS_TEST_UNSET_VAR}' }));
    assert.deepEqual(errors, ['jira.json email (${CHARNESS_TEST_UNSET_VAR} is not set)']);
  });

  it('no error ever carries a configured value — neither a schema error nor a field rule', () => {
    // Two configs: a schema error returns before the field rules run.
    const schemaErrors = getErrors(createConfig({ email: 42, pollIntervalSeconds: tokenValue.length * 100 }));
    const ruleErrors = getErrors(createConfig({
      site: `https://${tokenValue}.example.com/path`,
      baseUrl: `http://${tokenValue}.example.com`,
      adapter: tokenValue,
      projects: { CHRN: { folder: tokenValue, triggerStatuses: ['x'] } },
    }));
    assert.equal(schemaErrors.length, 2, schemaErrors.join('\n'));
    assert.equal(ruleErrors.length, 4, ruleErrors.join('\n'));
    for (const error of [...schemaErrors, ...ruleErrors]) assert.ok(!error.includes(tokenValue), error);
  });

  for (const site of ['https://example.atlassian.net', 'example.atlassian.net/jira', 'example.atlassian.net:443', 'jira.example.com', 'EXAMPLE.atlassian.net']) {
    it(`site "${site}" is refused: a bare <name>.atlassian.net host only`, () => {
      assert.deepEqual(getErrors(createConfig({ site })), ['jira.json site must be a bare <name>.atlassian.net host']);
    });
  }

  it('the test-only baseUrl is accepted on a loopback host and replaces the https URL', () => {
    for (const baseUrl of ['http://127.0.0.1:8099', 'http://localhost:8099', 'http://[::1]:8099']) {
      const result = validateJiraConfig(createConfig({ baseUrl }), { workRoot, openCodeUrl: isolatedOpenCodeUrl });
      assert.ok(result.ok, baseUrl);
      assert.equal(result.config.baseUrl, baseUrl);
    }
  });

  it('a baseUrl off loopback (or not http) is refused — it would send the token elsewhere', () => {
    for (const baseUrl of ['https://example.atlassian.net', 'http://10.8.0.1:8099', 'file:///tmp/x', 'not a url']) {
      const errors = getErrors(createConfig({ baseUrl }));
      assert.equal(errors.length, 1, baseUrl);
      assert.match(errors[0], /^jira\.json baseUrl /);
    }
  });

  it('R4: OpenCode is refused for a Jira project, with its own reason', () => {
    assert.deepEqual(getErrors(createConfig({ adapter: 'opencode' })), [
      'jira.json adapter: OpenCode is not available for a Jira project (it cannot be isolated yet)',
    ]);
  });

  it('an unknown adapter is refused', () => {
    assert.deepEqual(getErrors(createConfig({ adapter: 'terminal' })), ['jira.json adapter must be one of claude-json-stream, claude']);
  });

  it('R9: an unset or default OPENCODE_URL is refused, a port of its own is accepted', () => {
    const expected = `OPENCODE_URL must name a port of its own, not the default ${defaultOpenCodeUrl} other instances use`;
    // A URL without a port means the default one — the port OpenCode is started on.
    for (const openCodeUrl of [undefined, '', 'http://127.0.0.1:4096', 'http://localhost:4096/', 'http://127.0.0.1']) {
      assert.deepEqual(getErrors(createConfig(), { openCodeUrl }), [expected], `${openCodeUrl}`);
    }
    assert.equal(getOpenCodeIsolationError('http://127.0.0.1:4196'), null);
    assert.equal(getOpenCodeIsolationError('not a url'), 'OPENCODE_URL is not a URL');
  });

  it('a project key that is not a Jira key, and a folder outside WORK_ROOT or missing, are refused', () => {
    const errors = getErrors(createConfig({
      projects: {
        chrn: { folder: 'charness-work', triggerStatuses: ['AI To Do'] },
        MISSING: { folder: 'no-such-folder', triggerStatuses: ['AI To Do'] },
        ESCAPE: { folder: '../', triggerStatuses: ['AI To Do'] },
      },
    }));
    assert.equal(errors.length, 3, errors.join('\n'));
    assert.equal(errors[0], 'jira.json projects.chrn: not a Jira project key');
    assert.equal(errors[1], 'jira.json projects.MISSING.folder: does not exist under WORK_ROOT');
    assert.equal(errors[2], 'jira.json projects.ESCAPE.folder: is outside WORK_ROOT');
  });

  it('an empty project list is refused — the allowlist must name a project', () => {
    assert.deepEqual(getErrors(createConfig({ projects: {} })), ['jira.json projects names no project']);
  });

  it('schema errors name the field: missing token, poll interval out of range, budget below 1, no trigger status', () => {
    const errors = getErrors(createConfig({
      apiToken: undefined,
      pollIntervalSeconds: 601,
      runBudgetPer24h: 0,
      projects: { CHRN: { folder: 'charness-work', triggerStatuses: [] } },
    }));
    const fields = errors.map((error) => error.split(':')[0]).sort();
    assert.deepEqual(fields, [
      'jira.json apiToken',
      'jira.json pollIntervalSeconds',
      'jira.json projects.CHRN.triggerStatuses',
      'jira.json runBudgetPer24h',
    ]);
    assert.deepEqual(getErrors(createConfig({ pollIntervalSeconds: 9 })).map((error) => error.split(':')[0]), ['jira.json pollIntervalSeconds']);
  });
});

describe('loadJiraConfig', () => {
  const configPath = (): string => getJiraConfigPath(dataDir);

  before(() => {
    workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jira-config-work-'));
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jira-config-data-'));
    fs.mkdirSync(path.join(workRoot, 'charness-work'));
    process.env[tokenVarName] = tokenValue;
  });
  after(() => {
    delete process.env[tokenVarName];
    fs.rmSync(workRoot, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  function load(): ReturnType<typeof loadJiraConfig> {
    return loadJiraConfig({ dataDir, workRoot, openCodeUrl: isolatedOpenCodeUrl });
  }

  it('reads DATA_DIR/jira.json', () => {
    fs.writeFileSync(configPath(), JSON.stringify(createConfig()));
    const result = load();
    assert.ok(result.ok);
    assert.equal(result.config.site, 'example.atlassian.net');
  });

  it('a missing file, invalid JSON and a non-object are refused by path', () => {
    fs.rmSync(configPath(), { force: true });
    assert.deepEqual(load(), { ok: false, errors: [`cannot read ${configPath()}`] });
    fs.writeFileSync(configPath(), '{ not json');
    assert.deepEqual(load(), { ok: false, errors: [`${configPath()} is not valid JSON`] });
    for (const text of ['[]', 'null', '"text"', '42']) {
      fs.writeFileSync(configPath(), text);
      assert.deepEqual(load(), { ok: false, errors: [`${configPath()} must hold a JSON object`] }, text);
    }
  });
});

describe('resolveTriggerStatusIds', () => {
  const statuses = [
    { id: '10001', name: 'AI To Do' },
    { id: '10002', name: 'In Progress' },
    { id: '3', name: 'Done' },
  ];

  it('matches names case-insensitively, in order, without duplicates', () => {
    assert.deepEqual(resolveTriggerStatusIds('CHRN', ['ai to do', 'Done', 'AI TO DO'], statuses), { ok: true, statusIds: ['10001', '3'] });
  });

  it('a name the project lacks is an error naming it, so a typo never disables the trigger silently', () => {
    assert.deepEqual(resolveTriggerStatusIds('CHRN', ['AI To Do', 'Ai Todo', 'Review'], statuses), {
      ok: false,
      error: 'project CHRN has no status named "Ai Todo", "Review"',
    });
  });
});
