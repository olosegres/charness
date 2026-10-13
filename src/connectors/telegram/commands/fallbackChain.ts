/**
 * `/fallback` — the instance-wide priority chain of backend + account / provider + model a topic continues on
 * when its agent hits a usage limit, with its buttons: reorder, remove, add (a two-step sub-picker), propose a
 * draft, clear, the auto-switch toggle — and the «🔁 Switch to …» buttons a usage-limit notice carries. See
 * README.md in this folder and `utils/fallbackChain.ts`.
 */
import { Markup, type Context } from 'telegraf';
import type { SessionKey } from '../../../sessionKey';
import { t } from '../../../i18n';
import type { InboundCommand } from '../../../platform/inbound';
import { paginateList } from '../../../utils/paginateList';
import { formatClaudeUsageResetAt } from '../../../utils/claudeUsage';
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
  checkIsSameFallbackAccount,
  fallbackAddCallback,
  fallbackAddClaudeCallbackRe,
  fallbackAddClaudeModelCallbackRe,
  fallbackAddModelCallbackRe,
  fallbackAddModelPageCallbackRe,
  fallbackAddProviderCallbackRe,
  fallbackAutoSwitchOffCallback,
  fallbackAutoSwitchOnCallback,
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
}

/** The «add» sub-picker's own snapshot, per picker MESSAGE: the providers it listed and the chosen provider's models. */
interface AddSnapshot {
  providers: string[];
  providerId: string | null;
  models: string[];
}

/** @description Build the `/fallback` feature over its ports: the command, its buttons, the limit-notice switch button. */
export function createFallbackChain(ports: FallbackChainPorts) {
  const {
    bot, command, getState, replyToThread, editThreadMessage, authoriseContext, withThreadLocale, checkIsGeneral,
    getInstanceTimezone, detectFallbackOptions, getTopicPosition, takeSwitchOffer,
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
    return `${index + 1}. ${formatEntry(entry)}${status}${marker}`;
  }

  /** The auto-switch value the topic (General: the instance) effectively has. */
  function resolveAutoSwitchEnabled(key: SessionKey, isGeneral: boolean): boolean {
    return isGeneral ? getState().getClaudeAutoSwitchOnLimitGlobalDefault() : getState().checkIsClaudeAutoSwitchOnLimitEnabled(key);
  }

  /** The main picker: the chain with its availability, the edit rows (General only) and the auto-switch toggle. */
  async function buildPicker(key: SessionKey, isGeneral: boolean): Promise<{ text: string; keyboard: ReturnType<typeof Markup.inlineKeyboard> }> {
    const chain = getState().getFallbackChain();
    const detection = await detectFallbackOptions();
    const current = isGeneral ? null : getTopicPosition(key);
    const nowMs = Date.now();
    const list = chain.map((entry, index) => formatRow(index, entry, detection, current, nowMs)).join('\n');
    const parts = [chain.length === 0 ? t('fallback.empty') : t('fallback.title', { list })];
    if (isGeneral) parts.push(t('fallback.generalHint'));
    else parts.push(t('fallback.topicNote', { current: current ? formatEntry(current) : t('fallback.noAgent') }));
    const rows: ReturnType<typeof Markup.button.callback>[][] = [];
    if (isGeneral) {
      const revision = getFallbackChainRevision(chain);
      chain.forEach((_, index) => {
        rows.push([
          Markup.button.callback(`⬆️ ${index + 1}`, buildFallbackMoveUpCallback(index, revision)),
          Markup.button.callback(`⬇️ ${index + 1}`, buildFallbackMoveDownCallback(index, revision)),
          Markup.button.callback(`🗑 ${index + 1}`, buildFallbackRemoveCallback(index, revision)),
        ]);
      });
      const actions = [
        Markup.button.callback(t('fallback.addButton'), fallbackAddCallback),
        Markup.button.callback(t('fallback.proposeButton'), fallbackProposeCallback),
      ];
      if (chain.length > 0) actions.push(Markup.button.callback(t('fallback.clearButton'), fallbackClearCallback));
      rows.push(actions);
    }
    const isAutoSwitchOn = resolveAutoSwitchEnabled(key, isGeneral);
    rows.push([
      Markup.button.callback(
        t('fallback.autoSwitchButton', { state: isAutoSwitchOn ? t('autoContinueLimits.on') : t('autoContinueLimits.off') }),
        isAutoSwitchOn ? fallbackAutoSwitchOffCallback : fallbackAutoSwitchOnCallback,
      ),
    ]);
    return { text: `${parts.join('\n\n')}\n\n${t('fallback.autoSwitchHint')}`, keyboard: Markup.inlineKeyboard(rows) };
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
    const chain = proposeFallbackChain(await detectFallbackOptions());
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
   * work between accounts and providers is an operator decision) and RETURN the confirmation. The same setting
   * `/account` shows: General sets the instance default, a topic its override.
   */
  async function applyAutoSwitch(key: SessionKey, isGeneral: boolean, enabled: boolean): Promise<string> {
    const stateWord = enabled ? t('autoContinueLimits.on') : t('autoContinueLimits.off');
    if (isGeneral) {
      await getState().setClaudeAutoSwitchOnLimitGlobalDefault(enabled);
      return t('account.autoSwitchSetGlobal', { state: stateWord });
    }
    await getState().setClaudeAutoSwitchOnLimitOverride(key, enabled);
    return t('account.autoSwitchSetThisTopic', { state: stateWord });
  }

  // ── the command ──

  function registerFallbackChainCommands(): void {
    // `/fallback` — bare: the picker (editable in General, read-only elsewhere). `propose` drafts the chain,
    // `clear` empties it, `autoswitch on|off` flips the toggle. Not gated on a session: the chain must be
    // settable before any limit hits.
    command('fallback', async (_ctx, key, parsed: InboundCommand) => {
      const isGeneral = checkIsGeneral(key);
      const [verb = '', value = ''] = parsed.args;
      switch (verb.toLowerCase()) {
        case '': {
          const picker = await buildPicker(key, isGeneral);
          await replyToThread(key, picker.text, picker.keyboard);
          return;
        }
        case 'propose': {
          if (!isGeneral) { await replyToThread(key, t('fallback.generalOnly')); return; }
          await replyToThread(key, await applyPropose());
          const picker = await buildPicker(key, isGeneral);
          await replyToThread(key, picker.text, picker.keyboard);
          return;
        }
        case 'clear': {
          if (!isGeneral) { await replyToThread(key, t('fallback.generalOnly')); return; }
          await replyToThread(key, await applyClear());
          return;
        }
        case 'autoswitch': {
          const word = value.toLowerCase();
          if (word !== 'on' && word !== 'off') { await replyToThread(key, t('fallback.usage')); return; }
          await replyToThread(key, await applyAutoSwitch(key, isGeneral, word === 'on'));
          return;
        }
        default:
          await replyToThread(key, t('fallback.usage'));
      }
    });
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
        await editThreadMessage(key, messageId, t('fallback.proposeConfirm'), Markup.inlineKeyboard([
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

    for (const [callback, enabled] of [[fallbackAutoSwitchOnCallback, true], [fallbackAutoSwitchOffCallback, false]] as const) {
      bot.action(callback, (ctx) => handleTap(ctx, async (key, isGeneral, messageId) => {
        await answerTap(ctx, key, await applyAutoSwitch(key, isGeneral, enabled));
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

  return { registerFallbackChainCommands, registerFallbackChainCallbacks, formatFallbackEntry: formatEntry };
}
