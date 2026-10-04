/**
 * `/model`, `/effort`, `/connect` and `/disconnect` — the provider → models picker, the effort picker and the
 * provider credential flows — with their buttons. See README.md in this folder.
 */
import { Markup, type Context } from 'telegraf';
import type { Message } from 'telegraf/typings/core/types/typegram';
import { getAdapter, getThreadAdapter } from '../../../adapters/createAdapter';
import type { AgentAdapter } from '../../../types';
import type { SessionKey } from '../../../sessionKey';
import { keyToString } from '../../../sessionKey';
import { getTelegramChatId } from '../sessionKeyCodec';
import { checkIsValidProviderId } from '../../../adapters/openCodeAdapter';
import { enqueueSend } from '../../../rateLimiter';
import { t } from '../../../i18n';
import { paginateList } from '../../../utils/paginateList';
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
  buildDisconnectProviderCallback,
  buildDisconnectPickerKey,
  getEvictedDisconnectPickerKeys,
  disconnectProviderCallbackRe,
  getDisconnectPickerProviderAt,
} from '../../../utils/providerDisconnectPlan';
import type { InboundCommand } from '../../../platform/inbound';
import { checkIsApiError, getErrorDescription } from '../../../sendErrorClassifier';
import { getModelSetReplyDecision } from '../../../utils/modelSetReplyDecision';
import { defaultEffortLevel } from '../../../effortLevels';
import {
  type OpenCodeAuthMethod,
  checkIsPlausibleProviderApiKey,
  buildConnectMethodButtonLabel,
  checkIsOAuthMethod,
} from '../../../utils/openCodeAuthLogin';
import { getCallbackMessageId } from './callbackMessage';
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

/**
 * @description Models per page in the `/model` model level. Model names are
 * long, so each gets a full-width row; 10 rows keep the keyboard scroll-free
 * and the numbered text list ~10 short lines — far from Telegram's 4096-char
 * message cap, which the old render-everything list blew past (12 990 chars on
 * a 367-model `openrouter` catalog → every `/model` died with "message is too
 * long" and the topic went silent).
 */
const MODEL_PAGE_SIZE = 10;

/** Model label the thread currently runs, or the localized "default" stand-in. */
function getCurrentModelLabel(adapter: AgentAdapter, key: SessionKey): string {
  return adapter.getCurrentModel?.(key) || t('model.current_default');
}

/**
 * @description Provider level: one row per provider, each with a 🙈 button that
 * hides it from the picker. Hidden providers follow in their own section with a
 * 👁 button to bring them back — the only way back, so they must always render.
 */
