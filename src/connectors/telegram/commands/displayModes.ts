/**
 * The per-topic rendering preferences — `/thinking`, `/tool_results`, `/subagent`, `/verbosity` and the view
 * row — their pickers and their buttons. A preference is never sent to the agent. See README.md in this folder.
 */
import { Markup, type Context } from 'telegraf';
import type { Message } from 'telegraf/typings/core/types/typegram';
import { getThreadAdapter } from '../../../adapters/createAdapter';
import type { DisplayVerbosityMode, ResolvedThreadDisplayPrefs, TopicView } from '../../../types';
import type { SessionKey } from '../../../sessionKey';
import { getTelegramChatId } from '../sessionKeyCodec';
import { OpenCodeAdapter } from '../../../adapters/openCodeAdapter';
import { enqueueSend } from '../../../rateLimiter';
import { t } from '../../../i18n';
import { checkIsApiError, getErrorDescription } from '../../../sendErrorClassifier';
import { displayVerbosityModeOptions, normalizeDisplayVerbosityMode } from '../../../utils/displayVerbosity';
import { getUniformVerbosityLevel } from '../../../utils/verbosityRender';
import {
  topicViewOptions,
  checkAreRequestsEnabled,
  parseTopicView,
  topicViewArguments,
} from '../../../utils/topicView';
import type { BotCore } from './botCore';

// ── /thinking — per-topic chain-of-thought verbosity (both backends, S5) ─────

/**
 * @description Build a display-mode picker keyboard shared by ALL FOUR mode
 * commands (`/thinking`, `/tool_results`, `/subagent`, `/verbosity`): one
 * callback button per unified mode, the `marked` mode (if any) carrying a `✓`.
 * The four families differ only in their i18n label namespace and callback
 * prefix, so one builder removes the four near-identical copies (S2 review
 * note). `marked` is nullable for `/verbosity`'s mixed ("custom") state, where
 * no single level matches — then no button is marked.
 *
 * @param i18nGroup the mode-label namespace (`thinking`/`toolResults`/`subagent`/`verbosity`).
 * @param callbackPrefix the action prefix (`think`/`toolres`/`subag`/`verb`).
 * @param marked the mode to mark with `✓`, or null for no mark.
 */
function buildDisplayModeKeyboard(
  i18nGroup: string,
  callbackPrefix: string,
  marked: DisplayVerbosityMode | null,
) {
  return Markup.inlineKeyboard(buildDisplayModeButtons(i18nGroup, callbackPrefix, marked), { columns: displayVerbosityModeOptions.length });
}

/** One button per display-verbosity mode (`<callbackPrefix>_<mode>`), `✓` on `marked` — the row every mode picker shares. */
function buildDisplayModeButtons(i18nGroup: string, callbackPrefix: string, marked: DisplayVerbosityMode | null) {
  return displayVerbosityModeOptions.map((mode) =>
    Markup.button.callback(
      mode === marked ? `${t(`${i18nGroup}.mode.${mode}`)} ✓` : t(`${i18nGroup}.mode.${mode}`),
      `${callbackPrefix}_${mode}`,
    ),
  );
}

// ── /verbosity — per-topic macro over ALL THREE display prefs ───────────────
// Sets thinking + toolResults + subagent to one level at once; the individual
// commands keep point-overriding afterwards (they all write the same store,
// last write per pref wins — no extra mechanism). Like /subagent there is no
// backend or session gate: the prefs are bot-side rendering state, valid on
// both backends and with no session running.

/**
 * @description Render the picker's "current state" fragment: the shared mode
 * label when all three prefs agree, else the i18n'd "custom" line spelling
 * out each pref so the user sees WHAT is mixed.
 */
function formatVerbosityCurrent(prefs: ResolvedThreadDisplayPrefs): string {
  const matched = getUniformVerbosityLevel(prefs);
  if (matched) return t(`verbosity.mode.${matched}`);
  return t('verbosity.custom', {
    thinking: t(`verbosity.mode.${prefs.thinking}`),
    toolResults: t(`verbosity.mode.${prefs.toolResults}`),
    subagent: t(`verbosity.mode.${prefs.subagent}`),
  });
}

