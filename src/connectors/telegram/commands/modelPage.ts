/**
 * The model page — one provider's models as a paginated list of full-width buttons — shared by every screen that
 * lets the operator pick a model: `/model`, the «add a fallback model» step of `/limits_autoswitch`, and the
 * provider pages of `/limits` and `/accounts`. The page only draws buttons; WHAT a tap does is the screen's:
 * it hands in the callback data of its own pick, page and back buttons (each screen keeps its own snapshot or
 * catalog that the indexes point into), and an optional per-model suffix (the `⛔ 14:00` limit mark).
 *
 * The same module owns what the two screens that PICK A PROVIDER (`limitsBoard.ts`, `claudeAccounts.ts`) must decide
 * identically: what a tap on a provider does ({@link decideProviderTap}), how a provider's page is built
 * ({@link buildOpenCodeProviderPage}) and how a tap on a model is answered ({@link handleModelPick}). Each screen keeps only
 * its snapshot maps and callback data. See README.md in this folder.
 */
import { Markup, type Context } from 'telegraf';
import type { SessionKey } from '../../../sessionKey';
import { t } from '../../../i18n';
import { paginateList } from '../../../utils/paginateList';
import { getModelShortLabel } from '../../../utils/modelPickerPlan';
import { formatOpenCodeModelLimitSuffix, getRunningModelOfProvider, type FallbackChainEntry } from '../../../utils/fallbackChain';
import type { OperatorSwitchOutcome } from '../../../utils/operatorSwitchPlan';

/**
 * Models per page. Model names are long, so each gets a full-width row; 10 rows keep the keyboard scroll-free and the
 * message far from Telegram's 4096-character cap (a 367-model `openrouter` catalog rendered whole once killed `/model`).
 */
export const modelPageSize = 10;

/** The `callback_data` of the page's buttons, built by the screen that owns the page. */
export interface ModelPageCallbacks {
  /** A page arrow: the page to show. */
  buildPage: (page: number) => string;
  /** A model button: the model's index in the provider's whole list (not on the page). */
  buildPick: (modelIndex: number) => string;
  /** The inert page pill. */
  noop: string;
  /** The way back; `null` when the page is the first level (nothing to go back to). */
  back: { label: string; data: string } | null;
}

export interface ModelPageInput {
  provider: string;
  /** The provider's model ids, in the order the pick indexes address. */
  models: readonly string[];
  page: number;
  /** The id that carries the ✓; may match none. */
  current: string | null;
  callbacks: ModelPageCallbacks;
  /** Appended to a model's caption (` ⛔ 14:00`); `''` for none. */
  getSuffix?: (modelId: string) => string;
}

export interface ModelPageButtons {
  rows: ReturnType<typeof Markup.button.callback>[][];
  /** The model ids on the resolved page, in button order. */
  pageModels: string[];
  currentPage: number;
  totalPages: number;
}

/**
 * @description The buttons of one page: a row per model (`name ⛔ 14:00 ✓`), the arrows around the page pill when
 * there is more than one page, then the back row. An out-of-range page is clamped to the last one (`paginateList`).
 */
export function buildModelPageButtons(input: ModelPageInput): ModelPageButtons {
  const { provider, models, callbacks } = input;
  const { slice, currentPage, totalPages } = paginateList(models, input.page, modelPageSize);
  const firstIndexOnPage = currentPage * modelPageSize;
  const rows = slice.map((modelId, offset) => {
    const caption = `${getModelShortLabel(modelId, provider)}${input.getSuffix?.(modelId) ?? ''}${modelId === input.current ? ' ✓' : ''}`;
    return [Markup.button.callback(caption, callbacks.buildPick(firstIndexOnPage + offset))];
  });
  if (totalPages > 1) {
    const arrows: ReturnType<typeof Markup.button.callback>[] = [];
    if (currentPage > 0) arrows.push(Markup.button.callback(t('model.prev_button'), callbacks.buildPage(currentPage - 1)));
    arrows.push(Markup.button.callback(t('model.page_button', { page: currentPage + 1, totalPages }), callbacks.noop));
    if (currentPage < totalPages - 1) arrows.push(Markup.button.callback(t('model.next_button'), callbacks.buildPage(currentPage + 1)));
    rows.push(arrows);
  }
  if (callbacks.back) rows.push([Markup.button.callback(callbacks.back.label, callbacks.back.data)]);
  return { rows, pageModels: slice, currentPage, totalPages };
}

// ── a provider as a pick ──

/** A provider's page as a screen edits it into its message: the text and the keyboard. */
export interface ProviderModelPage {
  text: string;
  keyboard: ReturnType<typeof Markup.inlineKeyboard>;
}

export interface ProviderModelPageInput {
  /** The localised program name (`Claude` / `OpenCode`). */
  program: string;
  providerId: string;
  models: readonly string[];
  page: number;
  /** The model id that carries the ✓. */
  current: string | null;
  callbacks: ModelPageCallbacks;
  getSuffix?: (modelId: string) => string;
}

