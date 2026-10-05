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
  getClaudeMemoryAbove,
  getOpenCodeIsolationError,
  jiraDefaultEffort,
  jiraDefaultModel,
  jiraPollIntervalDefaultSeconds,
  jiraRunBudgetDefault,
  loadJiraConfig,
  resolveExtraFields,
  resolveTriggerStatusIds,
  validateJiraConfig,
} from '../connectors/jira/config';
import { getJiraConfigPath } from '../connectors/jira/configFile';
import { defaultOpenCodeUrl } from '../installManager';
import { getModulesLoadedBy } from './loadedModulesProbe';

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
    projects: { PROJ: { folder: 'proj-work', triggerStatuses: ['AI To Do'] } },
    ...overrides,
  };
}

function getErrors(parsedJson: object, context: { openCodeUrl: string | undefined } = { openCodeUrl: isolatedOpenCodeUrl }): string[] {
  const result = validateJiraConfig(parsedJson, { workRoot, openCodeUrl: context.openCodeUrl });
  assert.equal(result.ok, false, 'the config must be refused');
  return result.ok ? [] : result.errors;
}

/** R12 refuses a folder with Claude memory above it, so the temp folder itself must have a clean ancestry. */
function createCleanWorkRoot(): string {
  const created = fs.mkdtempSync(path.join(os.tmpdir(), 'jira-config-work-'));
  const memory = getClaudeMemoryAbove(created);
  assert.equal(memory, null, `the temp folder's ancestry holds ${memory?.markerName}: run the tests with TMPDIR outside HOME and any repository`);
  return created;
}

