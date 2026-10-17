/**
 * @description The two settings that decide what a usage limit does — «auto switch to a fallback model» and «wait for
 * the reset and continue» — as the screens read them: the value in force, the topic's own choice and the General
 * value. Shared by `/limits_autoswitch` (`fallbackChain.ts`), which edits them, and the `/limits` board
 * (`limitsBoard.ts`), which shows them, so the two can never read a setting differently.
 */
import type { SessionKey } from '../sessionKey';
import { t } from '../i18n';
import type { StateStore } from '../state';

/** The two settings: the ids the setting rows, the sub-menu and its callbacks are keyed by. */
export type LimitSettingId = 'switch' | 'wait';

export const limitSettingIds: readonly LimitSettingId[] = ['switch', 'wait'];

/** A setting's value as a screen reads it: what is in force, the topic's own choice (`undefined` = follows General) and the General value. */
export interface LimitSettingValue {
  effective: boolean;
  override: boolean | undefined;
  generalValue: boolean;
}

/** The slice of the state store the settings are read from. */
export type LimitSettingsReader = Pick<
  StateStore,
  | 'getClaudeAutoSwitchOnLimitGlobalDefault'
  | 'checkIsClaudeAutoSwitchOnLimitEnabled'
  | 'getClaudeAutoSwitchOnLimitOverride'
  | 'getAutoContinueOnLimitGlobalDefault'
  | 'checkIsAutoContinueOnLimitEnabled'
  | 'getAutoContinueOnLimitOverride'
>;

/** A setting's value for the topic (General: the instance default, where there is no override). */
export function readLimitSetting(state: LimitSettingsReader, id: LimitSettingId, key: SessionKey, isGeneral: boolean): LimitSettingValue {
  if (id === 'switch') {
    return {
      effective: isGeneral ? state.getClaudeAutoSwitchOnLimitGlobalDefault() : state.checkIsClaudeAutoSwitchOnLimitEnabled(key),
      override: isGeneral ? undefined : state.getClaudeAutoSwitchOnLimitOverride(key),
      generalValue: state.getClaudeAutoSwitchOnLimitGlobalDefault(),
    };
  }
  return {
    effective: isGeneral ? state.getAutoContinueOnLimitGlobalDefault() : state.checkIsAutoContinueOnLimitEnabled(key),
    override: isGeneral ? undefined : state.getAutoContinueOnLimitOverride(key),
    generalValue: state.getAutoContinueOnLimitGlobalDefault(),
  };
}

export function formatLimitSettingState(isEnabled: boolean): string {
  return isEnabled ? t('autoContinueLimits.on') : t('autoContinueLimits.off');
}

/** Where a topic's setting value comes from: General, or the topic's own override. */
export function formatLimitSettingSource(setting: LimitSettingValue): string {
  return setting.override === undefined ? t('limits.sourceGeneral') : t('limits.sourceTopic');
}
