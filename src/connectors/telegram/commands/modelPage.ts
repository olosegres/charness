/**
 * The model page — one provider's models as a paginated list of full-width buttons — shared by every screen that
 * lets the operator pick a model: `/model`, the «add a fallback model» step of `/limits_autoswitch`, and the
 * provider pages of `/limits` and `/accounts`. The page only draws buttons; WHAT a tap does is the screen's:
 * it hands in the callback data of its own pick, page and back buttons (each screen keeps its own snapshot or
 * catalog that the indexes point into), and an optional per-model suffix (the `⛔ 14:00` limit mark). See README.md
 * in this folder.
 */
import { Markup } from 'telegraf';
import { t } from '../../../i18n';
import { paginateList } from '../../../utils/paginateList';
import { getModelShortLabel } from '../../../utils/modelPickerPlan';

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