describe('validateJiraConfig', () => {
  before(() => {
    workRoot = createCleanWorkRoot();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jira-config-data-'));
    fs.mkdirSync(path.join(workRoot, 'proj-work'));
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
    assert.deepEqual([...config.projects], [['PROJ', { folder: 'proj-work', triggerStatusNames: ['AI To Do'], extraFieldIds: [] }]]);
  });

  it('explicit poll interval, budget, json-stream adapter, model and effort are taken', () => {
    const result = validateJiraConfig(
      createConfig({ pollIntervalSeconds: 30, runBudgetPer24h: 2, adapter: 'claude-json-stream', model: 'opus[1m]', effort: 'low' }),
      { workRoot, openCodeUrl: isolatedOpenCodeUrl },
    );
    assert.ok(result.ok, result.ok ? '' : result.errors.join('\n'));
    assert.equal(result.config.pollIntervalMs, 30_000);
    assert.equal(result.config.runBudgetPer24h, 2);
    assert.equal(result.config.adapter, 'claude-json-stream');
    assert.equal(result.config.model, 'opus[1m]');
    assert.equal(result.config.effort, 'low');
  });

  it('C14: a Jira session defaults to opus with high effort — each key overrides only its own default', () => {
    const getModelAndEffort = (overrides: Record<string, string>): [string, string] => {
      const result = validateJiraConfig(createConfig(overrides), { workRoot, openCodeUrl: isolatedOpenCodeUrl });
      assert.ok(result.ok, result.ok ? '' : result.errors.join('\n'));
      return [result.config.model, result.config.effort];
    };
    assert.deepEqual(getModelAndEffort({}), ['opus', 'high']);
    assert.deepEqual(getModelAndEffort({ model: 'sonnet' }), ['sonnet', 'high']);
    assert.deepEqual(getModelAndEffort({ effort: 'low' }), ['opus', 'low']);
    assert.deepEqual(getModelAndEffort({ model: 'sonnet', effort: 'low' }), ['sonnet', 'low']);
    assert.deepEqual([jiraDefaultModel, jiraDefaultEffort], ['opus', 'high']);
  });

  it('C11: a project\'s extraFields are taken (empty by default, duplicates once) — custom and system ids alike; only an empty id is refused', () => {
    const result = validateJiraConfig(
      createConfig({ projects: { PROJ: { folder: 'proj-work', triggerStatuses: ['AI To Do'], extraFields: ['customfield_10042', 'customfield_10042', 'duedate'] } } }),
      { workRoot, openCodeUrl: isolatedOpenCodeUrl },
    );
    assert.ok(result.ok, result.ok ? '' : result.errors.join('\n'));
    assert.deepEqual(result.config.projects.get('PROJ')?.extraFieldIds, ['customfield_10042', 'duedate']);
    const errors = getErrors(createConfig({ projects: { PROJ: { folder: 'proj-work', triggerStatuses: ['AI To Do'], extraFields: ['labels', ''] } } }));
    assert.deepEqual(errors.map((error) => error.split(':')[0]), ['jira.json projects.PROJ.extraFields.1']);
  });

  it('R15: an effort outside Claude\'s levels and a model that is not a model name are refused by field', () => {
    const errors = getErrors(createConfig({ effort: 'extreme', model: 'opus --dangerously-skip-permissions' }));
    assert.deepEqual(errors.map((error) => error.split(':')[0]).sort(), ['jira.json effort', 'jira.json model']);
  });

  it('R14: the tmux Claude backend is refused for a Jira project, with its reason', () => {
    assert.deepEqual(getErrors(createConfig({ adapter: 'claude' })), [
      'jira.json adapter: the tmux Claude backend is not available for a Jira project (its folder-trust dialog would hold the session)',
    ]);
  });

  it('R12: a folder with Claude memory in it or anywhere above it is refused, naming the marker and how far up', () => {
    const cases: Array<[string, string, string]> = [
      ['CLAUDE.md', 'memory-file/project', 'Claude would load CLAUDE.md found 1 folder(s) above it'],
      ['CLAUDE.local.md', 'memory-local/project', 'Claude would load CLAUDE.local.md found 1 folder(s) above it'],
      ['AGENTS.md', 'memory-agents/deep/project', 'Claude would load AGENTS.md found 2 folder(s) above it'],
      ['.claude', 'memory-dir/project', 'Claude would load .claude found 1 folder(s) above it'],
    ];
    for (const [markerName, folder, expected] of cases) {
      fs.mkdirSync(path.join(workRoot, folder), { recursive: true });
      const markerParent = path.join(workRoot, folder.split('/')[0]);
      if (markerName === '.claude') fs.mkdirSync(path.join(markerParent, markerName));
      else fs.writeFileSync(path.join(markerParent, markerName), '# memory\n');
      const errors = getErrors(createConfig({ projects: { PROJ: { folder, triggerStatuses: ['AI To Do'] } } }));
      assert.deepEqual(errors, [`jira.json projects.PROJ.folder: ${expected} — pick a folder outside HOME and any repository`], markerName);
    }
    fs.mkdirSync(path.join(workRoot, 'memory-inside'));
    fs.writeFileSync(path.join(workRoot, 'memory-inside', 'CLAUDE.md'), '# memory\n');
    assert.match(getErrors(createConfig({ projects: { PROJ: { folder: 'memory-inside', triggerStatuses: ['x'] } } }))[0], /CLAUDE\.md found in it/);
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
      projects: { PROJ: { folder: tokenValue, triggerStatuses: ['x'] } },
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
    for (const baseUrl of ['https://example.atlassian.net', 'http://192.0.2.10:8099', 'file:///tmp/x', 'not a url']) {
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

  it('an unknown adapter is refused; the per-turn json-stream lifecycle is accepted (L-D12)', () => {
    assert.deepEqual(getErrors(createConfig({ adapter: 'terminal' })), ['jira.json adapter must be claude-json-stream or claude-per-turn']);
    const perTurn = validateJiraConfig(createConfig({ adapter: 'claude-per-turn' }), { workRoot, openCodeUrl: isolatedOpenCodeUrl });
    assert.ok(perTurn.ok, JSON.stringify(perTurn));
    if (perTurn.ok) assert.equal(perTurn.config.adapter, 'claude-per-turn');
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
        proj: { folder: 'proj-work', triggerStatuses: ['AI To Do'] },
        MISSING: { folder: 'no-such-folder', triggerStatuses: ['AI To Do'] },
        ESCAPE: { folder: '../', triggerStatuses: ['AI To Do'] },
      },
    }));
    assert.equal(errors.length, 3, errors.join('\n'));
    assert.equal(errors[0], 'jira.json projects.proj: not a Jira project key');
    assert.equal(errors[1], 'jira.json projects.MISSING.folder: does not exist under WORK_ROOT');
    assert.equal(errors[2], 'jira.json projects.ESCAPE.folder: is outside WORK_ROOT');
  });

  it('a folder is stored in the canonical relative form a binding uses, not as written', () => {
    for (const folder of ['./proj-work/', ' proj-work ', path.join(workRoot, 'proj-work')]) {
      const result = validateJiraConfig(
        createConfig({ projects: { PROJ: { folder, triggerStatuses: ['AI To Do'] } } }),
        { workRoot, openCodeUrl: isolatedOpenCodeUrl },
      );
      assert.ok(result.ok, folder);
      assert.equal(result.config.projects.get('PROJ')?.folder, 'proj-work', folder);
    }
  });

  it('an unknown or misspelled key is refused by name — never a silently applied default — and its value is not echoed', () => {
    const errors = getErrors(createConfig({
      adaptor: tokenValue,
      projects: { PROJ: { folder: 'proj-work', triggerStatuses: ['AI To Do'], triggerStatus: tokenValue } },
    }));
    assert.equal(errors.length, 2, errors.join('\n'));
    assert.ok(errors.some((error) => /^jira\.json \(root\): .*"adaptor"/.test(error)), errors.join('\n'));
    assert.ok(errors.some((error) => /^jira\.json projects\.PROJ: .*"triggerStatus"/.test(error)), errors.join('\n'));
    for (const error of errors) assert.ok(!error.includes(tokenValue), error);
  });

  it('an empty project list is refused — the allowlist must name a project', () => {
    assert.deepEqual(getErrors(createConfig({ projects: {} })), ['jira.json projects names no project']);
  });

  it('schema errors name the field: missing token, poll interval out of range, budget below 1, no trigger status', () => {
    const errors = getErrors(createConfig({
      apiToken: undefined,
      pollIntervalSeconds: 601,
      runBudgetPer24h: 0,
      projects: { PROJ: { folder: 'proj-work', triggerStatuses: [] } },
    }));
    const fields = errors.map((error) => error.split(':')[0]).sort();
    assert.deepEqual(fields, [
      'jira.json apiToken',
      'jira.json pollIntervalSeconds',
      'jira.json projects.PROJ.triggerStatuses',
      'jira.json runBudgetPer24h',
    ]);
    assert.deepEqual(getErrors(createConfig({ pollIntervalSeconds: 9 })).map((error) => error.split(':')[0]), ['jira.json pollIntervalSeconds']);
  });
});