function buildModelProviderKeyboard(catalog: ModelCatalog) {
  const hiddenProviderSet = new Set(catalog.hiddenProviders);
  const visibleRows: ReturnType<typeof Markup.button.callback>[][] = [];
  const hiddenRows: ReturnType<typeof Markup.button.callback>[][] = [];
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
 */
export function buildModelProviderRender(catalog: ModelCatalog, current: string): ModelPickerRender {
  return {
    text: buildModelProviderText(catalog, current),
    keyboard: buildModelProviderKeyboard(catalog),
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
  const { slice, currentPage, totalPages } = paginateList(providerModels, page, MODEL_PAGE_SIZE);
  const firstIndexOnPage = currentPage * MODEL_PAGE_SIZE;

  const rows = slice.map((modelId, offset) => {
    const shortLabel = getModelShortLabel(modelId, provider);
    return [
      Markup.button.callback(
        modelId === current ? `${shortLabel} ✓` : shortLabel,
        buildModelPickCallback(providerIndex, firstIndexOnPage + offset),
      ),
    ];
  });

  if (totalPages > 1) {
    const nav = [];
    if (currentPage > 0) {
      nav.push(Markup.button.callback(
        t('model.prev_button'),
        buildProviderPageCallback(providerIndex, currentPage - 1),
      ));
    }
    nav.push(Markup.button.callback(
      t('model.page_button', { page: currentPage + 1, totalPages }),
      modelPickerNoopCallback,
    ));
    if (currentPage < totalPages - 1) {
      nav.push(Markup.button.callback(
        t('model.next_button'),
        buildProviderPageCallback(providerIndex, currentPage + 1),
      ));
    }
    rows.push(nav);
  }
  // No back row when the provider level was skipped — it would lead nowhere.
  if (checkHasProviderLevel(catalog.visibleProviders.length, catalog.hiddenProviders.length)) {
    rows.push([Markup.button.callback(t('model.back_button'), modelPickerBackCallback)]);
  }

  const header = t('model.page_header', {
    provider,
    count: providerModels.length,
    page: currentPage + 1,
    totalPages,
    current,
  });
  const numberedList = options.isWithNumberedList
    ? slice.map((modelId, offset) => `${offset + 1}. ${getModelShortLabel(modelId, provider)}`).join('\n')
    : '';
  const hint = options.isWithNumberedList ? t('model.page_hint') : t('model.page_hint_buttons_only');
  const text = [header, numberedList, hint].filter((part) => part.length > 0).join('\n\n');

  return {
    text,
    keyboard: Markup.inlineKeyboard(rows),
    pageModels: slice,
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

/**
 * @description Build the `/effort` level picker keyboard.
 *
 * One callback button per available reasoning-effort level (3 per row);
 * the level matching `current` carries a `✓` marker. Shared by the
 * `/effort` command (initial render) and the `effort_<level>` callback
 * (re-render after a press) so the marker can never drift between the two.
 */
function buildEffortKeyboard(levels: readonly string[], current: string | null) {
  const buttons = levels.map((l) =>
    Markup.button.callback(l === current ? `${l} ✓` : l, `effort_${l}`),
  );
  return Markup.inlineKeyboard(buttons, { columns: 3 });
}

/**
 * What `/model`, `/effort`, `/connect` and `/disconnect` need from the bot: the shared core, the per-thread picker
 * and pending-input state the bot also clears on teardown or reads in its text handler, and the OAuth sign-in
 * driver.
 */
export interface ModelProvidersPorts
  extends Pick<
    BotCore,
    'bot' | 'command' | 'getState' | 'replyToThread' | 'deleteThreadMessage' | 'authoriseContext' | 'updatePinnedStatus'
  > {
  awaitingModelSelection: Set<string>;
  awaitingSessionSelection: Set<string>;
  awaitingFolderName: Set<string>;
  threadModelLists: Map<string, string[]>;
  pendingProviderConnects: Map<string, PendingProviderConnect>;
  connectMethodLists: Map<string, { providerId: string; methods: OpenCodeAuthMethod[] }>;
  disconnectProviderLists: Map<string, string[]>;
  startOpenCodeOAuthLogin: (key: SessionKey, providerId: string, methodLabel: string) => Promise<void>;
}

/**
 * @description Build the model, effort and provider-credential flows over their ports. It returns what the bot's
 * text handler reaches into (a pasted provider key, a numbered model pick) and the `register…()` calls, which the
 * bot makes at the positions its neighbouring commands and buttons are registered.
 */
export function createModelProviders(ports: ModelProvidersPorts) {
  const { awaitingModelSelection, awaitingSessionSelection, awaitingFolderName, threadModelLists, pendingProviderConnects, connectMethodLists, disconnectProviderLists, startOpenCodeOAuthLogin, bot, command, getState, replyToThread, deleteThreadMessage, authoriseContext, updatePinnedStatus } = ports;

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
    const setModelError = adapter.setModel ? await adapter.setModel(key, modelId) : null;
    const displayLabel = adapter.getCurrentModel?.(key) || modelId;
    // Read AFTER the switch: a model that does not offer the level in force
    // clears it (`effort.cleared_on_model_switch`), so a pre-switch read would
    // report a level the new model no longer runs. Same resolution rule as
    // `/status` — no `getEffort` means the backend has no effort concept at all.
    const effort = adapter.getEffort ? (adapter.getEffort(key) ?? defaultEffortLevel) : null;
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
    if (decision.isOk) await updatePinnedStatus(key).catch(() => {});
    return { ...decision, setModelError, displayLabel };
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
      ? buildModelProviderRender(catalog, current)
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
    const render = buildModelProviderRender(catalog, getCurrentModelLabel(adapter, key));
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
      const adapter = getThreadAdapter(key);
      const args = parsed.argsText;

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
        const err = await adapter.setEffort(key, args);
        if (err) {
          await replyToThread(key, err);
        } else {
          await replyToThread(key, t('effort.set_success', { level: args }));
          await updatePinnedStatus(key).catch(() => {});
        }
        return;
      }

      // No arg: show current effort + a button per available level.
      let levels: string[] = [];
      try {
        levels = await adapter.getAvailableEffortLevels(key);
      } catch (e) {
        console.error('[Bot] getAvailableEffortLevels:', e);
      }
      if (levels.length === 0) {
        // Empty means the current model declares no variants (OpenCode) or the
        // backend reports no levels — not an error, just nothing to pick.
        await replyToThread(key, t('effort.not_available'));
        return;
      }
      const cur = adapter.getEffort?.(key) ?? null;
      await replyToThread(
        key,
        t('effort.choose', { current: cur ?? t('effort.current_none') }),
        buildEffortKeyboard(levels, cur),
      );
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
        await ctx.answerCbQuery(t('cb.model_error', { error: (setModelError ?? message).slice(0, 50) }));
        return;
      }
      await ctx.answerCbQuery(t('cb.model_set', { model: displayLabel.split('/').pop() || displayLabel }));

      // The pick is made, so the page's bare-digit affordance must go (an armed
      // thread swallows a later ordinary "3" prompt) — and with it the numbers in
      // the text. Re-render the SAME page so the ✓ moves to the model just picked.
      const refreshed = buildModelPageRender(
        catalog,
        providerIndex,
        Math.floor(modelIndex / MODEL_PAGE_SIZE),
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
      await ctx.answerCbQuery(t('cb.model_hidden', { provider }));
      await refreshModelProviderLevel(ctx, key);
    });

    bot.action(providerShowCallbackRe, async (ctx) => {
      const key = await authoriseContext(ctx);
      if (!key) { await ctx.answerCbQuery(t('cb.access_denied')); return; }
      const catalog = await getModelCatalog(getThreadAdapter(key));
      const provider = catalog.providers[Number(ctx.match[1])];
      if (provider === undefined) { await ctx.answerCbQuery(t('cb.model_provider_gone')); return; }
      await getState().setModelProviderHidden(provider, false);
      await ctx.answerCbQuery(t('cb.model_shown', { provider }));
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
        await ctx.answerCbQuery(t('cb.model_error', { error: (setModelError ?? message).slice(0, 50) }));
        return;
      }
      await ctx.answerCbQuery(t('cb.model_set', { model: displayLabel.split('/').pop() || displayLabel }));
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

    bot.action(/^effort_(.+)$/, async (ctx) => {
      const key = await authoriseContext(ctx);
      if (!key) { await ctx.answerCbQuery(t('cb.access_denied')); return; }
      const level = ctx.match[1];
      const adapter = getThreadAdapter(key);
      // No `checkIsActive` gate — effort is persisted pre-session (mirrors the
      // `/effort` command and `/model`). The adapter returns its own notice if the
      // pick can't apply live; we surface it via `cb.effort_error` below.
      if (!adapter.setEffort) {
        await ctx.answerCbQuery(t('cb.not_supported', { label: adapter.label }));
        return;
      }
      const err = await adapter.setEffort(key, level);
      if (err) { await ctx.answerCbQuery(t('cb.effort_error', { error: err.slice(0, 50) })); return; }
      await ctx.answerCbQuery(t('cb.effort_set', { level }));
      await replyToThread(key, t('effort.set_success', { level }));
      await updatePinnedStatus(key).catch(() => {});

      // Re-render the picker so the `✓` marker follows the new level instead of
      // staying stuck on the previously-selected one (B12). The current level is
      // the freshly-set one; fall back to `level` if the adapter can't report it.
      const cbMsg = ctx.callbackQuery?.message as Message | undefined;
      if (cbMsg && adapter.getAvailableEffortLevels) {
        let levels: string[] = [];
        try {
          levels = await adapter.getAvailableEffortLevels(key);
        } catch (e) {
          console.error('[effort_cb] getAvailableEffortLevels:', e);
        }
        if (levels.length > 0) {
          const cur = adapter.getEffort?.(key) ?? level;
          const keyboard = buildEffortKeyboard(levels, cur);
          try {
            await enqueueSend(
              key,
              () => bot.telegram.editMessageReplyMarkup(
                getTelegramChatId(key), cbMsg.message_id, undefined, keyboard.reply_markup,
              ),
            );
          } catch (e) {
            const desc = checkIsApiError(e) ? getErrorDescription(e) : '';
            if (!/message is not modified/i.test(desc)) {
              console.warn('[effort_cb] keyboard re-render failed:', desc || e);
            }
          }
        }
      }
    });
  }

  return {
    handleProviderConnectKey,
    applyNumberedModelPick,
    applyModelPagePickArming,
    checkIsNumberedModelPickArmed,
    getNumberedModelPick,
    registerProviderCommands,
    registerModelCommands,
    registerModelCallbacks,
  };
}
