/**
 * @description Audit S19 / #50: cover the placeholder substitution
 * pipeline, locale normalization, async locale scoping, and the missing-key
 * fallback. The default runtime locale is English; Telegram/chat-specific
 * locale selection is supplied through `runWithLocale`.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import {
  t,
  checkKeyInAllLangs,
  getKeyInLang,
  localeCodes,
  localeEndonyms,
  getLocaleEndonym,
  formatLanguageDisplay,
  defaultLocale,
  getActiveLang,
  normalizeLocale,
  runWithLocale,
} from '../i18n';
import type { Locale } from '../i18n';
import { enDict } from '../i18n/en';
import { reminderTextMaxLength } from '../utils/reminderWizard';

test('default active locale is English', () => {
  assert.equal(defaultLocale, 'en');
  assert.equal(getActiveLang(), 'en');
});

test('normalizeLocale accepts Telegram region/script variants', () => {
  assert.equal(normalizeLocale('EN'), 'en');
  assert.equal(normalizeLocale('pt-BR'), 'pt');
  assert.equal(normalizeLocale('zh_Hans'), 'zh');
  assert.equal(normalizeLocale('zh_Hans_CN'), 'zh');
  assert.equal(normalizeLocale(' ru '), 'ru');
  assert.equal(normalizeLocale('xx'), null);
  assert.equal(normalizeLocale(undefined), null);
});

test('runWithLocale scopes t across async work and restores the previous locale', async () => {
  assert.equal(getActiveLang(), 'en');

  const out = await runWithLocale('ru', async () => {
    assert.equal(getActiveLang(), 'ru');
    await Promise.resolve();
    return t('status.global_empty');
  });

  assert.equal(out, '📊 Тредов пока нет.');
  assert.equal(getActiveLang(), 'en');
});

test('t substitutes single {name} placeholder', () => {
  // Use any known key that takes a placeholder. `cb.binding_to` was
  // added in S18.
  const out = t('cb.binding_to', { subdir: 'overview' });
  assert.ok(out.includes('overview'), `expected substring "overview" in "${out}"`);
});

test('t substitutes multiple placeholders', () => {
  // `thread.bind_collision` mentions `{subdir}` once + `{threads}` once.
  const out = t('thread.bind_collision', { subdir: 'src', threads: '`a`, `b`' });
  assert.ok(out.includes('src'));
  assert.ok(out.includes('`a`, `b`'));
});

test('bind.current resolves with the subdir in the active locale', () => {
  const out = t('bind.current', { subdir: 'overview' });
  assert.ok(out.includes('overview'), `expected "overview" in "${out}"`);
  assert.ok(!out.includes('{subdir}'), `placeholder not substituted: "${out}"`);
});

test('bind.current_none resolves to a non-empty message', () => {
  const out = t('bind.current_none');
  assert.ok(out.length > 0);
  assert.ok(!out.includes('{'));
});

test('thread.bind_required resolves in ru (not the bare-code fallback) and names /bind', () => {
  const out = runWithLocale('ru', () => t('thread.bind_required'));
  assert.notEqual(out, 'bind_required', 'ru catalog is missing thread.bind_required');
  assert.ok(out.includes('/bind'), `expected "/bind" in "${out}"`);
});

test('new.general_hint exists in every locale and names /new', () => {
  assert.ok(checkKeyInAllLangs('new.general_hint'), 'new.general_hint missing in some locale');
  const out = t('new.general_hint');
  assert.ok(out.includes('/new'), `expected "/new" in "${out}"`);
});

test('retired topic-creation keys are gone from both locales', () => {
  // The old /new created a forum topic; its keys must not linger as orphans.
  for (const code of ['new.in_topic', 'new.usage', 'new.created', 'new.created_unbound', 'new.failed', 'new.bind_failed']) {
    assert.ok(!checkKeyInAllLangs(code), `retired key still present: ${code}`);
  }
});

test('agent.question_cancelled_for_prompt exists in every locale (S2 wedged-question backstop)', () => {
  assert.ok(
    checkKeyInAllLangs('agent.question_cancelled_for_prompt'),
    'agent.question_cancelled_for_prompt missing in some locale',
  );
  const out = t('agent.question_cancelled_for_prompt');
  assert.ok(out.length > 0);
  assert.ok(!out.includes('{'), `unexpected placeholder in "${out}"`);
});

test('reattach recap keys exist in every locale', () => {
  for (const code of ['recap.missedCountHeader', 'recap.restartedFallbackHeader', 'recap.stillWorkingLine']) {
    assert.ok(checkKeyInAllLangs(code), `${code} missing in some locale`);
  }
});

test('recap.missedCountHeader substitutes the {count}', () => {
  const out = t('recap.missedCountHeader', { count: 7 });
  assert.ok(out.includes('7'), `expected the count in "${out}"`);
  assert.ok(!out.includes('{count}'), `placeholder not substituted: "${out}"`);
});

test('file intake keys exist in every locale', () => {
  assert.ok(checkKeyInAllLangs('file.too_big'), 'file.too_big missing in some locale');
  assert.ok(checkKeyInAllLangs('file.download_failed'), 'file.download_failed missing in some locale');
});

test('model-selection keys exist in every locale (S5)', () => {
  assert.ok(checkKeyInAllLangs('model.saved_for_next_start'), 'model.saved_for_next_start missing in some locale');
  assert.ok(checkKeyInAllLangs('model.start_agent_first'), 'model.start_agent_first missing in some locale');
});

test('start-notice model + effort keys exist in every locale', () => {
  for (const code of ['agent.ready_model', 'effort.current_hint', 'model.set_success']) {
    assert.ok(checkKeyInAllLangs(code), `${code} missing in some locale`);
  }
});

test('agent.ready carries the {infoBlock} placeholder in every locale', () => {
  // The block is what makes the notice name the model + effort. A locale that
  // lost the placeholder would silently drop both rows for its users.
  for (const locale of localeCodes) {
    const template = getKeyInLang(locale, 'agent.ready');
    assert.ok(template, `agent.ready missing in ${locale}`);
    assert.ok(
      template?.includes('{infoBlock}'),
      `agent.ready in ${locale} lost the {infoBlock} placeholder: "${template}"`,
    );
  }
});

test('voice.retrying names the error and the pause in every locale', () => {
  // The notice must tell the user a retry is coming AND when; a locale that lost
  // {seconds} would announce a retry with no delay, one that lost {error} no cause.
  for (const locale of localeCodes) {
    const out = runWithLocale(locale, () => t('voice.retrying', { error: 'transcription timed out', seconds: 15 }));
    assert.ok(out.includes('transcription timed out'), `expected the error in ${locale}: "${out}"`);
    assert.ok(out.includes('15'), `expected the seconds in ${locale}: "${out}"`);
    assert.ok(!out.includes('{'), `placeholder not substituted in ${locale}: "${out}"`);
  }
});

test('compaction completion keys exist in every locale and keep both token placeholders', () => {
  for (const code of ['compact.done', 'compact.done_tokens', 'compact.summaryHeader']) {
    assert.ok(checkKeyInAllLangs(code), `${code} missing in some locale`);
  }
  // The numbers are the whole point of the `_tokens` variant: a locale that lost
  // one placeholder would report "314 150 → {post} tokens" to the operator.
  for (const locale of localeCodes) {
    const out = runWithLocale(locale, () => t('compact.done_tokens', { pre: '314 150', post: '12 883' }));
    assert.ok(out.includes('314 150'), `expected the pre-count in ${locale}: "${out}"`);
    assert.ok(out.includes('12 883'), `expected the post-count in ${locale}: "${out}"`);
    assert.ok(!out.includes('{'), `placeholder not substituted in ${locale}: "${out}"`);
  }
});

test('compact-summary setting keys exist in every locale and substitute {state}', () => {
  for (const code of [
    'compactSummary.on',
    'compactSummary.off',
    'compactSummary.title',
    'compactSummary.titleGeneral',
    'compactSummary.enableButton',
    'compactSummary.disableButton',
    'compactSummary.setThisTopic',
    'compactSummary.setGlobal',
    'compactSummary.unsupported',
  ]) {
    assert.ok(checkKeyInAllLangs(code), `${code} missing in some locale`);
  }
  // Both titles and both confirmations render the ON/OFF word; a locale that lost
  // the placeholder would report the setting as a literal "{state}".
  for (const locale of localeCodes) {
    for (const code of [
      'compactSummary.title',
      'compactSummary.titleGeneral',
      'compactSummary.setThisTopic',
      'compactSummary.setGlobal',
    ]) {
      const out = runWithLocale(locale, () => t(code, { state: 'ON' }));
      assert.ok(out.includes('ON'), `expected the state in ${locale} ${code}: "${out}"`);
      assert.ok(!out.includes('{state}'), `placeholder not substituted in ${locale} ${code}: "${out}"`);
    }
  }
});

test('auto-continue-limits keys exist in every locale', () => {
  for (const code of [
    'autoContinueLimits.on',
    'autoContinueLimits.off',
    'autoContinueLimits.title',
    'autoContinueLimits.titleGeneral',
    'autoContinueLimits.enableButton',
    'autoContinueLimits.disableButton',
    'autoContinueLimits.skipButton',
    'autoContinueLimits.skipDone',
    'autoContinueLimits.skipExpired',
    'autoContinueLimits.skippedNotice',
    'autoContinueLimits.setThisTopic',
    'autoContinueLimits.setGlobal',
    'autoContinueLimits.limitReachedDisabled',
    // Also asserted per-locale below, but `t()` falls back to `en` for a missing
    // key — only this parity check actually proves every locale carries it.
    'autoContinueLimits.noticeHint',
    'apiRetry.limitResetResuming',
  ]) {
    assert.ok(checkKeyInAllLangs(code), `${code} missing in some locale`);
  }
});

test('autoContinueLimits.* state texts substitute the {state} in every locale', () => {
  // Both titles and both confirmations render the ON/OFF word; a locale that lost
  // the placeholder would report the setting as a literal "{state}".
  for (const locale of localeCodes) {
    for (const code of [
      'autoContinueLimits.title',
      'autoContinueLimits.titleGeneral',
      'autoContinueLimits.setThisTopic',
      'autoContinueLimits.setGlobal',
    ]) {
      const out = runWithLocale(locale, () => t(code, { state: 'ON' }));
      assert.ok(out.includes('ON'), `expected the state in ${locale} ${code}: "${out}"`);
      assert.ok(!out.includes('{state}'), `placeholder not substituted in ${locale} ${code}: "${out}"`);
    }
  }
});

test('autoContinueLimits.noticeHint names the command in every locale', () => {
  // The hint IS the escape hatch on a limit notice (Telegram auto-links the bare
  // command), so a locale that lost the command name leaves the user with no way out.
  for (const locale of localeCodes) {
    const out = runWithLocale(locale, () => t('autoContinueLimits.noticeHint'));
    assert.ok(out.includes('/auto_continue_limits'), `expected the command in ${locale}: "${out}"`);
  }
});

test('agent.ready substitutes an empty {infoBlock} away entirely', () => {
  const out = t('agent.ready', { label: 'OpenCode', subdir: 'myProject', argsSuffix: '', infoBlock: '' });
  assert.ok(!out.includes('{infoBlock}'), `placeholder not substituted: "${out}"`);
  assert.ok(!out.includes('\n\n'), `an empty info block must leave no blank line: "${out}"`);
});

test('agent.ready_model substitutes the {model}', () => {
  const out = t('agent.ready_model', { model: 'anthropic/claude-opus-4-8' });
  assert.ok(out.includes('anthropic/claude-opus-4-8'), `expected the model name in "${out}"`);
  assert.ok(!out.includes('{model}'), `placeholder not substituted: "${out}"`);
});

test('effort.current_hint substitutes the {effort} and names /effort in every locale', () => {
  for (const locale of localeCodes) {
    const out = runWithLocale(locale, () => t('effort.current_hint', { effort: 'xhigh' }));
    assert.ok(out.includes('xhigh'), `expected the level in ${locale}: "${out}"`);
    assert.ok(!out.includes('{effort}'), `placeholder not substituted in ${locale}: "${out}"`);
    // The command name itself stays literal — it is typed, not translated.
    assert.ok(out.includes('/effort'), `expected "/effort" in ${locale}: "${out}"`);
  }
});

test('model.set_success substitutes the {model} name', () => {
  const out = t('model.set_success', { model: 'anthropic/claude-opus-4-8' });
  assert.ok(out.includes('anthropic/claude-opus-4-8'), `expected the model name in "${out}"`);
  assert.ok(!out.includes('{model}'), `placeholder not substituted: "${out}"`);
});

test('rename-session keys exist in every locale', () => {
  assert.ok(checkKeyInAllLangs('rename_session.usage'), 'rename_session.usage missing in some locale');
  assert.ok(checkKeyInAllLangs('rename_session.start_agent_first'), 'rename_session.start_agent_first missing in some locale');
  assert.ok(checkKeyInAllLangs('rename_session.unsupported_backend'), 'rename_session.unsupported_backend missing in some locale');
  assert.ok(checkKeyInAllLangs('rename_session.success'), 'rename_session.success missing in some locale');
  assert.ok(checkKeyInAllLangs('rename_session.failed'), 'rename_session.failed missing in some locale');
});

test('compact keys exist in every locale', () => {
  for (const code of [
    'compact.started',
    'compact.start_agent_first',
    'compact.unsupported_backend',
    'compact.model_unresolved',
    'compact.failed',
  ]) {
    assert.ok(checkKeyInAllLangs(code), `${code} missing in some locale`);
  }
});

test('compact-on-idle keys exist in every locale', () => {
  for (const code of [
    'compact.busy',
    'compact.closingSectionInstruction',
    'compactOnIdle.notice',
    'compactOnIdle.on',
    'compactOnIdle.off',
    'compactOnIdle.title',
    'compactOnIdle.titleGeneral',
    'compactOnIdle.enableButton',
    'compactOnIdle.disableButton',
    'compactOnIdle.setThisTopic',
    'compactOnIdle.setGlobal',
    'compactOnIdle.unsupported',
  ]) {
    assert.ok(checkKeyInAllLangs(code), `${code} missing in some locale`);
  }
});

test('compact.closingSectionInstruction substitutes the marker placeholders', () => {
  const out = t('compact.closingSectionInstruction', {
    startMarker: '<<<WHERE_WE_STOPPED>>>',
    endMarker: '<<<END_WHERE_WE_STOPPED>>>',
  });
  assert.ok(out.includes('<<<WHERE_WE_STOPPED>>>'), `expected the start marker in "${out}"`);
  assert.ok(out.includes('<<<END_WHERE_WE_STOPPED>>>'), `expected the end marker in "${out}"`);
  assert.ok(!out.includes('{startMarker}'), 'startMarker placeholder not substituted');
  assert.ok(!out.includes('{endMarker}'), 'endMarker placeholder not substituted');
});

test('compactOnIdle.setThisTopic substitutes the {state}', () => {
  const out = t('compactOnIdle.setThisTopic', { state: 'ON' });
  assert.ok(out.includes('ON'), `expected the state in "${out}"`);
  assert.ok(!out.includes('{state}'), `placeholder not substituted: "${out}"`);
});

test('compact.failed substitutes the {reason}', () => {
  const out = t('compact.failed', { reason: 'HTTP 500 boom' });
  assert.ok(out.includes('HTTP 500 boom'), `expected the reason in "${out}"`);
  assert.ok(!out.includes('{reason}'), `placeholder not substituted: "${out}"`);
});

test('compact.unsupported_backend substitutes the {label}', () => {
  const out = t('compact.unsupported_backend', { label: '🖥 Terminal' });
  assert.ok(out.includes('🖥 Terminal'), `expected the label in "${out}"`);
  assert.ok(!out.includes('{label}'), `placeholder not substituted: "${out}"`);
});

test('connect provider-auth keys exist in every locale', () => {
  for (const code of [
    'connect.prompt_key',
    'connect.empty_key',
    'connect.invalid_provider',
    'connect.unsupported_provider',
    'connect.unsupported_backend',
    'connect.failed',
    'connect.success',
    'connect.cancelled',
    'connect.pick_method',
    'connect.no_methods',
    'connect.oauth_device',
    'connect.oauth_url_only',
    'connect.oauth_paste',
    'connect.oauth_waiting',
    'connect.oauth_success',
    'connect.oauth_failed',
    'cb.connect_method_expired',
  ]) {
    assert.ok(checkKeyInAllLangs(code), `${code} missing in some locale`);
  }
});

test('rename_session.success substitutes the {title}', () => {
  const out = t('rename_session.success', { title: 'Refactor auth' });
  assert.ok(out.includes('Refactor auth'), `expected the title in "${out}"`);
  assert.ok(!out.includes('{title}'), `placeholder not substituted: "${out}"`);
});

test('model.saved_for_next_start substitutes the {model} name', () => {
  const out = t('model.saved_for_next_start', { model: 'anthropic/claude-opus-4-8' });
  assert.ok(out.includes('anthropic/claude-opus-4-8'), `expected the model name in "${out}"`);
  assert.ok(!out.includes('{model}'), `placeholder not substituted: "${out}"`);
});

test('file.too_big substitutes the {cap} size', () => {
  const out = t('file.too_big', { cap: 20 });
  assert.ok(out.includes('20'), `expected "20" in "${out}"`);
  assert.ok(!out.includes('{cap}'), `placeholder not substituted: "${out}"`);
});

test('bind create-folder flow keys exist in every locale', () => {
  for (const code of [
    'bind.create_button',
    'bind.create_prompt',
    'bind.create_cb',
    'bind.create_empty',
    'bind.create_separator',
    'bind.create_dot_segment',
    'bind.create_hidden',
    'bind.create_invalid_chars',
    'bind.create_exists',
    'bind.create_failed',
  ]) {
    assert.ok(checkKeyInAllLangs(code), `${code} missing in some locale`);
  }
});

test('bind.create_exists substitutes the {subdir}', () => {
  const out = t('bind.create_exists', { subdir: 'overview' });
  assert.ok(out.includes('overview'), `expected the subdir in "${out}"`);
  assert.ok(!out.includes('{subdir}'), `placeholder not substituted: "${out}"`);
});

test('bind.create_failed substitutes the {error}', () => {
  const out = t('bind.create_failed', { error: 'EACCES' });
  assert.ok(out.includes('EACCES'), `expected the error in "${out}"`);
  assert.ok(!out.includes('{error}'), `placeholder not substituted: "${out}"`);
});

test('trace toggle keys exist in every locale', () => {
  for (const code of [
    'trace.onThisThreadReply',
    'trace.offThisThreadReply',
    'trace.onAllThreadsReply',
    'trace.offAllThreadsReply',
    'trace.statusReply',
    'trace.statusOnLabel',
    'trace.statusOffLabel',
    'trace.usageHint',
  ]) {
    assert.ok(checkKeyInAllLangs(code), `${code} missing in some locale`);
  }
});

test('timestamps toggle keys exist in every locale', () => {
  for (const code of [
    'timestamps.onReply',
    'timestamps.offReply',
    'timestamps.statusOnReply',
    'timestamps.statusOffReply',
    'timestamps.usageHint',
  ]) {
    assert.ok(checkKeyInAllLangs(code), `${code} missing in some locale`);
  }
});

test('per-thread /status keys exist in every locale', () => {
  for (const code of [
    'status.thread_report',
    'status.thread_model',
    'status.thread_effort',
    'status.thread_started',
    'status.thread_running',
    'status.thread_stopped',
    'status.thread_no_agent',
    'status.thread_no_binding',
    'status.thread_workdir',
    'status.thread_runtime_version',
    'status.thread_context',
  ]) {
    assert.ok(checkKeyInAllLangs(code), `${code} missing in some locale`);
  }
});

test('status.thread_report substitutes agent / subdir / session placeholders', () => {
  const out = t('status.thread_report', {
    agent: 'Claude Code (claude)',
    subdir: 'overview',
    session: 'running',
  });
  assert.ok(out.includes('Claude Code (claude)'), `expected the agent in "${out}"`);
  assert.ok(out.includes('overview'), `expected the subdir in "${out}"`);
  assert.ok(out.includes('running'), `expected the session state in "${out}"`);
  assert.ok(!out.includes('{'), `placeholders not substituted: "${out}"`);
});

test('status.thread_started substitutes the {started} timestamp', () => {
  const out = t('status.thread_started', { started: '2026-06-27T19:42:10+04:00' });
  assert.ok(out.includes('2026-06-27T19:42:10+04:00'), `expected the timestamp in "${out}"`);
  assert.ok(!out.includes('{started}'), `placeholder not substituted: "${out}"`);
});

test('status runtime keys substitute their values', () => {
  const workDir = t('status.thread_workdir', { workDir: '/home/user/projects/example' });
  const version = t('status.thread_runtime_version', { version: '1.2.3' });
  const context = t('status.thread_context', { used: 12_000, limit: 200_000 });
  assert.ok(workDir.includes('/home/user/projects/example'));
  assert.ok(version.includes('1.2.3'));
  assert.ok(context.includes('12000'));
  assert.ok(context.includes('200000'));
  assert.ok(!`${workDir}${version}${context}`.includes('{'));
});

test('language command keys exist in every locale', () => {
  for (const code of [
    'language.status',
    'language.set_success',
    'language.auto_success',
    'language.invalid',
  ]) {
    assert.ok(checkKeyInAllLangs(code), `${code} missing in some locale`);
  }
});

test('language.status renders ONLY the {display} — no source / Telegram line', () => {
  // The status line now carries just the human display (endonym or "auto (…)");
  // the Telegram-profile + source labels were dropped (the picker buttons and
  // the display line replace them).
  const out = t('language.status', { display: 'auto (English)' });
  assert.ok(out.includes('auto (English)'), `expected the display in "${out}"`);
  assert.ok(!/Telegram/i.test(out), `Telegram line should be gone: "${out}"`);
  assert.ok(!out.includes('{'), `placeholders not substituted: "${out}"`);
});

test('language.auto_success renders the {display} of the resolved language', () => {
  const out = t('language.auto_success', { display: 'auto (English)' });
  assert.ok(out.includes('auto (English)'), `expected the display in "${out}"`);
  assert.ok(!out.includes('{locale}') && !out.includes('{display}'),
    `placeholder not substituted: "${out}"`);
});

// ── endonyms + formatLanguageDisplay (kept in code, not the per-key dict) ──

test('every locale has a non-empty endonym, kept in code (parity-neutral)', () => {
  for (const loc of localeCodes) {
    const endonym = getLocaleEndonym(loc);
    assert.ok(endonym && endonym.trim().length > 0, `empty endonym for "${loc}"`);
  }
  // Exactly the 12 supported locales, no orphans / extras.
  assert.deepEqual(Object.keys(localeEndonyms).sort(), [...localeCodes].sort());
});

test('endonyms are the expected native names (each language written in itself)', () => {
  const expected: Record<string, string> = {
    en: 'English', de: 'Deutsch', fr: 'Français', es: 'Español', pt: 'Português',
    ru: 'Русский', zh: '中文', ja: '日本語', hi: 'हिन्दी', uz: 'Oʻzbekcha', ka: 'ქართული',
    uk: 'Українська',
  };
  for (const loc of localeCodes) {
    assert.equal(getLocaleEndonym(loc), expected[loc], `wrong endonym for "${loc}"`);
  }
});

test('formatLanguageDisplay: explicit override → the endonym alone', () => {
  assert.equal(formatLanguageDisplay({ locale: 'ru', source: 'override' }), 'Русский');
  assert.equal(formatLanguageDisplay({ locale: 'ka', source: 'override' }), 'ქართული');
});

test('formatLanguageDisplay: any auto source → "auto (<endonym>)"', () => {
  // telegram / storedTelegram / fallback are all non-override → auto form.
  assert.equal(formatLanguageDisplay({ locale: 'en', source: 'telegram' }), 'auto (English)');
  assert.equal(formatLanguageDisplay({ locale: 'de', source: 'storedTelegram' }), 'auto (Deutsch)');
  assert.equal(formatLanguageDisplay({ locale: 'en', source: 'fallback' }), 'auto (English)');
});

test('trace.statusReply substitutes thisThread/allThreads/count placeholders', () => {
  const out = t('trace.statusReply', { thisThread: 'on', allThreads: 'off', count: 3 });
  assert.ok(out.includes('3'), `expected count in "${out}"`);
  assert.ok(!out.includes('{thisThread}') && !out.includes('{allThreads}') && !out.includes('{count}'),
    `placeholders not substituted: "${out}"`);
});

test('scheduler fire keys exist in every locale', () => {
  assert.ok(checkKeyInAllLangs('schedule.fired'), 'schedule.fired missing in some locale');
  assert.ok(checkKeyInAllLangs('schedule.missedNote'), 'schedule.missedNote missing in some locale');
});

test('schedule.fired substitutes name/schedule/prompt and an empty missedNote on-time', () => {
  const out = t('schedule.fired', {
    name: 'Daily reminder',
    schedule: 'daily at 09:00',
    prompt: 'check the deploy',
    missedNote: '',
  });
  assert.ok(out.includes('Daily reminder'), `expected the job name in "${out}"`);
  assert.ok(out.includes('daily at 09:00'), `expected the schedule text in "${out}"`);
  assert.ok(out.includes('check the deploy'), `expected the prompt in "${out}"`);
  assert.ok(!out.includes('{'), `placeholders not substituted: "${out}"`);
});

test('schedule.missedNote substitutes the {time}', () => {
  const out = t('schedule.missedNote', { time: '09:00' });
  assert.ok(out.includes('09:00'), `expected the time in "${out}"`);
  assert.ok(!out.includes('{time}'), `placeholder not substituted: "${out}"`);
});

test('schedule command wrapper keys exist in every locale (S7)', () => {
  assert.ok(
    checkKeyInAllLangs('schedule.forwardPromptTemplate'),
    'schedule.forwardPromptTemplate missing in some locale',
  );
  assert.ok(
    checkKeyInAllLangs('schedule.interviewPromptTemplate'),
    'schedule.interviewPromptTemplate missing in some locale',
  );
});

test('schedule.forwardPromptTemplate: English instructions, per-locale reply language (agent-facing)', () => {
  // These wrap the user request as an instruction the AGENT reads, never the
  // user. The instructions stay English in both catalogs, but the TARGET
  // reply language is baked per locale — on a fresh session the locale is
  // the only reliable user-language signal (live 2026-06-06: "in their
  // language" made the agent ask in English). `getKeyInLang` reads each
  // catalog directly (the active-lang `t` can't compare the other locale).
  const ru = getKeyInLang('ru', 'schedule.forwardPromptTemplate');
  const en = getKeyInLang('en', 'schedule.forwardPromptTemplate');
  assert.ok(ru && en, 'forward template missing in a catalog');
  assert.ok(ru.includes('IN RUSSIAN'), `ru catalog must direct replies to Russian: "${ru}"`);
  assert.ok(en.includes('IN ENGLISH'), `en catalog must direct replies to English: "${en}"`);
  // It must name the MCP tools so the agent knows how to act.
  assert.ok(ru.includes('schedule_create') && en.includes('schedule_create'));
});

test('schedule.interviewPromptTemplate: English instructions, per-locale reply language (agent-facing)', () => {
  const ru = getKeyInLang('ru', 'schedule.interviewPromptTemplate');
  const en = getKeyInLang('en', 'schedule.interviewPromptTemplate');
  assert.ok(ru && en, 'interview template missing in a catalog');
  assert.ok(ru.includes('IN RUSSIAN'), `ru catalog must direct the interview to Russian: "${ru}"`);
  assert.ok(en.includes('IN ENGLISH'), `en catalog must direct the interview to English: "${en}"`);
  assert.ok(ru.includes('schedule_create') && en.includes('schedule_create'));
});

test('schedule.forwardPromptTemplate substitutes {text} verbatim (markdown + quotes preserved)', () => {
  // The wrapper rides every /schedule <text> call — a request containing
  // markdown / quotes / braces must survive substitution untouched so the
  // agent sees exactly what the user typed (no escaping, single regex pass).
  const request = 'remind me to ship **release** and say "done" at 9am `daily`';
  const out = t('schedule.forwardPromptTemplate', { text: request });
  assert.ok(out.includes(request), `expected the verbatim request in "${out}"`);
  assert.ok(!out.includes('{text}'), `placeholder not substituted: "${out}"`);
});

test('the reminder fire key moved into the plural namespace (the old one is retired)', () => {
  // `reminder.fired` → `reminders.fired`, so the fire announcement shares the
  // namespace with every other `/reminders` string. A lingering orphan would be
  // dead weight that the next reader mistakes for the live key.
  assert.ok(checkKeyInAllLangs('reminders.fired'), 'reminders.fired missing in some locale');
  assert.ok(!checkKeyInAllLangs('reminder.fired'), 'the retired reminder.fired key is still present');
});

test('reminders.fired substitutes text/schedule and an empty missedNote on-time', () => {
  const out = t('reminders.fired', {
    text: 'Take the pills',
    schedule: 'every day at 09:00',
    missedNote: '',
  });
  assert.ok(out.includes('Take the pills'), `expected the reminder text in "${out}"`);
  assert.ok(out.includes('every day at 09:00'), `expected the schedule text in "${out}"`);
  assert.ok(!out.includes('{'), `placeholders not substituted: "${out}"`);
});

test('every /reminders key exists in every locale', () => {
  // The `/reminders` screens are ALL buttons, and `getKeyInLang` has no per-key en
  // fallback — a locale missing one of these renders a dead caption (or the bare
  // last code segment) on a button the operator has to tap.
  for (const code of [
    // fire announcement
    'reminders.fired',
    // localized schedule wording (one per descriptor kind)
    'reminders.scheduleDaily',
    'reminders.scheduleWeekdays',
    'reminders.scheduleWeekly',
    'reminders.scheduleMonthly',
    'reminders.scheduleOnce',
    'reminders.scheduleRaw',
    // next run
    'reminders.nextRunToday',
    'reminders.nextRunTomorrow',
    'reminders.nextRunOnDate',
    'reminders.nextRunNone',
    // hub
    'reminders.hubTitle',
    'reminders.hubEmptyLine',
    'reminders.hubActiveLine',
    'reminders.hubLimitLine',
    'reminders.addButton',
    'reminders.listButton',
    'reminders.closeButton',
    'reminders.closedNotice',
    // list
    'reminders.listTitle',
    'reminders.listPageLine',
    'reminders.listRow',
    'reminders.listPrevButton',
    'reminders.listNextButton',
    'reminders.listBackToHubButton',
    // card + created
    'reminders.cardTitle',
    'reminders.cardWhen',
    'reminders.cardText',
    'reminders.cardNext',
    'reminders.cardDeleteButton',
    'reminders.cardBackToListButton',
    'reminders.createdTitle',
    'reminders.doneListButton',
    // wizard chrome + running summary
    'reminders.wizardTitle',
    'reminders.pickRepeat',
    'reminders.pickDate',
    'reminders.pickWeekday',
    'reminders.pickDayOfMonth',
    'reminders.pickTime',
    'reminders.pickText',
    // wizard steps
    'reminders.stepRepeatQuestion',
    'reminders.stepDateQuestion',
    'reminders.stepDateGridQuestion',
    'reminders.stepWeekdayQuestion',
    'reminders.stepDayOfMonthQuestion',
    'reminders.stepDayOfMonthGridQuestion',
    'reminders.stepTimeQuestion',
    'reminders.stepHourQuestion',
    'reminders.stepMinuteQuestion',
    'reminders.stepTextQuestion',
    // wizard buttons
    'reminders.repeatOnceButton',
    'reminders.repeatDailyButton',
    'reminders.repeatWeekdaysButton',
    'reminders.repeatWeeklyButton',
    'reminders.repeatMonthlyButton',
    'reminders.dateTodayButton',
    'reminders.dateTomorrowButton',
    'reminders.dateOtherButton',
    'reminders.dayOfMonthOtherButton',
    'reminders.timeOtherButton',
    'reminders.backButton',
    'reminders.cancelButton',
    'reminders.weekdayMondayButton',
    'reminders.weekdayTuesdayButton',
    'reminders.weekdayWednesdayButton',
    'reminders.weekdayThursdayButton',
    'reminders.weekdayFridayButton',
    'reminders.weekdaySaturdayButton',
    'reminders.weekdaySundayButton',
    // outcomes
    'reminders.errorPastTime',
    'reminders.errorInvalidDate',
    'reminders.errorInvalidTime',
    'reminders.errorTextTooLong',
    'reminders.cancelledNotice',
    'reminders.expiredNotice',
    'reminders.capReachedNotice',
    // callback answers
    'reminders.wizardExpiredCbAnswer',
    'reminders.deletedCbAnswer',
    'reminders.deleteGoneCbAnswer',
    'reminders.cardExpiredCbAnswer',
  ]) {
    assert.ok(checkKeyInAllLangs(code), `${code} missing in some locale`);
  }
});

test('the reminders.* keys that carry a value substitute it in every locale', () => {
  // Each of these is read by an operator deciding something ("is this the day I
  // meant?"), so a locale that dropped its placeholder would render a line that
  // states nothing.
  const substitutions: Record<string, Record<string, string | number>> = {
    'reminders.scheduleDaily': { time: '09:00' },
    'reminders.scheduleWeekdays': { time: '09:00' },
    'reminders.scheduleWeekly': { weekday: 'Sun', time: '18:00' },
    'reminders.scheduleMonthly': { dayOfMonth: 5, time: '12:00' },
    'reminders.scheduleOnce': { date: '2026-06-07', time: '21:00' },
    'reminders.scheduleRaw': { text: '*/7 * * * *' },
    'reminders.nextRunToday': { time: '21:00' },
    'reminders.nextRunTomorrow': { time: '09:00' },
    'reminders.nextRunOnDate': { date: '2026-06-20', time: '12:30' },
    'reminders.hubActiveLine': { count: 3 },
    'reminders.hubLimitLine': { count: 30, limit: 30 },
    'reminders.listButton': { count: 3 },
    'reminders.listTitle': { count: 3 },
    'reminders.listPageLine': { page: 2, total: 4 },
    'reminders.listRow': { name: 'Pills', schedule: 'every day at 09:00' },
    'reminders.cardTitle': { name: 'Pills' },
    'reminders.cardWhen': { schedule: 'every day at 09:00' },
    'reminders.cardText': { text: 'Take the pills' },
    'reminders.cardNext': { next: 'today at 09:00' },
    'reminders.pickRepeat': { value: 'Every day' },
    'reminders.pickDate': { value: '2026-06-07' },
    'reminders.pickWeekday': { value: 'Sun' },
    'reminders.pickDayOfMonth': { value: 5 },
    'reminders.pickTime': { value: '21:00' },
    'reminders.pickText': { value: 'Take the pills' },
    'reminders.stepMinuteQuestion': { hour: '21' },
    'reminders.capReachedNotice': { limit: 30 },
    // The rejection has to NAME the bound it refused, or the operator retries blind.
    'reminders.errorTextTooLong': { limit: reminderTextMaxLength },
  };
  for (const locale of localeCodes) {
    for (const [code, vars] of Object.entries(substitutions)) {
      const out = runWithLocale(locale, () => t(code, vars));
      assert.ok(out.length > 0, `${code} empty in ${locale}`);
      assert.ok(!/\{[a-zA-Z]+\}/.test(out), `${code} in ${locale} left a placeholder: "${out}"`);
      for (const value of Object.values(vars)) {
        assert.ok(
          out.includes(value.toString()),
          `${code} in ${locale} dropped "${value}": "${out}"`,
        );
      }
    }
  }
});

