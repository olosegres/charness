/**
 * `/limits` — everything about a usage limit on one screen: the instance-wide priority chain of backend +
 * account / provider + model a topic continues on (reorder, include / exclude, remove, add through a two-step
 * sub-picker, rebuild a draft, clear — from EVERY topic, one instance-wide list), the two settings that decide what a
 * limit does (auto switch to a fallback model, wait for the reset and continue — instance defaults in General,
 * on / off / same-as-General overrides in a topic, chosen in a per-setting sub-menu) — and the «🔁 Switch to …»
 * buttons a usage-limit notice carries. `/fallback` and `/auto_continue_limits` are hidden aliases of this
 * screen. See README.md in this folder and `utils/fallbackChain.ts`.
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
  fallbackAutoSwitchOpenCallback,
  fallbackAutoSwitchSameCallback,
  fallbackBackCallback,
  fallbackChainMaxLength,
  fallbackClaudeModelAliases,
  fallbackClearCallback,
  fallbackMoveDownCallbackRe,
  fallbackOpenCallbackRe,
  buildFallbackOpenCallback,
  fallbackMoveUpCallbackRe,
  fallbackProposeCallback,
  fallbackProposeConfirmCallback,
  fallbackRemoveCallbackRe,
  fallbackSwitchCallbackRe,
  fallbackToggleCallbackRe,
  fallbackWaitOffCallback,
  fallbackWaitOnCallback,
  fallbackWaitOpenCallback,
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

/** The two settings of the screen: the ids the setting rows, the sub-menu and its callbacks are keyed by. */
type SettingId = 'switch' | 'wait';

const settingIds: readonly SettingId[] = ['switch', 'wait'];

/** A setting's value as a screen reads it: what is in force, the topic's own choice (`undefined` = follows General) and the General value. */
interface SettingValue {
  effective: boolean;
  override: boolean | undefined;
  generalValue: boolean;
}

/** One setting's callbacks: the topic button that opens its sub-menu, and the sub-menu's on / off / same-as-General options. */
interface SettingCallbacks {
  open: string;
  on: string;
  off: string;
  same: string;
}

const settingCallbacks: Record<SettingId, SettingCallbacks> = {
  switch: { open: fallbackAutoSwitchOpenCallback, on: fallbackAutoSwitchOnCallback, off: fallbackAutoSwitchOffCallback, same: fallbackAutoSwitchSameCallback },
  wait: { open: fallbackWaitOpenCallback, on: fallbackWaitOnCallback, off: fallbackWaitOffCallback, same: fallbackWaitSameCallback },
};

