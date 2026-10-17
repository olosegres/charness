/**
 * `/limits_autoswitch` — the setup of automatic switching on a usage limit, on one screen: the instance-wide priority
 * chain of backend + account / provider + model a topic continues on (reorder, include / exclude, remove, add through
 * a two-step sub-picker, rebuild a draft, clear — from EVERY topic, one instance-wide list), the two settings that decide
 * what a limit does (auto switch to a fallback model, wait for the reset and continue — instance defaults in General,
 * on / off / same-as-General overrides in a topic, chosen in a per-setting sub-menu) — and the «🔁 Switch to …»
 * buttons a usage-limit notice carries. The message text is deliberately short: a title, the topic's position and
 * where its settings come from — the list and the settings' values are on the buttons. `/fallback` and
 * `/auto_continue_limits` are hidden aliases of this screen. `/limits` itself is the switch board
 * (`limitsBoard.ts`). See README.md in this folder and `utils/fallbackChain.ts`.
 */
import { Markup, type Context } from 'telegraf';
import type { SessionKey } from '../../../sessionKey';
import { t } from '../../../i18n';
import type { InboundCommand } from '../../../platform/inbound';
import { modelPickerNoopCallback } from '../../../utils/modelPickerPlan';
import { formatClaudeUsageResetAt } from '../../../utils/claudeUsage';
import { claudeUsageOnDemandMaxAgeMs } from '../../../utils/claudeUsageRefresher';
import { buildSkipArmedRetryCallbackData } from '../../../utils/autoContinueOnLimit';
import {
  addFallbackEntry,
  buildFallbackAddConfirmCallback,
  buildFallbackAddClaudeCallback,
  buildFallbackAddClaudeModelCallback,
  buildFallbackAddModelCallback,
  buildFallbackAddModelPageCallback,
  buildFallbackAddProviderCallback,
  buildFallbackMoveDownCallback,
  buildFallbackMoveUpCallback,
  buildFallbackRemoveCallback,
  buildFallbackToggleCallback,
  buildFallbackToggleConfirmCallback,
  checkIsFallbackEntryDisabled,
  checkIsMixedFallbackChain,
  checkIsNewBackendForChain,
  checkIsSameFallbackAccount,
  fallbackAddCallback,
  fallbackAddConfirmCallbackRe,
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
  fallbackToggleConfirmCallbackRe,
  fallbackWaitOffCallback,
  fallbackWaitOnCallback,
  fallbackWaitOpenCallback,
  fallbackWaitSameCallback,
  formatFallbackEntryLabel,
  formatOpenCodeModelLimitSuffix,
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
import { buildMessageSnapshotKey, getCallbackMessageId } from './callbackMessage';
import type { BotCore } from './botCore';
import { createWholeTextAnswerer } from './callbackToast';
import { buildModelPageButtons } from './modelPage';

/**
 * How long opening the screen waits for the usage refresh (one poll is ~0.5 s). A slower one — a hung endpoint
 * runs into the fetch's own 15 s timeout — keeps going in the background and the next render shows its result.
 */
export const limitsUsageRefreshBudgetMs = 2_000;

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

/** A setting's texts: its main-screen button (the name with the value, `{state}`) and the title of its sub-menu. */
const settingTextKeys: Record<SettingId, { button: 'limits.switchButton' | 'limits.waitButton'; menuTitle: 'limits.switchMenuTitle' | 'limits.waitMenuTitle' }> = {
  switch: { button: 'limits.switchButton', menuTitle: 'limits.switchMenuTitle' },
  wait: { button: 'limits.waitButton', menuTitle: 'limits.waitMenuTitle' },
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
  /**
   * Bring the per-profile usage snapshots up to date (`utils/claudeUsageRefresher.ts`) for the usage block; never
   * throws. Called when the screen is OPENED (bounded by {@link limitsUsageRefreshBudgetMs}), never on a tap: the
   * rows' availability reads the windows (an account at 100 % is not a candidate).
   */
  refreshClaudeUsage: (options: { maxAgeMs?: number }) => Promise<void>;
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

/** @description Build the `/limits_autoswitch` feature over its ports: the command (+ the hidden aliases), its buttons, the limit-notice switch button. */
export function createFallbackChain(ports: FallbackChainPorts) {
  const {
    bot, command, getState, replyToThread, editThreadMessage, authoriseContext, withThreadLocale, checkIsGeneral,
    getInstanceTimezone, refreshClaudeUsage, detectFallbackOptions, getTopicPosition, takeSwitchOffer, applyAutoContinue, getArmedLimitRetryFireAt,
  } = ports;
  const answerWithWholeText = createWholeTextAnswerer(replyToThread);

  // Both per MESSAGE, keyed by chat + message id (`buildMessageSnapshotKey`): a message id is unique only within one chat.
  const addSnapshots = new Map<string, AddSnapshot>();
  /** The rung each «add it?» question waits to add; the revision of the list it was asked about rides in its button. */
  const pendingAdds = new Map<string, FallbackChainEntry>();

  function getLabelWords(): { claude: string; openCode: string; topicModel: string } {
    return { claude: t('fallback.backendClaude'), openCode: t('fallback.backendOpenCode'), topicModel: t('fallback.topicModel') };
  }

  /** The entry for a row or a button. */
  function formatEntry(entry: FallbackChainEntry): string {
    return formatFallbackEntryLabel(entry, getLabelWords());
  }

  /**
   * A rung on its label button: `✓ 1. Claude · work · opus` / `3. OpenCode · openai · gpt-6.1 🚫` — the program, then
   * the account or provider and the model when the rung names one (Telegram sizes and truncates the button as it sees
   * fit). The rung's state rides as a suffix (⛔ limited until, 🔒 not signed in, ❓ not offered any more, 🚫 left out
   * of switching) and ✓ at the start marks where the topic runs now. The one place the label is built: a two-row
   * layout (label on its own row) only changes how `buildPicker` assembles the row.
   */
  function formatRowButtonLabel(index: number, entry: FallbackChainEntry, detection: FallbackDetection, current: FallbackChainEntry | null, nowMs: number): string {
    const words = getLabelWords();
    const base = entry.backend === 'claude'
      ? `${words.claude} · ${entry.profile}${entry.model === null ? '' : ` · ${entry.model}`}`
      : `${words.openCode} · ${entry.providerId} · ${entry.modelId}`;
    const availability = getFallbackEntryAvailability(entry, detection, nowMs);
    let suffix = '';
    if (availability.status === 'limited') suffix += ` ⛔ ${formatClaudeUsageResetAt(availability.until, getInstanceTimezone(), nowMs)}`;
    else if (availability.status === 'signedOut') suffix += ' 🔒';
    else if (availability.status === 'missing') suffix += ' ❓';
    if (checkIsFallbackEntryDisabled(entry)) suffix += ' 🚫';
    const here = current && checkIsSameFallbackAccount(entry, current) ? '✓ ' : '';
    return `${here}${index + 1}. ${base}${suffix}`;
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

  /** Where a topic's setting value comes from: General, or the topic's own override. */
  function formatSettingSource(setting: SettingValue): string {
    return setting.override === undefined ? t('limits.sourceGeneral') : t('limits.sourceTopic');
  }

  /**
   * One setting's button on the main screen: one full-width button with the setting's name and its effective value
   * (`🔁 Auto switch: ON`). Where a topic's value comes from is in the message text above and in the sub-menu
   * (the ✓), not on the button — the worded source made it too long for a phone and cut it again. General: a tap
   * flips the value. A topic: a tap opens the setting's sub-menu ({@link renderSettingMenu}) in the same message —
   * three choices on one row would split the width evenly and cut every label.
   */
  function buildSettingRow(id: SettingId, setting: SettingValue, isGeneral: boolean) {
    const callbacks = settingCallbacks[id];
    const tapData = isGeneral ? (setting.effective ? callbacks.off : callbacks.on) : callbacks.open;
    return [Markup.button.callback(t(settingTextKeys[id].button, { state: formatState(setting.effective) }), tapData)];
  }

  /**
   * A topic's setting sub-menu, in the message the screen sits in: the setting's name, then ON / OFF / As in
   * General (with the General value it would give) as full-width buttons — the current choice marked `✓`, which
   * is also where the value comes from — and Back. The options are the setting's own callbacks, which apply the
   * choice and return to the main screen.
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
    await editThreadMessage(key, messageId, t(settingTextKeys[id].menuTitle), Markup.inlineKeyboard(rows));
  }

  /**
   * The `/limits_autoswitch` screen. Text: its title, what the topic runs on and where its two settings come from
   * (General: just that these are defaults), then the list's heading — the list itself, its marks and the two
   * settings' values are on the buttons. A topic also gets «skip once» while a limit wait is armed for it.
   */
  async function buildPicker(key: SessionKey, isGeneral: boolean): Promise<{ text: string; keyboard: ReturnType<typeof Markup.inlineKeyboard> }> {
    const chain = getState().getFallbackChain();
    const detection = await detectFallbackOptions();
    const current = isGeneral ? null : getTopicPosition(key);
    const nowMs = Date.now();
    const switchSetting = readSetting('switch', key, isGeneral);
    const waitSetting = readSetting('wait', key, isGeneral);
    const parts: string[] = [];
    parts.push(isGeneral
      ? [t('limits.autoswitchTitle'), t('limits.settingsGeneral')].join('\n')
      : [
        t('limits.autoswitchTitle'),
        t('limits.topicRuns', { current: current ? formatEntry(current) : t('fallback.noAgent') }),
        t('limits.sourceLine', { switch: formatSettingSource(switchSetting), wait: formatSettingSource(waitSetting) }),
      ].join('\n'));
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

  /** Re-render the picker IN PLACE (it is meant for repeated use, like `/account`) off the cached usage; best-effort. */
  async function rerenderPicker(key: SessionKey, messageId: number | null, isGeneral: boolean): Promise<void> {
    if (messageId === null) return;
    const snapshotKey = buildMessageSnapshotKey(key, messageId);
    addSnapshots.delete(snapshotKey);
    pendingAdds.delete(snapshotKey);
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
    addSnapshots.set(buildMessageSnapshotKey(key, messageId), { providers, providerId: null, models: [] });
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

  /** Step 2 for an OpenCode provider: one page of its models (absolute indexes into the snapshot), limit marks on the limited ones. */
  async function showAddModelPage(key: SessionKey, messageId: number, snapshot: AddSnapshot, page: number): Promise<void> {
    const providerId = snapshot.providerId ?? '';
    const { openCodeLimits } = await detectFallbackOptions();
    const nowMs = Date.now();
    const { rows } = buildModelPageButtons({
      provider: providerId,
      models: snapshot.models,
      page,
      current: null,
      callbacks: {
        buildPage: buildFallbackAddModelPageCallback,
        buildPick: buildFallbackAddModelCallback,
        noop: modelPickerNoopCallback,
        back: { label: t('fallback.backButton'), data: fallbackBackCallback },
      },
      getSuffix: (modelId) => formatOpenCodeModelLimitSuffix(`${providerId}/${modelId}`, openCodeLimits, getInstanceTimezone(), nowMs),
    });
    await editThreadMessage(key, messageId, t('fallback.pickModel', { account: `${getLabelWords().openCode} · ${providerId}` }), Markup.inlineKeyboard(rows));
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

  /**
   * The question before a rung of a NEW backend joins automatic switching, in the message the tap came from: the
   * rung, the shared line about the hand-over, ✅ Continue (the revision of the list is baked in) and ✖️ Cancel
   * (`cancelData`: back to the list, or to the rung's detail view). A tap that comes late finds the list changed.
   */
  async function askAboutNewBackend(key: SessionKey, messageId: number, questionKey: 'limits.addConfirm' | 'limits.enableConfirm', entry: FallbackChainEntry, continueData: string, cancelData: string): Promise<void> {
    const text = `${t(questionKey, { label: formatEntry(entry) })}\n${t('handover.note')}`;
    await editThreadMessage(key, messageId, text, Markup.inlineKeyboard([[
      Markup.button.callback(t('handover.continueButton'), continueData),
      Markup.button.callback(t('handover.cancelButton'), cancelData),
    ]]));
  }

  /**
   * An «add» that finished its steps. A rung of a backend the list does not use yet asks first (the question
   * replaces the picker in the same message); any other add goes ahead and the screen is re-rendered.
   */
  async function takeAdd(ctx: Context, key: SessionKey, isGeneral: boolean, messageId: number | null, entry: FallbackChainEntry): Promise<void> {
    const chain = getState().getFallbackChain();
    if (messageId !== null && addFallbackEntry(chain, entry).ok && checkIsNewBackendForChain(chain, entry)) {
      await ctx.answerCbQuery();
      pendingAdds.set(buildMessageSnapshotKey(key, messageId), entry);
      await askAboutNewBackend(key, messageId, 'limits.addConfirm', entry, buildFallbackAddConfirmCallback(getFallbackChainRevision(chain)), fallbackBackCallback);
      return;
    }
    await answerWithWholeText(ctx, key, await applyAdd(entry));
    await rerenderPicker(key, messageId, isGeneral);
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
    // `/limits_autoswitch` — bare: the screen (the chain is edited from every topic). `propose` / `rebuild`
    // drafts the chain, `clear` empties it, `switch|autoswitch on|off|same` and `wait on|off|same` flip the two
    // settings; `/limits` takes the same verbs (`limitsBoard.ts` hands them to {@link runAutoSwitchCommand}).
    // `/fallback` is the same command under its old name (hidden alias). Not gated on a session: the chain must
    // be settable before any limit hits.
    command(['limits_autoswitch', 'fallback', 'limits'], async (_ctx, key, parsed: InboundCommand) => {
      const [verb = '', value = ''] = parsed.args;
      await runAutoSwitchCommand(key, verb, value);
    });
  }

  /**
   * Refresh the usage snapshots (a snapshot younger than a minute is kept — the `/accounts` freshness), waiting at
   * most {@link limitsUsageRefreshBudgetMs}: the screen is never held by a slow usage endpoint.
   */
  async function refreshUsageWithinBudget(): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const budget = new Promise<void>((resolve) => { timer = setTimeout(resolve, limitsUsageRefreshBudgetMs); });
    try {
      await Promise.race([refreshClaudeUsage({ maxAgeMs: claudeUsageOnDemandMaxAgeMs }), budget]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Open the screen as a fresh message (the `/auto_continue_limits` alias lands here); the usage is refreshed first. */
  async function openAutoSwitchView(key: SessionKey): Promise<void> {
    await refreshUsageWithinBudget();
    const picker = await buildPicker(key, checkIsGeneral(key));
    await replyToThread(key, picker.text, picker.keyboard);
  }

  async function runAutoSwitchCommand(key: SessionKey, verb: string, value: string): Promise<void> {
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
        await openAutoSwitchView(key);
        return;
      case 'propose':
      case 'rebuild': {
        await replyToThread(key, await applyPropose());
        await openAutoSwitchView(key);
        return;
      }
      case 'clear': {
        await replyToThread(key, await applyClear());
        return;
      }
      case 'switch':
      case 'autoswitch': {
        const enabled = parseState();
        if (enabled === undefined) { await replyToThread(key, t('limits.autoswitchUsage')); return; }
        await replyToThread(key, await applyAutoSwitch(key, isGeneral, enabled));
        return;
      }
      case 'wait': {
        const enabled = parseState();
        if (enabled === undefined) { await replyToThread(key, t('limits.autoswitchUsage')); return; }
        await replyToThread(key, await applyWait(key, isGeneral, enabled));
        return;
      }
      default:
        await replyToThread(key, t('limits.autoswitchUsage'));
    }
  }

  /** The shared tap prologue: authorise, resolve the topic, run under its locale. */
  async function handleTap(ctx: Context, run: (key: SessionKey, isGeneral: boolean, messageId: number | null) => Promise<void>): Promise<void> {
    const key = await authoriseContext(ctx);
    if (!key) { await ctx.answerCbQuery(t('cb.access_denied')); return; }
    await withThreadLocale(key, () => run(key, checkIsGeneral(key), getCallbackMessageId(ctx)));
  }

  /** An edit tap: a stale revision only re-renders. */
  function registerEdit(
    re: RegExp,
    edit: (chain: FallbackChainEntry[], index: number) => ReturnType<typeof removeFallbackEntry>,
    confirm: (chain: FallbackChainEntry[], index: number) => string,
    /** Where the rung sits after the edit (the detail view follows it); `null` = back to the list. */
    nextIndex: (index: number) => number | null,
    /** An edit that must ask first answers with the data of the question's two buttons; `null` = go ahead. */
    gate?: (chain: FallbackChainEntry[], index: number, revision: string) => { continueData: string; cancelData: string } | null,
  ): void {
    bot.action(re, (ctx) => handleTap(ctx, async (key, isGeneral, messageId) => {
      const chain = getState().getFallbackChain();
      const revision = getFallbackChainRevision(chain);
      const parsed = parseFallbackEditCallback(ctx.match[0], re, revision);
      if (parsed === null) { await ctx.answerCbQuery(); return; }
      if (!parsed.isCurrent) {
        await ctx.answerCbQuery(t('fallback.stale'));
        await rerenderPicker(key, messageId, isGeneral);
        return;
      }
      const question = gate?.(chain, parsed.index, revision);
      if (question && messageId !== null && chain[parsed.index]) {
        await ctx.answerCbQuery();
        await askAboutNewBackend(key, messageId, 'limits.enableConfirm', chain[parsed.index], question.continueData, question.cancelData);
        return;
      }
      const result = edit(chain, parsed.index);
      if (!result.ok) { await ctx.answerCbQuery(t('fallback.stale')); await rerenderPicker(key, messageId, isGeneral); return; }
      await getState().setFallbackChain(result.chain);
      await answerWithWholeText(ctx, key, confirm(chain, parsed.index));
      const next = nextIndex(parsed.index);
      if (next === null) await rerenderPicker(key, messageId, isGeneral);
      else await renderRungDetail(key, messageId, next, isGeneral);
    }));
  }

  function registerFallbackChainCallbacks(): void {
    registerEdit(fallbackMoveUpCallbackRe, (chain, index) => moveFallbackEntry(chain, index, -1), () => t('fallback.moved'), (index) => Math.max(0, index - 1));
    registerEdit(fallbackMoveDownCallbackRe, (chain, index) => moveFallbackEntry(chain, index, 1), () => t('fallback.moved'), (index) => index + 1);
    const confirmToggle = (chain: FallbackChainEntry[], index: number): string => t(
      checkIsFallbackEntryDisabled(chain[index]) ? 'limits.entryEnabled' : 'limits.entryDisabled',
      { label: formatEntry(chain[index]) },
    );
    // Using a rung that is left out is a question when its backend is not in automatic switching yet.
    registerEdit(fallbackToggleCallbackRe, toggleFallbackEntryDisabled, confirmToggle, (index) => index, (chain, index, revision) => {
      const entry = chain[index];
      if (!entry || !checkIsFallbackEntryDisabled(entry) || !checkIsNewBackendForChain(chain.filter((_, i) => i !== index), entry)) return null;
      return { continueData: buildFallbackToggleConfirmCallback(index, revision), cancelData: buildFallbackOpenCallback(index, revision) };
    });
    registerEdit(fallbackToggleConfirmCallbackRe, toggleFallbackEntryDisabled, confirmToggle, (index) => index);
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
      await takeAdd(ctx, key, isGeneral, messageId, { backend: 'claude', profile: ctx.match[1], model });
    }));

    bot.action(fallbackAddProviderCallbackRe, (ctx) => handleTap(ctx, async (key, isGeneral, messageId) => {
      const snapshot = messageId === null ? undefined : addSnapshots.get(buildMessageSnapshotKey(key, messageId));
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
      addSnapshots.set(buildMessageSnapshotKey(key, messageId), next);
      await showAddModelPage(key, messageId, next, 0);
    }));

    bot.action(fallbackAddModelPageCallbackRe, (ctx) => handleTap(ctx, async (key, isGeneral, messageId) => {
      const snapshot = messageId === null ? undefined : addSnapshots.get(buildMessageSnapshotKey(key, messageId));
      if (messageId === null || !snapshot || snapshot.providerId === null) {
        await ctx.answerCbQuery(t('fallback.stale'));
        await rerenderPicker(key, messageId, isGeneral);
        return;
      }
      await ctx.answerCbQuery();
      await showAddModelPage(key, messageId, snapshot, Number(ctx.match[1]));
    }));

    bot.action(fallbackAddModelCallbackRe, (ctx) => handleTap(ctx, async (key, isGeneral, messageId) => {
      const snapshot = messageId === null ? undefined : addSnapshots.get(buildMessageSnapshotKey(key, messageId));
      const modelId = snapshot?.models[Number(ctx.match[1])];
      if (!snapshot || snapshot.providerId === null || modelId === undefined) {
        await ctx.answerCbQuery(t('fallback.stale'));
        await rerenderPicker(key, messageId, isGeneral);
        return;
      }
      await takeAdd(ctx, key, isGeneral, messageId, { backend: 'opencode', providerId: snapshot.providerId, modelId });
    }));

    // «✅ Continue» of the question before a rung of a new backend is added: only while the list is the one the
    // question was asked about; a stale tap re-renders the list and adds nothing.
    bot.action(fallbackAddConfirmCallbackRe, (ctx) => handleTap(ctx, async (key, isGeneral, messageId) => {
      const entry = messageId === null ? undefined : pendingAdds.get(buildMessageSnapshotKey(key, messageId));
      if (!entry || ctx.match[1] !== getFallbackChainRevision(getState().getFallbackChain())) {
        await ctx.answerCbQuery(t('fallback.stale'));
        await rerenderPicker(key, messageId, isGeneral);
        return;
      }
      if (messageId !== null) pendingAdds.delete(buildMessageSnapshotKey(key, messageId));
      await answerWithWholeText(ctx, key, await applyAdd(entry));
      await rerenderPicker(key, messageId, isGeneral);
    }));

    bot.action(fallbackProposeCallback, (ctx) => handleTap(ctx, async (key, isGeneral, messageId) => {
      if (getState().getFallbackChain().length === 0) {
        await answerWithWholeText(ctx, key, await applyPropose());
        await rerenderPicker(key, messageId, isGeneral);
        return;
      }
      await ctx.answerCbQuery();
      if (messageId !== null) {
        // A draft that holds both backends hands conversations over when a limit moves a topic along it: say so.
        const draft = proposeFallbackChain(await detectFallbackOptions(), getState().getFallbackChain());
        const text = checkIsMixedFallbackChain(draft) ? `${t('limits.rebuildConfirm')}\n${t('handover.note')}` : t('limits.rebuildConfirm');
        await editThreadMessage(key, messageId, text, Markup.inlineKeyboard([
          [Markup.button.callback(t('fallback.proposeConfirmButton'), fallbackProposeConfirmCallback)],
          buildBackRow(),
        ]));
      }
    }));

    bot.action(fallbackProposeConfirmCallback, (ctx) => handleTap(ctx, async (key, isGeneral, messageId) => {
      await answerWithWholeText(ctx, key, await applyPropose());
      await rerenderPicker(key, messageId, isGeneral);
    }));

    bot.action(fallbackClearCallback, (ctx) => handleTap(ctx, async (key, isGeneral, messageId) => {
      await answerWithWholeText(ctx, key, await applyClear());
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
        await answerWithWholeText(ctx, key, await apply(key, isGeneral, enabled));
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

  return { registerFallbackChainCommands, registerFallbackChainCallbacks, openAutoSwitchView, runAutoSwitchCommand, applyAutoSwitch, formatFallbackEntry: formatEntry };
}
