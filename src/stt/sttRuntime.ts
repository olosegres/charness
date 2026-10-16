import {
  createEmptySttConfig,
  getSttConfigWriteBlock,
  getSttReportLines,
  loadSttConfig,
  migrateLegacySttKeys,
  resolveSttSettings,
  type ResolvedSttSettings,
  type SttConfigLoad,
  type SttFacts,
} from './sttSettings';
import { isGigaamInstalled, isGigaamInstalling } from './sttInstall';
import {
  getSttSidecarTranscriptionEndpoint,
  type SttOwnerContext,
  type SttSidecarOwner,
} from './sttSidecarOwner';

/**
 * @description The voice settings as the running bot sees them: `stt.json` re-read when it changes, resolved
 * against what the local engine's lifecycle says RIGHT NOW (installed? installing? marked unhealthy? has an
 * owner?), with a change in what is wrong logged once as `[STT] …`. Built over injected dependencies so `bot.ts`
 * (which a test cannot import) only wires it.
 */

export interface SttRuntimeDeps {
  getDataDir: () => string;
  getConfigPath: () => string;
  owner: Pick<SttSidecarOwner, 'ensure' | 'checkIsUnhealthy'>;
  getOwnerContext: () => SttOwnerContext | null;
  /** The sinks for the `[STT]` lines: info (the migration) and problems (what is wrong with the settings). */
  logInfo: (line: string) => void;
  logProblem: (line: string) => void;
  /**
   * Called when `stt.json` CHANGED (a hand edit or a `/stt` save) and now names an enabled local engine that is
   * not installed — the bot installs it by itself. Not called at boot (the boot step starts that install, with
   * its progress message) and never per voice note, so a failed install is not retried by every voice.
   */
  onNeedsAutoInstall?: () => void;
  /** Seams for tests; default to the real install checks. */
  checkIsInstalled?: (dataDir: string) => boolean;
  checkIsInstalling?: (dataDir: string) => boolean;
}

export interface SttRuntime {
  /** The chain in effect now (re-reads the file when its stamp changed). */
  getResolved: () => ResolvedSttSettings;
  /** Boot: move the old env keys into `stt.json` once, then report the first state. */
  init: () => void;
}

export function createSttRuntime(deps: SttRuntimeDeps): SttRuntime {
  const checkIsInstalled = deps.checkIsInstalled ?? isGigaamInstalled;
  const checkIsInstalling = deps.checkIsInstalling ?? isGigaamInstalling;
  /** The `[STT]` lines last logged, so an unchanged state is reported once, not per voice note. */
  let lastReport = '';
  /** The load the last resolve saw: the cache hands back the SAME object until the file changes. */
  let lastLoad: SttConfigLoad | null = null;

  function resolveNow(isInit: boolean): ResolvedSttSettings {
    const load = loadSttConfig(deps.getConfigPath());
    const dataDir = deps.getDataDir();
    const facts: SttFacts = {
      isGigaamInstalled: checkIsInstalled(dataDir),
      isGigaamInstalling: checkIsInstalling(dataDir),
      isGigaamUnhealthy: deps.owner.checkIsUnhealthy(),
      hasOwnerContext: deps.getOwnerContext() !== null,
    };
    // The process settings of THIS resolve: a start (or an adoption) is judged against them.
    const localEngineSettings = (load.config ?? createEmptySttConfig()).gigaam;
    const resolved = resolveSttSettings(load, facts, {
      getGigaamEndpoint: async () => getSttSidecarTranscriptionEndpoint(await deps.owner.ensure(localEngineSettings)),
    });
    const report = getSttReportLines(resolved).join('\n');
    if (report !== lastReport) {
      lastReport = report;
      if (report) deps.logProblem(report);
    }
    const isChanged = load !== lastLoad;
    lastLoad = load;
    if (isChanged && !isInit && resolved.needsAutoInstall) deps.onNeedsAutoInstall?.();
    return resolved;
  }

  return {
    getResolved: () => resolveNow(false),
    init() {
      const configPath = deps.getConfigPath();
      const migration = migrateLegacySttKeys(configPath);
      if (migration.status === 'migrated') {
        deps.logInfo(`[STT] moved ${migration.engineNames.join(' + ')} from the environment into ${configPath}`);
      } else if (migration.status === 'writeFailed') {
        deps.logProblem(`[STT] could not write ${configPath} (${migration.error}): voice input stays off until it can be written`);
      } else {
        // Said once, at boot: a settings file that cannot be kept (a read-only or unmounted directory) loses every /stt edit.
        const writeBlock = getSttConfigWriteBlock(configPath);
        if (writeBlock !== null) {
          deps.logProblem(`[STT] ${configPath} cannot be written (${writeBlock}): changes made in /stt will not be kept — make its directory writable`);
        }
      }
      resolveNow(true);
    },
  };
}
