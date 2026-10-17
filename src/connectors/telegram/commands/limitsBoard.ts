/**
 * `/limits` — the switch board: every signed-in Claude account and every connected OpenCode provider on one screen, each
 * with its usage or its limit, so a topic moves to another one with a single tap. A row is one full-width button; the
 * text holds only the two automatic-switching settings (their screen is `/limits_autoswitch`, `fallbackChain.ts`) and
 * the legend of the figures. A tap in a topic switches the topic through the one switch path
 * (`switchTopicByOperator`, `bot.ts`): a Claude account changes the account, an OpenCode provider opens the shared model
 * page and a model pick switches, the ✓ row opens the model page of where the topic runs; in General a Claude row sets
 * the instance default and an OpenCode row only says that a model is picked inside a topic. The old text verbs
 * (`rebuild`, `clear`, `switch`, `wait`) are handed to the `/limits_autoswitch` runner. See README.md in this folder
 * and `utils/limitsBoardPlan.ts`.
 */
import { Markup, type Context } from 'telegraf';
import type { SessionKey } from '../../../sessionKey';
import { t } from '../../../i18n';
import type { InboundCommand } from '../../../platform/inbound';
import { buildSkipArmedRetryCallbackData } from '../../../utils/autoContinueOnLimit';
import {
  formatOpenCodeModelLimitSuffix,
  listOpenCodeModelsOfProvider,
  type FallbackChainEntry,
  type FallbackDetection,
} from '../../../utils/fallbackChain';
import { formatLimitSettingState, readLimitSetting, type LimitSettingId, type LimitSettingValue } from '../../../utils/limitSettings';
import { buildLimitsBoardRows, type LimitsBoardRow } from '../../../utils/limitsBoardPlan';
import { modelPickerNoopCallback } from '../../../utils/modelPickerPlan';
import type { OperatorSwitchOutcome } from '../../../utils/operatorSwitchPlan';
import { refreshUsageWithinBudget } from '../../../utils/usageRefreshBudget';
import { buildMessageSnapshotKey, getCallbackMessageId } from './callbackMessage';
import { createWholeTextAnswerer } from './callbackToast';
import { buildModelPageButtons } from './modelPage';
import type { BotCore } from './botCore';

/** Claude account row / OpenCode provider row / model on the open page / page arrow / back to the board: each carries an INDEX into the message's snapshot. */
const boardClaudeRowCallbackRe = /^lim_c_(\d{1,3})$/;
const boardOpenCodeRowCallbackRe = /^lim_o_(\d{1,3})$/;
const boardModelPickCallbackRe = /^lim_m_(\d{1,3})$/;
const boardPageCallbackRe = /^lim_pg_(\d{1,3})$/;
const boardBackCallback = 'lim_back';

function buildClaudeRowCallback(index: number): string {
  return `lim_c_${index}`;
}

function buildOpenCodeRowCallback(index: number): string {
  return `lim_o_${index}`;
}

function buildModelPickCallback(index: number): string {
  return `lim_m_${index}`;
}

function buildPageCallback(page: number): string {
  return `lim_pg_${page}`;
}

/** Screens whose snapshot is kept (the newest); an older keyboard is refused as out of date. */
const snapshotLimit = 50;

/**
 * What the board needs from the bot: the shared core, the detection of what is signed in, where the topic runs, the
 * picks (an account the `/accounts` way, anything else through the one switch path) and the `/limits_autoswitch`
 * runner the old text verbs go to.
 */