test('reminders.wizardExpiredCbAnswer names /reminders literally in every locale', () => {
  // The answer is the ONLY thing a stale tap produces, so it has to say how to get
  // a fresh wizard. The command name is typed, not translated.
  for (const locale of localeCodes) {
    const out = runWithLocale(locale, () => t('reminders.wizardExpiredCbAnswer'));
    assert.ok(out.includes('/reminders'), `expected "/reminders" in ${locale}: "${out}"`);
  }
});

test('startup readiness status keys exist in every locale', () => {
  for (const code of [
    'startup.ready',
    'startup.header_not_ready',
    'startup.item.create_group',
    'startup.item.grant_admin',
    'startup.item.bind_topic',
    'startup.item.install_agent',
    'startup.item.optional_groq',
    'startup.item.optional_owner',
  ]) {
    assert.ok(checkKeyInAllLangs(code), `${code} missing in some locale`);
  }
});

test('startup.item.grant_admin substitutes the {missing} rights list', () => {
  const out = t('startup.item.grant_admin', { missing: 'Manage Topics, Pin Messages' });
  assert.ok(out.includes('Manage Topics, Pin Messages'), `expected the rights in "${out}"`);
  assert.ok(!out.includes('{missing}'), `placeholder not substituted: "${out}"`);
});

