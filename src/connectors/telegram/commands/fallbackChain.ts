/**
 * `/limits` — everything about a usage limit on one screen: the instance-wide priority chain of backend +
 * account / provider + model a topic continues on (reorder, include / exclude, remove, add through a two-step
 * sub-picker, rebuild a draft, clear — in General; read-only in a topic), the two settings that decide what a
 * limit does (switch to a backup by itself, wait for the reset and continue — instance defaults in General,
 * on / off / same-as-General overrides in a topic) — and the «🔁 Switch to …» buttons a usage-limit notice
 * carries. `/fallback` and `/auto_continue_limits` are hidden aliases of this screen. See README.md in this
 * folder and `utils/fallbackChain.ts`.
 */
import { Markup, type Context } from 'telegraf';
import type { SessionKey } from '../../../sessionKey';
import { t } from '../../../i18n';
import type { InboundCommand } from '../../../platform/inbound';
import { paginateList } from '../../../utils/paginateList';
import { formatClaudeUsageResetAt } from '../../../utils/claudeUsage';
import { buildSkipArmedRetryCallbackData } from '../../../utils/autoContinueOnLimit';
import {
  addFallbackEntry,
  buildFallbackAddClaudeCallback,
  buildFallbackAddClaudeModelCallback,
  buildFallbackAddModelCallback,
  buildFallbackAddModelPageCallback,
  buildFallbackAddProviderCallback,
  buildFallbackMoveDownCallback,
  buildFallbackMoveUpCallback,
  buildFallbackRemoveCallback,
  buildFallbackToggleCallback,
  checkIsFallbackEntryDisabled,
  checkIsSameFallbackAccount,
  fallbackAddCallback,
  fallbackAddClaudeCallbackRe,
  fallbackAddClaudeModelCallbackRe,
  fallbackAddModelCallbackRe,
  fallbackAddModelPageCallbackRe,
  fallbackAddProviderCallbackRe,
  fallbackAutoSwitchOffCallback,
  fallbackAutoSwitchOnCallback,
  fallbackAutoSwitchSameCallback,
  fallbackBackCallback,
  fallbackChainMaxLength,
  fallbackClaudeModelAliases,
  fallbackClearCallback,
  fallbackMoveDownCallbackRe,
  fallbackMoveUpCallbackRe,
  fallbackProposeCallback,
  fallbackProposeConfirmCallback,
  fallbackRemoveCallbackRe,
  fallbackSwitchCallbackRe,
  fallbackToggleCallbackRe,
  fallbackWaitOffCallback,
  fallbackWaitOnCallback,
  fallbackWaitSameCallback,
  formatFallbackEntryLabel,
  getFallbackChainRevision,
  getFallbackEntryAvailability,
  listOpenCodeModelsOfProvider,
  listOpenCodeProviders,
  moveFallbackEntry,
  parseFallbackEditCallback,
  parseFallbackSwitchCallbackData,
  proposeFallbackChain,
  removeFallbackEntry,
  toggleFallbackEntryDisabled,
  type FallbackChainEntry,
  type FallbackDetection,
} from '../../../utils/fallbackChain';
import { getCallbackMessageId } from './callbackMessage';
import type { BotCore } from './botCore';

/** Models per page in the «add an OpenCode model» step (the `/model` picker's density). */
const addModelPageSize = 8;

/**
 * What the chain picker needs from the bot: the shared core, the detection of what is signed in, the topic's
 * current position (to mark it and to skip it), the instance zone for the limit marks, and the switch a
 * limit-notice button triggers.
 */
