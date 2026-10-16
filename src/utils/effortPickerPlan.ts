/**
 * @description Pure plan of the `/effort` picker (text + buttons), shared by the command and its buttons in
 * `connectors/telegram/commands/modelProviders.ts` so the text and the ✓ can never drift between the first render
 * and the re-render after a tap.
 *
 * Two screens:
 * - **General** — the instance default (`settings.json`): says it is the default of every topic without its own
 *   effort; one button per level, the current default marked ✓.
 * - **A topic** — the level in force AND where it comes from («as in General» / «set for this topic»); one button
 *   per level the backend offers (✓ on the one in force) and, when the backend can clear a pick, a last button
 *   that puts the topic back on General's value.
 */

/** Levels per keyboard row. */
export const effortPickerColumns = 3;

/** The «as in General» button of a topic's picker. Disjoint from {@link effortLevelCallbackRe} (no underscore). */
export const effortSameCallback = 'effortsame';

/** A level button's callback data prefix; the rest is the level. */
const effortLevelCallbackPrefix = 'effort_';

/** Matches a level button's callback data. */
export const effortLevelCallbackRe = new RegExp(`^${effortLevelCallbackPrefix}(.+)$`);

/** @description A level button's callback data. */
export function buildEffortLevelCallback(level: string): string {
  return `${effortLevelCallbackPrefix}${level}`;
}

export interface EffortPickerButton {
  text: string;
  data: string;
}

export interface EffortPicker {
  text: string;
  /** Rows of buttons, top to bottom. */
  rows: EffortPickerButton[][];
}

export type EffortPickerInput =
  | {
      isGeneral: true;
      /** The levels General offers (the Claude set). */
      levels: readonly string[];
      /** The instance default now in force. */
      instanceDefault: string;
    }
  | {
      isGeneral: false;
      levels: readonly string[];
      /** The level the topic runs at: its own pick, else the instance default (OpenCode: clamped). */
      inForce: string;
      /** The topic picked `inForce` itself (`getOwnEffort`), instead of following General. */
      isOwnPick: boolean;
      /** The instance default now in force — what the «as in General» button promises. */
      instanceDefault: string;
      /** The backend can clear a pick (`clearEffort`): the «as in General» button is offered. */
      canClear: boolean;
    };

type Translate = (code: string, vars?: Record<string, string | number>) => string;

function buildLevelRows(levels: readonly string[], current: string): EffortPickerButton[][] {
  const buttons = levels.map((level) => ({ text: level === current ? `${level} ✓` : level, data: buildEffortLevelCallback(level) }));
  const rows: EffortPickerButton[][] = [];
  for (let start = 0; start < buttons.length; start += effortPickerColumns) {
    rows.push(buttons.slice(start, start + effortPickerColumns));
  }
  return rows;
}

/** @description The `/effort` picker for `input`: its text and button rows. */
export function buildEffortPicker(input: EffortPickerInput, translate: Translate): EffortPicker {
  if (input.isGeneral) {
    return {
      text: translate('effort.general.choose', { current: input.instanceDefault }),
      rows: buildLevelRows(input.levels, input.instanceDefault),
    };
  }
  const source = translate(input.isOwnPick ? 'effort.sourceTopic' : 'effort.sourceGeneral');
  const rows = buildLevelRows(input.levels, input.inForce);
  if (input.canClear) {
    rows.push([{ text: translate('effort.sameAsGeneralButton', { level: input.instanceDefault }), data: effortSameCallback }]);
  }
  return { text: translate('effort.choose', { current: input.inForce, source }), rows };
}