export interface LimitsBoardPorts
  extends Pick<
    BotCore,
    'bot' | 'command' | 'getState' | 'replyToThread' | 'editThreadMessage' | 'authoriseContext' | 'withThreadLocale' | 'checkIsGeneral'
  > {
  getInstanceTimezone: () => string;
  /** Bring the usage snapshots (Claude profiles and OpenCode subscriptions) up to date; never throws. */
  refreshUsage: (options: { maxAgeMs?: number }) => Promise<void>;
  /** What is connected now: the Claude profiles with usage, the OpenCode catalog, the limit marks. */
  detectFallbackOptions: () => Promise<FallbackDetection>;
  /** The rung the topic runs on now; `null` for no agent, a shell, or an OpenCode on the server's default model. */
  getTopicPosition: (key: SessionKey) => FallbackChainEntry | null;
  /**
   * A Claude account picked the `/accounts` way (`claudeAccounts.ts`): refused when it is not signed in; in General it
   * becomes the instance default, in a topic it goes through the switch path. The line to show, or `null` when the
   * hand-over question is already in the topic.
   */
  pickClaudeAccount: (key: SessionKey, isGeneral: boolean, name: string) => Promise<string | null>;
  /** Any other pick of a topic — an OpenCode model, a Claude model — through the one switch path (`bot.ts`). */
  switchTopicByOperator: (key: SessionKey, to: FallbackChainEntry) => Promise<OperatorSwitchOutcome>;
  /** The model aliases the topic's Claude adapter offers. */
  listClaudeModels: (key: SessionKey) => Promise<string[]>;
  /** The old text verbs of `/limits` (`rebuild`, `clear`, `switch`, `wait`): the `/limits_autoswitch` runner. */
  runAutoSwitchCommand: (key: SessionKey, verb: string, value: string, usageKey: 'limits.usage') => Promise<void>;
  /** The fire time of the limit wait armed for the topic, or `null` — the board then offers «skip once». */
  getArmedLimitRetryFireAt: (key: SessionKey) => number | null;
}

/** The row a board button stands for, as the message listed it. */
type BoardRowRef = Pick<LimitsBoardRow, 'kind' | 'id'>;

/** What a message's keyboard indexes into: the board's rows, or the open model page's models. */
type BoardSnapshot =
  | { kind: 'board'; rows: BoardRowRef[] }
  | { kind: 'page'; row: BoardRowRef; models: string[] };