export interface FallbackChainPorts
  extends Pick<
    BotCore,
    'bot' | 'command' | 'getState' | 'replyToThread' | 'editThreadMessage' | 'authoriseContext' | 'withThreadLocale' | 'checkIsGeneral'
  > {
  getInstanceTimezone: () => string;
  /** What is connected now: Claude profiles with usage, the OpenCode catalog, the recent picks, the limit marks. */
  detectFallbackOptions: () => Promise<FallbackDetection>;
  /** The rung the topic runs on now (its Claude profile + model, or its OpenCode provider/model); `null` for no agent. */
  getTopicPosition: (key: SessionKey) => FallbackChainEntry | null;
  /**
   * A tap on a «switch to …» button of a usage-limit notice (`utils/fallbackChain.ts`): move the topic and
   * continue its work. The confirmation the notice is edited into, or `null` when the tap is stale.
   */
  takeSwitchOffer: (key: SessionKey, episodeId: number, index: number) => Promise<string | null>;
  /**
   * Apply the «wait for the reset and continue» setting (`autoContinueLimits.ts`, which also drops an armed
   * wait that the new value contradicts): `null` = a topic follows General again. The confirmation is ignored
   * here — `/limits` words its own.
   */
  applyAutoContinue: (key: SessionKey, isGeneral: boolean, enabled: boolean | null) => Promise<string>;
  /** The fire time of the limit wait armed for the topic, or `null` — the screen then offers «skip once». */
  getArmedLimitRetryFireAt: (key: SessionKey) => number | null;
}

/** The «add» sub-picker's own snapshot, per picker MESSAGE: the providers it listed and the chosen provider's models. */
interface AddSnapshot {
  providers: string[];
  providerId: string | null;
  models: string[];
}

