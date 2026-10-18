/**
 * `/model`, `/effort`, `/connect` and `/disconnect` — the provider → models picker, the effort picker and the
 * provider credential flows — with their buttons. See README.md in this folder.
 */
import { Markup, type Context } from 'telegraf';
import { getAdapter, getThreadAdapter } from '../../../adapters/createAdapter';
import { openCodeAdapterName } from '../../../adapters/adapterNames';
import type { AgentAdapter } from '../../../types';
import type { SessionKey } from '../../../sessionKey';
import { keyToString } from '../../../sessionKey';
import { checkIsValidProviderId } from '../../../adapters/openCodeAdapter';
import { t } from '../../../i18n';
import {
  type ModelCatalog,
  modelPickerNoopCallback,
  buildProviderShowCallback,
  buildProviderPageCallback,
  buildProviderHideCallback,
  getModelShortLabel,
  buildModelPickCallback,
  checkHasProviderLevel,
  modelPickerBackCallback,
  buildModelCatalog,
  providerPageCallbackRe,
  modelPickCallbackRe,
  providerHideCallbackRe,
  providerShowCallbackRe,
} from '../../../utils/modelPickerPlan';
import {
  buildRecentModelPickCallback,
  getRecentModelPick,
  getRecentModelsInCatalog,
  recentModelPickCallbackRe,
  recentModelsOpenCallback,
} from '../../../utils/modelRecentPlan';
import {
  buildDisconnectProviderCallback,
  buildDisconnectPickerKey,
  getEvictedDisconnectPickerKeys,
  disconnectProviderCallbackRe,
  getDisconnectPickerProviderAt,
} from '../../../utils/providerDisconnectPlan';
import type { InboundCommand } from '../../../platform/inbound';
import { checkIsApiError, getErrorDescription } from '../../../sendErrorClassifier';
import { getModelSetReplyDecision } from '../../../utils/modelSetReplyDecision';
import { checkIsClaudeEffortLevel, claudeEffortLevels, getEffortAmongLevels, getInstanceDefaultEffort, getThreadEffortView, type ClaudeEffortLevel } from '../../../effortLevels';
import { getCaughtErrnoCode } from '../../../configDirFile';
import { loadInstanceSettingsForUpdate, saveInstanceSettings } from '../../../instanceSettings';
import { buildEffortPicker, effortLevelCallbackRe, effortSameCallback, type EffortPicker } from '../../../utils/effortPickerPlan';
import {
  type OpenCodeAuthMethod,
  checkIsPlausibleProviderApiKey,
  buildConnectMethodButtonLabel,
  checkIsOAuthMethod,
} from '../../../utils/openCodeAuthLogin';
import { getCallbackMessageId } from './callbackMessage';
import { buildModelPageButtons, modelPageSize } from './modelPage';
import { answerCallbackQuerySafely, createWholeTextAnswerer } from './callbackToast';
import type { BotCore } from './botCore';

export interface PendingProviderConnect {
  providerId: string;
}

const defaultConnectProviderId = 'openai';

interface ConnectCommandArgs {
  providerId: string;
  apiKey: string | null;
}

function checkLooksLikeProviderApiKey(value: string): boolean {
  return value.startsWith('sk-');
}

function getConnectCommandArgs(parsed: InboundCommand): ConnectCommandArgs {
  const args = parsed.args;
  if (args.length === 0) return { providerId: defaultConnectProviderId, apiKey: null };
  if (args.length === 1) {
    const onlyArg = args[0].trim();
    if (checkLooksLikeProviderApiKey(onlyArg)) {
      return { providerId: defaultConnectProviderId, apiKey: onlyArg };
    }
    return { providerId: onlyArg.toLowerCase(), apiKey: null };
  }
  return {
    providerId: args[0].trim().toLowerCase(),
    apiKey: args.slice(1).join(' ').trim(),
  };
}

/**
 * @description The adapter that owns provider credentials.
 *
 * Provider auth is an OpenCode concept, so `/connect` and `/disconnect` BOTH
 * target the OpenCode adapter directly instead of the thread's current
 * backend — otherwise a topic that never started OpenCode could connect a
 * provider (which `/connect` has always allowed) but not disconnect it, and
 * the two are advertised side by side in the bound-thread help.
 */
export function getProviderAuthAdapter(): AgentAdapter {
  return getAdapter('opencode');
}

// ═══════════════════════════════════════════════════════════════════════════════
//  /model — two-level provider → models picker
// ═══════════════════════════════════════════════════════════════════════════════

/** Model label the thread currently runs, or the localized "default" stand-in. */
function getCurrentModelLabel(adapter: AgentAdapter, key: SessionKey): string {
  return adapter.getCurrentModel?.(key) || t('model.current_default');
}

/**
 * @description Provider level: one row per provider, each with a 🙈 button that
 * hides it from the picker. Hidden providers follow in their own section with a
 * 👁 button to bring them back — the only way back, so they must always render.
 *
 * The FIRST row is the "Recently used" shortcut — the flat cross-provider list
 * of models picked before — present only when that list (already filtered
 * against the catalog) has something to offer: an empty level would be a dead
 * end, so the button is simply absent.
 */
function buildModelProviderKeyboard(catalog: ModelCatalog, recentModels: readonly string[]) {
  const hiddenProviderSet = new Set(catalog.hiddenProviders);
  const visibleRows: ReturnType<typeof Markup.button.callback>[][] = [];
  const hiddenRows: ReturnType<typeof Markup.button.callback>[][] = [];
  if (recentModels.length > 0) {
    visibleRows.push([
      Markup.button.callback(
        t('model.recent_button', { count: recentModels.length }),
        recentModelsOpenCallback,
      ),
    ]);
  }
  catalog.providers.forEach((provider, providerIndex) => {
    const count = catalog.byProvider.get(provider)?.length ?? 0;
    if (hiddenProviderSet.has(provider)) {
      hiddenRows.push([
        Markup.button.callback(
          t('model.hidden_provider_button', { provider, count }),
          modelPickerNoopCallback,
        ),
        Markup.button.callback(t('model.show_button'), buildProviderShowCallback(providerIndex)),
      ]);
      return;
    }
    visibleRows.push([
      Markup.button.callback(
        t('model.provider_button', { provider, count }),
        buildProviderPageCallback(providerIndex, 0),
      ),
      Markup.button.callback(t('model.hide_button'), buildProviderHideCallback(providerIndex)),
    ]);
  });
  return Markup.inlineKeyboard([...visibleRows, ...hiddenRows]);
}