/** @description Build the `/limits` board over its ports: the command, its buttons. */
export function createLimitsBoard(ports: LimitsBoardPorts) {
  const {
    bot, command, getState, replyToThread, editThreadMessage, authoriseContext, withThreadLocale, checkIsGeneral,
    getInstanceTimezone, refreshUsage, detectFallbackOptions, getTopicPosition, pickClaudeAccount, switchTopicByOperator,
    listClaudeModels, runAutoSwitchCommand, getArmedLimitRetryFireAt,
  } = ports;
  const answerWithWholeText = createWholeTextAnswerer(replyToThread);

  /** Per MESSAGE, keyed by chat + message id (`buildMessageSnapshotKey`): a message id is unique only within one chat. */
  const snapshots = new Map<string, BoardSnapshot>();

  function rememberSnapshot(key: SessionKey, messageId: number, snapshot: BoardSnapshot): void {
    const snapshotKey = buildMessageSnapshotKey(key, messageId);
    snapshots.delete(snapshotKey);
    snapshots.set(snapshotKey, snapshot);
    while (snapshots.size > snapshotLimit) {
      const oldest = snapshots.keys().next().value;
      if (oldest === undefined) break;
      snapshots.delete(oldest);
    }
  }

  function getSnapshot(key: SessionKey, messageId: number | null): BoardSnapshot | undefined {
    return messageId === null ? undefined : snapshots.get(buildMessageSnapshotKey(key, messageId));
  }

  function getProgramWords(): { claude: string; openCode: string } {
    return { claude: t('fallback.backendClaude'), openCode: t('fallback.backendOpenCode') };
  }

  /** Where the topic runs; in General the default Claude account (the ✓ of the board there). */
  function getCurrentRung(key: SessionKey, isGeneral: boolean): FallbackChainEntry | null {
    return isGeneral ? { backend: 'claude', profile: getState().getClaudeProfileGlobalDefault(), model: null } : getTopicPosition(key);
  }

  /** ` (as in General)` after a topic's setting that follows General; nothing for its own value and in General. */
  function formatSourceSuffix(setting: LimitSettingValue, isGeneral: boolean): string {
    return !isGeneral && setting.override === undefined ? ` (${t('limits.sourceGeneral')})` : '';
  }

  function formatSettingsLine(key: SessionKey, isGeneral: boolean): string {
    const read = (id: LimitSettingId): LimitSettingValue => readLimitSetting(getState(), id, key, isGeneral);
    const switchSetting = read('switch');
    const waitSetting = read('wait');
    return t('limits.boardSettings', {
      switch: formatLimitSettingState(switchSetting.effective),
      switchSource: formatSourceSuffix(switchSetting, isGeneral),
      wait: formatLimitSettingState(waitSetting.effective),
      waitSource: formatSourceSuffix(waitSetting, isGeneral),
    });
  }

  /**
   * The board: the two settings' state with the link to their screen, the legend of the figures (and the ⚠️ line only
   * when a row is out of date), then one full-width button per account / provider and «skip once» while a limit wait is
   * armed for the topic.
   */
  async function buildBoard(key: SessionKey, isGeneral: boolean): Promise<{ text: string; keyboard: ReturnType<typeof Markup.inlineKeyboard>; rows: BoardRowRef[] }> {
    const detection = await detectFallbackOptions();
    const rows = buildLimitsBoardRows({
      detection,
      openCodeProviderUsage: getState().getOpenCodeProviderUsages(),
      current: getCurrentRung(key, isGeneral),
      nowMs: Date.now(),
      timezone: getInstanceTimezone(),
      words: getProgramWords(),
    });
    const settingsLine = formatSettingsLine(key, isGeneral);
    const lines = isGeneral
      ? [`${t('limits.boardGeneral')}${settingsLine}`, `${t('limits.boardGeneralHint')} ${t('limits.boardPercentHint')}`]
      : [settingsLine, t('limits.boardPercentHint')];
    if (rows.some((row) => row.isStale)) lines.push(t('limits.boardStaleHint'));
    const keyboardRows = rows.map((row, index) => [
      Markup.button.callback(row.label, row.kind === 'claude' ? buildClaudeRowCallback(index) : buildOpenCodeRowCallback(index)),
    ]);
    const armedFireAt = isGeneral ? null : getArmedLimitRetryFireAt(key);
    if (armedFireAt !== null) keyboardRows.push([Markup.button.callback(t('autoContinueLimits.skipButton'), buildSkipArmedRetryCallbackData(armedFireAt))]);
    return { text: lines.join('\n'), keyboard: Markup.inlineKeyboard(keyboardRows), rows: rows.map(({ kind, id }) => ({ kind, id })) };
  }

  /** Open the board as a fresh message; the usage is refreshed first (bounded: a slow endpoint never holds the screen). */
  async function openBoard(key: SessionKey): Promise<void> {
    await refreshUsageWithinBudget(refreshUsage);
    const board = await buildBoard(key, checkIsGeneral(key));
    const messageId = await replyToThread(key, board.text, board.keyboard);
    if (messageId !== null) rememberSnapshot(key, messageId, { kind: 'board', rows: board.rows });
  }

  /** Re-render the board IN PLACE off the cached usage (a tap never waits on the usage endpoint); best-effort. */
  async function rerenderBoard(key: SessionKey, messageId: number | null, isGeneral: boolean): Promise<void> {
    if (messageId === null) return;
    const board = await buildBoard(key, isGeneral);
    rememberSnapshot(key, messageId, { kind: 'board', rows: board.rows });
    await editThreadMessage(key, messageId, board.text, board.keyboard);
  }

  /** The model page of a row, in the message the board sits in: the models the shared renderer lists, ✓ on the topic's own. */
  async function showModelPage(key: SessionKey, messageId: number, row: BoardRowRef, models: string[], page: number): Promise<void> {
    const current = getTopicPosition(key);
    const detection = await detectFallbackOptions();
    const nowMs = Date.now();
    let currentModel: string | null = null;
    if (row.kind === 'opencode' && current?.backend === 'opencode' && current.providerId === row.id) currentModel = current.modelId;
    // A running Claude session reports its full model name (`claude-opus-4-1`); the page lists the CLI aliases.
    if (row.kind === 'claude' && current?.backend === 'claude' && current.profile === row.id && current.model !== null) {
      const running = current.model.toLowerCase();
      currentModel = models.find((alias) => running.includes(alias.toLowerCase())) ?? null;
    }
    const { rows } = buildModelPageButtons({
      provider: row.id,
      models,
      page,
      current: currentModel,
      callbacks: {
        buildPage: buildPageCallback,
        buildPick: buildModelPickCallback,
        noop: modelPickerNoopCallback,
        back: { label: t('fallback.backButton'), data: boardBackCallback },
      },
      getSuffix: row.kind === 'opencode'
        ? (modelId) => formatOpenCodeModelLimitSuffix(`${row.id}/${modelId}`, detection.openCodeLimits, getInstanceTimezone(), nowMs)
        : undefined,
    });
    rememberSnapshot(key, messageId, { kind: 'page', row, models });
    const program = row.kind === 'claude' ? t('fallback.backendClaude') : t('fallback.backendOpenCode');
    await editThreadMessage(key, messageId, t('limits.pickModel', { label: `${program} · ${row.id}` }), Markup.inlineKeyboard(rows));
  }

  /** The tap prologue: authorise, resolve the topic, run under its locale. */
  async function handleTap(ctx: Context, run: (key: SessionKey, isGeneral: boolean, messageId: number | null) => Promise<void>): Promise<void> {
    const key = await authoriseContext(ctx);
    if (!key) { await ctx.answerCbQuery(t('cb.access_denied')); return; }
    await withThreadLocale(key, () => run(key, checkIsGeneral(key), getCallbackMessageId(ctx)));
  }

  /** A tap whose message the board knows nothing about (a restart, an older screen): say so and re-render; it never acts. */
  async function answerStale(ctx: Context, key: SessionKey, messageId: number | null, isGeneral: boolean): Promise<void> {
    await ctx.answerCbQuery(t('accounts.stale'));
    await rerenderBoard(key, messageId, isGeneral);
  }

  /** The line of an outcome on the tap: the toast (whole), or no toast when the hand-over question is the answer. */
  async function answerOutcome(ctx: Context, key: SessionKey, outcome: OperatorSwitchOutcome): Promise<void> {
    if (outcome.kind === 'asked') await ctx.answerCbQuery();
    else await answerWithWholeText(ctx, key, outcome.text);
  }

  function checkIsBound(key: SessionKey): boolean {
    return getState().getBinding(key) !== null;
  }

  function registerLimitsBoardCommands(): void {
    // `/limits` — bare: the board. The old text verbs (`rebuild`, `clear`, `switch`, `wait`) still work and go to the
    // `/limits_autoswitch` runner. Not gated on a session: the default account must be pickable before any agent runs.
    command('limits', async (_ctx, key, parsed: InboundCommand) => {
      const [verb = '', value = ''] = parsed.args;
      if (verb === '') await openBoard(key);
      else await runAutoSwitchCommand(key, verb, value, 'limits.usage');
    });
  }

  function registerLimitsBoardCallbacks(): void {
    // A Claude account's row: in General the instance default; in a topic the account switch — or, on the ✓ row, the
    // model page of the account the topic runs on.
    bot.action(boardClaudeRowCallbackRe, (ctx) => handleTap(ctx, async (key, isGeneral, messageId) => {
      const snapshot = getSnapshot(key, messageId);
      const row = snapshot?.kind === 'board' ? snapshot.rows[Number(ctx.match[1])] : undefined;
      if (messageId === null || row === undefined || row.kind !== 'claude') { await answerStale(ctx, key, messageId, isGeneral); return; }
      if (!isGeneral && !checkIsBound(key)) { await answerWithWholeText(ctx, key, t('thread.bind_required')); return; }
      const current = isGeneral ? null : getTopicPosition(key);
      if (current?.backend === 'claude' && current.profile === row.id) {
        await ctx.answerCbQuery();
        await showModelPage(key, messageId, row, await listClaudeModels(key), 0);
        return;
      }
      const line = await pickClaudeAccount(key, isGeneral, row.id);
      if (line === null) await ctx.answerCbQuery();
      else await answerWithWholeText(ctx, key, line);
      await rerenderBoard(key, messageId, isGeneral);
    }));

    // An OpenCode provider's row: its model page (a provider with one model switches at once); never in General.
    bot.action(boardOpenCodeRowCallbackRe, (ctx) => handleTap(ctx, async (key, isGeneral, messageId) => {
      const snapshot = getSnapshot(key, messageId);
      const row = snapshot?.kind === 'board' ? snapshot.rows[Number(ctx.match[1])] : undefined;
      if (messageId === null || row === undefined || row.kind !== 'opencode') { await answerStale(ctx, key, messageId, isGeneral); return; }
      if (isGeneral) { await ctx.answerCbQuery(t('limits.openCodeInTopicOnly')); return; }
      if (!checkIsBound(key)) { await answerWithWholeText(ctx, key, t('thread.bind_required')); return; }
      const models = listOpenCodeModelsOfProvider((await detectFallbackOptions()).openCodeModels, row.id);
      if (models.length === 0) { await answerStale(ctx, key, messageId, isGeneral); return; }
      const current = getTopicPosition(key);
      const isHere = current?.backend === 'opencode' && current.providerId === row.id;
      if (models.length === 1 && !isHere) {
        const outcome = await switchTopicByOperator(key, { backend: 'opencode', providerId: row.id, modelId: models[0] });
        await answerOutcome(ctx, key, outcome);
        if (outcome.kind !== 'refused') await rerenderBoard(key, messageId, isGeneral);
        return;
      }
      await ctx.answerCbQuery();
      await showModelPage(key, messageId, row, models, 0);
    }));

    bot.action(boardPageCallbackRe, (ctx) => handleTap(ctx, async (key, isGeneral, messageId) => {
      const snapshot = getSnapshot(key, messageId);
      if (messageId === null || snapshot?.kind !== 'page') { await answerStale(ctx, key, messageId, isGeneral); return; }
      await ctx.answerCbQuery();
      await showModelPage(key, messageId, snapshot.row, snapshot.models, Number(ctx.match[1]));
    }));

    // A model on the open page: the switch. A refusal stays on the page; anything else returns to the board, whose ✓ moved.
    bot.action(boardModelPickCallbackRe, (ctx) => handleTap(ctx, async (key, isGeneral, messageId) => {
      const snapshot = getSnapshot(key, messageId);
      const model = snapshot?.kind === 'page' ? snapshot.models[Number(ctx.match[1])] : undefined;
      if (messageId === null || snapshot?.kind !== 'page' || model === undefined) { await answerStale(ctx, key, messageId, isGeneral); return; }
      const to: FallbackChainEntry = snapshot.row.kind === 'claude'
        ? { backend: 'claude', profile: snapshot.row.id, model }
        : { backend: 'opencode', providerId: snapshot.row.id, modelId: model };
      const outcome = await switchTopicByOperator(key, to);
      await answerOutcome(ctx, key, outcome);
      if (outcome.kind !== 'refused') await rerenderBoard(key, messageId, isGeneral);
    }));

    bot.action(boardBackCallback, (ctx) => handleTap(ctx, async (key, isGeneral, messageId) => {
      await ctx.answerCbQuery();
      await rerenderBoard(key, messageId, isGeneral);
    }));
  }

  return { registerLimitsBoardCommands, registerLimitsBoardCallbacks };
}