test('thinking (/thinking) keys exist in every locale (S2)', () => {
  for (const code of [
    'thinking.live',
    'thinking.thoughtForSeconds',
    'thinking.choose',
    'thinking.set_success',
    'thinking.invalid_mode',
    'thinking.mode.minimal',
    'thinking.mode.short',
    'thinking.mode.full',
    'cb.thinking_set',
    'cb.thinking_error',
  ]) {
    assert.ok(checkKeyInAllLangs(code), `${code} missing in some locale`);
  }
});

test('thinking.live is the static ••• indicator in every locale (locked decision, S3)', () => {
  // Plan 2026-06-27: the live working cue is the STATIC three-bullet glyph —
  // no animation, no "thinking"/"думаю" word, identical across locales. The
  // native Telegram typing action stays the animated cue.
  for (const lang of localeCodes) {
    assert.equal(getKeyInLang(lang, 'thinking.live'), '•••', `thinking.live must be ••• in ${lang}`);
  }
});

test('unified display-mode label keys exist in every locale (S1)', () => {
  // One label per unified mode per command group — the pickers of /thinking,
  // /tool_results, /subagent and the /verbosity umbrella all render
  // minimal|short|full buttons.
  for (const group of ['thinking', 'toolResults', 'subagent', 'verbosity']) {
    for (const mode of ['minimal', 'short', 'full']) {
      const code = `${group}.mode.${mode}`;
      assert.ok(checkKeyInAllLangs(code), `${code} missing in some locale`);
    }
  }
});