function buildModelProviderText(catalog: ModelCatalog, current: string): string {
  // An EMPTY catalog is not "everything is hidden": there is no 👁 row to tap,
  // so that copy would be a dead end. Reachable on the in-place re-render path
  // (hide/show/«back») when the backend's model lookup comes back empty — e.g.
  // a `/disconnect` dropped the last provider, or the CLI lookup failed right
  // after `resetOpenCodeProviderCaches()` wiped the cache.
  if (catalog.providers.length === 0) return t('model.none_available', { current });
  if (catalog.visibleProviders.length === 0) return t('model.all_hidden', { current });
  const header = t('model.pick_provider', { current });
  return catalog.hiddenProviders.length > 0 ? `${header}\n\n${t('model.hidden_header')}` : header;
}

/** A ready-to-send (or ready-to-edit) render of one picker level. */
export interface ModelPickerRender {
  text: string;
  keyboard: ReturnType<typeof Markup.inlineKeyboard>;
  /** Model ids on this page, in button order — empty at the provider level. */
  pageModels: string[];
  /**
   * Whether the rendered TEXT carries the numbered list. Paired with
   * {@link applyModelPagePickArming} so the bare-digit affordance can only ever
   * be armed for a page that actually SHOWS numbers — dead numbers that
   * silently do nothing, or live numbers with no list, are both bugs.
   */
  isNumberedPickArmed: boolean;
}

/**
 * @description Provider level (level 1) as a ready-to-send render. Exported so
 * the "no render path can outgrow Telegram's message cap" guarantee — the whole
 * point of the two-level picker — is assertable on THIS level too, not just on
 * the paginated model level.
 *
 * `recentModels` is the recently-used list ALREADY filtered against `catalog`
 * (`getRecentModelsInCatalog`); the caller passes nothing for a backend that
 * has no providers to hop between (the Claude backends).
 */
export function buildModelProviderRender(
  catalog: ModelCatalog,
  current: string,
  recentModels: readonly string[] = [],
): ModelPickerRender {
  return {
    text: buildModelProviderText(catalog, current),
    keyboard: buildModelProviderKeyboard(catalog, recentModels),
    pageModels: [],
    isNumberedPickArmed: false,
  };
}

/**
 * @description The "Recently used" level: one flat list of full
 * `provider/model` ids (the provider is the point here, so it is NOT
 * stripped), most recent first, ✓ on the current one, and the way back to the
 * providers. Buttons only — no numbered list, so it never arms the bare-digit
 * pick.
 *
 * Each button carries its position AND the entry's identity hash
 * (`mdlr_<i>_<hash>`): the list is reordered by every pick, so an index alone
 * would let a keyboard left in the history apply a different model than the
 * one printed on it.
 *
 * Returns `null` for an empty list — the row that opens this level is absent
 * then, so a tap can only come from a stale keyboard.
 */
export function buildRecentModelsRender(
  recentModels: readonly string[],
  current: string,
): ModelPickerRender | null {
  if (recentModels.length === 0) return null;
  const rows = recentModels.map((modelId, index) => [
    Markup.button.callback(
      modelId === current ? `${modelId} ✓` : modelId,
      buildRecentModelPickCallback(index, modelId),
    ),
  ]);
  rows.push([Markup.button.callback(t('model.back_button'), modelPickerBackCallback)]);
  const header = t('model.recent_header', { count: recentModels.length, current });
  return {
    text: `${header}\n\n${t('model.page_hint_buttons_only')}`,
    keyboard: Markup.inlineKeyboard(rows),
    pageModels: [],
    isNumberedPickArmed: false,
  };
}

/** Render options for {@link buildModelPageRender}. */
export interface ModelPageRenderOptions {
  /**
   * Include the numbered list in the message text. `false` for the re-render
   * that follows a BUTTON pick: the bare-digit affordance is disarmed there, so
   * printing numbers nothing responds to would be worse than printing none.
   */
  isWithNumberedList: boolean;
}

/**
 * @description Model level: one page of a single provider's models.
 *
 * Returns `null` when the provider index no longer resolves (a stale keyboard
 * after the catalog changed) or points at a HIDDEN provider — hiding must make
 * a provider unreachable here, not just invisible one level up.
 */
export function buildModelPageRender(
  catalog: ModelCatalog,
  providerIndex: number,
  page: number,
  current: string,
  options: ModelPageRenderOptions,
): ModelPickerRender | null {
  const provider = catalog.providers[providerIndex];
  if (provider === undefined || catalog.hiddenProviders.includes(provider)) return null;
  const providerModels = catalog.byProvider.get(provider) ?? [];
  const { rows, pageModels, currentPage, totalPages } = buildModelPageButtons({
    provider,
    models: providerModels,
    page,
    current,
    callbacks: {
      buildPage: (targetPage) => buildProviderPageCallback(providerIndex, targetPage),
      buildPick: (modelIndex) => buildModelPickCallback(providerIndex, modelIndex),
      noop: modelPickerNoopCallback,
      // No back row when the provider level was skipped — it would lead nowhere.
      back: checkHasProviderLevel(catalog.visibleProviders.length, catalog.hiddenProviders.length)
        ? { label: t('model.back_button'), data: modelPickerBackCallback }
        : null,
    },
  });

  const header = t('model.page_header', {
    provider,
    count: providerModels.length,
    page: currentPage + 1,
    totalPages,
    current,
  });
  const numberedList = options.isWithNumberedList
    ? pageModels.map((modelId, offset) => `${offset + 1}. ${getModelShortLabel(modelId, provider)}`).join('\n')
    : '';
  const hint = options.isWithNumberedList ? t('model.page_hint') : t('model.page_hint_buttons_only');
  const text = [header, numberedList, hint].filter((part) => part.length > 0).join('\n\n');

  return {
    text,
    keyboard: Markup.inlineKeyboard(rows),
    pageModels,
    isNumberedPickArmed: options.isWithNumberedList,
  };
}

/**
 * @description Swap a picker message to another level/page in place, keeping
 * the thread clean. A no-op edit (same button tapped twice) comes back as
 * Telegram's "message is not modified" 400, which is swallowed.
 */
async function editModelPickerMessage(
  ctx: Context,
  render: ModelPickerRender,
): Promise<void> {
  try {
    await ctx.editMessageText(render.text, render.keyboard);
  } catch (e) {
    const desc = checkIsApiError(e) ? getErrorDescription(e) : '';
    if (!/message is not modified/i.test(desc)) {
      console.warn('[model picker] edit failed:', desc || e);
    }
  }
}