describe('loadJiraConfig', () => {
  const configPath = (): string => getJiraConfigPath(dataDir);

  before(() => {
    workRoot = createCleanWorkRoot();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jira-config-data-'));
    fs.mkdirSync(path.join(workRoot, 'proj-work'));
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

describe('resolveExtraFields (C11)', () => {
  const siteFields = [{ id: 'customfield_10042', name: 'Acceptance criteria' }, { id: 'duedate', name: 'Due date' }];

  it('names the ids the site lists, in the configured order, and reports the ones it does not', () => {
    assert.deepEqual(resolveExtraFields(['duedate', 'customfield_10042', 'customfield_99999'], siteFields), {
      extraFields: [{ id: 'duedate', name: 'Due date' }, { id: 'customfield_10042', name: 'Acceptance criteria' }],
      unknownFieldIds: ['customfield_99999'],
    });
  });

  it('nothing configured, nothing resolved', () => {
    assert.deepEqual(resolveExtraFields([], siteFields), { extraFields: [], unknownFieldIds: [] });
  });
});

describe('resolveTriggerStatusIds', () => {
  const statuses = [
    { id: '10001', name: 'AI To Do' },
    { id: '10002', name: 'In Progress' },
    { id: '3', name: 'Done' },
  ];

  it('matches names case-insensitively, in order, without duplicates', () => {
    assert.deepEqual(resolveTriggerStatusIds('PROJ', ['ai to do', 'Done', 'AI TO DO'], statuses), { ok: true, statusIds: ['10001', '3'] });
  });

  it('a name several issue types\' statuses share yields every id, so no issue type\'s status is missed', () => {
    const shared = [...statuses, { id: '10005', name: 'AI To Do' }];
    assert.deepEqual(resolveTriggerStatusIds('PROJ', ['AI To Do'], shared), { ok: true, statusIds: ['10001', '10005'] });
  });

  it('a name the project lacks is an error naming it, so a typo never disables the trigger silently', () => {
    assert.deepEqual(resolveTriggerStatusIds('PROJ', ['AI To Do', 'Ai Todo', 'Review'], statuses), {
      ok: false,
      error: 'project PROJ has no status named "Ai Todo", "Review"',
    });
  });
});

describe('what the config module loads', () => {
  it('not the json-stream adapter: it needs only that backend\'s name (J4 review)', () => {
    const { projectModules } = getModulesLoadedBy('connectors/jira/config.ts');
    assert.ok(projectModules.includes('connectors/jira/config.ts'), 'the probe is not vacuous');
    assert.ok(!projectModules.includes('adapters/claudeJsonStreamAdapter.ts'), projectModules.join('\n'));
  });
});