/** The localized name of a view (`verbosity.view.*`). */
export function formatTopicView(view: TopicView): string {
  return t(`verbosity.view.${view}`);
}

/**
 * @description The `/verbosity` picker: row 1 is the shared detail row
 * (`verb_<mode>`, ✓ on an exact match only — see {@link formatVerbosityCurrent}),
 * row 2 the view row (`view_<view>`, ✓ on the topic's view). One builder for the
 * command and both callback re-renders, so the two rows never drift.
 */
function buildVerbosityKeyboard(prefs: ResolvedThreadDisplayPrefs) {
  const detailRow = buildDisplayModeButtons('verbosity', 'verb', getUniformVerbosityLevel(prefs));
  const viewRow = topicViewOptions.map((view) =>
    Markup.button.callback(view === prefs.view ? `${formatTopicView(view)} ✓` : formatTopicView(view), `view_${view}`),
  );
  return Markup.inlineKeyboard([detailRow, viewRow]);
}

/**
 * @description Per-family config for the ONE shared display-mode callback
 * handler ({@link handleDisplayModeCallback}). The four mode-button callbacks
 * (`think_`/`toolres_`/`subag_`/`verb_`) differ only in these fields, so the
 * handler is written once (S2 review note — was four near-identical copies).
 */
interface DisplayModeCallbackConfig {
  /** i18n mode-label namespace (`thinking`/`toolResults`/`subagent`/`verbosity`). */
  i18nGroup: string;
  /** Action prefix used for the re-rendered keyboard's callbacks. */
  callbackPrefix: string;
  /** `true` to gate the callback to OpenCode-bound topics. All four families
   * drive both backends now (S5 un-gated `/thinking`), so this is `false` for
   * every config — kept as a field for the rare future per-backend display pref. */
  isOpenCodeOnly: boolean;
  /** Persist the picked mode (the per-command apply helper). */
  apply: (key: SessionKey, mode: DisplayVerbosityMode) => Promise<void>;
  /** cb-query i18n key for the bad-mode answer. */
  errorCbKey: string;
  /** cb-query i18n key for the success answer. */
  setCbKey: string;
  /** Short tag for the keyboard-re-render warning log. */
  logTag: string;
  /**
   * The picker to re-render after the pick; defaults to the shared one-row
   * keyboard. `/verbosity` renders its two rows (detail + view, S6) instead.
   */
  buildKeyboard?: (key: SessionKey) => ReturnType<typeof buildDisplayModeKeyboard>;
}

/**
 * What the display-mode commands need from the bot.
 */
export type DisplayModesPorts = Pick<
  BotCore,
  'bot' | 'command' | 'getState' | 'replyToThread' | 'authoriseContext' | 'cancelConversationRequest'
>;