test('verbosity (/verbosity umbrella) keys exist in every locale (S2)', () => {
  for (const code of [
    'verbosity.choose',
    'verbosity.set_success',
    'verbosity.invalid_mode',
    'verbosity.custom',
    'cb.verbosity_set',
    'cb.verbosity_error',
  ]) {
    assert.ok(checkKeyInAllLangs(code), `${code} missing in some locale`);
  }
});

test('verbosity.custom substitutes all three per-pref placeholders (mixed state)', () => {
  const out = t('verbosity.custom', {
    thinking: 'кратко',
    toolResults: 'минимум',
    subagent: 'подробно',
  });
  assert.ok(out.includes('кратко') && out.includes('минимум') && out.includes('подробно'),
    `expected all three values in "${out}"`);
  assert.ok(!out.includes('{'), `placeholders not substituted: "${out}"`);
});

test('thinking.thoughtForSeconds substitutes the {seconds} count', () => {
  const out = t('thinking.thoughtForSeconds', { seconds: 12 });
  assert.ok(out.includes('12'), `expected the seconds in "${out}"`);
  assert.ok(!out.includes('{seconds}'), `placeholder not substituted: "${out}"`);
});

test('t falls back to last code segment for unknown key', () => {
  const out = t('nonexistent.key.path');
  assert.equal(out, 'path');
});