/** @description A provider's model page: «<program> · <provider> — pick the model for this topic:» over the shared buttons. */
export function buildProviderModelPage(input: ProviderModelPageInput): ProviderModelPage {
  const { rows } = buildModelPageButtons({
    provider: input.providerId,
    models: input.models,
    page: input.page,
    current: input.current,
    callbacks: input.callbacks,
    getSuffix: input.getSuffix,
  });
  return { text: t('limits.pickModel', { label: `${input.program} · ${input.providerId}` }), keyboard: Markup.inlineKeyboard(rows) };
}

export interface OpenCodeProviderPageInput {
  providerId: string;
  models: readonly string[];
  page: number;
  /** Where the topic runs: the page marks the rung's model when it is on this provider. */
  rung: FallbackChainEntry | null;
  /** The OpenCode limit marks (`provider/model` → ISO instant): a limited model carries its reset. */
  limits: Readonly<Record<string, string>>;
  timezone: string;
  nowMs: number;
  callbacks: ModelPageCallbacks;
}

/** @description An OpenCode provider's page: ✓ on the model the topic runs, ` ⛔ <reset>` on a limited one. */
export function buildOpenCodeProviderPage(input: OpenCodeProviderPageInput): ProviderModelPage {
  return buildProviderModelPage({
    program: t('fallback.backendOpenCode'),
    providerId: input.providerId,
    models: input.models,
    page: input.page,
    current: getRunningModelOfProvider(input.rung, input.providerId),
    callbacks: input.callbacks,
    getSuffix: (modelId) => formatOpenCodeModelLimitSuffix(`${input.providerId}/${modelId}`, input.limits, input.timezone, input.nowMs),
  });
}

/**
 * What a tap on an OpenCode provider does: `stale` when the provider lists no model any more (re-render, act on nothing),
 * `switchNow` when it lists exactly one model and the topic is not on it yet (nothing to choose), else `page` — its model
 * page, which is also where the ✓ row leads.
 */
export function decideProviderTap(input: { models: readonly string[]; isHere: boolean }): 'stale' | 'switchNow' | 'page' {
  if (input.models.length === 0) return 'stale';
  return input.models.length === 1 && !input.isHere ? 'switchNow' : 'page';
}

/** The ports a provider pick needs from its screen's module. */
export interface ProviderPickDeps {
  ctx: Pick<Context, 'answerCbQuery'>;
  key: SessionKey;
  /** The one switch path (`bot.ts`). */
  switchTopicByOperator: (key: SessionKey, to: FallbackChainEntry) => Promise<OperatorSwitchOutcome>;
  /** The toast, posted whole when it does not fit (`createWholeTextAnswerer`). */
  answerWholeText: (ctx: Pick<Context, 'answerCbQuery'>, key: SessionKey, text: string) => Promise<void>;
  /** Back to the screen, its ✓ moved. */
  rerender: () => Promise<void>;
}

/**
 * @description A tap on a model: the switch, answered with the short toast `limits.switched` (where the topic runs now) — a
 * refusal with its reason, an asked hand-over question with no toast at all (the question is the answer). A refusal leaves the
 * page where it is; anything else returns to the screen. Used by every model button and by a provider with one model.
 */
export async function handleModelPick(deps: ProviderPickDeps, to: FallbackChainEntry): Promise<void> {
  const outcome = await deps.switchTopicByOperator(deps.key, to);
  if (outcome.kind === 'asked') await deps.ctx.answerCbQuery();
  else await deps.answerWholeText(deps.ctx, deps.key, outcome.kind === 'switched' ? t('limits.switched', { label: outcome.label }) : outcome.text);
  if (outcome.kind !== 'refused') await deps.rerender();
}

export interface ProviderTapDeps extends ProviderPickDeps {
  providerId: string;
  /** The provider's models (ids without the provider), `[]` when it lists none any more. */
  models: readonly string[];
  /** Where the topic runs now. */
  rung: FallbackChainEntry | null;
  /** Show the provider's first page in the screen's message. */
  showPage: () => Promise<void>;
  /** The screen's «out of date» answer (toast + re-render). */
  answerStale: () => Promise<void>;
}

/** @description A tap on an OpenCode provider's row, decided by {@link decideProviderTap}. */
export async function handleProviderTap(deps: ProviderTapDeps): Promise<void> {
  const decision = decideProviderTap({ models: deps.models, isHere: getRunningModelOfProvider(deps.rung, deps.providerId) !== null });
  if (decision === 'stale') { await deps.answerStale(); return; }
  if (decision === 'switchNow') {
    await handleModelPick(deps, { backend: 'opencode', providerId: deps.providerId, modelId: deps.models[0] });
    return;
  }
  await deps.ctx.answerCbQuery();
  await deps.showPage();
}