/** @description Build the `/limits` feature over its ports: the command (+ the hidden aliases), its buttons, the limit-notice switch button. */
export function createFallbackChain(ports: FallbackChainPorts) {
  const {
    bot, command, getState, replyToThread, editThreadMessage, authoriseContext, withThreadLocale, checkIsGeneral,
    getInstanceTimezone, detectFallbackOptions, getTopicPosition, takeSwitchOffer, applyAutoContinue, getArmedLimitRetryFireAt,
  } = ports;

  const addSnapshots = new Map<number, AddSnapshot>();

  function getLabelWords(): { claude: string; openCode: string; topicModel: string } {
    return { claude: t('fallback.backendClaude'), openCode: t('fallback.backendOpenCode'), topicModel: t('fallback.topicModel') };
  }

  /** The entry for a row or a button. */
  function formatEntry(entry: FallbackChainEntry): string {
    return formatFallbackEntryLabel(entry, getLabelWords());
  }

  function formatRow(index: number, entry: FallbackChainEntry, detection: FallbackDetection, current: FallbackChainEntry | null, nowMs: number): string {
    const availability = getFallbackEntryAvailability(entry, detection, nowMs);
    let status = '';
    if (availability.status === 'limited') status = t('fallback.row.limited', { until: formatClaudeUsageResetAt(availability.until, getInstanceTimezone(), nowMs) });
    else if (availability.status === 'signedOut') status = t('fallback.row.signedOut');
    else if (availability.status === 'missing') status = t('fallback.row.missing');
    const marker = current && checkIsSameFallbackAccount(entry, current) ? t('fallback.row.current') : '';
    return `${index + 1}. ${checkIsFallbackEntryDisabled(entry) ? '🚫' : '✅'} ${formatEntry(entry)}${status}${marker}`;
  }

  /** The auto-switch value the topic (General: the instance) effectively has. */
  function resolveAutoSwitchEnabled(key: SessionKey, isGeneral: boolean): boolean {
    return isGeneral ? getState().getClaudeAutoSwitchOnLimitGlobalDefault() : getState().checkIsClaudeAutoSwitchOnLimitEnabled(key);
  }

  /** The wait-for-the-reset value the topic (General: the instance) effectively has. */
  function resolveWaitEnabled(key: SessionKey, isGeneral: boolean): boolean {
    return isGeneral ? getState().getAutoContinueOnLimitGlobalDefault() : getState().checkIsAutoContinueOnLimitEnabled(key);
  }

  function formatState(enabled: boolean): string {
    return enabled ? t('autoContinueLimits.on') : t('autoContinueLimits.off');
  }

  /** `ON` for General; `ON (as in General)` / `OFF (set for this topic)` in a topic. */
  function formatSettingValue(enabled: boolean, override: boolean | undefined, isGeneral: boolean): string {
    if (isGeneral) return formatState(enabled);
    return `${formatState(enabled)}${override === undefined ? t('limits.sourceGeneral') : t('limits.sourceTopic')}`;
  }

  /**
   * One setting's buttons. General: a single flip button (shows the value, taps to the other). A topic: three
   * buttons — on / off / same as General (with the General value) — the current choice marked `✓`.
   */
  function buildSettingRow(input: {
    icon: string;
    labelKey: 'limits.switchButton' | 'limits.waitButton';
    isGeneral: boolean;
    effective: boolean;
    override: boolean | undefined;
    generalValue: boolean;
    onData: string;
    offData: string;
    sameData: string;
  }) {
    if (input.isGeneral) {
      return [Markup.button.callback(t(input.labelKey, { state: formatState(input.effective) }), input.effective ? input.offData : input.onData)];
    }
    const mark = (isCurrent: boolean): string => (isCurrent ? ' ✓' : '');
    return [
      Markup.button.callback(`${input.icon} ${formatState(true)}${mark(input.override === true)}`, input.onData),
      Markup.button.callback(`${input.icon} ${formatState(false)}${mark(input.override === false)}`, input.offData),
      Markup.button.callback(`${input.icon} ${t('limits.optSame', { state: formatState(input.generalValue) })}${mark(input.override === undefined)}`, input.sameData),
    ];
  }

  /**
   * The `/limits` screen: the chain with its availability (editable rows in General), the two settings with
   * their effective values, and how they combine. A topic also sees what it runs on now, and «skip once»
   * while a limit wait is armed for it.
   */
  async function buildPicker(key: SessionKey, isGeneral: boolean): Promise<{ text: string; keyboard: ReturnType<typeof Markup.inlineKeyboard> }> {
    const chain = getState().getFallbackChain();
    const detection = await detectFallbackOptions();
    const current = isGeneral ? null : getTopicPosition(key);
    const nowMs = Date.now();
    const list = chain.map((entry, index) => formatRow(index, entry, detection, current, nowMs)).join('\n');
    const switchOverride = isGeneral ? undefined : getState().getClaudeAutoSwitchOnLimitOverride(key);
    const waitOverride = isGeneral ? undefined : getState().getAutoContinueOnLimitOverride(key);
    const switchEnabled = resolveAutoSwitchEnabled(key, isGeneral);
    const waitEnabled = resolveWaitEnabled(key, isGeneral);
    const parts: string[] = [];
    if (!isGeneral) parts.push(t('limits.topicRuns', { current: current ? formatEntry(current) : t('fallback.noAgent') }));
    parts.push(chain.length === 0 ? t('limits.chainEmpty') : t('limits.chainTitle', { list }));
    if (isGeneral) parts.push(t('limits.chainHintGeneral'));
    parts.push(`${isGeneral ? `${t('limits.settingsGeneral')}\n` : ''}${t('limits.settings', {
      switch: formatSettingValue(switchEnabled, switchOverride, isGeneral),
      wait: formatSettingValue(waitEnabled, waitOverride, isGeneral),
    })}`);
    parts.push(t('limits.howItWorks'));
    const rows: ReturnType<typeof Markup.button.callback>[][] = [];
    if (isGeneral) {
      const revision = getFallbackChainRevision(chain);
      chain.forEach((entry, index) => {
        rows.push([
          Markup.button.callback(`⬆️ ${index + 1}`, buildFallbackMoveUpCallback(index, revision)),
          Markup.button.callback(`⬇️ ${index + 1}`, buildFallbackMoveDownCallback(index, revision)),
          Markup.button.callback(`${checkIsFallbackEntryDisabled(entry) ? '🚫' : '✅'} ${index + 1}`, buildFallbackToggleCallback(index, revision)),
          Markup.button.callback(`🗑 ${index + 1}`, buildFallbackRemoveCallback(index, revision)),
        ]);
      });
      const actions = [
        Markup.button.callback(t('fallback.addButton'), fallbackAddCallback),
        Markup.button.callback(t('limits.rebuildButton'), fallbackProposeCallback),
      ];
      if (chain.length > 0) actions.push(Markup.button.callback(t('fallback.clearButton'), fallbackClearCallback));
      rows.push(actions);
    }
    rows.push(buildSettingRow({
      icon: '🔁', labelKey: 'limits.switchButton', isGeneral, effective: switchEnabled, override: switchOverride,
      generalValue: getState().getClaudeAutoSwitchOnLimitGlobalDefault(),
      onData: fallbackAutoSwitchOnCallback, offData: fallbackAutoSwitchOffCallback, sameData: fallbackAutoSwitchSameCallback,
    }));
    rows.push(buildSettingRow({
      icon: '⏳', labelKey: 'limits.waitButton', isGeneral, effective: waitEnabled, override: waitOverride,
      generalValue: getState().getAutoContinueOnLimitGlobalDefault(),
      onData: fallbackWaitOnCallback, offData: fallbackWaitOffCallback, sameData: fallbackWaitSameCallback,
    }));
    const armedFireAt = isGeneral ? null : getArmedLimitRetryFireAt(key);
    if (armedFireAt !== null) rows.push([Markup.button.callback(t('autoContinueLimits.skipButton'), buildSkipArmedRetryCallbackData(armedFireAt))]);
    return { text: parts.join('\n\n'), keyboard: Markup.inlineKeyboard(rows) };
  }

  /** Re-render the picker IN PLACE (it is meant for repeated use, like `/account`); best-effort. */
  async function rerenderPicker(key: SessionKey, messageId: number | null, isGeneral: boolean): Promise<void> {
    if (messageId === null) return;
    addSnapshots.delete(messageId);
    const picker = await buildPicker(key, isGeneral);
    await editThreadMessage(key, messageId, picker.text, picker.keyboard);
  }

  function buildBackRow() {
    return [Markup.button.callback(t('fallback.backButton'), fallbackBackCallback)];
  }

  /** Step 1 of «add»: the signed-in Claude profiles and the OpenCode providers the server is authenticated for. */
  async function renderAddAccountStep(key: SessionKey, messageId: number): Promise<void> {
    const detection = await detectFallbackOptions();
    const words = getLabelWords();
    const rows: ReturnType<typeof Markup.button.callback>[][] = [];
    for (const profile of detection.claudeProfiles) {
      if (profile.loggedIn === false) continue;
      rows.push([Markup.button.callback(`${words.claude} · ${profile.name}`, buildFallbackAddClaudeCallback(profile.name))]);
    }
    const providers = listOpenCodeProviders(detection.openCodeModels);
    providers.forEach((providerId, index) => {
      rows.push([Markup.button.callback(`${words.openCode} · ${providerId}`, buildFallbackAddProviderCallback(index))]);
    });
    if (rows.length === 0) {
      await replyToThread(key, t('fallback.nothingDetected'));
      return;
    }
    addSnapshots.set(messageId, { providers, providerId: null, models: [] });
    rows.push(buildBackRow());
    await editThreadMessage(key, messageId, t('fallback.pickAccount'), Markup.inlineKeyboard(rows));
  }

  /** Step 2 for a Claude profile: keep the topic's model, or pin one of the CLI aliases. */
  async function renderAddClaudeModelStep(key: SessionKey, messageId: number, profile: string): Promise<void> {
    const rows = [[Markup.button.callback(t('fallback.topicModelButton'), buildFallbackAddClaudeModelCallback(profile, null))]];
    rows.push(fallbackClaudeModelAliases.map((model) => Markup.button.callback(model, buildFallbackAddClaudeModelCallback(profile, model))));
    rows.push(buildBackRow());
    await editThreadMessage(key, messageId, t('fallback.pickModel', { account: `${getLabelWords().claude} · ${profile}` }), Markup.inlineKeyboard(rows));
  }

  /** Step 2 for an OpenCode provider: one page of its models (absolute indexes into the snapshot). */
  async function renderAddModelPage(key: SessionKey, messageId: number, snapshot: AddSnapshot, page: number): Promise<void> {
    const { slice, currentPage, totalPages } = paginateList(snapshot.models, page, addModelPageSize);
    const offset = currentPage * addModelPageSize;
    const rows = slice.map((modelId, index) => [Markup.button.callback(modelId, buildFallbackAddModelCallback(offset + index))]);
    if (totalPages > 1) {
      const nav: ReturnType<typeof Markup.button.callback>[] = [];
      if (currentPage > 0) nav.push(Markup.button.callback('◀️', buildFallbackAddModelPageCallback(currentPage - 1)));
      nav.push(Markup.button.callback(`${currentPage + 1}/${totalPages}`, buildFallbackAddModelPageCallback(currentPage)));
      if (currentPage < totalPages - 1) nav.push(Markup.button.callback('▶️', buildFallbackAddModelPageCallback(currentPage + 1)));
      rows.push(nav);
    }
    rows.push(buildBackRow());
    await editThreadMessage(key, messageId, t('fallback.pickModel', { account: `${getLabelWords().openCode} · ${snapshot.providerId}` }), Markup.inlineKeyboard(rows));
  }

  /** Append an entry to the chain and RETURN the confirmation (the one write path behind both add steps). */
  async function applyAdd(entry: FallbackChainEntry): Promise<string> {
    const result = addFallbackEntry(getState().getFallbackChain(), entry);
    if (!result.ok) {
      return result.reason === 'full' ? t('fallback.full', { max: fallbackChainMaxLength }) : t('fallback.alreadyInChain', { label: formatEntry(entry) });
    }
    await getState().setFallbackChain(result.chain);
    return t('fallback.added', { label: formatEntry(entry) });
  }

  /** Replace the chain with the draft and RETURN the confirmation. */
  async function applyPropose(): Promise<string> {
    const chain = proposeFallbackChain(await detectFallbackOptions(), getState().getFallbackChain());
    if (chain.length === 0) return t('fallback.proposeNothing');
    await getState().setFallbackChain(chain);
    return t('fallback.proposed', { count: chain.length });
  }

  async function applyClear(): Promise<string> {
    await getState().setFallbackChain([]);
    return t('fallback.cleared');
  }

  /**
   * @description Set whether the bot moves a limited topic to the next rung by itself (OFF by default: moving
   * work between accounts and providers is an operator decision) and RETURN the confirmation. General sets the
   * instance default, a topic its override (`null` = follow General again).
   */
  async function applyAutoSwitch(key: SessionKey, isGeneral: boolean, enabled: boolean | null): Promise<string> {
    const what = t('limits.whatSwitch');
    if (isGeneral) {
      await getState().setClaudeAutoSwitchOnLimitGlobalDefault(enabled ?? false);
      return t('limits.setGlobal', { what, state: formatState(enabled ?? false) });
    }
    await getState().setClaudeAutoSwitchOnLimitOverride(key, enabled);
    return enabled === null
      ? t('limits.setSame', { what, state: formatState(getState().getClaudeAutoSwitchOnLimitGlobalDefault()) })
      : t('limits.setThisTopic', { what, state: formatState(enabled) });
  }

  /** The «wait for the reset» twin of {@link applyAutoSwitch}; the write (and the armed-wait cleanup) is `autoContinueLimits.ts`'s. */
  async function applyWait(key: SessionKey, isGeneral: boolean, enabled: boolean | null): Promise<string> {
    const what = t('limits.whatWait');
    await applyAutoContinue(key, isGeneral, isGeneral ? (enabled ?? true) : enabled);
    if (isGeneral) return t('limits.setGlobal', { what, state: formatState(enabled ?? true) });
    return enabled === null
      ? t('limits.setSame', { what, state: formatState(getState().getAutoContinueOnLimitGlobalDefault()) })
      : t('limits.setThisTopic', { what, state: formatState(enabled) });
  }

  // ── the command ──

  function registerFallbackChainCommands(): void {
    // `/limits` — bare: the screen (editable chain in General, read-only elsewhere). `propose` / `rebuild`
    // drafts the chain, `clear` empties it, `switch|autoswitch on|off|same` and `wait on|off|same` flip the two
    // settings. `/fallback` is the same command under its old name (hidden alias). Not gated on a session:
    // the chain must be settable before any limit hits.
    command(['limits', 'fallback'], async (_ctx, key, parsed: InboundCommand) => {
      const [verb = '', value = ''] = parsed.args;
      await runLimitsCommand(key, verb, value);
    });
  }

  /** Open the screen as a fresh message (the `/auto_continue_limits` alias lands here). */
  async function openLimitsView(key: SessionKey): Promise<void> {
    const picker = await buildPicker(key, checkIsGeneral(key));
    await replyToThread(key, picker.text, picker.keyboard);
  }

  async function runLimitsCommand(key: SessionKey, verb: string, value: string): Promise<void> {
    const isGeneral = checkIsGeneral(key);
    const word = value.toLowerCase();
    const parseState = (): boolean | null | undefined => {
      if (word === 'on') return true;
      if (word === 'off') return false;
      if (word === 'same' && !isGeneral) return null;
      return undefined;
    };
    switch (verb.toLowerCase()) {
      case '':
        await openLimitsView(key);
        return;
      case 'propose':
      case 'rebuild': {
        if (!isGeneral) { await replyToThread(key, t('fallback.generalOnly')); return; }
        await replyToThread(key, await applyPropose());
        await openLimitsView(key);
        return;
      }
      case 'clear': {
        if (!isGeneral) { await replyToThread(key, t('fallback.generalOnly')); return; }
        await replyToThread(key, await applyClear());
        return;
      }
      case 'switch':
      case 'autoswitch': {
        const enabled = parseState();
        if (enabled === undefined) { await replyToThread(key, t('limits.usage')); return; }
        await replyToThread(key, await applyAutoSwitch(key, isGeneral, enabled));
        return;
      }
      case 'wait': {
        const enabled = parseState();
        if (enabled === undefined) { await replyToThread(key, t('limits.usage')); return; }
        await replyToThread(key, await applyWait(key, isGeneral, enabled));
        return;
      }
      default:
        await replyToThread(key, t('limits.usage'));
    }
  }

  /** The shared tap prologue: authorise, resolve the topic, run under its locale. */
  async function handleTap(ctx: Context, run: (key: SessionKey, isGeneral: boolean, messageId: number | null) => Promise<void>): Promise<void> {
    const key = await authoriseContext(ctx);
    if (!key) { await ctx.answerCbQuery(t('cb.access_denied')); return; }
    await withThreadLocale(key, () => run(key, checkIsGeneral(key), getCallbackMessageId(ctx)));
  }

  /** `answerCbQuery` is capped at 200 characters: a long confirmation goes to the topic instead. */
  async function answerTap(ctx: Context, key: SessionKey, text: string): Promise<void> {
    if (text.length <= 180) { await ctx.answerCbQuery(text); return; }
    await ctx.answerCbQuery();
    await replyToThread(key, text);
  }

  /** An edit tap: refused outside General; a stale revision only re-renders. */
  function registerEdit(re: RegExp, edit: (chain: FallbackChainEntry[], index: number) => ReturnType<typeof removeFallbackEntry>, confirm: (chain: FallbackChainEntry[], index: number) => string): void {
    bot.action(re, (ctx) => handleTap(ctx, async (key, isGeneral, messageId) => {
      if (!isGeneral) { await ctx.answerCbQuery(t('fallback.generalOnly')); return; }
      const chain = getState().getFallbackChain();
      const parsed = parseFallbackEditCallback(ctx.match[0], re, getFallbackChainRevision(chain));
      if (parsed === null) { await ctx.answerCbQuery(); return; }
      if (!parsed.isCurrent) {
        await ctx.answerCbQuery(t('fallback.stale'));
        await rerenderPicker(key, messageId, isGeneral);
        return;
      }
      const result = edit(chain, parsed.index);
      if (!result.ok) { await ctx.answerCbQuery(t('fallback.stale')); await rerenderPicker(key, messageId, isGeneral); return; }
      await getState().setFallbackChain(result.chain);
      await answerTap(ctx, key, confirm(chain, parsed.index));
      await rerenderPicker(key, messageId, isGeneral);
    }));
  }

  function registerFallbackChainCallbacks(): void {
    registerEdit(fallbackMoveUpCallbackRe, (chain, index) => moveFallbackEntry(chain, index, -1), () => t('fallback.moved'));
    registerEdit(fallbackMoveDownCallbackRe, (chain, index) => moveFallbackEntry(chain, index, 1), () => t('fallback.moved'));
    registerEdit(fallbackToggleCallbackRe, toggleFallbackEntryDisabled, (chain, index) => t(
      checkIsFallbackEntryDisabled(chain[index]) ? 'limits.entryEnabled' : 'limits.entryDisabled',
      { label: formatEntry(chain[index]) },
    ));
    registerEdit(fallbackRemoveCallbackRe, removeFallbackEntry, (chain, index) => t('fallback.removed', { label: formatEntry(chain[index]) }));

    bot.action(fallbackAddCallback, (ctx) => handleTap(ctx, async (key, isGeneral, messageId) => {
      if (!isGeneral) { await ctx.answerCbQuery(t('fallback.generalOnly')); return; }
      await ctx.answerCbQuery();
      if (messageId !== null) await renderAddAccountStep(key, messageId);
    }));

    bot.action(fallbackAddClaudeCallbackRe, (ctx) => handleTap(ctx, async (key, isGeneral, messageId) => {
      if (!isGeneral) { await ctx.answerCbQuery(t('fallback.generalOnly')); return; }
      await ctx.answerCbQuery();
      if (messageId !== null) await renderAddClaudeModelStep(key, messageId, ctx.match[1]);
    }));

    bot.action(fallbackAddClaudeModelCallbackRe, (ctx) => handleTap(ctx, async (key, isGeneral, messageId) => {
      if (!isGeneral) { await ctx.answerCbQuery(t('fallback.generalOnly')); return; }
      const model = ctx.match[2] === '-' ? null : ctx.match[2];
      await answerTap(ctx, key, await applyAdd({ backend: 'claude', profile: ctx.match[1], model }));
      await rerenderPicker(key, messageId, isGeneral);
    }));

    bot.action(fallbackAddProviderCallbackRe, (ctx) => handleTap(ctx, async (key, isGeneral, messageId) => {
      if (!isGeneral) { await ctx.answerCbQuery(t('fallback.generalOnly')); return; }
      const snapshot = messageId === null ? undefined : addSnapshots.get(messageId);
      const providerId = snapshot?.providers[Number(ctx.match[1])];
      if (messageId === null || !snapshot || providerId === undefined) {
        await ctx.answerCbQuery(t('fallback.stale'));
        await rerenderPicker(key, messageId, isGeneral);
        return;
      }
      await ctx.answerCbQuery();
      const detection = await detectFallbackOptions();
      const models = listOpenCodeModelsOfProvider(detection.openCodeModels, providerId);
      const next: AddSnapshot = { ...snapshot, providerId, models };
      addSnapshots.set(messageId, next);
      await renderAddModelPage(key, messageId, next, 0);
    }));

    bot.action(fallbackAddModelPageCallbackRe, (ctx) => handleTap(ctx, async (key, isGeneral, messageId) => {
      const snapshot = messageId === null ? undefined : addSnapshots.get(messageId);
      if (messageId === null || !snapshot || snapshot.providerId === null) {
        await ctx.answerCbQuery(t('fallback.stale'));
        await rerenderPicker(key, messageId, isGeneral);
        return;
      }
      await ctx.answerCbQuery();
      await renderAddModelPage(key, messageId, snapshot, Number(ctx.match[1]));
    }));

    bot.action(fallbackAddModelCallbackRe, (ctx) => handleTap(ctx, async (key, isGeneral, messageId) => {
      if (!isGeneral) { await ctx.answerCbQuery(t('fallback.generalOnly')); return; }
      const snapshot = messageId === null ? undefined : addSnapshots.get(messageId);
      const modelId = snapshot?.models[Number(ctx.match[1])];
      if (!snapshot || snapshot.providerId === null || modelId === undefined) {
        await ctx.answerCbQuery(t('fallback.stale'));
        await rerenderPicker(key, messageId, isGeneral);
        return;
      }
      await answerTap(ctx, key, await applyAdd({ backend: 'opencode', providerId: snapshot.providerId, modelId }));
      await rerenderPicker(key, messageId, isGeneral);
    }));

    bot.action(fallbackProposeCallback, (ctx) => handleTap(ctx, async (key, isGeneral, messageId) => {
      if (!isGeneral) { await ctx.answerCbQuery(t('fallback.generalOnly')); return; }
      if (getState().getFallbackChain().length === 0) {
        await answerTap(ctx, key, await applyPropose());
        await rerenderPicker(key, messageId, isGeneral);
        return;
      }
      await ctx.answerCbQuery();
      if (messageId !== null) {
        await editThreadMessage(key, messageId, t('limits.rebuildConfirm'), Markup.inlineKeyboard([
          [Markup.button.callback(t('fallback.proposeConfirmButton'), fallbackProposeConfirmCallback)],
          buildBackRow(),
        ]));
      }
    }));

    bot.action(fallbackProposeConfirmCallback, (ctx) => handleTap(ctx, async (key, isGeneral, messageId) => {
      if (!isGeneral) { await ctx.answerCbQuery(t('fallback.generalOnly')); return; }
      await answerTap(ctx, key, await applyPropose());
      await rerenderPicker(key, messageId, isGeneral);
    }));

    bot.action(fallbackClearCallback, (ctx) => handleTap(ctx, async (key, isGeneral, messageId) => {
      if (!isGeneral) { await ctx.answerCbQuery(t('fallback.generalOnly')); return; }
      await answerTap(ctx, key, await applyClear());
      await rerenderPicker(key, messageId, isGeneral);
    }));

    bot.action(fallbackBackCallback, (ctx) => handleTap(ctx, async (key, isGeneral, messageId) => {
      await ctx.answerCbQuery();
      await rerenderPicker(key, messageId, isGeneral);
    }));

    const settingTaps: ReadonlyArray<[string, (key: SessionKey, isGeneral: boolean, enabled: boolean | null) => Promise<string>, boolean | null]> = [
      [fallbackAutoSwitchOnCallback, applyAutoSwitch, true], [fallbackAutoSwitchOffCallback, applyAutoSwitch, false], [fallbackAutoSwitchSameCallback, applyAutoSwitch, null],
      [fallbackWaitOnCallback, applyWait, true], [fallbackWaitOffCallback, applyWait, false], [fallbackWaitSameCallback, applyWait, null],
    ];
    for (const [callback, apply, enabled] of settingTaps) {
      bot.action(callback, (ctx) => handleTap(ctx, async (key, isGeneral, messageId) => {
        if (enabled === null && isGeneral) { await ctx.answerCbQuery(); return; }
        await answerTap(ctx, key, await apply(key, isGeneral, enabled));
        await rerenderPicker(key, messageId, isGeneral);
      }));
    }

    // «🔁 Switch to <entry>» on a usage-limit notice: a one-shot button — the notice is edited into the
    // confirmation (keyboard dropped); a stale tap (the episode is over) only says so.
    bot.action(fallbackSwitchCallbackRe, (ctx) => handleTap(ctx, async (key, _isGeneral, messageId) => {
      const parsed = parseFallbackSwitchCallbackData(ctx.match[0]);
      if (parsed === null) { await ctx.answerCbQuery(); return; }
      const confirmation = await takeSwitchOffer(key, parsed.episodeId, parsed.index);
      if (confirmation === null) { await ctx.answerCbQuery(t('fallback.switchExpired')); return; }
      await ctx.answerCbQuery();
      if (messageId !== null) await editThreadMessage(key, messageId, confirmation);
    }));
  }

  return { registerFallbackChainCommands, registerFallbackChainCallbacks, openLimitsView, formatFallbackEntry: formatEntry };
}