test('t returns plain message when no placeholders', () => {
  const out = t('access.denied');
  assert.ok(out.length > 0);
  assert.ok(!out.includes('{'));
});

test('t handles repeated {name} occurrences (each replaced)', () => {
  // No production key uses the same placeholder twice today, but the
  // regex builder is `new RegExp(..., 'g')` which is the behaviour we
  // want to lock in. Synthetic check via direct substitution on a key
  // that does use a placeholder: substitute the value, then count.
  const value = 'X';
  const out = t('cb.binding_to', { subdir: value });
  // We can't synthesise a multi-occurrence key without writing to the
  // dict, so we content-assert: result contains the substituted value
  // at least once and contains zero literal `{subdir}` placeholders.
  assert.ok(out.includes(value));
  assert.ok(!out.includes('{subdir}'));
});

// ── multi-locale tests (12 locales: en, de, fr, es, pt, ru, zh, ja, hi, uz, ka, uk) ──

test('localeCodes lists all 12 supported locales', () => {
  assert.equal(localeCodes.length, 12, `expected 12 locales, got ${localeCodes.length}`);
  assert.ok(localeCodes.includes('en'));
  assert.ok(localeCodes.includes('ru'));
  assert.ok(localeCodes.includes('de'));
  assert.ok(localeCodes.includes('fr'));
  assert.ok(localeCodes.includes('es'));
  assert.ok(localeCodes.includes('pt'));
  assert.ok(localeCodes.includes('zh'));
  assert.ok(localeCodes.includes('ja'));
  assert.ok(localeCodes.includes('hi'));
  assert.ok(localeCodes.includes('uz'));
  assert.ok(localeCodes.includes('ka'));
  assert.ok(localeCodes.includes('uk'));
});