export function createDisplayModes(ports: DisplayModesPorts) {
  const { bot, command, getState, replyToThread, authoriseContext, cancelConversationRequest } = ports;

  /**
   * @description Persist a new thinking mode for `key` and apply it best-effort to
   * the live reasoning stream (it always governs the NEXT one). Shared by the
   * `/thinking <mode>` direct form and the `think_<mode>` callback so the two
   * paths can never diverge.
   */
  async function applyThinkingMode(key: SessionKey, mode: DisplayVerbosityMode): Promise<void> {
    await getState().setDisplayPref(key, 'thinking', mode);
  }

  // ── /tool_results — per-topic tool-output verbosity (OpenCode only, S3) ──────
  // Telegram bot commands cannot contain '-', so the plan's "/tool-results" is
  // registered as `tool_results` (same convention as /rename_session).

  /**
   * @description Persist a new tool-results mode for `key` — it governs every
   * `toolResult` event from now on (the mode is resolved per event, so a live
   * turn picks it up immediately). Shared by the `/tool_results <mode>` direct
   * form and the `toolres_<mode>` callback so the two paths can never diverge.
   */
  async function applyToolResultMode(key: SessionKey, mode: DisplayVerbosityMode): Promise<void> {
    await getState().setDisplayPref(key, 'toolResults', mode);
  }

  // ── /subagent — per-topic sub-agent transcript verbosity (both backends) ────
  // `minimal` and `short` are equivalent here (v1): both are status-only — the
  // user always wants the "working" indicator visible (locked decision), so no
  // mode ever hides it. Unlike /thinking and /tool_results (OpenCode-only
  // render prefs), the pref is backend-agnostic: OpenCode branches its
  // child-session SSE parts on it, Claude tails the on-disk sub-agent
  // transcripts in `full` mode (plan 2026-06-11 S2/S3).

  /**
   * @description Persist a new sub-agent mode for `key` — the adapter reads it
   * per child event (the injected reader), so a delegation already streaming
   * picks the change up immediately. Shared by the `/subagent <mode>` direct
   * form and the `subag_<mode>` callback so the two paths can never diverge.
   */
  async function applySubagentMode(key: SessionKey, mode: DisplayVerbosityMode): Promise<void> {
    await getState().setDisplayPref(key, 'subagent', mode);
  }

  /**
   * @description Apply ONE level to all three display prefs (the `/verbosity`
   * macro). Reuses the per-command apply helpers so the macro and the point
   * commands can never write through different paths.
   */
  async function applyVerbosityLevel(key: SessionKey, mode: DisplayVerbosityMode): Promise<void> {
    await applyThinkingMode(key, mode);
    await applyToolResultMode(key, mode);
    await applySubagentMode(key, mode);
  }

  /**
   * @description Persist the topic's view (request/answer plan S6). It applies
   * from the next message: nothing in flight is re-rendered. Switching to the
   * full stream turns requests off for the topic, so its open request closes
   * silently — nothing wakes it and no alert follows. Shared by the typed form
   * and the `view_<view>` picker button so the two paths can never diverge.
   */
  async function applyTopicView(key: SessionKey, view: TopicView): Promise<void> {
    await getState().setDisplayPref(key, 'view', view);
    if (!checkAreRequestsEnabled(view)) cancelConversationRequest(key);
  }

  /**
   * @description Re-render a picker message's inline keyboard after a button
   * press so its ✓ follows the new state (mirrors effort_cb). "Message is not
   * modified" is the no-change case, not a failure; anything else is logged.
   */
  async function rerenderPickerKeyboard(
    ctx: Context,
    key: SessionKey,
    keyboard: ReturnType<typeof buildDisplayModeKeyboard>,
    logTag: string,
  ): Promise<void> {
    const cbMsg = ctx.callbackQuery?.message as Message | undefined;
    if (!cbMsg) return;
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
        console.warn(`[${logTag}] keyboard re-render failed:`, desc || e);
      }
    }
  }

  /**
   * @description Shared handler for a display-mode button press. Authorises,
   * optionally gates to OpenCode (no family does today; see {@link
   * DisplayModeCallbackConfig.isOpenCodeOnly}), normalizes the picked mode
   * (legacy names on stale buttons keep working), persists it, answers the
   * callback, and re-renders the picker so the `✓` follows the new mode. The
   * re-render always marks `picked` because a single button press sets exactly
   * that mode (for `/verbosity` all three prefs then equal it, so there is always
   * an exact match).
   */
  async function handleDisplayModeCallback(
    ctx: Context & { match: RegExpExecArray },
    config: DisplayModeCallbackConfig,
  ): Promise<void> {
    const key = await authoriseContext(ctx);
    if (!key) { await ctx.answerCbQuery(t('cb.access_denied')); return; }
    // Optional OpenCode-only gate (no family uses it today — see
    // `DisplayModeCallbackConfig.isOpenCodeOnly`): a stale button on a topic
    // switched to Claude after the picker was shown must not silently set an
    // unused pref.
    if (config.isOpenCodeOnly && !(getThreadAdapter(key) instanceof OpenCodeAdapter)) {
      await ctx.answerCbQuery(t('cb.not_supported', { label: getThreadAdapter(key).label }));
      return;
    }
    // Normalize BEFORE validating: picker messages posted before the vocabulary
    // was unified still carry old mode names (`think_detailed`, `subag_compact`,
    // `toolres_hide`) in their buttons — those must keep working.
    const picked = normalizeDisplayVerbosityMode(ctx.match[1]);
    if (!picked) {
      await ctx.answerCbQuery(t(config.errorCbKey, { error: ctx.match[1].slice(0, 50) }));
      return;
    }
    await config.apply(key, picked);
    await ctx.answerCbQuery(t(config.setCbKey, { mode: t(`${config.i18nGroup}.mode.${picked}`) }));

    const keyboard = config.buildKeyboard
      ? config.buildKeyboard(key)
      : buildDisplayModeKeyboard(config.i18nGroup, config.callbackPrefix, picked);
    await rerenderPickerKeyboard(ctx, key, keyboard, config.logTag);
  }

  function registerDisplayModeCommands(): void {
    command('thinking', async (_ctx, key, parsed) => {
      // No backend gate (un-gated in S5): the pref drives both backends now —
      // OpenCode's thinking SSE render and Claude's scrape-chunk relay routing.
      const arg = parsed.argsText.toLowerCase();
      const current = getState().getDisplayPrefs(key).thinking;

      if (arg) {
        // Normalization keeps retired names (`detailed`/`brief`/`hide`) working as
        // hidden aliases; the reply always names the NEW mode.
        const mode = normalizeDisplayVerbosityMode(arg);
        if (!mode) {
          await replyToThread(key, t('thinking.invalid_mode', {
            mode: arg,
            valid: displayVerbosityModeOptions.join(', '),
          }));
          return;
        }
        await applyThinkingMode(key, mode);
        await replyToThread(key, t('thinking.set_success', { mode: t(`thinking.mode.${mode}`) }));
        return;
      }

      // No arg: show current mode + a button per mode.
      await replyToThread(
        key,
        t('thinking.choose', { current: t(`thinking.mode.${current}`) }),
        buildDisplayModeKeyboard('thinking', 'think', current),
      );
    });

    command('tool_results', async (_ctx, key, parsed) => {
      // No backend gate (un-gated in S4): the pref drives both backends now —
      // OpenCode's `toolResult` SSE render and Claude's scrape-chunk relay routing.
      const arg = parsed.argsText.toLowerCase();
      const current = getState().getDisplayPrefs(key).toolResults;

      if (arg) {
        // Normalization keeps the retired `hide` name working as a hidden alias;
        // the reply always names the NEW mode.
        const mode = normalizeDisplayVerbosityMode(arg);
        if (!mode) {
          await replyToThread(key, t('toolResults.invalid_mode', {
            mode: arg,
            valid: displayVerbosityModeOptions.join(', '),
          }));
          return;
        }
        await applyToolResultMode(key, mode);
        await replyToThread(key, t('toolResults.set_success', { mode: t(`toolResults.mode.${mode}`) }));
        return;
      }

      // No arg: show current mode + a button per mode.
      await replyToThread(
        key,
        t('toolResults.choose', { current: t(`toolResults.mode.${current}`) }),
        buildDisplayModeKeyboard('toolResults', 'toolres', current),
      );
    });

    command('subagent', async (_ctx, key, parsed) => {
      const arg = parsed.argsText.toLowerCase();
      const current = getState().getDisplayPrefs(key).subagent;

      if (arg) {
        // Normalization keeps the retired `compact` name working as a hidden
        // alias (→ `short`); the reply always names the NEW mode.
        const mode = normalizeDisplayVerbosityMode(arg);
        if (!mode) {
          await replyToThread(key, t('subagent.invalid_mode', {
            mode: arg,
            valid: displayVerbosityModeOptions.join(', '),
          }));
          return;
        }
        await applySubagentMode(key, mode);
        await replyToThread(key, t('subagent.set_success', { mode: t(`subagent.mode.${mode}`) }));
        return;
      }

      // No arg: show current mode + a button per mode.
      await replyToThread(
        key,
        t('subagent.choose', { current: t(`subagent.mode.${current}`) }),
        buildDisplayModeKeyboard('subagent', 'subag', current),
      );
    });

    command('verbosity', async (_ctx, key, parsed) => {
      const arg = parsed.argsText.toLowerCase();

      if (arg) {
        // Normalization keeps the retired names (`detailed`/`brief`/`hide`/
        // `compact`) working as hidden aliases; the reply always names the NEW mode.
        const mode = normalizeDisplayVerbosityMode(arg);
        if (mode) {
          await applyVerbosityLevel(key, mode);
          await replyToThread(key, t('verbosity.set_success', { mode: t(`verbosity.mode.${mode}`) }));
          return;
        }
        // Not a level: the view vocabulary (`stream|stream_answers|answers`, S6).
        const view = parseTopicView(arg);
        if (!view) {
          await replyToThread(key, t('verbosity.invalid_mode', {
            mode: arg,
            valid: displayVerbosityModeOptions.join(', '),
            views: topicViewOptions.map((option) => topicViewArguments[option]).join(', '),
          }));
          return;
        }
        await applyTopicView(key, view);
        await replyToThread(key, t('verbosity.view_set_success', { view: formatTopicView(view) }));
        return;
      }

      // No arg: show the current state (exact level, or "custom" with the three
      // values spelled out, plus the view) + the two button rows.
      const prefs = getState().getDisplayPrefs(key);
      await replyToThread(
        key,
        t('verbosity.choose', { current: formatVerbosityCurrent(prefs), view: formatTopicView(prefs.view) }),
        buildVerbosityKeyboard(prefs),
      );
    });
  }

  function registerDisplayModeCallbacks(): void {
    // All four mode callbacks drive both backends (S5 un-gated /thinking). Each is a
    // one-line delegation to the shared handler above.
    bot.action(/^think_(.+)$/, (ctx) => handleDisplayModeCallback(ctx, {
      i18nGroup: 'thinking', callbackPrefix: 'think', isOpenCodeOnly: false,
      apply: applyThinkingMode, errorCbKey: 'cb.thinking_error', setCbKey: 'cb.thinking_set', logTag: 'think_cb',
    }));

    bot.action(/^toolres_(.+)$/, (ctx) => handleDisplayModeCallback(ctx, {
      i18nGroup: 'toolResults', callbackPrefix: 'toolres', isOpenCodeOnly: false,
      apply: applyToolResultMode, errorCbKey: 'cb.toolresults_error', setCbKey: 'cb.toolresults_set', logTag: 'toolres_cb',
    }));

    bot.action(/^subag_(.+)$/, (ctx) => handleDisplayModeCallback(ctx, {
      i18nGroup: 'subagent', callbackPrefix: 'subag', isOpenCodeOnly: false,
      apply: applySubagentMode, errorCbKey: 'cb.subagent_error', setCbKey: 'cb.subagent_set', logTag: 'subag_cb',
    }));

    bot.action(/^verb_(.+)$/, (ctx) => handleDisplayModeCallback(ctx, {
      i18nGroup: 'verbosity', callbackPrefix: 'verb', isOpenCodeOnly: false,
      apply: applyVerbosityLevel, errorCbKey: 'cb.verbosity_error', setCbKey: 'cb.verbosity_set', logTag: 'verb_cb',
      // The level was just applied to all three prefs; the view row reads the store.
      buildKeyboard: (key) => buildVerbosityKeyboard(getState().getDisplayPrefs(key)),
    }));

    // The `/verbosity` picker's second row (S6): the topic's view. Same shape as the
    // level callbacks — authorise, validate the payload, persist, answer, re-render.
    bot.action(/^view_(.+)$/, async (ctx) => {
      const key = await authoriseContext(ctx);
      if (!key) { await ctx.answerCbQuery(t('cb.access_denied')); return; }
      const picked = parseTopicView(ctx.match[1]);
      if (!picked) {
        await ctx.answerCbQuery(t('cb.verbosity_error', { error: ctx.match[1].slice(0, 50) }));
        return;
      }
      await applyTopicView(key, picked);
      await ctx.answerCbQuery(t('cb.view_set', { view: formatTopicView(picked) }));
      await rerenderPickerKeyboard(ctx, key, buildVerbosityKeyboard(getState().getDisplayPrefs(key)), 'view_cb');
    });
  }

  return { registerDisplayModeCommands, registerDisplayModeCallbacks };
}