/** @description The inline keyboard of an `/effort` picker plan (a thin Markup wrapper over its rows). */
function buildEffortKeyboard(picker: EffortPicker) {
  return Markup.inlineKeyboard(picker.rows.map((row) => row.map((button) => Markup.button.callback(button.text, button.data))));
}

/**
 * What `/model`, `/effort`, `/connect` and `/disconnect` need from the bot: the shared core, the per-thread picker
 * and pending-input state the bot also clears on teardown or reads in its text handler, and the OAuth sign-in
 * driver.
 */
export interface ModelProvidersPorts
  extends Pick<
    BotCore,
    'bot' | 'command' | 'getState' | 'replyToThread' | 'editThreadMessage' | 'deleteThreadMessage' | 'authoriseContext' | 'updatePinnedStatus' | 'wakeSleepingSession' | 'checkIsGeneral'
  > {
  awaitingModelSelection: Set<string>;
  awaitingSessionSelection: Set<string>;
  awaitingFolderName: Set<string>;
  threadModelLists: Map<string, string[]>;
  pendingProviderConnects: Map<string, PendingProviderConnect>;
  connectMethodLists: Map<string, { providerId: string; methods: OpenCodeAuthMethod[] }>;
  disconnectProviderLists: Map<string, string[]>;
  startOpenCodeOAuthLogin: (key: SessionKey, providerId: string, methodLabel: string) => Promise<void>;
  /** Where `settings.json` (the instance default effort `/effort` sets in General) lives. */
  getInstanceSettingsPath: () => string;
}

/**
 * @description Build the model, effort and provider-credential flows over their ports. It returns what the bot's
 * text handler reaches into (a pasted provider key, a numbered model pick) and the `register…()` calls, which the
 * bot makes at the positions its neighbouring commands and buttons are registered.
 */