test('every locale has full key parity with en (no missing keys)', () => {
  // en is the canonical reference — every other locale must have the same set
  // of keys. A missing key would silently fall back to en at runtime, but the
  // locked decision is FULL parity for the generated locales.
  const enKeys = Object.keys(enDict);
  assert.ok(enKeys.length >= 250, `en key count suspiciously low: ${enKeys.length}`);

  for (const loc of localeCodes) {
    for (const key of enKeys) {
      const val = getKeyInLang(loc as Locale, key);
      assert.ok(val !== undefined, `key "${key}" missing in locale "${loc}"`);
    }
  }
  // Also verify checkKeyInAllLangs is true for every en key
  for (const key of enKeys) {
    assert.ok(checkKeyInAllLangs(key), `checkKeyInAllLangs failed for "${key}"`);
  }
  // Verify no retired keys are present in ANY locale
  for (const code of [
    'new.in_topic', 'new.usage', 'new.created', 'new.created_unbound', 'new.failed', 'new.bind_failed',
    // /language status no longer shows the Telegram-profile / source labels.
    'language.telegram_unknown',
    'language.source.override', 'language.source.telegram',
    'language.source.storedTelegram', 'language.source.fallback',
  ]) {
    assert.ok(!checkKeyInAllLangs(code), `retired key still present: ${code}`);
  }
});