/** The line naming a setting with its value (`{state}`): the main screen's button (the value alone) and the sub-menu's text (with its source). */
const settingLabelKeys: Record<SettingId, 'limits.switchButton' | 'limits.waitButton'> = {
  switch: 'limits.switchButton',
  wait: 'limits.waitButton',
};

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

  /**
   * A rung on its label button: `3. Claude · work ⛔ 14:00` / `1. openai / gpt-6.1 🚫` — the FULL name (Telegram
   * sizes and truncates the button as it sees fit). The rung's state rides as a suffix (⛔ limited until, 🔒 not
   * signed in, ❓ not offered any more, 🚫 left out of switching, ✓ where the topic runs now). The one place the
   * label is built: a two-row layout (label on its own row) only changes how `buildPicker` assembles the row.
   */
  function formatRowButtonLabel(index: number, entry: FallbackChainEntry, detection: FallbackDetection, current: FallbackChainEntry | null, nowMs: number): string {
    const base = entry.backend === 'claude'
      ? formatEntry(entry)
      : `${entry.providerId} / ${entry.modelId}`;
    const availability = getFallbackEntryAvailability(entry, detection, nowMs);
    let suffix = '';
    if (availability.status === 'limited') suffix += ` ⛔ ${formatClaudeUsageResetAt(availability.until, getInstanceTimezone(), nowMs)}`;
    else if (availability.status === 'signedOut') suffix += ' 🔒';
    else if (availability.status === 'missing') suffix += ' ❓';
    if (checkIsFallbackEntryDisabled(entry)) suffix += ' 🚫';
    if (current && checkIsSameFallbackAccount(entry, current)) suffix += ' ✓';
    return `${index + 1}. ${base}${suffix}`;
  }

  /**
   * A rung's detail view, in the message the list sits in: its name and state, then ⬆️ Up / ⬇️ Down (hidden at
   * the ends), Use / Don't use, Remove and Back. Every edit button bakes the chain revision and the index, so a
   * stale tap re-renders the list instead of acting.
   */
  async function renderRungDetail(key: SessionKey, messageId: number | null, index: number, isGeneral: boolean): Promise<void> {
    if (messageId === null) return;
    const chain = getState().getFallbackChain();
    const entry = chain[index];
    if (!entry) { await rerenderPicker(key, messageId, isGeneral); return; }
    const detection = await detectFallbackOptions();
    const current = isGeneral ? null : getTopicPosition(key);
    const nowMs = Date.now();
    const availability = getFallbackEntryAvailability(entry, detection, nowMs);
    const lines = [t('limits.rungTitle', { n: index + 1, total: chain.length, label: formatEntry(entry) })];
    if (availability.status === 'limited') lines.push(t('limits.rungLimited', { until: formatClaudeUsageResetAt(availability.until, getInstanceTimezone(), nowMs) }));
    else if (availability.status === 'signedOut') lines.push(t('limits.rungSignedOut'));
    else if (availability.status === 'missing') lines.push(t('limits.rungMissing'));
    else lines.push(t('limits.rungReady'));
    if (checkIsFallbackEntryDisabled(entry)) lines.push(t('limits.rungDisabled'));
    if (current && checkIsSameFallbackAccount(entry, current)) lines.push(t('limits.rungHere'));
    const revision = getFallbackChainRevision(chain);
    const move: ReturnType<typeof Markup.button.callback>[] = [];
    if (index > 0) move.push(Markup.button.callback(t('limits.btnUp'), buildFallbackMoveUpCallback(index, revision)));
    if (index < chain.length - 1) move.push(Markup.button.callback(t('limits.btnDown'), buildFallbackMoveDownCallback(index, revision)));
    const rows = [
      ...(move.length > 0 ? [move] : []),
      [
        Markup.button.callback(t(checkIsFallbackEntryDisabled(entry) ? 'limits.btnUse' : 'limits.btnDontUse'), buildFallbackToggleCallback(index, revision)),
        Markup.button.callback(t('account.removeButton'), buildFallbackRemoveCallback(index, revision)),
      ],
      buildBackRow(),
    ];
    await editThreadMessage(key, messageId, lines.join('\n'), Markup.inlineKeyboard(rows));
  }

  /** A setting's value for the topic (General: the instance default, where there is no override). */
  function readSetting(id: SettingId, key: SessionKey, isGeneral: boolean): SettingValue {
    if (id === 'switch') {
      return {
        effective: isGeneral ? getState().getClaudeAutoSwitchOnLimitGlobalDefault() : getState().checkIsClaudeAutoSwitchOnLimitEnabled(key),
        override: isGeneral ? undefined : getState().getClaudeAutoSwitchOnLimitOverride(key),
        generalValue: getState().getClaudeAutoSwitchOnLimitGlobalDefault(),
      };
    }
    return {
      effective: isGeneral ? getState().getAutoContinueOnLimitGlobalDefault() : getState().checkIsAutoContinueOnLimitEnabled(key),
      override: isGeneral ? undefined : getState().getAutoContinueOnLimitOverride(key),
      generalValue: getState().getAutoContinueOnLimitGlobalDefault(),
    };
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
   * One setting's button on the main screen: one full-width button with the setting's name and its effective value
   * (`🔁 Auto switch to a fallback model: ON`). Where a topic's value comes from is in the message text above and in
   * the sub-menu, not on the button — the worded source made it too long for a phone and cut it again. General: a tap
   * flips the value. A topic: a tap opens the setting's sub-menu ({@link renderSettingMenu}) in the same message —
   * three choices on one row would split the width evenly and cut every label.
   */
  function buildSettingRow(id: SettingId, setting: SettingValue, isGeneral: boolean) {
    const callbacks = settingCallbacks[id];
    const tapData = isGeneral ? (setting.effective ? callbacks.off : callbacks.on) : callbacks.open;
    return [Markup.button.callback(t(settingLabelKeys[id], { state: formatState(setting.effective) }), tapData)];
  }

  /**
   * A topic's setting sub-menu, in the message the screen sits in: the setting's line, then ON / OFF / As in
   * General (with the General value it would give) as full-width buttons — the current choice marked `✓` — and
   * Back. The options are the setting's own callbacks, which apply the choice and return to the main screen.
   */
  async function renderSettingMenu(key: SessionKey, messageId: number | null, id: SettingId): Promise<void> {
    if (messageId === null) return;
    const setting = readSetting(id, key, false);
    const callbacks = settingCallbacks[id];
    const mark = (isCurrent: boolean): string => (isCurrent ? ' ✓' : '');
    const rows = [
      [Markup.button.callback(`${formatState(true)}${mark(setting.override === true)}`, callbacks.on)],
      [Markup.button.callback(`${formatState(false)}${mark(setting.override === false)}`, callbacks.off)],
      [Markup.button.callback(
        `${t('limits.settingSameButton', { state: formatState(setting.generalValue) })}${mark(setting.override === undefined)}`,
        callbacks.same,
      )],
      buildBackRow(),
    ];
    const line = t(settingLabelKeys[id], { state: formatSettingValue(setting.effective, setting.override, false) });
    await editThreadMessage(key, messageId, line, Markup.inlineKeyboard(rows));
  }

  /**
   * The `/limits` screen: the chain with its availability (editable from every topic), the two settings with
   * their effective values, and how they combine. A topic also sees what it runs on now, and «skip once»
   * while a limit wait is armed for it.
   */
  async function buildPicker(key: SessionKey, isGeneral: boolean): Promise<{ text: string; keyboard: ReturnType<typeof Markup.inlineKeyboard> }> {
    const chain = getState().getFallbackChain();
    const detection = await detectFallbackOptions();
    const current = isGeneral ? null : getTopicPosition(key);
    const nowMs = Date.now();
    const switchSetting = readSetting('switch', key, isGeneral);
    const waitSetting = readSetting('wait', key, isGeneral);
    const parts: string[] = [];
    if (!isGeneral) parts.push(t('limits.topicRuns', { current: current ? formatEntry(current) : t('fallback.noAgent') }));
    parts.push(t('limits.chainHint'));
    parts.push(`${isGeneral ? `${t('limits.settingsGeneral')}\n` : ''}${t('limits.settings', {
      switch: formatSettingValue(switchSetting.effective, switchSetting.override, isGeneral),
      wait: formatSettingValue(waitSetting.effective, waitSetting.override, isGeneral),
    })}`);
    parts.push(t('limits.howItWorks'));
    parts.push(chain.length === 0 ? t('limits.listNoteEmpty') : t('limits.listNote'));
    const rows: ReturnType<typeof Markup.button.callback>[][] = [];
    const revision = getFallbackChainRevision(chain);
    // One full-width button per rung; a tap opens the rung's detail view in the same message.
    chain.forEach((entry, index) => {
      rows.push([Markup.button.callback(formatRowButtonLabel(index, entry, detection, current, nowMs), buildFallbackOpenCallback(index, revision))]);
    });
    const actions = [
      Markup.button.callback(t('fallback.addButton'), fallbackAddCallback),
      Markup.button.callback(t('limits.rebuildButton'), fallbackProposeCallback),
    ];
    if (chain.length > 0) actions.push(Markup.button.callback(t('fallback.clearButton'), fallbackClearCallback));
    rows.push(actions);
    rows.push(buildSettingRow('switch', switchSetting, isGeneral));
    rows.push(buildSettingRow('wait', waitSetting, isGeneral));
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
    // `/limits` — bare: the screen (the chain is edited from every topic). `propose` / `rebuild`
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
        await replyToThread(key, await applyPropose());
        await openLimitsView(key);
        return;
      }
      case 'clear': {
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

  /** An edit tap: a stale revision only re-renders. */
  function registerEdit(
    re: RegExp,
    edit: (chain: FallbackChainEntry[], index: number) => ReturnType<typeof removeFallbackEntry>,
    confirm: (chain: FallbackChainEntry[], index: number) => string,
    /** Where the rung sits after the edit (the detail view follows it); `null` = back to the list. */
    nextIndex: (index: number) => number | null,
  ): void {
    bot.action(re, (ctx) => handleTap(ctx, async (key, isGeneral, messageId) => {
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
      const next = nextIndex(parsed.index);
      if (next === null) await rerenderPicker(key, messageId, isGeneral);
      else await renderRungDetail(key, messageId, next, isGeneral);
    }));
  }

  function registerFallbackChainCallbacks(): void {
    registerEdit(fallbackMoveUpCallbackRe, (chain, index) => moveFallbackEntry(chain, index, -1), () => t('fallback.moved'), (index) => Math.max(0, index - 1));
    registerEdit(fallbackMoveDownCallbackRe, (chain, index) => moveFallbackEntry(chain, index, 1), () => t('fallback.moved'), (index) => index + 1);
    registerEdit(fallbackToggleCallbackRe, toggleFallbackEntryDisabled, (chain, index) => t(
      checkIsFallbackEntryDisabled(chain[index]) ? 'limits.entryEnabled' : 'limits.entryDisabled',
      { label: formatEntry(chain[index]) },
    ), (index) => index);
    registerEdit(fallbackRemoveCallbackRe, removeFallbackEntry, (chain, index) => t('fallback.removed', { label: formatEntry(chain[index]) }), () => null);

    // A rung's button on the list: open its detail view (a stale revision only re-renders the list).
    bot.action(fallbackOpenCallbackRe, (ctx) => handleTap(ctx, async (key, isGeneral, messageId) => {
      const chain = getState().getFallbackChain();
      const parsed = parseFallbackEditCallback(ctx.match[0], fallbackOpenCallbackRe, getFallbackChainRevision(chain));
      if (parsed === null) { await ctx.answerCbQuery(); return; }
      if (!parsed.isCurrent || parsed.index >= chain.length) {
        await ctx.answerCbQuery(t('fallback.stale'));
        await rerenderPicker(key, messageId, isGeneral);
        return;
      }
      await ctx.answerCbQuery();
      await renderRungDetail(key, messageId, parsed.index, isGeneral);
    }));

    bot.action(fallbackAddCallback, (ctx) => handleTap(ctx, async (key, _isGeneral, messageId) => {
      await ctx.answerCbQuery();
      if (messageId !== null) await renderAddAccountStep(key, messageId);
    }));

    bot.action(fallbackAddClaudeCallbackRe, (ctx) => handleTap(ctx, async (key, _isGeneral, messageId) => {
      await ctx.answerCbQuery();
      if (messageId !== null) await renderAddClaudeModelStep(key, messageId, ctx.match[1]);
    }));

    bot.action(fallbackAddClaudeModelCallbackRe, (ctx) => handleTap(ctx, async (key, isGeneral, messageId) => {
      const model = ctx.match[2] === '-' ? null : ctx.match[2];
      await answerTap(ctx, key, await applyAdd({ backend: 'claude', profile: ctx.match[1], model }));
      await rerenderPicker(key, messageId, isGeneral);
    }));

    bot.action(fallbackAddProviderCallbackRe, (ctx) => handleTap(ctx, async (key, isGeneral, messageId) => {
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
      await answerTap(ctx, key, await applyPropose());
      await rerenderPicker(key, messageId, isGeneral);
    }));

    bot.action(fallbackClearCallback, (ctx) => handleTap(ctx, async (key, isGeneral, messageId) => {
      await answerTap(ctx, key, await applyClear());
      await rerenderPicker(key, messageId, isGeneral);
    }));

    bot.action(fallbackBackCallback, (ctx) => handleTap(ctx, async (key, isGeneral, messageId) => {
      await ctx.answerCbQuery();
      await rerenderPicker(key, messageId, isGeneral);
    }));

    // A topic's setting button: open its sub-menu. General has no sub-menu (its button flips the value), so a tap
    // that still arrives there only re-renders the screen.
    for (const id of settingIds) {
      bot.action(settingCallbacks[id].open, (ctx) => handleTap(ctx, async (key, isGeneral, messageId) => {
        await ctx.answerCbQuery();
        if (isGeneral) await rerenderPicker(key, messageId, isGeneral);
        else await renderSettingMenu(key, messageId, id);
      }));
    }

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

  return { registerFallbackChainCommands, registerFallbackChainCallbacks, openLimitsView, applyAutoSwitch, formatFallbackEntry: formatEntry };
}
