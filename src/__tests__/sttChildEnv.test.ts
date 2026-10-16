/**
 * @description The sidecar and the installer run third-party package code; they get a short allowlist of the
 * environment, never the bot's own secrets.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { getSttChildEnv } from '../stt/sttChildEnv';

test('the bot\'s secrets and everything else stay out; the paths, locale, proxy and tool settings go through', () => {
  const botEnv: NodeJS.ProcessEnv = {
    PATH: '/usr/bin:/bin',
    HOME: '/home/user',
    TMPDIR: '/data/tmp',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    HF_HOME: '/data/hf',
    HF_TOKEN: 'hf_tokenForTheModelHub',
    UV_CACHE_DIR: '/data/uv',
    UV_INDEX_URL: 'https://pypi.example/simple',
    PIP_INDEX_URL: 'https://pypi.example/simple',
    HTTPS_PROXY: 'http://proxy.local:3128',
    no_proxy: 'localhost',
    SSL_CERT_FILE: '/etc/ssl/ca.pem',
    TELEGRAM_BOT_TOKEN: '1000000001:secret',
    GROQ_API_KEY: 'gsk_secret',
    OPENAI_API_KEY: 'sk-secret',
    ANTHROPIC_API_KEY: 'sk-ant-secret',
    JIRA_API_TOKEN: 'jira-secret',
    DATA_DIR: '/srv/data',
    ENV_FILE: '/srv/instance.env',
    CHARNESS_STT_SIDECAR_TOKEN: 'a-token-nobody-hands-over-this-way',
    HTTP_PROXY_PASSWORD_FILE: '/not/allowed',
  };
  const childEnv = getSttChildEnv(botEnv);
  assert.deepEqual(Object.keys(childEnv).sort(), [
    'HF_HOME', 'HF_TOKEN', 'HOME', 'HTTPS_PROXY', 'LANG', 'LC_ALL', 'PATH', 'PIP_INDEX_URL', 'SSL_CERT_FILE', 'TMPDIR', 'UV_CACHE_DIR', 'UV_INDEX_URL', 'no_proxy',
  ]);
  assert.equal(childEnv.PATH, '/usr/bin:/bin');
  for (const secretName of ['TELEGRAM_BOT_TOKEN', 'GROQ_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'JIRA_API_TOKEN', 'ENV_FILE', 'DATA_DIR']) {
    assert.ok(!(secretName in childEnv), `${secretName} leaked`);
  }
});

test('a name that only starts like an allowed one is not allowed, and an unset value is not invented', () => {
  const childEnv = getSttChildEnv({ PATHOLOGY: 'x', HFX_NOT: 'x', UVX: 'x', HOME: undefined });
  assert.deepEqual(childEnv, {});
});

test('it reads the process environment by default', () => {
  const previous = process.env.TELEGRAM_BOT_TOKEN;
  process.env.TELEGRAM_BOT_TOKEN = 'secret-for-this-test';
  try {
    const childEnv = getSttChildEnv();
    assert.ok(!('TELEGRAM_BOT_TOKEN' in childEnv));
    assert.equal(childEnv.PATH, process.env.PATH);
  } finally {
    if (previous === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = previous;
  }
});