test('every locale has the same key count as en (full parity)', () => {
  const enKeys = Object.keys(enDict);
  assert.ok(enKeys.length >= 250, `en key count suspiciously low: ${enKeys.length}`);
  for (const loc of localeCodes) {
    let count = 0;
    for (const key of enKeys) {
      if (getKeyInLang(loc as Locale, key) !== undefined) count++;
    }
    assert.equal(count, enKeys.length, `locale "${loc}" has ${count} keys, expected ${enKeys.length}`);
  }
});

test('agent-facing template reply-language directive varies per locale', () => {
  // The schedule.forwardPromptTemplate keeps English instructions but bakes
  // the TARGET reply language per locale. Each locale must carry a distinct
  // "IN <LANGUAGE>" directive (or the existing ru/en ones).
  const expectedReplyLang: Record<string, string> = {
    en: 'IN ENGLISH',
    ru: 'IN RUSSIAN',
    de: 'IN GERMAN',
    fr: 'IN FRENCH',
    es: 'IN SPANISH',
    pt: 'IN PORTUGUESE',
    zh: 'IN CHINESE',
    ja: 'IN JAPANESE',
    hi: 'IN HINDI',
    uz: 'IN UZBEK',
    ka: 'IN GEORGIAN',
    uk: 'IN UKRAINIAN',
  };
  for (const loc of localeCodes) {
    const fwd = getKeyInLang(loc as Locale, 'schedule.forwardPromptTemplate');
    const ivw = getKeyInLang(loc as Locale, 'schedule.interviewPromptTemplate');
    assert.ok(fwd, `forwardPromptTemplate missing in ${loc}`);
    assert.ok(ivw, `interviewPromptTemplate missing in ${loc}`);
    const expected = expectedReplyLang[loc];
    assert.ok(expected, `no expected reply-lang for ${loc}`);
    assert.ok(fwd.includes(expected), `${loc} forwardPromptTemplate must contain "${expected}": "${fwd}"`);
    assert.ok(ivw.includes(expected), `${loc} interviewPromptTemplate must contain "${expected}": "${ivw}"`);
    // The instructions stay English in every locale
    assert.ok(fwd.includes('schedule_create'), `${loc} must name the MCP tool`);
    assert.ok(ivw.includes('schedule_create'), `${loc} must name the MCP tool`);
  }
});