export function createModelProviders(ports: ModelProvidersPorts) {
  const { awaitingModelSelection, awaitingSessionSelection, awaitingFolderName, threadModelLists, pendingProviderConnects, connectMethodLists, disconnectProviderLists, startOpenCodeOAuthLogin, getInstanceSettingsPath, bot, command, getState, replyToThread, editThreadMessage, deleteThreadMessage, authoriseContext, updatePinnedStatus, wakeSleepingSession, checkIsGeneral } = ports;

  const answerWithWholeText = createWholeTextAnswerer(replyToThread);

  /**
   * @description Single choke point for the four `/model`-set paths (the
   * `/model <num>` and `/model <name>` commands, the text-handler numeric pick,
   * and the `model_<id>` button callback). Drives the thread's adapter and turns
   * the outcome into a ready reply via the pure {@link getModelSetReplyDecision}.
   *
   * No session gate here: each adapter decides what "no session" means
   * (OpenCode persists the pick for the next start and succeeds; Claude refuses
   * with a notice). On success the pinned banner is refreshed best-effort.
   */
  async function applyModelSelection(
    adapter: AgentAdapter,
    key: SessionKey,
    modelId: string,
  ): Promise<{ isOk: boolean; message: string; setModelError: string | null; displayLabel: string }> {
    // A sleeping conversation is woken first (L-D4), so the pick applies to its live session
    // instead of the "start the agent first" refusal of an idle backend.
    const wakeNotice = await wakeSleepingSession(key);
    if (wakeNotice) await replyToThread(key, wakeNotice);
    const setModelError = adapter.setModel ? await adapter.setModel(key, modelId) : null;
    const displayLabel = adapter.getCurrentModel?.(key) || modelId;
    // Read AFTER the switch: a model that does not offer the level in force
    // clears it (`effort.cleared_on_model_switch`), so a pre-switch read would
    // report a level the new model no longer runs. Same resolution rule as
    // `/status` — no `getEffortState` means the backend has no effort concept at all.
    const effort = getThreadEffortView(adapter, key)?.level ?? null;
    const decision = getModelSetReplyDecision(
      {
        hasSetModel: Boolean(adapter.setModel),
        setModelError,
        isActive: adapter.checkIsActive(key),
        adapterLabel: adapter.label,
        displayLabel,
        effort,
      },
      t,
    );
    if (decision.isOk) {
      await updatePinnedStatus(key).catch(() => {});
      // The "Recently used" list is an OpenCode concept (providers to hop
      // between); a Claude alias has none. `displayLabel` is the adapter's
      // resolved `provider/model`, not whatever shorthand the user typed.
      if (adapter.name === openCodeAdapterName && displayLabel.includes('/')) {
        await getState().addRecentModel(displayLabel);
      }
    }
    return { ...decision, setModelError, displayLabel };
  }

  /**
   * @description The recently-used entries the picker may offer for `adapter`:
   * the persisted list filtered against the live catalog (a stale entry must
   * not render a button that resolves to nothing), and nothing at all for a
   * backend without providers — the Claude backends never show the row.
   */
  function getRecentModelsForPicker(adapter: AgentAdapter, catalog: ModelCatalog): string[] {
    if (adapter.name !== openCodeAdapterName) return [];
    return getRecentModelsInCatalog(getState().getRecentModels(), catalog);
  }

  function armProviderConnect(key: SessionKey, providerId: string): void {
    const keyString = keyToString(key);
    awaitingModelSelection.delete(keyString);
    awaitingSessionSelection.delete(keyString);
    awaitingFolderName.delete(keyString);
    pendingProviderConnects.set(keyString, { providerId });
  }

  async function handleProviderConnectKey(
    key: SessionKey,
    providerId: string,
    apiKey: string,
    secretMessageId: number | null,
  ): Promise<void> {
    const trimmedApiKey = apiKey.trim();
    if (!trimmedApiKey) {
      armProviderConnect(key, providerId);
      await replyToThread(key, t('connect.empty_key'));
      return;
    }
    // Reject a value that can't be a real key (spaces / non-Latin-1 / controls)
    // BEFORE storing it — otherwise a stray chat message captured by a stale
    // `/connect` state becomes a broken `Authorization` header that only fails
    // (cryptically) on the next request. An implausible value is NOT a secret, so
    // keep it visible, re-arm, and hint. (live 2026-07-20)
    if (!checkIsPlausibleProviderApiKey(trimmedApiKey)) {
      armProviderConnect(key, providerId);
      await replyToThread(key, t('connect.invalid_key'));
      return;
    }
    // A plausible key IS a single-use secret → delete it from history now.
    if (secretMessageId !== null) {
      await deleteThreadMessage(key, secretMessageId);
    }

    const adapter = getAdapter('opencode');
    if (!adapter.connectProvider) {
      await replyToThread(key, t('connect.unsupported_backend'));
      return;
    }
    const connectError = await adapter.connectProvider(key, providerId, trimmedApiKey);
    if (connectError) {
      await replyToThread(key, connectError);
      return;
    }
    await replyToThread(key, t('connect.success', { provider: providerId }));
  }

  /**
   * @description Show the `/connect <provider>` method picker: one inline button
   * per auth method from the live catalog — OAuth (subscription/account, driven
   * out-of-band via `opencode auth login` in a pty) and the API-key method (the
   * existing key-paste flow). Tapping a button fires the `connm_<idx>` callback.
   */
  async function showConnectMethodPicker(key: SessionKey, providerId: string): Promise<void> {
    const adapter = getAdapter('opencode');
    if (!adapter.fetchProviderAuthMethods) {
      await replyToThread(key, t('connect.unsupported_backend'));
      return;
    }
    let methods: OpenCodeAuthMethod[];
    try {
      methods = await adapter.fetchProviderAuthMethods(providerId);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      await replyToThread(key, t('connect.failed', { provider: providerId, reason }));
      return;
    }
    if (methods.length === 0) {
      await replyToThread(key, t('connect.no_methods', { provider: providerId }));
      return;
    }
    connectMethodLists.set(keyToString(key), { providerId, methods });
    const buttons = methods.map((m, i) =>
      Markup.button.callback(buildConnectMethodButtonLabel(m), `connm_${i}`),
    );
    await replyToThread(
      key,
      t('connect.pick_method', { provider: providerId }),
      Markup.inlineKeyboard(buttons, { columns: 1 }),
    );
  }

  /**
   * @description Apply a `/disconnect` for one provider and report the outcome.
   *
   * The adapter's `null` means a clean disconnect; a non-null string is the
   * notice to show verbatim — a failure, OR the honest caveat that the provider
   * is still active because the backend enables it from an environment variable
   * (the `openrouter` / `OPENROUTER_API_KEY` case that `DELETE /auth/:id` cannot
   * touch, and the reason `/model` also has a bot-side hide toggle).
   */
  async function applyProviderDisconnect(key: SessionKey, providerId: string): Promise<void> {
    const adapter = getProviderAuthAdapter();
    if (!adapter.disconnectProvider) {
      await replyToThread(key, t('disconnect.unsupported_backend'));
      return;
    }
    const notice = await adapter.disconnectProvider(key, providerId);
    await replyToThread(key, notice ?? t('disconnect.success', { provider: providerId }));
  }

  /**
   * @description Bare `/disconnect` → one button per currently active provider.
   * The provider list comes from OpenCode's live model catalog (a provider
   * serving no models is not connected in any useful sense) and INCLUDES hidden
   * ones — hiding is a picker preference, orthogonal to dropping credentials.
   *
   * The snapshot is stored under the SENT MESSAGE's id, so this keyboard can only
   * ever resolve against the list it actually shows.
   */
  async function showDisconnectProviderPicker(key: SessionKey): Promise<void> {
    const adapter = getProviderAuthAdapter();
    if (!adapter.disconnectProvider) {
      await replyToThread(key, t('disconnect.unsupported_backend'));
      return;
    }
    const catalog = await getModelCatalog(adapter);
    if (catalog.providers.length === 0) {
      await replyToThread(key, t('disconnect.no_providers'));
      return;
    }
    const buttons = catalog.providers.map((provider, index) =>
      Markup.button.callback(
        t('disconnect.provider_button', { provider }),
        buildDisconnectProviderCallback(index),
      ),
    );
    const messageId = await replyToThread(
      key,
      t('disconnect.pick_provider'),
      Markup.inlineKeyboard(buttons, { columns: 1 }),
    );
    // A failed send has no keyboard to resolve against — recording the snapshot
    // would only leak an entry.
    if (messageId === null) return;
    disconnectProviderLists.set(buildDisconnectPickerKey(keyToString(key), messageId), catalog.providers);
    for (const evictedKey of getEvictedDisconnectPickerKeys(disconnectProviderLists.keys())) {
      disconnectProviderLists.delete(evictedKey);
    }
  }

  /**
   * @description Read the thread backend's model list and split it for the
   * picker. Re-derived on every render (command AND callback) rather than
   * snapshotted per thread — the same self-healing approach `bind_page` takes,
   * and both adapters cache the underlying lookup.
   *
   * A backend without `getAvailableModels` (or a failing one) yields an empty
   * catalog, which the caller turns into the "set it manually" notice.
   */
  async function getModelCatalog(adapter: AgentAdapter): Promise<ModelCatalog> {
    let models: string[] = [];
    if (adapter.getAvailableModels) {
      try {
        models = await adapter.getAvailableModels();
      } catch (e) {
        console.error('[Bot] getAvailableModels:', e);
      }
    }
    // Claude reports slash-less aliases (`sonnet`, `opus`, …) — they group under
    // the adapter label, otherwise the picker would render an empty list.
    return buildModelCatalog(models, adapter.label, getState().getHiddenModelProviders());
  }

  /**
   * @description Arm the numbered-reply affordance for the page just rendered.
   * Scoped to the CURRENT PAGE: `threadModelLists` holds that page's ids in
   * button order, so a bare digit picks what the user is looking at.
   */
  function armModelPagePick(key: SessionKey, pageModels: string[]): void {
    const kStr = keyToString(key);
    threadModelLists.set(kStr, pageModels);
    awaitingModelSelection.add(kStr);
  }

  /**
   * @description Whether a bare digit in this thread is currently read as a
   * `/model` page pick. Read-only probe, exported so the "a BUTTON pick must
   * disarm the numbered affordance" rule is directly assertable in tests — an
   * armed thread silently swallows a later ordinary "3" prompt.
   */
  function checkIsNumberedModelPickArmed(key: SessionKey): boolean {
    return awaitingModelSelection.has(keyToString(key));
  }

  /** Disarm the numbered-reply affordance — the provider level shows no numbers. */
  function clearModelPagePick(key: SessionKey): void {
    const kStr = keyToString(key);
    threadModelLists.delete(kStr);
    awaitingModelSelection.delete(kStr);
  }

  /**
   * @description Resolve a numbered pick against the page the thread is currently
   * looking at, and CONSUME the bare-digit affordance. `null` when the number
   * addresses nothing on that page.
   *
   * The single resolver behind BOTH numbered entry points — `/model <n>` and the
   * plain "3" reply — so the range check and the disarm cannot drift apart. The
   * disarm is unconditional because an armed thread silently swallows a later
   * ordinary "3" prompt as a model pick instead of forwarding it to the agent;
   * `/model <n>` used to skip it entirely. The page list itself survives, so a
   * follow-up `/model 4` still resolves against the list still on screen.
   *
   * Exported so that rule is directly assertable without a Telegram surface.
   */
  function getNumberedModelPick(key: SessionKey, num: number): string | null {
    const kStr = keyToString(key);
    const pageModels = threadModelLists.get(kStr);
    awaitingModelSelection.delete(kStr);
    if (!pageModels || num < 1 || num > pageModels.length) return null;
    return pageModels[num - 1];
  }

  /**
   * @description Apply a numbered pick and reply — the shared tail of `/model <n>`
   * and the plain "3" reply. Always replies (even for an adapter that cannot set a
   * model), so both call sites can return unconditionally afterwards.
   */
  async function applyNumberedModelPick(
    adapter: AgentAdapter,
    key: SessionKey,
    num: number,
  ): Promise<void> {
    const selected = getNumberedModelPick(key, num);
    if (selected === null) {
      await replyToThread(key, t('model.invalid_number'));
      return;
    }
    const { message } = await applyModelSelection(adapter, key, selected);
    await replyToThread(key, message);
  }

  /**
   * @description Arm (or disarm) the bare-digit pick to match what the render
   * actually shows. THE single choke point: a button pick re-renders its page
   * WITHOUT numbers, and leaving `awaitingModelSelection` armed there made a
   * later ordinary "3" prompt get swallowed as a model pick instead of reaching
   * the agent.
   */
  function applyModelPagePickArming(key: SessionKey, render: ModelPickerRender): void {
    if (render.isNumberedPickArmed && render.pageModels.length > 0) {
      armModelPagePick(key, render.pageModels);
      return;
    }
    clearModelPagePick(key);
  }

  /**
   * @description Open the `/model` picker as a NEW message. Starts at the model
   * level when the catalog has a single offered provider (the Claude aliases),
   * otherwise at the provider level.
   */
  async function showModelPicker(key: SessionKey, adapter: AgentAdapter): Promise<void> {
    const current = getCurrentModelLabel(adapter, key);
    const catalog = await getModelCatalog(adapter);
    if (catalog.providers.length === 0) {
      clearModelPagePick(key);
      await replyToThread(key, t('model.none_available', { current }));
      return;
    }

    const render = checkHasProviderLevel(catalog.visibleProviders.length, catalog.hiddenProviders.length)
      ? buildModelProviderRender(catalog, current, getRecentModelsForPicker(adapter, catalog))
      // Single offered provider → the provider level is a one-button detour;
      // `providers` then holds exactly that one entry, hence index 0.
      : buildModelPageRender(catalog, 0, 0, current, { isWithNumberedList: true });
    if (!render) {
      clearModelPagePick(key);
      await replyToThread(key, t('model.none_available', { current }));
      return;
    }

    applyModelPagePickArming(key, render);
    await replyToThread(key, render.text, render.keyboard);
  }

  /** Re-render the provider level in place (after a hide/show toggle or «back»). */
  async function refreshModelProviderLevel(ctx: Context, key: SessionKey): Promise<void> {
    const adapter = getThreadAdapter(key);
    const catalog = await getModelCatalog(adapter);
    const render = buildModelProviderRender(
      catalog,
      getCurrentModelLabel(adapter, key),
      getRecentModelsForPicker(adapter, catalog),
    );
    applyModelPagePickArming(key, render);
    await editModelPickerMessage(ctx, render);
  }

  /**
   * @description Re-render the "Recently used" level in place. Falls back to the
   * provider level when the list came out empty (nothing left after the catalog
   * filter), so the message never shows a level with no buttons.
   */
  async function refreshRecentModelsLevel(ctx: Context, key: SessionKey): Promise<void> {
    const adapter = getThreadAdapter(key);
    const catalog = await getModelCatalog(adapter);
    const render = buildRecentModelsRender(
      getRecentModelsForPicker(adapter, catalog),
      getCurrentModelLabel(adapter, key),
    );
    if (!render) { await refreshModelProviderLevel(ctx, key); return; }
    applyModelPagePickArming(key, render);
    await editModelPickerMessage(ctx, render);
  }

  function registerProviderCommands(): void {
    command('connect', async (ctx, key, parsed) => {
      const { providerId, apiKey } = getConnectCommandArgs(parsed);
      if (!checkIsValidProviderId(providerId)) {
        if (apiKey !== null) await deleteThreadMessage(key, ctx.message.message_id);
        await replyToThread(key, t('connect.invalid_provider', { provider: providerId }));
        return;
      }
      // Inline API-key fast path: `/connect <provider> sk-…` connects with the key
      // directly (and deletes the secret message). No key → show the method picker
      // so the user can choose OAuth (subscription) vs API key.
      if (apiKey !== null) {
        await handleProviderConnectKey(key, providerId, apiKey, ctx.message.message_id);
        return;
      }
      await showConnectMethodPicker(key, providerId);
    });

    command('disconnect', async (_ctx, key, parsed) => {
      // No thread-adapter gate — `/connect` has none either; the unsupported-build
      // guard lives where the provider-auth adapter is resolved.
      const providerId = parsed.argsText;
      if (!providerId) {
        await showDisconnectProviderPicker(key);
        return;
      }
      await applyProviderDisconnect(key, providerId);
    });
  }

  /**
   * @description How a regular topic's effort reads against the levels its backend offers: the level its running
   * session uses (else the one its next start will), the next start's level when that differs, and what General's
   * value really is for it. OpenCode offers the model's variants only: a level it lacks runs as the nearest it has,
   * so every level shown is that one.
   */
  function getTopicEffortAmongLevels(key: SessionKey, adapter: AgentAdapter, levels: readonly string[]) {
    const instanceDefault = getEffortAmongLevels(getInstanceDefaultEffort(), levels);
    const view = getThreadEffortView(adapter, key);
    const inForce = view ? getEffortAmongLevels(view.level, levels) : instanceDefault;
    const nextStartLevel = view?.nextStartLevel ? getEffortAmongLevels(view.nextStartLevel, levels) : null;
    return { instanceDefault, inForce, nextStartLevel: nextStartLevel === inForce ? null : nextStartLevel };
  }

  /** @description The levels `adapter` offers the thread; `[]` when it offers none (or cannot say). */
  async function listTopicEffortLevels(key: SessionKey, adapter: AgentAdapter): Promise<string[]> {
    try {
      return (await adapter.getAvailableEffortLevels?.(key)) ?? [];
    } catch (e) {
      console.error('[Bot] getAvailableEffortLevels:', e);
      return [];
    }
  }

  /**
   * @description The `/effort` picker of a regular topic: the level its session uses, where the next start's level
   * comes from (its own pick or General's value), and a button per level the backend offers. `null` when the backend
   * offers none.
   */
  async function buildTopicEffortPicker(key: SessionKey, adapter: AgentAdapter): Promise<EffortPicker | null> {
    const levels = await listTopicEffortLevels(key, adapter);
    if (levels.length === 0) return null;
    return buildEffortPicker(
      {
        isGeneral: false,
        levels,
        ...getTopicEffortAmongLevels(key, adapter, levels),
        isOwnPick: (adapter.getOwnEffort?.(key) ?? null) !== null,
        canClear: Boolean(adapter.clearEffort),
      },
      t,
    );
  }

  /** @description The `/effort` picker as it stands now, for the screen of `key`; `null` when there is nothing to pick. */
  async function buildEffortPickerFor(key: SessionKey): Promise<EffortPicker | null> {
    if (checkIsGeneral(key)) {
      return buildEffortPicker({ isGeneral: true, levels: claudeEffortLevels, instanceDefault: getInstanceDefaultEffort() }, t);
    }
    return buildTopicEffortPicker(key, getThreadAdapter(key));
  }

  /**
   * @description Re-render the picker a tap came from, text and buttons: the ✓ AND the level named in the text
   * (and its source) follow the new state instead of staying on the previous one. "Message is not modified" (the
   * same tap twice) is swallowed by the shared edit helper.
   */
  async function rerenderEffortPicker(ctx: Context, key: SessionKey): Promise<void> {
    const messageId = getCallbackMessageId(ctx);
    if (messageId === null) return;
    const picker = await buildEffortPickerFor(key);
    if (!picker) return;
    await editThreadMessage(key, messageId, picker.text, buildEffortKeyboard(picker));
  }

  /**
   * @description Write the instance default effort (`settings.json`) on top of what the file already holds.
   * Returns `null` on success, else the errno code of the failed write — logged here with the file's path; the
   * caller words it for the user.
   */
  function saveInstanceDefaultEffort(level: ClaudeEffortLevel): string | null {
    const filePath = getInstanceSettingsPath();
    try {
      saveInstanceSettings(filePath, { ...loadInstanceSettingsForUpdate(filePath), defaultEffort: level });
      return null;
    } catch (e) {
      const code = getCaughtErrnoCode(e);
      console.warn(`[Settings] could not write ${filePath} (${code})`);
      return code;
    }
  }

  /** @description `/effort` in General: the picker of the instance default, or `/effort <level>` to set it. */
  async function handleGeneralEffortCommand(key: SessionKey, args: string): Promise<void> {
    if (!args) {
      const picker = await buildEffortPickerFor(key);
      if (picker) await replyToThread(key, picker.text, buildEffortKeyboard(picker));
      return;
    }
    if (!checkIsClaudeEffortLevel(args)) {
      await replyToThread(key, t('effort.invalid_level', { level: args, valid: claudeEffortLevels.join(', ') }));
      return;
    }
    const writeCode = saveInstanceDefaultEffort(args);
    await replyToThread(
      key,
      writeCode === null
        ? t('effort.general.setConfirmation', { level: args })
        : t('effort.general.writeFailedNotice', { path: getInstanceSettingsPath(), code: writeCode }),
    );
  }

  /** @description A level button in General: save it as the instance default, confirm, and re-render the picker. */
  async function handleGeneralEffortTap(ctx: Context, key: SessionKey, level: string): Promise<void> {
    if (!checkIsClaudeEffortLevel(level)) {
      await ctx.answerCbQuery(t('cb.effort_error', { error: level }));
      return;
    }
    const writeCode = saveInstanceDefaultEffort(level);
    if (writeCode !== null) {
      await answerCallbackQuerySafely(ctx, t('cb.effort_error', { error: writeCode }));
      await replyToThread(key, t('effort.general.writeFailedNotice', { path: getInstanceSettingsPath(), code: writeCode }));
      return;
    }
    await answerCallbackQuerySafely(ctx, t('cb.effort_set', { level }));
    await replyToThread(key, t('effort.general.setConfirmation', { level }));
    await rerenderEffortPicker(ctx, key);
  }

  function registerModelCommands(): void {
    command('model', async (_ctx, key, parsed) => {
      const adapter = getThreadAdapter(key);
      const args = parsed.argsText;

      // numeric selection from the last rendered page
      if (/^\d+$/.test(args)) {
        await applyNumberedModelPick(adapter, key, parseInt(args, 10));
        return;
      }

      // direct «/model provider/name» — resolves a HIDDEN provider too: hiding
      // filters the picker only and must never break an explicit pick or a saved
      // model pref.
      if (args) {
        const { message } = await applyModelSelection(adapter, key, args);
        await replyToThread(key, message);
        return;
      }

      await showModelPicker(key, adapter);
    });

    command('effort', async (_ctx, key, parsed) => {
      const args = parsed.argsText;

      // General sets the instance default, which needs no backend at all.
      if (checkIsGeneral(key)) {
        await handleGeneralEffortCommand(key, args);
        return;
      }

      const adapter = getThreadAdapter(key);

      // Backend must support the effort contract (both methods are optional).
      if (!adapter.setEffort || !adapter.getAvailableEffortLevels) {
        await replyToThread(key, t('effort.unsupported_backend', { label: adapter.label }));
        return;
      }
      // No `checkIsActive` gate — like `/model`, effort works pre-session: the
      // adapter persists the pick (OpenCode/Claude) and a later session replays it.
      // The picker lists the PROSPECTIVE model's levels; the direct-set path
      // surfaces the adapter's own notice (e.g. Claude's `effort.start_agent_first`).

      // Direct set: `/effort <level>`. The adapter validates (Claude against its
      // canonical set, OpenCode against the model's variants) and returns a
      // user-facing notice string on any non-success.
      if (args) {
        const wakeNotice = await wakeSleepingSession(key); // L-D4: apply to the woken session
        if (wakeNotice) await replyToThread(key, wakeNotice);
        const outcome = await adapter.setEffort(key, args);
        await replyToThread(key, outcome.status === 'applied' ? t('effort.set_success', { level: args }) : outcome.status === 'stored' ? outcome.notice : outcome.reason);
        // A pick the adapter stored but could not apply yet (no agent running) is a pick all the same: the banner
        // follows it. Only a refusal leaves the banner as it was.
        if (outcome.status !== 'refused') await updatePinnedStatus(key).catch(() => {});
        return;
      }

      // No arg: the level in force, where it comes from, and a button per available level.
      const picker = await buildTopicEffortPicker(key, adapter);
      if (!picker) {
        // Empty means the current model declares no variants (OpenCode) or the
        // backend reports no levels — not an error, just nothing to pick.
        await replyToThread(key, t('effort.not_available'));
        return;
      }
      await replyToThread(key, picker.text, buildEffortKeyboard(picker));
    });
  }

  function registerModelCallbacks(): void {
    /**
     * @description `/model` picker callbacks — the two-level provider → models
     * keyboard. All of them are registered BEFORE the generic `model_(.+)$`
     * handler below (which is the legacy "pick this model id" button kept for
     * back-compat) so no prefix can be mis-matched; Telegraf dispatches action
     * regexes first-match-wins, the same ordering rule `bind_page_(\d+)$` relies on.
     */

    // Provider tapped (or a page arrow) → render that provider's model page.
    bot.action(providerPageCallbackRe, async (ctx) => {
      const key = await authoriseContext(ctx);
      if (!key) { await ctx.answerCbQuery(t('cb.access_denied')); return; }
      const adapter = getThreadAdapter(key);
      const catalog = await getModelCatalog(adapter);
      const render = buildModelPageRender(
        catalog,
        Number(ctx.match[1]),
        Number(ctx.match[2]),
        getCurrentModelLabel(adapter, key),
        { isWithNumberedList: true },
      );
      if (!render) { await ctx.answerCbQuery(t('cb.model_provider_gone')); return; }
      applyModelPagePickArming(key, render);
      await editModelPickerMessage(ctx, render);
      await ctx.answerCbQuery();
    });

    // Model tapped → same apply path as `/model <name>` and the numeric reply.
    bot.action(modelPickCallbackRe, async (ctx) => {
      const key = await authoriseContext(ctx);
      if (!key) { await ctx.answerCbQuery(t('cb.access_denied')); return; }
      const adapter = getThreadAdapter(key);
      if (!adapter.setModel) {
        await ctx.answerCbQuery(t('cb.not_supported', { label: adapter.label }));
        return;
      }
      const catalog = await getModelCatalog(adapter);
      const providerIndex = Number(ctx.match[1]);
      const modelIndex = Number(ctx.match[2]);
      const provider = catalog.providers[providerIndex];
      const modelId = provider === undefined
        ? undefined
        : catalog.byProvider.get(provider)?.[modelIndex];
      if (modelId === undefined) { await ctx.answerCbQuery(t('cb.model_provider_gone')); return; }

      const { isOk, message, setModelError, displayLabel } = await applyModelSelection(adapter, key, modelId);
      if (!isOk) {
        await answerWithWholeText(ctx, key, t('cb.model_error', { error: setModelError ?? message }));
        return;
      }
      await answerCallbackQuerySafely(ctx, t('cb.model_set', { model: displayLabel.split('/').pop() || displayLabel }));

      // The pick is made, so the page's bare-digit affordance must go (an armed
      // thread swallows a later ordinary "3" prompt) — and with it the numbers in
      // the text. Re-render the SAME page so the ✓ moves to the model just picked.
      const refreshed = buildModelPageRender(
        catalog,
        providerIndex,
        Math.floor(modelIndex / modelPageSize),
        getCurrentModelLabel(adapter, key),
        { isWithNumberedList: false },
      );
      if (refreshed) {
        applyModelPagePickArming(key, refreshed);
        await editModelPickerMessage(ctx, refreshed);
      } else {
        clearModelPagePick(key);
      }
      await replyToThread(key, message);
    });

    // 🕘 Recently used → the flat cross-provider list of earlier picks.
    bot.action(recentModelsOpenCallback, async (ctx) => {
      const key = await authoriseContext(ctx);
      if (!key) { await ctx.answerCbQuery(t('cb.access_denied')); return; }
      await ctx.answerCbQuery();
      await refreshRecentModelsLevel(ctx, key);
    });

    // A recent entry tapped → the same apply path as every other pick. Resolved
    // by the identity hash the button carries, against the list AS IT IS NOW:
    // an old keyboard can name a model that moved (still applied — it is the
    // model printed on the button) or one that left the list (refused), never
    // a different one.
    bot.action(recentModelPickCallbackRe, async (ctx) => {
      const key = await authoriseContext(ctx);
      if (!key) { await ctx.answerCbQuery(t('cb.access_denied')); return; }
      const adapter = getThreadAdapter(key);
      if (!adapter.setModel) {
        await ctx.answerCbQuery(t('cb.not_supported', { label: adapter.label }));
        return;
      }
      const catalog = await getModelCatalog(adapter);
      const modelId = getRecentModelPick(
        getRecentModelsForPicker(adapter, catalog),
        { index: Number(ctx.match[1]), identity: ctx.match[2] },
      );
      if (modelId === null) { await ctx.answerCbQuery(t('cb.model_recent_gone')); return; }

      const { isOk, message, setModelError, displayLabel } = await applyModelSelection(adapter, key, modelId);
      if (!isOk) {
        await answerWithWholeText(ctx, key, t('cb.model_error', { error: setModelError ?? message }));
        return;
      }
      await answerCallbackQuerySafely(ctx, t('cb.model_set', { model: displayLabel.split('/').pop() || displayLabel }));
      // Re-render the SAME level: the pick just moved to the head and takes the ✓.
      await refreshRecentModelsLevel(ctx, key);
      await replyToThread(key, message);
    });

    // 🙈 / 👁 — the bot-side provider filter. GLOBAL for the instance and the only
    // lever that works for a provider OpenCode enables from an environment
    // variable, which `/disconnect` cannot remove.
    bot.action(providerHideCallbackRe, async (ctx) => {
      const key = await authoriseContext(ctx);
      if (!key) { await ctx.answerCbQuery(t('cb.access_denied')); return; }
      const catalog = await getModelCatalog(getThreadAdapter(key));
      const provider = catalog.providers[Number(ctx.match[1])];
      if (provider === undefined) { await ctx.answerCbQuery(t('cb.model_provider_gone')); return; }
      await getState().setModelProviderHidden(provider, true);
      await answerCallbackQuerySafely(ctx, t('cb.model_hidden', { provider }));
      await refreshModelProviderLevel(ctx, key);
    });

    bot.action(providerShowCallbackRe, async (ctx) => {
      const key = await authoriseContext(ctx);
      if (!key) { await ctx.answerCbQuery(t('cb.access_denied')); return; }
      const catalog = await getModelCatalog(getThreadAdapter(key));
      const provider = catalog.providers[Number(ctx.match[1])];
      if (provider === undefined) { await ctx.answerCbQuery(t('cb.model_provider_gone')); return; }
      await getState().setModelProviderHidden(provider, false);
      await answerCallbackQuerySafely(ctx, t('cb.model_shown', { provider }));
      await refreshModelProviderLevel(ctx, key);
    });

    // «⬅️ providers» — back to the provider level.
    bot.action(modelPickerBackCallback, async (ctx) => {
      const key = await authoriseContext(ctx);
      if (!key) { await ctx.answerCbQuery(t('cb.access_denied')); return; }
      await ctx.answerCbQuery();
      await refreshModelProviderLevel(ctx, key);
    });

    // Inert label buttons (the "2/5" page pill, a hidden provider's name).
    bot.action(modelPickerNoopCallback, async (ctx) => {
      await ctx.answerCbQuery();
    });

    // Bare-`/disconnect` picker row → drop that provider's stored credentials.
    // Resolved against the snapshot of the message the button sits on, so an older
    // picker left in the history can never map its index onto a newer list and
    // delete the wrong provider's credentials.
    bot.action(disconnectProviderCallbackRe, async (ctx) => {
      const key = await authoriseContext(ctx);
      if (!key) { await ctx.answerCbQuery(t('cb.access_denied')); return; }
      const provider = getDisconnectPickerProviderAt(
        disconnectProviderLists,
        keyToString(key),
        getCallbackMessageId(ctx),
        Number(ctx.match[1]),
      );
      if (provider === null) { await ctx.answerCbQuery(t('cb.disconnect_expired')); return; }
      await ctx.answerCbQuery();
      await applyProviderDisconnect(key, provider);
    });

    bot.action(/^model_(.+)$/, async (ctx) => {
      const key = await authoriseContext(ctx);
      if (!key) { await ctx.answerCbQuery(t('cb.access_denied')); return; }
      const modelId = ctx.match[1];
      const adapter = getThreadAdapter(key);
      // No bot-side session gate: the adapter owns the no-session decision
      // (OpenCode persists the pick for next start and succeeds; Claude refuses
      // with a notice surfaced as the error toast below).
      if (!adapter.setModel) {
        await ctx.answerCbQuery(t('cb.not_supported', { label: adapter.label }));
        return;
      }
      const { isOk, message, setModelError, displayLabel } = await applyModelSelection(adapter, key, modelId);
      if (!isOk) {
        await answerWithWholeText(ctx, key, t('cb.model_error', { error: setModelError ?? message }));
        return;
      }
      await answerCallbackQuerySafely(ctx, t('cb.model_set', { model: displayLabel.split('/').pop() || displayLabel }));
      await replyToThread(key, message);
    });

    bot.action(/^connm_(\d+)$/, async (ctx) => {
      const key = await authoriseContext(ctx);
      if (!key) { await ctx.answerCbQuery(t('cb.access_denied')); return; }
      const entry = connectMethodLists.get(keyToString(key));
      const idx = Number(ctx.match[1]);
      const method = entry?.methods[idx];
      if (!entry || !method) { await ctx.answerCbQuery(t('cb.connect_method_expired')); return; }
      await ctx.answerCbQuery();
      if (checkIsOAuthMethod(method)) {
        // OAuth (subscription/account): drive `opencode auth login` out-of-band.
        await startOpenCodeOAuthLogin(key, entry.providerId, method.label);
        return;
      }
      // API-key method: arm the existing key-paste flow (next message is the key).
      armProviderConnect(key, entry.providerId);
      await replyToThread(key, t('connect.prompt_key', { provider: entry.providerId }));
    });

    bot.action(effortLevelCallbackRe, async (ctx) => {
      const key = await authoriseContext(ctx);
      if (!key) { await ctx.answerCbQuery(t('cb.access_denied')); return; }
      const level = ctx.match[1];

      if (checkIsGeneral(key)) {
        await handleGeneralEffortTap(ctx, key, level);
        return;
      }

      const adapter = getThreadAdapter(key);
      // No `checkIsActive` gate — effort is persisted pre-session (mirrors the
      // `/effort` command and `/model`). The adapter returns its own notice when the
      // pick can't apply live; it is shown whole (see below).
      if (!adapter.setEffort) {
        await ctx.answerCbQuery(t('cb.not_supported', { label: adapter.label }));
        return;
      }
      const wakeNotice = await wakeSleepingSession(key); // L-D4: apply to the woken session
      if (wakeNotice) await replyToThread(key, wakeNotice);
      const outcome = await adapter.setEffort(key, level);
      if (outcome.status === 'refused') {
        await answerWithWholeText(ctx, key, t('cb.effort_error', { error: outcome.reason }));
        return;
      }
      if (outcome.status === 'stored') {
        // Made, but no agent is running to apply it: what follows a pick follows this one too — only the toast carries
        // the notice (whole) instead of "set".
        await answerWithWholeText(ctx, key, outcome.notice);
      } else {
        await answerCallbackQuerySafely(ctx, t('cb.effort_set', { level }));
        await replyToThread(key, t('effort.set_success', { level }));
      }
      await updatePinnedStatus(key).catch(() => {});
      await rerenderEffortPicker(ctx, key);
    });

    // «As in General»: drop the topic's own pick. Registered with the level buttons: `effortsame` has no
    // underscore, so `effortLevelCallbackRe` never takes it.
    bot.action(effortSameCallback, async (ctx) => {
      const key = await authoriseContext(ctx);
      if (!key) { await ctx.answerCbQuery(t('cb.access_denied')); return; }
      const adapter = getThreadAdapter(key);
      if (!adapter.clearEffort) {
        await ctx.answerCbQuery(t('cb.not_supported', { label: adapter.label }));
        return;
      }
      await adapter.clearEffort(key);
      const { inForce: level } = getTopicEffortAmongLevels(key, adapter, await listTopicEffortLevels(key, adapter));
      await answerCallbackQuerySafely(ctx, t('cb.effort_same', { level }));
      await replyToThread(key, t('effort.sameAsGeneralConfirmation', { level }));
      await updatePinnedStatus(key).catch(() => {});
      await rerenderEffortPicker(ctx, key);
    });
  }

  return {
    showConnectMethodPicker,
    applyProviderDisconnect,
    handleProviderConnectKey,
    applyNumberedModelPick,
    applyModelSelection,
    applyModelPagePickArming,
    checkIsNumberedModelPickArmed,
    getNumberedModelPick,
    registerProviderCommands,
    registerModelCommands,
    registerModelCallbacks,
  };
}