test('apiRetry.continueNudge is translated per locale (agent-facing nudge)', () => {
  // The continueNudge is agent-facing — it tells the agent to resume. It must
  // be in the locale's language (mirroring the schedule template rule).
  for (const loc of localeCodes) {
    const nudge = getKeyInLang(loc as Locale, 'apiRetry.continueNudge');
    assert.ok(nudge, `continueNudge missing in ${loc}`);
    assert.ok(nudge.length > 5, `${loc} continueNudge suspiciously short: "${nudge}"`);
  }
  // Spot-check: en and ru have known values
  assert.equal(getKeyInLang('en' as Locale, 'apiRetry.continueNudge'), 'Continue from where you left off.');
  assert.equal(getKeyInLang('ru' as Locale, 'apiRetry.continueNudge'), 'Продолжай с того места, где ты остановился.');
});

test('the schedule templates carry the {timeNote} placeholder in every locale', () => {
  // The note is what gives the agent an absolute clock. A locale that lost the
  // placeholder would send its users back to the old failure mode: "tomorrow at
  // 9" resolved against whatever the model assumed rather than the operator's
  // zone. Also asserts the note itself substitutes cleanly.
  for (const loc of localeCodes) {
    for (const key of ['schedule.forwardPromptTemplate', 'schedule.interviewPromptTemplate']) {
      const template = getKeyInLang(loc as Locale, key);
      assert.ok(template, `${key} missing in ${loc}`);
      assert.ok(template.includes('{timeNote}'), `${key} in ${loc} lost {timeNote}: "${template}"`);
    }
    const note = runWithLocale(loc as Locale, () =>
      t('schedule.currentTimeNote', { now: '2026-09-14 18:42 (+03:00)', zone: 'Europe/Moscow' }),
    );
    assert.ok(note.includes('2026-09-14 18:42 (+03:00)'), `${loc} note lost the instant: "${note}"`);
    assert.ok(note.includes('Europe/Moscow'), `${loc} note lost the zone: "${note}"`);
    assert.ok(!note.includes('{'), `${loc} note has an unsubstituted placeholder: "${note}"`);
  }
});

test('the timezone.* strings substitute their placeholders in every locale', () => {
  // Every one of these is read by an operator making a decision ("is this the
  // zone I meant?"), so a locale that dropped {zone} or {now} would render a
  // confirmation that confirms nothing.
  const substitutions: Record<string, Record<string, string | number>> = {
    'timezone.status': { zone: 'Europe/Moscow', now: '18:42 (+03:00)' },
    'timezone.set_success': { zone: 'Europe/Moscow', now: '18:42 (+03:00)', count: 3 },
    'timezone.auto_success': { zone: 'UTC', now: '15:42 (+00:00)', count: 0 },
    'timezone.invalid': { zone: 'Bogus/Zone' },
    'timezone.picker_regions': { zone: 'Europe/Moscow', now: '2026-09-14 18:42 (+03:00)' },
    'timezone.picker_zones': { region: 'Europe', page: 2, total: 6 },
  };
  for (const loc of localeCodes) {
    for (const [key, vars] of Object.entries(substitutions)) {
      const out = runWithLocale(loc as Locale, () => t(key, vars));
      assert.ok(out.length > 0, `${key} empty in ${loc}`);
      assert.ok(!/\{[a-zA-Z]+\}/.test(out), `${key} in ${loc} has an unsubstituted placeholder: "${out}"`);
      for (const value of Object.values(vars)) {
        assert.ok(
          out.includes(String(value)),
          `${key} in ${loc} dropped the value "${value}": "${out}"`,
        );
      }
    }
    // These two take no variables but must still say something.
    for (const key of ['timezone.usage', 'timezone.fixed_offset_warning', 'timezone.picker_expired']) {
      const out = getKeyInLang(loc as Locale, key);
      assert.ok(out && out.length > 5, `${key} missing or suspiciously short in ${loc}`);
    }
    // The command name is typed, not translated.
    assert.ok(
      getKeyInLang(loc as Locale, 'timezone.usage')?.includes('/timezone'),
      `timezone.usage in ${loc} must name /timezone literally`,
    );
  }
});
