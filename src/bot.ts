import { Telegraf, Markup, type Context, type NarrowedContext } from 'telegraf';
import { message } from 'telegraf/filters';
import type { Update, Message } from 'telegraf/typings/core/types/typegram';
import * as fs from 'fs';
import { promises as fsp } from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as https from 'https';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

import {
  getAdapter,
  getThreadAdapter,
  getThreadAdapterNameRaw,
  setThreadAdapter,
  getAvailableAdapters,
  getDefaultClaudeBackendName,
  registerAdapterEventHandlers,
  registerDisplayPrefsReader,
  registerSeenWatermarkWriter,
  registerJsonStreamTailWriter,
  registerThreadLocaleReader,
  stopAllAdaptersFor as sweepAdapters,
  getKnownAdapterNames,
  checkIsClaudeBackend,
  checkIsSameConversationSwitch,
  resolveClaudeBackendName,
  parseClaudeBackendArg,
  getClaudeModeAction,
} from './adapters/createAdapter';
import { ClaudeJsonStreamAdapter, claudeJsonStreamAdapterName } from './adapters/claudeJsonStreamAdapter';
import { checkShouldPostReattachRecap, formatReattachRecap } from './resumeContext';
import type { AgentAdapter, AgentRuntimeInfo, AgentSession, DisplayVerbosityMode, OpenCodeQuestion, OutputTransport, PendingQuestionState, AgentApiErrorClass, LimitEpisodeMarker, ResolvedThreadDisplayPrefs, SeenWatermark, SubagentStatusEvent, ThinkingEvent, ToolResultEvent } from './types';
import type { SessionKey } from './sessionKey';
import { createOutputTransport } from './connectors/telegram/output/createOutputTransport';
import { keyToString, keyFromString, tryKeyFromString } from './sessionKey';
import {
  checkIsTelegramKey,
  getTelegramChatId,
  getTelegramThreadId,
  makeTelegramKey,
} from './connectors/telegram/sessionKeyCodec';
// Pure parser lives in `./agentTrigger` so it can be unit-tested without
// booting Telegraf (audit S19 / #25).
import { parseAgentTrigger as checkIsStartAgentPhrase } from './agentTrigger';
import { checkSessionPickAction } from './sessionPick';
import { ClaudeCliAdapter, getClaudeReplyRoute } from './adapters/claudeCliAdapter';
import { OpenCodeAdapter, checkIsValidProviderId, type OpenCodePendingQuestion } from './adapters/openCodeAdapter';
import { TerminalAdapter } from './adapters/terminalAdapter';
import {
  buildQuestionBodyLines,
  buildQuestionBodyLinesPlain,
  recordAnswerAndAdvance,
  migratePendingQuestionState,
  getQuestionReplyRoute,
} from './openCodeQuestionFlow';
import { checkShouldRepostPendingQuestion } from './pendingQuestionRepost';
import {
  enqueueSend,
  sendUnpaced,
  checkIsRateLimited,
  getRateLimitRemainingMs,
  getActiveChatRateSummaries,
  formatRateSummaryLine,
  enterShutdownDrain,
  drainPendingSends,
  shutdownDrainMaxMs,
  type ShutdownDrainVerdict,
} from './rateLimiter';
import {
  stopOpenCodeServer,
  ensureOpenCodeServer,
  checkIsInstalled,
  getOpenCodeChildEnv,
} from './installManager';
import {
  buildReadinessReport,
  buildStartupStatusText,
  checkShouldSendStartupStatus,
  resolveStartupTargets,
  type BotAdminRights,
  type ReadinessFacts,
  type StartupTarget,
} from './utils/startupReadiness';
import { getStateStore, KeyLock, type StateStore } from './state';
import { releaseLock } from './cli/lock';
import { gracefulShutdown } from './shutdown';
import {
  createUpdateDispatcher,
  installUpdateDispatcher,
  getUpdateQueueKey,
} from './connectors/telegram/updateDispatcher';
import { classifyBoot } from './bootClassifier';
import { defaultLocale, formatLanguageDisplay, localeCodes, normalizeLocale, runWithLocale, t, type Locale } from './i18n';
import { buildLanguagePicker, languageAutoCallback } from './connectors/telegram/languagePicker';
import {
  applyProcessTimezone,
  checkIsApplicableTimezone,
  checkIsFixedOffsetZone,
  formatZoneNow,
  formatZoneNowWithDate,
  getCanonicalTimezone,
  getEffectiveTimezone,
  getHostTimezone,
} from './utils/timezone';
import {
  buildTimezoneRegionPicker,
  buildTimezoneZonePicker,
  getTimezoneAt,
  regionPageCallbackRe,
  timezoneAutoCallback,
  timezonePickerBackCallback,
  zonePickCallbackRe,
} from './connectors/telegram/timezonePicker';
import { recomputeSchedulesForTimezoneChange } from './scheduler/timezoneRecompute';
import { validateSubdir, resolveBoundWorkDir, BindError, findAutobindSubdir, paginateBindList } from './validation';
import { paginateList } from './utils/paginateList';
import {
  buildModelCatalog,
  buildModelPickCallback,
  buildProviderHideCallback,
  buildProviderPageCallback,
  buildProviderShowCallback,
  checkHasProviderLevel,
  getModelShortLabel,
  modelPickCallbackRe,
  modelPickerBackCallback,
  modelPickerNoopCallback,
  providerHideCallbackRe,
  providerPageCallbackRe,
  providerShowCallbackRe,
  type ModelCatalog,
} from './utils/modelPickerPlan';
import {
  buildDisconnectPickerKey,
  buildDisconnectProviderCallback,
  disconnectProviderCallbackRe,
  getDisconnectPickerKeysForThread,
  getDisconnectPickerProviderAt,
  getEvictedDisconnectPickerKeys,
} from './utils/providerDisconnectPlan';
import { validateNewFolderName, NewFolderNameError } from './folderName';
import {
  resolveThreadKeyForMode,
  checkIsDmThreadKey,
  resolvePairingCandidate,
  checkIsChatMode,
  GENERAL_THREAD_ID,
  DM_GENERAL_THREAD_ID,
  type ChatMode,
} from './threadRouting';
import { AdminCache, ADMIN_CACHE_TTL_MS } from './accessControl';
import {
  checkShouldInvalidateAdminCache,
  createTelegramConnectorInbound,
  getTelegramCommand,
} from './connectors/telegram/inbound';
import { buildOptionsKeyboard, createTelegramConnectorOutbound } from './connectors/telegram/outbound';
import { createCommandRouter } from './platform/commandRouter';
import type { InboundCommand, InboundEvent } from './platform/inbound';
import type { OutboundHints } from './platform/outbound';
import type { PostToSessionDeps } from './postToSession';
import { getLimitResumeMessage } from './utils/limitHeldPrompts';
import { deliverPromptOrBuffer as deliverPromptWithDeps, type PromptDelivery, type PromptDeliveryDeps } from './utils/promptDelivery';
import { restoreApiRetryTimers, runApiRetryKick, type ApiRetryKickDeps, type ApiRetryTimerEntry } from './apiRetryKick';
import { LimitHeldPromptQueue } from './utils/limitHeldPromptQueue';
import type { UpdateType } from 'telegraf/typings/telegram-types';
import type { InlineKeyboardMarkup } from 'telegraf/typings/core/types/typegram';
import { downloadFile } from './utils/download';
import { getTranscriptionEndpoint, transcribeAudio, type TranscribeResult } from './utils/transcribeAudio';
import { stripCommandBotMention } from './utils';
import { checkIsConnectCommandText, getRecvTracePreview } from './utils/recvPreviewRedaction';
import {
  classifySendError,
  checkIsApiError,
  getErrorCode,
  getErrorDescription,
} from './sendErrorClassifier';
import { formatPinnedStatus } from './pinnedStatus';
import { checkIsProgressChunk, collapseProgressChunk } from './progressLine';
import { StartupPromptBuffer, type BufferedPromptSettled } from './startupPromptBuffer';
import { renderAgentHtml } from './connectors/telegram/renderAgentHtml';
import { splitMessage, MAX_MESSAGE_LEN } from './connectors/telegram/messageSplit';
import { getOutputFlushPlan, appendPendingOutput, getUnsentRemainder } from './connectors/telegram/outputFlushPlan';
import { glueBacklogFrames } from './connectors/telegram/outputBacklogGlue';
import { checkShouldKeepTyping as checkShouldKeepTypingDecision } from './utils/typingActive';
import { checkIsTypingStuckByLeak } from './utils/typingLoopBackstop';
import { getOutputFlushTiming } from './utils/outputFlushTiming';
import { getOutputDebounceMs as resolveOutputDebounceMs } from './utils/outputDebounce';
import { checkIsStaleAnswerCallbackQueryError } from './utils/telegramError';
import {
  flushTraceBufferSyncOnExit,
  installCallApiTrace,
  pruneTraceBuckets,
  setTraceConfig,
  traceAgentEmit,
  traceRecvUpdate,
} from './outputTrace';
import { installLinkPreviewSuppression } from './utils/linkPreviewSuppression';
import { pruneExpiredBuckets, retentionMs as logBucketRetentionMs } from './utils/rotatingLogFile';
import { consoleFileBase, consoleFileExt } from './utils/consoleFileTap';
import { clearThreadOutputQueues } from './utils/clearThreadOutputQueues';
import { getGroupFinalizePlan } from './utils/groupFinalizePlan';
import { persistAdapterSessionIds } from './utils/persistAdapterSessionIds';
import { createSendFilesToThread } from './utils/fileSendService';
import { createSendMessagesToThread } from './utils/messageSendService';
import { createTelegramFileSendGateway } from './connectors/telegram/fileSendGateway';
import { getStatusFlushAction } from './utils/statusFlushDecision';
import { getThreadStatusModel, getThreadStatusReport } from './utils/threadStatusReport';
import { createIdenticalOutputGuard } from './utils/identicalOutputGuard';
import { getTransientFrameIds, clearTransientFramesForShutdown } from './utils/transientFrames';
import {
  getThinkingEventAction,
  getThinkingAnswerStartAction,
  formatThinkingDurationSeconds,
} from './utils/thinkingRender';
import {
  getToolResultRenderAction,
  getTruncatedToolResult,
  buildFencedToolResultBody,
} from './utils/toolResultRender';
import { buildSubagentOutputPrefix } from './utils/subagentRender';
import {
  buildSubagentElapsedText,
  getSubagentStatusAction,
  checkShouldEnqueueSubagentStatus,
  checkShouldExpireSubagentStatus,
} from './utils/subagentStatusRender';
import {
  displayVerbosityModeOptions,
  normalizeDisplayVerbosityMode,
} from './utils/displayVerbosity';
import { getUniformVerbosityLevel } from './utils/verbosityRender';
import { createSerialQueue, type SerialQueue } from './utils/serialQueue';
import { getVoiceTranscriptionQueue } from './voiceQueue';
import {
  buildClaudeLivenessFrameText,
  checkShouldForceIdleRemoval,
  checkShouldSendLivenessFrame,
  getClaudeLivenessAction,
  getClaudeLivenessShouldStop,
  getStatusFrameStoreDecision,
} from './utils/claudeLivenessAction';
import { getModelSetReplyDecision } from './utils/modelSetReplyDecision';
import { formatIsoLocalOffset } from './utils/isoTimestamp';
import { defaultEffortLevel } from './effortLevels';
import {
  buildThreadContextPreamble,
  prependThreadContextPreamble,
  checkShouldInjectPreamble,
  checkShouldSkipPreambleForText,
} from './threadContextPreamble';
import { getPinnedBannerSkipDecision } from './utils/pinnedBannerSkipDecision';
import { extractReplyQuote, buildReplyQuoteBlock, type ReplyQuoteSource } from './utils/replyQuote';
import {
  getTelegramFileMeta,
  getMediaGroupId,
  buildSavedFileName,
  buildFilePromptText,
  buildAlbumPromptText,
  checkIsFileTooBig,
  telegramFileDownloadCapBytes,
  incomingFileMessageFilter,
} from './connectors/telegram/fileIntake';
import type { TelegramFileMeta, AlbumFile } from './connectors/telegram/fileIntake';
import { createMediaGroupCollector } from './utils/mediaGroupCollector';
import { sessionTitleSnippetMaxLength } from './openCodeSessionTitle';
import {
  ensureThreadFilesDir,
  purgeThreadFiles,
  resolveFilesRoot,
  sweepExpiredThreadFiles,
  fileRetentionMs,
  fileSweepIntervalMs,
} from './botFileStorage';
import {
  resolveJsonStreamRoot,
  sweepOrphanJsonStreamDirs,
  resolveJsonStreamSessionDir,
  getJsonStreamSessionPaths,
  readFileByteRange,
} from './utils/jsonStreamHost';
import { RunLedger } from './scheduler/runLedger';
import { createScheduleDelivery, unboundDeliveryError } from './scheduler/delivery';
import { buildCheckEnv, runCheckCommand } from './scheduler/checkRun';
import { createSchedulerEngine, maxTimeoutMs, type SchedulerEngine } from './scheduler/engine';
import {
  createSchedulerMcpServer,
  getSchedulerMcpPort,
  resolveSchedulerMcpPort,
  type SchedulerMcpHandle,
} from './scheduler/mcpSurface';
import { schedulerMcpServerName } from './scheduler/injection';
import { runSessionBootPhase, startSchedulerMcpForBoot } from './scheduler/mcpBoot';
import { RequestLedger } from './requests/requestLedger';
import { answerRequest } from './requests/answerRequest';
import { createTelegramAnswerSink } from './connectors/telegram/answerSink';
import { getAnswerSink, releaseRequestAlert, type AnswerSinks } from './platform/answerSink';
import { createSessionTurnProbe } from './requests/sessionTurnProbe';
import {
  answerOpenRequestForLimitWait,
  getLimitWaitForNewRequest,
  type LimitWaitAnswerDeps,
  type LimitWaitAnswerOutcome,
  type UsageLimitWait,
} from './requests/limitWaitAnswer';
import { formatLocalClockWithDateIfNotToday } from './utils/localClock';
import { RequestWakeUpEngine } from './requests/wakeUpEngine';
import { getRequestBackstopMs } from './requests/wakeUpRules';
import { getPromptNotTakenIn, type WakeUpMessage } from './requests/requestHeader';
import type { OpenRequestState, RequestAlertReason } from './requests/types';
import { getThreadKeysForDirectory } from './scheduler/directoryThreads';
import { getRebindResumeAction } from './scheduler/rebindResume';
import { checkIsReminderSchedule, getUnboundPausableSchedules } from './scheduler/deliveryKind';
import { createScheduleForThread, maxRemindersPerThread } from './scheduler/store';
import type { DeliveryOutcome, FireContext, ScheduleRecord, ScheduleSpec } from './scheduler/types';
import {
  applyReminderWizardCallback,
  buildReminderCardPlan,
  buildReminderDeleteCallback,
  buildReminderHubKeyboard,
  buildReminderListPageCallback,
  buildReminderListPlan,
  buildReminderSpec,
  buildReminderStepKeyboard,
  createReminderWizardId,
  createReminderWizardState,
  formatReminderTime,
  getReminderCardBackPage,
  getReminderDeleteTarget,
  getReminderNameFromText,
  getReminderPicksFromState,
  getReminderScheduleDescriptor,
  getReminderStateForRetime,
  getReminderStateForStep,
  getShortenedText,
  parseReminderCardCallback,
  parseReminderDeleteCallback,
  parseReminderListPageCallback,
  reminderAddCallback,
  reminderCardCallbackRe,
  reminderCloseCallback,
  reminderDeleteCallbackRe,
  reminderHubCallback,
  reminderLabelKeys,
  reminderListPageCallbackRe,
  reminderRepeatLabelKeys,
  reminderSummaryTextMaxLength,
  reminderTextMaxLength,
  reminderWeekdayLabelKeys,
  reminderWizardCallbackRe,
  type ReminderButtonLabel,
  type ReminderKeyboardPlan,
  type ReminderListRow,
  type ReminderScheduleDescriptor,
  type ReminderSchedulePicks,
  type ReminderWizardErrorCode,
  type ReminderWizardState,
} from './utils/reminderWizard';
import {
  getReminderNextRunText,
  getReminderRowLabel,
  getReminderScheduleDescriptorText,
} from './utils/reminderScheduleText';
import {
  checkIsReminderTextWaitKept,
  getReminderHubPlan,
  getReminderTextAcceptance,
  getReminderTextCaptureRoute,
  getReminderWizardTapRoute,
  type ReminderTextCaptureRoute,
} from './utils/reminderFlow';
import { decideRetryAction, classifyAgentApiError } from './apiErrorRetry';
import { checkIsReplayablePrompt, decideWedgeRecovery } from './utils/wedgeRecovery';
import { spawn as spawnPty, type IPty } from 'node-pty';
import { resolveClaudeBinary, resolveOpenCodeBinary } from './utils/resolveBinary';
import {
  parseClaudeAuthLoginUrl,
  checkIsClaudeAuthLoginCodePrompt,
  parseAuthStatusLoggedIn,
  checkIsAuthLoginSucceeded,
  getLoginCommandRoute,
} from './utils/claudeAuthLogin';
import { getCompactCommandRoute, type CompactCommandRoute } from './utils/compactCommandRoute';
import {
  getIdleCompactionArmDecision,
  type IdleCompactionArmKind,
  checkShouldFireIdleCompaction,
  checkIsBusyForRealTurn,
  buildCompactionInstruction,
  compactionSummaryGuidance,
  compactionSkillsGuidance,
  extractCompactionClosingSection,
  stripCompactionClosingMarkers,
  checkShouldPostCompactionSummary,
  checkShouldAnnounceCompactionStart,
  buildIdleCompactionNoticeParts,
  formatTokenCount,
  compactionClosingStartMarker,
  compactionClosingEndMarker,
} from './utils/compactOnIdle';
import {
  decideLimitEpisodeRecovery,
  getLastTerminalErrorText,
  limitEpisodeTailMaxBytes,
} from './utils/limitEpisodeRecovery';
import {
  buildSkipArmedRetryCallbackData,
  parseSkipArmedRetryCallbackData,
  getArmedRetrySkipDecision,
  skipArmedRetryCallbackPrefix,
} from './utils/autoContinueOnLimit';
import {
  type OpenCodeAuthMethod,
  buildOpenCodeAuthLoginArgs,
  parseOpenCodeOAuthUrl,
  parseOpenCodeDeviceCode,
  checkIsOpenCodeOAuthPastePrompt,
  checkIsOAuthInfoReady,
  checkIsOAuthMethod,
  getOpenCodeAuthFilePath,
  checkProviderAuthed,
  checkIsOpenCodeOAuthSucceeded,
  buildConnectMethodButtonLabel,
  parseOAuthAuthorizeDetails,
  checkIsLoopbackOAuthFlow,
  parseOAuthCallbackFromReply,
  classifyOpenCodeOAuthReply,
  buildLoopbackCompletionUrl,
  checkIsPlausibleProviderApiKey,
} from './utils/openCodeAuthLogin';

// ═══════════════════════════════════════════════════════════════════════════════
//  ENV parsing & fatal validation
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * @description Parse + validate boot environment. Throws (and ends the
 * process via `index.ts`) on any required mis-configuration so the bot
 * never silently runs in a half-broken state.
 *
 * `TELEGRAM_BOT_TOKEN` is the only normal required env var. `WORK_ROOT` is
 * usually supplied by the CLI wrapper as `$PWD`; the fallback here keeps a
 * direct import from silently becoming stricter than the public entrypoint.
 */
function parseEnv() {
  const errors: string[] = [];

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) errors.push('TELEGRAM_BOT_TOKEN is required');

  // CHAT_MODE selects which surface(s) the instance serves: `group` (forum
  // supergroup only), `dm` (the owner's private chat only), or `both` (one
  // instance serves the owner DM AND the group at once, decided per chat).
  // Unset → `both`, so a bare `telegramcode` lights up both surfaces. An unknown
  // value fails fast (same intent as the ALLOWED_GROUP_ID numeric gate).
  const chatModeRaw = (process.env.CHAT_MODE ?? '').trim();
  let chatMode: ChatMode = 'both';
  if (chatModeRaw) {
    if (checkIsChatMode(chatModeRaw)) {
      chatMode = chatModeRaw;
    } else {
      errors.push(`CHAT_MODE must be "group", "dm" or "both" (got "${chatModeRaw}")`);
    }
  }

  // OWNER_USER_ID is the numeric Telegram user id allowed to use the bot in DM
  // (the owner's private-chat id equals their user id). REQUIRED for `dm`
  // (without it the DM surface would have no access authority — any user can DM a
  // bot). For `both` it is OPTIONAL: set → the DM surface is active; unset → the
  // DM surface is INERT (group-only) and boot logs a notice, so default `both`
  // stays backward-compatible with a bare group-only deploy. Ignored in `group`.
  const ownerUserIdRaw = (process.env.OWNER_USER_ID ?? '').trim();
  let ownerUserId = NaN;
  if (ownerUserIdRaw) {
    ownerUserId = Number(ownerUserIdRaw);
    if (!Number.isFinite(ownerUserId)) {
      errors.push('OWNER_USER_ID must be a numeric Telegram user id');
    }
  } else if (chatMode === 'dm') {
    errors.push('OWNER_USER_ID is required when CHAT_MODE=dm (numeric Telegram user id)');
  }
  // The DM surface is inert when no owner is configured. Impossible for `dm`
  // (owner required above) and `group` (no DM surface); only `both` without an
  // OWNER_USER_ID reaches it → that instance serves the group only.
  const isDmSurfaceInert = !Number.isFinite(ownerUserId);

  // Access authority is fully runtime: the creator + administrators of the
  // served forum group (read live via getChatAdministrators, cached). There is
  // no static user allow-list env any more — the old ALLOWED_USERS is removed.

  // ALLOWED_GROUP_ID is optional: leave it empty to auto-pair with the
  // first forum supergroup an allowed user contacts the bot from (the id
  // is then persisted to state.json). A non-numeric value is still an
  // error — Telegram addresses chats by numeric id, not by group name.
  const allowedGroupIdRaw = (process.env.ALLOWED_GROUP_ID ?? '').trim();
  let allowedGroupId = NaN;
  if (allowedGroupIdRaw) {
    allowedGroupId = Number(allowedGroupIdRaw);
    if (!Number.isFinite(allowedGroupId)) {
      errors.push(
        'ALLOWED_GROUP_ID must be a numeric chat id (e.g. -1001234567890), ' +
          'or leave it empty to auto-pair with your forum supergroup on first contact',
      );
    }
  }

  const workRoot = process.env.WORK_ROOT || process.cwd();
  try {
    if (!fs.statSync(workRoot).isDirectory()) {
      errors.push(`WORK_ROOT="${workRoot}" is not a directory`);
    }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? 'unknown';
    errors.push(`WORK_ROOT="${workRoot}" is not accessible (${code})`);
  }

  if (errors.length > 0) {
    for (const err of errors) console.error(`[startup] ${err}`);
    process.exit(1);
  }

  return {
    botToken: botToken!,
    chatMode,
    ownerUserId,
    isDmSurfaceInert,
    allowedGroupId,
    workRoot,
    openaiApiKey: process.env.OPENAI_API_KEY,
    groqApiKey: process.env.GROQ_API_KEY,
  };
}

const ENV = parseEnv();

// ═══════════════════════════════════════════════════════════════════════════════
//  Effective group id — single source of truth for the forum supergroup
//
//  A numeric `ALLOWED_GROUP_ID` env locks the id and disables auto-pairing.
//  Otherwise the id starts `null` (pairing mode) and is adopted from
//  `state.json` at boot (see startBot) or set live by the pairing middleware
//  / `/pair`. Every runtime consumer reads `getAllowedGroupId()` so a
//  pairing event takes effect without a restart.
// ═══════════════════════════════════════════════════════════════════════════════

const isGroupLockedByEnv = Number.isFinite(ENV.allowedGroupId);
let effectiveGroupId: number | null = isGroupLockedByEnv ? ENV.allowedGroupId : null;

/** The forum supergroup id currently in effect, or `null` while unpaired. */
function getAllowedGroupId(): number | null {
  return effectiveGroupId;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Served-surface mode — group (supergroup) / dm (owner private chat) / both
//
//  Selected at boot by CHAT_MODE; `both` (the default) serves the group AND the
//  owner DM at once, decided PER CHAT. The surface a given update belongs to is
//  read off its resolved SessionKey: a DM key carries the owner's chat id
//  (`resolveDmThreadKey` enforces `chat.id === ownerUserId`), so
//  `checkIsDmKey(key)` is the per-chat discriminator that replaces the old
//  global `checkIsDmMode()`. Access authority stays per surface: the owner id
//  for a DM chat, the served group's admin cache for the group chat.
// ═══════════════════════════════════════════════════════════════════════════════

/** The served surface(s) in effect for this process (fixed at boot). */
function getChatMode(): ChatMode {
  return ENV.chatMode;
}

/** The owner's Telegram user id (DM access authority), or `NaN` when no DM owner. */
function getOwnerUserId(): number {
  return ENV.ownerUserId;
}

/**
 * @description Is the DM surface live in this process? True for `dm`, and for
 * `both` only when an OWNER_USER_ID is configured (otherwise the DM surface is
 * inert and the instance serves the group only). Always false for `group`. The
 * single gate `getThreadKey` consults before trying the owner-DM resolver.
 */
function checkIsDmSurfaceActive(): boolean {
  if (getChatMode() === 'group') return false;
  return !ENV.isDmSurfaceInert;
}

/**
 * @description Per-chat discriminator: does this resolved key belong to the DM
 * surface? Thin runtime wrapper over the pure {@link checkIsDmThreadKey}: a DM
 * key's `chatId` is the owner's user id, so the equality both identifies the
 * surface and re-asserts the owner. False when the DM surface is inert — so a
 * group-only `both` is always group.
 */
function checkIsDmKey(key: SessionKey): boolean {
  return checkIsDmThreadKey(key, getOwnerUserId(), checkIsDmSurfaceActive());
}

/**
 * @description Per-context discriminator for the gated sites that decide BEFORE a
 * key is resolved (access control). A DM chat is the owner's private chat: the
 * private-chat id equals the owner's user id, so the same equality both gates the
 * chat type and identifies the owner. False when the DM surface is inert.
 */
function checkIsDmChat(ctx: Context): boolean {
  if (!checkIsDmSurfaceActive()) return false;
  const chat = ctx.chat;
  if (!chat || chat.type !== 'private') return false;
  return chat.id === getOwnerUserId();
}

/**
 * The per-surface output transport, selected once at boot from CHAT_MODE
 * (`registerOutputTransport`, mirroring `registerDisplayPrefsReader`). The
 * output / status / teardown sites route through it instead of branching on the
 * surface themselves; in `both` it is a dispatcher that routes each call by
 * `checkIsDmKey(key)` to the DM or group impl. Null until boot wires it.
 */
let outputTransport: OutputTransport | null = null;

/** Wire the boot-selected output transport. Called once near the adapter wiring. */
function registerOutputTransport(transport: OutputTransport): void {
  outputTransport = transport;
}

/** The boot-selected output transport. Throws if read before boot wiring. */
function getOutputTransport(): OutputTransport {
  if (!outputTransport) {
    throw new Error('outputTransport accessed before registerOutputTransport at boot');
  }
  return outputTransport;
}

const telegramAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 10000,
  family: 4,
});
const bot = new Telegraf(ENV.botToken, { telegram: { agent: telegramAgent } });

// Decouple the long-polling intake/ACK from per-handler latency: wrap
// `bot.handleUpdate` so each update is enqueued into its thread's serial queue
// and the loop's `Promise.all` resolves at once (next `getUpdates` = ACK + new
// batch fires now). The real middleware chain — the two `bot.use` middlewares,
// every command/`on`/action, `bot.catch` — runs unchanged inside the captured
// original, just off-loop and per-thread-serial. MUST be installed before
// `bot.launch`. The graceful-shutdown path drains it (see `updateDrainTimeoutMs`).
const updateDispatcher = createUpdateDispatcher({
  getKey: getUpdateQueueKey,
  onError: (error, update) =>
    console.error(`[dispatch] unhandled error for update ${update.update_id}:`, error),
});
installUpdateDispatcher(bot, updateDispatcher);
/** Bound (well under the 10s shutdown watchdog) for draining queued updates on shutdown. */
const updateDrainTimeoutMs = 2000;

// Output-trace mode (toggled at runtime via `/trace`): record every outgoing
// Bot API call with its outcome at the single `callApi` chokepoint. Installed
// unconditionally — when tracing is off each call costs one boolean check.
// The buffered writer is flushed synchronously on process exit so the final
// window is not lost on shutdown.
installCallApiTrace(bot.telegram);
process.on('exit', flushTraceBufferSyncOnExit);

// Default every text message/edit to NO link preview: a bare URL in agent
// output otherwise expanded into a large preview card, one per message, in the
// muted topic (operator complaint 2026-09-07). Installed OUTSIDE the trace wrap
// so the trace records the payload actually sent.
installLinkPreviewSuppression(bot.telegram);

// ═══════════════════════════════════════════════════════════════════════════════
//  Access control — who may talk to the agent
//
//  Authority is fully runtime: the creator + administrators of the served forum
//  group. The set is read live via `getChatAdministrators` and cached for an
//  hour (lazy refresh on the first access after expiry); an admin-status change
//  in the group (`chat_member` update) invalidates the cache immediately, so a
//  demoted/left admin drops out on their next message — the TTL is only the
//  fallback. There is no static allow-list env and no /grant command.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * @description The Telegram connector's inbound side: the membership lookup the
 * access policy needs, and the normalization step that hands the core
 * platform-neutral events.
 */
const telegramInbound = createTelegramConnectorInbound({
  listAdministrators: (chatId) => bot.telegram.getChatAdministrators(chatId),
  getIdentity: () => ({ username: bot.botInfo?.username, userId: bot.botInfo?.id }),
});

/**
 * @description The Telegram connector's outbound side: the core delivers
 * semantic content, files and an activity state through this, and the connector
 * decides how Telegram renders, splits, pins and paces them.
 *
 * Every dependency is read lazily (through a closure) because the primitives it
 * routes to — the chat-mode transport, the file-send service — are wired later
 * in the boot sequence than this composition.
 */
const telegramOutbound = createTelegramConnectorOutbound({
  getOutputTransport,
  sendStandaloneMessage: (key, text, replyMarkup) =>
    replyChunkWithFallback(key, renderAgentHtml(text), text, replyMarkup),
  pinMessage: (key, messageId) => pinThreadQuestion(key, messageId),
  setTypingLoader: (key, isActive) => {
    if (isActive) startTypingLoader(key);
    else stopTypingLoader(key);
  },
  sendTypingPing: (key) => {
    sendThreadTypingIndicator(key).catch(() => {});
  },
  sendFiles: (threadKeyString, request) => sendFilesToThread(threadKeyString, request),
  encodeKey: keyToString,
});

const adminCache = new AdminCache({
  // Routed through the connector's membership lookup rather than calling
  // `getChatAdministrators` again here: two paths to the same API would let the
  // policy and the pairing check disagree about who counts as elevated.
  fetchElevatedMemberIds: () => {
    const groupId = getAllowedGroupId();
    // `[]` and not a rejection: with no served group there genuinely are no
    // elevated members, so this is an ANSWER, not a failed lookup (which must
    // reject — see `ConnectorInbound.listMembersWithElevatedRights`). Caching it
    // is safe because pairing calls `adminCache.invalidate()`.
    if (groupId === null) return Promise.resolve([]);
    return telegramInbound.listMembersWithElevatedRights(groupId.toString());
  },
  ttlMs: ADMIN_CACHE_TTL_MS,
});

/**
 * @description True iff the sender of `ctx` may use the bot — decided PER CHAT,
 * which is the single source of truth for access on each surface:
 *   - a DM chat (the owner's private chat) → the configured OWNER_USER_ID is the
 *     sole authority;
 *   - the group chat → a creator/admin of the served forum group (admin cache).
 * The owner-id / admin-cache split must stay per surface: gating a DM with the
 * group admins would let any group admin act in the owner's DM, and gating the
 * group with the owner id would lock out the group's real admins.
 */
async function checkIsAllowedUser(ctx: Context): Promise<boolean> {
  const userId = ctx.from?.id;
  if (!userId) return false;
  if (checkIsDmChat(ctx)) {
    return userId === getOwnerUserId();
  }
  const adminIds = await adminCache.getAdminIds();
  return adminIds.has(userId.toString());
}

/**
 * @description Direct (uncached) check that `userId` is a creator/administrator
 * of `chatId`. Used only at pairing time, where the served group isn't fixed yet
 * so the cache (keyed to the served group) doesn't apply. Returns `false` on any
 * API failure — pairing should fail closed.
 */
async function checkIsForumAdmin(chatId: number, userId: number): Promise<boolean> {
  try {
    const elevated = await telegramInbound.listMembersWithElevatedRights(chatId.toString());
    return elevated.includes(userId.toString());
  } catch (e) {
    console.warn(`[pair] getChatAdministrators(${chatId}) failed:`, e instanceof Error ? e.message : e);
    return false;
  }
}

// Output-trace `recv` hook — must be the FIRST middleware so every update is
// recorded before any gating (access control, group routing) can drop it.
// Security: while the thread awaits a `/connect` key paste (same
// `pendingProviderConnects` state the text handler consumes later in this
// update), the message text is a provider API key — the preview is redacted
// at record time so the secret never lands in the on-disk trace.
bot.use(async (ctx, next) => {
  const message = ctx.message;
  const messageText = message && 'text' in message ? message.text : undefined;
  const callbackData =
    ctx.callbackQuery && 'data' in ctx.callbackQuery ? ctx.callbackQuery.data : undefined;
  const threadKey = messageText === undefined ? null : getThreadKey(ctx);
  const isThreadPendingProviderConnect =
    threadKey !== null && pendingProviderConnects.has(keyToString(threadKey));
  traceRecvUpdate({
    updateType: ctx.updateType,
    updateId: ctx.update.update_id,
    fromId: ctx.from?.id,
    chatId: ctx.chat?.id,
    threadId: message?.message_thread_id,
    preview:
      messageText === undefined
        ? callbackData
        : getRecvTracePreview(messageText, isThreadPendingProviderConnect),
    tgDateSec: message?.date,
  });
  return next();
});

// Locale is a Telegram-chat concern, not a process env knob. Every update runs
// inside an async i18n context: explicit `/language` override for the DM/group
// wins, else this sender's Telegram `language_code`, else the last seen Telegram
// locale for that chat (for async bot-originated events), else English.
bot.use(async (ctx, next) => runWithLocale(getLocaleForContext(ctx), () => next()));

// Auto-pairing must run before any command / `on` handler so a freshly
// discovered group id is already in effect by the time the routing gates
// fire on the same update. Registered here (right after bot creation) to
// guarantee it precedes the module-scope handler registrations below.
bot.use(async (ctx, next) => {
  await tryAutoPair(ctx);
  return next();
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Constants
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * @description `GENERAL_THREAD_ID` is imported from `./threadRouting`
 * (the pure routing module owns it so unit tests can reach it without
 * booting Telegraf). Plan §4.3 point 3 / R2.
 */

/**
 * @description Update types the bot subscribes to (`allowed_updates` at
 * launch). `chat_member` is NOT in Telegram's default set and must be
 * requested explicitly — it drives the immediate admin-cache invalidation on
 * promotion/demotion in the served group. The rest reproduces exactly the
 * default-set types the registered handlers use (`message` covers text, voice,
 * media and the forum service messages; `callback_query` the inline buttons).
 * Telegram REMEMBERS `allowed_updates` between polls, so the full list must
 * ride every launch — a partial list would silently unsubscribe the rest.
 */
const botAllowedUpdates: UpdateType[] = [
  'message',
  'edited_message',
  'callback_query',
  'my_chat_member',
  'chat_member',
];

/**
 * @description The output debounce window in effect for this process. The
 * persist/`queueOutput` path is group-only in DM v2 (DM streams via the native
 * draft cursor and finalizes at boundaries), so there is one value left — the
 * group cadence. The constant lives in the pure `utils/outputDebounce` module so
 * it is unit-testable without booting Telegraf; the pure timing helper
 * `getOutputFlushTiming` just receives this value as its `normalDebounceMs`.
 */
function getOutputDebounceMs(): number {
  return resolveOutputDebounceMs();
}

/**
 * Tick cadence of the Claude liveness loop (bug #11). Re-checks `checkIsBusy`
 * and refreshes the activity frame this often. ~1s reads as alive during the
 * 300ms→1.5s scrape backoff and quiet thinking stretches, while staying at/below
 * Telegram's ~1 edit/sec/chat budget so the rolling frame never triggers a 429
 * storm. The coalescer + `lastSentText` dedup drop identical re-edits, so a
 * frozen spinner glyph costs zero Bot API calls.
 */
const CLAUDE_LIVENESS_TICK_MS = 1000;

/**
 * S1/S3: the BASE floor for how often the liveness loop RE-RENDERS+SENDS the
 * working-status frame (its live `m:ss` elapsed). Decoupled from
 * {@link CLAUDE_LIVENESS_TICK_MS} (the 1s idle-CHECK cadence) so the elapsed
 * advances visibly — proving "working" vs "hung" — without a per-second
 * `editMessageText` flood near Telegram's ~1 edit/sec/chat budget. A `create`
 * (no frame yet) bypasses this and shows immediately.
 *
 * S3: under a live 429 cooldown the actual throttle scales UP to the remaining
 * cooldown (`max(this, getRateLimitRemainingMs)` in {@link checkShouldSendLivenessFrame}),
 * mirroring the relay output debounce, so the status frame stops adding
 * `editMessageText` traffic to an already-throttling chat. The 3s→5s floor bump
 * further cuts the frame's baseline edit rate (the status frame was ~half the
 * 429-storm traffic, live 2026-06-29).
 */
const claudeWorkingStatusRefreshMs = 5000;

/**
 * S2: how long the scraped TUI pane may stay byte-identical before the liveness
 * loop treats the agent as idle and FORCE-removes the working-status frame
 * (the hard anti-hang net). A genuinely working agent repaints the pane every
 * second (animated spinner + the TUI's own elapsed timer), so 30s of a static
 * pane means the turn is over even if Claude's footer busy signal is stuck —
 * never trips mid-think. See {@link checkShouldForceIdleRemoval}.
 */
const claudeIdlePaneMs = 30_000;

/**
 * S2: how long the liveness loop keeps ticking after a busy-ONSET arm (a prompt
 * was just forwarded) while Claude's footer busy signal has not flipped yet.
 * Without this grace the first idle tick would self-stop the loop (idle, no
 * frame, nothing pending) before Claude starts thinking, so a long quiet think
 * would show NO working frame (the muted-topic "looks hung" bug). ~8s comfortably
 * spans the gap between submit and Claude going busy; once busy is observed the
 * grace is cleared and normal busy ticking owns the frame.
 */
const claudeBusyOnsetGraceMs = 8_000;

/**
 * Cadence of the dedicated OpenCode sub-agent status message's elapsed-counter
 * tick. One `editMessageText` per active delegation every 10 s — far under
 * Telegram's ~1 edit/sec/chat budget, so the live "m:ss" counter never costs a
 * 429. A failed edit just retries on the next tick.
 */
const subagentTickMs = 10_000;

/**
 * Hard upper bound on how long a dedicated sub-agent status message may stay
 * open. A session that dies SERVER-SIDE emits no clean `session.idle` / parent
 * `message.finish`, so the adapter's defensive close never fires and the
 * self-re-arming {@link subagentTickMs} timer would otherwise churn the frame
 * forever, tripping the per-group 429 flood limit and starving the topic (live
 * incident 2026-08-03). Sub-agent delegations here run ~3 min; 30 min is
 * generously above any realistic length, so this only ever fires on a genuinely
 * abandoned frame — never on a healthy in-flight delegation.
 */
const subagentStatusMaxAgeMs = 30 * 60 * 1000;

/**
 * Re-fire cadence of the native typing-indicator loader. Telegram's `typing`
 * chat action self-expires after ~5 s, so the sustained loader re-sends it on
 * this interval (comfortably under the expiry) to keep the dots visible for as
 * long as the agent is working. One `sendChatAction` per tick is negligible
 * against the rate budget.
 */
const typingLoaderRefreshMs = 4_000;

/**
 * Rotating spinner glyphs for the liveness frame's neutral fallback (used only
 * when no scraped activity line is available). Cycling them on each tick makes
 * the frame visibly alive even while the scrape is quiet. Mirrors the TUI's own
 * whimsical spinner set so the relayed indicator looks native.
 */
const CLAUDE_LIVENESS_GLYPHS = ['✻', '✽', '✶', '✢'] as const;

/**
 * Small slack added on top of the remaining 429 cooldown before a deferred
 * send is retried, so the retry fires *after* the cooldown has actually
 * lifted rather than racing its boundary. Shared by the status coalescer's
 * deferred-frame retry and the B14 interactive-reply redelivery.
 */
const COOLDOWN_RETRY_SLACK_MS = 250;

// ═══════════════════════════════════════════════════════════════════════════════
//  State store — singleton populated in startBot(), referenced by handlers
// ═══════════════════════════════════════════════════════════════════════════════

let state!: StateStore;

/**
 * @description The scheduler timer engine (S3), constructed in {@link startBot}.
 * Module-level so the `/unbind` pause path, the `/bind` resume path, and the
 * shutdown handler can reach `armJob` / `disarmJob` / `shutdown` without
 * threading the instance through every caller. `null` until boot wires it.
 */
let schedulerEngine: SchedulerEngine | null = null;
/**
 * The request wake-up engine (request/answer core S4), assigned once by
 * `startBot` after the request ledger loads. Module-level like
 * {@link schedulerEngine} because the cancel paths (`/esc`, `/c`, `/quit`,
 * `/quit-all`, `/new`, `/resume`, leaving the folder, switching the topic to
 * another agent or a shell) are module-level command handlers.
 */
let requestWakeUpEngine: RequestWakeUpEngine | null = null;
/** What the bot's own limit-wait answer needs (S5); set at boot next to the engine. */
let requestLimitWaitAnswerDeps: LimitWaitAnswerDeps | null = null;

/**
 * @description Resolve the live `DATA_DIR` from the state store. The store
 * owns `state.json` in that directory, so its parent is the single source of
 * truth for where bot-owned data (including intake files) lands.
 */
function getDataDir(): string {
  return path.dirname(state.stateFilePath);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Per-thread in-memory state
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * @description UI state per `SessionKey` — tracks the editable message id,
 * status indicator, and loader message used for the typing UX. Lives in
 * memory only (re-derived on bot restart from the next outgoing message).
 *
 * Persistent state — bindings, agent choice, message-id history — lives
 * in `state.json` via {@link StateStore}, not here.
 */
interface ThreadMessageState {
  /** Most recent assistant-message id we can edit in place. */
  lastMessageId: number | null;
  /** Source (pre-render) text currently shown in `lastMessageId` — the append base for streaming continuations. */
  lastMessageText: string | null;
  /** True when next output should send a new message instead of editing. */
  needsNewMessage: boolean;
  /**
   * The sole "agent is working" loader: a timer that re-fires the native typing
   * indicator (`sendChatAction('typing')`) while the bot waits for output (a
   * self-greeting boot, every prompt forward). `null` = no loader running.
   * Re-fired because Telegram's typing action self-expires after a few seconds.
   * Cleared ONLY by a real event (first output / status / question / teardown /
   * start-fail) — never by a timeout, so a long-thinking agent keeps the loader.
   */
  typingLoaderTimer: NodeJS.Timeout | null;
  /** Transient status/spinner message id — replaced by permanent text. */
  statusMessageId: number | null;
  /**
   * Thinking (chain-of-thought) message id — owned independently of
   * {@link statusMessageId} so the live "☁️ thinking …" indicator can persist
   * across tool-status churn. Lifecycle per the thinking
   * {@link DisplayVerbosityMode}: edited live while reasoning, then (per mode)
   * collapsed to "💭 thought for {N}s", left as-is, or deleted when the answer
   * starts. `null` = no thinking message. The accumulated reasoning text
   * mirrors what the adapter sent, so a `full`-mode live frame can re-render
   * the full body on each edit.
   */
  thinkingMessageId: number | null;
  /**
   * Monotonic generation for the thinking-message lifecycle, bumped on every
   * {@link clearThinkingMessage} (session end / question takeover). A create in
   * flight captures it before its `await` and re-checks after: a clear that
   * lands mid-create bumps the generation, so the just-created message is
   * DELETED instead of resurrecting `thinkingMessageId` as an orphan under the
   * "session ended" / question UI. (Mirror of {@link statusFrameGeneration} —
   * the persist path `finishThinkingMessage` does NOT bump it, so a normal
   * collapse/keep leaves the message in the chat.)
   */
  thinkingFrameGeneration: number;
  /**
   * Monotonic generation for the status-frame lifecycle, bumped on every
   * `deleteStatusMessage`. `sendStatusFrame` captures it before creating a new
   * message and re-checks after the `await` (see `getStatusFrameStoreDecision`):
   * a delete that lands mid-create bumps the generation, so the just-created
   * message is discarded instead of resurrecting `statusMessageId` as an orphan.
   * The anti-thrash guard that keeps the spinner a SINGLE, reliably-removed frame.
   */
  statusFrameGeneration: number;
  /**
   * Claude liveness loop (bug #11): a self-disarming per-thread timer that keeps
   * an activity frame on screen for the WHOLE busy period, driven by
   * `checkIsBusy` rather than opportunistic scrape emits. `null` = no loop armed.
   */
  livenessTimer: NodeJS.Timeout | null;
  /**
   * Latest activity text the Claude scrape produced (the `✻ Verb… (Ns · tokens)`
   * line), fed in from `handleAdapterStatus`. The liveness frame prefers this
   * over the neutral `agent.workingIndicator` fallback. `null` = none seen yet.
   */
  lastActivityText: string | null;
  /** Rotating index into {@link CLAUDE_LIVENESS_GLYPHS} for the fallback frame. */
  livenessGlyphIndex: number;
  /** Last `checkIsBusy` reading, so the loop can detect a busy→idle edge. */
  wasBusy: boolean;
  /**
   * Epoch ms the current busy turn started — the base for the working-status
   * frame's live `m:ss` elapsed (S1 un-freeze). Set when the liveness loop arms
   * a FRESH turn (idle→busy edge) and reset when a new prompt is forwarded;
   * cleared (`null`) when the loop stops, so the next turn restarts at 0:00.
   * Held STABLE across a turn's output-delete→recreate churn so the counter
   * stays monotonic within the turn.
   */
  workingSince: number | null;
  /**
   * Epoch ms the liveness loop last RE-RENDERED+SENT the working frame, gating
   * the {@link claudeWorkingStatusRefreshMs} send throttle so the 1s idle-CHECK
   * tick does not push a per-second `editMessageText`. `0` = never sent this
   * process; a fresh turn's first tick always passes (its base is far in the past).
   */
  lastLivenessSentAt: number;
  /**
   * Idle-removal latch (S2): set true when the loop force-removed the frame
   * because the scraped pane went static for ≥ {@link claudeIdlePaneMs}. While
   * latched the loop must NOT recreate a working frame (the hard guarantee: a
   * finished/idle agent never leaves a status hanging). Cleared when a new
   * prompt is forwarded / the loop next arms a fresh turn — so the status is
   * not recreated until genuine new activity re-arms it.
   */
  statusIdleSuppressed: boolean;
  /**
   * Busy-onset arming grace deadline (epoch ms), S2: set when the liveness loop
   * is armed by a freshly-forwarded prompt (not a scrape emit). Until Claude's
   * footer busy signal flips — or this deadline passes — the loop keeps ticking
   * instead of self-stopping on the first idle reading, so a long quiet think
   * still shows a working frame. `0` = not in a busy-onset grace. Cleared the
   * moment busy is observed and on teardown.
   */
  busyOnsetArmedUntil: number;
  /**
   * Dedicated OpenCode sub-agent (delegation) status message id, owned
   * INDEPENDENTLY of {@link statusMessageId} (the fix for the flood bug — the
   * shared status re-`sendMessage`d a new message on every child-text burst).
   * The `minimal`/`short` `/subagent` "working" indicator: ONE message, edited
   * in place with a ticking elapsed counter. `null` = none open. Created on
   * delegation start, deleted on its end / session teardown / question takeover.
   */
  subagentStatusMessageId: number | null;
  /**
   * Epoch ms when the current sub-agent status message opened — the base for
   * the elapsed `m:ss` counter. `null` when no message is open.
   */
  subagentStartedAt: number | null;
  /**
   * Sticky last non-null delegation title for the open sub-agent status
   * message, re-rendered on every elapsed tick. `null` = the delegation never
   * carried a title (falls back to the generic label at render time).
   */
  subagentTitle: string | null;
  /**
   * Self-re-arming unref'd timer that re-edits the sub-agent status message
   * with the updated elapsed time every {@link subagentTickMs}. `null` = not
   * armed (no message open). Mirrors {@link livenessTimer}'s lifecycle.
   */
  subagentTimer: ReturnType<typeof setTimeout> | null;
  /**
   * Last text the sub-agent status refresh DECIDED to enqueue — recorded
   * synchronously at decision time, not after the send resolves (S1' coalescing
   * dedup, see {@link checkShouldEnqueueSubagentStatus}). `refreshSubagentStatus`
   * skips the edit when the freshly rendered line equals this. Recording it at
   * decision time (rather than the old "last delivered" semantics) is what stops
   * a burst of same-second refreshes from stacking identical `editMessageText`
   * closures into the per-thread FIFO while the pacer drains them one every 2s —
   * that backlog head-of-line-blocked the agent's own answer and hung the topic
   * (live 2026-08-07; earlier 400-churn variant 2026-08-03). `null`
   * on open / post-clear so the first real edit always lands.
   */
  lastSubagentText: string | null;
  /**
   * Whether a sub-agent status `editMessageText` is currently in flight (from
   * {@link refreshSubagentStatus} enqueue to resolve). Guards against enqueuing a
   * second edit while one is still draining the pacer — the coalescing half of
   * the fix above; at most ONE status edit rides the FIFO at a time. `false` when
   * idle / no message open.
   */
  subagentEditInFlight: boolean;
}

interface OutputQueueState {
  pendingOutput: string | null;
  /** Whether the FIRST batch in `pendingOutput` continues the last sent message. */
  pendingIsContinuation: boolean;
  isProcessing: boolean;
  debounceTimer: NodeJS.Timeout | null;
}

/**
 * @description Per-thread coalescer for `status` (thinking / spinner) events.
 *
 * Claude's tmux poller can emit a status update every ~300 ms while the
 * agent is thinking, and each one used to translate into its own
 * `editMessageText` call going through the rate-limiter FIFO. A burst of
 * 10 thinking-text changes would put 10 edit operations into the queue —
 * and any real `output` arriving in the middle of that burst had to wait
 * behind them all (this was the "thinking blocks output even within one
 * thread" symptom).
 *
 * The coalescer enforces "at most one status send in flight per thread"
 * and "latest text always wins":
 *
 * - When a status arrives, `pendingText` is overwritten unconditionally.
 *   Stale intermediate frames are dropped before they ever reach Telegram.
 * - If no flush is currently running, one is started; otherwise the
 *   in-flight flush will pick up the new text after it finishes the
 *   current send.
 * - When real `output` arrives (`handleAgentOutput`), `pendingText` is
 *   cleared — there's no point sending a "Thinking…" frame that the
 *   output is about to replace anyway.
 */
interface StatusCoalesceState {
  /** Latest status text not yet sent. `null` = nothing pending. */
  pendingText: string | null;
  /** A `flushStatusCoalescer` loop is currently running. */
  inFlight: boolean;
  /**
   * Last status frame that actually reached Telegram for this thread.
   * Lets the flush loop skip a re-send of identical text (which only earns
   * a `400 "message is not modified"` and wastes a send-budget token).
   */
  lastSentText: string | null;
  /**
   * Armed timer that resumes a flush deferred during a 429 cooldown. While
   * set, new status events only refresh `pendingText` (the newest frame
   * wins) instead of arming a second timer. `null` = none armed.
   */
  deferRetryTimer: NodeJS.Timeout | null;
}

/**
 * @description Per-thread coalescer for the live "☁️ thinking …" indicator.
 *
 * The OpenCode reasoning stream is chatty: even after the adapter's 400 ms
 * debounce, a long chain-of-thought emits many `live` frames. Routing each one
 * into its own `editMessageText` would burn the chat-wide send budget that
 * real output and interactive replies need. The coalescer enforces "at most one
 * thinking edit in flight per thread" and "latest frame wins" (same shape as
 * {@link StatusCoalesceState} but for the dedicated thinking message id).
 */
interface ThinkingCoalesceState {
  /** Latest rendered thinking-frame HTML not yet sent. `null` = nothing pending. */
  pendingHtml: string | null;
  /** A `flushThinkingCoalescer` loop is currently running. */
  inFlight: boolean;
  /** Last frame that actually reached Telegram — skip an identical re-send. */
  lastSentHtml: string | null;
  /**
   * When `true`, the pending frame is the response's FINAL one (the short-mode
   * "thought for {N}s" collapse). The flush loop edits it onto the SAME message,
   * THEN detaches the tracked id (`finishThinkingMessage`) — doing the detach
   * before the edit would make the collapse create a new message instead of
   * replacing the live indicator in place.
   */
  detachAfterDrain: boolean;
}

const threadMessageStates = new Map<string, ThreadMessageState>();
const outputQueues = new Map<string, OutputQueueState>();
const pendingQuestions = new Map<string, PendingQuestionState>();
/**
 * @description Per-thread id of the question message currently PINNED in the
 * topic (in-memory only). A pinned message pierces a MUTED topic, so pinning the
 * pending question is how the operator — who keeps every topic muted — gets a
 * Telegram notification about it. Source of truth for {@link unpinThreadQuestion};
 * re-established after a restart by the OpenCode persisted-`messageId` fallback
 * and Claude's live re-scrape, so it needs no persistence of its own.
 */
const questionPinnedMessageId = new Map<string, number>();
/**
 * @description Placeholder stored in a pinned-notice map ({@link
 * authNoticePinnedMessageId}, {@link limitResumeNoticePinnedMessageId}) between
 * reserving the one-notice slot and the pin landing, so a burst of events can't
 * race two notices out. A real Telegram message id is always positive, so `-1` can
 * never collide with one.
 */
const pinnedNoticePendingSentinel = -1;
/**
 * @description Per-thread id of the PINNED "logged-out" notice (in-memory). Its
 * presence is ALSO the one-notice-per-logout-episode guard: while set, a repeat
 * `apiError('auth')` is a no-op. Deliberately SEPARATE from
 * {@link questionPinnedMessageId} — an auth notice must never clobber a real
 * pending question's pin. Cleared (and the message unpinned) on recovery (the
 * first real output after re-login) and at the session-END / teardown sites
 * (session closed/stopped, `/new` release, `/quit`, leaving the folder) — but
 * NOT at the user-takeover {@link cancelApiRetry} sites, which must not
 * re-notify (see the NOTE in {@link cancelApiRetry}).
 */
const authNoticePinnedMessageId = new Map<string, number>();
/**
 * @description Per-thread id of the PINNED "the limit reset, work resumed" notice
 * (in-memory). A limit wait can run for hours in a MUTED topic, so the one message
 * announcing that work is moving again is pinned WITH a notification — the pin is
 * the only thing that pierces mute. Its presence doubles as the one-pin-per-episode
 * guard. Retired (unpinned, guard dropped) by {@link cancelApiRetry}, i.e. on the
 * thread's next genuine user message and at every session-end / teardown site, so
 * pins never accumulate one per episode.
 */
const limitResumeNoticePinnedMessageId = new Map<string, number>();
/**
 * @description Threads that already got the "auto-continue is OFF for this topic"
 * notice for the CURRENT limit episode. Without it every repeated limit frame
 * (Claude re-scrapes, OpenCode can repeat `session.error`) would post the notice
 * again — the arming path gets that dedup for free from `decideRetryAction`'s
 * `pending` check, but the OFF path arms nothing and so needs its own guard.
 * Cleared by {@link cancelApiRetry} (the user took over / the session went away).
 */
const autoContinueOffNoticedThreads = new Set<string>();
const threadModelLists = new Map<string, string[]>();
const awaitingModelSelection = new Set<string>();
const statusCoalescers = new Map<string, StatusCoalesceState>();
const thinkingCoalescers = new Map<string, ThinkingCoalesceState>();

/**
 * @description Per-thread backstop against a runaway flood of byte-identical
 * PERMANENT output (flood 2026-06-16: a Claude topic re-emitted one table ~500
 * times). Defense-in-depth behind the table-emit root-cause fix (S1) — caps ANY
 * emit path that re-sends the same large block. Reset on every session
 * stop/closed/unbind via `clearThreadQueues`. See `utils/identicalOutputGuard`.
 */
const identicalOutputGuard = createIdenticalOutputGuard();

/**
 * @description Register/replace a thread's pending interactive question in BOTH
 * the in-memory `pendingQuestions` map and the persisted store, so a restart
 * can restore it (the in-memory map is otherwise lost — see `state.ts`). Single
 * choke point for every `pendingQuestions.set(...)` / `messageId` patch so the
 * two copies never drift. The store write is debounced + fire-and-forget; the
 * in-memory set is what the live button handlers read, so it must be synchronous.
 */
function setPendingQuestion(key: SessionKey, value: PendingQuestionState): void {
  pendingQuestions.set(keyToString(key), value);
  state.setPendingQuestion(key, value).catch(e =>
    console.error('[pendingQuestion] persist failed:', e),
  );
}

/**
 * @description Drop a thread's pending interactive question from BOTH the
 * in-memory map and the persisted store. Single choke point for every
 * `pendingQuestions.delete(...)` so memory and disk stay in lockstep.
 */
function clearPendingQuestion(key: SessionKey): void {
  const kStr = keyToString(key);
  // Post-restart OpenCode: the in-memory pin map was lost on restart but the
  // question message is still pinned on Telegram (its id lives on the persisted
  // `pendingQuestions` entry). Seed the map from it so the unpin below finds the
  // id — deterministic, with no reliance on sync execution order against the
  // `delete` that follows. The live case is a no-op (the map already holds the
  // id; `has` is true).
  const pending = pendingQuestions.get(kStr);
  if (pending?.messageId != null && !questionPinnedMessageId.has(kStr)) {
    questionPinnedMessageId.set(kStr, pending.messageId);
  }
  void unpinThreadQuestion(key);
  pendingQuestions.delete(kStr);
  state.clearPendingQuestion(key).catch(e =>
    console.error('[pendingQuestion] clear failed:', e),
  );
  clearQuestionRepostState(key);
}

// ── keep a pending question at the bottom of its topic (plan S3) ──

/**
 * @description Per-thread bookkeeping for the "keep the question at the bottom"
 * re-post (S3). `wasLastSendTheQuestion` is the loop guard: true right after the
 * question is (re-)posted, flipped false by {@link onThreadActivityWhileQuestionPending}
 * as soon as anything else is sent below it. `repostTimer` debounces a burst of
 * output into ONE re-post.
 */
interface QuestionRepostState {
  wasLastSendTheQuestion: boolean;
  repostTimer: NodeJS.Timeout | null;
  /**
   * True while {@link postPendingQuestionAt} is between starting its send and
   * storing the new `messageId`. The re-post path must not run in that window:
   * it would read the PREVIOUS question's `messageId` and delete the wrong
   * message (live race 2026-06-10 — answered-Q1 "✅" deleted, Q2 duplicated).
   */
  isPostInFlight: boolean;
}

const questionRepostStates = new Map<string, QuestionRepostState>();

/**
 * Per-thread serial queues for QUESTION-LIFECYCLE transitions (initial post,
 * re-post-to-bottom, answer→advance→post-next). Each transition spans several
 * awaited sends through the rate-limited send queue, so two transitions
 * running concurrently interleave across SECONDS — live race 2026-06-10: a
 * re-post armed by output below the question executed its delete AFTER the
 * user had already answered, removing the message the answer path was about
 * to ✅-edit ("message to edit not found") and orphaning/duplicating posts.
 * Serializing the transitions makes each one see the other's COMPLETED state.
 * Entries are tiny (an idle queue holds one resolved promise) and bounded by
 * the number of topics, so they are never evicted.
 */
const questionLifecycleQueues = new Map<string, SerialQueue>();

function runQuestionLifecycleOp<T>(key: SessionKey, op: () => Promise<T>): Promise<T> {
  const kStr = keyToString(key);
  let queue = questionLifecycleQueues.get(kStr);
  if (!queue) {
    queue = createSerialQueue();
    questionLifecycleQueues.set(kStr, queue);
  }
  return queue.run(op);
}

/**
 * Debounce window for the S3 re-post: a busy sub-agent streams many chunks back
 * to back; collapse the whole burst into a single delete+re-post of the
 * question instead of thrashing it per chunk.
 */
const questionRepostDebounceMs = 1_200;

function getQuestionRepostState(key: SessionKey): QuestionRepostState {
  const kStr = keyToString(key);
  let s = questionRepostStates.get(kStr);
  if (!s) {
    s = { wasLastSendTheQuestion: false, repostTimer: null, isPostInFlight: false };
    questionRepostStates.set(kStr, s);
  }
  return s;
}

function clearQuestionRepostState(key: SessionKey): void {
  const s = questionRepostStates.get(keyToString(key));
  if (s?.repostTimer) clearTimeout(s.repostTimer);
  questionRepostStates.delete(keyToString(key));
}

/**
 * @description Record that the question message itself was just (re-)posted —
 * so the next {@link onThreadActivityWhileQuestionPending} knows the question is
 * currently at the bottom and must NOT re-post in reaction to its own send (the
 * loop guard). Called by {@link postPendingQuestionAt} after a successful send.
 */
function markQuestionMessageSent(key: SessionKey, _messageId: number): void {
  const s = getQuestionRepostState(key);
  s.wasLastSendTheQuestion = true;
}

/**
 * @description Hook called right after ANY non-question output is sent into a
 * topic (agent output, status frame, sub-agent/tool emit, api-retry notice).
 * If a question is pending and it is no longer the last message, schedule a
 * debounced re-post so the question returns to the bottom (S3). Cheap no-op when
 * no question is pending — safe to call from every emit handler.
 */
function onThreadActivityWhileQuestionPending(key: SessionKey): void {
  if (!pendingQuestions.has(keyToString(key))) return;
  const s = getQuestionRepostState(key);
  // Something other than the question just landed below it.
  s.wasLastSendTheQuestion = false;
  if (!checkShouldRepostPendingQuestion({
    isQuestionPending: true,
    wasLastSendTheQuestion: s.wasLastSendTheQuestion,
    isQuestionPostInFlight: s.isPostInFlight,
  })) {
    return;
  }
  // Debounce: a burst of output re-posts the question ONCE, not per chunk.
  if (s.repostTimer) clearTimeout(s.repostTimer);
  s.repostTimer = setTimeout(() => {
    s.repostTimer = null;
    void withThreadLocale(key, () => repostPendingQuestionToBottom(key));
  }, questionRepostDebounceMs);
}

/**
 * @description Re-post the current pending question as the newest thread message
 * (S3): delete the old question message, then send the current question again
 * via {@link postPendingQuestionAt} (which re-renders with S1 descriptions /
 * S2 current index and re-owns `messageId`). No-op if the question was answered
 * meanwhile, or if it is already the last message (the loop guard re-checked at
 * fire time, since the debounce window may have closed the gap).
 */
async function repostPendingQuestionToBottom(key: SessionKey): Promise<void> {
  // Serialized with the other lifecycle transitions; all guards re-read state
  // INSIDE the critical section, since the world may have moved on between
  // the debounce arming and this op's turn in the queue.
  await runQuestionLifecycleOp(key, async () => {
    const kStr = keyToString(key);
    const pending = pendingQuestions.get(kStr);
    if (!pending) return;
    const s = getQuestionRepostState(key);
    if (s.wasLastSendTheQuestion) return; // already at the bottom — nothing to do
    // A post that started during the debounce window owns `messageId` —
    // deleting based on the stale value would remove the previous (answered)
    // question's message (the live 2026-06-10 race).
    if (s.isPostInFlight) return;
    const oldMessageId = pending.messageId;
    if (oldMessageId !== null) {
      await deleteThreadMessage(key, oldMessageId);
    }
    await postPendingQuestionAt(key);
  });
}

// ── auto-retry after a provider-side API error (plan S4/S5/S6) ──

/** One minute in ms — used only to render the "in N min" notices. */
const apiRetryMsPerMinute = 60_000;

const apiRetryTimers = new Map<string, ApiRetryTimerEntry>();

/**
 * @description Drop the thread's saved retry (`state.json` `apiRetries`). The saved
 * record means ARMED: it is set when a retry is armed and cleared whenever the
 * retry stops being armed — a cancel, a give-up, or a kick that ran its course — so
 * a restart never restores a retry that is already spent.
 */
function clearSavedApiRetry(key: SessionKey): void {
  void state.clearApiRetry(key).catch(e => console.error('[apiRetry] clear failed:', e));
}
/**
 * Threads whose retry timer FIRED and whose "continue" nudge is not forwarded
 * yet ({@link fireApiRetry}). The retry is no longer armed then, but the idle
 * the error left behind is still not a turn end — the request wake-up probe
 * reads this set so it never reminds on top of the nudge.
 */
const apiRetryKicksInFlight = new Set<string>();

/**
 * @description `fireAt` of the thread's currently PENDING usage-limit resume, or
 * `null` when none is armed. Scoped to the `usageLimit` class on purpose: «skip
 * once» belongs to the limit feature, and the short transient retries are not
 * user-controllable at all. A record whose timer already fired (`timer === null`)
 * is history, not something to skip.
 */
function getArmedLimitRetryFireAt(key: SessionKey): number | null {
  const entry = getArmedApiRetry(key);
  if (!entry || entry.kind !== 'usageLimit') return null;
  return entry.fireAt;
}

/**
 * @description The thread's API-error retry or usage-limit wait while it is still
 * ARMED, else `null`. A record whose timer already fired stays in
 * {@link apiRetryTimers} for its grace window (see {@link fireApiRetry}) — it is
 * history, not a wait in progress.
 */
function getArmedApiRetry(key: SessionKey): ApiRetryTimerEntry | null {
  const entry = apiRetryTimers.get(keyToString(key));
  return entry && entry.timer !== null ? entry : null;
}

/**
 * Prompts held during an armed usage-limit wait (Jira plan R23), in `state.json`
 * apart from the retry record so they outlive a wait that ends without its
 * resume. Released by {@link forwardPromptToAgent} (they ride the first prompt
 * forwarded after the wait) and by {@link replayBufferedPrompts} (a new session).
 */
const limitHeldPrompts = new LimitHeldPromptQueue({
  store: {
    getLimitHeldPrompts: (key) => state.getLimitHeldPrompts(key),
    setLimitHeldPrompts: (key, prompts) => state.setLimitHeldPrompts(key, prompts),
  },
  checkIsLimitWaitArmed: (key) => getArmedApiRetry(key)?.kind === 'usageLimit',
});

/**
 * Last RAW prompt forwarded to each thread (pre-preamble), kept so a wedged
 * OpenCode session (accepted a prompt but ran no turn) can be recovered by
 * restarting fresh and replaying it. Slash commands and recovery replays are
 * not cached (see {@link forwardPromptToAgent}).
 */
const lastForwardedPrompt = new Map<string, string>();
/**
 * Per-thread wedge-recovery tier: how many recovery attempts were already made
 * for the CURRENT prompt episode. Escalates resend(0) → fork(1) → restart(2) →
 * give-up, one attempt each, so the last dialog is preserved when possible and a
 * persistently-wedging session can't loop. Reset (deleted) when a genuine new
 * prompt is forwarded. See {@link decideWedgeRecovery}.
 */
const wedgeRecoveryTier = new Map<string, number>();
/**
 * Threads whose wedge recovery ({@link handleNoResponse}) is under way: from the
 * `noResponse` event until the replay was forwarded (or the recovery gave up).
 * The request wake-up probe reads it as "not a turn end" — the wedged idle looks
 * like one, and a reminder on top would be a second recovery of the same turn.
 */
const wedgeRecoveriesInFlight = new Set<string>();

/**
 * @description `apiError` from the adapter — arm (or escalate) an auto-retry, or
 * give up. The pure decision lives in {@link decideRetryAction}; this handler is
 * the I/O shell: it posts the class-specific notice, persists the armed record,
 * and arms one unref'd timer whose fire callback is {@link fireApiRetry}.
 *
 * Dedup is delegated to `decideRetryAction` (a `pending` retry → `ignore`), so a
 * repeated Claude scrape frame or a duplicate `session.error` never double-arms.
 *
 * `/auto_continue_limits` gates the `usageLimit` class ONLY: with it OFF the bot says so
 * once per topic (and once per open request, which also stops being woken) and
 * stops, arming nothing and persisting nothing. `transient` (the short
 * 5/10/20-min retries) and `auth` (surfaced, never retried) are untouched by the
 * toggle — a rate-limit hiccup always wants the automatic retry.
 */
function handleApiError(key: SessionKey, cls: AgentApiErrorClass): void {
  const k = keyToString(key);
  if (cls.kind === 'usageLimit' && !state.checkIsAutoContinueOnLimitEnabled(key)) {
    const isFirstOffNotice = !autoContinueOffNoticedThreads.has(k);
    autoContinueOffNoticedThreads.add(k);
    // Each repeat is offered to the open request: the dedup is per request, so one
    // opened after the first notice still hears about the limit (and is stopped).
    const wait: UsageLimitWait = { kind: 'autoResumeOff' };
    void announceLimitWait(key, wait, getLimitWaitTexts(key, wait, 0), isFirstOffNotice);
    return;
  }
  const entry = apiRetryTimers.get(k);
  const prev = entry
    ? { attempt: entry.attempt, firedAt: entry.firedAt, pending: entry.timer !== null }
    : null;

  const action = decideRetryAction({
    kind: cls.kind,
    resetAt: cls.resetAt,
    now: Date.now(),
    prev,
  });

  // auth / logged out → surface a pinned notice (never a timer). Deduped to one
  // notice per episode inside `surfaceLoggedOutNotice`.
  if (action.action === 'surface') {
    void surfaceLoggedOutNotice(key);
    return;
  }

  if (action.action === 'ignore') return;

  if (action.action === 'giveUp') {
    void replyToThread(key, t('apiRetry.giveUp', { attempts: action.attempts }));
    clearSavedApiRetry(key);
    apiRetryTimers.delete(k);
    // Nothing resumes this limit any more: a reminder would hit it and arm a fresh episode, endlessly.
    if (cls.kind === 'usageLimit') void requestWakeUpEngine?.stopWakingForLimitWait(key);
    return;
  }

  // action === 'arm'. A LIMIT notice ends with the shared pointer at
  // `/auto_continue_limits` (the escape hatch: skip this one resume, or turn the
  // mode off). The transient notice gets none — it is not governed by the toggle
  // and resumes within minutes anyway.
  let limitWait: UsageLimitWait | undefined;
  if (cls.kind === 'usageLimit') {
    // A previous episode's pinned "work resumed" notice is stale now (we are
    // limited again) → retire it, which also re-opens the one-pin guard so THIS
    // episode's resume pins and notifies again. Without it the guard survived
    // across episodes whenever no user message intervened — exactly the
    // autonomous case this feature exists for — leaving the old pin up and the
    // next resume silent.
    clearLimitResumeNotice(key);
    limitWait = cls.resetAt !== undefined
      ? { kind: 'afterReset', resetAt: cls.resetAt, fireAt: action.fireAt }
      : { kind: 'nextAttempt', fireAt: action.fireAt };
    void announceLimitWait(key, limitWait, getLimitWaitTexts(key, limitWait, action.attempt), true);
  } else {
    void replyToThread(key, t('apiRetry.transientNotice', {
      minutes: Math.round(action.delayMs / apiRetryMsPerMinute),
      attempt: action.attempt,
    }));
  }

  // S3: the notice landed below any pending question — bring it back to the
  // bottom (debounced; no-op when no question is pending).
  onThreadActivityWhileQuestionPending(key);

  void state
    .setApiRetry(key, { kind: cls.kind, attempt: action.attempt, fireAt: action.fireAt })
    .catch(e => console.error('[apiRetry] persist failed:', e));

  const delayMs = Math.min(action.delayMs, maxTimeoutMs);
  const timer = setTimeout(() => {
    void fireApiRetry(key);
  }, delayMs);
  timer.unref?.();
  apiRetryTimers.set(k, {
    timer,
    attempt: action.attempt,
    kind: cls.kind,
    firedAt: null,
    fireAt: action.fireAt,
    limitWait,
  });
}

/**
 * @description R23: hold a prompt that arrives while `key` waits out an ARMED
 * usage limit — posting it would only hit the limit again. `false` when no
 * usage-limit wait is armed: post as usual. The open request's own prompt is
 * not copied into {@link limitHeldPrompts}: its request keeps it (R21), the
 * resume posts it from there, and a request superseded meanwhile is never posted.
 */
function holdPromptForLimitResume(key: SessionKey, text: string, heldText?: string): boolean {
  if (getArmedApiRetry(key)?.kind !== 'usageLimit') return false;
  if (requestLimitWaitAnswerDeps?.ledger.getOpenRequest(key)?.prompt === text) {
    console.log(`[apiRetry] ${keyToString(key)}: request held until the usage-limit wait resumes`);
    return true;
  }
  return limitHeldPrompts.holdPrompt(key, text, heldText);
}

/**
 * @description The retry kick (timer callback): make sure a session is up (after
 * an OpenCode `session.error` it still is, so `ensureAgentSession` is a no-op and
 * the nudge lands in the SAME live session — context intact; only a
 * genuinely-dead session is restarted via the thread's last adapter), tell the
 * user we're resuming, then hand over a neutral "continue" nudge. With no session
 * to resume the topic gets the reason instead, and nothing is forwarded. The kick
 * itself lives in `apiRetryKick.ts`, on the ports {@link apiRetryKickDeps}.
 *
 * CRITICAL: the nudge goes through the prompt path ({@link deliverPromptOrBuffer}),
 * NEVER a scheduler wait-for-idle path — OpenCode's optimistic `isBusy` is not
 * cleared on `session.error`, so a wait-for-idle kick would stall the full 10-min cap.
 *
 * The IN-MEMORY entry is intentionally KEPT after firing (timer nulled, `firedAt`
 * stamped): a recurrence within the grace window re-arms at attempt+1 via
 * {@link handleApiError}; a recovery leaves a harmless stale entry that the next,
 * later error resets to attempt 1. The SAVED record is not: it means ARMED, so the
 * kick clears it once it has run its course ({@link clearSavedApiRetry}), or a
 * restart would restore it and fire the kick again. A nudge still waiting in the
 * startup buffer has not run its course — the buffer is in memory and a restart loses
 * it — so the record stays until the buffer replays or drops the nudge.
 *
 * The notice differs by class: a `usageLimit` wait can have lasted hours, so its
 * resume is the PINNED, notifying {@link surfaceLimitResumedNotice} (the operator
 * keeps topics muted and wants to know work restarted). The `transient` retries
 * fire every few minutes and stay a plain line — pinning those would notify
 * relentlessly.
 */
async function fireApiRetry(key: SessionKey): Promise<void> {
  return withThreadLocale(key, () => runApiRetryKick(apiRetryKickDeps, key));
}

/**
 * The ports of the retry kick (`apiRetryKick.ts`): the bot's own retry map and
 * in-flight set, and what the kick does to the world.
 */
const apiRetryKickDeps: ApiRetryKickDeps = {
  entries: apiRetryTimers,
  kicksInFlight: apiRetryKicksInFlight,
  now: () => Date.now(),
  resumeOwnSession: resumeOwnSessionUnlessStarting,
  ensureSession: (key) => ensureAgentSession(key),
  postTopicNotice: (key, notice) => {
    if (notice.kind === 'noSession') void replyToThread(key, notice.message);
    else if (notice.retryKind === 'usageLimit') void surfaceLimitResumedNotice(key);
    else void replyToThread(key, t('apiRetry.resuming'));
  },
  getResumeMessage: (key, retryKind) => getLimitResumeMessage({
    continueNudge: t('apiRetry.continueNudge'),
    untakenRequestPrompt: retryKind === 'usageLimit'
      ? getPromptNotTakenIn(requestLimitWaitAnswerDeps?.ledger.getOpenRequest(key))
      : undefined,
  }),
  // `ensureAgentSession` is already satisfied by a start ANOTHER caller has under way — the session is
  // not there to take the nudge yet, so it goes through the startup buffer, not straight to the adapter.
  // The buffer is in memory: the kick keeps the saved record until the buffer settles the nudge.
  deliverNudge: (key, text, onBufferedSettled) => deliverPromptOrBuffer(key, text, startupPromptBuffer.checkIsStarting(keyToString(key)), onBufferedSettled),
  trackContinuation: async (key, options) => {
    await requestWakeUpEngine?.trackContinuationTurn(key, options);
  },
  clearSavedRetry: clearSavedApiRetry,
};

/**
 * @description Post a usage-limit wait (request/answer core S5): as the bot's own
 * `progress` answer to the open request when there is one — it REPLACES the plain
 * notice, which would say the same thing twice. The plain notice goes out only
 * when it is due (`isPlainNoticeDue`) and no answer said it — no open request,
 * or the answer could not be delivered.
 */
async function announceLimitWait(
  key: SessionKey,
  wait: UsageLimitWait,
  texts: LimitWaitTexts,
  isPlainNoticeDue: boolean,
): Promise<void> {
  let outcome: LimitWaitAnswerOutcome = 'notAnswered';
  if (requestLimitWaitAnswerDeps) {
    try {
      outcome = await answerOpenRequestForLimitWait(requestLimitWaitAnswerDeps, key, wait, texts.answerBody);
    } catch (e) {
      console.warn('[requests] limit answer failed:', e instanceof Error ? e.message : e);
    }
  }
  if (outcome === 'notAnswered' && isPlainNoticeDue) await replyToThread(key, texts.plainNotice);
}

/**
 * @description A request opened during a usage-limit wait hears about it too
 * (the ledger's create hook): a scheduled run or a tracker event does not cancel
 * the wait, and without the answer — and, with auto-resume off, the stop — it
 * would be woken straight into the limit and end in a false alert.
 */
function announceLimitWaitToNewRequest(key: SessionKey): void {
  const armed = getArmedApiRetry(key);
  const armedLimit = armed?.kind === 'usageLimit' ? armed : null;
  const wait = getLimitWaitForNewRequest({
    armedLimitWait: armedLimit ? { fireAt: armedLimit.fireAt, wait: armedLimit.limitWait } : null,
    isAutoResumeOffNoticed: autoContinueOffNoticedThreads.has(keyToString(key)),
    isAutoResumeOn: state.checkIsAutoContinueOnLimitEnabled(key),
  });
  if (!wait) return;
  void withThreadLocale(key, () =>
    announceLimitWait(key, wait, getLimitWaitTexts(key, wait, armedLimit?.attempt ?? 0), false),
  );
}

/** The two texts a usage-limit wait is told with: the topic's plain notice and the request's answer. */
interface LimitWaitTexts {
  plainNotice: string;
  answerBody: string;
}

/**
 * @description Both texts of a limit wait, from ONE branch on how it ends, in the
 * thread's locale. A wait ending on another day names the date. The
 * `/auto_continue_limits` pointer names a Telegram command — elsewhere it would
 * be noise; the "auto-resume is off" text carries its own.
 */
function getLimitWaitTexts(key: SessionKey, wait: UsageLimitWait, attempt: number): LimitWaitTexts {
  if (wait.kind === 'autoResumeOff') {
    const text = t('autoContinueLimits.limitReachedDisabled');
    return { plainNotice: text, answerBody: text };
  }
  const nowMs = Date.now();
  // R31: a tracker's requester may sit in another zone — the time names the instance's.
  const zoneSuffix = checkIsTelegramKey(key) ? '' : ` ${getCurrentTimezone()}`;
  const time = `${formatLocalClockWithDateIfNotToday(wait.kind === 'afterReset' ? wait.resetAt : wait.fireAt, nowMs)}${zoneSuffix}`;
  const [noticeText, answerText] = wait.kind === 'afterReset'
    ? [t('apiRetry.usageLimitResetNotice', { time }), t('requests.limit.answerAfterResetNotice', { time })]
    : [
      t('apiRetry.usageLimitDelayNotice', { minutes: Math.round((wait.fireAt - nowMs) / apiRetryMsPerMinute), attempt }),
      t('requests.limit.answerNextAttemptNotice', { time }),
    ];
  const addHint = (text: string): string => (checkIsTelegramKey(key) ? appendAutoContinueLimitsHint(text) : text);
  return { plainNotice: addHint(noticeText), answerBody: addHint(answerText) };
}

/**
 * @description Cancel a thread's armed retry SILENTLY — the user took over, so
 * there is nothing to resume and no give-up notice to post (cancel and give-up
 * must never share a code path). Clears the timer, the in-memory entry, and the
 * persisted record. Wired at the session-end sites (`handleAgentClosed` /
 * `handleAgentStopped`); the remaining user-takeover call-sites are S6.
 */
function cancelApiRetry(key: SessionKey): void {
  const k = keyToString(key);
  const entry = apiRetryTimers.get(k);
  if (entry?.timer) clearTimeout(entry.timer);
  // Prompts held during the wait (R23) are not dropped with it: they ride the next
  // prompt forwarded to the session — the operator's message that cancelled the
  // wait — or go to the next session on their own (`limitHeldPrompts`).
  apiRetryTimers.delete(k);
  clearSavedApiRetry(key);
  // The limit episode is over for this thread → retire its two one-shot markers.
  // Unlike the logged-out notice below, BOTH are safe to drop here: the pinned
  // "work resumed" message announces a PAST event (nothing re-posts it), and the
  // "auto-continue is off" notice can only reappear after a genuinely NEW limit
  // error — so neither can re-notify per message.
  clearLimitResumeNotice(key);
  autoContinueOffNoticedThreads.delete(k);
  // NOTE: intentionally does NOT touch the logged-out notice. `cancelApiRetry`
  // fires on EVERY inbound message (user takeover); clearing the auth notice here
  // would drop the one-notice guard so the user's next prompt (into the STILL
  // logged-out session) re-pins and re-notifies — the exact "notifies per
  // message" bug. The notice is retired only on genuine teardown (the explicit
  // `clearAuthNotice` calls at session-end sites) and on recovery (first real
  // output, in `handleAgentOutput`).
}

/**
 * @description `noResponse` from the OpenCode adapter — the prompt was accepted
 * (HTTP 204) but the agent ran no turn at all (a WEDGED session: its loop exits
 * at step 0 with no output; verified live 2026-08-15/16 on the my-news digest).
 * The topic would otherwise look dead, so the bot auto-recovers AND restores the
 * last dialog where possible, escalating one tier per repeat (pure
 * {@link decideWedgeRecovery}):
 *
 *   resend  — replay into the SAME session (a transient stall recovers, dialog intact);
 *   fork    — fork the session into a fresh one carrying the full conversation, then replay
 *             (recovers an instance-level wedge while KEEPING the dialog);
 *   restart — blank fresh session + replay (the conversation itself is the poison,
 *             e.g. a bloated session — dialog dropped, but the trigger still runs);
 *   giveUp  — surface the actionable notice instead of looping.
 *
 * The tier is bumped BEFORE the replay (which rides `isRecoveryReplay` so it does
 * not reset it), so each repeat escalates and a persistent wedge ends at giveUp.
 * A wedge only fires on a genuinely stuck session (a healthy turn always produces
 * assistant activity), so this never disturbs a working thread.
 */
function handleNoResponse(key: SessionKey): void {
  const k = keyToString(key);
  // Marked synchronously, in the same tick as the wedged idle: the wake-up poll
  // must never see that idle without the recovery already claiming it.
  wedgeRecoveriesInFlight.add(k);
  void withThreadLocale(key, () => handleNoResponseWithLocale(key)).finally(() => wedgeRecoveriesInFlight.delete(k));
}

async function handleNoResponseWithLocale(key: SessionKey): Promise<void> {
  const k = keyToString(key);
  const replayPrompt = lastForwardedPrompt.get(k);
  const adapter = getThreadAdapter(key);
  const tier = wedgeRecoveryTier.get(k) ?? 0;
  const action = decideWedgeRecovery({
    tier,
    hasReplayPrompt: replayPrompt !== undefined,
    canFork: typeof adapter.forkSession === 'function',
  });

  if (action === 'giveUp') {
    wedgeRecoveryTier.delete(k);
    await replyToThread(key, t('agent.no_response'));
    return;
  }

  // Record this attempt BEFORE the replay so a repeat escalates to the next tier
  // (the replay forward rides `isRecoveryReplay`, which does NOT reset the tier).
  wedgeRecoveryTier.set(k, tier + 1);
  try {
    if (action === 'resend') {
      // Transient-stall retry: same session, dialog fully intact.
      await replyToThread(key, t('agent.session_recovering'));
    } else if (action === 'fork') {
      // Restore the last dialog into a fresh, unwedged session.
      await replyToThread(key, t('agent.session_recovering'));
      const forkedId = await adapter.forkSession!(key);
      if (forkedId) {
        await persistAdapterSessionIds(key, adapter, state);
      } else {
        // Fork failed → fall back immediately to a blank restart this tier.
        await releaseThreadSession(key);
        const startMsg = await startAgentSession(key);
        if (startMsg) await replyToThread(key, startMsg);
      }
    } else {
      // action === 'restart': blank fresh session (dialog dropped).
      await replyToThread(key, t('agent.session_restarting'));
      await releaseThreadSession(key);
      const startMsg = await startAgentSession(key);
      if (startMsg) await replyToThread(key, startMsg);
    }
    // Re-trigger the original prompt into the (same / forked / fresh) session.
    await forwardPromptToAgent(key, getThreadAdapter(key), replayPrompt!, undefined, {
      isRecoveryReplay: true,
    });
  } catch (e) {
    console.error(`[wedgeRecovery] ${action} failed:`, e instanceof Error ? e.message : e);
    wedgeRecoveryTier.delete(k);
    await replyToThread(key, t('agent.no_response'));
  }
}

/**
 * @description Surface a logged-out / bad-credentials error as ONE PINNED notice
 * (a pin pierces the muted topic → a Telegram notification), backend-aware
 * (Claude → re-`/login`; OpenCode → restart the server). No timer, no persisted
 * retry record — a wait never recovers auth. Deduped to exactly one notice per
 * logout episode via {@link authNoticePinnedMessageId}; the slot is reserved with
 * {@link pinnedNoticePendingSentinel} BEFORE the awaits so a burst of `apiError`
 * frames can't race two notices out. The pin is removed on recovery — the first
 * real output after re-login ({@link clearAuthNotice}, wired in
 * {@link handleAgentOutput}) — and at the session-end / teardown sites (NOT the
 * user-takeover {@link cancelApiRetry} sites; see its NOTE).
 */
async function surfaceLoggedOutNotice(key: SessionKey): Promise<void> {
  const k = keyToString(key);
  if (authNoticePinnedMessageId.has(k)) return; // already surfaced this episode
  authNoticePinnedMessageId.set(k, pinnedNoticePendingSentinel);

  const messageKey =
    getThreadAdapterNameRaw(key) === 'opencode' ? 'apiRetry.loggedOutOpenCode' : 'apiRetry.loggedOutClaude';
  const id = await replyToThread(key, t(messageKey));
  if (id === null) {
    // Send failed — release the reservation so a later error can retry surfacing.
    if (authNoticePinnedMessageId.get(k) === pinnedNoticePendingSentinel) authNoticePinnedMessageId.delete(k);
    return;
  }
  // A concurrent teardown (clearAuthNotice) may have dropped the reservation
  // mid-send; don't resurrect it — leave the message unpinned in that case.
  if (!authNoticePinnedMessageId.has(k)) return;
  authNoticePinnedMessageId.set(k, id);
  // First pin of the episode notifies (disableNotification: false).
  await pinMessageQuiet(key, id, { disableNotification: false });
}

/**
 * @description Retire a thread's pinned logged-out notice: unpin it (if a real
 * message was pinned — the sentinel means the pin hadn't landed yet) and drop the
 * one-notice guard so a LATER logout notifies again. Called on recovery (first
 * real output) and at the session-end / teardown sites (NOT folded into
 * {@link cancelApiRetry} — see its NOTE). No-op when none is active.
 */
function clearAuthNotice(key: SessionKey): void {
  const k = keyToString(key);
  const pinnedId = authNoticePinnedMessageId.get(k);
  if (pinnedId === undefined) return;
  authNoticePinnedMessageId.delete(k);
  if (pinnedId !== pinnedNoticePendingSentinel) void unpinMessageQuiet(key, pinnedId);
}

/**
 * @description Announce that a usage/session-limit window reset and work is moving
 * again, as ONE PINNED, NOTIFYING message. A limit wait runs for up to an hour per
 * attempt in a topic the operator keeps muted, so a plain line would go unseen —
 * the pin is what fires the Telegram notification. Reserves its slot with
 * {@link pinnedNoticePendingSentinel} BEFORE the awaits (same discipline as
 * {@link surfaceLoggedOutNotice}) so a burst can't pin twice, and refuses to
 * resurrect a reservation a concurrent teardown dropped mid-send.
 */
async function surfaceLimitResumedNotice(key: SessionKey): Promise<void> {
  const k = keyToString(key);
  if (limitResumeNoticePinnedMessageId.has(k)) return; // already pinned this episode
  limitResumeNoticePinnedMessageId.set(k, pinnedNoticePendingSentinel);

  const id = await replyToThread(key, t('apiRetry.limitResetResuming'));
  if (id === null) {
    // Send failed — release the reservation so a later fire can retry surfacing.
    if (limitResumeNoticePinnedMessageId.get(k) === pinnedNoticePendingSentinel) {
      limitResumeNoticePinnedMessageId.delete(k);
    }
    return;
  }
  if (!limitResumeNoticePinnedMessageId.has(k)) return;
  limitResumeNoticePinnedMessageId.set(k, id);
  await pinMessageQuiet(key, id, { disableNotification: false });
}

/**
 * @description Retire a thread's pinned limit-resumed notice: unpin it (if a real
 * message was pinned — the sentinel means the pin hadn't landed yet) and drop the
 * one-pin guard so a LATER limit episode notifies again. Folded into
 * {@link cancelApiRetry}, which covers both the next genuine user message and every
 * session-end / teardown site, so pins never accumulate one per episode. No-op when
 * none is active.
 */
function clearLimitResumeNotice(key: SessionKey): void {
  const k = keyToString(key);
  const pinnedId = limitResumeNoticePinnedMessageId.get(k);
  if (pinnedId === undefined) return;
  limitResumeNoticePinnedMessageId.delete(k);
  if (pinnedId !== pinnedNoticePendingSentinel) void unpinMessageQuiet(key, pinnedId);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  json-stream `/login` — out-of-band OAuth via `claude auth login` in a pty
// ═══════════════════════════════════════════════════════════════════════════════
//
// The json-stream Claude backend has no TUI to host Claude's interactive `/login`,
// so the bot drives `claude auth login --claudeai` in a pty and relays it through
// the topic: sign-in URL out → pasted code in (the code message is deleted, with
// the 🔐 ack — same secret-handling as the tmux login-paste + /connect flows). On
// success the pinned logged-out notice clears (the normal recovery path). Pure
// parse/decision helpers live in `utils/claudeAuthLogin.ts`; this is the impure
// pty driver + per-thread state (mirrors the apiErrorRetry pure-layer / manager
// split). The pty is a bot child, NOT restart-safe — a bot restart kills it and
// drops the in-flight login, which is correct (a half-done login has no state to
// preserve; the user just re-runs /login).

interface PendingAuthLogin {
  readonly pty: IPty;
  /** Accumulated pty output (ANSI included) — re-parsed on each chunk. */
  output: string;
  /** The sign-in URL has been relayed to the topic. */
  urlRelayed: boolean;
  /** Fires if no sign-in URL appears in the window (OAuth-init call blocked). */
  readonly timeoutTimer: NodeJS.Timeout;
}

/** Per-thread in-flight `claude auth login` flows, keyed by `keyToString(key)`. */
const pendingAuthLogins = new Map<string, PendingAuthLogin>();

/**
 * How long to wait for the sign-in URL before giving up. The host egress firewall
 * can hold the OAuth-init network call (decision window up to ~2 min), so this is
 * generous; a permitted call returns the URL sub-second.
 */
const authLoginUrlTimeoutMs = 120_000;
const authLoginPtyCols = 100;
const authLoginPtyRows = 40;
const authStatusProbeTimeoutMs = 5_000;

/**
 * @description Whether the thread's `/login` flow has reached the "paste code"
 * stage — the sign-in URL was relayed and the next plain text is the OAuth code.
 * Mirrors the tmux backend's `isLoginPastePending` (true only once the paste
 * prompt is live), so a message typed in the pre-URL boot window is NOT
 * swallowed/deleted as a code. Teardown still keys off the map itself, not this.
 */
function checkIsAuthLoginAwaitingCode(key: SessionKey): boolean {
  return pendingAuthLogins.get(keyToString(key))?.urlRelayed === true;
}

/** Kill + forget a thread's in-flight login (idempotent). Reports nothing. */
function cancelClaudeAuthLogin(key: SessionKey): void {
  const k = keyToString(key);
  const pending = pendingAuthLogins.get(k);
  if (!pending) return;
  pendingAuthLogins.delete(k);
  clearTimeout(pending.timeoutTimer);
  try {
    pending.pty.kill();
  } catch {
    /* already exited */
  }
}

/** Read `claude auth status --json` → loggedIn, or `null` if the probe fails. */
async function readAuthLoginStatus(): Promise<boolean | null> {
  try {
    const { stdout } = await execFileAsync(
      resolveClaudeBinary(),
      ['auth', 'status', '--json'],
      { timeout: authStatusProbeTimeoutMs },
    );
    return parseAuthStatusLoggedIn(stdout);
  } catch {
    return null;
  }
}

/**
 * @description Start the out-of-band `/login` flow for a json-stream thread: spawn
 * `claude auth login --claudeai` in a pty, relay the sign-in URL when it appears,
 * and arm the pending-code state (the thread's next plain text is written into the
 * pty as the code). Re-running `/login` while a flow is pending restarts it.
 */
async function startClaudeAuthLogin(key: SessionKey): Promise<void> {
  const k = keyToString(key);
  cancelClaudeAuthLogin(key); // clean restart on a repeated /login

  let child: IPty;
  try {
    // Force subscription login (never metered): `--claudeai` picks the Claude
    // subscription and dropping ANTHROPIC_API_KEY keeps the metered console path
    // out of the way. cwd is irrelevant — login writes to `~/.claude` globally.
    const env: Record<string, string | undefined> = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    child = spawnPty(resolveClaudeBinary(), ['auth', 'login', '--claudeai'], {
      name: 'xterm-256color',
      cols: authLoginPtyCols,
      rows: authLoginPtyRows,
      cwd: process.cwd(),
      env,
    });
  } catch (e) {
    console.warn(`[login] ${k} pty spawn failed:`, e);
    await replyToThread(key, t('agent.login_failed'));
    return;
  }

  const pending: PendingAuthLogin = {
    pty: child,
    output: '',
    urlRelayed: false,
    timeoutTimer: setTimeout(() => {
      void onAuthLoginUrlTimeout(key, child);
    }, authLoginUrlTimeoutMs),
  };
  pendingAuthLogins.set(k, pending);

  child.onData((chunk) => {
    const current = pendingAuthLogins.get(k);
    if (!current || current.pty !== child) return; // cancelled/replaced
    current.output += chunk;
    // Relay the URL only once the "paste code" prompt is up — that guarantees the
    // full URL block already rendered (never a chunk-split half-URL).
    if (!current.urlRelayed && checkIsClaudeAuthLoginCodePrompt(current.output)) {
      const url = parseClaudeAuthLoginUrl(current.output);
      if (url) {
        current.urlRelayed = true;
        clearTimeout(current.timeoutTimer);
        void replyToThread(key, t('agent.login_url', { url }));
      }
    }
  });

  child.onExit(({ exitCode }) => {
    void onAuthLoginExit(key, child, exitCode);
  });
}

/**
 * @description The pending flow's next plain text is the OAuth code: type it into
 * the pty, delete the user's message (the code is a single-use secret), and post
 * the 🔐 ack. The final success/failure notice comes from {@link onAuthLoginExit}.
 */
async function submitClaudeAuthLoginCode(
  key: SessionKey,
  code: string,
  messageId: number,
): Promise<void> {
  const pending = pendingAuthLogins.get(keyToString(key));
  if (!pending) return;
  pending.pty.write(`${code.trim()}\r`);
  await deleteThreadMessage(key, messageId);
  await replyToThread(key, t('agent.login_code_relayed'));
}

/** No sign-in URL within the window → the OAuth-init call was likely blocked. */
async function onAuthLoginUrlTimeout(key: SessionKey, child: IPty): Promise<void> {
  const k = keyToString(key);
  const pending = pendingAuthLogins.get(k);
  if (!pending || pending.pty !== child || pending.urlRelayed) return;
  cancelClaudeAuthLogin(key);
  await replyToThread(key, t('agent.login_failed'));
}

/**
 * @description The `claude auth login` process exited. If the thread's flow is
 * still active (not cancelled/replaced), report the outcome: `claude auth status`
 * is authoritative, exit code is the fallback. On success clear the pinned
 * logged-out notice (recovery). A cancelled flow already dropped its entry, so
 * this no-ops for it (never reports a false "success" on a teardown kill).
 */
async function onAuthLoginExit(
  key: SessionKey,
  child: IPty,
  exitCode: number,
): Promise<void> {
  const k = keyToString(key);
  const pending = pendingAuthLogins.get(k);
  if (!pending || pending.pty !== child) return; // cancelled/replaced → no report
  clearTimeout(pending.timeoutTimer);
  pendingAuthLogins.delete(k);
  const loggedIn = await readAuthLoginStatus();
  if (checkIsAuthLoginSucceeded({ exitCode, loggedIn })) {
    clearAuthNotice(key); // recovery → retire any pinned logged-out notice
    await replyToThread(key, t('agent.login_success'));
  } else {
    await replyToThread(key, t('agent.login_failed'));
  }
}

// ── OpenCode `/connect` OAuth (subscription) — out-of-band pty flow ───────────
// Mirrors the Claude `/login` driver above but drives `opencode auth login
// -p <id> -m <label>`. Two shapes, auto-detected from the pty output: a DEVICE
// flow (relay URL + code, wait for the process to exit when the user authorises
// in a browser) and a PASTE flow (relay URL, then the next plain text is the
// code written into the pty). Pure parse/decision helpers live in
// `utils/openCodeAuthLogin.ts`; success is read from the on-disk `auth.json`.

interface PendingOpenCodeOAuth {
  readonly pty: IPty;
  readonly providerId: string;
  readonly methodLabel: string;
  /** Accumulated pty output (ANSI included) — re-parsed on each chunk. */
  output: string;
  /** The sign-in URL/code has been relayed to the topic. */
  infoRelayed: boolean;
  /**
   * Paste OR loopback flow: the next plain text is the OAuth reply — either a
   * pasted callback URL or a bare code. A device flow never sets this (it
   * self-completes when the user authorises at the URL — nothing is pasted).
   */
  awaitingReply: boolean;
  /**
   * The flow redirects to a loopback callback (`redirect_uri=localhost:<port>`)
   * that the user's remote browser can't reach — the bot must replay the pasted
   * callback on the host to complete it (see {@link submitOpenCodeOAuthReply}).
   */
  isLoopback: boolean;
  /** Loopback completion target parsed from the authorize URL. */
  redirectPort: number | null;
  redirectPath: string | null;
  /** `state` the CLI generated — needed to complete a bare-code loopback reply. */
  oauthState: string | null;
  /** Fires if no sign-in URL appears in the window (OAuth-init call blocked). */
  readonly timeoutTimer: NodeJS.Timeout;
}

/** Per-thread in-flight `opencode auth login` OAuth flows, keyed by `keyToString(key)`. */
const pendingOpenCodeOAuth = new Map<string, PendingOpenCodeOAuth>();

/**
 * @description Whether the thread's OAuth flow has reached a stage where the next
 * plain text is the OAuth reply (a paste-style code OR a loopback callback URL).
 * A device flow never sets this (nothing is pasted back — it self-completes).
 */
function checkIsOpenCodeOAuthAwaitingReply(key: SessionKey): boolean {
  return pendingOpenCodeOAuth.get(keyToString(key))?.awaitingReply === true;
}

/** Kill + forget a thread's in-flight OAuth login (idempotent). Reports nothing. */
function cancelOpenCodeOAuthLogin(key: SessionKey): void {
  const k = keyToString(key);
  const pending = pendingOpenCodeOAuth.get(k);
  if (!pending) return;
  pendingOpenCodeOAuth.delete(k);
  clearTimeout(pending.timeoutTimer);
  try {
    pending.pty.kill();
  } catch {
    /* already exited */
  }
}

/**
 * @description Read the provider's credential type out of OpenCode's on-disk
 * `auth.json` after the flow exits. Returns `true` when the provider is authed
 * as `oauth` (a fresh success — distinct from a stale `api` entry left by an
 * earlier key-based `/connect`), `false` when it isn't, `null` when the file
 * can't be read (caller falls back to the exit code).
 */
async function readOpenCodeProviderAuthed(providerId: string): Promise<boolean | null> {
  try {
    const authPath = getOpenCodeAuthFilePath({
      XDG_DATA_HOME: process.env.XDG_DATA_HOME,
      HOME: os.homedir(),
    });
    const raw = await fsp.readFile(authPath, 'utf8');
    return checkProviderAuthed(JSON.parse(raw), providerId, 'oauth');
  } catch {
    return null;
  }
}

/**
 * @description Start the out-of-band OAuth flow for `/connect <provider>`: spawn
 * `opencode auth login -p <id> -m <label>` in a pty, relay the sign-in URL (+ the
 * device code, for a device flow) once it's fully rendered, and — for a paste
 * flow — arm the pending-code state. Re-running restarts a pending flow.
 */
async function startOpenCodeOAuthLogin(
  key: SessionKey,
  providerId: string,
  methodLabel: string,
): Promise<void> {
  const k = keyToString(key);
  cancelOpenCodeOAuthLogin(key); // clean restart on a repeat

  let child: IPty;
  try {
    // Drop provider API-key envs so the login uses the subscription/account path
    // and can't be short-circuited by an ambient key. cwd is irrelevant — login
    // writes to OpenCode's global auth.json.
    const env: Record<string, string | undefined> = getOpenCodeChildEnv();
    delete env.OPENAI_API_KEY;
    delete env.ANTHROPIC_API_KEY;
    child = spawnPty(resolveOpenCodeBinary(), buildOpenCodeAuthLoginArgs(providerId, methodLabel), {
      name: 'xterm-256color',
      cols: authLoginPtyCols,
      rows: authLoginPtyRows,
      cwd: process.cwd(),
      env,
    });
  } catch (e) {
    console.warn(`[connect] ${k} opencode oauth pty spawn failed:`, e);
    await replyToThread(key, t('connect.oauth_failed', { provider: providerId }));
    return;
  }

  const pending: PendingOpenCodeOAuth = {
    pty: child,
    providerId,
    methodLabel,
    output: '',
    infoRelayed: false,
    awaitingReply: false,
    isLoopback: false,
    redirectPort: null,
    redirectPath: null,
    oauthState: null,
    timeoutTimer: setTimeout(() => {
      void onOpenCodeOAuthUrlTimeout(key, child);
    }, authLoginUrlTimeoutMs),
  };
  pendingOpenCodeOAuth.set(k, pending);

  child.onData((chunk) => {
    const current = pendingOpenCodeOAuth.get(k);
    if (!current || current.pty !== child) return; // cancelled/replaced
    current.output += chunk;
    if (current.infoRelayed) return;
    // Relay only once the URL block is fully rendered (a device code, the poll,
    // or a paste prompt is present) — never a chunk-split half-URL.
    if (!checkIsOAuthInfoReady(current.output)) return;
    const url = parseOpenCodeOAuthUrl(current.output);
    if (!url) return;
    current.infoRelayed = true;
    clearTimeout(current.timeoutTimer);
    const deviceCode = parseOpenCodeDeviceCode(current.output);
    const isPaste = checkIsOpenCodeOAuthPastePrompt(current.output) && !deviceCode;
    // Loopback (browser) flow: the CLI redirects to localhost, which a REMOTE
    // browser can't reach — so we relay the URL and bridge the callback the user
    // pastes back (either the full callback URL or the bare code, completed with
    // the stored state). Parse the completion target now, while the authorize
    // URL (with state) is fully rendered.
    const isLoopback = !deviceCode && !isPaste && checkIsLoopbackOAuthFlow(current.output);
    if (deviceCode) {
      void replyToThread(key, t('connect.oauth_device', { provider: providerId, url, code: deviceCode }));
    } else {
      void replyToThread(key, t('connect.oauth_url_only', { provider: providerId, url }));
    }
    if (isPaste) {
      current.awaitingReply = true;
      void replyToThread(key, t('connect.oauth_paste'));
    } else if (isLoopback) {
      const details = parseOAuthAuthorizeDetails(current.output);
      current.isLoopback = true;
      current.redirectPort = details.redirectPort;
      current.redirectPath = details.redirectPath;
      current.oauthState = details.state;
      current.awaitingReply = true;
      void replyToThread(key, t('connect.oauth_loopback'));
    } else {
      void replyToThread(key, t('connect.oauth_waiting'));
    }
  });

  child.onExit(({ exitCode }) => {
    void onOpenCodeOAuthExit(key, child, exitCode);
  });
}

/**
 * @description Handle the user's reply to a pending OAuth flow. The reply is
 * classified URL-FIRST, then as a bare code (requested behaviour): recognise a
 * pasted callback link first, otherwise a validated code — a value that is
 * neither (an ordinary chat message like "я перезагрузил") is NEVER consumed as
 * a credential, so a stale "awaiting reply" state can't swallow unrelated text.
 *
 *  - LOOPBACK (browser) flow: the pasted callback URL (or a bare code + the
 *    stored `state`) is replayed against the CLI's local callback server on the
 *    host (`127.0.0.1:<port>/auth/callback?…`) — the bot bridges what the remote
 *    browser could not reach. The CLI then exchanges the code and exits.
 *  - PASTE flow: the code is typed into the pty verbatim.
 *
 * The user's message is deleted (single-use secret); success/failure comes from
 * {@link onOpenCodeOAuthExit} once the CLI process exits.
 * @returns `true` when the reply was consumed as an OAuth reply, `false` when it
 *   was not recognised (caller keeps the flow armed and hints).
 */
async function submitOpenCodeOAuthReply(
  key: SessionKey,
  text: string,
  messageId: number,
): Promise<boolean> {
  const pending = pendingOpenCodeOAuth.get(keyToString(key));
  if (!pending) return false;
  const reply = classifyOpenCodeOAuthReply(text);
  if (reply === null) {
    // Not a link, not a plausible code → do not consume it as a credential.
    await replyToThread(key, t('connect.oauth_invalid_reply'));
    return false;
  }

  if (pending.isLoopback) {
    // Complete the loopback exchange on the host. Prefer values from the pasted
    // callback URL; fall back to the stored port/path/state for a bare code.
    const completionUrl = buildLoopbackCompletionUrl({
      port: (reply.kind === 'callback' ? reply.port : null) ?? pending.redirectPort,
      path: (reply.kind === 'callback' ? reply.path : null) ?? pending.redirectPath,
      code: reply.code,
      state: (reply.kind === 'callback' ? reply.state : null) ?? pending.oauthState,
    });
    if (!completionUrl) {
      await replyToThread(key, t('connect.oauth_invalid_reply'));
      return false;
    }
    await deleteThreadMessage(key, messageId);
    await replyToThread(key, t('agent.login_code_relayed'));
    try {
      // The CLI's local callback server exchanges the code and lets the pty exit.
      const res = await fetch(completionUrl, { signal: AbortSignal.timeout(30_000) });
      // Drain the body so the connection closes cleanly; ignore its content.
      await res.text().catch(() => '');
    } catch (e) {
      console.warn(`[connect] ${keyToString(key)} loopback callback replay failed:`, e);
      // The pty is still waiting; onExit will report the eventual outcome, but a
      // transport failure here means it likely won't — surface it now.
      await replyToThread(key, t('connect.oauth_failed', { provider: pending.providerId }));
    }
    return true;
  }

  // Paste flow: type the code into the pty verbatim.
  await deleteThreadMessage(key, messageId);
  await replyToThread(key, t('agent.login_code_relayed'));
  pending.pty.write(`${reply.code}\r`);
  return true;
}

/** No sign-in URL within the window → the OAuth-init call was likely blocked. */
async function onOpenCodeOAuthUrlTimeout(key: SessionKey, child: IPty): Promise<void> {
  const k = keyToString(key);
  const pending = pendingOpenCodeOAuth.get(k);
  if (!pending || pending.pty !== child || pending.infoRelayed) return;
  cancelOpenCodeOAuthLogin(key);
  await replyToThread(key, t('connect.oauth_failed', { provider: pending.providerId }));
}

/**
 * @description The `opencode auth login` process exited. If the thread's flow is
 * still active, report the outcome: `auth.json` is authoritative (the provider's
 * entry flips to `oauth`), exit code is the fallback. A cancelled flow already
 * dropped its entry, so this no-ops for it.
 */
async function onOpenCodeOAuthExit(
  key: SessionKey,
  child: IPty,
  exitCode: number,
): Promise<void> {
  const k = keyToString(key);
  const pending = pendingOpenCodeOAuth.get(k);
  if (!pending || pending.pty !== child) return; // cancelled/replaced → no report
  clearTimeout(pending.timeoutTimer);
  pendingOpenCodeOAuth.delete(k);
  const authed = await readOpenCodeProviderAuthed(pending.providerId);
  if (checkIsOpenCodeOAuthSucceeded({ exitCode, authed })) {
    const adapter = getAdapter('opencode');
    const isProviderAuthReloaded = adapter.reloadProviderAuth
      ? await adapter.reloadProviderAuth()
      : false;
    if (isProviderAuthReloaded) {
      await replyToThread(key, t('connect.oauth_success', { provider: pending.providerId }));
    } else {
      await replyToThread(key, t('connect.oauth_failed', { provider: pending.providerId }));
    }
  } else {
    await replyToThread(key, t('connect.oauth_failed', { provider: pending.providerId }));
  }
}

/**
 * @description Buffers prompts typed while an agent session is still booting so
 * they are replayed once it's ready, instead of being dropped into the
 * "no agent running" guidance. Adapter-agnostic — covers both Claude (tmux
 * boot) and OpenCode (server boot). See {@link StartupPromptBuffer}.
 */
const startupPromptBuffer = new StartupPromptBuffer();

/**
 * @description Per-thread snapshot of the last `/sessions` listing. Audit
 * S4 / #7: Telegram caps `callback_data` at 64 bytes, so encoding a full
 * OpenCode session id (UUID-like, often > 60 chars) used to require
 * `.slice(0, 60)` which then resolved to a non-existent id on click. We
 * keep the full ids on the bot side and use `resume_<index>` as the
 * callback payload instead.
 */
const threadSessionLists = new Map<string, string[]>();

interface PendingProviderConnect {
  providerId: string;
}

/**
 * @description Per-thread `/connect` state. The next plain text message is
 * treated as the provider API key and deleted from Telegram before the adapter
 * stores it in OpenCode auth.
 */
const pendingProviderConnects = new Map<string, PendingProviderConnect>();

/**
 * @description Per-thread snapshot of the last `/connect` method picker: the
 * provider and its auth methods in catalog order. The `connm_<idx>` callback
 * resolves its tapped method here (labels are long / > 64-byte callback_data, so
 * the index is the payload — same trick as `threadSessionLists`/`resume_<idx>`).
 */
const connectMethodLists = new Map<string, { providerId: string; methods: OpenCodeAuthMethod[] }>();

/**
 * @description Snapshots of the bare-`/disconnect` pickers, keyed per picker
 * MESSAGE (`buildDisconnectPickerKey`), holding the active provider ids in the
 * order that message's buttons were rendered. The `dscp_<idx>` callback
 * resolves its tap against ITS OWN message's snapshot rather than carrying the
 * provider name (Telegram's 64-byte `callback_data` rule, same as
 * {@link connectMethodLists}).
 *
 * Keyed per message, not per thread, because disconnect is DESTRUCTIVE: a
 * second `/disconnect` leaves the first picker's buttons tappable forever, and
 * a thread-keyed snapshot would resolve that old keyboard's index against the
 * NEW list — deleting a different provider's credentials than the one the user
 * tapped. Bounded by {@link disconnectPickerSnapshotLimit}; a thread's teardown
 * drops all of its keys.
 */
const disconnectProviderLists = new Map<string, string[]>();

/**
 * @description Per-thread "session-pick" arming flag. A thread is added here
 * by `/sessions` (or its `/resume` synonym) and removed when the user picks
 * a number, cancels, or sends non-numeric text. Only while a key is in this
 * set is a bare digit reply interpreted as a session pick — so a normal "2"
 * prompt is never hijacked. Mirrors the existing `awaitingModelSelection`
 * pattern (see the `/model` numeric-selection flow).
 */
const awaitingSessionSelection = new Set<string>();

/**
 * @description Per-thread "create-new-folder" arming flag. Added when the
 * user taps the «create new folder» option in the `/bind` picker; removed
 * when the user sends the name, cancels, or runs any other command. While a
 * key is in this set the next text message is treated as the folder name to
 * create + bind. Mirrors the `awaitingSessionSelection` pattern. Stays armed
 * on an invalid name so the user can retry.
 */
const awaitingFolderName = new Set<string>();

/** Max sessions shown in a `/sessions` list (Telegram-friendly, plan S3). */
const sessionsDisplayLimit = 10;

/**
 * @description Forum-topic names that arrived via `forum_topic_created`
 * but couldn't be processed because the creator wasn't an authorised user
 * (a group admin/creator) (audit S2 / #5). We can't read a thread's title
 * later via Telegram Bot API in any portable way, so keeping the name here
 * lets the first message from an authorised user trigger fuzzy auto-bind.
 *
 * In-memory by design: this is a UX nicety, not a security boundary —
 * losing the cache on restart just means the user has to bind manually
 * once. The TTL guards against unbounded growth in a busy group where
 * non-authorised members keep creating topics.
 */
interface PendingTopicNameEntry { name: string; ts: number; }
const pendingTopicNames = new Map<string, PendingTopicNameEntry>();
const PENDING_TOPIC_NAME_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * @description In-memory `chatId → chat.title` cache for the served group.
 * Every authorised group update carries `chat.title`, so we refresh it for
 * free on each accepted message; read at thread-context-preamble build time
 * so the agent learns the group name. Not persisted — the next authorised
 * update repopulates it after a restart, and the preamble simply omits an
 * unknown group title until then.
 */
const groupTitleCache = new Map<number, string>();

/**
 * @description Per-thread marker holding the last thread-context preamble the
 * bot injected ahead of a prompt (keyed by `keyToString`). The preamble rides
 * the next prompt only when the freshly-built text differs from this marker
 * (see `checkShouldInjectPreamble`): a fresh session (marker cleared on
 * start/stop/closed), a rename (built text changes), or `/clear` (marker
 * reset) all trigger a re-inject. In-memory by design — a duplicate preamble
 * after a bot restart / session resume is acceptable (the marker isn't
 * persisted).
 */
const threadContextMarkers = new Map<string, string>();

/**
 * @description Forget the last-injected preamble for a thread so the next
 * prompt re-carries it. Called on every session lifecycle boundary (start,
 * stop, closed) and on forwarding a bare `/clear`.
 */
function clearThreadContextMarker(key: SessionKey): void {
  threadContextMarkers.delete(keyToString(key));
}

function getThreadMessageState(key: SessionKey): ThreadMessageState {
  const k = keyToString(key);
  let s = threadMessageStates.get(k);
  if (!s) {
    s = { lastMessageId: null, lastMessageText: null, needsNewMessage: true, typingLoaderTimer: null, statusMessageId: null, thinkingMessageId: null, thinkingFrameGeneration: 0, statusFrameGeneration: 0, livenessTimer: null, lastActivityText: null, livenessGlyphIndex: 0, wasBusy: false, workingSince: null, lastLivenessSentAt: 0, statusIdleSuppressed: false, busyOnsetArmedUntil: 0, subagentStatusMessageId: null, subagentStartedAt: null, subagentTitle: null, subagentTimer: null, lastSubagentText: null, subagentEditInFlight: false };
    threadMessageStates.set(k, s);
  }
  return s;
}

/**
 * @description Persist the thread's CURRENT transient status-frame ids (the
 * non-null `statusMessageId` / `thinkingMessageId` / `subagentStatusMessageId`)
 * so an UNGRACEFUL restart (crash / SIGKILL — no graceful sweep ran) can delete
 * whatever frame was on screen on the next boot (S2). The in-memory
 * `ThreadMessageState` is the live source of truth; this just keeps disk in step.
 * Debounced + fire-and-forget. Single collection point shared by the three
 * frame-id setters below so memory and disk never drift.
 */
function persistTransientFrames(key: SessionKey): void {
  const ids = getTransientFrameIds(getThreadMessageState(key));
  state.setTransientFrames(key, ids).catch(e =>
    console.error('[transientFrames] persist failed:', e),
  );
}

/**
 * @description The three choke points for mutating a transient frame id: assign
 * the in-memory `ThreadMessageState` field AND mirror the resulting id set to the
 * persisted store (S2). Callers keep their generation-guard checks (only null
 * when the id still equals the one they created); the setter just routes the
 * same write through one place.
 */
function setStatusFrameId(key: SessionKey, id: number | null): void {
  getThreadMessageState(key).statusMessageId = id;
  persistTransientFrames(key);
}
function setThinkingFrameId(key: SessionKey, id: number | null): void {
  getThreadMessageState(key).thinkingMessageId = id;
  persistTransientFrames(key);
}
function setSubagentFrameId(key: SessionKey, id: number | null): void {
  getThreadMessageState(key).subagentStatusMessageId = id;
  persistTransientFrames(key);
}

function getOutputQueueState(key: SessionKey): OutputQueueState {
  const k = keyToString(key);
  let s = outputQueues.get(k);
  if (!s) {
    s = { pendingOutput: null, pendingIsContinuation: false, isProcessing: false, debounceTimer: null };
    outputQueues.set(k, s);
  }
  return s;
}

/**
 * @description Is real agent output currently mid-flight for this thread —
 * queued, debouncing, or actively sending? The Claude liveness loop checks this
 * to stay out of the output's way: while output owns the rolling message, the
 * activity frame must not be created/ticked/deleted (anti-thrash). Reads with
 * `.get()` so a thread that never streamed output is trivially "not streaming".
 */
function checkIsOutputStreaming(key: SessionKey): boolean {
  // The DM draft transport streams via drafts, not the output queue, so ask it
  // too — otherwise the Claude liveness loop, blind to an active draft, inserts a
  // heartbeat status frame between prose deltas and chops the draft mid-answer.
  if (telegramOutbound.checkIsDelivering(key)) return true;
  const q = outputQueues.get(keyToString(key));
  if (!q) return false;
  return q.pendingOutput !== null || q.isProcessing || q.debounceTimer !== null;
}

function getStatusCoalesceState(key: SessionKey): StatusCoalesceState {
  const k = keyToString(key);
  let s = statusCoalescers.get(k);
  if (!s) {
    s = { pendingText: null, inFlight: false, lastSentText: null, deferRetryTimer: null };
    statusCoalescers.set(k, s);
  }
  return s;
}

function getThinkingCoalesceState(key: SessionKey): ThinkingCoalesceState {
  const k = keyToString(key);
  let s = thinkingCoalescers.get(k);
  if (!s) {
    s = { pendingHtml: null, inFlight: false, lastSentHtml: null, detachAfterDrain: false };
    thinkingCoalescers.set(k, s);
  }
  return s;
}

/**
 * @description Tear down a thread's thinking message + coalescer. Called on
 * every session-end / takeover path (close, stop, question) so a live
 * "☁️ thinking …" frame never lingers after the reasoning it described is gone
 * (mirrors `deleteStatusMessage` for the dedicated thinking id). Best-effort:
 * the delete is fire-and-forget; the in-memory id/coalescer are cleared
 * synchronously so a racing emit can't resurrect a stale frame.
 */
function clearThinkingMessage(key: SessionKey): void {
  const s = getThreadMessageState(key);
  const coalescer = thinkingCoalescers.get(keyToString(key));
  if (coalescer) {
    coalescer.pendingHtml = null;
    coalescer.lastSentHtml = null;
    coalescer.detachAfterDrain = false;
  }
  // Bump UNCONDITIONALLY (even with no id tracked): a `sendThinkingFrame` create
  // may be mid-`await` with its id not yet stored. The bump tells that in-flight
  // create to DISCARD its message instead of resurrecting an orphan.
  s.thinkingFrameGeneration += 1;
  if (s.thinkingMessageId === null) return;
  const id = s.thinkingMessageId;
  setThinkingFrameId(key, null);
  deleteThreadMessage(key, id).catch(() => {});
}

/**
 * @description Drop a thread's bot-side queued-but-unsent agent output on
 * stop, so nothing coalesced *before* the stop posts *after* the "stopped"
 * confirmation (live repro: a 429 backlog let trailing outputs land seconds
 * later). Looks the existing state up with `.get()` — no lazy creation, since
 * clearing a thread that never queued anything is a no-op. The pure clear
 * logic lives in `utils/clearThreadOutputQueues` for unit testing.
 */
function clearThreadQueues(key: SessionKey): void {
  const k = keyToString(key);
  // A teardown that clears queued output must FIRST finalize any in-flight
  // content so the agent's final answer lands instead of being discarded (DM:
  // the live draft → a permanent message; group: the coalesced-but-unsent
  // output buffer → a permanent message, S2). This is the convergence point for
  // `/quit` release, session `closed`/`stopped`, `/unbind`, and topic-delete —
  // all route through here. CRITICAL ORDER: finalize BEFORE
  // `clearThreadOutputQueues`, because the group finalize drains
  // `q.pendingOutput` and the clear would otherwise null it first (S2). Both
  // transports capture + reset their in-flight state SYNCHRONOUSLY before any
  // await, so the clear below can't race the drain. Fire-and-forget.
  void telegramOutbound.finalize(key);
  clearThreadOutputQueues(outputQueues.get(k), statusCoalescers.get(k));
  // A new session starts with empty context — forget the last-sent outputs so
  // the identical-output backstop can't suppress a legitimate repeat across a
  // session boundary (the same convergence point that clears the other
  // per-thread relay state: /quit release, session closed/stopped, /unbind).
  identicalOutputGuard.reset(k);
}

function markNeedsNewMessage(key: SessionKey): void {
  getThreadMessageState(key).needsNewMessage = true;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Threading helpers — gating, key extraction
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * @description Thin Telegraf adapter over `resolveThreadKeyForMode` (the pure
 * bi-surface composition lives in `./threadRouting`, where it can be
 * unit-tested). The bot only translates `ctx` shapes into the routing module's
 * plain inputs and supplies the runtime surface config.
 */
function getThreadKey(ctx: Context): SessionKey | null {
  const msg = ctx.message as Message | undefined;
  const cbMsg = ctx.callbackQuery?.message as Message | undefined;
  const routeInput = {
    chat: getRouteChat(ctx),
    message: msg
      ? {
          message_thread_id: 'message_thread_id' in msg ? msg.message_thread_id : undefined,
          is_topic_message: 'is_topic_message' in msg ? msg.is_topic_message : undefined,
        }
      : undefined,
    callbackQueryMessage: cbMsg
      ? {
          message_thread_id: 'message_thread_id' in cbMsg ? cbMsg.message_thread_id : undefined,
          is_topic_message: 'is_topic_message' in cbMsg ? cbMsg.is_topic_message : undefined,
        }
      : undefined,
  };
  return resolveThreadKeyForMode(routeInput, {
    mode: getChatMode(),
    ownerUserId: getOwnerUserId(),
    allowedGroupId: getAllowedGroupId() ?? NaN,
    isDmSurfaceActive: checkIsDmSurfaceActive(),
  });
}

/**
 * @description Is this thread the General topic? The General marker differs per
 * surface — `1` in the supergroup, `0` (no `message_thread_id`) in the DM — so
 * the check is per-chat (the key's surface), not a global mode.
 */
function checkIsGeneral(key: SessionKey): boolean {
  const generalThreadId = checkIsDmKey(key) ? DM_GENERAL_THREAD_ID : GENERAL_THREAD_ID;
  return getTelegramThreadId(key) === generalThreadId;
}

type LocaleSource = 'override' | 'telegram' | 'storedTelegram' | 'fallback';

interface ResolvedChatLocale {
  locale: Locale;
  source: LocaleSource;
}

function getTelegramLocale(ctx: Context): Locale | null {
  return normalizeLocale(ctx.from?.language_code);
}

function getResolvedChatLocale(chatId: number, telegramLocale: Locale | null): ResolvedChatLocale {
  const override = state.getChatLocaleOverride(chatId);
  if (override) return { locale: override, source: 'override' };
  if (telegramLocale) return { locale: telegramLocale, source: 'telegram' };
  const storedTelegramLocale = state.getChatTelegramLocale(chatId);
  if (storedTelegramLocale) return { locale: storedTelegramLocale, source: 'storedTelegram' };
  return { locale: defaultLocale, source: 'fallback' };
}

function getLocaleForContext(ctx: Context): Locale {
  const telegramLocale = getTelegramLocale(ctx);
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return telegramLocale ?? defaultLocale;
  if (telegramLocale) {
    void state
      .setChatTelegramLocale(chatId, telegramLocale)
      .catch(e => console.error('[i18n] failed to persist Telegram locale:', e));
  }
  return getResolvedChatLocale(chatId, telegramLocale).locale;
}

function getLocaleForKey(key: SessionKey): Locale {
  if (!state) return defaultLocale;
  return state.getChatLocaleOverride(getTelegramChatId(key)) ?? state.getChatTelegramLocale(getTelegramChatId(key)) ?? defaultLocale;
}

function withThreadLocale<T>(key: SessionKey, fn: () => T): T {
  return runWithLocale(getLocaleForKey(key), fn);
}

/**
 * @description Build the minimal `RouteChat` shape from a Telegraf context
 * (the `is_forum` flag isn't on every chat variant in the union).
 */
function getRouteChat(ctx: Context): { id: number; type: string; is_forum?: boolean } | undefined {
  const chat = ctx.chat;
  if (!chat) return undefined;
  return { id: chat.id, type: chat.type, is_forum: 'is_forum' in chat ? chat.is_forum : undefined };
}

/**
 * @description Auto-pairing entrypoint, invoked as the first middleware on
 * every update. No-op unless the bot is in pairing mode (no effective group
 * id and not locked by env). On the first qualifying update from an allowed
 * user in a forum supergroup it adopts that chat as the bot's group, persists
 * the id, and confirms in-chat — so the operator never looks up the `-100…`
 * id by hand. Re-pointing later is done explicitly via `/pair`.
 */
async function tryAutoPair(ctx: Context): Promise<void> {
  // Pairing adopts a forum supergroup, so it is inert only when there is NO
  // group surface — pure `dm` mode. In `both` it must still run (the group
  // surface is live); a DM update is harmless here (`resolvePairingCandidate`
  // rejects private chats), and the served chat is fixed only in `dm`.
  if (getChatMode() === 'dm') return;

  const chat = getRouteChat(ctx);

  // While unpaired, log every incoming update so the operator can see
  // exactly what reaches the bot. Without this, the three ways pairing
  // can silently fail — privacy mode (no update at all), a non-forum chat,
  // or a sender who isn't a group admin — are indistinguishable from "bot
  // is broken". Gated to pairing mode so normal operation stays quiet.
  if (!isGroupLockedByEnv && getAllowedGroupId() === null) {
    console.log(
      `[pair] incoming ${ctx.updateType} update: chat=${chat?.id} type=${chat?.type} ` +
        `is_forum=${chat?.is_forum} from=${ctx.from?.id}`,
    );
  }

  const candidate = resolvePairingCandidate({
    chat,
    currentGroupId: getAllowedGroupId(),
    isEnvLocked: isGroupLockedByEnv,
  });
  if (candidate === null) return;

  // Authority probe: only a creator/administrator of the candidate group may
  // pair the bot, so a random group the bot is added to can't hijack it.
  const userId = ctx.from?.id;
  if (!userId || !(await checkIsForumAdmin(candidate, userId))) {
    console.warn(`[pair] ignored pairing from chat ${candidate} user ${userId ?? '?'} (not a group admin)`);
    return;
  }

  effectiveGroupId = candidate;
  await state.setPairedGroupId(candidate);
  adminCache.invalidate();
  console.log(`[pair] auto-paired forum supergroup ${candidate} (persisted to state.json)`);

  const key = getThreadKey(ctx) ?? makeTelegramKey(candidate, GENERAL_THREAD_ID);
  await replyToThread(key, t('pair.success', { groupId: candidate })).catch(() => {});
}

/**
 * @description Combined access check. Returns the `SessionKey` if the
 * context is from an authorised user (a creator/admin of the served forum
 * group) in the configured forum supergroup, else `null`. Logs (but does not
 * reply to) chats / users we don't accept so foreign chats / spam stay silent
 * (plan §13.13, D21).
 */
async function authoriseContext(ctx: Context): Promise<SessionKey | null> {
  const userId = ctx.from?.id;
  if (!userId || !(await checkIsAllowedUser(ctx))) {
    if (ctx.chat) {
      console.warn(
        `[security] ignored update from chat ${ctx.chat.id} user ${userId ?? '?'} (not a group admin)`,
      );
    }
    return null;
  }
  const key = getThreadKey(ctx);
  if (!key) {
    if (ctx.chat) {
      const surface = checkIsDmChat(ctx) ? "the owner's DM" : 'the forum supergroup we listen to';
      console.warn(`[security] ignored update from chat ${ctx.chat.id} (not ${surface})`);
    }
    return null;
  }
  // Refresh the group-title cache from this authorised update — supergroups
  // always carry `chat.title`. Feeds the thread-context preamble (S2). Cheap,
  // idempotent, and the only place every accepted update funnels through. A
  // private chat (DM key) has no `title`, so there is nothing to cache (the
  // preamble falls back to the bot name) — skip it explicitly.
  if (!checkIsDmKey(key) && ctx.chat && 'title' in ctx.chat && ctx.chat.title) {
    groupTitleCache.set(ctx.chat.id, ctx.chat.title);
  }
  return key;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Send helpers — replyToThread + auto-track + error routing
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * @description Central handler for failed sends.
 *
 * Delegates the classification rules to `./sendErrorClassifier` (so the
 * Telegram-400-text matching is unit-testable, plan §11 Этап 7 / R8),
 * then performs the imperative side-effects that depend on bot state.
 *
 * Categories (plan §13.10, E5):
 *   - **thread-deleted** → wipe binding + in-memory state.
 *   - **topic-closed** → preserve binding (closures are reversible),
 *     mark `closed: true`, notify in General.
 *   - **other** → log; no state mutation.
 */
async function handleSendError(key: SessionKey, err: unknown): Promise<void> {
  const kind = classifySendError(err);

  if (kind === 'thread-deleted') {
    console.log(`[gc] thread ${keyToString(key)} not found — removing binding`);
    await state.removeBinding(key);
    clearInMemoryThreadState(key);
    // The in-flight reminder wizard is dropped HERE rather than inside
    // `clearInMemoryThreadState`, which also runs on `/unbind`: a reminder needs
    // neither a folder nor an agent, so leaving a folder must NOT abandon a wizard
    // mid-flow. Only the topic actually being gone does.
    reminderWizards.delete(keyToString(key));
    return;
  }
  if (kind === 'topic-closed') {
    console.log(`[skip] thread ${keyToString(key)} is closed — binding preserved`);
    await state.setBindingClosed(key, true);
    // Notify in General so user is not silent. Use low-level send (no
    // recursion through replyToThread, which would re-enter this handler).
    // Notify General. We use the low-level send (no `replyToThread`) to
    // avoid re-entering this handler if the notification itself fails;
    // omit `message_thread_id` so the message lands in General — see the
    // `buildSendExtra` rationale for why `1` on outbound is now a 400.
    enqueueSend(key, () =>
      bot.telegram.sendMessage(
        getTelegramChatId(key),
        t('error.tg.thread.closed', { key: keyToString(key) }),
      ),
    ).catch(e2 => console.error('[send] failed to notify General about TOPIC_CLOSED:', e2));
    return;
  }

  // Fallthrough: keep enough context in the log to recognise repeat
  // offenders without hauling state.json into the log line.
  if (checkIsApiError(err)) {
    console.error(
      `[send] ${keyToString(key)} ${getErrorCode(err) ?? '?'} ${getErrorDescription(err) || '(no description)'}`,
    );
  } else {
    console.error(`[send] ${keyToString(key)} unknown error:`, err);
  }
}

/**
 * @description Drop all in-memory traces of a thread.
 *
 * Used after a `forum_topic_deleted` event or a 400-thread-not-found
 * cleanup. Does NOT touch state.json bindings/agents/messages — the caller
 * already removed those. The ONE persisted thing cleared here is the pending
 * question (`clearPendingQuestion`): leaving it on disk after the binding is
 * gone would orphan an unreachable entry that boot-restore would just drop
 * anyway, so we release it eagerly to keep `state.json` clean.
 */
function clearInMemoryThreadState(key: SessionKey): void {
  const k = keyToString(key);
  // Drop queued output AND status frame (incl. cancelling the output
  // debounce timer) BEFORE deleting the map entries — otherwise an armed
  // `debounceTimer` would survive the `outputQueues.delete` as an orphan and
  // still fire into a freshly-bound session.
  clearThreadQueues(key);
  // Clear the liveness timer BEFORE dropping the message-state entry, otherwise
  // it survives the `threadMessageStates.delete` as an orphan that fires into a
  // freshly-bound session (same reasoning as the output debounce timer above).
  stopClaudeLiveness(key);
  // Same orphan-prevention for the typing-loader timer (it lives in the
  // message-state entry too) — covers /unbind and a deleted topic.
  telegramOutbound.setActivity(key, 'idle');
  threadMessageStates.delete(k);
  outputQueues.delete(k);
  clearPendingQuestion(key);
  // The thread is going away (/unbind, topic deleted) → cancel any pending
  // API-error retry silently; there's nothing left to resume into.
  cancelApiRetry(key);
  cancelClaudeAuthLogin(key); // teardown → kill any in-flight /login pty
  cancelOpenCodeOAuthLogin(key); // teardown → kill any in-flight /connect oauth pty
  clearAuthNotice(key); // teardown → retire any pinned logged-out notice
  threadModelLists.delete(k);
  awaitingModelSelection.delete(k);
  threadSessionLists.delete(k);
  awaitingSessionSelection.delete(k);
  pendingProviderConnects.delete(k);
  connectMethodLists.delete(k);
  // Compound (thread + message) keys — drop every picker this thread rendered.
  for (const pickerKey of getDisconnectPickerKeysForThread(disconnectProviderLists.keys(), k)) {
    disconnectProviderLists.delete(pickerKey);
  }
  awaitingFolderName.delete(k);
  pinnedStatusTextCache.delete(k);
  statusCoalescers.delete(k);
  // `clearThreadQueues` → `finalizeInFlight` above already finalized any accumulated
  // draft text (synchronously capturing it + clearing the timers); drop the now-
  // reset per-transport state so it doesn't leak across a rebind (DM: the draft map
  // entry; group: noop).
  telegramOutbound.dispose(key);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Pinned per-thread status banner (plan §11 Этап 7 / §20.5)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * @description Threads currently inside a `/unbind` critical section.
 *
 * `/unbind` deletes the pinned banner and stops the agent in one logical
 * step; the adapter's synchronous `stopped` event would otherwise race the
 * teardown and re-pin a stale "idle" banner inside the dying thread. Guard
 * is keyed by serialised `SessionKey` and held only while the handler runs.
 */
const unbindingKeys = new Set<string>();

/**
 * @description In-memory dedup for the pinned-banner edit pipeline.
 *
 * Telegram answers `400 message is not modified` when we try to edit a
 * pinned message with identical text; the call is harmless but burns a
 * token-bucket slot. Remembering the last sent text per thread skips the
 * round-trip entirely when nothing actually changed (rapid succession of
 * `started → status → output` events on a busy agent).
 *
 * In-memory, but seeded at boot from `binding.pinnedStatusText` (persisted
 * in state.json) via `getPinnedBannerSkipDecision` — so a restart's banner
 * refresh wave skips unchanged banners without burning API calls (B8).
 */
const pinnedStatusTextCache = new Map<string, string>();

/**
 * @description Per-thread lock for the pinned-banner send/edit pipeline.
 * Audit S6 / #8: `updatePinnedStatus` reads `binding.pinnedStatusMessageId`,
 * awaits several `enqueueSend` round-trips, then writes the id back.
 * Two concurrent adapter events (`started` + `status`) could both observe
 * a missing id, both send + pin, and overwrite each other → duplicate
 * stacked pins. We deliberately don't reuse `state.withLock` here: the
 * banner pipeline does multi-second network work, and holding the state
 * lock that long would stall every other persistence op on the key.
 */
const pinnedStatusLock = new KeyLock();

/**
 * @description Per-thread lock for the question pin/unpin read-modify-write
 * (`questionPinnedMessageId`). Same rationale as {@link pinnedStatusLock}: both
 * `pinThreadQuestion` and `unpinThreadQuestion` read the map, `await` an
 * `enqueueSend` round-trip, then set/delete the map — interleaving two of them
 * (e.g. an S3 repost racing the answer's unpin) could double-notify or leave a
 * phantom id that makes the NEXT question pin silently (zero notification — the
 * worst outcome for a muted topic). Holding ONE lock across both helpers
 * serialises every pin/unpin for a key.
 */
const questionPinLock = new KeyLock();

/**
 * @description Single source of truth for turning a failed Telegram send into a
 * log string: prefer the API error description, fall back to the JS message.
 * Used by every pin/unpin/banner swallow-and-log site so the extraction never
 * drifts between them.
 */
function describeSendError(e: unknown): string {
  return checkIsApiError(e) ? getErrorDescription(e) : (e instanceof Error ? e.message : String(e));
}

/**
 * @description Pin `messageId` for `key` through the rate-limit queue, swallowing
 * + logging failures (missing `can_pin_messages`, closed topic, network). Returns
 * `true` on success so the caller can keep its bookkeeping in sync with what is
 * actually pinned. Bot-owned plumbing primitive for the question pin helpers.
 */
async function pinMessageQuiet(key: SessionKey, messageId: number, options: { disableNotification: boolean }): Promise<boolean> {
  try {
    await enqueueSend(key, () =>
      bot.telegram.pinChatMessage(getTelegramChatId(key), messageId, { disable_notification: options.disableNotification }),
    );
    return true;
  } catch (e) {
    console.warn(`[question-pin] pin ${keyToString(key)} msg ${messageId} failed: ${describeSendError(e)}`);
    return false;
  }
}

/**
 * @description Unpin `messageId` for `key` through the rate-limit queue,
 * swallowing + logging failures (already-unpinned / deleted / lost permission).
 * Fire-and-forget sibling of {@link pinMessageQuiet}.
 */
async function unpinMessageQuiet(key: SessionKey, messageId: number): Promise<void> {
  try {
    await enqueueSend(key, () =>
      bot.telegram.unpinChatMessage(getTelegramChatId(key), messageId),
    );
  } catch (e) {
    console.warn(`[question-pin] unpin ${keyToString(key)} msg ${messageId} failed: ${describeSendError(e)}`);
  }
}

/**
 * @description Whether this thread's binding is eligible for a pinned
 * banner. General has no per-thread state to mirror; closed topics get
 * the banner left as-is (Telegram refuses edits in closed topics).
 */
function shouldHavePinnedStatus(key: SessionKey): boolean {
  if (checkIsGeneral(key)) return false;
  return state.getBinding(key) !== null;
}

/**
 * @description Compute the current pinned status text for `key` from live
 * adapter + state. Returns `null` if the thread shouldn't have a banner
 * (no binding, or in the General topic).
 */
function computePinnedStatusText(key: SessionKey): string | null {
  const binding = state.getBinding(key);
  if (!binding) return null;

  let agentLabel: string | null = null;
  let model: string | null = null;
  let effort: string | null = null;
  let isActive = false;

  const agent = state.getAgent(key);
  if (agent?.name) {
    try {
      const adapter = getAdapter(agent.name);
      agentLabel = adapter.label;
      isActive = adapter.checkIsActive(key);
      model = adapter.getCurrentModel?.(key) ?? agent.model ?? null;
      effort = adapter.getEffort?.(key) ?? null;
    } catch {
      // Unknown adapter name from a stale binding — fall back to raw name
      // so the banner is still informative.
      agentLabel = agent.name;
      model = agent.model ?? null;
    }
  }

  return formatPinnedStatus({ binding, agentLabel, model, effort, isActive });
}

/**
 * @description Send-or-edit the pinned status banner for a thread.
 *
 * Idempotent — safe to call from every adapter lifecycle event. Failures
 * (missing `can_pin_messages`, closed topic, network) are logged but do
 * not surface to the user: the banner is convenience UI, not blocking UX.
 *
 * NB: pinned messages must NOT be auto-tracked into `state.messages[key]`,
 * otherwise `/clear` would delete the banner. We call `bot.telegram.*`
 * directly through `enqueueSend` to skip `replyToThread`'s tracking step.
 */
async function updatePinnedStatus(key: SessionKey): Promise<void> {
  const k = keyToString(key);
  if (unbindingKeys.has(k)) return;
  if (!shouldHavePinnedStatus(key)) return;

  // Audit S6 / #8: serialise all banner work for a key — without this,
  // two near-simultaneous adapter events could both observe a missing
  // `pinnedStatusMessageId` and stack duplicate pins. Errors from one
  // invocation must not poison followers, so `KeyLock` swallows them
  // internally (the body's own try/catch already handles user-facing
  // outcomes).
  await pinnedStatusLock.withLock(k, async () => {
    if (unbindingKeys.has(k)) return;
    if (!shouldHavePinnedStatus(key)) return;

    const text = computePinnedStatusText(key);
    if (text === null) return;

    const binding = state.getBinding(key);
    if (!binding) return;

    // Skip the edit when nothing changed since the last send/edit. The
    // in-memory cache is empty on every restart, so fall back to the text
    // persisted in state.json — this lets the boot-time refresh wave skip
    // re-editing banners that are already current (B8) instead of spending a
    // wasted "message is not modified" 400 per binding on the chat-wide budget.
    const skipDecision = getPinnedBannerSkipDecision({
      computedText: text,
      cachedText: pinnedStatusTextCache.get(k),
      persistedText: binding.pinnedStatusText,
    });
    if (skipDecision === 'skip') return;
    if (skipDecision === 'seedAndSkip') {
      pinnedStatusTextCache.set(k, text);
      return;
    }

    const existingId = binding.pinnedStatusMessageId;

    if (existingId !== undefined) {
      try {
        await enqueueSend(key, () =>
          bot.telegram.editMessageText(getTelegramChatId(key), existingId, undefined, text),
        );
        pinnedStatusTextCache.set(k, text);
        persistPinnedStatusText(key, text);
        return;
      } catch (e) {
        const desc = checkIsApiError(e) ? getErrorDescription(e) : '';
        if (/message is not modified/i.test(desc)) {
          pinnedStatusTextCache.set(k, text);
          persistPinnedStatusText(key, text);
          return;
        }
        if (!/message to edit not found|MESSAGE_ID_INVALID|message can't be edited/i.test(desc)) {
          // Other errors — log and bail without churning state. The next
          // call will retry; we don't want to spam new banners on every
          // transient API hiccup.
          console.warn(`[pinned] edit ${k} failed: ${desc || (e instanceof Error ? e.message : e)}`);
          return;
        }
        // Pinned message was deleted out from under us — fall through to
        // send a fresh one. Clear BOTH the id and the persisted text: the
        // stale text must never suppress the edit for the NEW banner message
        // (B8). The in-memory cache is cleared too so the fresh send isn't
        // short-circuited by a leftover match.
        pinnedStatusTextCache.delete(k);
        await state.setBindingPinnedStatusMessageId(key, null).catch(() => {});
        await state.setBindingPinnedStatusText(key, null).catch(() => {});
      }
    }

    let messageId: number;
    try {
      const sent = await enqueueSend(key, () =>
        bot.telegram.sendMessage(getTelegramChatId(key), text, {
          message_thread_id: getTelegramThreadId(key),
          disable_notification: true,
        }),
      );
      messageId = (sent as { message_id: number }).message_id;
    } catch (e) {
      await handleSendError(key, e);
      return;
    }

    try {
      await enqueueSend(key, () =>
        bot.telegram.pinChatMessage(getTelegramChatId(key), messageId, {
          disable_notification: true,
        }),
      );
    } catch (e) {
      // Most common reason: bot is not admin or lacks `can_pin_messages`.
      // We still keep the message id so subsequent edits keep refreshing it
      // (so the user at least sees a fresh status line in the topic body
      // even without a pin).
      console.warn(`[pinned] pin ${k} failed: ${describeSendError(e)}`);
    }

    await state.setBindingPinnedStatusMessageId(key, messageId).catch(err =>
      console.warn(`[pinned] persist id for ${k} failed:`, err),
    );
    pinnedStatusTextCache.set(k, text);
    persistPinnedStatusText(key, text);
  });
}

/**
 * @description Fire-and-forget persist of the banner text for a thread so a
 * later restart can seed `pinnedStatusTextCache` and skip identical-banner
 * edits (B8). Mirrors the `state.setBindingPinnedStatusMessageId(...).catch`
 * pattern used for the id — the banner is convenience UI, so a failed persist
 * is logged, not surfaced.
 */
function persistPinnedStatusText(key: SessionKey, text: string): void {
  state.setBindingPinnedStatusText(key, text).catch(err =>
    console.warn(`[pinned] persist text for ${keyToString(key)} failed:`, err),
  );
}

/**
 * @description Unpin and delete the banner for a thread; clear the cached
 * id. Called from `/unbind` before `state.removeBinding` wipes the row.
 *
 * Both Telegram calls swallow errors — if the banner is already gone or
 * the bot lost pin permissions mid-flight, the user-facing /unbind ack
 * shouldn't fail because of it.
 */
async function clearPinnedStatus(key: SessionKey): Promise<void> {
  const k = keyToString(key);
  // Same lock as `updatePinnedStatus` so an `/unbind` mid-flight doesn't
  // race a concurrent banner refresh and leak a freshly-pinned message.
  await pinnedStatusLock.withLock(k, async () => {
    pinnedStatusTextCache.delete(k);

    const binding = state.getBinding(key);
    const existingId = binding?.pinnedStatusMessageId;
    if (existingId === undefined) return;

    try {
      await enqueueSend(key, () =>
        bot.telegram.unpinChatMessage(getTelegramChatId(key), existingId),
      );
    } catch (e) {
      console.warn(`[pinned] unpin ${k} failed: ${describeSendError(e)}`);
    }
    try {
      await enqueueSend(key, () =>
        bot.telegram.deleteMessage(getTelegramChatId(key), existingId),
      );
    } catch {
      // Older than 48h or already deleted — silently ignored.
    }
    await state.setBindingPinnedStatusMessageId(key, null).catch(() => {});
    // Clear the persisted text alongside the id so a future /bind in the same
    // thread can't have its first banner edit suppressed by a stale match (B8).
    await state.setBindingPinnedStatusText(key, null).catch(() => {});
  });
}

/**
 * @description Pin the pending question's message so the topic — which the
 * operator keeps muted — fires a Telegram notification (a pin pierces a muted
 * topic). Mirrors the {@link updatePinnedStatus} pin pattern: routed through
 * `enqueueSend`, errors swallowed + logged (missing `can_pin_messages`, closed
 * topic, network) — the pin is convenience UI and must never fail the question
 * flow. A DIFFERENT question already pinned for this thread is unpinned first, so
 * the topic never keeps a stale pinned question (Q1→Q2 advance, or an S3
 * re-post-to-bottom that replaced the message id).
 *
 * Notifies ONLY on the FIRST pin of a thread's pending question; every RE-pin is
 * SILENT (`disable_notification: true`) so one question = one notification. The
 * first-vs-repin signal is the in-memory map: `existingId === undefined` ⇒ nothing
 * pinned yet ⇒ first pin ⇒ notify; an `existingId` ⇒ a repin from the S3 repost /
 * Q1→Q2 advance ⇒ silent (the entry only clears on resolve via
 * {@link unpinThreadQuestion}, so it survives reposts). Unpinning is per-message-id,
 * so the banner's own (silent) pin is never disturbed.
 */
async function pinThreadQuestion(key: SessionKey, messageId: number): Promise<void> {
  const kStr = keyToString(key);
  // Hold the lock across the whole read-modify-write (F2): re-read the map INSIDE
  // the critical section so a concurrent pin/unpin for this key can't make us
  // act on a stale `existingId` (double-notify, or a phantom id that silences
  // the next first-pin).
  await questionPinLock.withLock(kStr, async () => {
    const existingId = questionPinnedMessageId.get(kStr);
    // A pinned entry already present ⇒ this is a repin (S3 repost / Q1→Q2), which
    // must NOT re-notify — only the FIRST pin pierces the muted topic, once.
    const isRepin = existingId !== undefined;
    // Same message already pinned (and already notified) — nothing to do.
    if (existingId === messageId) return;
    // Retire a DIFFERENT previous question pin so the topic never keeps a stale one.
    if (existingId !== undefined) await unpinMessageQuiet(key, existingId);
    const pinned = await pinMessageQuiet(key, messageId, { disableNotification: isRepin });
    // Keep the map in lockstep with what is actually pinned: store on success;
    // on failure (e.g. lost `can_pin_messages` — we just unpinned any previous)
    // clear it so a later unpin doesn't chase a message we never pinned AND the
    // next pin counts as a first pin (notifies).
    if (pinned) questionPinnedMessageId.set(kStr, messageId);
    else questionPinnedMessageId.delete(kStr);
  });
}

/**
 * @description Remove the thread's pinned question once it resolves (answered /
 * cancelled / session torn down / binding left). Fire-and-forget, errors
 * swallowed. Purely map-driven under {@link questionPinLock}; the post-restart
 * OpenCode case (in-memory map lost but the message still pinned on Telegram) is
 * handled by {@link clearPendingQuestion} seeding the map from the persisted
 * `pendingQuestions` entry BEFORE calling this, so there is no cross-map timing
 * dependency.
 */
async function unpinThreadQuestion(key: SessionKey): Promise<void> {
  const kStr = keyToString(key);
  await questionPinLock.withLock(kStr, async () => {
    const pinnedId = questionPinnedMessageId.get(kStr);
    questionPinnedMessageId.delete(kStr);
    if (pinnedId === undefined) return;
    await unpinMessageQuiet(key, pinnedId);
  });
}

/**
 * @description Send a message into a specific thread, going through the
 * per-chat rate-limit queue and auto-tracking the message id in state.json.
 *
 * This is the **only** function bot code should use to send new messages.
 * Direct `bot.telegram.sendMessage(...)` calls bypass tracking and the
 * `/clear` command will then leave orphan messages behind (plan §13.11, D19).
 *
 * Returns the message id on success, `null` on failure (the error has
 * already been logged / handled — caller doesn't need to wrap in try/catch).
 */
/**
 * `extra` is intentionally typed as a loose object so Telegraf `Markup<>`
 * values (which expose `reply_markup` but don't satisfy a string index
 * signature) and plain `{ parse_mode: 'Markdown' }` records both work.
 */
type SendExtra = Record<string, unknown> | object;

/**
 * @description Build the `extra` object for outbound `send*` calls so the
 * General topic gets NO `message_thread_id` while topical threads get one.
 *
 * Telegram historically reserved `message_thread_id == 1` for the General
 * topic on inbound updates, but on **outbound** sends `1` now returns
 * `400 Bad Request: message thread not found` in current Bot API versions
 * (confirmed against this group, 2026-05). The fix is to omit the field
 * entirely for General — the message lands in General by default.
 *
 * Our internal routing still keeps `GENERAL_THREAD_ID = 1` as the marker
 * for "this update came from / belongs to General" because incoming
 * updates may still carry `message_thread_id: 1`. Translation happens
 * only at the API boundary.
 */
function buildSendExtra(key: SessionKey, extra: SendExtra): Record<string, unknown> {
  const base = extra as Record<string, unknown>;
  if (checkIsGeneral(key)) return { ...base };
  // Audit S20 / #36: spread `base` BEFORE `message_thread_id` so a
  // caller passing `message_thread_id: undefined` in `extra` can't
  // accidentally suppress our routing. With this order, our explicit
  // value wins regardless of what the caller passed.
  return { ...base, message_thread_id: getTelegramThreadId(key) };
}

/**
 * @description Options for {@link replyToThread}.
 */
interface ReplyToThreadOptions {
  /**
   * Route the send OUTSIDE the global message pacer (via {@link sendUnpaced})
   * instead of the paced {@link enqueueSend}. Default `false`. Reserved for
   * user-input acknowledgements — e.g. the voice-transcript echo — that must
   * surface immediately and not queue behind the thread's streaming agent
   * output. Still 429-safe and traced; do NOT use it for ordinary agent output.
   */
  unpaced?: boolean;
}

async function replyToThread(
  key: SessionKey,
  text: string,
  extra: SendExtra = {},
  options: ReplyToThreadOptions = {},
): Promise<number | null> {
  const sendOnce = (sendExtra: Record<string, unknown>) => {
    const send = () =>
      bot.telegram.sendMessage(
        getTelegramChatId(key),
        text,
        sendExtra as Parameters<typeof bot.telegram.sendMessage>[2],
      );
    return options.unpaced ? sendUnpaced(key, send) : enqueueSend(key, send);
  };

  try {
    const sent = await sendOnce(buildSendExtra(key, extra));
    const messageId = (sent as { message_id: number }).message_id;
    await state.pushMessageId(key, messageId);
    return messageId;
  } catch (e) {
    // Markdown parse failure fallback. Several `t(...)` templates interpolate
    // user-controlled content (subdir names, branch names, error strings)
    // into Markdown body — a backtick or stray `*` inside the content
    // breaks Telegram's parser and the whole message gets dropped with a
    // 400. The right reflex is to retry WITHOUT `parse_mode` so the user
    // sees raw text instead of silence (review of the live "wrote 3 times,
    // bot silent" repro). Logged for follow-up so we still find and escape
    // the culprit at source.
    const desc = checkIsApiError(e) ? getErrorDescription(e) : '';
    const hasParseMode =
      typeof (extra as Record<string, unknown>).parse_mode === 'string';
    if (hasParseMode && /can't parse entities/i.test(desc)) {
      console.warn(
        `[send] ${keyToString(key)} markdown parse failed (${desc}); retrying as plain text`,
      );
      const plainExtra = { ...(extra as Record<string, unknown>) };
      delete plainExtra.parse_mode;
      try {
        const sent = await sendOnce(buildSendExtra(key, plainExtra));
        const messageId = (sent as { message_id: number }).message_id;
        await state.pushMessageId(key, messageId);
        return messageId;
      } catch (e2) {
        await handleSendError(key, e2);
        return null;
      }
    }

    // A double-429 (rate-limited even after withRateLimitRetry's single
    // retry-after wait) surfaces as a RateLimitedError. The global 1/2s send
    // pacer (S1) makes a sustained 429 essentially impossible, so we no longer
    // re-arm a bounded redelivery (its late re-send was the OUT-OF-ORDER cause
    // the user reported) — the rare 429 is just logged via handleSendError.
    await handleSendError(key, e);
    return null;
  }
}

/**
 * @description Edit an existing assistant message in the thread.
 *
 * Returns `true` on success, `false` if the edit failed for any reason —
 * caller decides whether to fall back to a new `replyToThread`. We don't
 * track edits as new ids (the original was already tracked).
 */
async function editThreadMessage(
  key: SessionKey,
  messageId: number,
  text: string,
  extra: SendExtra = {},
): Promise<boolean> {
  const editOnce = (editExtra: Record<string, unknown>) =>
    enqueueSend(key, () =>
      bot.telegram.editMessageText(
        getTelegramChatId(key), messageId, undefined, text,
        editExtra as Parameters<typeof bot.telegram.editMessageText>[4],
      ),
    );

  try {
    await editOnce(extra as Record<string, unknown>);
    return true;
  } catch (e) {
    const desc = checkIsApiError(e) ? getErrorDescription(e) : '';
    if (/message is not modified/i.test(desc)) return true; // benign
    if (
      /thread not found|TOPIC_CLOSED|topic is closed/i.test(desc)
    ) {
      await handleSendError(key, e);
      return false;
    }
    // Symmetric markdown-parse-fail fallback to `replyToThread`. See the
    // long comment there — same rationale: prefer a plain-text edit over
    // a silent drop.
    const hasParseMode =
      typeof (extra as Record<string, unknown>).parse_mode === 'string';
    if (hasParseMode && /can't parse entities/i.test(desc)) {
      console.warn(
        `[edit] ${keyToString(key)}#${messageId} markdown parse failed (${desc}); retrying as plain text`,
      );
      const plainExtra = { ...(extra as Record<string, unknown>) };
      delete plainExtra.parse_mode;
      try {
        await editOnce(plainExtra);
        return true;
      } catch (e2) {
        const desc2 = checkIsApiError(e2) ? getErrorDescription(e2) : '';
        if (/message is not modified/i.test(desc2)) return true;
        console.error(`[edit] ${keyToString(key)}#${messageId} retry failed:`, desc2 || e2);
        return false;
      }
    }
    console.error(`[edit] ${keyToString(key)}#${messageId}:`, desc || e);
    return false;
  }
}

async function deleteThreadMessage(
  key: SessionKey,
  messageId: number,
): Promise<void> {
  try {
    await enqueueSend(key, () => bot.telegram.deleteMessage(getTelegramChatId(key), messageId));
  } catch {
    /* messages older than 48h or already deleted — silently ignore */
  }
}

/**
 * @description `sendChatAction('typing')` in a thread. Best-effort; we
 * don't fail the caller if the API rejects it (e.g. action briefly not
 * supported for forum threads on older clients).
 *
 * Sent via {@link sendUnpaced}, NOT the paced {@link enqueueSend}: the typing
 * action is not a Telegram message and is not subject to the flood limit, yet
 * at one tick / thread / few seconds it used to eat ~60% of the global send
 * budget and push real message sends (voice echoes, acks) minutes behind. It
 * stays 429-safe and traced (both live at the `callApi` chokepoint), it just no
 * longer takes a pacer permit or queues behind the thread's other sends.
 */
async function sendThreadTypingIndicator(key: SessionKey): Promise<void> {
  try {
    await sendUnpaced(key, () =>
      bot.telegram.sendChatAction(
        getTelegramChatId(key),
        'typing',
        // Omit thread_id for General; see buildSendExtra docs.
        checkIsGeneral(key) ? undefined : { message_thread_id: getTelegramThreadId(key) },
      ),
    );
  } catch (e) {
    console.log(`[typing] ${keyToString(key)} failed:`, e instanceof Error ? e.message : e);
  }
}

/** Whether the thread's adapter is still working (its optional `checkIsBusy`). */
function checkIsAdapterBusy(key: SessionKey): boolean {
  return getThreadAdapter(key).checkIsBusy?.(key) === true;
}

/**
 * @description S3 — should the native typing state keep showing for `key`? True
 * while output is mid-flight, the agent is still working, OR a bot-issued
 * compaction is running. The pure rule lives in `utils/typingActive`; this wraps
 * it with the three live readings.
 */
function checkShouldKeepTyping(key: SessionKey): boolean {
  return checkShouldKeepTypingDecision({
    isOutputStreaming: checkIsOutputStreaming(key),
    isAdapterBusy: checkIsAdapterBusy(key),
    isCompacting: checkIsThreadCompacting(key),
  });
}

/**
 * @description Start the sustained "agent is working" loader for `key`: fire the
 * native typing indicator NOW, then keep re-firing it every
 * {@link typingLoaderRefreshMs} (Telegram's `typing` action self-expires). This
 * is the ONLY loader — it replaced the old `⏳` placeholder message. Idempotent:
 * an already-running loader is cleared first so a second start can't leave two
 * timers.
 *
 * S3: the loader is a PERSISTENT state — each tick keeps firing `typing` while
 * {@link checkShouldKeepTyping} holds (output streaming, agent busy, OR a
 * bot-issued compaction in flight) and self-stops once the topic is truly drained
 * + idle + not compacting. It is NOT cleared on the first output any more; hard
 * teardown paths (session end / question UI / unbind) still call
 * {@link stopTypingLoader} directly.
 */
function startTypingLoader(key: SessionKey): void {
  const s = getThreadMessageState(key);
  if (s.typingLoaderTimer) clearInterval(s.typingLoaderTimer);
  sendThreadTypingIndicator(key).catch(() => {});
  s.typingLoaderTimer = setInterval(() => {
    if (!checkShouldKeepTyping(key)) {
      stopTypingLoader(key);
      return;
    }
    // Loop-level backstop: `checkShouldKeepTyping` still holds, but is it a
    // GENUINE working/streaming state, or a leaked one? A live debounce timer is
    // always armed WITH pending text; an armed handle over an otherwise-empty,
    // not-busy queue is the dead handle from the `isFinal` fast-path — it pins
    // `isOutputStreaming` true forever and the indicator hangs unbounded (the
    // hour+ hang). The pure decision (`utils/typingLoopBackstop`) fires ONLY on
    // that provable inconsistency, never on a legit long silent-tool turn (which
    // keeps the adapter busy). Diagnose which input kept the loop alive, repair
    // the leaked handle, and stop — so a FUTURE unknown leak is self-recorded too.
    if (checkIsTypingLoopStuck(key)) {
      const q = outputQueues.get(keyToString(key));
      console.warn(
        `[typing] ${keyToString(key)} force-stop: kept alive by leaked output-queue state — ` +
        `isOutputStreaming=${checkIsOutputStreaming(key)} isAdapterBusy=${checkIsAdapterBusy(key)} ` +
        `pendingOutput=${q?.pendingOutput !== null && q?.pendingOutput !== undefined} ` +
        `isProcessing=${q?.isProcessing === true} debounceTimer=${q?.debounceTimer !== null && q?.debounceTimer !== undefined}`,
      );
      if (q?.debounceTimer) { clearTimeout(q.debounceTimer); q.debounceTimer = null; }
      stopTypingLoader(key);
      return;
    }
    sendThreadTypingIndicator(key).catch(() => {});
  }, typingLoaderRefreshMs);
  // Don't keep the event loop alive just for a loader (mirrors the liveness timer).
  s.typingLoaderTimer.unref?.();
}

/**
 * @description Loop-level backstop check: is the typing loop being kept alive
 * PURELY by a leaked output-queue state (an armed debounce handle over an empty,
 * not-busy queue) rather than genuine work? Wraps the pure
 * {@link checkIsTypingStuckByLeak} with the live queue + adapter readings. Only
 * fires on a provable inconsistency, so it never truncates a legit long turn.
 */
function checkIsTypingLoopStuck(key: SessionKey): boolean {
  const q = outputQueues.get(keyToString(key));
  return checkIsTypingStuckByLeak({
    isAdapterBusy: checkIsAdapterBusy(key),
    isCompacting: checkIsThreadCompacting(key),
    isTransportStreaming: telegramOutbound.checkIsDelivering(key),
    hasPendingOutput: q?.pendingOutput != null,
    isProcessing: q?.isProcessing === true,
    hasDebounceTimer: q?.debounceTimer != null,
  });
}

/**
 * @description Stop the typing loader for `key` (clear the re-fire timer). The
 * typing indicator itself self-expires within a few seconds, so there is nothing
 * to delete — just stop refreshing it. Idempotent (no-op when no loader runs).
 */
function stopTypingLoader(key: SessionKey): void {
  const s = getThreadMessageState(key);
  if (s.typingLoaderTimer) {
    clearInterval(s.typingLoaderTimer);
    s.typingLoaderTimer = null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Output rendering — split, escape, queued edits
// ═══════════════════════════════════════════════════════════════════════════════


function escapeMarkdownChars(text: string): string {
  return text
    .replace(/\*/g, '\\*')
    .replace(/_/g, '\\_')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/`/g, '\\`');
}

// Audit S13 / #29: hoisted to module scope so `escapeMarkdown` doesn't
// recompile the regex on every output chunk. `g`-flag regexes are stateful
// (`lastIndex`), so we explicitly reset before each use.
const ESCAPE_BOLD_REGEX = /\*([^*\n]+)\*/g;

/**
 * @description Best-effort escape that preserves existing `*bold*` runs
 * while escaping incidental Markdown chars elsewhere. Same heuristic as
 * the legacy bot — Telegram's classic Markdown is loose enough that this
 * holds for the agent output we render.
 */
function escapeMarkdown(text: string): string {
  ESCAPE_BOLD_REGEX.lastIndex = 0;
  const boldMatches: Array<{ start: number; end: number; content: string }> = [];

  let match;
  while ((match = ESCAPE_BOLD_REGEX.exec(text)) !== null) {
    boldMatches.push({
      start: match.index,
      end: match.index + match[0].length,
      content: match[1],
    });
  }

  let result = '';
  let lastIndex = 0;
  for (const m of boldMatches) {
    const before = text.slice(lastIndex, m.start);
    result += escapeMarkdownChars(before);
    const escapedContent = m.content.replace(/_/g, '\\_').replace(/\[/g, '\\[').replace(/\]/g, '\\]');
    result += `*${escapedContent}*`;
    lastIndex = m.end;
  }
  result += escapeMarkdownChars(text.slice(lastIndex));
  return result;
}

/**
 * @description Queue an output text for a thread with debounce.
 *
 * Multiple `output` events from the adapter are coalesced into one pending
 * buffer (see {@link appendPendingOutput}), not overwritten — every emitted
 * chunk reaches Telegram. A continuation tail concatenates as-is (it may be
 * cut mid-word); a standalone output joins the buffer with `\n`. The first
 * batch's `isContinuation` is recorded so the flush knows whether the buffer
 * extends the last sent message or starts a new one. During a 429 cooldown
 * the delay stretches so we don't keep hammering the API.
 */
/**
 * Audit S13 / #30: extracted from two near-identical ternaries; lengthens
 * the debounce window during a 429 cooldown so we don't keep hammering
 * Telegram while it's already throttling us. Now a thin wrapper over the pure
 * {@link getOutputFlushTiming} — used by the re-trigger timer (always non-final,
 * so it never returns `'now'`).
 */
function getOutputDelay(chatId: number): number {
  const normalDebounceMs = getOutputDebounceMs();
  const timing = getOutputFlushTiming({
    isFinal: false,
    isRateLimited: checkIsRateLimited(chatId),
    normalDebounceMs,
    // S3: while throttled, scale the debounce to the live remaining cooldown so
    // a long 429 batches into one larger edit instead of a backlog of tiny ones.
    remainingCooldownMs: getRateLimitRemainingMs(chatId),
  });
  // Non-final input can only yield a numeric delay, never `'now'`.
  return timing === 'now' ? normalDebounceMs : timing;
}

/**
 * @param isFinal True when this is the turn's last frame (the OpenCode session
 *   went idle). The frame is appended exactly like any other (continuation
 *   semantics unchanged), but instead of waiting out the possibly-429-stretched
 *   debounce it is flushed immediately so the turn never looks hung behind a
 *   cooldown.
 */
function queueOutput(
  key: SessionKey,
  output: string,
  isContinuation = false,
  isFinal = false,
  isComplete = false,
  startsNewParagraph = false,
): void {
  const q = getOutputQueueState(key);
  // The continuation flag of the FIRST batch in a fresh buffer decides whether
  // the whole flush extends the last sent message; later batches only append.
  if (q.pendingOutput === null) q.pendingIsContinuation = isContinuation;
  q.pendingOutput = appendPendingOutput(q.pendingOutput, output, isContinuation, startsNewParagraph);
  // `isFinal` / `isComplete` still drive the immediate-flush timing below (a
  // finished turn must not wait out the debounce) — they no longer mark the
  // buffer for redelivery (retired with the global send pacer, S4).
  // NULL the handle, don't just clear it: the `timing === 'now'` branch below
  // RETURNS without reassigning `q.debounceTimer`, so a bare `clearTimeout` left
  // the field holding a dead-but-non-null handle. `checkIsOutputStreaming` reads
  // `q.debounceTimer !== null`, so that stale handle pinned "output streaming"
  // true forever after the final flush → the native typing indicator hung for
  // an hour+ on an idle topic (live 2026-07-19, a json-stream group topic whose
  // turn ended with a residual `isFinal` flush). Nulling here keeps the field
  // authoritative on every path; the else-branch reassigns it a fresh timer.
  if (q.debounceTimer) { clearTimeout(q.debounceTimer); q.debounceTimer = null; }

  const timing = getOutputFlushTiming({
    // A complete one-shot flushes immediately like a final frame — ready content
    // must not wait out the (dm-stretched) debounce.
    isFinal: isFinal || isComplete,
    isRateLimited: checkIsRateLimited(getTelegramChatId(key)),
    normalDebounceMs: getOutputDebounceMs(),
    // S3: scale the in-cooldown debounce to the live remaining cooldown.
    remainingCooldownMs: getRateLimitRemainingMs(getTelegramChatId(key)),
  });
  if (timing === 'now') {
    // Final frame: flush immediately. `processOutputQueue` already guards
    // `isProcessing`, so this is idempotent if a flush is mid-flight (the
    // pending frame will be picked up by the re-trigger timer it arms).
    void processOutputQueue(key);
    return;
  }
  q.debounceTimer = setTimeout(() => {
    q.debounceTimer = null;
    processOutputQueue(key);
  }, timing);
}

async function processOutputQueue(key: SessionKey): Promise<void> {
  const q = getOutputQueueState(key);
  if (q.isProcessing || !q.pendingOutput) return;
  q.isProcessing = true;
  try {
    const out = q.pendingOutput;
    const isContinuation = q.pendingIsContinuation;
    q.pendingOutput = null;
    const { unsentRemainder } = await sendOutputImmediate(key, out, isContinuation);
    // No silent drop: a chunk dropped on a 429 after the retry-after wait comes
    // back as `unsentRemainder`. Put it BACK at the FRONT of the buffer (it is
    // older than anything that arrived during the await) so the re-trigger flush
    // below retries it — never lost. Landed chunks are excluded by
    // `getUnsentRemainder`, so this never re-sends what already reached Telegram.
    // The remainder restarts a fresh message (its predecessors landed / edited in
    // place already), so it is NOT a continuation.
    if (unsentRemainder) {
      q.pendingOutput =
        q.pendingOutput === null
          ? unsentRemainder
          : appendPendingOutput(unsentRemainder, q.pendingOutput, false);
      q.pendingIsContinuation = false;
    }
  } finally {
    q.isProcessing = false;
    if (q.pendingOutput) {
      // Audit S13 / #30: the re-trigger `setTimeout` used to be a bare
      // call whose handle was never stored. A `queueOutput` call between
      // here and the timer firing would `clearTimeout(null)` and
      // schedule a duplicate timer, leaving one orphan callback alive.
      // Routing through `queueOutput`-equivalent code keeps `q.debounceTimer`
      // authoritative.
      if (q.debounceTimer) clearTimeout(q.debounceTimer);
      q.debounceTimer = setTimeout(() => {
        q.debounceTimer = null;
        processOutputQueue(key);
      }, getOutputDelay(getTelegramChatId(key)));
    }
  }
}

/**
 * @description Group-path `finalizeInFlight`: reconcile the thread's
 * coalesced-but-unsent output against what actually landed, and force-send the
 * remainder so the agent's FINAL answer is never discarded on teardown (S2).
 *
 * Today the group output queue coalesces into `q.pendingOutput` and the
 * (possibly 429-stretched) debounce flushes it later; a teardown
 * (`idle`/`isFinal` → `handleAgentStopped`, `/new`, `/quit`, `/unbind`,
 * topic-delete) runs `clearThreadOutputQueues` which DISCARDS that buffer — so
 * under a sustained 429 the settled final answer could vanish with only a
 * `console.error`. This drains the buffer FIRST.
 *
 * Captures + nulls the buffer SYNCHRONOUSLY before its await, so the
 * immediately-following `clearThreadOutputQueues` finds nothing to discard and
 * the drain is never double-sent (mirrors `processOutputQueue`'s snapshot
 * discipline + the DM `finalizeDraft` reset-before-await). Idempotent + runs
 * exactly once per turn: an empty buffer (a fully-delivered turn) is a no-op,
 * so no duplicate post. The drain just sends the remainder once; the global 1/2s
 * send pacer (S1) makes a 429 at this point essentially impossible.
 */
async function finalizeGroupOutput(key: SessionKey): Promise<void> {
  const q = outputQueues.get(keyToString(key));
  if (!q) return;
  const plan = getGroupFinalizePlan(q);
  if (plan.action === 'noop') return; // fully delivered → no-op, no dupe.
  // Snapshot is captured by the plan; null the buffer SYNCHRONOUSLY before the
  // await so the immediately-following clear / a concurrent flush can't re-send it.
  q.pendingOutput = null;
  if (q.debounceTimer) {
    clearTimeout(q.debounceTimer);
    q.debounceTimer = null;
  }
  const { unsentRemainder } = await sendOutputImmediate(key, plan.text, plan.isContinuation);
  // A remainder that still 429'd at teardown is dropped (the buffer is being
  // torn down anyway — unchanged from the pre-S2 discard). Do NOT re-queue: the
  // queue is about to be cleared, and re-queuing would race that clear. At 1/2s
  // global pacing a 429 here is essentially impossible.
  if (unsentRemainder) {
    console.warn(`[send] ${keyToString(key)} finalize remainder 429'd and was dropped at teardown`);
  }
}

/**
 * @description Render `output` as the agent's permanent message in a thread.
 *
 * Append semantics for continuations: when `isContinuation` is true and the
 * last message is still editable, the flush re-renders `lastMessageText +
 * output` and edits that message in place — the one message GROWS as the
 * streamed reply arrives, spilling into fresh messages once it outgrows the
 * Telegram cap. The pre-render append base lives in `msgState.lastMessageText`.
 *
 * Fresh outputs ALWAYS send a new message — never edit. The old edit-in-place
 * for fresh outputs was the data-loss bug: each interim tail replaced the whole
 * previous text on the same message id, so the user could read only the last
 * tail. Editing is now reserved for explicit continuations of the SAME reply.
 *
 * On Markdown rejection by Telegram we fall back to plain text (`parse_mode`
 * unset) — the message lands either way. If the in-place edit fails (message
 * deleted / API hiccup) we send every chunk fresh so the full combined text
 * still reaches the user.
 */
async function sendOutputImmediate(
  key: SessionKey,
  output: string,
  isContinuation = false,
): Promise<{ unsentRemainder: string | null }> {
  // The typing loader is stopped upstream in `handleAgentOutput` (the shared
  // onOutput entry for BOTH transports), so it's not repeated here.
  await deleteStatusMessage(key);

  const msgState = getThreadMessageState(key);
  const { chunks: planChunks, shouldEditFirstChunk } = getOutputFlushPlan({
    output,
    isContinuation,
    needsNewMessage: msgState.needsNewMessage,
    lastMessageId: msgState.lastMessageId,
    lastMessageText: msgState.lastMessageText,
  });
  // S2b: when this flush starts FRESH (no in-place edit) and its backlog is ≥3
  // messages, glue them into the fewest \n\n-joined messages so a burst drains in
  // one send, not a per-2s trickle behind the global pacer. The edit-in-place
  // (continuation) path is left untouched — chunks[0] must still match the
  // message being edited. Glue uses the same rendered-length measure the plan
  // split with, so a glued block never exceeds Telegram's cap.
  const chunks = shouldEditFirstChunk
    ? planChunks
    : glueBacklogFrames(planChunks, MAX_MESSAGE_LEN, (chunk) => renderAgentHtml(chunk).length);

  let startIndex = 0;
  if (shouldEditFirstChunk) {
    const editedOk =
      chunks[0] === msgState.lastMessageText ||
      (await editThreadMessage(key, msgState.lastMessageId!, renderAgentHtml(chunks[0]), { parse_mode: 'HTML' }));
    if (editedOk) {
      msgState.lastMessageText = chunks[0];
      startIndex = 1;
    }
    // Edit failed (message deleted / API hiccup): fall through and send every
    // chunk fresh — the full combined text still reaches the user.
  }

  // No silent drop: track how many chunks actually landed, counting from the
  // FRONT. `startIndex` already covers a successful in-place edit of chunks[0];
  // when that edit failed it is 0 and every chunk re-sends fresh below. A
  // `replyChunkWithFallback` that returns null means the chunk was dropped on a
  // 429 after the retry-after wait — STOP the run (the cooldown would drop the
  // rest of this synchronous flush too) and report the un-sent remainder so the
  // caller re-enqueues it for the next flush.
  let sentCount = startIndex;
  for (let i = startIndex; i < chunks.length; i++) {
    const id = await replyChunkWithFallback(key, renderAgentHtml(chunks[i]), chunks[i]);
    if (!id) break;
    msgState.lastMessageId = id;
    msgState.lastMessageText = chunks[i];
    msgState.needsNewMessage = false;
    sentCount = i + 1;
  }

  // S3: output just landed below any pending question — bring the question back
  // to the bottom (debounced; no-op when no question is pending).
  onThreadActivityWhileQuestionPending(key);

  return { unsentRemainder: getUnsentRemainder(chunks, sentCount) };
}

/**
 * @description Send a chunk as HTML first; if Telegram rejects the entities,
 * fall back to plain text so the message reaches the user either way.
 */
async function replyChunkWithFallback(
  key: SessionKey,
  renderedHtml: string,
  plainFallback: string,
  replyMarkup?: InlineKeyboardMarkup,
): Promise<number | null> {
  const markupExtra = replyMarkup ? { reply_markup: replyMarkup } : {};
  const id = await replyToThread(key, renderedHtml, { parse_mode: 'HTML', ...markupExtra });
  if (id) return id;
  return replyToThread(key, plainFallback, markupExtra);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Shared output send primitives + the DM draft channel's `sendMessageDraft` call
//
//  The DM live-draft MANAGER moved to `output/dmOutputTransport.ts` (the
//  OutputTransport seam). `callSendMessageDraft` and `sendAgentChunks` stay here
//  because they are SHARED: `sendAgentChunks` lands permanent messages for the
//  group path / the `isComplete` one-shot too, and the draft channel's untyped
//  `callApi` view is injected into the DM transport. Both are passed in via the
//  factory deps at boot.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * `sendMessageDraft` is a real Bot API method but is absent from this telegraf /
 * typegram version's `Telegram` type, so `callApi('sendMessageDraft', …)` won't
 * typecheck against the `M extends keyof Telegram` signature. We narrow a
 * локализованный untyped view of `callApi` here (the `deleteMessages` precedent
 * at the top of this file is typed; this one genuinely isn't in the vendored
 * types). Payload is the locked shape from the P0/P0.5 live probes.
 */
type SendMessageDraftCall = (
  method: 'sendMessageDraft',
  payload: Record<string, unknown>,
) => Promise<unknown>;

const callSendMessageDraft = bot.telegram.callApi.bind(
  bot.telegram,
) as unknown as SendMessageDraftCall;

/**
 * @description Send each already-split chunk as a permanent message, tracking the
 * last one as the thread's `lastMessageId`/`lastMessageText` so a later
 * continuation can append onto it. The shared send loop behind the DM finalize /
 * overflow-spill / one-shot paths.
 */
async function sendAgentChunks(key: SessionKey, chunks: string[]): Promise<void> {
  const msgState = getThreadMessageState(key);
  // S2b: collapse a ≥3-message backlog into the fewest \n\n-joined messages so a
  // burst (DM finalize / overflow-spill) lands in one send, not a trickle.
  const toSend = glueBacklogFrames(chunks, MAX_MESSAGE_LEN, (chunk) => renderAgentHtml(chunk).length);
  for (const chunk of toSend) {
    const id = await replyChunkWithFallback(key, renderAgentHtml(chunk), chunk);
    if (id) {
      msgState.lastMessageId = id;
      msgState.lastMessageText = chunk;
      msgState.needsNewMessage = false;
    }
  }
}

async function deleteStatusMessage(key: SessionKey): Promise<void> {
  const s = getThreadMessageState(key);
  // The next status frame will create a *new* message, so the dedup baseline
  // is stale — clear it, otherwise an identical-text frame after a delete
  // would be wrongly skipped and the fresh status message never appear.
  getStatusCoalesceState(key).lastSentText = null;
  // Bump UNCONDITIONALLY (even when no id is tracked): a `sendStatusFrame`
  // create may be mid-`await` with its id not yet stored. The bump signals that
  // in-flight create to DISCARD its message instead of storing it as an orphan
  // (`getStatusFrameStoreDecision`). Without this, a delete that races a still
  // null `statusMessageId` removes nothing and the create resurrects a frame
  // that idle/output already meant to clear → the leftover spinner of bug #11.
  s.statusFrameGeneration += 1;
  if (s.statusMessageId === null) return;
  const id = s.statusMessageId;
  setStatusFrameId(key, null);
  await deleteThreadMessage(key, id);
}

/**
 * Internal bound (ms) on the graceful-shutdown transient-frame sweep. Well under
 * the 10s shutdown watchdog so a slow Telegram API can't eat into the budget
 * `state.flush()` needs to land the last state to disk.
 */
const shutdownFrameSweepMs = 1500;

/**
 * @description Best-effort delete of every TRANSIENT status frame still on
 * screen at graceful shutdown — the "✽ working…" liveness frame, the live
 * thinking indicator, and the dedicated sub-agent status. Their ids live ONLY in
 * volatile in-memory {@link ThreadMessageState}, so a restart that doesn't clean
 * them up orphans the messages forever in the topic (the reported incident:
 * ~25 hot reloads left "✽ работаю…" frames stuck; and a 🔧 tool status stranded
 * as a topic's last message when a hot reload landed mid-tool). Iterates every
 * tracked thread, and for each {@link clearTransientFramesForShutdown} BUMPS both
 * frame generations (so a `sendStatusFrame`/thinking create still mid-`await`
 * discards its just-sent message instead of orphaning it — see that helper) and
 * nulls the in-memory ids so a racing per-thread tick can't re-edit a just-deleted
 * message; the returned on-screen ids are deleted in parallel.
 *
 * The generation bump MUST run for every thread, including one whose ids are
 * already null (its racing create hasn't stored an id yet) — that is exactly the
 * case the old `if (ids.length === 0) continue` skipped, letting the create store
 * an orphan after the sweep. Threads that had nothing on screen still skip the
 * (fire-and-forget) persist + delete work.
 *
 * Wired into {@link gracefulShutdown} as `clearTransientFrames`: runs AFTER
 * `cleanupTimers()` (no interval re-creates a frame mid-sweep) and BEFORE
 * `bot.stop()` (the Telegram client must still send the deletes). Self-bounded by
 * {@link shutdownFrameSweepMs} — a slow API must not starve `state.flush()`.
 */
async function sweepTransientFramesOnShutdown(): Promise<void> {
  const deletes: Promise<unknown>[] = [];
  for (const [keyStr, msgState] of threadMessageStates) {
    let key: SessionKey;
    try {
      key = keyFromString(keyStr);
    } catch {
      continue;
    }
    // Bump generations + null ids for EVERY tracked thread (fixes the racing
    // create that resolves after the sweep). Only threads that HAD a frame on
    // screen need the persist + delete.
    const ids = clearTransientFramesForShutdown(msgState);
    if (ids.length === 0) continue;
    for (const id of ids) {
      deletes.push(bot.telegram.deleteMessage(getTelegramChatId(key), id).catch(() => {}));
    }
    // Clear the S2 persisted set too, so the next boot's reconciliation finds
    // nothing to redo after a graceful exit.
    state.setTransientFrames(key, []).catch(() => {});
  }
  if (deletes.length === 0) return;
  await Promise.race([
    Promise.allSettled(deletes),
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, shutdownFrameSweepMs);
      timer.unref?.();
    }),
  ]);
}

/**
 * Hard bound (ms) on the whole shutdown output flush (finalize + FIFO drain):
 * the drain budget plus headroom for the finalize sends themselves. Under the
 * 10s shutdown watchdog so the later steps (frame sweep, update drain,
 * `state.flush()`) keep their budgets.
 */
const shutdownOutputFlushMaxMs = shutdownDrainMaxMs + 1000;

/**
 * @description Flush every thread's not-yet-delivered agent output at graceful
 * shutdown, so a hot-reload restart can't swallow it (live 2026-07-05):
 * already-emitted answer chunks died in the send pipeline with the
 * process and were never re-sent). Two buffers drain, in order:
 *
 *  [A] per-thread COALESCE state — the group/baseline `q.pendingOutput`
 *      buffers (enumerated here from {@link outputQueues}) and the DM
 *      transport's active drafts (enumerated via `getInFlightThreadKeys`) —
 *      each finalized to a permanent message via the transport's
 *      `finalizeInFlight`;
 *  [B] the per-thread send FIFOs already parked on the global pacer — drained
 *      by `drainPendingSends` after `enterShutdownDrain()` flips the pacer to
 *      immediate release (at 1 send/2s a 5-message backlog alone outlives any
 *      sane shutdown window; every drained send keeps `withRateLimitRetry`).
 *
 * `enterShutdownDrain()` is flipped BEFORE the finalizes: their awaits resolve
 * only when their sends land, and with the pacer still spacing each queued
 * send would wait out its 2s slot and bust the bound. Still strictly inside
 * the shutdown sequence — live operation never runs unpaced.
 *
 * Wired into {@link gracefulShutdown} as `finalizePendingOutput`: runs AFTER
 * `cleanupTimers()` and BEFORE `clearTransientFrames` / `bot.stop()` (content
 * lands first, then transient frames are deleted, all while the Telegram
 * client is alive). Self-bounded by {@link shutdownOutputFlushMaxMs} — the
 * outer watchdog stays the backstop.
 */
async function finalizePendingOutputOnShutdown(): Promise<void> {
  const drainDeadlineMs = Date.now() + shutdownDrainMaxMs;
  let flushedCount = 0;
  const flushWork = (async (): Promise<ShutdownDrainVerdict> => {
    enterShutdownDrain();
    // [A] union of threads with pending coalesced output: the bot-owned output
    // queues + the connector's own unfinalized content (deduped by serialised key).
    const pendingKeys = new Map<string, SessionKey>();
    for (const [keyStr, q] of outputQueues) {
      if (q.pendingOutput === null) continue;
      try {
        pendingKeys.set(keyStr, keyFromString(keyStr));
      } catch {
        /* malformed key — nothing to flush for it */
      }
    }
    for (const key of telegramOutbound.listUnfinalizedKeys()) {
      pendingKeys.set(keyToString(key), key);
    }
    flushedCount = pendingKeys.size;
    await Promise.allSettled(
      [...pendingKeys.values()].map((key) => telegramOutbound.finalize(key)),
    );
    // A DM-surface thread on a non-draft adapter (e.g. terminal) coalesces via
    // the group `queueOutput` path, but its transport finalize handled only the
    // draft — drain any such leftover buffer directly. Group keys were already
    // drained above (their finalize nulls `pendingOutput` synchronously), so
    // this is a no-op for them.
    const leftoverDrains: Promise<void>[] = [];
    for (const [keyStr, q] of outputQueues) {
      if (q.pendingOutput === null) continue;
      try {
        leftoverDrains.push(finalizeGroupOutput(keyFromString(keyStr)));
      } catch {
        /* malformed key */
      }
    }
    await Promise.allSettled(leftoverDrains);
    // [B] wait for the released FIFOs to empty, bounded by what is left of the
    // shared drain budget.
    return drainPendingSends(Math.max(drainDeadlineMs - Date.now(), 0));
  })();
  const verdict = await Promise.race([
    flushWork,
    new Promise<ShutdownDrainVerdict>((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), shutdownOutputFlushMaxMs);
      timer.unref?.();
    }),
  ]);
  console.log(`[shutdown] flushed ${flushedCount} threads, ${verdict}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Voice download + transcribe
// ═══════════════════════════════════════════════════════════════════════════════

// Voice download timeout is shared with the transcription request below so a
// single constant governs the whole voice path. `downloadFile` itself (retries,
// redirects, warm-agent reuse) lives in `./utils/download` so it stays
// side-effect-free and unit-testable.
const DOWNLOAD_TIMEOUT_MS = 20_000;

/**
 * Bot API download cap in MB, surfaced in the `file.too_big` reply. Derived
 * from `telegramFileDownloadCapBytes` so the user-facing number and the
 * pre-download size check can never drift apart.
 */
const FILE_DOWNLOAD_CAP_MB = Math.floor(telegramFileDownloadCapBytes / (1024 * 1024));

/**
 * Quiet period after the LAST album item before the batched album prompt is
 * forwarded. Telegram delivers an album's messages in a sub-second burst, so a
 * couple of seconds comfortably catches every item (album max is 10) without a
 * user-perceptible lag before the agent starts.
 */
const ALBUM_DEBOUNCE_MS = 2_000;

/**
 * @description Transcribe a downloaded voice note for thread `key`. Transient
 * provider failures (timeout / network error / 408 / 409 / 5xx / 429) are
 * retried inside `transcribeAudio`; before each retry the topic gets a short
 * notice naming the error and the pause, so the user knows the voice note
 * isn't lost. The notice is UNPACED like the transcript echo it precedes:
 * queued behind agent output it could land after the retry already succeeded.
 */
async function transcribeVoiceFile(key: SessionKey, filePath: string): Promise<TranscribeResult> {
  const endpoint = getTranscriptionEndpoint({ groqApiKey: ENV.groqApiKey, openaiApiKey: ENV.openaiApiKey });
  if (!endpoint) return { ok: false, error: 'no api key configured' };
  const result = await transcribeAudio(filePath, endpoint, {
    timeoutMs: DOWNLOAD_TIMEOUT_MS,
    onRetry: ({ attemptNumber, error, delayMs }) => {
      console.warn(`[transcribe] attempt ${attemptNumber} failed (${error}); retrying in ${delayMs}ms`);
      const seconds = Math.round(delayMs / 1000);
      void replyToThread(key, t('voice.retrying', { error, seconds }), {}, { unpaced: true }).catch(() => {});
    },
  });
  if (!result.ok) console.warn(`[transcribe] failed: ${result.error}`);
  return result;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Adapter lifecycle helpers
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * @description Resolve the working directory for an adapter session in
 * this thread, or `null` when the thread has no binding.
 *
 * The bind IS the agent's working folder — an agent must never run outside it,
 * so there is deliberately NO fallback to `WORK_ROOT` itself. The old Этап-3
 * "smoke-test against WORK_ROOT before any /bind" behavior is retired: every
 * agent-facing entry point (start / list / resume) refuses with
 * `thread.bind_required` when this returns `null`.
 */
function formatBindErrorMessage(error: BindError, rawSubdir: string): string {
  switch (error.code) {
    case 'BIND_INVALID_CHARS': return t('bind.invalid_chars');
    case 'BIND_NOT_FOUND':     return t('bind.not_found', { subdir: rawSubdir, workRoot: ENV.workRoot });
    case 'BIND_OUTSIDE_ROOT':  return t('bind.outside_root');
    case 'BIND_NOT_DIRECTORY': return t('bind.not_directory', { subdir: rawSubdir });
    default:                   return `❌ ${error.message}`;
  }
}

function getWorkDirStartDecision(key: SessionKey): { ok: true; workDir: string } | { ok: false; message: string } {
  const binding = state.getBinding(key);
  const decision = resolveBoundWorkDir(ENV.workRoot, binding);
  if (decision.kind === 'proceed') return { ok: true, workDir: decision.workDir };
  return withThreadLocale(key, () => {
    if (decision.kind === 'refuse') return { ok: false as const, message: t('thread.bind_required') };
    return { ok: false as const, message: formatBindErrorMessage(decision.error, binding?.subdir ?? '') };
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Subdir validation + discovery (plan §13.7 / T1)
// ═══════════════════════════════════════════════════════════════════════════════

// `validateSubdir` + `BindError` live in `src/validation.ts` so the
// security-critical bits can be unit-tested without booting Telegraf
// (plan §11 Этап 7, R3). The import at the top of this file pulls them in.

/** Inline-keyboard page size for `/bind`. 20 fits one phone screen comfortably. */
const BIND_PAGE_SIZE = 20;

/**
 * @description List immediate subdirectories of `WORK_ROOT` for the `/bind`
 * inline-button picker and the `forum_topic_created` welcome message.
 *
 * Filters out hidden (`.*`) and synthetic (`__*`, `node_modules`, etc.) names
 * — those are almost never project roots and would push real options off
 * Telegram's inline-keyboard limit.
 *
 * Filters out names whose `bind_<name>` `callback_data` would exceed Telegram's
 * 64-byte UTF-8 hard limit (Cyrillic / CJK / emoji names trip this fast at
 * 2-4 bytes per char). Those folders are still bindable via the `/bind <name>`
 * slash command — only the inline-button shortcut is hidden.
 *
 * `fs.readdirSync` is intentional: this is a low-cadence path (per /bind, per
 * topic_created event), and the synchronous block is dwarfed by the Telegram
 * round-trip that follows it.
 */
/**
 * Audit S13 / #28: `fs.readdirSync` on every no-binding text reply / every
 * `/bind` keyboard rebuild is a synchronous blocker on the event loop for
 * any WORK_ROOT with thousands of entries. Cache the result for 30 s —
 * the only realistic way the list changes is the operator creating a
 * folder, which `/bind` after that interval picks up naturally.
 */
const SUBDIR_CACHE_TTL_MS = 30_000;
const subdirCache = new Map<string, { value: string[]; ts: number }>();

function listAvailableSubdirs(workRoot: string, limit = 200): string[] {
  const cacheKey = `${workRoot}|${limit}`;
  const cached = subdirCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < SUBDIR_CACHE_TTL_MS) {
    return cached.value;
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(workRoot, { withFileTypes: true });
  } catch {
    subdirCache.set(cacheKey, { value: [], ts: Date.now() });
    return [];
  }
  const skip = new Set(['node_modules', '.git', '.cache', '.idea', '.vscode']);
  const callbackPrefix = 'bind_';
  const result = entries
    .filter(e => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('__') && !skip.has(e.name))
    .map(e => e.name)
    .filter(name => Buffer.byteLength(callbackPrefix + name, 'utf8') <= 64)
    .sort((a, b) => a.localeCompare(b))
    .slice(0, limit);
  subdirCache.set(cacheKey, { value: result, ts: Date.now() });
  return result;
}

/**
 * @description Build a `subdir`-suggestion keyboard for `/bind` and friends.
 *
 * Lists are paginated at {@link BIND_PAGE_SIZE} entries: a `WORK_ROOT` with
 * many subfolders (mono-repo workspace, packages dir, etc.) would otherwise
 * push the inline keyboard past Telegram's per-message height limit and
 * lose entries below the fold.
 *
 * The nav row appears only when there's more than one page. The middle
 * `pageLabel` button is a no-op (`bind_page_noop` callback) — it exists
 * solely so the user sees "2/5" without us having to fake a divider with
 * a separate message.
 *
 * Subdirs whose callback_data exceeds 64 bytes are filtered out upstream
 * in `listAvailableSubdirs`. `page` is clamped to a valid index so a stale
 * callback (folders disappeared since the keyboard was sent) just lands
 * on the last available page.
 *
 * When `isBound` the FIRST row is a full-width «leave current dir» button
 * (`bindLeaveCurrentCallback`, the folded-in `/unbind`); the «create new folder»
 * button (`bindCreateFolderCallback`) follows. Both callbacks deliberately do
 * NOT start with `bind_`, so they can't be mistaken for a folder pick by the
 * `bind_<subdir>` action regex. They ride on every page so they're reachable
 * regardless of pagination.
 */
const bindCreateFolderCallback = 'bindCreateFolder';

/**
 * «Leave current dir» button — the folded-in `/unbind`. Like
 * `bindCreateFolderCallback`, the callback id deliberately does NOT start with
 * `bind_`, so the `bind_<subdir>` action regex can't mistake it for a folder
 * pick. Only rendered in a bound topic.
 */
const bindLeaveCurrentCallback = 'bindLeaveCurrent';

export function buildBindKeyboard(
  subdirs: readonly string[],
  page: number = 0,
  pageSize: number = BIND_PAGE_SIZE,
  isBound: boolean = false,
) {
  const { slice, currentPage, totalPages } = paginateBindList(subdirs, page, pageSize);

  const rows = [
    [Markup.button.callback(t('bind.create_button'), bindCreateFolderCallback)],
  ];
  // A bound topic gets a full-width «leave current dir» row PREPENDED above the
  // «create new folder» row — this is the folded-in `/unbind`. Its callback
  // deliberately avoids the `bind_` prefix so the `bind_<subdir>` action regex
  // can't catch it. The row is omitted when unbound (nothing to leave).
  if (isBound) {
    rows.unshift([Markup.button.callback(t('bind.leave_button'), bindLeaveCurrentCallback)]);
  }
  for (let i = 0; i < slice.length; i += 2) {
    const row = [Markup.button.callback(`📁 ${slice[i]}`, `bind_${slice[i]}`)];
    if (slice[i + 1]) {
      row.push(Markup.button.callback(`📁 ${slice[i + 1]}`, `bind_${slice[i + 1]}`));
    }
    rows.push(row);
  }

  if (totalPages > 1) {
    const nav = [];
    if (currentPage > 0) {
      nav.push(Markup.button.callback('⬅️ Prev', `bind_page_${currentPage - 1}`));
    }
    nav.push(Markup.button.callback(`${currentPage + 1}/${totalPages}`, 'bind_page_noop'));
    if (currentPage < totalPages - 1) {
      nav.push(Markup.button.callback('Next ➡️', `bind_page_${currentPage + 1}`));
    }
    rows.push(nav);
  }

  return Markup.inlineKeyboard(rows);
}

/**
 * @description Bot-level wrapper around the pure sweep helper in
 * `createAdapter.ts`. Binds the production adapter resolver so callers
 * don't have to thread it through; tests in `stopAllAdapters.test.ts`
 * cover the sweep logic directly with fakes.
 */
function stopAllAdaptersFor(key: SessionKey, adapterNames?: string[]) {
  return sweepAdapters(key, getAdapter, adapterNames);
}

/**
 * @description Explicit-stop teardown used by `/new`/`/clear_session`:
 * sweep every adapter active for the thread, then RELEASE the persisted session
 * ids (even when nothing was running) so a later bot restart won't auto-reattach
 * and any half-dead state from a crash/SSE-giveup is cleared. The session stays
 * on disk → still reachable via `/sessions`. Returns the sweep result so callers
 * can decide what to reply.
 */
async function releaseThreadSession(key: SessionKey): Promise<ReturnType<typeof stopAllAdaptersFor>> {
  // User took over (/new) → cancel any pending API-error retry silently
  // before the session is released, so the kick never lands in a torn-down
  // session.
  cancelApiRetry(key);
  cancelClaudeAuthLogin(key); // session released → kill any in-flight /login pty
  cancelOpenCodeOAuthLogin(key); // session released → kill any in-flight /connect oauth pty
  clearAuthNotice(key); // session released → retire any pinned logged-out notice
  // Session is going away → no output is coming, so stop the "working" loader
  // (covers the release half of /new before its fresh start re-arms it).
  telegramOutbound.setActivity(key, 'idle');
  // Close any still-pending OpenCode question on the server BEFORE stopping the
  // session — a stopped session can't accept the reject, and an unrejected
  // question re-surfaces on the next reattach (`restoreOpenQuestion`). No-op for
  // Claude / no pending question.
  getThreadAdapter(key).rejectQuestion?.(key);
  const result = stopAllAdaptersFor(key);
  await state.clearAgentSessionIds(key);
  return result;
}

/**
 * @description Switch a thread's adapter and clear the previous adapter's
 * persisted session id, so a later restart can't re-attach to the wrong
 * one. Audit S12 / #21: `setAgent({ name })` patched `agents[key].name`
 * but left `claudeSessionId` / `opencodeSessionId` behind. After a
 * restart the reattach loop saw both fields, treated the binding as a
 * claude session (because `claudeSessionId` was non-null), and re-spawned
 * a tmux pane while the UI insisted the thread used OpenCode.
 *
 * Also stops any live session belonging to the *previous* adapter so two
 * adapters can't end up polling/streaming the same thread at once — that
 * desync caused mixed output, silent `/stop`, and the "I keep getting
 * 'Login successful' on every message" bug reported 2026-05-15.
 */
async function switchThreadAdapter(key: SessionKey, newName: string): Promise<void> {
  const prevName = getThreadAdapterNameRaw(key);
  // Another agent or a shell takes the topic over: the open request belonged to
  // the old conversation, so it closes silently instead of a later wake-up
  // reminding (or, in a terminal, TYPING into) a session that never saw it.
  if (prevName && !checkIsSameConversationSwitch(prevName, newName)) cancelConversationRequest(key);
  if (prevName && prevName !== newName) {
    try {
      const prev = getAdapter(prevName);
      if (prev.checkIsActive(key)) {
        // `stopSession` is `void` in the AgentAdapter contract — OpenCode
        // queues teardown behind its lifecycle lock and returns
        // immediately. A handful of stragger `output`/`status` events
        // can still fire between this call and the actual teardown.
        // They route through the *new* adapter's `outputsDeltas` after
        // the map switch below, which is bounded and never lands them
        // in the wrong topic. A fully-awaited stop would need an async
        // hook on the adapter interface — follow-up if anyone hits a
        // real artefact from this window.
        prev.stopSession(key);
      }
    } catch (e) {
      // Unknown previous adapter (renamed/removed): nothing to stop.
      console.warn(`[switchThreadAdapter] could not stop previous adapter ${prevName}:`, e instanceof Error ? e.message : e);
    }
  }
  setThreadAdapter(key, newName);
  const agent = state.getAgent(key);
  if (!agent) return;
  // Wipe ids that don't belong to the new adapter. We persist via
  // setAgent (which merges), so build a fresh record with only the
  // surviving fields.
  const next: { name: string; model?: string; claudeSessionId?: string; opencodeSessionId?: string; startedAt?: string } = { name: newName };
  if (agent.model !== undefined) next.model = agent.model;
  // Preserve the session-start time across a same-conversation backend switch
  // (`/claude_mode` tmux↔json-stream). A truly fresh start (the
  // `ensureAgentSession` → switch → `startAgentSession` path) overwrites it
  // with "now" afterwards, so carrying it here can't wrongly age a new session.
  if (agent.startedAt !== undefined) next.startedAt = agent.startedAt;
  // Both Claude backends share the on-disk transcript, so keep the session id
  // when switching between tmux-scrape and json-stream — the new backend resumes
  // the SAME conversation (`/claude_mode` live switch).
  if (checkIsClaudeBackend(newName) && agent.claudeSessionId) next.claudeSessionId = agent.claudeSessionId;
  if (newName === 'opencode' && agent.opencodeSessionId) next.opencodeSessionId = agent.opencodeSessionId;
  // Overwrite by removing the row first; setAgent then writes only the
  // fields we kept.
  await state.removeAgent(key);
  await state.setAgent(key, next);
}

/**
 * @description The post-start "ready" notice for an agent that just came up — or
 * the empty string when none should be posted. Pure decision extracted from
 * {@link startAgentSession} so the capability gate is unit-testable without the
 * whole start machinery (tmux/HTTP/state):
 *  - a self-greeting agent (Claude — `selfGreetsOnStart`) returns `''`: it prints
 *    its OWN banner to the topic, so the bot's notice would be a redundant,
 *    slightly-early "ready" line above it (the typing loader covers the gap);
 *  - terminal returns the shell-specific `terminal.ready` copy (a shell isn't an
 *    agent that takes a prompt);
 *  - any other backend (OpenCode) returns the generic `agent.ready` notice —
 *    without it the user would have no cue the session is up, since nothing greets.
 *
 * The `agent.ready` notice also names WHAT the session will run with — the model
 * and the reasoning effort — plus the `/effort` pointer, because "ready" alone
 * told the user nothing about the two settings that decide cost and quality. The
 * `{infoBlock}` those lines fill sits directly above the closing "Send a message:"
 * line in every locale; with both values absent it collapses to the empty string,
 * so the notice renders exactly as it did before. `terminal.ready` is NOT given
 * the block: a shell has neither a model nor an effort level.
 *
 * Both values arrive ALREADY RESOLVED so this stays pure (no adapter/state reads
 * here — see the caller in {@link startAgentSession}).
 *
 * @param model Resolved model label, or `null` when no source knows one — then
 * the row still renders, carrying the `model.current_default` text that `/status`
 * and `/model` already use for "whatever the backend defaults to".
 * @param effort Effort level in force, or `null` for a backend with no effort
 * concept — then no effort line (and no `/effort` pointer) is rendered.
 */
function getStartReadyInfoBlock(model: string | null, effort: string | null): string {
  // Nothing known about either setting — collapse to empty so the notice reads
  // exactly as it did before the block existed (no stray blank line).
  if (model === null && effort === null) return '';
  // Once anything is known the model row always renders: showing a bare effort
  // level without saying which model runs it would be more confusing than the
  // honest "default" marker `/status` and `/model` already use.
  const lines = [t('agent.ready_model', { model: model ?? t('model.current_default') })];
  if (effort !== null) lines.push(t('effort.current_hint', { effort }));
  // Trailing newline keeps the template's closing "Send a message:" on its own line.
  return `${lines.join('\n')}\n`;
}

export function getStartReadyMessage(
  adapter: AgentAdapter,
  subdir: string,
  args: string | undefined,
  model: string | null,
  effort: string | null,
): string {
  if (adapter.selfGreetsOnStart) return '';
  const isTerminal = adapter.name === 'terminal';
  const vars: Record<string, string> = {
    label: adapter.label,
    subdir,
    argsSuffix: args ? ` (${args})` : '',
  };
  if (isTerminal) return t('terminal.ready', vars);
  return t('agent.ready', { ...vars, infoBlock: getStartReadyInfoBlock(model, effort) });
}

async function startAgentSession(key: SessionKey, args?: string): Promise<string> {
  const kStr = keyToString(key);
  // The bound folder IS the agent's cwd — refuse to start without one. The
  // command/natural-language callers gate on the binding too, but a binding
  // can vanish (/unbind) between their check and here, so re-check before any
  // side effect (startup window / markers) opens.
  const workDirDecision = getWorkDirStartDecision(key);
  if (!workDirDecision.ok) return workDirDecision.message;
  const workDir = workDirDecision.workDir;
  // Open the startup window synchronously (before the first await) so text
  // typed right after `/claude` / `/opencode` is buffered, not dropped.
  startupPromptBuffer.markStarting(kStr);
  // A fresh session is a new conversation — clear any spent compact-on-idle latch
  // (D2) so this session can idle-compact even if the PREVIOUS session in this
  // thread already fired one (its latch persisted). The user starting the agent
  // is the genuine user action that re-arms it.
  if (state.checkIsCompactIdleLatched(key)) {
    void state.setCompactIdleLatched(key, false);
  }
  markNeedsNewMessage(key);
  // Fresh session — the agent's context is empty, so the next prompt must
  // re-carry the thread-context preamble. Forget the last-injected marker.
  clearThreadContextMarker(key);
  const adapter = getThreadAdapter(key);

  // Boot loader. A self-greeting agent (Claude) prints its banner shortly — keep
  // the SUSTAINED loader up from now until that first output covers the gap. A
  // non-self-greeting agent (OpenCode/terminal) emits nothing until the user
  // prompts, so a one-shot typing ping is enough — its `ready` notice (below)
  // tells the user the session is up; a sustained loader would dangle forever.
  // A surface with no such cue (a tracker issue, R6) ignores `starting`.
  telegramOutbound.setActivity(key, adapter.selfGreetsOnStart ? 'working' : 'starting');

  try {
    await adapter.startSession(key, workDir, args);

    // Persist backend session ids so a bot restart can re-attach without
    // losing the live conversation (Claude tmux UUID; OpenCode server UUID).
    await persistAdapterSessionIds(key, adapter, state);
    // Stamp the session-start time (surfaced by /status). A fresh start is
    // "now"; the agent row already exists (just persisted above), so this
    // merge-only write lands. `/new` cleared the old value via
    // releaseThreadSession first, so this correctly resets it.
    await state.setAgentStartedAt(key, formatIsoLocalOffset(Date.now()));

    // Session is active now — replay anything the user typed while it booted,
    // in arrival order, through the normal forward path. Fire-and-forget so the
    // `ready` message isn't delayed; `replayPrompts` closes the window synchronously
    // (before the first await inside) so it is already closed by the time we
    // return — no message can slip into a second buffer.
    void replayBufferedPrompts(key);

    const subdir = state.getBinding(key)?.subdir ?? path.basename(ENV.workRoot);
    // Resolve what the fresh session will actually run with, for the ready
    // notice. Effort follows the `/status` rule: a backend without `getEffort`
    // has no effort concept (null → no effort line), otherwise an unset pref
    // means the default the agent really applies. The model resolution
    // DELIBERATELY skips the runtime self-report `/status` consults — that is an
    // async transcript/HTTP read and must not be added to the start path. The
    // agent row was just written by `persistAdapterSessionIds`, so the persisted
    // fallback is populated by now.
    const effort = adapter.getEffort ? (adapter.getEffort(key) ?? defaultEffortLevel) : null;
    const model = getThreadStatusModel({
      adapterModel: adapter.getCurrentModel?.(key) ?? null,
      runtimeModel: null,
      persistedModel: state.getAgent(key)?.model ?? null,
    });
    return getStartReadyMessage(adapter, subdir, args, model, effort);
  } catch (e) {
    // Start failed — the buffered prompts have nowhere to go, so drop them
    // rather than replaying into a dead session. Stop the boot loader too: a
    // self-greeting start armed the sustained loader, and no output is coming.
    startupPromptBuffer.discardPrompts(kStr);
    telegramOutbound.setActivity(key, 'idle');
    return t('agent.start_failed', {
      label: adapter.label,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * @name EnsureAgentSessionResult
 * @description Outcome of {@link ensureAgentSession}. `ok` means a session is
 * ready to receive prompts NOW — either it was already active, it is in its
 * async startup window (prompts get buffered + replayed on ready), or it was
 * just started. `message` is the localized text the caller MAY surface (the
 * `agent.ready` notice on a fresh start, empty when nothing user-facing
 * happened). On failure, `reason` distinguishes a missing binding (`unbound`),
 * a bound topic that has never picked an agent and none was supplied
 * (`no-adapter` — refuse rather than silently launch a default), and a start
 * that threw (`start-failed`); `message` carries the matching localized text.
 */
export type EnsureAgentSessionResult =
  | { ok: true; message: string }
  | { ok: false; reason: 'unbound' | 'no-adapter' | 'start-failed'; message: string };

/**
 * @name EnsureAgentSessionOptions
 * @description Tuning for {@link ensureAgentSession}.
 *  - `preferredAdapterName` — an EXPLICIT user choice that outranks every
 *    resolved name (the natural-language-start path passes the matched
 *    `/claude` vs `/opencode` adapter here).
 *  - `fallbackAdapterName` — the LAST resort when nothing else resolves (the
 *    scheduler passes a job's `lastAdapterName` snapshot for a start after a
 *    rebind, where the thread has no live or persisted adapter). When it too is
 *    absent and nothing resolved, `ensureAgentSession` fails with `no-adapter`
 *    rather than silently launching a default backend.
 *  - `args` — forwarded to `startAgentSession` (e.g. the natural-language
 *    start phrase's trailing args).
 */
export interface EnsureAgentSessionOptions {
  preferredAdapterName?: string;
  fallbackAdapterName?: string;
  args?: string;
}

/**
 * @description Ensure the thread `key` has an agent session ready to take a
 * prompt, starting one if needed — the single choke point shared by the
 * natural-language-start path, the `/schedule` command (S7), and the scheduler
 * delivery (S4). It does NOT itself send any user-facing reply: it returns the
 * outcome (and the message to show) so each caller decides its own messaging
 * (e.g. the natural-language path adds a General-topic guard + a folder picker
 * on `unbound`, the scheduler annotates the run ledger instead).
 *
 * Cases:
 *  - already active                → `{ ok: true }` (no message; nothing started).
 *  - mid-startup (window open)     → `{ ok: true }` (prompts will buffer + replay).
 *  - no session, no binding        → `{ ok: false, reason: 'unbound' }`.
 *  - no session, has binding, but no adapter resolves (no explicit pick, no
 *    in-memory/persisted choice, no `fallbackAdapterName`) →
 *    `{ ok: false, reason: 'no-adapter' }` — refuse rather than silently launch
 *    a default backend (interactive starts always pass `preferredAdapterName`,
 *    so this only bites a `/schedule`/scheduler fire on a never-started topic).
 *  - no session, has binding       → resolve the adapter name (explicit
 *    `preferredAdapterName` → in-memory thread pick → persisted
 *    `agents[key].name` → `fallbackAdapterName`), `switchThreadAdapter`
 *    + `startAgentSession`, then report `ok` from whether the session came up.
 */
async function ensureAgentSession(
  key: SessionKey,
  options: EnsureAgentSessionOptions = {},
): Promise<EnsureAgentSessionResult> {
  const adapter = getThreadAdapter(key);
  if (adapter.checkIsActive(key)) return { ok: true, message: '' };
  if (startupPromptBuffer.checkIsStarting(keyToString(key))) return { ok: true, message: '' };

  if (!state.getBinding(key)) {
    return { ok: false, reason: 'unbound', message: t('thread.bind_required') };
  }

  // Resolve which adapter to start. `getThreadAdapterNameRaw` returns the
  // in-memory pick WITHOUT any default fallback, so "no pick yet" stays
  // distinguishable and the chain never silently defaults to a backend. When
  // nothing resolves (bound topic that never picked an agent, no caller
  // fallback) we REFUSE — the user must start/pick an agent first.
  const adapterName =
    options.preferredAdapterName ??
    getThreadAdapterNameRaw(key) ??
    state.getAgent(key)?.name ??
    options.fallbackAdapterName;

  if (!adapterName) {
    return { ok: false, reason: 'no-adapter', message: t('agent.no_session') };
  }

  await switchThreadAdapter(key, adapterName);
  const message = await startAgentSession(key, options.args);
  if (getThreadAdapter(key).checkIsActive(key)) {
    return { ok: true, message };
  }
  return { ok: false, reason: 'start-failed', message };
}

/**
 * @description Replay prompts buffered during the startup window to the now-active
 * agent, preserving arrival order. Each prompt goes through the same forward
 * routine as a live message (new-message marker + loader + `sendInput`).
 */
async function replayBufferedPrompts(key: SessionKey): Promise<void> {
  const adapter = getThreadAdapter(key);
  const isSessionActive = adapter.checkIsActive(key);
  // The buffer closes the window synchronously and settles every prompt it held (a sender waiting on one,
  // like the API-error retry's nudge, hears whether it reached the session).
  await startupPromptBuffer.replayPrompts(keyToString(key), {
    isSessionActive,
    forward: (prompt) => forwardPromptToAgent(key, adapter, prompt),
  });
  if (!isSessionActive) return;
  // R23: prompts held during a usage-limit wait that ended with the previous
  // session go to this one — on their own when nothing above carried them.
  const heldText = limitHeldPrompts.releaseAll(key);
  if (heldText === null) return;
  try {
    await forwardPromptToAgent(key, adapter, heldText);
  } catch (err) {
    console.error('[replayBufferedPrompts] forwarding the held prompts failed:', err);
  }
}

/**
 * @description Forward one user prompt to a live agent: mark the thread for a
 * fresh output message, start the typing loader (the sole "agent is working"
 * cue), and hand the text to the adapter. Shared by the text handler, the voice
 * handler, and startup-prompt replay so the loader/marker behaviour stays
 * identical across all three. The loader is cleared by the agent's first output
 * (or status / question / teardown) — never by a timeout.
 *
 * If the adapter implements `interruptAndWaitIdle`, we interrupt the running
 * turn and wait until it is actually idle before handing over the text. Only
 * Claude implements it (Escape + a TUI poll) — its TUI ignores typed input for
 * a long stretch of a running turn, so interrupting is what makes it read the
 * new message promptly. OpenCode deliberately does NOT interrupt a HEALTHY busy
 * turn: `prompt_async` queues the prompt and the agent picks it up quickly, so
 * aborting would lose work. Its adapter handles the one exception internally:
 * `session.status=retry` will not read queued prompts until the provider retry
 * time, so a new prompt aborts that stale wait before using the current model.
 * An adapter without the method forwards directly.
 */
async function forwardPromptToAgent(
  key: SessionKey,
  adapter: AgentAdapter,
  text: string,
  sentAtMs?: number,
  options: { isRecoveryReplay?: boolean; isRequestReminder?: boolean; replyContext?: string } = {},
): Promise<void> {
  // A forwarded prompt is thread activity — reset the compact-on-idle watchdog (F2).
  noteThreadActivity(key);
  // Skip slash commands (not worth replaying), the recovery replay itself (keeps
  // the once-per-episode guard intact) and a request reminder (the request's own
  // prompt stays the one to replay).
  const isReplayable = checkIsReplayablePrompt({
    isSlashCommand: checkShouldSkipPreambleForText(text),
    isRecoveryReplay: options.isRecoveryReplay ?? false,
    isRequestReminder: options.isRequestReminder ?? false,
  });
  // R23: prompts held during a usage-limit wait ride the first such prompt
  // forwarded to a live session once no wait holds them — after it, in arrival
  // order (the resume's, the operator's message that ended the wait, a later
  // post). Only a replayable one carries them, so a wedge recovery replays them too.
  const textWithHeld = isReplayable && adapter.checkIsActive(key) ? limitHeldPrompts.releaseWithForward(key, text) : text;
  // Fold the reply-quote block (from a Telegram REPLY) ahead of the user's text
  // so the agent sees WHAT is being referenced — only for a normal prompt, since
  // a slash command forwarded to the agent is a control token a prefixed block
  // would corrupt. The folded `body` is what gets cached, preamble-wrapped and
  // timestamped below.
  const body =
    options.replyContext && !checkShouldSkipPreambleForText(text)
      ? `${options.replyContext}\n\n${textWithHeld}`
      : textWithHeld;
  // Cache the (reply-folded) prompt so a wedged OpenCode session can be recovered
  // by restarting fresh and replaying it — replaying WITH the quote is correct.
  // A genuine new prompt also opens a fresh recovery episode (clears the guard).
  if (isReplayable) {
    lastForwardedPrompt.set(keyToString(key), body);
    wedgeRecoveryTier.delete(keyToString(key));
  }
  // Glue the thread-context preamble (topic / group / thread / folder) ahead
  // of the prompt so the agent knows WHERE it works. Slash commands forwarded
  // to the agent (`/clear`, `/compact`, …) are skipped — a preamble would
  // corrupt them into plain text. The preamble rides only when it differs
  // from the last one we injected this session (fresh session, rename, or
  // post-`/clear` marker reset). See `threadContextPreamble.ts`.
  //
  // `/timestamps` injection (S2): when the thread toggle is ON, the send-time
  // rides EVERY prompt as the very top line (local-offset ISO + blank line,
  // above the on-change preamble) — agent-facing only, never posted to the
  // topic. `sentAtMs` is the originating Telegram message's real send time
  // (plumbed from the text/voice handlers); prompts with no live message
  // (scheduled runs, buffered replay, api-retry nudge, file intake) fall back
  // to now. Slash commands skip it for the same reason they skip the preamble.
  let promptText = getPromptWithThreadContext(key, body);
  if (state.checkIsTimestampsEnabled(key) && !checkShouldSkipPreambleForText(text)) {
    promptText = `${formatIsoLocalOffset(sentAtMs ?? Date.now())}\n\n${promptText}`;
  }
  markNeedsNewMessage(key);
  // A new prompt is a new turn: lift the S2 idle-suppress latch and re-base the
  // working-status elapsed so the next busy period shows a fresh 0:00 counter
  // (the single prompt-forward choke point — covers user text, scheduled runs,
  // and the auto-retry "continue" nudge). Harmless for OpenCode threads (they
  // never arm the Claude liveness loop, so these fields stay unread).
  const msgState = getThreadMessageState(key);
  msgState.statusIdleSuppressed = false;
  msgState.workingSince = Date.now();
  // The native typing indicator is the loader: it shows immediately, can't be
  // delayed behind a chat-wide 429 cooldown (unlike a sent message), and (S3)
  // persists while output is streaming OR the agent is busy — self-stopping only
  // when the topic drains + idles.
  telegramOutbound.setActivity(key, 'working');
  if (adapter.interruptAndWaitIdle) {
    await adapter.interruptAndWaitIdle(key);
  }
  // OpenCode: if a sub-agent is synchronously blocking this session, detach it to
  // the background so this prompt is answered promptly instead of queuing behind
  // the whole (possibly long) sub-agent run — the sub-agent keeps working and its
  // result is injected back when it finishes. No-op for other adapters and when
  // no sub-agent is running. Best-effort; never blocks the forward on failure.
  if (adapter.detachRunningSubagents) {
    await adapter.detachRunningSubagents(key);
  }
  adapter.sendInput(key, promptText);
  // S2 busy-onset arm: start the Claude liveness loop the moment the prompt is
  // forwarded — driven by `checkIsBusy`, not by waiting for an opportunistic
  // scrape emit that may never come during a long quiet think. The arming grace
  // keeps the loop alive until Claude flips busy. Claude-only + idempotent
  // (no-op for OpenCode / an already-armed loop). This is the single prompt
  // choke point (user text, voice, scheduled run, api-retry continue, buffered
  // replay), so every path that makes Claude busy now raises the working frame.
  startClaudeLiveness(key, 'busyOnset');
}

/**
 * @description Return the prompt text with the thread-context preamble glued
 * in front when it should ride this turn, or the text unchanged otherwise.
 *
 * Slash commands forwarded to the agent skip the preamble (gluing it on would
 * turn `/clear` into plain text). For normal prompts we build the preamble
 * from the thread's binding (subdir + known topic name) and the cached group
 * title, then inject only when it differs from the last preamble sent for this
 * thread — a fresh session (marker cleared on start/stop/closed), a topic
 * rename, or a `/clear` (marker reset) all flip the decision to inject. On
 * inject we record the preamble as the new marker so identical follow-up
 * prompts don't repeat it.
 */
/**
 * @description Resolve the `group:` label for the thread-context preamble.
 * For a group key it's the cached supergroup title (empty until the first
 * authorised update after a restart). A DM key's chat is a private chat with no
 * title, so it falls back to the bot's own display name — a stable, non-fatal
 * label so the agent still gets a "where" even though there is no group.
 */
function getPreambleGroupTitle(key: SessionKey): string | undefined {
  const cached = groupTitleCache.get(getTelegramChatId(key));
  if (cached) return cached;
  if (checkIsDmKey(key)) return bot.botInfo?.username ?? bot.botInfo?.first_name;
  return undefined;
}

function getPromptWithThreadContext(key: SessionKey, text: string): string {
  if (checkShouldSkipPreambleForText(text)) return text;

  const binding = state.getBinding(key);
  const subdir = binding?.subdir ?? path.basename(ENV.workRoot);
  const preamble = buildThreadContextPreamble({
    topicName: binding?.topicName,
    groupTitle: getPreambleGroupTitle(key),
    key,
    subdir,
    timezone: getCurrentTimezone(),
  });

  const kStr = keyToString(key);
  if (!checkShouldInjectPreamble(preamble, threadContextMarkers.get(kStr))) {
    return text;
  }
  threadContextMarkers.set(kStr, preamble);
  return prependThreadContextPreamble(preamble, text);
}

/**
 * @description Bridge a telegraf text/voice message to the agent-facing
 * reply-quote block. When the operator uses Telegram's REPLY feature, this folds
 * the replied-to message's content into the forwarded prompt so the agent sees
 * WHAT is being referenced. Returns the block, or `undefined` when there is
 * nothing to inject (no reply, a forum/service or topic-root message, or a reply
 * carrying no textual content — the pure {@link extractReplyQuote} decides).
 *
 * Union fields are read with the `'x' in msg` idiom (no casts): `text`/`caption`
 * live only on their specific variants, `forum_topic_created` marks a service
 * message; `message_id` / `from` / `message_thread_id` are on every variant. The
 * bot's own id (`bot.botInfo.id`) drives the `from: assistant` attribution.
 */
function getReplyQuoteBlock(message: Message.TextMessage | Message.VoiceMessage): string | undefined {
  const replied = message.reply_to_message;
  if (!replied) return undefined;

  const botId = bot.botInfo?.id;
  const source: ReplyQuoteSource = {
    manualQuoteText: message.quote?.text,
    replyText: 'text' in replied ? replied.text : undefined,
    replyCaption: 'caption' in replied ? replied.caption : undefined,
    replyMessageId: replied.message_id,
    topicRootId: message.message_thread_id,
    isServiceMessage: 'forum_topic_created' in replied,
    fromBot: botId !== undefined && replied.from?.id === botId,
  };
  return buildReplyQuoteBlock(extractReplyQuote(source)) ?? undefined;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Natural-language start phrases (`claude ...`, `opencode ...`)
// ═══════════════════════════════════════════════════════════════════════════════

// (Parser imported up-top — see `parseAgentTrigger` import.)

// ═══════════════════════════════════════════════════════════════════════════════
//  Model selection helper — used by /model and the numeric-reply flow
// ═══════════════════════════════════════════════════════════════════════════════

function formatTimeAgo(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${Math.floor(diffHours / 24)}d ago`;
}

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

// ═══════════════════════════════════════════════════════════════════════════════
//  Commands
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * @description The core's name → handler table for commands. Platform-neutral:
 * it knows `/status` as the name `status`, never as Telegram syntax. The
 * Telegram trigger below is what recognises `/status@thisbot` and hands this
 * router an already-normalized {@link InboundEvent}.
 */
const commandRouter = createCommandRouter();

// Arm the connector's inbound side. Synchronous in practice (it only stores the
// handler), and done at module scope so no update can arrive before it: the
// telegraf trigger below is registered here too, and `bot.launch` is much later.
void telegramInbound.start(async (event) => {
  // `checkIsRegistered` already gated the name, so a `false` here means the
  // table changed under us — surface it instead of silently eating the message.
  const wasDispatched = await commandRouter.dispatch(event);
  if (!wasDispatched) {
    console.warn(`[command] ${keyToString(event.key)} no handler for "${event.command?.name}"`);
  }
});

/** The Telegram context a command handler receives — a text message, always. */
type CommandContext = NarrowedContext<Context, Update.MessageUpdate<Message.TextMessage>>;

/**
 * @description Register a command handler on the neutral router.
 *
 * Each handler gets the resolved `key` (gating already applied by the trigger
 * below, so it can never be null here) plus the already-parsed
 * {@link InboundCommand}, so no handler re-splits the raw text itself.
 *
 * The `raw` assertion below is a KNOWN, deliberate exception to the repo's
 * no-casts rule, and the only typing the seam permits: `InboundEvent.raw` is
 * `unknown` BY DESIGN (a connector-private payload the core must not interpret),
 * so no core-side type can describe it. Parameterising `InboundEvent` on it
 * would type the neutral router against a Telegram type and undo the seam; a
 * structural type guard for a ~100-member telegraf `Context` would be an
 * unsound assertion wearing a guard's signature. It disappears only when the
 * command handlers stop reading the telegraf context and move into
 * `connectors/telegram/` — the follow-up decomposition, not a typing change.
 */
function command(
  name: string | string[],
  handler: (ctx: CommandContext, key: SessionKey, parsed: InboundCommand) => Promise<void> | void,
): void {
  commandRouter.register(name, (event, parsed) =>
    handler(event.raw as CommandContext, event.key, parsed),
  );
}

/**
 * @description True iff the neutral router owns `name`, i.e. a `/name` message
 * is claimed by the routed-command trigger instead of falling through.
 *
 * Exported so the fall-through contract can be asserted against the REAL
 * registration table: `pair` must stay OFF it (it is a raw `bot.command` that
 * has to run in a not-yet-paired group, which authorisation would reject).
 */
export function checkIsRoutedCommand(name: string): boolean {
  return commandRouter.checkIsRegistered(name);
}

/**
 * @description Running ANY command exits the single-purpose input modes an
 * earlier command armed:
 *  - `/bind`'s create-folder await-name mode — that flow only expects a plain
 *    folder-name message, never a command (the picker's create button re-arms
 *    it afterwards via its own callback);
 *  - `/connect`'s pending provider connect — cancelled out loud, unless the
 *    command IS another `/connect` (which continues the flow);
 *  - an in-flight `/reminders` wizard, at whatever step. Unconditional rather
 *    than only during the step-4 text wait: that is what makes a repeat
 *    `/reminders` retire the previous wizard (relabelling its message) instead
 *    of leaving a second live-looking keyboard in the topic. Cheap — it returns
 *    at once when no wizard exists, and only then spends a send on the relabel.
 */
async function exitPendingInputModes(key: SessionKey, messageText: string): Promise<void> {
  const keyString = keyToString(key);
  awaitingFolderName.delete(keyString);
  const hadPendingProviderConnect = pendingProviderConnects.delete(keyString);
  if (hadPendingProviderConnect && !checkIsConnectCommandText(messageText)) {
    await replyToThread(key, t('connect.cancelled'));
  }
  await cancelReminderWizard(key);
}

/**
 * @description Collaborators of {@link handleRoutedCommandMessage}, injected so
 * the trigger's guard ORDER is provable without a live Telegraf instance, a
 * paired group or an admin-cache round trip.
 */
export interface RoutedCommandTriggerDeps<TContext> {
  /** Telegraf's own command recognition, re-implemented in `getTelegramCommand`. */
  getCommand: (message: Message.TextMessage) => InboundCommand | null;
  /** Is the name on the neutral router's table? `false` ⇒ fall through. */
  checkIsRegistered: (name: string) => boolean;
  /** Resolve + gate the sender. `null` ⇒ not allowed here: drop, no fall-through. */
  authorise: (ctx: TContext) => Promise<SessionKey | null>;
  /** Clear the single-purpose input modes an earlier command armed. */
  exitPendingInputModes: (key: SessionKey, messageText: string) => Promise<void>;
  /** Reset the compact-on-idle watchdog (F2) — any command is thread activity. */
  noteActivity: (key: SessionKey) => void;
  /** Normalize through the connector and hand the event to the core's router. */
  deliverInbound: (ctx: TContext, key: SessionKey) => Promise<void>;
}

/**
 * @description The single Telegram trigger for every routed command, replacing
 * the per-command `bot.command(...)` registrations.
 *
 * Recognition is telegraf's own rule, re-implemented in
 * {@link getTelegramCommand}, so WHICH messages count as commands is unchanged
 * — including `/name@otherbot` falling through.
 *
 * The guard ORDER is load-bearing in both directions and is what this function
 * exists (separately from its `bot.on` registration) to make testable:
 *  - an unrouted name calls `next()` BEFORE authorisation, so a raw
 *    `bot.command` further down the middleware chain — `/pair`, which must work
 *    in a group the bot is not paired with yet — still receives it;
 *  - a rejected sender returns WITHOUT `next()`, so the update stops at the
 *    first gate that refused it. The generic text handler below re-authorises,
 *    so a stray `next()` would not actually leak the command; it would spend a
 *    second admin-cache round trip and log the same refusal twice, which is how
 *    a real leak would be missed in the noise.
 */
export async function handleRoutedCommandMessage<TContext extends { message: Message.TextMessage }>(
  ctx: TContext,
  next: () => Promise<void>,
  deps: RoutedCommandTriggerDeps<TContext>,
): Promise<void> {
  const parsed = deps.getCommand(ctx.message);
  if (!parsed || !deps.checkIsRegistered(parsed.name)) return next();
  const key = await deps.authorise(ctx);
  if (!key) return;
  await deps.exitPendingInputModes(key, ctx.message.text);
  deps.noteActivity(key);
  await deps.deliverInbound(ctx, key);
}

/**
 * @description Hand a routed command to the connector for normalization.
 *
 * Normalization goes through the connector rather than a second inline
 * `getInboundEvent` call so exactly one place decides what lands on the event.
 *
 * The event's `raw` is the telegraf CONTEXT, not `ctx.message` — load-bearing,
 * and it shipped wrong once (fixed in `c9b1da4`): the not-yet-relocated command
 * handlers read Telegram fields off the context, so one reading
 * `ctx.message.message_id` finds `undefined` when `raw` is the bare message.
 * `ConnectorInbound.deliver` types `raw` as `unknown`, so only a test can hold
 * this line honest.
 */
export function deliverRoutedCommand<TContext extends { message: Message.TextMessage }>(
  ctx: TContext,
  key: SessionKey,
): Promise<void> {
  return telegramInbound.deliver(ctx.message, key, ctx);
}

/**
 * Registered at the position the first command used to occupy, so middleware
 * order relative to `bot.command('pair')` and the text handler is preserved.
 */
export const routedCommandTriggerDeps: RoutedCommandTriggerDeps<CommandContext> = {
  getCommand: (message) => getTelegramCommand(message, { username: bot.botInfo?.username }),
  checkIsRegistered: checkIsRoutedCommand,
  authorise: authoriseContext,
  exitPendingInputModes,
  noteActivity: noteThreadActivity,
  deliverInbound: deliverRoutedCommand,
};

bot.on(message('text'), (ctx, next) =>
  handleRoutedCommandMessage(ctx, next, routedCommandTriggerDeps),
);

/** The connector the routed-command trigger and the core's dispatcher share. */
export { telegramInbound };

command('start', async (_ctx, key) => {
  const adapters = getAvailableAdapters();
  const list = adapters.map(a => `• ${a.label} (/${a.name})`).join('\n');
  await replyToThread(
    key,
    'AI Agent Bot (multi-thread)\n\n' +
      `WORK_ROOT: ${ENV.workRoot}\n\n` +
      `Available agents:\n${list}\n\n` +
      '/claude /opencode — start an agent in this thread\n' +
      '/sessions — previous sessions\n' +
      '/quit — quit current agent\n' +
      '/status — show status',
  );
});

command('status', async (_ctx, key) => {
  // In General the per-thread status is meaningless (no binding ever) — so
  // we promote /status to a workspace-wide overview there. Topical threads
  // keep the per-thread report.
  if (checkIsGeneral(key)) {
    const rows = collectBindingRows();
    if (rows.length === 0) {
      await replyToThread(key, t('status.global_empty'));
      return;
    }
    const body = rows.map(r => t('status.global_row', {
      key: keyToString(r.key),
      subdir: r.subdir,
      agent: r.agentLabel,
      status: formatBindingStatus(r),
    })).join('\n');
    await replyToThread(
      key,
      `${t('status.global_header', { total: rows.length })}\n${body}`,
      { parse_mode: 'Markdown' },
    );
    return;
  }
  const adapter = getThreadAdapter(key);
  const isActive = adapter.checkIsActive(key);
  const adapterName = getThreadAdapterNameRaw(key);
  const agentLine = adapterName ? `${adapter.label} (${adapterName})` : t('status.thread_no_agent');
  const binding = state.getBinding(key);
  const subdir = binding?.subdir ?? t('status.thread_no_binding');
  let workDir: string | null = null;
  if (binding) {
    workDir = t('version.unknown');
    try {
      const resolved = resolveBoundWorkDir(ENV.workRoot, binding);
      if (resolved.kind === 'proceed') workDir = resolved.workDir;
    } catch (error) {
      console.warn(`[Status] failed to resolve work directory for ${keyToString(key)}:`, error instanceof Error ? error.message : error);
    }
  }
  // Model / effort / start date are session properties — only meaningful while
  // a session is live. Effort resolves exactly like the pinned banner
  // (`computePinnedStatusText`), plus a fallback to the default the agent
  // actually runs when none is picked. Model resolution is DELIBERATELY wider
  // than the banner's: it adds the runtime's self-reported model, which the
  // banner cannot share because `computePinnedStatusText` is synchronous while
  // reading runtime info is an async transcript/HTTP read. So on the Claude tmux
  // backend `/status` can name a model the banner still leaves blank.
  let model: string | null = null;
  let effort: string | null = null;
  let startedAt: string | null = null;
  let runtime: AgentRuntimeInfo | null = null;
  if (isActive) {
    const agent = state.getAgent(key);
    effort = adapter.getEffort ? (adapter.getEffort(key) ?? defaultEffortLevel) : null;
    startedAt = agent?.startedAt ?? null;

    if (adapter.getRuntimeInfo) {
      runtime = await adapter.getRuntimeInfo(key).catch((error) => {
        console.warn(`[Status] failed to read runtime info for ${keyToString(key)}:`, error instanceof Error ? error.message : error);
        return null;
      });
    }
    // The runtime is read BEFORE the label is resolved so its self-reported
    // model can serve as the middle fallback (see `getThreadStatusModel`).
    model = getThreadStatusModel({
      adapterModel: adapter.getCurrentModel?.(key) ?? null,
      runtimeModel: runtime?.model ?? null,
      persistedModel: agent?.model ?? null,
    });
  }
  const timezone = getCurrentTimezone();
  await replyToThread(key, getThreadStatusReport({
    agentLine, subdir, isActive, workDir, model, effort, startedAt, runtime,
    timezone,
    timezoneNow: formatZoneNow(timezone, Date.now()),
  }));
});

/** The `/language` argument: the first token, lower-cased (locale codes are case-insensitive). */
function getLanguageCommandArg(parsed: InboundCommand): string {
  return (parsed.args[0] ?? '').toLowerCase();
}

command(['language', 'lang'], async (ctx, key, parsed) => {
  const chatId = getTelegramChatId(key);
  const locales = localeCodes.join(', ');
  const arg = getLanguageCommandArg(parsed);

  if (arg === 'auto' || arg === 'reset') {
    await state.setChatLocaleOverride(chatId, null);
    const resolved = getResolvedChatLocale(chatId, getTelegramLocale(ctx));
    await replyToThread(key, runWithLocale(resolved.locale, () => t('language.auto_success', { display: formatLanguageDisplay(resolved) })));
    return;
  }

  if (arg) {
    const locale = normalizeLocale(arg);
    if (!locale) {
      await replyToThread(key, t('language.invalid', { locale: arg, locales }));
      return;
    }
    await state.setChatLocaleOverride(chatId, locale);
    await replyToThread(key, runWithLocale(locale, () => t('language.set_success', { locale })));
    return;
  }

  const resolved = getResolvedChatLocale(chatId, getTelegramLocale(ctx));
  const override = state.getChatLocaleOverride(chatId);
  await replyToThread(
    key,
    t('language.status', { display: formatLanguageDisplay(resolved) }),
    buildLanguagePicker(override),
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
//  /timezone — the instance-wide operator timezone
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * @description The zone in effect right now: the stored `/timezone` pick, else
 * the host zone. Single read point so no call site re-derives the fallback.
 */
function getCurrentTimezone(): string {
  return getEffectiveTimezone(state.getTimezone());
}

/**
 * @description Apply a zone change end to end and render its confirmation.
 *
 * Order is load-bearing: persist → apply to the process → THEN recompute the
 * schedules. The recompute derives each job's next occurrence from the current
 * clock, so it must run after `process.env.TZ` has been re-based, or every job
 * would be re-based against the OLD zone.
 *
 * `null` resets to the host zone. The recompute deliberately goes through
 * {@link recomputeSchedulesForTimezoneChange} rather than the engine's
 * `rearmAll()`, which would read the now-stale stored `nextRunAt` values as
 * missed runs and fire catch-up announcements into every topic.
 */
async function applyTimezoneSelection(timezone: string | null): Promise<string> {
  await state.setTimezone(timezone);
  applyProcessTimezone(timezone);

  const recompute = schedulerEngine
    ? await recomputeSchedulesForTimezoneChange({
        store: state,
        engine: schedulerEngine,
        now: () => Date.now(),
      })
    : { recomputed: 0, removed: 0 };

  const zone = getEffectiveTimezone(timezone);
  const vars = { zone, now: formatZoneNow(zone, Date.now()), count: recompute.recomputed };
  const lines = [
    timezone === null ? t('timezone.auto_success', vars) : t('timezone.set_success', vars),
  ];
  // A fixed offset is a legitimate pick (Intl accepts it) but silently goes an
  // hour wrong across a DST boundary, so say so instead of rejecting it.
  if (timezone !== null && checkIsFixedOffsetZone(timezone)) {
    lines.push(t('timezone.fixed_offset_warning'));
  }
  return lines.join('\n');
}

/** The inline keyboard shape both `/timezone` picker levels produce. */
type TimezonePickerKeyboard = ReturnType<typeof buildTimezoneRegionPicker>;

/** Header + keyboard for the level-1 (regions) picker view. */
function buildTimezoneRegionView(): { text: string; keyboard: TimezonePickerKeyboard } {
  const zone = getCurrentTimezone();
  return {
    text: t('timezone.picker_regions', { zone, now: formatZoneNowWithDate(zone, Date.now()) }),
    keyboard: buildTimezoneRegionPicker(state.getTimezone()),
  };
}

/**
 * @description The `/timezone` argument, preserved VERBATIM (not lowercased,
 * unlike `/language`'s locale codes): zone names are canonicalized by `Intl`
 * downstream, and a fixed offset like `+04:00` has no case to normalize.
 */
function getTimezoneCommandArg(parsed: InboundCommand): string {
  return parsed.args[0] ?? '';
}

command('timezone', async (_ctx, key, parsed) => {
  const arg = getTimezoneCommandArg(parsed);

  if (arg.toLowerCase() === 'auto' || arg.toLowerCase() === 'reset') {
    await replyToThread(key, await applyTimezoneSelection(null));
    return;
  }

  if (arg) {
    const canonical = getCanonicalTimezone(arg);
    if (canonical === null) {
      await replyToThread(key, `${t('timezone.invalid', { zone: arg })}\n${t('timezone.usage')}`);
      return;
    }
    // `Intl` accepts an offset like `+05:30`, but `process.env.TZ` has no
    // spelling for it — applying it would leave the process on UTC while the
    // confirmation reported `+05:30`. Refuse rather than accept a no-op.
    if (!checkIsApplicableTimezone(canonical)) {
      await replyToThread(key, `${t('timezone.offset_unsupported', { zone: canonical })}\n${t('timezone.usage')}`);
      return;
    }
    await replyToThread(key, await applyTimezoneSelection(canonical));
    return;
  }

  const view = buildTimezoneRegionView();
  await replyToThread(key, view.text, view.keyboard);
});

// ═══════════════════════════════════════════════════════════════════════════════
//  /bind /unbind /where — thread ↔ subfolder binding (plan §11 Этап 4)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * @description Persist a `key → subdir` binding and report the outcome.
 *
 * Shared between the `/bind <subdir>` command and the `bind_<subdir>`
 * inline-callback so both paths apply identical validation, collision
 * checks (plan §11 Этап 4 — warn when other threads already use the same
 * folder, decision D7) and acknowledgement formatting.
 *
 * Returns `{ ok: true, subdir }` on success, plus a localised
 * acknowledgement string. Callers send the message themselves so they
 * can stack additional content (rich welcome, etc.) underneath.
 */
type ApplyBindingResult =
  | { ok: true;  message: string; subdir: string }
  | { ok: false; message: string };

async function applyBinding(
  key: SessionKey,
  rawSubdir: string,
  options: { topicName?: string } = {},
): Promise<ApplyBindingResult> {
  let subdir: string;
  try {
    subdir = validateSubdir(ENV.workRoot, rawSubdir);
  } catch (e) {
    let msg: string;
    if (e instanceof BindError) {
      msg = formatBindErrorMessage(e, rawSubdir);
    } else {
      msg = `❌ ${e instanceof Error ? e.message : String(e)}`;
    }
    return { ok: false, message: msg };
  }

  // Collision warning: one folder may host several threads (D7), but the
  // user should know they're about to join an existing workspace rather
  // than start a fresh one.
  const peers = state.listKeysForSubdir(subdir).filter(k => keyToString(k) !== keyToString(key));
  await state.setBinding(key, subdir, options.topicName !== undefined ? { topicName: options.topicName } : {});

  const message = peers.length > 0
    ? t('thread.bind_collision', {
        subdir,
        threads: peers.map(k => `\`${keyToString(k)}\``).join(', '),
      })
    : t('thread.bound', { subdir });

  // Rebind resume (S8): a thread that was unbound paused its schedules; binding
  // it again (this thread, possibly a different folder) resumes them. Best
  // effort — a folder pick must succeed even if the resume bookkeeping hiccups.
  await resumeThreadSchedulesOnRebind(key).catch((e) =>
    console.warn(`[scheduler] resume-on-rebind failed for ${keyToString(key)}:`, e),
  );

  return { ok: true, message, subdir };
}

/**
 * @description Pause the AGENT-PROMPT schedules owned by `key` because its topic
 * was just unbound (S8): flag each `isPaused` with reason `'unbound'`, disarm its
 * timer, and post ONE notice naming the count (only when > 0). Scheduler pins are
 * NOT touched (user decision: pins accumulate). Returns the number paused so the
 * caller can decide whether anything happened. The engine stays generic — this
 * unbound-specific policy lives here in bot.ts.
 *
 * Reminders are EXEMPT ({@link getUnboundPausableSchedules}): they post + pin with
 * no agent and no folder, so pausing them on unbind would break the one kind that
 * could still have fired. A thread holding only reminders pauses nothing and posts
 * no notice.
 */
async function pauseThreadSchedulesOnUnbind(key: SessionKey): Promise<number> {
  const records = getUnboundPausableSchedules(state.getThreadSchedules(key));
  if (records.length === 0) return 0;
  for (const record of records) {
    await state.setSchedulePaused(record.id, true, 'unbound');
    schedulerEngine?.disarmJob(record.id);
  }
  await replyToThread(key, t('schedule.pausedUnbound', { count: records.length }));
  return records.length;
}

/**
 * @description Resume the schedules paused for `'unbound'` on `key` when its
 * topic is rebound (S8): recompute each `nextRunAt` FROM NOW (no catch-up for a
 * deliberate pause), then either un-pause + re-arm, or — for a one-shot whose
 * instant already passed while unbound — drop the record (a past one-shot has no
 * future occurrence, so it cannot be resumed). Posts ONE notice with the resumed
 * count (only when > 0). Jobs paused for other reasons (none exist in v1) are
 * left alone.
 */
async function resumeThreadSchedulesOnRebind(key: SessionKey): Promise<void> {
  const paused = state
    .getThreadSchedules(key)
    .filter((record) => record.isPaused && record.pauseReason === 'unbound');
  if (paused.length === 0) return;

  const nowMs = Date.now();
  let resumed = 0;
  for (const record of paused) {
    const action = getRebindResumeAction(record, nowMs);
    if (action.kind === 'remove') {
      await state.removeSchedule(record.id);
      schedulerEngine?.disarmJob(record.id);
      continue;
    }
    const updated: ScheduleRecord = {
      ...record,
      nextRunAt: action.nextRunAt,
      updatedAt: new Date(nowMs).toISOString(),
    };
    delete updated.isPaused;
    delete updated.pauseReason;
    await state.upsertSchedule(updated);
    schedulerEngine?.armJob(updated);
    resumed += 1;
  }
  if (resumed > 0) {
    await replyToThread(key, t('schedule.resumedRebind', { count: resumed }));
  }
}

/**
 * @description Arm a thread's await-folder-name mode for the `/bind`
 * create-folder flow. Clears any other in-flight pick mode first so the
 * armed-mode branches in the text handler never overlap (only one armed
 * mode is active per thread at a time).
 */
function armFolderCreation(key: SessionKey): void {
  const kStr = keyToString(key);
  awaitingModelSelection.delete(kStr);
  awaitingSessionSelection.delete(kStr);
  // A stale pending question would otherwise consume the message AFTER the
  // folder name as an answer to the old (pre-rebind) agent question.
  clearPendingQuestion(key);
  awaitingFolderName.add(kStr);
}

/** Map a `validateNewFolderName` rejection to its localised reply. */
function mapNewFolderError(reason: NewFolderNameError): string {
  switch (reason) {
    case 'empty':         return t('bind.create_empty');
    case 'separator':     return t('bind.create_separator');
    case 'dot_segment':   return t('bind.create_dot_segment');
    case 'hidden':        return t('bind.create_hidden');
    case 'invalid_chars': return t('bind.create_invalid_chars');
    default:              return t('bind.create_empty');
  }
}

/**
 * @description Create a new folder under WORK_ROOT from a user-typed name and
 * bind the thread to it. Validates the name first (no traversal/slashes/dots),
 * then `mkdir` (recursive: an already-existing folder is fine — we just bind
 * to it and tell the user), then routes through `applyBinding` for the same
 * containment/symlink defence + welcome stack the picker uses.
 *
 * Returns `{ ok }` so the caller knows whether to disarm the await-name mode:
 * an invalid name keeps the thread armed for a retry; success or a real
 * filesystem failure disarms it.
 */
async function createAndBindFolder(key: SessionKey, rawName: string): Promise<{ ok: boolean }> {
  const validated = validateNewFolderName(rawName);
  if (!validated.ok) {
    await replyToThread(key, mapNewFolderError(validated.reason));
    return { ok: false };
  }

  const targetPath = path.join(ENV.workRoot, validated.name);
  const alreadyExisted = fs.existsSync(targetPath);
  try {
    fs.mkdirSync(targetPath, { recursive: true });
  } catch (e) {
    await replyToThread(key, t('bind.create_failed', {
      error: e instanceof Error ? e.message : String(e),
    }));
    return { ok: true };
  }

  // Folder freshly on disk → the cached subdir list is stale; drop it so the
  // next picker render includes the new folder.
  subdirCache.clear();

  if (alreadyExisted) {
    await replyToThread(key, t('bind.create_exists', { subdir: validated.name }));
  }
  const result = await applyBinding(key, validated.name);
  await replyToThread(key, result.message);
  if (result.ok) await sendBindingWelcome(key, result.subdir);
  return { ok: true };
}

command('bind', async (_ctx, key, parsed) => {
  if (checkIsGeneral(key)) {
    await replyToThread(key, t('bind.in_general'));
    return;
  }
  // Collapse internal whitespace runs so `/bind   foo` works the same as
  // `/bind foo` and we don't end up looking for a literal "foo  bar"
  // directory because the user double-tapped space.
  const parts = parsed.args;
  const arg = parts.join(' ');
  if (!arg) {
    // Show where the topic points now, so the picker message itself answers
    // "what am I bound to?" without a separate /where.
    const binding = state.getBinding(key);
    const currentLine = binding
      ? t('bind.current', { subdir: binding.subdir })
      : t('bind.current_none');
    const usage = `${currentLine}\n\n${t('bind.usage')}`;
    const subdirs = listAvailableSubdirs(ENV.workRoot);
    // Always show the keyboard — even with zero subdirs it carries the
    // «create new folder» button, which is the only way to bootstrap a folder
    // from an empty WORK_ROOT without the slash form. When already bound it
    // also carries the «leave current dir» button (the folded-in /unbind).
    await replyToThread(key, usage, buildBindKeyboard(subdirs, 0, BIND_PAGE_SIZE, !!binding));
    return;
  }
  const result = await applyBinding(key, arg);
  await replyToThread(key, result.message);
  if (result.ok) await sendBindingWelcome(key, result.subdir);
});

/**
 * @description Unbind a thread from its folder: stop any live session, drop the
 * pinned banner, release persisted session ids, pause the thread's schedules,
 * then wipe the binding. Shared by the `/bind` picker's «leave current dir»
 * button (the old `/unbind` command was folded into it). Safe to call only on a
 * BOUND, non-General topic — the leave button only renders there.
 */
async function unbindThread(key: SessionKey): Promise<void> {
  // Mark this thread as in-flight unbinding so the adapter's synchronous
  // `stopped` event doesn't race us and re-pin a stale "idle" banner over
  // the message we're about to delete.
  const kStr = keyToString(key);
  unbindingKeys.add(kStr);
  // Leaving the folder ends the conversation's work: its open request closes silently.
  cancelConversationRequest(key);
  try {
    // Order matters: drop the pin FIRST (while binding.pinnedStatusMessageId
    // is still readable), then stop the session, then wipe the binding.
    await clearPinnedStatus(key);

    // Stop any running session before discarding the binding so we don't leave
    // an orphan tmux/SSE stream pointing at a directory we no longer track.
    const adapter = getThreadAdapter(key);
    if (adapter.checkIsActive(key)) {
      // Close any still-pending OpenCode question on the server BEFORE stopping
      // the session — a stopped session can't accept the reject, and an
      // unrejected question re-surfaces on the next reattach. No-op for Claude /
      // no pending question.
      adapter.rejectQuestion?.(key);
      try { adapter.stopSession(key); } catch (e) {
        console.warn(`[unbind] stopSession failed for ${kStr}:`, e);
      }
    }
    // Release persisted session ids too — otherwise re-binding this thread
    // later + a bot restart would resurrect the old session the user unbound.
    await state.clearAgentSessionIds(key);
    // Pause this thread's schedules BEFORE dropping the binding: a fire against
    // an unbound topic can't deliver, so the jobs park (paused + disarmed) and
    // the next /bind resumes them. `removeBinding` only touches bindings/agents/
    // messages — schedules are their own collection and survive (S8).
    await pauseThreadSchedulesOnUnbind(key).catch((e) =>
      console.warn(`[scheduler] pause-on-unbind failed for ${kStr}:`, e),
    );
    await state.removeBinding(key);
    clearInMemoryThreadState(key);
    await replyToThread(key, t('thread.unbound'));
  } finally {
    unbindingKeys.delete(kStr);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  /ls /list — General-scoped info (plan §11 Этап 4)
// ═══════════════════════════════════════════════════════════════════════════════

// `/ls` is intentionally available in topical threads too — there's no
// security reason to refuse, and it's handy when the user wants to see
// siblings before running /bind.
command('ls', async (_ctx, key) => {
  const subdirs = listAvailableSubdirs(ENV.workRoot);
  if (subdirs.length === 0) {
    await replyToThread(key, t('ls.empty'));
    return;
  }
  const body = subdirs.map(s => `• \`${s}\``).join('\n');
  await replyToThread(
    key,
    `${t('ls.header', { workRoot: ENV.workRoot })}\n${body}`,
    { parse_mode: 'Markdown' },
  );
});

/**
 * @description Iterate the bindings, sort them deterministically and resolve
 * each thread's display label + activity. Shared between `/list` and the
 * General-scoped branch of `/status` so adapter-resolution safety and
 * sort/render rules stay aligned.
 *
 * `getAdapter(agent.name)` *throws* on unknown adapter names — the same
 * binding may have been persisted with an adapter that has since been
 * renamed or removed, so we wrap the lookup defensively and fall back to
 * the stored name. Without this, the very first stale binding crashes the
 * whole report (review CRITICAL #1).
 */
interface BindingRow {
  key: SessionKey;
  subdir: string;
  closed: boolean;
  agentLabel: string;
  isActive: boolean;
}

function collectBindingRows(): BindingRow[] {
  const bindings = [...state.listBindings()];
  bindings.sort((a, b) => getTelegramThreadId(a.key) - getTelegramThreadId(b.key));
  return bindings.map(({ key: k, data }) => {
    const agent = state.getAgent(k);
    let agentLabel = '—';
    if (agent?.name) {
      try { agentLabel = getAdapter(agent.name).label; }
      catch { agentLabel = agent.name; }
    }
    let isActive = false;
    if (agent) {
      try { isActive = getThreadAdapter(k).checkIsActive(k); }
      catch { /* keep false */ }
    }
    return {
      key: k,
      subdir: data.subdir,
      closed: data.closed === true,
      agentLabel,
      isActive,
    };
  });
}

function formatBindingStatus(row: BindingRow): string {
  if (row.closed) return '🔒 closed';
  return row.isActive ? '🟢 running' : '⚪ stopped';
}

command('list', async (_ctx, key) => {
  const rows = collectBindingRows();
  if (rows.length === 0) {
    await replyToThread(key, t('list.empty'));
    return;
  }
  const body = rows.map(r => {
    if (r.closed) {
      return t('list.row_closed', {
        threadId: getTelegramThreadId(r.key), subdir: r.subdir, agent: r.agentLabel,
      });
    }
    return t('list.row', {
      threadId: getTelegramThreadId(r.key),
      subdir: r.subdir,
      agent: r.agentLabel,
      status: formatBindingStatus(r),
    });
  }).join('\n');
  await replyToThread(
    key,
    `${t('list.header', { count: rows.length })}\n${body}`,
    { parse_mode: 'Markdown' },
  );
});

/**
 * @description `/new` (alias `/clear_session`) — stop the thread's current agent
 * session and immediately start a fresh one in the SAME topic with the SAME
 * adapter. The old session is RELEASED (not deleted): its transcript stays on
 * disk so it's still resumable via `/sessions`, but a bot restart won't
 * auto-reattach it. Unlike `/quit` + `/claude`, this is one tap and keeps the
 * thread's chosen backend.
 *
 * Guards mirror `handleStartCommand`: General has no binding/agent, so it just
 * hints; an unbound topic gets the standard bind-required reply.
 */
command(['new', 'clear_session'], async (_ctx, key) => {
  if (checkIsGeneral(key)) {
    await replyToThread(key, t('new.general_hint'));
    return;
  }
  if (!state.getBinding(key)) {
    await replyToThread(key, t('thread.bind_required'));
    return;
  }
  // A fresh session does not know the old one's request: it closes silently.
  cancelConversationRequest(key);
  // Release the current session (sweep + clear ids) via `releaseThreadSession`.
  // The fresh start below uses the thread's current adapter, so we keep the
  // adapter selection untouched.
  await releaseThreadSession(key);
  // `startAgentSession` handles startup buffering, the typing-loader boot, and
  // the preamble-marker reset. It returns `''` for a self-greeting agent (Claude
  // prints its own banner) — show a notice only for a non-empty ready text.
  const msg = await startAgentSession(key);
  if (msg) await replyToThread(key, msg);
});

// ═══════════════════════════════════════════════════════════════════════════════
//  /whoami /version /help /status (global) — debug & onboarding
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * @description Best-effort version probe for an external CLI.
 *
 * `execFile` is used (not `exec`) to avoid shell expansion of the argument
 * list — the binary name comes from configuration but the arg is constant.
 * 1500ms is enough for any reasonable `--version` call and short enough to
 * keep `/version` responsive when a binary hangs (e.g. opencode autostart
 * during a transient netfail).
 */
async function getCliVersion(cmd: string, args: string[] = ['--version']): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, { timeout: 1500 });
    const out = (stdout || stderr || '').split('\n')[0].trim();
    return out || t('version.unknown');
  } catch {
    return t('version.unknown');
  }
}

command('version', async (_ctx, key) => {
  // Read our own version from package.json so we don't drift if it ever bumps
  // again without us updating a hardcoded string here.
  let botVersion = t('version.unknown');
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    botVersion = pkg.version || botVersion;
  } catch { /* fall through to unknown */ }

  const [tmuxV, claudeV, opencodeV] = await Promise.all([
    getCliVersion('tmux', ['-V']),
    getCliVersion('claude'),
    getCliVersion('opencode'),
  ]);

  await replyToThread(
    key,
    t('version.report', {
      bot: botVersion,
      node: process.version,
      tmux: tmuxV,
      claude: claudeV,
      opencode: opencodeV,
    }),
    { parse_mode: 'Markdown' },
  );
});

command('whoami', async (ctx, key) => {
  const userId = ctx.from?.id ?? 0;
  // Per-chat authority is the single source of truth now (owner for a DM chat,
  // the served group's admins for the group chat); `checkIsAllowedUser` already
  // encodes the surface gate, so no extra group-id clause is needed.
  const allowed = await checkIsAllowedUser(ctx);
  const binding = state.getBinding(key);
  await replyToThread(
    key,
    t('whoami.report', {
      userId,
      chatId: getTelegramChatId(key),
      threadId: getTelegramThreadId(key),
      allowed: allowed ? 'yes' : 'no',
      binding: binding ? `\`${binding.subdir}\`` : t('whoami.binding_unbound'),
    }),
    { parse_mode: 'Markdown' },
  );
});

/**
 * @description Re-point the bot to the forum supergroup this command was
 * sent in. Registered raw (not via the group-gated `command()` wrapper) so
 * it can switch the bot from one group to another. Refused when the id is
 * locked by `ALLOWED_GROUP_ID` env. Only a creator/administrator of the target
 * group may pair, so a random group can't hijack the binding.
 */
bot.command('pair', async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  // A private chat has no group to pair. Reply with the DM hint only to the
  // owner (a resolvable DM key); any other private chat stays silent so foreign
  // DMs get nothing. Group chats fall through to the real pairing logic — so in
  // `both` the group can still be (re)paired via /pair from inside it.
  if (ctx.chat?.type === 'private') {
    const dmKey = getThreadKey(ctx);
    if (dmKey) await replyToThread(dmKey, t('pair.dm')).catch(() => {});
    return;
  }

  const routeChat = getRouteChat(ctx);
  const fallbackThreadId =
    ctx.message && 'message_thread_id' in ctx.message ? ctx.message.message_thread_id : undefined;
  const replyKey: SessionKey =
    getThreadKey(ctx) ??
    makeTelegramKey(ctx.chat?.id ?? routeChat?.id ?? 0, fallbackThreadId ?? GENERAL_THREAD_ID);

  if (isGroupLockedByEnv) {
    await replyToThread(replyKey, t('pair.locked')).catch(() => {});
    return;
  }
  if (!routeChat || routeChat.type !== 'supergroup' || !routeChat.is_forum) {
    await replyToThread(replyKey, t('pair.only_forum')).catch(() => {});
    return;
  }
  if (!(await checkIsForumAdmin(routeChat.id, userId))) {
    await replyToThread(replyKey, t('pair.not_admin')).catch(() => {});
    return;
  }

  effectiveGroupId = routeChat.id;
  await state.setPairedGroupId(routeChat.id);
  adminCache.invalidate();
  console.log(`[pair] re-paired to forum supergroup ${routeChat.id} via /pair`);
  const key = getThreadKey(ctx) ?? makeTelegramKey(routeChat.id, GENERAL_THREAD_ID);
  await replyToThread(key, t('pair.success', { groupId: routeChat.id }));
});

command('help', async (_ctx, key) => {
  if (checkIsGeneral(key)) {
    await replyToThread(key, t('help.general'), { parse_mode: 'Markdown' });
    return;
  }
  const binding = state.getBinding(key);
  if (!binding) {
    const subdirs = listAvailableSubdirs(ENV.workRoot);
    const extra = buildBindKeyboard(subdirs, 0, BIND_PAGE_SIZE, !!state.getBinding(key));
    await replyToThread(key, t('help.thread_unbound'), {
      parse_mode: 'Markdown',
      ...(extra ?? {}),
    });
    return;
  }
  await replyToThread(
    key,
    t('help.thread_bound', { subdir: binding.subdir }),
    { parse_mode: 'Markdown' },
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Rich binding welcome (plan §20.5) — folder stats + start-agent keyboard
// ═══════════════════════════════════════════════════════════════════════════════

interface BindingStats {
  claudeMdSize: string | null;
  mcpServerCount: number | null;
  gitBranch: string | null;
  gitClean: boolean | null;   // null = no git repo
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * @description Collect a short factual summary of a bound project folder for
 * the welcome message — what onboarding context Claude would actually pick
 * up (CLAUDE.md), what MCP servers are configured at the project level, and
 * what git state the folder is in. Every probe is best-effort: a missing
 * file or non-git folder just means the corresponding row is dropped from
 * the welcome.
 */
async function getBindingStats(workDir: string): Promise<BindingStats> {
  const out: BindingStats = {
    claudeMdSize: null,
    mcpServerCount: null,
    gitBranch: null,
    gitClean: null,
  };

  try {
    const stat = fs.statSync(path.join(workDir, 'CLAUDE.md'));
    if (stat.isFile()) out.claudeMdSize = formatBytes(stat.size);
  } catch { /* no CLAUDE.md */ }

  try {
    const raw = fs.readFileSync(path.join(workDir, '.mcp.json'), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.mcpServers === 'object' && parsed.mcpServers) {
      out.mcpServerCount = Object.keys(parsed.mcpServers).length;
    }
  } catch { /* no .mcp.json or invalid */ }

  // `git` is only inspected if `.git` is present — avoids spawning the
  // binary on every /bind, and dodges sub-second `git status` runs for big
  // monorepos.
  try {
    fs.accessSync(path.join(workDir, '.git'));
  } catch { return out; }

  try {
    const { stdout } = await execFileAsync('git', ['symbolic-ref', '--short', 'HEAD'], {
      cwd: workDir, timeout: 1500,
    });
    out.gitBranch = stdout.trim() || 'HEAD';
  } catch { out.gitBranch = 'HEAD'; }

  try {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain'], {
      cwd: workDir, timeout: 1500,
    });
    out.gitClean = stdout.trim().length === 0;
  } catch { /* keep null = unknown */ }

  return out;
}

/**
 * @description Inline keyboard offering one-tap entry into the freshly bound
 * thread. The buttons reuse existing callback handlers (`agent_*` and
 * `resume_*`) so the routes stay single-sourced; resume is included as a
 * shortcut to the picker view.
 */
function buildStartAgentKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('▶️ Claude', 'agent_claude'),
      Markup.button.callback('▶️ OpenCode', 'agent_opencode'),
    ],
    [Markup.button.callback('📋 Resume…', 'open_sessions')],
  ]);
}

/**
 * @description Compose and send the rich post-bind welcome described in
 * plan §20.5: header with the bound subdir, three optional fact rows
 * (CLAUDE.md / .mcp.json / git), and an inline keyboard to start an agent.
 * Falls back gracefully when stats can't be probed.
 */
async function sendBindingWelcome(key: SessionKey, subdir: string): Promise<void> {
  // Pin the status banner first so the user sees it land near the top of
  // the thread before the slower stats probe finishes. Fire-and-forget —
  // a failed pin (missing permissions, closed topic) just logs a warning
  // and never blocks the welcome flow.
  updatePinnedStatus(key).catch(err =>
    console.warn(`[pinned] initial pin for ${keyToString(key)} failed:`, err),
  );

  const workDir = path.join(ENV.workRoot, subdir);
  let stats: BindingStats;
  try {
    stats = await getBindingStats(workDir);
  } catch {
    stats = { claudeMdSize: null, mcpServerCount: null, gitBranch: null, gitClean: null };
  }

  const lines: string[] = [t('binding.welcome.header', { subdir })];
  if (stats.claudeMdSize) lines.push(t('binding.welcome.claude_md', { size: stats.claudeMdSize }));
  if (stats.mcpServerCount !== null) {
    lines.push(t('binding.welcome.mcp_json', { count: stats.mcpServerCount }));
  }
  if (stats.gitBranch) {
    const detail = stats.gitClean === null
      ? ''
      : stats.gitClean ? t('binding.welcome.git_clean') : t('binding.welcome.git_dirty');
    lines.push(t('binding.welcome.git', { branch: stats.gitBranch, detail }));
  } else if (fs.existsSync(path.join(workDir, '.git')) === false) {
    lines.push(t('binding.welcome.git_none'));
  }
  lines.push('');
  lines.push(t('binding.welcome.start_prompt'));

  await replyToThread(key, lines.join('\n'), {
    parse_mode: 'Markdown',
    ...buildStartAgentKeyboard(),
  });
}

// `open_sessions` callback wires the [📋 Resume…] button to the `/sessions`
// flow — same `handleSessionsList` helper the slash command calls into, so
// the picker source (list rendering + pick-mode arming) stays single-sourced.
bot.action('open_sessions', async (ctx) => {
  const key = await authoriseContext(ctx);
  if (!key) { await ctx.answerCbQuery(t('cb.access_denied')); return; }
  await ctx.answerCbQuery();
  await handleSessionsList(key);
});

// ═══════════════════════════════════════════════════════════════════════════════
//  /doctor — self-diagnostics (plan §20.1)
// ═══════════════════════════════════════════════════════════════════════════════

interface DoctorLine {
  status: 'ok' | 'warn' | 'fail';
  label: string;
  hint?: string;
}

function formatDoctorLine(line: DoctorLine): string {
  if (line.status === 'ok')  return t('doctor.ok',   { label: line.label });
  if (line.status === 'warn') return t('doctor.warn', { label: line.label, hint: line.hint ?? '' });
  return                       t('doctor.fail', { label: line.label, hint: line.hint ?? '' });
}

async function checkCliPresent(cmd: string): Promise<boolean> {
  try {
    await execFileAsync(cmd, ['--version'], { timeout: 1500 });
    return true;
  } catch { return false; }
}

async function runDoctor(): Promise<DoctorLine[]> {
  const lines: DoctorLine[] = [];

  // 1. Bot admin permissions in the configured group.
  const groupId = getAllowedGroupId();
  if (groupId === null) {
    lines.push({ status: 'warn', label: t('doctor.bot_admin'), hint: t('pair.not_paired') });
  } else try {
    const botId = bot.botInfo?.id ?? (await bot.telegram.getMe()).id;
    const member = await bot.telegram.getChatMember(groupId, botId);
    if (member.status === 'administrator') {
      lines.push({ status: 'ok', label: t('doctor.bot_admin') });
      lines.push({
        status: member.can_manage_topics ? 'ok' : 'fail',
        label: t('doctor.can_manage_topics'),
        hint: t('error.tg.perm.manage_topics'),
      });
      lines.push({
        status: member.can_delete_messages ? 'ok' : 'fail',
        label: t('doctor.can_delete_messages'),
        hint: t('error.tg.perm.delete'),
      });
      lines.push({
        status: member.can_pin_messages ? 'ok' : 'warn',
        label: t('doctor.can_pin_messages'),
        hint: t('doctor.pin_hint'),
      });
    } else {
      lines.push({
        status: 'fail',
        label: t('doctor.bot_admin'),
        hint: `current status: ${member.status}`,
      });
    }
  } catch (e) {
    lines.push({
      status: 'warn',
      label: t('doctor.bot_admin'),
      hint: t('doctor.no_admin_info'),
    });
  }

  // 2. Privacy mode (heuristic — Bot API doesn't expose the flag directly,
  //    but `getMe().can_read_all_group_messages === false` indicates it's on).
  try {
    const me = await bot.telegram.getMe();
    lines.push({
      status: me.can_read_all_group_messages ? 'ok' : 'fail',
      label: t('doctor.privacy_off'),
      hint: t('doctor.privacy_hint'),
    });
  } catch { /* skip silently — covered by admin check above */ }

  // 3. WORK_ROOT.
  const subdirCount = listAvailableSubdirs(ENV.workRoot, 9999).length;
  lines.push({
    status: 'ok',
    label: t('doctor.workroot_subdirs', { workRoot: ENV.workRoot, count: subdirCount }),
  });

  // 4. DATA_DIR.
  lines.push({
    status: 'ok',
    label: t('doctor.datadir_path', { dataDir: path.dirname(state.stateFilePath) }),
  });

  // 5. CLI presence — informational, auto-install kicks in on first /claude
  //    or /opencode anyway.
  const [hasClaude, hasOpencode] = await Promise.all([
    checkCliPresent('claude'),
    checkCliPresent('opencode'),
  ]);
  lines.push({
    status: hasClaude ? 'ok' : 'warn',
    label: t('doctor.claude_installed'),
    hint: t('doctor.cli_missing'),
  });
  lines.push({
    status: hasOpencode ? 'ok' : 'warn',
    label: t('doctor.opencode_installed'),
    hint: t('doctor.cli_missing'),
  });

  // 6. State validity (and archive notice).
  const bindings = state.listBindings();
  const activeCount = bindings.filter(({ key: k }) => {
    try { return getThreadAdapter(k).checkIsActive(k); } catch { return false; }
  }).length;
  lines.push({
    status: 'ok',
    label: t('doctor.state_valid', { bindings: bindings.length, active: activeCount }),
  });
  if (state.wasCorruptedOnLoad()) {
    lines.push({
      status: 'warn',
      label: t('doctor.state_archived', { path: state.getCorruptedArchivePath() ?? '?' }),
    });
  }

  return lines;
}

command('doctor', async (_ctx, key) => {
  // Single big edit-in-place would be nicer, but doctor is rarely run and
  // gathering the report in series keeps it dead simple.
  const lines = await runDoctor();
  const body = lines.map(formatDoctorLine).join('\n');
  await replyToThread(
    key,
    `${t('doctor.header')}\n\n${body}`,
    { parse_mode: 'Markdown' },
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
//  /mcp — read-only listing of MCP servers across all four levels (§19.3)
// ═══════════════════════════════════════════════════════════════════════════════

interface McpEntry {
  name: string;
  source: string;
}

function loadMcpFile(filePath: string): string[] {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.mcpServers === 'object' && parsed.mcpServers) {
      return Object.keys(parsed.mcpServers);
    }
    // Claude CLI also accepts a `mcpServers` key inside `~/.claude/settings.json`
    // alongside other settings; same shape.
  } catch { /* missing / unreadable / invalid JSON — skip */ }
  return [];
}

function collectMcpEntries(workDir: string | null, key: SessionKey | null): McpEntry[] {
  const entries: McpEntry[] = [];
  const dataDir = path.dirname(state.stateFilePath);

  // user-level
  const userPath = path.join(os.homedir(), '.claude', 'settings.json');
  for (const name of loadMcpFile(userPath)) {
    entries.push({ name, source: t('mcp.source_user') });
  }
  // group-level
  for (const name of loadMcpFile(path.join(dataDir, 'mcp.json'))) {
    entries.push({ name, source: t('mcp.source_group') });
  }
  // project-level
  if (workDir) {
    for (const name of loadMcpFile(path.join(workDir, '.mcp.json'))) {
      entries.push({ name, source: t('mcp.source_project', { workDir }) });
    }
  }
  // thread-level
  if (key) {
    const threadFile = path.join(dataDir, 'threads', `${keyToString(key)}.json`);
    for (const name of loadMcpFile(threadFile)) {
      entries.push({ name, source: t('mcp.source_thread') });
    }
  }
  return entries;
}

command('mcp', async (_ctx, key) => {
  const binding = state.getBinding(key);
  const workDir = binding ? path.join(ENV.workRoot, binding.subdir) : null;
  // General can still benefit from user+group entries even without a workDir.
  const entries = collectMcpEntries(workDir, checkIsGeneral(key) ? null : key);
  if (entries.length === 0) {
    await replyToThread(key, t('mcp.empty'));
    return;
  }
  const body = entries.map(e => t('mcp.row', { name: e.name, source: e.source })).join('\n');
  await replyToThread(
    key,
    `${t('mcp.header')}\n${body}`,
    { parse_mode: 'Markdown' },
  );
});

/**
 * @description Switch a thread to `adapterName` and START a session in one step —
 * the shared core behind the `/claude` `/opencode` `/terminal` commands AND the
 * post-bind welcome buttons (one tap: select + start). Returns nothing user-facing
 * itself beyond the replies it sends, so callers can layer their own follow-up
 * (the button re-renders its keyboard ✓ + refreshes the pinned banner).
 *
 * Guards (in order): General topic → refuse; no binding → bind-required reply +
 * folder picker; already-active session → "already running". A self-greeting
 * agent's `startAgentSession` returns `''` (Claude prints its own banner), so the
 * ready notice is shown only when there is text.
 *
 * `adapterName` is typed `string` because the button passes a raw callback match;
 * an unknown name makes `getThreadAdapter` throw, which the caller wrapping this
 * (the `agent_*` action) turns into a "unknown agent" answer.
 */
async function handleAgentStart(
  key: SessionKey,
  adapterName: string,
  args?: string,
): Promise<void> {
  if (checkIsGeneral(key)) {
    await replyToThread(key, t('error.start_in_general'));
    return;
  }
  // Refuse to start an agent without a binding — same rationale as the
  // natural-language path in the text handler (plan §11 Этап 4).
  if (!state.getBinding(key)) {
    const subdirs = listAvailableSubdirs(ENV.workRoot);
    const extra = buildBindKeyboard(subdirs, 0, BIND_PAGE_SIZE, !!state.getBinding(key));
    await replyToThread(key, t('thread.no_binding'), extra);
    return;
  }
  // "Claude Code" is one user-facing choice with two backends (tmux-scrape vs
  // json-stream); open the thread's picked backend, default tmux-scrape (for now).
  if (adapterName === 'claude') adapterName = resolveClaudeBackendName(key);
  await switchThreadAdapter(key, adapterName);
  const adapter = getThreadAdapter(key);
  if (adapter.checkIsActive(key)) {
    await replyToThread(key, t('agent.already_active', { label: adapter.label }));
    return;
  }
  const msg = await startAgentSession(key, args);
  if (msg) await replyToThread(key, msg);
}

/**
 * @description Thin wrapper extracting the trailing args from the command text
 * for {@link handleAgentStart}. The args are everything after the command word
 * (e.g. `/claude refactor src/bot.ts` → `refactor src/bot.ts`).
 */
function handleStartCommand(
  parsed: InboundCommand,
  key: SessionKey,
  adapterName: 'claude' | 'opencode' | 'terminal',
): Promise<void> {
  return handleAgentStart(key, adapterName, parsed.argsText || undefined);
}

command('claude', (_ctx, key, parsed) => handleStartCommand(parsed, key, 'claude'));
command(['opencode', 'oc'], (_ctx, key, parsed) => handleStartCommand(parsed, key, 'opencode'));
command('terminal', (_ctx, key, parsed) => handleStartCommand(parsed, key, 'terminal'));

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

/** Human label for a Claude backend name (the two adapters share `label`
 *  "Claude Code", so the picker/notices need a distinguishing name). */
function getClaudeBackendLabel(name: string): string {
  return name === claudeJsonStreamAdapterName ? '⚡ JSON-stream' : '🖥 Terminal-scrape';
}

/** Build the `/claude_mode` picker: one button per Claude backend, `✓` on the
 *  current one. Callback data `ccmode_<adapterName>`. */
function buildClaudeModeKeyboard(current: string) {
  const buttons = [claudeJsonStreamAdapterName, 'claude'].map((name) =>
    Markup.button.callback(
      name === current ? `${getClaudeBackendLabel(name)} ✓` : getClaudeBackendLabel(name),
      `ccmode_${name}`,
    ),
  );
  return Markup.inlineKeyboard(buttons, { columns: 1 });
}

/**
 * @description Switch a thread's Claude Code backend (tmux-scrape ↔ json-stream)
 * live. Both drive the same CLI against the same on-disk transcript, so an
 * ACTIVE session is RESUMED seamlessly on the new backend (same conversation);
 * an idle thread just records the pick for its next start. Returns the localized
 * notice to show. Assumes the thread is already on a Claude backend (callers gate).
 */
async function applyClaudeBackendSwitch(key: SessionKey, target: string): Promise<string> {
  const label = getClaudeBackendLabel(target);
  const wasActive = getThreadAdapter(key).checkIsActive(key);
  const sessionId = state.getAgent(key)?.claudeSessionId;

  // Stops the previous backend, records the pick, keeps `claudeSessionId`.
  await switchThreadAdapter(key, target);

  if (!wasActive) return t('claudeMode.set_idle', { label });

  const decision = getWorkDirStartDecision(key);
  if (!decision.ok) return decision.message;
  const targetAdapter = getThreadAdapter(key);
  sendThreadTypingIndicator(key).catch(() => {});
  if (sessionId && targetAdapter.resumeSession) {
    markNeedsNewMessage(key);
    clearThreadContextMarker(key);
    try {
      await targetAdapter.resumeSession(key, decision.workDir, sessionId, { isWithRecentContext: true });
      await persistAdapterSessionIds(key, targetAdapter, state);
      return t('claudeMode.switched_resumed', { label });
    } catch (e) {
      console.error('[claude_mode] resume failed, starting fresh:', e instanceof Error ? e.message : e);
    }
  }
  const msg = await startAgentSession(key);
  return msg || t('claudeMode.switched_fresh', { label });
}

command('claude_mode', async (_ctx, key, parsed) => {
  if (checkIsGeneral(key)) { await replyToThread(key, t('error.start_in_general')); return; }

  // Gate on the thread adapter name — the raw pick, else the Claude default via
  // `resolveClaudeBackendName` so a fresh no-pick topic still reads as a Claude
  // topic — but compare/✓ against the EFFECTIVE Claude backend, the same
  // resolution the start path uses. See `getClaudeModeAction` for the live bug
  // this split resolution fixes (a fresh thread under a legacy env-forced
  // 'claude' default no-oped the first `/claude_mode tmux`).
  const arg = parsed.argsText.toLowerCase();
  const action = getClaudeModeAction({
    threadAdapterName: getThreadAdapterNameRaw(key) ?? resolveClaudeBackendName(key),
    effectiveBackendName: resolveClaudeBackendName(key),
    requestedBackendName: parseClaudeBackendArg(arg),
  });
  if (action.kind === 'notClaude') { await replyToThread(key, t('claudeMode.not_claude')); return; }
  if (action.kind === 'already') {
    await replyToThread(key, t('claudeMode.already', { label: getClaudeBackendLabel(action.backendName) }));
    return;
  }
  if (action.kind === 'switch') {
    await replyToThread(key, await applyClaudeBackendSwitch(key, action.backendName));
    return;
  }
  await replyToThread(
    key,
    t('claudeMode.pick', { label: getClaudeBackendLabel(action.currentBackendName) }),
    buildClaudeModeKeyboard(action.currentBackendName),
  );
});

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
  return buildModelCatalog(models, adapter.label, state.getHiddenModelProviders());
}

/** Model label the thread currently runs, or the localized "default" stand-in. */
function getCurrentModelLabel(adapter: AgentAdapter, key: SessionKey): string {
  return adapter.getCurrentModel?.(key) || t('model.current_default');
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
export function checkIsNumberedModelPickArmed(key: SessionKey): boolean {
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
export function getNumberedModelPick(key: SessionKey, num: number): string | null {
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

/**
 * @description Arm (or disarm) the bare-digit pick to match what the render
 * actually shows. THE single choke point: a button pick re-renders its page
 * WITHOUT numbers, and leaving `awaitingModelSelection` armed there made a
 * later ordinary "3" prompt get swallowed as a model pick instead of reaching
 * the agent.
 */
export function applyModelPagePickArming(key: SessionKey, render: ModelPickerRender): void {
  if (render.isNumberedPickArmed && render.pageModels.length > 0) {
    armModelPagePick(key, render.pageModels);
    return;
  }
  clearModelPagePick(key);
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

/**
 * @description Id of the message a callback button sits on, or `null` when
 * Telegram did not attach one (a very old message). Callbacks that resolve an
 * INDEX against a per-message snapshot need it to reject a stale keyboard
 * rather than resolve against another message's list.
 */
function getCallbackMessageId(ctx: Context): number | null {
  return ctx.callbackQuery?.message?.message_id ?? null;
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

/** Re-render the provider level in place (after a hide/show toggle or «back»). */
async function refreshModelProviderLevel(ctx: Context, key: SessionKey): Promise<void> {
  const adapter = getThreadAdapter(key);
  const catalog = await getModelCatalog(adapter);
  const render = buildModelProviderRender(catalog, getCurrentModelLabel(adapter, key));
  applyModelPagePickArming(key, render);
  await editModelPickerMessage(ctx, render);
}

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
  const buttons = displayVerbosityModeOptions.map((mode) =>
    Markup.button.callback(
      mode === marked ? `${t(`${i18nGroup}.mode.${mode}`)} ✓` : t(`${i18nGroup}.mode.${mode}`),
      `${callbackPrefix}_${mode}`,
    ),
  );
  return Markup.inlineKeyboard(buttons, { columns: displayVerbosityModeOptions.length });
}

/**
 * @description Persist a new thinking mode for `key` and apply it best-effort to
 * the live reasoning stream (it always governs the NEXT one). Shared by the
 * `/thinking <mode>` direct form and the `think_<mode>` callback so the two
 * paths can never diverge.
 */
async function applyThinkingMode(key: SessionKey, mode: DisplayVerbosityMode): Promise<void> {
  await state.setDisplayPref(key, 'thinking', mode);
}

command('thinking', async (_ctx, key, parsed) => {
  // No backend gate (un-gated in S5): the pref drives both backends now —
  // OpenCode's thinking SSE render and Claude's scrape-chunk relay routing.
  const arg = parsed.argsText.toLowerCase();
  const current = state.getDisplayPrefs(key).thinking;

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
  await state.setDisplayPref(key, 'toolResults', mode);
}

command('tool_results', async (_ctx, key, parsed) => {
  // No backend gate (un-gated in S4): the pref drives both backends now —
  // OpenCode's `toolResult` SSE render and Claude's scrape-chunk relay routing.
  const arg = parsed.argsText.toLowerCase();
  const current = state.getDisplayPrefs(key).toolResults;

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
  await state.setDisplayPref(key, 'subagent', mode);
}

command('subagent', async (_ctx, key, parsed) => {
  const arg = parsed.argsText.toLowerCase();
  const current = state.getDisplayPrefs(key).subagent;

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

command('verbosity', async (_ctx, key, parsed) => {
  const arg = parsed.argsText.toLowerCase();

  if (arg) {
    // Normalization keeps the retired names (`detailed`/`brief`/`hide`/
    // `compact`) working as hidden aliases; the reply always names the NEW mode.
    const mode = normalizeDisplayVerbosityMode(arg);
    if (!mode) {
      await replyToThread(key, t('verbosity.invalid_mode', {
        mode: arg,
        valid: displayVerbosityModeOptions.join(', '),
      }));
      return;
    }
    await applyVerbosityLevel(key, mode);
    await replyToThread(key, t('verbosity.set_success', { mode: t(`verbosity.mode.${mode}`) }));
    return;
  }

  // No arg: show the current state (exact level, or "custom" with the three
  // values spelled out) + a button per level.
  const prefs = state.getDisplayPrefs(key);
  await replyToThread(
    key,
    t('verbosity.choose', { current: formatVerbosityCurrent(prefs) }),
    buildDisplayModeKeyboard('verbosity', 'verb', getUniformVerbosityLevel(prefs)),
  );
});

// Manually rename the CURRENT thread's session. Adapter-owned capability
// (optional method, like /model): OpenCode renames via `PATCH /session/:id`;
// Claude has no title concept and is told "not supported". Requires a live
// session — without one the user is told to start an agent first.
command('rename_session', async (_ctx, key, parsed) => {
  const adapter = getThreadAdapter(key);

  if (!adapter.renameSession) {
    await replyToThread(key, t('rename_session.unsupported_backend', { label: adapter.label }));
    return;
  }

  // Title is the whole text after the command, trimmed and capped to the same
  // length the auto-name snippet uses (single source of truth).
  const title = parsed.argsText.slice(0, sessionTitleSnippetMaxLength);
  if (!title) {
    await replyToThread(key, t('rename_session.usage'));
    return;
  }

  const err = await adapter.renameSession(key, title);
  if (err) {
    await replyToThread(key, err);
    return;
  }
  await replyToThread(key, t('rename_session.success', { title }));
  await updatePinnedStatus(key).catch(() => {});
});

/** The literal slash command forwarded to backends whose own CLI parses it. */
const compactCommandText = '/compact';

/** `adapter.name` of the raw-shell backend (see the `terminal` adapter). */
const terminalAdapterName = 'terminal';

/**
 * `adapter.name` of the OpenCode backend. Used only to decide whether the D3
 * maximally-complete-summary guidance must ride the per-invocation compaction
 * instruction: OpenCode bakes that guidance into its fork compaction prompt (so
 * it also covers auto/overflow compaction the bot can't reach), so the bot must
 * NOT re-append it there; every other (Claude) backend has no bot-controlled
 * prompt and needs it every time. See {@link getCompactionInstruction}.
 */
const openCodeAdapterName = 'opencode';

/**
 * @description Compose the per-invocation compaction instruction for a thread's
 * backend (D3 summary guidance + the loaded-skills guidance + the optional F2
 * closing section). The general guidance is skipped for OpenCode (baked in its
 * fork prompt) and appended for the Claude backends; the skills guidance is
 * skipped when the backend's own compaction prompt already gets it (an OpenCode
 * server running the bot's compaction plugin); the closing-section directive
 * rides only when requested.
 */
async function getCompactionInstruction(
  adapter: AgentAdapter,
  key: SessionKey,
  opts: { withClosingSection: boolean },
): Promise<string | undefined> {
  return buildCompactionInstruction({
    bakesSummaryGuidance: adapter.name === openCodeAdapterName,
    summaryGuidance: compactionSummaryGuidance,
    bakesSkillsGuidance: (await adapter.checkHasCompactionSkillsHook?.(key)) ?? false,
    skillsGuidance: compactionSkillsGuidance,
    closingSectionInstruction: opts.withClosingSection
      ? t('compact.closingSectionInstruction', {
          startMarker: compactionClosingStartMarker,
          endMarker: compactionClosingEndMarker,
        })
      : undefined,
  });
}

// ─── compaction orchestration (F1 tool + F2 idle) ───────────────────────────
//
// The manual `/compact` command reaches a real backend compaction directly (the
// handler below). The agent-triggered tool (F1) and the idle watchdog (F2) both
// funnel through the shared `runThreadCompaction` seam so the three triggers use
// ONE compaction path (plan 2026-09-14-self-compact-and-compact-on-idle).

/** F1 poll cadence while waiting for the current turn to finish before draining. */
const deferredCompactionPollMs = 3_000;

interface ThreadCompactionResult {
  ok: boolean;
  error?: string;
  /**
   * The extracted "Where we stopped" closing prose (F2), or null when absent.
   * ALWAYS null when {@link summary} is set — the block is a slice of the summary,
   * so printing both would duplicate it (§1.4).
   */
  closingSection?: string | null;
  /**
   * The full compaction summary to post into the topic, marker-stripped and ready
   * to send, or `null` when it must not be posted (the setting is off, the backend
   * streams its own, the route never produced one, or it could not be read).
   */
  summary?: string | null;
  /**
   * Context token counts the backend reported for the compaction, `null` when it
   * reports none (see {@link CompactionResult}). Both present ⇒ the completion
   * message names the numbers; otherwise it is the same sentence without them.
   */
  preTokens?: number | null;
  postTokens?: number | null;
}

/**
 * @description Resolve the `/compact` route for a thread's current backend — the
 * pure {@link getCompactCommandRoute} wrapped with the live adapter reading.
 * Every compaction entry point (the command, the seam, the F1 arm + drain, the
 * `/compact_on_idle` gate) asks the same question, so the three-line lookup lives
 * in ONE place rather than being spelled out at each of them.
 */
function getThreadCompactRoute(key: SessionKey): CompactCommandRoute {
  const adapter = getThreadAdapter(key);
  return getCompactCommandRoute({
    hasCompactContext: Boolean(adapter.compactContext),
    adapterName: adapter.name,
    terminalAdapterName,
  });
}

/**
 * Threads with a compaction IN FLIGHT (via {@link runThreadCompaction}). While a
 * key is here, the compaction's OWN output (some backends stream the summary
 * turn) must NOT count as thread activity — otherwise it would re-arm the idle
 * watchdog and mark a "completed turn", re-firing compaction on the next idle
 * with no real user activity (a loop). See {@link handleAgentOutput}.
 */
const threadsCompacting = new Set<string>();

/**
 * @description Is a bot-issued compaction in flight for `key`? The live reading
 * behind the typing indicator's `isCompacting` input (S3) — both the keep-alive
 * rule and the leak backstop's veto read it, so a compaction shows the native
 * "working" state for its whole duration instead of leaving the topic blank for
 * minutes. Reuses the EXISTING {@link threadsCompacting} set (already maintained
 * as the idle-watchdog loop guard) — no second piece of state to keep in step.
 */
function checkIsThreadCompacting(key: SessionKey): boolean {
  return threadsCompacting.has(keyToString(key));
}

/**
 * @description Shared execution seam for the compaction triggers. Resolves the
 * `/compact` route (same pure decision as the manual command), optionally
 * appends the F2 closing-section instruction, runs the REAL compaction, and — for
 * the closing-section case — lifts the appended section out of the generated
 * summary. Returns the outcome; the CALLER owns any topic message so each trigger
 * words it its own way (the operator-present narration vs the idle notice).
 *
 * Also the ONE place the typing indicator is started for a compaction (S3), so all
 * three triggers get it without each remembering to. It is deliberately NOT stopped
 * in the `finally`: dropping the key from {@link threadsCompacting} makes the
 * existing keep-alive rule self-stop on the loader's next tick, whereas an explicit
 * stop here could kill a loader a CONCURRENT prompt had armed.
 */
async function runThreadCompaction(
  key: SessionKey,
  opts: { withClosingSection: boolean },
): Promise<ThreadCompactionResult> {
  const adapter = getThreadAdapter(key);
  if (!adapter.checkIsActive(key)) return { ok: false, error: t('compact.start_agent_first') };
  const route = getThreadCompactRoute(key);
  if (route === 'notSupported') {
    return { ok: false, error: t('compact.unsupported_backend', { label: adapter.label }) };
  }

  // D3: every bot-issued compaction carries the maximally-complete-summary
  // guidance (baked in the OpenCode fork, appended for the Claude backends), plus
  // the F2 closing-section directive when requested.
  const instruction = await getCompactionInstruction(adapter, key, { withClosingSection: opts.withClosingSection });

  const kStr = keyToString(key);
  threadsCompacting.add(kStr);
  // S3: `threadsCompacting` is set FIRST, so the loader's very first keep-alive
  // check already sees the compaction and cannot self-stop on a topic that is
  // otherwise idle (which is exactly what a compacting OpenCode session looks like).
  startTypingLoader(key);
  try {
    if (route === 'forwardToAgent') {
      // tmux Claude: its TUI parses `/compact [instruction]` natively. Best-effort —
      // there is no completion signal to await, so no closing-section read here.
      const text = instruction ? `${compactCommandText} ${instruction}` : compactCommandText;
      await forwardPromptToAgent(key, adapter, text);
      return { ok: true, closingSection: null };
    }

    // adapterCompact: OpenCode / json-stream — a real, awaited compaction.
    // `compactContext` is present on this route by construction (it IS what
    // `getCompactCommandRoute` tested for), but the method is optional on the
    // interface, so the absence is answered rather than non-null-asserted.
    if (!adapter.compactContext) return { ok: false, error: t('compact.unsupported_backend', { label: adapter.label }) };
    const compaction = await adapter.compactContext(key, instruction);
    if (!compaction.ok) return { ok: false, error: compaction.error };

    const isWithSummary = checkShouldPostCompactionSummary({
      isEnabled: state.checkIsCompactSummaryEnabled(key),
      streamsOwnSummary: Boolean(adapter.streamsCompactionSummary),
      route,
    });
    // ONE read serves both consumers. The summary is a transcript / HTTP read, and
    // the closing section is a slice of the very same text.
    const summary = (isWithSummary || opts.withClosingSection) && adapter.getLatestCompactionSummary
      ? await adapter.getLatestCompactionSummary(key).catch(() => null)
      : null;
    // §1.4: with the full summary posted, the closing block would be a duplicate
    // slice of it — so it is not extracted at all, and every caller's "append the
    // block if present" check stays a plain check.
    const closingSection = !isWithSummary && opts.withClosingSection && summary
      ? extractCompactionClosingSection(summary)
      : null;
    return {
      ok: true,
      closingSection,
      summary: isWithSummary && summary ? stripCompactionClosingMarkers(summary) : null,
      preTokens: compaction.preTokens,
      postTokens: compaction.postTokens,
    };
  } finally {
    threadsCompacting.delete(kStr);
  }
}

/**
 * @description Run a bot-issued compaction the operator is PRESENT for — the
 * manual `/compact` command and the agent's `compact_conversation` drain — and
 * narrate it in the topic: the start notice BEFORE the wait, then the completion
 * report (with token counts when the backend gave any).
 *
 * The start notice used to be posted AFTER the wait returned, which read as "it is
 * starting now" when it was already over — and for the 1–3+ minutes in between the
 * topic showed nothing at all. Both triggers share this one body so the two can
 * never narrate a compaction differently.
 *
 * Narration is `adapterCompact`-ONLY. On the `forwardToAgent` route (the tmux
 * Claude backend) the TUI parses `/compact` and renders its own progress, and the
 * bot has no completion signal to await there — announcing "compacted" the instant
 * the text was typed in would be a claim the bot cannot back.
 */
async function runNarratedCompaction(key: SessionKey, route: CompactCommandRoute, logTag: string): Promise<void> {
  const isNarrated = route === 'adapterCompact';
  // The START notice also needs the session to be live (pure rule): the seam refuses
  // a dead session as its first act, and a "compacting…" ahead of that refusal is a
  // promise the very next message retracts. The seam still re-checks, so a session
  // lost right afterwards just reports the failure as before.
  if (checkShouldAnnounceCompactionStart({ route, isSessionActive: getThreadAdapter(key).checkIsActive(key) })) {
    await replyToThread(key, t('compact.started'));
  }

  // No closing section: the operator is right here, so there is nothing to recap
  // to a future reader of the topic.
  const result = await runThreadCompaction(key, { withClosingSection: false });
  if (!result.ok) {
    console.warn(`[${logTag}] ${keyToString(key)} compaction failed: ${result.error ?? 'unknown'}`);
    // Always surfaced, even on the drain, which used to only log: having just
    // announced a start, going silent would leave the operator waiting on a
    // compaction that already gave up.
    await replyToThread(key, result.error ?? t('compact.failed', { reason: 'unknown' }));
    return;
  }

  // Close the F2 fire guard. Not against an IMMEDIATE re-fire — the `command()`
  // wrapper already re-armed a fresh idle window for this thread — but against the
  // END of that window: without the stamp `lastTurnEndAt` would still be ahead of
  // `lastCompactionAt` there, so the watchdog would compact again with nothing new
  // to compress. Only on SUCCESS: stamping a compaction that never ran would
  // durably close the guard over a still-huge context.
  await state.setCompactIdleCompactedAt(key);

  if (!isNarrated) return;
  const { preTokens, postTokens } = result;
  await replyToThread(
    key,
    // Both counts or neither: one number alone says nothing about what was saved.
    typeof preTokens === 'number' && typeof postTokens === 'number'
      ? t('compact.done_tokens', { pre: formatTokenCount(preTokens), post: formatTokenCount(postTokens) })
      : t('compact.done'),
  );
  if (result.summary) await postCompactionSummary(key, result.summary);
}

/**
 * @description Post a compaction's FULL summary into the topic — the single poster
 * shared by all three triggers, each calling it after its own notice.
 *
 * Sent as PLAIN text with no `parse_mode`: this is freeform model prose, and one
 * stray backtick or asterisk in a Markdown/HTML send makes Telegram reject the
 * whole message, which would lose the summary entirely (§1.5). Long summaries are
 * SPLIT by the existing splitter, never truncated.
 *
 * Deliberately NOT routed through the agent-output path: that path stamps thread
 * activity and would re-arm the idle watchdog off the bot's own message — the loop
 * the `threadsCompacting` guard exists to prevent.
 */
async function postCompactionSummary(key: SessionKey, summary: string): Promise<void> {
  const chunks = splitMessage(`${t('compact.summaryHeader')}\n\n${summary}`, MAX_MESSAGE_LEN);
  for (const chunk of chunks) await replyToThread(key, chunk);
}

/**
 * Per-thread bookkeeping for the idle watchdog (F2) — the live TIMER only. The
 * three instants the watchdog reasons about (last activity / last turn end / last
 * compaction) live in the state store, which is their single source of truth: they
 * must survive a restart (the bot hot-reloads on every code change), and keeping
 * an in-memory duplicate would only let the two copies drift.
 */
interface ThreadCompactionState {
  idleTimer: NodeJS.Timeout | null;
}
const threadCompactionStates = new Map<string, ThreadCompactionState>();

function getThreadCompactionState(kStr: string): ThreadCompactionState {
  let existing = threadCompactionStates.get(kStr);
  if (!existing) {
    existing = { idleTimer: null };
    threadCompactionStates.set(kStr, existing);
  }
  return existing;
}

/** F1: threads whose agent asked (via the MCP tool) to compact when the turn ends. */
const deferredCompactionArmed = new Set<string>();
const deferredCompactionPollTimers = new Map<string, NodeJS.Timeout>();

/**
 * Human wording for the arm-kind the idle decision reports, for the diagnostic log
 * only (log text, so it stays out of `i18n.ts` — never user-facing).
 */
const idleArmKindLabels: Record<IdleCompactionArmKind, string> = {
  fullWindow: 'full window',
  remainder: 'remainder',
  overdue: 'overdue (staggered)',
};

/**
 * @description Re-arm the F2 idle timer for a thread on REAL activity (a user
 * message / command, a forwarded prompt, or agent output). Stamps the persisted
 * activity instant, so the countdown restarts from NOW — that is what makes this
 * different from {@link rearmThreadIdleTimer}, which must not move the stamp. The
 * feature's OWN notice is sent via `replyToThread`, which does NOT call this, so
 * the notice cannot re-arm the watchdog into a loop.
 */
function noteThreadActivity(key: SessionKey): void {
  armThreadIdleTimer(key, { isRealActivity: true });
}

/**
 * @description Re-arm the F2 idle timer for a session the bot just RE-ADOPTED
 * after a restart. A restart is not activity in the topic, so this deliberately
 * does NOT stamp the activity instant: the timer is armed from the PERSISTED one,
 * i.e. on the REMAINDER of the 55-minute window (or a staggered short delay when
 * the thread is already overdue). Arming the full window here — what the reattach
 * used to do by calling {@link noteThreadActivity} — meant that a bot restarting
 * more often than every 55 minutes (normal in hot-reload development) never let
 * any topic reach the threshold.
 */
function rearmThreadIdleTimer(key: SessionKey): void {
  armThreadIdleTimer(key, { isRealActivity: false });
}

/**
 * Shared arming core behind {@link noteThreadActivity} and
 * {@link rearmThreadIdleTimer} — one body so the two entry points can only differ
 * in whether they count as activity. Arms only when the feature is enabled for the
 * thread, an agent session is active, no compaction is in flight, AND the
 * user-latch is NOT spent (D2): once an idle-compaction has fired this user-active
 * period the thread stays latched — agent output resets nothing, and only a
 * genuine USER message (via {@link noteThreadUserActivity}) clears the latch. That
 * latch, being persisted, is also what stops a restart from re-firing.
 */
function armThreadIdleTimer(key: SessionKey, opts: { isRealActivity: boolean }): void {
  const kStr = keyToString(key);
  // A compaction in flight is NOT user/turn activity — skip so the compaction's
  // own streamed summary (some backends) can't re-arm the watchdog into a loop.
  if (threadsCompacting.has(kStr)) return;
  const compactionState = getThreadCompactionState(kStr);
  if (compactionState.idleTimer) {
    clearTimeout(compactionState.idleTimer);
    compactionState.idleTimer = null;
  }
  if (!state.checkIsCompactOnIdleEnabled(key)) return;
  if (!getThreadAdapter(key).checkIsActive(key)) return;
  const now = Date.now();
  // Stamp AFTER the enabled/active guards (a disabled or session-less topic has no
  // countdown to measure) but BEFORE the latch guard: a latched thread still has
  // activity worth recording — the latch only suppresses the TIMER.
  if (opts.isRealActivity) state.noteCompactIdleActivity(key, now);
  // D2: a spent latch means idle-compaction already fired this user-active period
  // — do NOT re-arm until a genuine USER message clears the latch.
  if (state.checkIsCompactIdleLatched(key)) return;
  const { lastActivityAt } = state.getCompactIdleTracking(key);
  const { delayMs, kind } = getIdleCompactionArmDecision({ threadKeyString: kStr, lastActivityAt, now });
  if (!opts.isRealActivity) {
    // Session-start / re-adopt only (once per thread per boot, or per manual start) —
    // was the other blind spot: nothing showed whether an adopted thread got re-armed
    // and for how long. Deliberately NOT logged for real activity, which runs on
    // every output chunk and would flood. The kind is the one the decision REPORTED —
    // re-deriving it here would let the log name a case the timer is not in.
    console.log(`[compact-on-idle] ${kStr} armed on session start: ${idleArmKindLabels[kind]}, ${(delayMs / 60_000).toFixed(1)} min`);
  }
  const timer = setTimeout(() => {
    compactionState.idleTimer = null;
    void withThreadLocale(key, () => onIdleCompactionTimerFired(key));
  }, delayMs);
  timer.unref?.();
  compactionState.idleTimer = timer;
}

/**
 * @description A genuine USER message (text / voice / file) or a fresh session
 * start (D2): clear the spent idle-compaction latch so the next idle period can
 * compact again, THEN reset/arm the idle timer. Distinct from
 * {@link noteThreadActivity} — which agent output and bot-initiated forwards also
 * call — because those must NEVER re-arm the latch, only a real user does.
 */
function noteThreadUserActivity(key: SessionKey): void {
  if (state.checkIsCompactIdleLatched(key)) {
    void state.setCompactIdleLatched(key, false);
  }
  noteThreadActivity(key);
}

/**
 * Mark that an agent turn produced output — there is now something to compress.
 * PERSISTED: the fire guard compares this against the last compaction, and after a
 * restart an in-memory-only stamp read back as 0, which read as "nothing to
 * compress" and silently disabled the feature in every quiet topic.
 */
function markThreadTurnProducedOutput(key: SessionKey): void {
  const kStr = keyToString(key);
  if (threadsCompacting.has(kStr)) return; // the compaction's own output isn't a turn
  state.noteCompactIdleTurnEnd(key);
}

/** Clear all compaction timers/arms for a thread (session teardown / unbind). */
function clearThreadCompaction(key: SessionKey): void {
  const kStr = keyToString(key);
  const compactionState = threadCompactionStates.get(kStr);
  if (compactionState?.idleTimer) clearTimeout(compactionState.idleTimer);
  threadCompactionStates.delete(kStr);
  // Drop the persisted instants too, so the NEXT session in this topic starts with
  // no history and therefore gets the FULL idle window — which is why the fresh-start
  // path needs no special case (do not "fix" it by adding one).
  void state.clearCompactIdleTracking(key);
  deferredCompactionArmed.delete(kStr);
  const pollTimer = deferredCompactionPollTimers.get(kStr);
  if (pollTimer) clearTimeout(pollTimer);
  deferredCompactionPollTimers.delete(kStr);
  reAskedQuestionOptions.delete(kStr);
}

/** The F2 idle timer fired: re-check the guard, then compact once (D1/D2). */
async function onIdleCompactionTimerFired(key: SessionKey): Promise<void> {
  const kStr = keyToString(key);
  const adapter = getThreadAdapter(key);
  const isEnabled = state.checkIsCompactOnIdleEnabled(key);
  const isSessionActive = adapter.checkIsActive(key);
  // A pending interactive question makes the session report busy, but it is
  // idle-WAITING, not running a turn — D1 treats that as a FIRE condition (reject
  // + compact + re-ask), so exclude it from the "busy" the guard blocks on. A
  // genuinely running turn still blocks.
  const hasPendingQuestion = pendingQuestions.has(kStr);
  const isBusy = adapter.checkIsBusy?.(key) ?? false;
  const isBusyForRealTurn = checkIsBusyForRealTurn({ isBusy, hasPendingQuestion });
  const isLatched = state.checkIsCompactIdleLatched(key);
  // Both instants come from the store, so a restart no longer erases the evidence
  // that this session has an un-compacted turn (the bug: two in-memory zeros made
  // `0 > 0` false, and D2's no-reschedule rule then left the feature dead).
  const { lastTurnEndAt, lastCompactionAt } = state.getCompactIdleTracking(key);
  const hasCompletedTurnSinceCompaction = lastTurnEndAt > lastCompactionAt;

  if (!checkShouldFireIdleCompaction({ isEnabled, isSessionActive, isBusyForRealTurn, isLatched, hasCompletedTurnSinceCompaction })) {
    // Log WHICH condition blocked it: this branch is the feature's blind spot —
    // it returned silently, which is why nothing in any log showed the watchdog
    // was even trying. At most once per armed timer, so it cannot flood.
    const blockers = [
      !isEnabled && 'disabled',
      !isSessionActive && 'no active session',
      isBusyForRealTurn && 'busy with a real turn',
      isLatched && 'latched (D2)',
      !hasCompletedTurnSinceCompaction && 'nothing to compress',
    ].filter((blocker): blocker is string => typeof blocker === 'string');
    console.log(`[compact-on-idle] ${kStr} timer fired but skipped: ${blockers.join(', ')}`);
    // D2: no reschedule. A real running turn will emit output that resets the
    // timer via `noteThreadActivity`; every other miss re-arms only on the next
    // genuine USER message (which clears the latch).
    return;
  }

  // D2: latch the thread the instant the fire is decided (BEFORE any output) and
  // persist it, so a bot restart can't re-fire and no second compaction runs this
  // user-active period. Stamp `lastCompactionAt` too so the re-fire guard holds
  // even if the compaction itself runs long.
  void state.setCompactIdleLatched(key, true);
  // Awaited (unlike the latch): the stamp must be in place BEFORE the compaction
  // starts, since it is what closes the "has an un-compacted turn" guard.
  await state.setCompactIdleCompactedAt(key);

  // D1: a pending question at idle → reject it server-side to UNBLOCK the turn
  // (reusing each backend's abort-error swallow via rejectQuestion + SIGINT),
  // remember it, drop the bot-side pending state + its now-stale buttons, then
  // RE-ASK it after the compaction with real buttons that feed a fresh prompt.
  let savedQuestion: PendingQuestionState | null = null;
  if (hasPendingQuestion) {
    savedQuestion = pendingQuestions.get(kStr) ?? null;
    const staleQuestionMessageId = savedQuestion?.messageId ?? null;
    adapter.rejectQuestion?.(key);
    adapter.sendSignal(key, 'SIGINT');
    clearPendingQuestion(key);
    if (staleQuestionMessageId !== null) {
      await deleteThreadMessage(key, staleQuestionMessageId).catch(() => {});
    }
  }

  const result = await runThreadCompaction(key, { withClosingSection: true });
  if (!result.ok) {
    console.warn(`[compact-on-idle] ${kStr} compaction failed: ${result.error ?? 'unknown'}`);
    // The compaction failed but the question is already rejected — re-ask it so
    // the user isn't left without the pending decision (no notice: nothing was
    // compacted).
    await postIdleCompactionResult(key, { noticeText: null, closingSection: null, summary: null }, savedQuestion);
    return;
  }
  await postIdleCompactionResult(
    key,
    {
      noticeText: t('compactOnIdle.notice'),
      closingSection: result.closingSection ?? null,
      summary: result.summary ?? null,
    },
    savedQuestion,
  );
}

/**
 * @description Per-thread option labels of an idle-compaction RE-ASKED question
 * (D1), keyed by {@link SessionKey} string. A `reask_<idx>` tap forwards the
 * matching label to the (now compacted) session as a FRESH prompt — the original
 * question request was rejected server-side, so it cannot be answered any more.
 * In-memory only: after a restart the buttons are simply inert ("no pending
 * question"), which is safe.
 */
const reAskedQuestionOptions = new Map<string, string[]>();

/**
 * @description Build the tappable keyboard for an OpenCode question's options.
 *
 * The bot offers a question's options twice with different callback wiring —
 * the live answer buttons (`qa_<qIdx>_<optIdx>`) and the idle-compaction re-ask
 * buttons (`reask_<optIdx>`) — so `buildCallbackId` is the only thing that
 * varies. Labels are passed through untouched: the button width cap and its
 * elision are Telegram's, and belong to the connector's
 * {@link buildOptionsKeyboard}, not here.
 *
 * `buildCallbackId` must produce an id the matching `bot.action` regex accepts.
 * The index it receives is the 0-based position in `question.options`; the body
 * shows that option as `index + 1`.
 */
export function buildQuestionOptionsKeyboard(
  question: OpenCodeQuestion,
  buildCallbackId: (optionIndex: number) => string,
): InlineKeyboardMarkup | undefined {
  return buildOptionsKeyboard(
    question.options.map((option, optionIndex) => ({
      id: buildCallbackId(optionIndex),
      label: option.label,
    })),
  );
}

/**
 * @description Attach an optional inline keyboard to a {@link replyToThread}
 * `extra`.
 *
 * One place owns the `reply_markup` spelling, because getting it wrong fails
 * SILENTLY: the message still sends, just with no buttons, and Telegram reports
 * nothing. `base` carries whatever else the send needs (a `parse_mode`).
 */
export function buildKeyboardExtra(
  keyboard: InlineKeyboardMarkup | undefined,
  base: Record<string, unknown> = {},
): Record<string, unknown> {
  return keyboard ? { ...base, reply_markup: keyboard } : { ...base };
}

/**
 * @description Build the RE-ASK inline keyboard for an idle-compaction pending
 * question (D1) and record its option labels so a `reask_<idx>` tap can forward
 * the chosen label as a fresh prompt.
 */
function buildReAskKeyboard(
  key: SessionKey,
  question: OpenCodeQuestion,
): InlineKeyboardMarkup | undefined {
  reAskedQuestionOptions.set(keyToString(key), question.options.map((opt) => opt.label));
  return buildQuestionOptionsKeyboard(question, (optionIndex) => `reask_${optionIndex}`);
}

/**
 * @description Post the idle-compaction outcome (D1/D2) as SEPARATE messages in
 * the §1.4 order: notice (+ closing section when no full summary) → the full
 * summary → the RE-ASKED question with its option buttons, LAST.
 *
 * The three used to be one joined message. They are split because the re-asked
 * question carries inline buttons the operator must be able to reach: glued behind
 * a full summary they end up buried under a wall of text, and a long summary does
 * not fit one Telegram message at all. The ORDER is what keeps the buttons the last
 * thing in the topic.
 *
 * `parts.noticeText` is `null` on a compaction failure (re-ask only, no notice).
 * No-op when there is nothing at all to say.
 */
async function postIdleCompactionResult(
  key: SessionKey,
  parts: { noticeText: string | null; closingSection: string | null; summary: string | null },
  savedQuestion: PendingQuestionState | null,
): Promise<void> {
  const question = savedQuestion?.data.questions[savedQuestion.currentIndex];
  const questionText = question
    ? [
        t('compactOnIdle.pendingQuestionReask'),
        question.header ? `${question.header}\n${question.question}` : question.question,
      ].join('\n\n')
    : null;

  const plan = buildIdleCompactionNoticeParts({ ...parts, questionText });
  if (plan.notice) await replyToThread(key, plan.notice);
  if (plan.summary) await postCompactionSummary(key, plan.summary);
  // The keyboard is built HERE (not while planning): it also records the option
  // labels a `reask_<idx>` tap resolves against, which must not happen for a
  // question that is never posted.
  if (plan.question && question) await replyToThread(key, plan.question, buildKeyboardExtra(buildReAskKeyboard(key, question)));
}

/**
 * @description F1: arm a "compact when the current turn finishes" request from
 * the agent's `compact_conversation` MCP tool. Returns a short status the tool
 * relays to the agent. Refuses when there is no active agent session (nothing to
 * compact). The drain (below) runs the plain compaction once the session idles.
 */
function armDeferredCompaction(key: SessionKey): { ok: boolean; message: string } {
  const adapter = getThreadAdapter(key);
  if (!adapter.checkIsActive(key)) {
    return { ok: false, message: 'No active agent session in this topic — nothing to compact.' };
  }
  if (getThreadCompactRoute(key) === 'notSupported') {
    return { ok: false, message: 'This session type cannot be compacted.' };
  }
  deferredCompactionArmed.add(keyToString(key));
  scheduleDeferredCompactionPoll(key);
  return { ok: true, message: 'Compaction is armed — it will run automatically when this turn finishes.' };
}

function scheduleDeferredCompactionPoll(key: SessionKey): void {
  const kStr = keyToString(key);
  if (!deferredCompactionArmed.has(kStr)) return;
  if (deferredCompactionPollTimers.has(kStr)) return; // already polling
  const timer = setTimeout(() => {
    deferredCompactionPollTimers.delete(kStr);
    void withThreadLocale(key, () => tickDeferredCompaction(key));
  }, deferredCompactionPollMs);
  timer.unref?.();
  deferredCompactionPollTimers.set(kStr, timer);
}

async function tickDeferredCompaction(key: SessionKey): Promise<void> {
  const kStr = keyToString(key);
  if (!deferredCompactionArmed.has(kStr)) return;
  const adapter = getThreadAdapter(key);
  if (!adapter.checkIsActive(key)) {
    deferredCompactionArmed.delete(kStr);
    return;
  }
  if (adapter.checkIsBusy?.(key)) {
    scheduleDeferredCompactionPoll(key); // still mid-turn — keep waiting
    return;
  }
  deferredCompactionArmed.delete(kStr);
  // §1.3: the agent only calls `compact_conversation` because the operator asked
  // it to, so the operator IS present and waiting — this compaction is narrated
  // exactly like the manual one (it used to post nothing at all). The shared body
  // also owns the `lastCompactionAt` stamp that keeps F2 from re-firing on top of
  // it, in this process or after a restart.
  await runNarratedCompaction(key, getThreadCompactRoute(key), 'compact-tool');
}

/**
 * @description Shared core of the `/compact_on_idle` command + its inline
 * callback. Regular topic → the per-thread override; General topic → the
 * instance-wide default. Applies the toggle, confirms, and re-arms/disarms the
 * idle watchdog for a regular topic.
 */
async function applyCompactOnIdle(key: SessionKey, isGeneral: boolean, enabled: boolean): Promise<void> {
  const stateWord = enabled ? t('compactOnIdle.on') : t('compactOnIdle.off');
  if (isGeneral) {
    await state.setCompactOnIdleGlobalDefault(enabled);
    await replyToThread(key, t('compactOnIdle.setGlobal', { state: stateWord }));
    return;
  }
  await state.setCompactOnIdleOverride(key, enabled);
  await replyToThread(key, t('compactOnIdle.setThisTopic', { state: stateWord }));
  if (enabled) noteThreadActivity(key);
  else {
    const compactionState = threadCompactionStates.get(keyToString(key));
    if (compactionState?.idleTimer) {
      clearTimeout(compactionState.idleTimer);
      compactionState.idleTimer = null;
    }
  }
}

/** Build the `/compact_on_idle` picker keyboard (Enable / Disable, ✓ on current). */
function buildCompactOnIdleKeyboard(isEnabled: boolean) {
  return Markup.inlineKeyboard([
    Markup.button.callback(t('compactOnIdle.enableButton') + (isEnabled ? ' ✓' : ''), 'coi_on'),
    Markup.button.callback(t('compactOnIdle.disableButton') + (!isEnabled ? ' ✓' : ''), 'coi_off'),
  ]);
}

/**
 * @description Apply the `/compact_summary` setting and RETURN the confirmation
 * text — the single write path behind the command and its picker buttons, so the
 * two can never drift. Regular topic → the per-thread override; General topic →
 * the instance-wide default.
 *
 * Nothing to arm or cancel afterwards (unlike `/compact_on_idle`, which owns a
 * timer): the toggle is read at the moment a compaction finishes.
 */
async function applyCompactSummary(key: SessionKey, isGeneral: boolean, enabled: boolean): Promise<string> {
  const stateWord = enabled ? t('compactSummary.on') : t('compactSummary.off');
  if (isGeneral) {
    await state.setCompactSummaryGlobalDefault(enabled);
    return t('compactSummary.setGlobal', { state: stateWord });
  }
  await state.setCompactSummaryOverride(key, enabled);
  return t('compactSummary.setThisTopic', { state: stateWord });
}

/** Build the `/compact_summary` picker keyboard (Enable / Disable, ✓ on current). */
function buildCompactSummaryKeyboard(isEnabled: boolean) {
  return Markup.inlineKeyboard([
    Markup.button.callback(t('compactSummary.enableButton') + (isEnabled ? ' ✓' : ''), 'csum_on'),
    Markup.button.callback(t('compactSummary.disableButton') + (!isEnabled ? ' ✓' : ''), 'csum_off'),
  ]);
}

/**
 * @description Append the shared `/auto_continue_limits` pointer to a usage-limit
 * arming notice. ONE key appended at ONE place, so the reset-time notice and the
 * "retrying in N min" fallback can never drift apart (the `effort.current_hint`
 * block shared by both `/model`-set replies is the same pattern). No inline
 * keyboard is needed: Telegram auto-links a bare command written in message text.
 */
function appendAutoContinueLimitsHint(noticeText: string): string {
  return `${noticeText}\n\n${t('autoContinueLimits.noticeHint')}`;
}

/**
 * @description Apply the `/auto_continue_limits` setting and RETURN the
 * confirmation text — the single write path behind the command and its picker
 * buttons, so the two can never drift. The caller decides delivery (the command
 * replies; the picker edits its own message into the confirmation).
 *
 * Regular topic → the per-thread override; General topic → the instance-wide
 * default. Turning it OFF for a topic also drops that topic's armed resume:
 * staying armed after «Disable» would contradict the setting. Unlike
 * `/compact_on_idle` there is no timer to re-arm — the toggle is read at the
 * moment a limit error arrives.
 */
async function applyAutoContinueLimits(key: SessionKey, isGeneral: boolean, enabled: boolean): Promise<string> {
  const stateWord = enabled ? t('autoContinueLimits.on') : t('autoContinueLimits.off');
  if (isGeneral) {
    await state.setAutoContinueOnLimitGlobalDefault(enabled);
    return t('autoContinueLimits.setGlobal', { state: stateWord });
  }
  await state.setAutoContinueOnLimitOverride(key, enabled);
  if (!enabled) {
    const isLimitWaitArmed = getArmedLimitRetryFireAt(key) !== null;
    cancelApiRetry(key);
    // Nothing resumes this wait any more: its request must not be woken into the same limit.
    if (isLimitWaitArmed) await requestWakeUpEngine?.stopWakingForLimitWait(key);
  }
  return t('autoContinueLimits.setThisTopic', { state: stateWord });
}

/**
 * @description Build the `/auto_continue_limits` picker keyboard: Enable / Disable
 * with `✓` on the current value, plus a «skip once» row ONLY while a limit resume
 * is actually armed for the topic. A skip row with nothing to skip would be a dead
 * end (same reasoning as the `/model` re-render never offering an empty list).
 */
function buildAutoContinueLimitsKeyboard(isEnabled: boolean, armedFireAt: number | null) {
  const rows = [[
    Markup.button.callback(t('autoContinueLimits.enableButton') + (isEnabled ? ' ✓' : ''), 'acl_on'),
    Markup.button.callback(t('autoContinueLimits.disableButton') + (!isEnabled ? ' ✓' : ''), 'acl_off'),
  ]];
  if (armedFireAt !== null) {
    rows.push([
      Markup.button.callback(t('autoContinueLimits.skipButton'), buildSkipArmedRetryCallbackData(armedFireAt)),
    ]);
  }
  return Markup.inlineKeyboard(rows);
}

// `/auto_continue_limits` — toggle waiting out a usage/session limit and resuming by
// itself. Regular topic → per-thread override; General → the instance-wide
// default. Bare → an Enable/Disable picker (✓ on current) plus a «skip once» row
// while a resume is armed. Deliberately NOT gated on an adapter/session (unlike
// `/compact_on_idle`): a limit can hit any topic at any time, and the operator must
// be able to set the preference before that.
command('auto_continue_limits', async (ctx, key) => {
  const arg = ctx.message.text.split(/\s+/).slice(1).join(' ').trim().toLowerCase();
  const isGeneral = checkIsGeneral(key);

  if (arg === 'on' || arg === 'off') {
    await replyToThread(key, await applyAutoContinueLimits(key, isGeneral, arg === 'on'));
    return;
  }

  const isEnabled = isGeneral
    ? state.getAutoContinueOnLimitGlobalDefault()
    : state.checkIsAutoContinueOnLimitEnabled(key);
  const stateWord = isEnabled ? t('autoContinueLimits.on') : t('autoContinueLimits.off');
  const title = isGeneral
    ? t('autoContinueLimits.titleGeneral', { state: stateWord })
    : t('autoContinueLimits.title', { state: stateWord });
  await replyToThread(key, title, buildAutoContinueLimitsKeyboard(isEnabled, getArmedLimitRetryFireAt(key)));
});

// `/compact` — shrink the agent's context. BOT-OWNED, because "forward the text
// and hope" only works for a backend that parses slash commands itself: OpenCode's
// prompt transport does not, so the literal `/compact` used to reach the model as
// an ordinary prompt and burn a whole turn without compacting anything. The
// three-way decision is the pure `getCompactCommandRoute`.
command('compact', async (_ctx, key) => {
  const route = getThreadCompactRoute(key);

  // A raw shell has no context to compact — and typing `/compact` into it would
  // just run a meaningless command. Answered from the route HERE rather than from
  // the seam's own `notSupported` result, because the seam checks session liveness
  // first: a terminal topic with no live shell would otherwise be told to start an
  // agent instead of that the backend cannot be compacted.
  if (route === 'notSupported') {
    await replyToThread(key, t('compact.unsupported_backend', { label: getThreadAdapter(key).label }));
    return;
  }

  // EXECUTION goes through the shared seam (which also carries the D3 summary
  // guidance). Dispatching inline here instead was a real defect: only
  // `runThreadCompaction` adds the thread to `threadsCompacting`, so the summary the
  // manual compaction produced counted as a TURN, pushing `lastTurnEndAt` back ahead
  // of the compaction stamp — and one idle window later the watchdog compacted an
  // already-compacted context.
  await runNarratedCompaction(key, route, 'compact');
});

// `/compact_on_idle` — toggle auto-compaction after ~55 min idle. Regular topic
// → per-thread override; General → the instance-wide default. Bare → an
// Enable/Disable picker (✓ on current). Only meaningful for an agent topic with
// an active session (terminal / unbound → the "nothing to compact" reply).
command('compact_on_idle', async (_ctx, key, parsed) => {
  const arg = parsed.args.join(' ').toLowerCase();
  const isGeneral = checkIsGeneral(key);

  if (!isGeneral) {
    if (!getThreadAdapter(key).checkIsActive(key) || getThreadCompactRoute(key) === 'notSupported') {
      await replyToThread(key, t('compactOnIdle.unsupported'));
      return;
    }
  }

  if (arg === 'on' || arg === 'off') {
    await applyCompactOnIdle(key, isGeneral, arg === 'on');
    return;
  }

  const isEnabled = isGeneral
    ? state.getCompactOnIdleGlobalDefault()
    : state.checkIsCompactOnIdleEnabled(key);
  const stateWord = isEnabled ? t('compactOnIdle.on') : t('compactOnIdle.off');
  const title = isGeneral
    ? t('compactOnIdle.titleGeneral', { state: stateWord })
    : t('compactOnIdle.title', { state: stateWord });
  await replyToThread(key, title, buildCompactOnIdleKeyboard(isEnabled));
});

// `/compact_summary` — toggle writing the agent's FULL compaction summary into the
// topic. Regular topic → per-thread override; General → the instance-wide default.
// Bare → an Enable/Disable picker (✓ on current). Deliberately NOT gated on an
// active session (unlike `/compact_on_idle`, which arms a timer): this one is read
// when a compaction finishes, so setting it in a quiet or not-yet-started topic is
// meaningful. Only a raw shell is refused — it has no context to compact.
command('compact_summary', async (ctx, key) => {
  const arg = ctx.message.text.split(/\s+/).slice(1).join(' ').trim().toLowerCase();
  const isGeneral = checkIsGeneral(key);

  if (!isGeneral && getThreadCompactRoute(key) === 'notSupported') {
    await replyToThread(key, t('compactSummary.unsupported'));
    return;
  }

  if (arg === 'on' || arg === 'off') {
    await replyToThread(key, await applyCompactSummary(key, isGeneral, arg === 'on'));
    return;
  }

  const isEnabled = isGeneral
    ? state.getCompactSummaryGlobalDefault()
    : state.checkIsCompactSummaryEnabled(key);
  const stateWord = isEnabled ? t('compactSummary.on') : t('compactSummary.off');
  const title = isGeneral
    ? t('compactSummary.titleGeneral', { state: stateWord })
    : t('compactSummary.title', { state: stateWord });
  await replyToThread(key, title, buildCompactSummaryKeyboard(isEnabled));
});

/**
 * @description Build the agent-picker keyboard.
 *
 * One callback button per available adapter (2 per row); the adapter whose
 * name matches `currentName` carries a `✓` marker. Shared by the `/start` +
 * post-bind welcome buttons (initial render) and the `agent_<name>` callback
 * (re-render after a press) so the marker can never drift between the two
 * (B16, mirrors B12).
 */
function buildAgentKeyboard(
  available: ReadonlyArray<{ name: string; label: string }>,
  currentName: string,
) {
  const buttons = available.map(a =>
    Markup.button.callback(a.name === currentName ? `${a.label} ✓` : a.label, `agent_${a.name}`),
  );
  return Markup.inlineKeyboard(buttons, { columns: 2 });
}

/** Max chars of a session title rendered on an inline resume button. */
const sessionButtonTitleMaxLength = 40;

/**
 * @description Shared `/sessions` (and `/resume` synonym) handler.
 *
 * Lists resumable sessions for the thread's bound folder as BOTH numbered
 * text and tappable inline buttons, then arms session-pick mode so a bare
 * digit reply resumes the matching session. Guards mirror the `resume_<idx>`
 * button: topical-thread-only + binding required. Reused by the `/sessions`
 * and `/resume` commands and the `open_sessions` inline button so the picker
 * source stays single-sourced.
 */
async function handleSessionsList(key: SessionKey): Promise<void> {
  if (checkIsGeneral(key)) {
    await replyToThread(key, t('cb.resume_only_topical'));
    return;
  }
  if (!state.getBinding(key)) {
    const subdirs = listAvailableSubdirs(ENV.workRoot);
    const extra = buildBindKeyboard(subdirs, 0, BIND_PAGE_SIZE, !!state.getBinding(key));
    await replyToThread(key, t('thread.no_binding'), extra);
    return;
  }

  // Guarded by the `!state.getBinding` early-return above, so workDir is
  // non-null here; the explicit check keeps the no-fallback contract honest.
  const workDirDecision = getWorkDirStartDecision(key);
  if (!workDirDecision.ok) {
    await replyToThread(key, workDirDecision.message);
    return;
  }
  const workDir = workDirDecision.workDir;
  const adapter = getThreadAdapter(key);
  let sessions: AgentSession[];
  try {
    sessions = await adapter.getSessions(key, workDir);
  } catch (e) {
    console.error('[Bot] getSessions:', e);
    await replyToThread(key, t('session.load_failed'));
    return;
  }

  if (sessions.length === 0) {
    await replyToThread(key, t('session.none'));
    return;
  }

  // Audit S4 / #7: stash the full id list per thread so the `resume_<idx>`
  // callback (and the digit reply) can recover the full id — Telegram's
  // callback_data cap would otherwise truncate long OpenCode session ids.
  const shown = sessions.slice(0, sessionsDisplayLimit);
  const kStr = keyToString(key);
  threadSessionLists.set(kStr, shown.map(s => s.id));
  awaitingSessionSelection.add(kStr);

  const lines = [t('session.list_header', { label: adapter.label })];
  const buttons = shown.map((s, idx) => {
    const timeAgo = formatTimeAgo(s.updatedAt);
    const title = (s.title || s.id).slice(0, sessionButtonTitleMaxLength);
    lines.push(`${idx + 1}. ${title} (${timeAgo})`);
    return Markup.button.callback(`${title} (${timeAgo})`, `resume_${idx}`);
  });
  lines.push('');
  lines.push(t('session.list_footer', { max: shown.length }));

  await replyToThread(key, lines.join('\n'), Markup.inlineKeyboard(buttons, { columns: 1 }));
}

/**
 * @description Resume the session at `idx` in the thread's last shown list.
 *
 * Core shared by the `resume_<idx>` inline button and the digit-reply path.
 * Recovers the full session id from `threadSessionLists`; if the cache was
 * lost (bot restarted between showing the list and the pick), reports it
 * via `onExpired`. Returns the user-facing result message to send, or
 * `null` when `onExpired` already handled the stale-cache case.
 */
async function resumeSessionByIndex(
  key: SessionKey,
  idx: number,
  onExpired: () => Promise<void>,
): Promise<string | null> {
  const list = threadSessionLists.get(keyToString(key));
  if (!list || idx < 0 || idx >= list.length) {
    await onExpired();
    return null;
  }
  const sessionId = list[idx];
  // Pick-mode is armed only by `handleSessionsList` (binding-gated), but a
  // binding can vanish (/unbind) between listing and picking — resume must
  // never run against an unbound thread (no WORK_ROOT fallback).
  const workDirDecision = getWorkDirStartDecision(key);
  if (!workDirDecision.ok) return workDirDecision.message;
  const workDir = workDirDecision.workDir;
  const adapter = getThreadAdapter(key);
  markNeedsNewMessage(key);
  try {
    // The ONLY resume path that posts the "last N messages" context block —
    // silent re-attach (bot restart) and crash recovery must stay quiet.
    await adapter.resumeSession(key, workDir, sessionId, { isWithRecentContext: true });
    // Another session took over this topic; it does not know the open request.
    cancelConversationRequest(key);
    // Persist the PICKED id — without this the next restart re-attaches to
    // whatever id the last fresh start wrote, silently dropping the user's
    // pick (live incident 2026-06-10).
    await persistAdapterSessionIds(key, adapter, state);
    // Stamp "now" as the start time: this is when the thread began using the
    // picked session (the original transcript's creation time isn't cheaply
    // recoverable). The agent row exists (persisted above), so the merge lands.
    await state.setAgentStartedAt(key, formatIsoLocalOffset(Date.now()));
    return t('session.resumed');
  } catch (e) {
    return t('session.resume_failed', { error: e instanceof Error ? e.message : String(e) });
  }
}

command(['sessions', 'resume'], (_ctx, key) => handleSessionsList(key));

/**
 * @description `/quit-all` — kill every active agent across every thread.
 *
 * General-only because it's a workspace-wide operation that's easy to
 * fire by mistake; restricting to General + needing an explicit command
 * matches the «admin-style» surface (see `/doctor`, `/status` global,
 * `/list`). Plan §20.x / §11 Этап 7.
 *
 * We walk persisted bindings (`state.listBindings`) rather than the
 * adapter's in-memory session map so we catch sessions whose adapter
 * instance has been replaced after a re-attach. For each, ask the
 * adapter that thread is configured for and stop only if it's active —
 * idempotent, so re-running is safe.
 */
command(['quit-all', 'quitall'], async (_ctx, key) => {
  if (!checkIsGeneral(key)) {
    await replyToThread(key, t('quit_all.general_only'));
    return;
  }

  // Same sweep semantics as `/quit`: kill any adapter that's actually
  // active for this key, not only the one the thread map points at —
  // otherwise a desynced thread (state says opencode but claude tmux is
  // running) gets counted as inactive and skipped. `attempted` /
  // `stopped` count *adapter sessions*, not threads, so the user-facing
  // summary preserves the "M of N" semantic when a stop call fails.
  let stopped = 0;
  let active = 0;
  for (const { key: bKey } of state.listBindings()) {
    cancelConversationRequest(bKey);
    const result = stopAllAdaptersFor(bKey);
    active += result.attempted;
    stopped += result.stopped.length;
    // Same release-for-good semantics as `/quit`, per swept thread.
    await state.clearAgentSessionIds(bKey);
  }

  if (active === 0) {
    await replyToThread(key, t('quit_all.none_active'));
    return;
  }
  await replyToThread(key, t('quit_all.summary', { stopped: String(stopped), total: String(active) }));
});

/**
 * Delay between the two `SIGINT`s that `/quit` sends to Claude CLI.
 *
 * Claude CLI debounces back-to-back Ctrl+C: the second press has to
 * land AFTER the first one has been rendered ("press Ctrl+C again to
 * exit") but BEFORE the prompt clears. 250ms is comfortably inside
 * that window on every machine we've tried — tighter values
 * occasionally collapse both presses into a single keystroke.
 */
const CLAUDE_DOUBLE_SIGINT_GAP_MS = 250;

// `/quit` (alias `/q`) — THE session-end command: gracefully ends the
// current thread's agent for every adapter shape.
// Two distinct paths because the agents themselves have very
// different "exit" semantics:
//
// • Claude CLI runs in a tmux session. Its canonical exit is two
//   Ctrl+C in quick succession (the first cancels the current turn,
//   the second leaves the CLI). We replay that by sending `SIGINT`
//   through the adapter twice with a small gap — softer than a
//   `tmux kill-session`.
//
// • Every other adapter (OpenCode HTTP server, the raw terminal shell,
//   any future backend) has no "double Ctrl+C" to leave cleanly — the
//   only real teardown is `stopSession` (abort the running generation /
//   `tmux kill-session`, drop the session). We call it directly so
//   `/quit` behaves like a real exit instead of two no-op aborts.
command(['quit', 'q'], async (_ctx, key) => {
  // User took over (/quit) → cancel any pending API-error retry silently. /quit
  // does NOT go through releaseThreadSession (it stops adapters + clears ids
  // inline), so the cancel is wired here explicitly.
  cancelApiRetry(key);
  cancelConversationRequest(key); // /quit ends the work → its open request closes silently
  cancelClaudeAuthLogin(key); // /quit teardown → kill any in-flight /login pty
  cancelOpenCodeOAuthLogin(key); // /quit teardown → kill any in-flight /connect oauth pty
  clearAuthNotice(key); // /quit teardown → retire any pinned logged-out notice
  const adapter = getThreadAdapter(key);
  const adapterName = getThreadAdapterNameRaw(key);
  const primaryActive = adapter.checkIsActive(key);

  // Defensive: any *other* adapter that's also active for this thread is
  // a leftover from a previous botched switch. Kill it first so it can't
  // keep streaming after the user's "quit". Re-using the sweep helper
  // instead of an open-coded loop avoids drift between the call sites.
  const otherAdapters = getKnownAdapterNames().filter(n => n !== adapterName);
  stopAllAdaptersFor(key, otherAdapters);

  if (!primaryActive) {
    await replyToThread(key, 'No agent running');
    return;
  }
  markNeedsNewMessage(key);

  // Close any still-pending OpenCode question on the server BEFORE the teardown
  // below (a stopped session can't accept the reject; an unrejected question
  // re-surfaces on the next reattach). No-op for Claude / no pending question.
  adapter.rejectQuestion?.(key);

  if (adapterName === 'claude') {
    adapter.sendSignal(key, 'SIGINT');
    await new Promise((r) => setTimeout(r, CLAUDE_DOUBLE_SIGINT_GAP_MS));
    adapter.sendSignal(key, 'SIGINT');
    // Explicit quit releases the session for good — no auto-reattach later.
    await state.clearAgentSessionIds(key);
    await replyToThread(key, t('agent.exit_signal_sent', { label: adapter.label }));
    return;
  }

  // OpenCode, terminal, any future adapter: tear down via stopSession.
  adapter.stopSession(key);
  // Explicit quit releases the session for good — no auto-reattach later.
  await state.clearAgentSessionIds(key);
  await replyToThread(key, t('agent.stopped', { label: adapter.label }));
});

// ── tmux-style controls (Claude CLI) ──

command('c', async (_ctx, key) => {
  const adapter = getThreadAdapter(key);
  // The operator interrupted the turn: its open request closes silently.
  cancelConversationRequest(key);
  markNeedsNewMessage(key);
  adapter.sendSignal(key, 'SIGINT');
  await replyToThread(key, 'Ctrl+C sent');
});

command('y', async (_ctx, key) => {
  const adapter = getThreadAdapter(key);
  if (adapter.checkIsActive(key)) {
    markNeedsNewMessage(key);
    adapter.sendInput(key, 'y');
  }
});

command('n', async (_ctx, key) => {
  const adapter = getThreadAdapter(key);
  if (adapter.checkIsActive(key)) {
    markNeedsNewMessage(key);
    adapter.sendInput(key, 'n');
  }
});

command('enter', async (_ctx, key) => {
  const adapter = getThreadAdapter(key);
  if (adapter.sendEnter) {
    markNeedsNewMessage(key);
    adapter.sendEnter(key);
  } else {
    await replyToThread(key, `Not supported for ${adapter.label}`);
  }
});

command('up', async (_ctx, key) => {
  const adapter = getThreadAdapter(key);
  if (adapter.sendArrow) adapter.sendArrow(key, 'Up');
  else await replyToThread(key, `Not supported for ${adapter.label}`);
});

command('down', async (_ctx, key) => {
  const adapter = getThreadAdapter(key);
  if (adapter.sendArrow) adapter.sendArrow(key, 'Down');
  else await replyToThread(key, `Not supported for ${adapter.label}`);
});

command('tab', async (_ctx, key) => {
  const adapter = getThreadAdapter(key);
  if (adapter.sendTab) adapter.sendTab(key);
  else await replyToThread(key, `Not supported for ${adapter.label}`);
});

command(['esc', 'escape'], async (_ctx, key) => {
  const adapter = getThreadAdapter(key);
  if (adapter.sendEscape) {
    // The operator interrupted the turn: its open request closes silently.
    cancelConversationRequest(key);
    markNeedsNewMessage(key);
    adapter.sendEscape(key);
  } else {
    await replyToThread(key, `Not supported for ${adapter.label}`);
  }
});

command('output', async (_ctx, key) => {
  const adapter = getThreadAdapter(key);
  if (!adapter.getFullOutput) {
    await replyToThread(key, `Not supported for ${adapter.label}`);
    return;
  }
  const output = adapter.getFullOutput(key, 500);
  if (!output) {
    await replyToThread(key, 'Agent not running or no output');
    return;
  }
  const chunks: string[] = [];
  let current = '';
  for (const line of output.split('\n')) {
    if (current.length + line.length + 1 > 4000) {
      chunks.push(current);
      current = line;
    } else {
      current += (current ? '\n' : '') + line;
    }
  }
  if (current) chunks.push(current);
  // Audit S11 / #26: the first chunk used to land via `replyToThread`
  // without flipping `needsNewMessage`, so it could overwrite a fresh
  // agent edit by accident. Also surface truncation explicitly so the
  // user knows N chunks were dropped instead of silently seeing only 5.
  markNeedsNewMessage(key);
  const MAX_CHUNKS = 5;
  const visible = chunks.slice(0, MAX_CHUNKS);
  const dropped = chunks.length - visible.length;
  for (let i = 0; i < visible.length; i++) {
    let chunk = visible[i] || '(empty)';
    if (i === visible.length - 1 && dropped > 0) {
      chunk += `\n\n…and ${dropped} more chunk${dropped === 1 ? '' : 's'} omitted`;
    }
    await replyToThread(key, chunk);
  }
});

/**
 * @description `/trace` — toggle the output-trace recorder at runtime.
 *
 *   /trace on        → trace THIS topic's events
 *   /trace off       → stop tracing this topic
 *   /trace on all    → trace every thread (cross-thread forensics)
 *   /trace off all   → clear the all-threads flag AND the per-thread set
 *   /trace           → status: this thread on/off, all-flag, traced count
 *
 * Replaces the boot-time `OUTPUT_TRACE` env var. The toggle is persisted in
 * `state.json` and re-seeded into `outputTrace.ts` at boot, so a `/trace`
 * setting survives a hot rebuild mid-debug. Lifecycle-independent: nothing in
 * the session lifecycle (stop, /new, /quit, resume, /unbind) touches it.
 */
command('trace', async (_ctx, key, parsed) => {
  const args = parsed.args.map((arg) => arg.toLowerCase());
  const config = state.getTraceConfig();
  const keyStr = keyToString(key);

  // Bare `/trace` — status only.
  if (args.length === 0) {
    const onLabel = t('trace.statusOnLabel');
    const offLabel = t('trace.statusOffLabel');
    const isThisThreadOn = config.allThreads || config.threadKeys.includes(keyStr);
    await replyToThread(key, t('trace.statusReply', {
      thisThread: isThisThreadOn ? onLabel : offLabel,
      allThreads: config.allThreads ? onLabel : offLabel,
      count: config.threadKeys.length,
    }));
    return;
  }

  const [action, scope] = args;
  const isAllScope = scope === 'all';
  if ((action !== 'on' && action !== 'off') || (scope !== undefined && !isAllScope)) {
    await replyToThread(key, t('trace.usageHint'));
    return;
  }

  let nextConfig: { allThreads: boolean; threadKeys: string[] };
  let reply: string;
  if (action === 'on' && isAllScope) {
    nextConfig = { allThreads: true, threadKeys: config.threadKeys };
    reply = t('trace.onAllThreadsReply');
  } else if (action === 'off' && isAllScope) {
    nextConfig = { allThreads: false, threadKeys: [] };
    reply = t('trace.offAllThreadsReply');
  } else if (action === 'on') {
    nextConfig = { allThreads: config.allThreads, threadKeys: [...config.threadKeys, keyStr] };
    reply = t('trace.onThisThreadReply');
  } else {
    nextConfig = {
      allThreads: config.allThreads,
      threadKeys: config.threadKeys.filter(k => k !== keyStr),
    };
    reply = t('trace.offThisThreadReply');
  }

  // Persist first, then seed the in-memory writer from the normalised config so
  // the two never drift (the store dedups/sorts the thread keys).
  await state.setTraceConfig(nextConfig);
  setTraceConfig(state.getTraceConfig());
  await replyToThread(key, reply);
});

/**
 * @description `/timestamps` — toggle the per-thread prompt-timestamp injection.
 *
 *   /timestamps on   → prepend the send-time (local-offset ISO top line) to
 *                      every prompt forwarded to THIS topic's agent
 *   /timestamps off  → stop injecting
 *   /timestamps      → status: this thread on/off
 *
 * Agent-facing only: the line rides the forwarded prompt like the thread-context
 * preamble and is never posted to the topic. Persisted in `state.json`
 * (mirrors `/trace`'s shape), lifecycle-independent — nothing in the session
 * lifecycle touches it. Default OFF. Use case: long multi-day sessions where
 * the agent needs absolute time to interpret "yesterday" / "2-3 days ago".
 */
command('timestamps', async (_ctx, key, parsed) => {
  const args = parsed.args.map((arg) => arg.toLowerCase());

  // Bare `/timestamps` — status only.
  if (args.length === 0) {
    await replyToThread(
      key,
      t(state.checkIsTimestampsEnabled(key) ? 'timestamps.statusOnReply' : 'timestamps.statusOffReply'),
    );
    return;
  }

  const [action] = args;
  if ((action !== 'on' && action !== 'off') || args.length > 1) {
    await replyToThread(key, t('timestamps.usageHint'));
    return;
  }

  await state.setTimestampsEnabled(key, action === 'on');
  await replyToThread(key, t(action === 'on' ? 'timestamps.onReply' : 'timestamps.offReply'));
});

/**
 * @description `/schedule` (S7) — a thin prompt wrapper. The bot owns NO
 * scheduling logic: it wraps the user's request in an agent-facing instruction
 * (forward template with args, interview template without) and delivers it
 * EXACTLY like a plain user message — reusing the agent session or starting one
 * with the thread's last-used agent. All the intelligence (parse the time,
 * call schedule_create / schedule_list / schedule_cancel) lives in the agent +
 * the bot's MCP tools (S5/S6). Until those land the agent simply replies it
 * can't schedule — an accepted intermediate state.
 *
 *   /schedule <free text>  → forward template wrapping {text}
 *   /schedule              → interview template (agent asks what + when)
 *
 * Routing mirrors the plain-text handler via the shared choke points:
 * `ensureAgentSession` does the bind-check + start (returns `unbound` →
 * bind-required reply, same as every agent-facing path), then
 * `deliverPromptOrBuffer` forwards (active) or buffers (mid-startup), reading
 * the startup window AFTER the ensure so a freshly-started session forwards.
 */
command('schedule', async (_ctx, key, parsed) => {
  const text = parsed.argsText;
  // The agent has no clock of its own, so the wrapper carries the CURRENT
  // instant + zone: without it "tomorrow at 9" resolves against whatever the
  // model assumes rather than the zone the schedule will actually fire in.
  const zone = getCurrentTimezone();
  const timeNote = t('schedule.currentTimeNote', {
    now: formatZoneNowWithDate(zone, Date.now()),
    zone,
  });
  const wrappedPrompt = text
    ? t('schedule.forwardPromptTemplate', { text, timeNote })
    : t('schedule.interviewPromptTemplate', { timeNote });

  const result = await ensureAgentSession(key);
  if (!result.ok) {
    // A bound topic that never started an agent (`no-adapter`) gets a
    // schedule-specific warning: a scheduled run needs an agent to launch,
    // so there is nothing to schedule until one is started. Every other
    // failure (e.g. `unbound`) keeps the shared reply.
    const message = result.reason === 'no-adapter' ? t('schedule.noAgent') : result.message;
    await replyToThread(key, message);
    return;
  }
  // Fresh-start notice (empty when the session was already active / starting).
  if (result.message) await replyToThread(key, result.message);

  const isStarting = startupPromptBuffer.checkIsStarting(keyToString(key));
  await deliverPromptOrBuffer(key, wrappedPrompt, isStarting);
});

// ═══════════════════════════════════════════════════════════════════════════════
//  /reminders — bot-LOCAL reminders (buttons only, zero agent involvement)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * @description One topic's in-flight add wizard.
 *
 * Kept in MEMORY, not `state.json`, on purpose: hot mode restarts the bot on
 * every code change and an unfinished wizard is a few taps, not data worth
 * persisting — while the reminder it produces goes straight to disk through the
 * normal schedule store.
 *
 * `messageId` is the ONE message the whole flow occupies: the hub message becomes
 * the wizard, each tap re-renders it, and it finally becomes the created card.
 * `textWait` is set only on step 4 and carries the COMPLETE pick set, so the
 * creation path is unreachable with a half-answered wizard.
 */
interface ReminderWizardSession {
  state: ReminderWizardState;
  messageId: number;
  textWait: {
    picks: ReminderSchedulePicks;
    armedAtMs: number;
    /**
     * Set by the message that consumed this wait, so a second message arriving
     * concurrently cannot create a second reminder from the same wizard. Released
     * again only when the wizard STAYS on step 4 (an over-long text), because then
     * a shorter retry still has to be captured.
     */
    isClaimed: boolean;
  } | null;
}

const reminderWizards = new Map<string, ReminderWizardSession>();

/** Width of the `HH` field in the minute step's `21:__` header. */
const reminderHourFieldWidth = 2;

/** Error code → the line the wizard prints above the step it re-renders. */
const reminderWizardErrorKeys: Readonly<Record<ReminderWizardErrorCode, string>> = {
  pastTime: 'reminders.errorPastTime',
  invalidDate: 'reminders.errorInvalidDate',
  invalidTime: 'reminders.errorInvalidTime',
  textTooLong: 'reminders.errorTextTooLong',
};

/**
 * @description Resolve a wizard error into its localized line. One choke point so
 * the `textTooLong` wording names the bound it rejected from the SINGLE constant
 * instead of having the number spelled out in 12 translations; the other codes
 * carry no `{limit}` and simply ignore it.
 */
function getReminderWizardErrorText(errorCode: ReminderWizardErrorCode): string {
  return t(reminderWizardErrorKeys[errorCode], { limit: reminderTextMaxLength });
}

/** A rendered reminder screen: the message text plus the keyboard that goes with it. */
interface ReminderScreen {
  text: string;
  keyboard: ReturnType<typeof Markup.inlineKeyboard>;
}

/**
 * Resolve one planned button caption: a locale-neutral literal, an i18n key, or a
 * list row — whose caption is composed HERE because its schedule half is itself a
 * localized lookup the pure planner cannot make.
 */
function renderReminderButtonLabel(label: ReminderButtonLabel): string {
  switch (label.kind) {
    case 'literal':
      return label.text;
    case 'key':
      return t(label.key, label.vars);
    case 'listRow':
      return getReminderRowLabel(label.name, label.descriptor);
  }
}

/** Turn a keyboard PLAN from the pure module into telegraf button rows. */
function renderReminderButtonRows(plan: ReminderKeyboardPlan) {
  return plan.map((row) =>
    row.map((button) =>
      Markup.button.callback(renderReminderButtonLabel(button.label), button.callbackData),
    ),
  );
}

function buildReminderKeyboard(plan: ReminderKeyboardPlan) {
  return Markup.inlineKeyboard(renderReminderButtonRows(plan));
}

/**
 * The «close» button. Composed HERE rather than inside `buildReminderHubKeyboard`
 * because that builder owns the rows whose PRESENCE is a decision (add at the
 * cap, list when empty), whereas «close» is an unconditional dismissal that both
 * the hub and the created card carry.
 */
function buildReminderCloseButton() {
  return Markup.button.callback(t('reminders.closeButton'), reminderCloseCallback);
}

/** The thread's reminders — its agent-prompt schedules filtered out. */
function getThreadReminders(key: SessionKey): ScheduleRecord[] {
  return state.getThreadSchedules(key).filter(checkIsReminderSchedule);
}

/** Records → the rows the pure list/card plans consume. */
function toReminderListRows(records: readonly ScheduleRecord[]): ReminderListRow[] {
  return records.map((record) => ({
    id: record.id,
    name: record.name,
    descriptor: getReminderScheduleDescriptor(record.spec),
  }));
}

/** Screen 0: the count (or why «add» is missing) plus the add/list/close rows. */
function buildReminderHubScreen(key: SessionKey): ReminderScreen {
  const records = getThreadReminders(key);
  const plan = getReminderHubPlan({
    // The reminder cap is the comparison `createScheduleForThread` makes for a
    // reminder, so «add» is never drawn for a create the store would reject four
    // steps later.
    reminderCount: records.length,
    maxReminders: maxRemindersPerThread,
  });
  const bodyLine =
    plan.body === 'empty'
      ? t('reminders.hubEmptyLine')
      : plan.body === 'atLimit'
        ? t('reminders.hubLimitLine', { count: records.length, limit: maxRemindersPerThread })
        : t('reminders.hubActiveLine', { count: records.length });
  const rows = buildReminderHubKeyboard(records.length, { isAddOffered: plan.isAddOffered });
  return {
    text: `${t('reminders.hubTitle')}\n${bodyLine}`,
    keyboard: Markup.inlineKeyboard([...renderReminderButtonRows(rows), [buildReminderCloseButton()]]),
  };
}

/**
 * @description One list page, or `null` when the thread has no reminders (the
 * caller falls back to the hub — a list screen with no rows is a dead end).
 *
 * Each row BUTTON carries «🔔 name · localized schedule», so the message text is
 * only a header — printing the same rows in the body as well would show the list
 * twice.
 */
function buildReminderListScreen(key: SessionKey, page: number): ReminderScreen | null {
  const rows = toReminderListRows(getThreadReminders(key));
  if (rows.length === 0) return null;
  const plan = buildReminderListPlan(rows, page);
  const lines = [t('reminders.listTitle', { count: rows.length })];
  if (plan.totalPages > 1) {
    lines.push(t('reminders.listPageLine', { page: plan.currentPage + 1, total: plan.totalPages }));
  }
  return { text: lines.join('\n'), keyboard: buildReminderKeyboard(plan.keyboard) };
}

/**
 * The three detail lines a reminder is described by. Shared by the card opened
 * from the list and by the created-screen, so the two can never describe the same
 * reminder differently.
 */
function buildReminderDetailLines(
  record: ScheduleRecord,
  descriptor: ReminderScheduleDescriptor,
): string[] {
  return [
    t('reminders.cardWhen', { schedule: getReminderScheduleDescriptorText(descriptor) }),
    t('reminders.cardText', { text: record.prompt }),
    t('reminders.cardNext', { next: getReminderNextRunText(record.nextRunAt, Date.now()) }),
  ];
}

/** One reminder's card, or `null` for a stale row index / a record already gone. */
function buildReminderCardScreen(key: SessionKey, reminderIndex: number): ReminderScreen | null {
  const records = getThreadReminders(key);
  const plan = buildReminderCardPlan(toReminderListRows(records), reminderIndex);
  if (plan === null) return null;
  const record = records.find((candidate) => candidate.id === plan.row.id);
  if (record === undefined) return null;
  return {
    text: [
      t('reminders.cardTitle', { name: plan.row.name }),
      ...buildReminderDetailLines(record, plan.row.descriptor),
    ].join('\n'),
    keyboard: buildReminderKeyboard(plan.keyboard),
  };
}

/** The done screen: what was created, plus delete / list / close. */
function buildReminderCreatedScreen(record: ScheduleRecord): ReminderScreen {
  return {
    text: [
      t('reminders.createdTitle'),
      ...buildReminderDetailLines(record, getReminderScheduleDescriptor(record.spec)),
    ].join('\n'),
    keyboard: Markup.inlineKeyboard([
      [
        Markup.button.callback(t(reminderLabelKeys.cardDelete), buildReminderDeleteCallback(record.id)),
        Markup.button.callback(t('reminders.doneListButton'), buildReminderListPageCallback(0)),
        buildReminderCloseButton(),
      ],
    ]),
  };
}

/** The question the wizard's CURRENT step asks. */
function getReminderStepQuestion(wizardState: ReminderWizardState): string {
  switch (wizardState.step) {
    case 'repeat':
      return t('reminders.stepRepeatQuestion');
    case 'date':
      return t('reminders.stepDateQuestion');
    case 'dateGrid':
      return t('reminders.stepDateGridQuestion');
    case 'weekday':
      return t('reminders.stepWeekdayQuestion');
    case 'dayOfMonth':
      return t('reminders.stepDayOfMonthQuestion');
    case 'dayOfMonthGrid':
      return t('reminders.stepDayOfMonthGridQuestion');
    case 'time':
      return t('reminders.stepTimeQuestion');
    case 'hour':
      return t('reminders.stepHourQuestion');
    case 'minute':
      // The hour is committed before this screen renders; `?? 0` only narrows the
      // optional field (a minute step with no hour is refused by the pure module).
      return t('reminders.stepMinuteQuestion', {
        hour: (wizardState.hour ?? 0).toString().padStart(reminderHourFieldWidth, '0'),
      });
    case 'text':
      return t('reminders.stepTextQuestion');
  }
}

/**
 * @description The wizard screen for a state: the title, the running summary of
 * everything already picked, then the current step's question (preceded by an
 * error line when a pick could not be applied). The summary is what makes a
 * single re-rendered message readable as a flow — each tap appends its value.
 */
function buildReminderWizardScreen(
  wizardState: ReminderWizardState,
  errorCode: ReminderWizardErrorCode | null,
): ReminderScreen {
  const lines = [t('reminders.wizardTitle')];
  if (wizardState.repeatKind !== null) {
    lines.push(t('reminders.pickRepeat', { value: t(reminderRepeatLabelKeys[wizardState.repeatKind]) }));
  }
  if (wizardState.dateIso !== null) {
    lines.push(t('reminders.pickDate', { value: wizardState.dateIso }));
  }
  if (wizardState.weekday !== null) {
    lines.push(t('reminders.pickWeekday', { value: t(reminderWeekdayLabelKeys[wizardState.weekday]) }));
  }
  if (wizardState.dayOfMonth !== null) {
    lines.push(t('reminders.pickDayOfMonth', { value: wizardState.dayOfMonth }));
  }
  if (wizardState.hour !== null && wizardState.minute !== null) {
    lines.push(
      t('reminders.pickTime', {
        value: formatReminderTime({ hour: wizardState.hour, minute: wizardState.minute }),
      }),
    );
  }
  if (wizardState.text !== null) {
    // Only a stale-instant retry holds text. The line is what tells the operator it
    // was KEPT — without it they retype the reminder, and a retyped message is no
    // longer captured by the (now disarmed) text wait: it reaches the agent instead.
    lines.push(
      t('reminders.pickText', {
        value: getShortenedText(wizardState.text, reminderSummaryTextMaxLength),
      }),
    );
  }
  const question = getReminderStepQuestion(wizardState);
  const body = errorCode === null ? question : `${getReminderWizardErrorText(errorCode)}\n\n${question}`;
  return {
    text: `${lines.join('\n')}\n\n${body}`,
    keyboard: buildReminderKeyboard(buildReminderStepKeyboard({ state: wizardState, nowMs: Date.now() })),
  };
}

/** Replace a reminder screen in place (the flow never creates a second message). */
async function renderReminderScreen(
  key: SessionKey,
  messageId: number,
  screen: ReminderScreen,
): Promise<void> {
  await editThreadMessage(key, messageId, screen.text, screen.keyboard);
}

/**
 * Relabel a reminder screen into a final notice and DROP its keyboard (an edit
 * with no `reply_markup` removes it), so a finished screen can't be acted on.
 */
async function retireReminderScreen(key: SessionKey, messageId: number, text: string): Promise<void> {
  await editThreadMessage(key, messageId, text);
}

/** Drop the keyboard of a tapped DEAD screen, swallowing a benign no-op edit. */
async function stripReminderKeyboard(ctx: Context): Promise<void> {
  try {
    await ctx.editMessageReplyMarkup(undefined);
  } catch (e) {
    const desc = checkIsApiError(e) ? getErrorDescription(e) : '';
    if (!/message is not modified/i.test(desc)) {
      console.warn('[reminders] keyboard strip failed:', desc || e);
    }
  }
}

/**
 * @description Retire the topic's in-flight wizard, if any: drop the session and
 * relabel its message so no dead keyboard is left tappable.
 *
 * Called by EVERY command (a command always wins over the step-4 text wait),
 * which is also what makes a repeat `/reminders` retire the previous wizard
 * before opening a new one — exactly one wizard is live per topic.
 */
async function cancelReminderWizard(key: SessionKey): Promise<void> {
  const kStr = keyToString(key);
  const session = reminderWizards.get(kStr);
  if (!session) return;
  reminderWizards.delete(kStr);
  await retireReminderScreen(key, session.messageId, t('reminders.cancelledNotice'));
}

/**
 * @description Retire a wizard whose step-4 text wait ran out. The triggering
 * message is NOT consumed by the caller — it falls through to normal handling,
 * because swallowing it would lose a prompt the operator meant for the agent.
 */
async function expireReminderWizard(key: SessionKey): Promise<void> {
  const kStr = keyToString(key);
  const session = reminderWizards.get(kStr);
  if (!session) return;
  reminderWizards.delete(kStr);
  await retireReminderScreen(key, session.messageId, t('reminders.expiredNotice'));
}

/**
 * @description Route an inbound message against the topic's step-4 text wait and,
 * when it IS the reminder text, CLAIM that wait — synchronously, before the caller
 * reaches its first `await`.
 *
 * The claim is the mutual exclusion: telegraf handles updates concurrently, so two
 * messages arriving together both pass an unclaimed wait and would each create a
 * reminder from the one wizard. A single-threaded event loop needs nothing heavier
 * than this flag — no lock, no timer — provided it is taken in the same synchronous
 * run as the decision, which is why claiming and routing are one function. Both the
 * typed and the voice path call it, so they cannot claim differently.
 */
function claimReminderTextCapture(key: SessionKey): ReminderTextCaptureRoute {
  const textWait = reminderWizards.get(keyToString(key))?.textWait;
  const route = getReminderTextCaptureRoute({
    armedAtMs: textWait?.armedAtMs ?? null,
    isClaimed: textWait?.isClaimed === true,
    nowMs: Date.now(),
  });
  if (route === 'capture' && textWait) textWait.isClaimed = true;
  return route;
}

/**
 * @description Persist a finished wizard's reminder, retire the wizard and turn its
 * message into the created card. The SINGLE creation path — shared by the text
 * capture and by the `createNow` retry after a stale instant — so the two can never
 * create reminders differently.
 */
async function createReminderFromWizard(input: {
  key: SessionKey;
  session: ReminderWizardSession;
  spec: ScheduleSpec;
  text: string;
  nowMs: number;
}): Promise<void> {
  const { key, session, text } = input;
  reminderWizards.delete(keyToString(key));
  const created = await createScheduleForThread(state, {
    threadKey: key,
    // The wizard never ASKS for a name — one less typing step; the list rows and
    // the card show the first words of the reminder itself.
    name: getReminderNameFromText(text),
    spec: input.spec,
    prompt: text,
    createdBy: 'user',
    nowMs: input.nowMs,
    deliveryKind: 'reminder',
  });
  if (!created.ok) {
    await retireReminderScreen(
      key,
      session.messageId,
      t('reminders.capReachedNotice', { limit: created.limit }),
    );
    return;
  }
  schedulerEngine?.armJob(created.record);
  await renderReminderScreen(key, session.messageId, buildReminderCreatedScreen(created.record));
}

/**
 * @description Turn the wizard's picks plus the operator's text into a reminder —
 * the entry point shared by the typed message and the transcribed voice note.
 *
 * The spec is rebuilt at THIS instant rather than reused from the time step:
 * minutes pass while the operator types, so a `once` reminder for «today» may have
 * gone by. That is reported on the time screen — and the text they just sent is
 * KEPT on the wizard, so the next time pick creates the reminder without asking for
 * it again. Re-typing the reminder is the one thing this all-buttons flow exists to
 * avoid.
 */
async function finishReminderWizard(key: SessionKey, text: string): Promise<void> {
  const session = reminderWizards.get(keyToString(key));
  const textWait = session?.textWait;
  if (!session || !textWait) return;

  // An over-long text is refused outright — it is never truncated, because the
  // words are the operator's own. The wizard therefore STAYS on step 4 (the error
  // rides the same screen) and the claim is released first, so the shorter retry is
  // captured instead of reaching the agent as a prompt.
  if (getReminderTextAcceptance(text) === 'tooLong') {
    textWait.isClaimed = false;
    await renderReminderScreen(
      key,
      session.messageId,
      buildReminderWizardScreen(session.state, 'textTooLong'),
    );
    return;
  }

  const nowMs = Date.now();
  const built = buildReminderSpec({ picks: textWait.picks, nowMs });
  if (!built.ok) {
    const retimeStep = getReminderStateForRetime(session.state, text);
    session.state = retimeStep;
    // Disarmed on purpose: the screen now asks for a TIME, not for text.
    session.textWait = null;
    await renderReminderScreen(key, session.messageId, buildReminderWizardScreen(retimeStep, built.code));
    return;
  }

  await createReminderFromWizard({ key, session, spec: built.spec, text, nowMs });
}

// `/reminders` — the reminder hub. Deliberately NOT gated on a binding or a
// session: the bot itself posts and pins a reminder, so it needs neither a folder
// nor an agent and works in every topic, General included.
command('reminders', async (_ctx, key) => {
  const screen = buildReminderHubScreen(key);
  await replyToThread(key, screen.text, screen.keyboard);
});

/**
 * @description `/clear` — delete the bot's messages in this thread.
 *
 * Plan §11 Этап 3 / §13.20 (T6):
 *   - Read ids from state.json (not in-memory `messageIds`).
 *   - Chunk by 100 (Bot API limit on deleteMessages).
 *   - Surface 48h truncation in the reply so the user understands why
 *     not all messages disappear (U2).
 *   - Requires `can_delete_messages` admin right; we degrade gracefully
 *     if Telegram says we can't.
 */
// `/clear_messages` (formerly `/clear`): delete the thread's Telegram
// messages. The bare `/clear` was freed for the agent — it now falls through
// to the verbatim-forward path (Claude TUI wipes its context, OpenCode treats
// it as plain text), and that path resets the thread-context preamble marker.
command('clear_messages', async (ctx, key) => {
  // Audit S11 / #19: snapshot and clear under the state lock so the
  // agent's concurrent `pushMessageId` writes between snapshot and
  // wipe don't get dropped without being deleted. New ids pushed
  // during the delete loop stay in state and get cleaned by the next
  // `/clear_messages` invocation.
  const messageIds = [ctx.message.message_id];
  const all = await state.takeMessageIds(key, messageIds);
  if (all.length === 0) {
    await replyToThread(key, t('clearMessages.no_messages'));
    return;
  }

  let deleted = 0;
  const batchSize = 100;
  for (let i = 0; i < all.length; i += batchSize) {
    const batch = all.slice(i, i + batchSize);
    try {
      await enqueueSend(key, () =>
        bot.telegram.callApi('deleteMessages', {
          chat_id: getTelegramChatId(key),
          message_ids: batch,
        }),
      );
      deleted += batch.length;
    } catch (e) {
      const desc = checkIsApiError(e) ? getErrorDescription(e) : String(e);
      if (/not enough rights|can't delete/i.test(desc)) {
        await replyToThread(key, t('error.tg.perm.delete'));
        return;
      }
      // `deleteMessages` is all-or-nothing per batch: a single un-deletable
      // id (>48h, already gone) sinks every fresh id alongside it. Fall back
      // to per-id deletes so we recover what we can. (Review HIGH #1.)
      for (const id of batch) {
        try {
          await enqueueSend(key, () => bot.telegram.deleteMessage(getTelegramChatId(key), id));
          deleted += 1;
        } catch {
          // Expired / already deleted — drop silently.
        }
      }
    }
  }

  const ms = getThreadMessageState(key);
  ms.lastMessageId = null;
  ms.lastMessageText = null;
  ms.needsNewMessage = true;

  console.log(`[clear_messages] ${keyToString(key)}: deleted ${deleted}/${all.length}`);
  await replyToThread(key, t('clearMessages.summary', { deleted, total: all.length }));
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Bot commands list (text vs slash) — known slash commands the bot handles
// ═══════════════════════════════════════════════════════════════════════════════

// Slash tokens the text handler must NOT forward to the agent. Covers every
// bot-owned command (incl. the raw-key controls c/y/n/enter/up/down/tab/esc)
// PLUS the retired commands (agent/cancel/unbind/where/stop/stopall/stop-all):
// their handlers were removed, but keeping the tokens here makes a stray
// `/where` (or `/stop`) inert instead of typing a meaningless prompt into the
// agent.
const botCommands = new Set([
  'start', 'claude', 'opencode', 'oc', 'terminal', 'agent', 'sessions', 'resume', 'cancel', 'model', 'connect',
  'disconnect', 'stop', 'stopall', 'stop-all', 'status', 'c', 'y', 'n', 'enter', 'up', 'down', 'tab', 'esc', 'escape', 'output', 'clear_messages',
  'bind', 'unbind', 'where', 'ls', 'list', 'new', 'clear_session', 'whoami', 'version', 'help', 'language', 'lang',
  'doctor', 'mcp', 'rename_session', 'compact', 'compact_on_idle', 'compact_summary', 'auto_continue_limits', 'trace', 'timestamps', 'timezone', 'schedule', 'reminders', 'thinking', 'tool_results',
  'subagent', 'claude_mode', 'effort', 'verbosity', 'quit', 'q', 'quit-all', 'quitall', 'pair',
]);

/**
 * @description The bare `/clear` is no longer bot-owned (it was renamed to
 * `/clear_messages`); it's forwarded verbatim to the agent. Forwarding it
 * resets the thread-context preamble marker so the next prompt re-informs the
 * agent of its context after its own context is wiped.
 */
const forwardedClearCommand = '/clear';

// ═══════════════════════════════════════════════════════════════════════════════
//  Text message handler — main conversational entrypoint
// ═══════════════════════════════════════════════════════════════════════════════

bot.on(message('text'), async (ctx) => {
  const key = await authoriseContext(ctx);
  if (!key) return;

  // User took over before a pending API-error retry fired → cancel it silently
  // (no give-up notice). Fires for EVERY authorised inbound text — a plain
  // prompt AND an owned slash-command — before the bot-command early-return.
  cancelApiRetry(key);

  // In groups Telegram appends `@botusername` to slash commands
  // (`/context` → `/context@my_bot`). Strip it up-front so BOTH the
  // bot-owned-command check below AND the verbatim forward to the agent see
  // the bare command — otherwise the agent's CLI gets `/context@my_bot` and
  // silently ignores it (the long-standing mention bug, first hit on /compact
  // back when that one was still forwarded).
  const text = stripCommandBotMention(ctx.message.text.trim());
  const kStr = keyToString(key);

  // Slash commands we don't own → forward to the agent (e.g. `/context`, `/help`).
  if (text.startsWith('/')) {
    const cmd = text.slice(1).split(' ')[0].split('@')[0].toLowerCase();
    if (botCommands.has(cmd)) return;
    // `/login` on a json-stream Claude thread has no TUI to host the OAuth flow →
    // run it out-of-band (spawn `claude auth login`, relay the URL). Every other
    // backend keeps the verbatim forward (tmux's TUI hosts /login itself). The
    // route reads the RAW backend pick, so an OpenCode/terminal thread is never
    // wrongly intercepted once json-stream is the default.
    const loginRoute = getLoginCommandRoute({
      command: cmd,
      rawBackendName: getThreadAdapterNameRaw(key),
      jsonStreamBackendName: claudeJsonStreamAdapterName,
    });
    if (loginRoute === 'outOfBand') {
      await state.pushMessageId(key, ctx.message.message_id);
      await startClaudeAuthLogin(key);
      return;
    }
  }

  // Always track inbound message ids so /clear can delete user messages too.
  await state.pushMessageId(key, ctx.message.message_id);

  // json-stream `/login` has reached the "paste code" stage → the next plain text
  // is the OAuth code. Mirror the /connect secret handling and the tmux login-paste
  // route: type it into the auth process, delete the message, ack. Gating on the
  // relayed-URL stage (not merely "a flow exists") keeps a message typed in the
  // pre-URL boot window from being swallowed/deleted as a code. A slash command
  // falls through (so /quit, /new, etc. still run and their teardown cancels the
  // pending login).
  if (checkIsAuthLoginAwaitingCode(key) && !text.startsWith('/')) {
    await submitClaudeAuthLoginCode(key, text, ctx.message.message_id);
    return;
  }

  // An OpenCode `/connect` OAuth flow has reached the reply stage (paste-style
  // code OR loopback callback) → the next plain text is the OAuth reply: a
  // pasted callback URL or a validated code. Recognised → consumed + deleted as
  // a secret; NOT recognised → the flow stays armed and hints (never forwarded
  // to the agent). A slash command falls through so /quit, /new, etc. still run
  // + cancel the flow.
  if (checkIsOpenCodeOAuthAwaitingReply(key) && !text.startsWith('/')) {
    await submitOpenCodeOAuthReply(key, text, ctx.message.message_id);
    return;
  }

  // Safety net: a pasted OAuth callback URL with NO flow in progress (e.g. a
  // stale one from a browser that timed out, or a re-paste after the flow ended)
  // must NOT be forwarded to the agent as a prompt — that both leaks the code
  // into the transcript and produced the confusing header error (live
  // 2026-07-20). Delete it as a secret and hint to re-run /connect.
  if (!text.startsWith('/') && parseOAuthCallbackFromReply(text)) {
    await deleteThreadMessage(key, ctx.message.message_id);
    await replyToThread(key, t('connect.oauth_callback_no_flow'));
    return;
  }

  const pendingProviderConnect = pendingProviderConnects.get(kStr);
  if (pendingProviderConnect && text.startsWith('/')) {
    pendingProviderConnects.delete(kStr);
    await replyToThread(key, t('connect.cancelled'));
  } else if (pendingProviderConnect) {
    pendingProviderConnects.delete(kStr);
    await handleProviderConnectKey(
      key,
      pendingProviderConnect.providerId,
      text,
      ctx.message.message_id,
    );
    return;
  }

  // `/reminders` step 4: this message IS the reminder text. Placed AFTER the
  // secret-capture flows above (the `/login` OAuth code, the `/connect` provider
  // key, the pasted-callback guard) — those must never be diverted into a
  // reminder — and BEFORE the startup buffer, so a wizard in a topic whose agent
  // happens to be booting still captures its text instead of buffering it as a
  // prompt. A slash command wins over the wait (it cancels the wizard and runs
  // normally); an expired wait retires the wizard and lets the message through; a
  // wait another concurrent message already CLAIMED falls through untouched, so the
  // one wizard yields exactly one reminder.
  const reminderTextRoute = claimReminderTextCapture(key);
  if (reminderTextRoute === 'capture' || reminderTextRoute === 'expired') {
    if (text.startsWith('/')) {
      await cancelReminderWizard(key);
    } else if (reminderTextRoute === 'expired') {
      await expireReminderWizard(key);
    } else {
      await finishReminderWizard(key, text);
      return;
    }
  }

  // Session is mid-startup → buffer the prompt and replay it once the agent is
  // ready, instead of dropping it into the "no agent running" guidance below.
  if (startupPromptBuffer.checkIsStarting(kStr)) {
    await deliverPromptOrBuffer(key, text, true);
    return;
  }

  // Audit S2 / #5: if `forum_topic_created` was emitted by a non-allowed
  // admin, we stashed the topic name in `pendingTopicNames` without
  // binding. Now that an allowed user is engaging this thread, retry the
  // fuzzy auto-bind once. Failure leaves the binding empty — text below
  // will route to the picker UX, same as on a topic without a cache hit.
  // Skip entirely when the thread is armed for create-folder: the user
  // explicitly chose to create a new folder, so this message is the name —
  // don't let a stale topic-name cache hijack it into a different bind.
  if (!checkIsGeneral(key) && !state.getBinding(key) && !awaitingFolderName.has(kStr)) {
    const pending = pendingTopicNames.get(kStr);
    if (pending && Date.now() - pending.ts < PENDING_TOPIC_NAME_TTL_MS) {
      const match = findAutobindSubdir(pending.name, listAvailableSubdirs(ENV.workRoot));
      if (match) {
        try {
          const subdir = validateSubdir(ENV.workRoot, match);
          // The pending entry carries the topic name (cached at creation) —
          // copy it onto the binding for the thread-context preamble (S1).
          await state.setBinding(key, subdir, pending.name ? { topicName: pending.name } : {});
          pendingTopicNames.delete(kStr);
          await replyToThread(key, t('thread.welcome_bound', { subdir }));
          await sendBindingWelcome(key, subdir);
        } catch (e) {
          console.warn(`[deferred-autobind] failed for "${match}":`, e);
          pendingTopicNames.delete(kStr);
        }
      } else {
        pendingTopicNames.delete(kStr);
      }
    } else if (pending) {
      // TTL expired — clean the entry.
      pendingTopicNames.delete(kStr);
    }
  }

  const adapter = getThreadAdapter(key);

  // Create-folder mode (armed by the «create new folder» button in the /bind
  // picker). The whole next message is the folder name — checked BEFORE the
  // numeric model / session branches so a numeric folder name (e.g. "2025")
  // isn't mistaken for a pick. /cancel and other commands already exited above
  // (slash commands return early), so reaching here means real name text. An
  // invalid name keeps the thread armed for a retry; success disarms it.
  if (awaitingFolderName.has(kStr)) {
    const { ok } = await createAndBindFolder(key, text);
    if (ok) awaitingFolderName.delete(kStr);
    return;
  }

  // Numeric model selection after `/model`.
  // Audit S12 / #20: previous code returned only when `adapter.setModel` was
  // truthy; on adapters that don't implement it (legacy void return) execution
  // fell through and the same numeric reply was re-processed as a
  // natural-language start + forwarded to the agent. `applyNumberedModelPick`
  // always replies (even for the unsupported case), so we always return after a
  // numeric pick — the user clearly intended a model pick, not a prompt.
  if (/^\d+$/.test(text) && awaitingModelSelection.has(kStr)) {
    await applyNumberedModelPick(adapter, key, parseInt(text, 10));
    return;
  }

  // Session-pick mode (armed by `/sessions` / `/resume`). Only while the
  // thread is armed is a bare digit treated as a pick — a normal numeric
  // prompt is never hijacked. See `checkSessionPickAction` for the rules.
  if (awaitingSessionSelection.has(kStr)) {
    const sessionList = threadSessionLists.get(kStr) ?? [];
    const pick = checkSessionPickAction(text, sessionList.length);
    if (pick.kind === 'invalid') {
      // Stay armed so the user can retry with a valid number.
      await replyToThread(key, t('session.invalid', { max: sessionList.length }));
      return;
    }
    if (pick.kind === 'cancel') {
      awaitingSessionSelection.delete(kStr);
      await replyToThread(key, t('session.cancelled'));
      return;
    }
    if (pick.kind === 'select') {
      awaitingSessionSelection.delete(kStr);
      const result = await resumeSessionByIndex(key, pick.index, async () => {
        await replyToThread(key, t('session.expired'));
      });
      if (result !== null) await replyToThread(key, result);
      return;
    }
    // passthrough: not a number — exit pick-mode and let normal handling run.
    awaitingSessionSelection.delete(kStr);
  }

  // Natural-language start.
  if (!adapter.checkIsActive(key)) {
    const startMatch = checkIsStartAgentPhrase(text);
    if (startMatch.isMatch && startMatch.adapterName) {
      if (checkIsGeneral(key)) {
        await replyToThread(key, t('error.start_in_general'));
        return;
      }
      // The shared `ensureAgentSession` does the bind-check + switch + start.
      // The explicit matched adapter wins (`preferredAdapterName`); the phrase's
      // trailing args ride along. On `unbound` we keep this path's own reply:
      // the folder picker (plan §11 Этап 4 — starting without a binding would
      // silently launch against WORK_ROOT, which is almost never wanted).
      const result = await ensureAgentSession(key, {
        preferredAdapterName: startMatch.adapterName,
        args: startMatch.args,
      });
      if (!result.ok && result.reason === 'unbound') {
        const subdirs = listAvailableSubdirs(ENV.workRoot);
        const extra = buildBindKeyboard(subdirs, 0, BIND_PAGE_SIZE, !!state.getBinding(key));
        await replyToThread(key, t('thread.no_binding'), extra);
        return;
      }
      // Empty when a self-greeting agent started (its banner is the cue) — guard
      // like the /schedule consumer so we never post a blank message.
      if (result.message) await replyToThread(key, result.message);
      return;
    }
  }

  // Claude TUI prompt on screen + a bare control reply (option digit or y/n)
  // → drive it in place. `getClaudeReplyRoute` decides precedence: a real
  // AskUserQuestion SELECTOR wins for a control reply; free-form prose breaks
  // out as a fresh prompt. Forwarding a digit as a prompt would first send
  // Escape (interruptAndWaitIdle) and cancel the menu — live-caught with
  // /login: the user replied "1" and got "⎿ Login interrupted".
  //   • selector → sendInput(digit) types the digit + an instant Enter, which
  //     jumps the selector to that option and confirms it.
  // Claude's native session SURVEY is auto-dismissed by the adapter (Escape) and
  // never surfaced, so a bare digit during a survey window is NOT a route here —
  // it falls through to the normal prompt path instead of being dropped.
  const replyRoute = getClaudeReplyRoute({
    isQuestionPending: adapter.isQuestionPending?.(key) ?? false,
    isLoginPastePending: adapter.isLoginPastePending?.(key) ?? false,
    text,
  });
  if (replyRoute === 'selector') {
    markNeedsNewMessage(key);
    adapter.sendInput(key, text);
    return;
  }
  // Claude `/login` OAuth code paste: type the code VERBATIM into the box (no
  // Escape, no thread-context preamble — both would break the login flow). The
  // code is a single-use secret, so delete the user's message from the topic
  // and post a short confirmation instead of leaving the token in history.
  if (replyRoute === 'loginPaste') {
    markNeedsNewMessage(key);
    adapter.sendInput(key, text);
    await deleteThreadMessage(key, ctx.message.message_id);
    await replyToThread(key, t('agent.login_code_relayed'));
    return;
  }

  // Terminal backend: a plain text message IS a shell command. Type it straight
  // in via `sendInput` (which appends Enter and arms a fresh rolling message),
  // bypassing `forwardPromptToAgent` entirely — no `[thread context]` preamble
  // (a shell isn't an agent that needs to know WHERE it works), no typing loader,
  // no interrupt logic. A bare `/clear` is likewise just typed in as input.
  if (adapter.name === 'terminal' && adapter.checkIsActive(key)) {
    adapter.sendInput(key, text);
    return;
  }

  // Forward text to a running agent (shared choke point for text + voice). It
  // owns the pending-question route (digit answers / free-form cancels), the G2
  // wedge backstop, and the actual forward. The Claude-selector + terminal
  // branches above already returned for their own cases, so this is reached only
  // for a generic active prompt. The message's real send time (Telegram `date`,
  // unix seconds) rides along for the `/timestamps` injection, and a Telegram
  // REPLY folds the quoted message into the prompt (see `getReplyQuoteBlock`).
  if (adapter.checkIsActive(key)) {
    const replyBlock = getReplyQuoteBlock(ctx.message);
    await deliverActivePrompt(key, adapter, text, ctx.message.date * 1000, replyBlock);
    return;
  }

  // Idle thread — guide the user. Three sub-states:
  //   • General → it's never bindable, just point at topical threads.
  //   • Topical without binding → offer the subdir picker (plan §20.6).
  //   • Topical with binding → existing /claude /opencode hint.
  if (checkIsGeneral(key)) {
    await replyToThread(key, t('thread.general_no_agent'));
    return;
  }
  const binding = state.getBinding(key);
  if (!binding) {
    const subdirs = listAvailableSubdirs(ENV.workRoot);
    const extra = buildBindKeyboard(subdirs, 0, BIND_PAGE_SIZE, !!state.getBinding(key));
    await replyToThread(key, t('thread.no_binding'), extra);
    return;
  }
  await replyToThread(key, t('thread.no_agent_with_binding', { subdir: binding.subdir }));
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Voice message handler
// ═══════════════════════════════════════════════════════════════════════════════

bot.on(message('voice'), async (ctx) => {
  const key = await authoriseContext(ctx);
  if (!key) return;

  // User took over (voice note) before a pending API-error retry fired → cancel
  // it silently, like the text handler.
  cancelApiRetry(key);

  await state.pushMessageId(key, ctx.message.message_id);

  if (!ENV.groqApiKey && !ENV.openaiApiKey) {
    await replyToThread(key, t('voice.no_api_key'));
    return;
  }

  // Offload the slow download+transcribe+forward off the telegraf update loop:
  // awaiting it here would stall intake of EVERY update until Groq replies
  // (up to 20s, longer on retries) and freeze the whole bot. The per-thread
  // FIFO queue preserves per-topic order; different topics run in parallel.
  // Do NOT await — the handler must return so the batch settles fast. A
  // rejected job is guarded so it can never become an unhandledRejection
  // (processVoiceJob already reports its own errors via replyToThread).
  const fileId = ctx.message.voice.file_id;
  const sentAtMs = ctx.message.date * 1000;
  // A Telegram REPLY on the voice note folds the quoted message into the prompt.
  // Compute it HERE (only the handler has `ctx`); the job runs later off the
  // update loop and only sees `key`/`bot`.
  const replyBlock = getReplyQuoteBlock(ctx.message);
  void getVoiceTranscriptionQueue(key)
    .run(() => processVoiceJob(key, fileId, sentAtMs, replyBlock))
    .catch((err) => {
      console.error('[Bot] Voice job error (already handled):', err);
    });
});

/**
 * @description Background worker for a single voice note: download → transcribe
 * → status emit → (buffer / start-agent-phrase / binding checks / forward).
 * Byte-for-byte the old voice handler's post-gate body — moved verbatim out of
 * the handler so it runs OFF the telegraf update loop (per-thread serialized).
 * Uses only `key`/`bot`, never the request `ctx`, so it survives past the
 * handler's return. `sentAtMs` is the voice note's real Telegram send time,
 * captured by the handler for the `/timestamps` injection (transcription can
 * take ~20s, so "now" at forward time would drift). `replyContext` is the
 * reply-quote block the handler built from `ctx.message` (a Telegram REPLY on
 * the voice note), plumbed here since the job no longer has `ctx`.
 */
async function processVoiceJob(
  key: SessionKey,
  fileId: string,
  sentAtMs?: number,
  replyContext?: string,
): Promise<void> {
  try {
    // Audit S14 / #33: `getFileLink` builds the bot-token URL in one
    // place inside Telegraf instead of us materialising the token in a
    // JS string. The previous manual interpolation worked but
    // accidentally leaking the token into any future log call would
    // expose the bot.
    const fileUrlObj = await bot.telegram.getFileLink(fileId);
    const fileUrl = fileUrlObj.toString();

    const tempDir = '/tmp';
    const tempFile = path.join(tempDir, `voice_${getTelegramChatId(key)}_${getTelegramThreadId(key)}_${Date.now()}.ogg`);
    try {
      // Ride the same warm, IPv4-pinned keep-alive agent as the Telegram API
      // calls (avoids the cold-handshake stall that used to trip the timeout),
      // and retry transient failures automatically so the user never has to
      // re-send the voice note.
      await downloadFile(fileUrl, tempFile, {
        agent: telegramAgent,
        timeoutMs: DOWNLOAD_TIMEOUT_MS,
        onRetry: (attempt, err, delayMs) => {
          console.warn(`[Bot] voice download attempt ${attempt} failed (${err.message}); retrying in ${delayMs}ms`);
        },
      });
    } catch (downloadErr) {
      const msg = downloadErr instanceof Error ? downloadErr.message : String(downloadErr);
      console.warn(`[Bot] voice download failed after retries: ${msg}`);
      await replyToThread(key, `${t('voice.failed')} (${msg})`);
      return;
    }
    const result = await transcribeVoiceFile(key, tempFile);
    fs.unlink(tempFile, () => {});

    if (!result.ok) {
      await replyToThread(key, `${t('voice.failed')} (${result.error})`);
      return;
    }
    const transcript = result.text;
    console.log(`[Bot] voice transcribed: "${transcript}"`);
    // Acknowledge the user's own input on the UNPACED path so the "🎤 …" echo
    // surfaces immediately instead of queuing behind the thread's streaming
    // agent output (which is what made it arrive minutes late under load).
    void replyToThread(key, t('voice.transcribed', { text: transcript }), {}, { unpaced: true }).catch(() => {});

    // `/reminders` step 4 accepts a voice note as well as typed text, so the
    // transcript is routed here — right after the 🎤 echo and BEFORE the
    // startup-buffer / natural-language-start / binding gates, which would
    // otherwise treat it as a prompt. Same single creation path as the text side.
    const reminderVoiceRoute = claimReminderTextCapture(key);
    if (reminderVoiceRoute === 'capture') {
      await finishReminderWizard(key, transcript);
      return;
    }
    if (reminderVoiceRoute === 'expired') await expireReminderWizard(key);

    // Session is mid-startup → buffer the transcript and replay it once ready.
    if (startupPromptBuffer.checkIsStarting(keyToString(key))) {
      await deliverPromptOrBuffer(key, transcript, true);
      return;
    }

    const adapter = getThreadAdapter(key);
    if (!adapter.checkIsActive(key)) {
      const startMatch = checkIsStartAgentPhrase(transcript);
      if (startMatch.isMatch && startMatch.adapterName) {
        if (checkIsGeneral(key)) {
          await replyToThread(key, t('error.start_in_general'));
          return;
        }
        if (!state.getBinding(key)) {
          const subdirs = listAvailableSubdirs(ENV.workRoot);
          const extra = buildBindKeyboard(subdirs, 0, BIND_PAGE_SIZE, !!state.getBinding(key));
          await replyToThread(key, t('thread.no_binding'), extra);
          return;
        }
        await switchThreadAdapter(key, startMatch.adapterName);
        // Empty for a self-greeting agent (Claude self-announces) — the typing
        // loader covers the gap; show a notice only when there's ready text.
        const msg = await startAgentSession(key, startMatch.args);
        if (msg) await replyToThread(key, msg);
        return;
      }
    }
    if (!adapter.checkIsActive(key)) {
      if (checkIsGeneral(key)) {
        await replyToThread(key, t('thread.general_no_agent'));
        return;
      }
      const binding = state.getBinding(key);
      if (!binding) {
        const subdirs = listAvailableSubdirs(ENV.workRoot);
        const extra = buildBindKeyboard(subdirs, 0, BIND_PAGE_SIZE, !!state.getBinding(key));
        await replyToThread(key, t('thread.no_binding'), extra);
        return;
      }
      await replyToThread(key, t('thread.no_agent_with_binding', { subdir: binding.subdir }));
      return;
    }

    // Same choke point as text: a voice transcript while a question is pending
    // CANCELS it (a transcript is free-form prose, never a bare digit) and is
    // delivered as a fresh prompt — closing the gap where voice queued behind a
    // blocked question-turn and the user got no reply.
    await deliverActivePrompt(key, adapter, transcript, sentAtMs, replyContext);
  } catch (err) {
    console.error('[Bot] Voice handling error:', err);
    await replyToThread(key, 'Error processing voice message');
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  File intake handler — photo / document / video / video_note / audio / animation
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * @description Detect Telegram's "file is too big" rejection from `getFile` /
 * `getFileLink` (400 with that description) so we can map it to the friendly
 * `file.too_big` reply instead of a generic failure. Bot API refuses to serve
 * a download link for files over the 20 MB cap.
 */
function checkIsFileTooBigApiError(err: unknown): boolean {
  if (!checkIsApiError(err)) return false;
  return /file is too big/i.test(getErrorDescription(err));
}

/**
 * @description Handle an inbound media message: gate exactly like the text
 * path, download the file into the bot-owned per-thread dir, then announce it
 * to the agent through the same `forwardPromptToAgent` choke point so the
 * preamble / buffering / `/clear` marker all apply uniformly.
 *
 * Gating mirrors the text handler: group gate (`authoriseContext`), inbound
 * id tracking, startup-buffer replay, then the active-session check with the
 * same no-agent / no-binding hints. The file is downloaded ONLY once we know
 * an agent is active (or mid-startup) — an idle/unbound thread gets the hint
 * and nothing hits disk, per the locked decision.
 */
/**
 * @description Evaluate the file-intake gate for a thread: an idle thread (no
 * active agent and not mid-startup) gets the same friendly guidance as the text
 * path and nothing hits disk. Returns `true` when intake may proceed.
 *
 * The hint reply is routed through `sendHint` rather than sent directly so the
 * album path can dedupe it to once-per-album; the single-file path passes
 * `replyToThread` verbatim.
 */
async function checkFileIntakeGatePassed(
  key: SessionKey,
  isStarting: boolean,
  sendHint: (text: string, extra?: SendExtra) => Promise<unknown>,
): Promise<boolean> {
  const adapter = getThreadAdapter(key);
  if (isStarting || adapter.checkIsActive(key)) return true;

  if (checkIsGeneral(key)) {
    await sendHint(t('thread.general_no_agent'));
    return false;
  }
  const binding = state.getBinding(key);
  if (!binding) {
    const subdirs = listAvailableSubdirs(ENV.workRoot);
    const extra = buildBindKeyboard(subdirs, 0, BIND_PAGE_SIZE, !!state.getBinding(key));
    await sendHint(t('thread.no_binding'), extra);
    return false;
  }
  await sendHint(t('thread.no_agent_with_binding', { subdir: binding.subdir }));
  return false;
}

/**
 * @description Download one inbound media file into the bot-owned per-thread
 * dir, returning its absolute saved path, or `null` if it could not be fetched.
 *
 * On a known-too-big file, an over-cap API error, or a download failure it
 * sends the matching error reply through `onError` (so the album path can
 * dedupe it) and returns `null`. The size pre-check is the caller's job for the
 * single-file fast path; for albums it is folded in here so each item is sized.
 */
async function downloadIncomingFile(
  ctx: NarrowedContext<Context, Update.MessageUpdate>,
  key: SessionKey,
  meta: TelegramFileMeta,
  onError: (text: string) => Promise<unknown>,
): Promise<string | null> {
  if (checkIsFileTooBig(meta.fileSize)) {
    await onError(t('file.too_big', { cap: FILE_DOWNLOAD_CAP_MB }));
    return null;
  }

  let fileUrl: string;
  try {
    fileUrl = (await ctx.telegram.getFileLink(meta.fileId)).toString();
  } catch (err) {
    if (checkIsFileTooBigApiError(err)) {
      await onError(t('file.too_big', { cap: FILE_DOWNLOAD_CAP_MB }));
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[Bot] getFileLink failed for ${meta.kind}: ${msg}`);
      await onError(t('file.download_failed'));
    }
    return null;
  }

  try {
    const dir = await ensureThreadFilesDir(getDataDir(), key);
    const unixSeconds = Math.floor(Date.now() / 1000);
    const fileName = buildSavedFileName(unixSeconds, meta.fileUniqueId, meta.kind, meta.fileName);
    const savedPath = path.join(dir, fileName);
    await downloadFile(fileUrl, savedPath, {
      agent: telegramAgent,
      timeoutMs: DOWNLOAD_TIMEOUT_MS,
      onRetry: (attempt, err, delayMs) => {
        console.warn(`[Bot] file download attempt ${attempt} failed (${err.message}); retrying in ${delayMs}ms`);
      },
    });
    return savedPath;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[Bot] file download failed after retries: ${msg}`);
    await onError(t('file.download_failed'));
    return null;
  }
}

/**
 * @description Deliver one already-built prompt to the thread's agent,
 * honouring the startup window (`utils/promptDelivery.ts`): mid-startup the
 * prompt is buffered, otherwise it is forwarded immediately through the normal
 * choke point. This is the single "buffer-or-forward" unit shared by the text and
 * voice handlers' mid-startup buffering, file/album intake, the `/schedule` command
 * (S7), the Jira connector's posts and an API-error retry's "continue" nudge, so the
 * startup-window handling never drifts between them.
 */
const promptDeliveryDeps: PromptDeliveryDeps = {
  startupBuffer: startupPromptBuffer,
  forwardPrompt: (key, text) => forwardPromptToAgent(key, getThreadAdapter(key), text),
  announceQueued: async (key) => {
    await replyToThread(key, t('agent.queued_starting', { label: getThreadAdapter(key).label }));
  },
};

function deliverPromptOrBuffer(
  key: SessionKey,
  promptText: string,
  isStarting: boolean,
  onBufferedSettled?: BufferedPromptSettled,
): Promise<PromptDelivery> {
  return deliverPromptWithDeps(promptDeliveryDeps, key, promptText, isStarting, onBufferedSettled);
}

/**
 * @description One member of an in-flight album, buffered in the collector
 * between the per-item download and the debounced flush. `caption` is the
 * caption that rode THIS item (Telegram puts it on a single, arbitrary album
 * member); the flush picks the first non-empty one.
 */
interface AlbumCollectorItem {
  /**
   * The originating message id. Album members arrive with monotonically
   * increasing ids, so sorting by it at flush time restores the user's visual
   * order even though Telegraf dispatches the burst concurrently (per-item
   * downloads can finish out of order).
   */
  messageId: number;
  albumFile: AlbumFile;
  caption?: string;
}

/**
 * @description Per-(thread, media_group) album batcher. Telegram delivers an
 * album as N messages sharing `media_group_id` in a quick burst; this coalesces
 * them so the agent gets ONE combined prompt after the burst settles, and gating
 * / error hints fire once per album. The flush forwards the combined prompt
 * through {@link deliverPromptOrBuffer}, re-reading the startup state AT FLUSH TIME
 * so a session that finished booting mid-burst forwards instead of buffers.
 */
const albumCollector = createMediaGroupCollector<AlbumCollectorItem>({
  debounceMs: ALBUM_DEBOUNCE_MS,
  onFlush: (groupKey, items) => {
    const { key } = parseAlbumGroupKey(groupKey);
    void withThreadLocale(key, async () => {
      if (items.length === 0) return; // Group existed only to hold a claimed hint.
      // Restore the user's visual order — downloads may have completed (and
      // thus collected) out of order under Telegraf's concurrent dispatch.
      const orderedItems = [...items].sort((a, b) => a.messageId - b.messageId);
      const files = orderedItems.map((item) => item.albumFile);
      const caption = orderedItems.find((item) => item.caption && item.caption.trim())?.caption;
      const promptText = buildAlbumPromptText(files, caption);
      const isStarting = startupPromptBuffer.checkIsStarting(keyToString(key));
      // User took over (album upload) before a pending API-error retry fired →
      // cancel it silently, like the text/voice handlers.
      cancelApiRetry(key);
      // A user album is genuine user activity → clear the compact-on-idle latch (D2).
      noteThreadUserActivity(key);
      try {
        await deliverPromptOrBuffer(key, promptText, isStarting);
      } catch (err) {
        console.error('[Bot] album flush failed:', err);
        await replyToThread(key, t('file.download_failed')).catch(() => {});
      }
    });
  },
});

/** Join a thread key and a media_group_id into the collector's group key. */
function buildAlbumGroupKey(key: SessionKey, mediaGroupId: string): string {
  return `${keyToString(key)}|${mediaGroupId}`;
}

/** Inverse of {@link buildAlbumGroupKey} — recover the owning thread key. */
function parseAlbumGroupKey(groupKey: string): { key: SessionKey } {
  const separatorIndex = groupKey.indexOf('|');
  const threadKeyString = separatorIndex === -1 ? groupKey : groupKey.slice(0, separatorIndex);
  return { key: keyFromString(threadKeyString) };
}

/**
 * @description Handle one media message that is part of an album (carries a
 * `media_group_id`). Gating and download happen per item — but the gating hint
 * and the download-error reply are deduped to once per album via the collector's
 * one-shot guard, and only the COMBINED prompt is debounced (the flush in
 * {@link albumCollector}). A successful download is buffered into the collector;
 * a failed one still lets the album flush announce the rest.
 */
async function handleAlbumFile(
  ctx: NarrowedContext<Context, Update.MessageUpdate>,
  key: SessionKey,
  meta: TelegramFileMeta,
  mediaGroupId: string,
): Promise<void> {
  const groupKey = buildAlbumGroupKey(key, mediaGroupId);
  const isStarting = startupPromptBuffer.checkIsStarting(keyToString(key));

  // Gate per item, but reply at most once per album. The guard is claimed
  // lazily so a passing gate never burns the one-shot slot.
  const gatePassed = await checkFileIntakeGatePassed(key, isStarting, async (text, extra) => {
    if (albumCollector.checkShouldAnnounceOnce(groupKey)) {
      await replyToThread(key, text, extra);
    }
  });
  if (!gatePassed) return;

  const savedPath = await downloadIncomingFile(ctx, key, meta, async (text) => {
    if (albumCollector.checkShouldAnnounceOnce(groupKey)) {
      await replyToThread(key, text);
    }
  });
  if (savedPath === null) return; // Error already deduped; let the rest flush.

  albumCollector.collect(groupKey, {
    messageId: ctx.message.message_id,
    albumFile: { kind: meta.kind, savedPath, fileSize: meta.fileSize },
    caption: meta.caption,
  });
}

async function handleIncomingFile(
  ctx: NarrowedContext<Context, Update.MessageUpdate>,
  key: SessionKey,
): Promise<void> {
  const meta = getTelegramFileMeta(ctx.message);
  if (!meta) return; // Not one of the six kinds (e.g. sticker) — ignore.

  // Always track inbound ids so /clear_messages can delete user uploads too.
  await state.pushMessageId(key, ctx.message.message_id);

  // Album item (shares media_group_id with siblings) → batch them into one
  // combined prompt instead of N prompts that abort each other.
  const mediaGroupId = getMediaGroupId(ctx.message);
  if (mediaGroupId) {
    await handleAlbumFile(ctx, key, meta, mediaGroupId);
    return;
  }

  const isStarting = startupPromptBuffer.checkIsStarting(keyToString(key));

  const gatePassed = await checkFileIntakeGatePassed(key, isStarting, (text, extra) =>
    replyToThread(key, text, extra),
  );
  if (!gatePassed) return;

  const savedPath = await downloadIncomingFile(ctx, key, meta, (text) => replyToThread(key, text));
  if (savedPath === null) return;

  const promptText = buildFilePromptText(meta.kind, savedPath, meta.fileSize, meta.caption);
  // User took over (file upload) before a pending API-error retry fired →
  // cancel it silently, like the text/voice handlers.
  cancelApiRetry(key);
  // A user file is genuine user activity → clear the compact-on-idle latch (D2).
  noteThreadUserActivity(key);
  await deliverPromptOrBuffer(key, promptText, isStarting);
}

bot.on(
  // anyOf-composed per-kind filter — `message('photo', 'document', …)` would
  // be an AND over the fields and never match a real media message (see
  // incomingFileMessageFilter).
  incomingFileMessageFilter,
  async (ctx) => {
    const key = await authoriseContext(ctx);
    if (!key) return;
    try {
      await handleIncomingFile(ctx, key);
    } catch (err) {
      console.error('[Bot] File handling error:', err);
      await replyToThread(key, t('file.download_failed'));
    }
  },
);

// ═══════════════════════════════════════════════════════════════════════════════
//  Edited message — explicit UX hint instead of silent ignore
// ═══════════════════════════════════════════════════════════════════════════════

bot.on('edited_message', async (ctx) => {
  const key = await authoriseContext(ctx);
  if (!key) return;
  // Reply once per edit so the user isn't left wondering. The bot does NOT
  // treat the edit as a re-prompt to the agent (plan §16.3, E6).
  await replyToThread(key, t('edited.hint'));
});

// ═══════════════════════════════════════════════════════════════════════════════
//  my_chat_member — auto-welcome when the bot is added to the group (§20.2)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * @description Detect when *this* bot is added to the configured group and
 * post a setup checklist into General. Without this, a fresh deployment is
 * silent: the user adds the bot, sees nothing, and has to dig through the
 * README to find out what permissions / privacy flags they need to flip.
 *
 * Filters:
 *   - chat must be the allowlisted group (we don't react in foreign chats),
 *   - the member that changed must be us (other admins being promoted etc.
 *     are not interesting),
 *   - new status must be `member` or `administrator` — `kicked`/`left`
 *     events would only generate noise.
 */
bot.on('my_chat_member', async (ctx) => {
  const chat = ctx.chat;
  if (!chat || chat.id !== getAllowedGroupId()) return;
  const upd = ctx.update.my_chat_member;
  const newMember = upd.new_chat_member;
  const botId = bot.botInfo?.id;
  if (!botId || newMember.user.id !== botId) return;
  if (newMember.status !== 'member' && newMember.status !== 'administrator') return;

  // We don't know which message_thread_id General actually has on this
  // group (it can be 1, or undefined for non-forum chats). For a forum
  // supergroup it's always the constant `GENERAL_THREAD_ID = 1`.
  const generalKey: SessionKey = makeTelegramKey(chat.id, GENERAL_THREAD_ID);
  await replyToThread(
    generalKey,
    t('onboarding.welcome', { workRoot: ENV.workRoot }),
    { parse_mode: 'Markdown' },
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
//  chat_member — admin promotion/demotion invalidates the admin cache
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * @description React to member-status changes in the served group: a
 * promotion/demotion changes the admin set that gates access, so the cached
 * set is invalidated and the next authorisation re-fetches it live — a demoted
 * admin loses access immediately instead of at the 1h TTL. Regular-member
 * joins/leaves can't change the admin set and are ignored
 * (`checkShouldInvalidateAdminCache`). Requires `chat_member` in
 * `allowed_updates` (NOT in Telegram's default set — see `botAllowedUpdates`).
 */
bot.on('chat_member', (ctx) => {
  if (ctx.chat?.id !== getAllowedGroupId()) return;
  const { old_chat_member, new_chat_member } = ctx.update.chat_member;
  if (!checkShouldInvalidateAdminCache(old_chat_member.status, new_chat_member.status)) return;
  adminCache.invalidate();
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Forum service events — created / deleted / closed / reopened
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * @description Auto-bind a newly-created thread when its name matches an
 * existing subdir; otherwise greet the user with the picker.
 *
 * Idempotent: the same event may arrive twice on bot restart, and the user's
 * very first message can race the service message. If a binding already
 * exists for this key we only re-send the welcome — never overwrite the
 * chosen subdir (plan §13.9, D16).
 */
bot.on(message('forum_topic_created'), async (ctx) => {
  const key = getThreadKey(ctx);
  if (!key) return;
  if (checkIsGeneral(key)) return; // General isn't created this way; defensive.

  const topicName = ctx.message.forum_topic_created.name ?? '';
  const existing = state.getBinding(key);

  // Already bound — service event arrived after the user's first message
  // (or on restart). Don't overwrite; quietly skip the welcome too, the
  // user has already seen the binding ack.
  if (existing) return;

  // Audit S2 / #5: topic creation may be open to all members (group setting),
  // not only admins. If the creator isn't an authorised user (group
  // admin/creator), we MUST NOT auto-bind — a non-admin could pick a name that
  // fuzzy-matches a sensitive WORK_ROOT subdir, the bot would auto-bind, and the
  // next message from an authorised user would launch an agent against the
  // attacker-chosen folder. Stash the topic name so a later authorised-user
  // message in the same thread can still benefit from fuzzy auto-bind.
  const userId = ctx.from?.id;
  if (!userId || !(await checkIsAllowedUser(ctx))) {
    if (topicName) {
      pendingTopicNames.set(keyToString(key), { name: topicName, ts: Date.now() });
    }
    console.warn(
      `[security] forum_topic_created in chat ${ctx.chat.id} by user ${userId ?? '?'} (not a group admin) — name cached, no auto-bind`,
    );
    return;
  }

  const subdirs = listAvailableSubdirs(ENV.workRoot);
  // Fuzzy match: NFC + lower + separator-collapsed (see `findAutobindSubdir`
  // for the precise drift coverage). Anything more aggressive would start
  // guessing — auto-bind has to stay predictable, mis-matches fall through
  // to the picker UX.
  const match = findAutobindSubdir(topicName, subdirs);
  if (match) {
    try {
      const subdir = validateSubdir(ENV.workRoot, match);
      // The creation event carries the topic name — persist it on the binding
      // for the thread-context preamble (S1).
      await state.setBinding(key, subdir, topicName ? { topicName } : {});
      await replyToThread(key, t('thread.welcome_bound', { subdir }));
      await sendBindingWelcome(key, subdir);
      return;
    } catch (e) {
      console.warn(`[forum_topic_created] auto-bind failed for "${match}":`, e);
      // Fall through to picker.
    }
  }

  const extra = buildBindKeyboard(subdirs, 0, BIND_PAGE_SIZE, !!state.getBinding(key));
  await replyToThread(key, t('thread.welcome_pick'), extra);
});

/**
 * @description A forum topic was renamed (or its icon changed). When the name
 * changed, persist it so the thread-context preamble can tell the agent its
 * current topic name. Admin-gated like the created/closed/reopened trio: a
 * non-authorised member's rename must not reshape what the bot remembers.
 *
 * This is also the ONLY way the bot learns the name of a pre-existing topic
 * (the Bot API can't query a topic title on demand). If the topic isn't bound
 * yet, refresh `pendingTopicNames` so a later auto-bind still gets the name.
 */
bot.on(message('forum_topic_edited'), async (ctx) => {
  const key = getThreadKey(ctx);
  if (!key) return;
  const newName = ctx.message.forum_topic_edited.name;
  // Icon-only edit (no `name`) — nothing for the preamble to track.
  if (!newName) return;
  const userId = ctx.from?.id;
  if (!userId || !(await checkIsAllowedUser(ctx))) {
    console.warn(`[security] forum_topic_edited in chat ${ctx.chat.id} by user ${userId ?? '?'} (not a group admin) — name not updated`);
    return;
  }
  if (state.getBinding(key)) {
    await state.setBindingTopicName(key, newName);
  } else {
    // No binding yet — keep the freshest name for a later fuzzy auto-bind.
    pendingTopicNames.set(keyToString(key), { name: newName, ts: Date.now() });
  }
});

// Audit S2 / #5: closed/reopened events can come from a member who isn't an
// authorised user. We deliberately diverge from "trust Telegram's state":
// better to leave our `closed` flag stale than to let a non-authorised user
// shape what the bot remembers about a thread. An authorised user re-engaging
// the thread will surface any drift via the `topic-closed` send-error path
// (which retries / surfaces a hint).
bot.on(message('forum_topic_closed'), async (ctx) => {
  const key = getThreadKey(ctx);
  if (!key) return;
  const userId = ctx.from?.id;
  if (!userId || !(await checkIsAllowedUser(ctx))) {
    console.warn(`[security] forum_topic_closed in chat ${ctx.chat.id} by user ${userId ?? '?'} (not a group admin) — state not updated`);
    return;
  }
  await state.setBindingClosed(key, true);
  // Topic closed — the session is no longer reachable from here, so any
  // re-engagement starts fresh. Drop the last-injected preamble so the next
  // prompt re-informs the agent of its context (the `closed` boundary in the
  // plan's start/stop/closed marker-reset rule).
  clearThreadContextMarker(key);
  // Refresh the banner so the `🔒 closed` marker appears immediately. Edits
  // INTO a closed topic are still allowed by Telegram even when sends aren't,
  // so we can update the existing pinned message without re-pinning.
  await updatePinnedStatus(key).catch(() => {});
});

bot.on(message('forum_topic_reopened'), async (ctx) => {
  const key = getThreadKey(ctx);
  if (!key) return;
  const userId = ctx.from?.id;
  if (!userId || !(await checkIsAllowedUser(ctx))) {
    console.warn(`[security] forum_topic_reopened in chat ${ctx.chat.id} by user ${userId ?? '?'} (not a group admin) — state not updated`);
    return;
  }
  await state.setBindingClosed(key, false);
  await updatePinnedStatus(key).catch(() => {});
});

// `forum_topic_deleted` is intentionally NOT handled here: Telegram doesn't
// reliably emit a service message for topic deletion (and Telegraf 4.16.3
// doesn't model it in its filter union), so we GC reactively via the 400
// "message thread not found" branch in `handleSendError` (plan §13.10, E5).
// That path also catches deletions that happen while the bot is offline,
// which any service-message-based handler would miss anyway.

// ═══════════════════════════════════════════════════════════════════════════════
//  Callback queries — model, agent switch, resume, opt buttons, qa answers
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * @description Inline-button binding picker shown by `/bind` (without args),
 * by the no-binding text-handler fallback, and by `forum_topic_created`.
 *
 * `bind_<subdir>` — subdir comes verbatim from the keyboard we just built,
 * so it's pre-filtered to entries actually present in WORK_ROOT. We still
 * route through `applyBinding` for validation parity with the slash command
 * (case the disk state changes between keyboard send and callback receive).
 */
/**
 * @description Pagination handler for the `/bind` keyboard.
 *
 * Edits the *existing* picker message in-place (`editMessageReplyMarkup`)
 * rather than sending a fresh keyboard — keeps the thread clean and
 * preserves the surrounding text. A no-op edit (same page tapped twice)
 * returns Telegram's "message is not modified" 400 which we swallow.
 *
 * Note: `bind_page_(\d+)$` is registered BEFORE `bind_(.+)$` so the
 * page-callback isn't accidentally interpreted as a folder name. Order
 * matters in Telegraf's action regex dispatch — first match wins.
 */
bot.action(/^bind_page_(\d+)$/, async (ctx) => {
  const key = await authoriseContext(ctx);
  if (!key) { await ctx.answerCbQuery(t('cb.access_denied')); return; }
  if (checkIsGeneral(key)) {
    await ctx.answerCbQuery(t('cb.bind_only_topical'));
    return;
  }
  const page = parseInt(ctx.match[1], 10);
  const subdirs = listAvailableSubdirs(ENV.workRoot);
  const keyboard = buildBindKeyboard(subdirs, page, BIND_PAGE_SIZE, !!state.getBinding(key));
  try {
    await ctx.editMessageReplyMarkup(keyboard.reply_markup);
  } catch (e) {
    const desc = checkIsApiError(e) ? getErrorDescription(e) : '';
    if (!/message is not modified/i.test(desc)) {
      console.warn(`[bind_page] edit failed:`, desc || e);
    }
  }
  await ctx.answerCbQuery();
});

// Middle "N/M" pill in the nav row — pure UI, no state change.
bot.action('bind_page_noop', async (ctx) => {
  await ctx.answerCbQuery();
});

// «Create new folder» — first option in the /bind picker. Arms the thread's
// await-folder-name mode; the next text message is the name (see the text
// handler). Callback id deliberately avoids the `bind_` prefix so it can't be
// matched by the `bind_<subdir>` regex below.
bot.action(bindCreateFolderCallback, async (ctx) => {
  const key = await authoriseContext(ctx);
  if (!key) { await ctx.answerCbQuery(t('cb.access_denied')); return; }
  if (checkIsGeneral(key)) {
    await ctx.answerCbQuery(t('cb.bind_only_topical'));
    return;
  }
  await ctx.answerCbQuery(t('bind.create_cb'));
  armFolderCreation(key);
  await replyToThread(key, t('bind.create_prompt'));
});

// «Leave current dir» — the folded-in `/unbind`, shown only in a bound topic.
// Callback id deliberately avoids the `bind_` prefix so it can't be matched by
// the `bind_<subdir>` regex below.
bot.action(bindLeaveCurrentCallback, async (ctx) => {
  const key = await authoriseContext(ctx);
  if (!key) { await ctx.answerCbQuery(t('cb.access_denied')); return; }
  if (checkIsGeneral(key)) {
    await ctx.answerCbQuery(t('cb.bind_only_topical'));
    return;
  }
  await ctx.answerCbQuery();
  await unbindThread(key);
});

bot.action(/^bind_(.+)$/, async (ctx) => {
  const key = await authoriseContext(ctx);
  if (!key) { await ctx.answerCbQuery(t('cb.access_denied')); return; }
  if (checkIsGeneral(key)) {
    await ctx.answerCbQuery(t('cb.bind_only_topical'));
    return;
  }
  const subdir = ctx.match[1];
  await ctx.answerCbQuery(t('cb.binding_to', { subdir }));
  const result = await applyBinding(key, subdir);
  await replyToThread(key, result.message);
  if (result.ok) await sendBindingWelcome(key, result.subdir);
});

// ─── /language inline picker callbacks ───────────────────────────────────────
//
// Registration order matters: `lang_auto` is registered BEFORE the generic
// `lang_(.+)` so the latter's `.+` can't swallow it (first-match-wins).

/**
 * @description Finalise a language pick: edit the picker message to a short
 * confirmation in the NEW effective locale and DROP the inline keyboard (the
 * menu disappears once a choice is made). Wrapped in `runWithLocale` because the
 * per-update locale middleware resolved the OLD locale before the override was
 * written (mirrors the text set/auto success paths).
 */
async function confirmLanguageSelection(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return;
  const resolved = getResolvedChatLocale(chatId, getTelegramLocale(ctx));
  const text = runWithLocale(resolved.locale, () =>
    t('language.status', { display: formatLanguageDisplay(resolved) }),
  );
  try {
    // No reply_markup → the inline keyboard is removed, leaving only the text.
    await ctx.editMessageText(text);
  } catch (e) {
    const desc = checkIsApiError(e) ? getErrorDescription(e) : '';
    if (!/message is not modified/i.test(desc)) console.warn('[lang_cb] edit failed:', desc || e);
  }
}

bot.action(languageAutoCallback, async (ctx) => {
  const key = await authoriseContext(ctx);
  if (!key) { await ctx.answerCbQuery(t('cb.access_denied')); return; }
  await state.setChatLocaleOverride(getTelegramChatId(key), null);
  await ctx.answerCbQuery();
  await confirmLanguageSelection(ctx);
});

bot.action(/^lang_(.+)$/, async (ctx) => {
  const key = await authoriseContext(ctx);
  if (!key) { await ctx.answerCbQuery(t('cb.access_denied')); return; }
  // A stale button could carry a code the bot no longer knows — normalize and
  // ignore silently rather than persist an invalid override.
  const locale = normalizeLocale(ctx.match[1]);
  if (!locale) { await ctx.answerCbQuery(); return; }
  await state.setChatLocaleOverride(getTelegramChatId(key), locale);
  await ctx.answerCbQuery();
  await confirmLanguageSelection(ctx);
});

// ─── /timezone inline picker callbacks ───────────────────────────────────────
//
// Registration order matters exactly as it does for `/language`: the literal
// `tzauto` / `tzback` ids are registered BEFORE the generic `tz_(\d+)_(\d+)`
// matcher (first-match-wins in Telegraf).

/**
 * @description Replace the picker message in place with `text` + `keyboard`,
 * or with `text` alone (keyboard dropped) when none is given — the same
 * "menu disappears once a choice is made" finish `/language` uses.
 */
async function editTimezonePickerMessage(
  ctx: Context,
  text: string,
  keyboard?: TimezonePickerKeyboard,
): Promise<void> {
  try {
    await ctx.editMessageText(text, keyboard);
  } catch (e) {
    const desc = checkIsApiError(e) ? getErrorDescription(e) : '';
    if (!/message is not modified/i.test(desc)) console.warn('[tz_cb] edit failed:', desc || e);
  }
}

/** Finalise a zone pick: confirm in place and drop the keyboard. */
async function confirmTimezoneSelection(ctx: Context, timezone: string | null): Promise<void> {
  await editTimezonePickerMessage(ctx, await applyTimezoneSelection(timezone));
}

bot.action(timezoneAutoCallback, async (ctx) => {
  const key = await authoriseContext(ctx);
  if (!key) { await ctx.answerCbQuery(t('cb.access_denied')); return; }
  await ctx.answerCbQuery();
  await confirmTimezoneSelection(ctx, null);
});

bot.action(timezonePickerBackCallback, async (ctx) => {
  const key = await authoriseContext(ctx);
  if (!key) { await ctx.answerCbQuery(t('cb.access_denied')); return; }
  await ctx.answerCbQuery();
  const view = buildTimezoneRegionView();
  await editTimezonePickerMessage(ctx, view.text, view.keyboard);
});

// Region tapped (or a page arrow) → render that region's zone page.
bot.action(regionPageCallbackRe, async (ctx) => {
  const key = await authoriseContext(ctx);
  if (!key) { await ctx.answerCbQuery(t('cb.access_denied')); return; }
  const render = buildTimezoneZonePicker(
    Number(ctx.match[1]),
    Number(ctx.match[2]),
    state.getTimezone(),
  );
  if (!render) { await ctx.answerCbQuery(t('timezone.picker_expired')); return; }
  await ctx.answerCbQuery();
  await editTimezonePickerMessage(
    ctx,
    t('timezone.picker_zones', {
      region: render.region,
      // Pages are zero-based on the wire and one-based for humans.
      page: render.currentPage + 1,
      total: render.totalPages,
    }),
    render.keyboard,
  );
});

// Zone tapped → set it. A stale index that no longer resolves answers
// "expired" rather than silently applying a neighbouring zone.
bot.action(zonePickCallbackRe, async (ctx) => {
  const key = await authoriseContext(ctx);
  if (!key) { await ctx.answerCbQuery(t('cb.access_denied')); return; }
  const timezone = getTimezoneAt(Number(ctx.match[1]), Number(ctx.match[2]));
  if (timezone === null) { await ctx.answerCbQuery(t('timezone.picker_expired')); return; }
  await ctx.answerCbQuery();
  await confirmTimezoneSelection(ctx, timezone);
});

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
  await state.setModelProviderHidden(provider, true);
  await ctx.answerCbQuery(t('cb.model_hidden', { provider }));
  await refreshModelProviderLevel(ctx, key);
});

bot.action(providerShowCallbackRe, async (ctx) => {
  const key = await authoriseContext(ctx);
  if (!key) { await ctx.answerCbQuery(t('cb.access_denied')); return; }
  const catalog = await getModelCatalog(getThreadAdapter(key));
  const provider = catalog.providers[Number(ctx.match[1])];
  if (provider === undefined) { await ctx.answerCbQuery(t('cb.model_provider_gone')); return; }
  await state.setModelProviderHidden(provider, false);
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

async function handleCompactOnIdleCallback(ctx: Context, enabled: boolean): Promise<void> {
  const key = await authoriseContext(ctx);
  if (!key) { await ctx.answerCbQuery(t('cb.access_denied')); return; }
  const isGeneral = checkIsGeneral(key);
  await withThreadLocale(key, () => applyCompactOnIdle(key, isGeneral, enabled));
  await ctx.answerCbQuery();
  // Re-render the picker keyboard so the ✓ follows the new state.
  const cbMsg = ctx.callbackQuery?.message as Message | undefined;
  if (cbMsg) {
    const keyboard = buildCompactOnIdleKeyboard(enabled);
    try {
      await enqueueSend(
        key,
        () => bot.telegram.editMessageReplyMarkup(getTelegramChatId(key), cbMsg.message_id, undefined, keyboard.reply_markup),
      );
    } catch (e) {
      const desc = checkIsApiError(e) ? getErrorDescription(e) : '';
      if (!/message is not modified/i.test(desc)) console.warn('[coi_cb] keyboard re-render failed:', desc || e);
    }
  }
}

bot.action('coi_on', (ctx) => handleCompactOnIdleCallback(ctx, true));
bot.action('coi_off', (ctx) => handleCompactOnIdleCallback(ctx, false));

/**
 * @description `/compact_summary` picker button. A REPEATED-USE picker, so it
 * re-renders its keyboard in place (the ✓ follows the new state) rather than being
 * consumed into a keyboard-less confirmation — mirrors `coi_on`/`coi_off`.
 */
async function handleCompactSummaryCallback(ctx: Context, enabled: boolean): Promise<void> {
  const key = await authoriseContext(ctx);
  if (!key) { await ctx.answerCbQuery(t('cb.access_denied')); return; }
  const isGeneral = checkIsGeneral(key);
  await withThreadLocale(key, async () => {
    await replyToThread(key, await applyCompactSummary(key, isGeneral, enabled));
  });
  await ctx.answerCbQuery();
  const cbMsg = ctx.callbackQuery?.message as Message | undefined;
  if (cbMsg) {
    const keyboard = buildCompactSummaryKeyboard(enabled);
    try {
      await enqueueSend(
        key,
        () => bot.telegram.editMessageReplyMarkup(getTelegramChatId(key), cbMsg.message_id, undefined, keyboard.reply_markup),
      );
    } catch (e) {
      const desc = checkIsApiError(e) ? getErrorDescription(e) : '';
      if (!/message is not modified/i.test(desc)) console.warn('[csum_cb] keyboard re-render failed:', desc || e);
    }
  }
}

bot.action('csum_on', (ctx) => handleCompactSummaryCallback(ctx, true));
bot.action('csum_off', (ctx) => handleCompactSummaryCallback(ctx, false));

/**
 * @description Rewrite the tapped picker into a final, keyboard-less confirmation:
 * a pick consumes the menu (the `/language` picker is the reference), so the same
 * button can't be acted on twice and the topic reads truthfully. Best-effort — a
 * failed edit only costs the relabel, never the state change that preceded it.
 */
async function consumeAutoContinueLimitsPicker(key: SessionKey, cbMsg: Message | undefined, text: string): Promise<void> {
  if (!cbMsg) return;
  try {
    await enqueueSend(key, () => bot.telegram.editMessageText(getTelegramChatId(key), cbMsg.message_id, undefined, text));
  } catch (e) {
    const desc = checkIsApiError(e) ? getErrorDescription(e) : '';
    if (!/message is not modified/i.test(desc)) console.warn('[acl_cb] picker relabel failed:', desc || e);
  }
}

/** Shared `acl_on` / `acl_off` tap handler: apply, then consume the picker. */
async function handleAutoContinueLimitsCallback(ctx: Context, enabled: boolean): Promise<void> {
  const key = await authoriseContext(ctx);
  if (!key) { await ctx.answerCbQuery(t('cb.access_denied')); return; }
  await withThreadLocale(key, async () => {
    const confirmation = await applyAutoContinueLimits(key, checkIsGeneral(key), enabled);
    await ctx.answerCbQuery();
    await consumeAutoContinueLimitsPicker(key, ctx.callbackQuery?.message as Message | undefined, confirmation);
  });
}

bot.action('acl_on', (ctx) => handleAutoContinueLimitsCallback(ctx, true));
bot.action('acl_off', (ctx) => handleAutoContinueLimitsCallback(ctx, false));

// «⏭ Skip once» in the `/auto_continue_limits` picker: drop THIS armed resume and
// leave the on/off setting alone. The episode is identified by the `fireAt` baked
// into the callback data, so an untouched older picker can never cancel a LATER
// episode (pure `getArmedRetrySkipDecision`); a stale tap changes nothing and says
// so. A later limit error arms again normally — `cancelApiRetry` only clears the
// record, it sets no "never again" flag.
bot.action(new RegExp(`^${skipArmedRetryCallbackPrefix}(\\d+)$`), async (ctx) => {
  const key = await authoriseContext(ctx);
  if (!key) { await ctx.answerCbQuery(t('cb.access_denied')); return; }
  const requestedFireAt = parseSkipArmedRetryCallbackData(`${skipArmedRetryCallbackPrefix}${ctx.match[1]}`);
  const decision = requestedFireAt === null
    ? 'expired'
    : getArmedRetrySkipDecision({ armedFireAt: getArmedLimitRetryFireAt(key), requestedFireAt });
  await withThreadLocale(key, async () => {
    if (decision === 'expired') {
      await ctx.answerCbQuery(t('autoContinueLimits.skipExpired'));
      return;
    }
    cancelApiRetry(key);
    // The skipped resume was the only thing to continue the work — the operator writes when to.
    await requestWakeUpEngine?.stopWakingForLimitWait(key);
    await ctx.answerCbQuery(t('autoContinueLimits.skipDone'));
    await consumeAutoContinueLimitsPicker(
      key,
      ctx.callbackQuery?.message as Message | undefined,
      t('autoContinueLimits.skippedNotice'),
    );
  });
});

// D1: a tap on an idle-compaction RE-ASKED question button. The original request
// was rejected server-side during the compaction, so the chosen option label is
// delivered to the (now compacted) session as a FRESH prompt, not answered.
bot.action(/^reask_(\d+)$/, async (ctx) => {
  const key = await authoriseContext(ctx);
  if (!key) { await ctx.answerCbQuery(t('cb.access_denied')); return; }
  const optIdx = parseInt(ctx.match[1], 10);
  const labels = reAskedQuestionOptions.get(keyToString(key));
  const label = labels?.[optIdx];
  if (!label) { await ctx.answerCbQuery(t('cb.no_pending_question')); return; }
  const adapter = getThreadAdapter(key);
  if (!adapter.checkIsActive(key)) { await ctx.answerCbQuery(t('agent.no_session')); return; }
  reAskedQuestionOptions.delete(keyToString(key));
  await ctx.answerCbQuery(label);
  await withThreadLocale(key, () => deliverActivePrompt(key, adapter, label));
});

/**
 * @description `/reminders` callbacks. Every one of them EDITS the tapped message
 * — the hub, the list, a card, the wizard and the created screen are all the same
 * message re-rendered, so a reminder session never litters the topic.
 *
 * The flat ids (`rmadd` / `rmhub` / `rmclose`) are registered before the prefixed
 * matchers, following the ordering rule the `/timezone` and `/model` pickers rely
 * on (Telegraf dispatches action patterns first-match-wins).
 */

// «➕ Add» → open the wizard IN the hub message.
bot.action(reminderAddCallback, async (ctx) => {
  const key = await authoriseContext(ctx);
  if (!key) { await ctx.answerCbQuery(t('cb.access_denied')); return; }
  const messageId = getCallbackMessageId(ctx);
  if (messageId === null) { await ctx.answerCbQuery(t('reminders.wizardExpiredCbAnswer')); return; }

  // At the cap the hub draws no «add», so a tap can only come from a keyboard
  // rendered before the cap was reached: say why and refresh the screen.
  const hubPlan = getReminderHubPlan({
    reminderCount: getThreadReminders(key).length,
    maxReminders: maxRemindersPerThread,
  });
  if (!hubPlan.isAddOffered) {
    await ctx.answerCbQuery(t('reminders.capReachedNotice', { limit: maxRemindersPerThread }));
    await renderReminderScreen(key, messageId, buildReminderHubScreen(key));
    return;
  }

  // An older hub message can still open a wizard while one is live; retire that
  // one first so only ever one wizard belongs to the topic.
  await cancelReminderWizard(key);
  const wizardState = createReminderWizardState(createReminderWizardId(Date.now()));
  reminderWizards.set(keyToString(key), { state: wizardState, messageId, textWait: null });
  await ctx.answerCbQuery();
  await renderReminderScreen(key, messageId, buildReminderWizardScreen(wizardState, null));
});

// «‹ Back» from the list → the hub.
bot.action(reminderHubCallback, async (ctx) => {
  const key = await authoriseContext(ctx);
  if (!key) { await ctx.answerCbQuery(t('cb.access_denied')); return; }
  const messageId = getCallbackMessageId(ctx);
  await ctx.answerCbQuery();
  if (messageId !== null) await renderReminderScreen(key, messageId, buildReminderHubScreen(key));
});

// «✕ Close» → relabel the screen and drop its keyboard.
bot.action(reminderCloseCallback, async (ctx) => {
  const key = await authoriseContext(ctx);
  if (!key) { await ctx.answerCbQuery(t('cb.access_denied')); return; }
  const messageId = getCallbackMessageId(ctx);
  await ctx.answerCbQuery();
  if (messageId !== null) await retireReminderScreen(key, messageId, t('reminders.closedNotice'));
});

// A list page (or a prev/next arrow). A now-empty list falls back to the hub.
bot.action(reminderListPageCallbackRe, async (ctx) => {
  const key = await authoriseContext(ctx);
  if (!key) { await ctx.answerCbQuery(t('cb.access_denied')); return; }
  const messageId = getCallbackMessageId(ctx);
  const page = parseReminderListPageCallback(ctx.match[0]);
  await ctx.answerCbQuery();
  if (messageId === null || page === null) return;
  await renderReminderScreen(
    key,
    messageId,
    buildReminderListScreen(key, page) ?? buildReminderHubScreen(key),
  );
});

// A list row → its card. A stale index (the list shrank since it was rendered)
// says so and reopens the list rather than opening a NEIGHBOURING reminder.
bot.action(reminderCardCallbackRe, async (ctx) => {
  const key = await authoriseContext(ctx);
  if (!key) { await ctx.answerCbQuery(t('cb.access_denied')); return; }
  const messageId = getCallbackMessageId(ctx);
  const reminderIndex = parseReminderCardCallback(ctx.match[0]);
  if (messageId === null || reminderIndex === null) { await ctx.answerCbQuery(); return; }
  const screen = buildReminderCardScreen(key, reminderIndex);
  if (screen === null) {
    await ctx.answerCbQuery(t('reminders.cardExpiredCbAnswer'));
    await renderReminderScreen(
      key,
      messageId,
      buildReminderListScreen(key, 0) ?? buildReminderHubScreen(key),
    );
    return;
  }
  await ctx.answerCbQuery();
  await renderReminderScreen(key, messageId, screen);
});

// «🗑 Delete» — there is deliberately NO extra confirmation step: the card the
// button sits on shows exactly what is about to go, so the card IS the
// confirmation. The reminder's own id is baked into the callback (never a
// positional index), so an old card can't delete whatever now occupies its row.
bot.action(reminderDeleteCallbackRe, async (ctx) => {
  const key = await authoriseContext(ctx);
  if (!key) { await ctx.answerCbQuery(t('cb.access_denied')); return; }
  const messageId = getCallbackMessageId(ctx);
  const reminderId = parseReminderDeleteCallback(ctx.match[0]);
  if (messageId === null || reminderId === null) { await ctx.answerCbQuery(); return; }

  const rows = toReminderListRows(getThreadReminders(key));
  const target = getReminderDeleteTarget(rows, reminderId);
  if (target.kind === 'notFound') {
    await ctx.answerCbQuery(t('reminders.deleteGoneCbAnswer'));
    await renderReminderScreen(
      key,
      messageId,
      buildReminderListScreen(key, 0) ?? buildReminderHubScreen(key),
    );
    return;
  }
  // Return to the page the deleted row was on (a shrunk list clamps the page).
  const listPage = getReminderCardBackPage(rows.findIndex((row) => row.id === target.row.id));
  await state.removeSchedule(target.row.id);
  schedulerEngine?.disarmJob(target.row.id);
  await ctx.answerCbQuery(t('reminders.deletedCbAnswer'));
  await renderReminderScreen(
    key,
    messageId,
    buildReminderListScreen(key, listPage) ?? buildReminderHubScreen(key),
  );
});

// Every wizard button. The wizard id baked into the callback is what makes an
// abandoned keyboard inert: a tap from a dead screen changes NO state.
bot.action(reminderWizardCallbackRe, async (ctx) => {
  const key = await authoriseContext(ctx);
  if (!key) { await ctx.answerCbQuery(t('cb.access_denied')); return; }
  const kStr = keyToString(key);
  const session = reminderWizards.get(kStr);
  const callbackData = ctx.match[0];

  // A tap from a DEAD screen (no wizard live, or a different wizard's id): say so
  // and strip THAT message's keyboard, because it can never be finished.
  if (
    session === undefined ||
    getReminderWizardTapRoute({ liveWizardId: session.state.wizardId, callbackData }) === 'foreign'
  ) {
    await ctx.answerCbQuery(t('reminders.wizardExpiredCbAnswer'));
    await stripReminderKeyboard(ctx);
    return;
  }

  const nowMs = Date.now();
  const transition = applyReminderWizardCallback({ state: session.state, callbackData, nowMs });
  // ONE choke point for the step-4 wait: any outcome that moves the wizard off the
  // text step disarms it here. «‹ Back» out of step 4 is the reachable case — the
  // screen goes back to asking for a TIME, and a wait left armed would swallow the
  // operator's next ordinary message and create the reminder from the picks they
  // went back to change.
  if (!checkIsReminderTextWaitKept(transition.kind)) session.textWait = null;
  switch (transition.kind) {
    case 'expired':
      // The live wizard, but an action from a step it has already left (a tap on a
      // stale VIEW of this same message). Re-render the current step instead of
      // stripping the keyboard — the wizard is alive and must stay finishable.
      await ctx.answerCbQuery(t('reminders.wizardExpiredCbAnswer'));
      await renderReminderScreen(key, session.messageId, buildReminderWizardScreen(session.state, null));
      return;
    case 'cancelled':
      reminderWizards.delete(kStr);
      await ctx.answerCbQuery();
      await retireReminderScreen(key, session.messageId, t('reminders.cancelledNotice'));
      return;
    case 'backToHub':
      reminderWizards.delete(kStr);
      await ctx.answerCbQuery();
      await renderReminderScreen(key, session.messageId, buildReminderHubScreen(key));
      return;
    case 'error':
      // The time was not committed: the screen re-renders WITH the reason, so
      // «today» plus a time that has gone by is said out loud rather than silently
      // rolled to tomorrow. The returned state is written back because it is not
      // always the one that came in — a DST-skipped time hands back the TIME step,
      // and a screen the session disagreed with would treat the next tap as stale.
      session.state = transition.state;
      await ctx.answerCbQuery(getReminderWizardErrorText(transition.code));
      await renderReminderScreen(
        key,
        session.messageId,
        buildReminderWizardScreen(transition.state, transition.code),
      );
      return;
    case 'render':
      session.state = transition.state;
      await ctx.answerCbQuery();
      await renderReminderScreen(key, session.messageId, buildReminderWizardScreen(session.state, null));
      return;
    case 'awaitText': {
      const picks = getReminderPicksFromState(transition.state);
      if (picks === null) {
        // Unreachable through the keyboards (`awaitText` is returned only after a
        // spec built cleanly from these very picks). Park the wizard back on the
        // time step rather than arming a wait that could not create anything.
        const timeStep = getReminderStateForStep(session.state, 'time');
        session.state = timeStep;
        await ctx.answerCbQuery(t('reminders.wizardExpiredCbAnswer'));
        await renderReminderScreen(key, session.messageId, buildReminderWizardScreen(timeStep, null));
        return;
      }
      session.state = transition.state;
      session.textWait = { picks, armedAtMs: nowMs, isClaimed: false };
      await ctx.answerCbQuery();
      await renderReminderScreen(key, session.messageId, buildReminderWizardScreen(session.state, null));
      return;
    }
    case 'createNow':
      // The text is already in hand — it arrived before the picked instant went
      // stale — so this replacement time pick finishes the reminder outright
      // instead of sending the operator back through step 4. The session is
      // retired by the create, so there is no state left to write back.
      await ctx.answerCbQuery();
      await createReminderFromWizard({
        key,
        session,
        spec: transition.spec,
        text: transition.text,
        nowMs,
      });
      return;
  }
});

bot.action(/^ccmode_(.+)$/, async (ctx) => {
  const key = await authoriseContext(ctx);
  if (!key) { await ctx.answerCbQuery(t('cb.access_denied')); return; }
  const target = ctx.match[1];
  if (!checkIsClaudeBackend(target)) { await ctx.answerCbQuery(t('cb.access_denied')); return; }
  // Compare against the EFFECTIVE backend (what /claude would start), same as
  // the command handler — the raw thread name may be a legacy default-adapter
  // fallback that never matches what a start would actually open.
  const current = resolveClaudeBackendName(key);
  if (target === current) { await ctx.answerCbQuery(t('cb.claudeMode_already')); return; }
  await ctx.answerCbQuery(t('cb.claudeMode_switching'));
  await replyToThread(key, await applyClaudeBackendSwitch(key, target));
  // Re-render the picker so the `✓` follows the new backend (mirrors effort_cb).
  const cbMsg = ctx.callbackQuery?.message as Message | undefined;
  if (cbMsg) {
    try {
      await enqueueSend(key, () => bot.telegram.editMessageReplyMarkup(
        getTelegramChatId(key), cbMsg.message_id, undefined,
        buildClaudeModeKeyboard(resolveClaudeBackendName(key)).reply_markup,
      ));
    } catch (e) {
      const desc = checkIsApiError(e) ? getErrorDescription(e) : '';
      if (!/message is not modified/i.test(desc)) console.warn('[ccmode_cb] re-render:', desc || e);
    }
  }
});

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

  // Re-render the picker so the `✓` follows the new mode (mirrors effort_cb).
  const cbMsg = ctx.callbackQuery?.message as Message | undefined;
  if (cbMsg) {
    const keyboard = buildDisplayModeKeyboard(config.i18nGroup, config.callbackPrefix, picked);
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
        console.warn(`[${config.logTag}] keyboard re-render failed:`, desc || e);
      }
    }
  }
}

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
}));

bot.action(/^agent_(.+)$/, async (ctx) => {
  const key = await authoriseContext(ctx);
  if (!key) { await ctx.answerCbQuery(t('cb.access_denied')); return; }
  const adapterName = ctx.match[1];
  try {
    // Resolve up-front so an unknown name throws into the catch (→ "unknown
    // agent") before any side effect, and so the toast can name the label.
    const adapter = getAdapter(adapterName);
    await ctx.answerCbQuery(t('cb.agent_switched', { label: adapter.label }));
    // One-tap start: switch + start the agent (was select-only — the user then
    // had to type /claude). `handleAgentStart` owns the General / binding /
    // already-active guards and the self-greeting ready-text suppression, and
    // `switchThreadAdapter` inside it persists the adapter choice.
    await handleAgentStart(key, adapterName);
    if (state.getBinding(key)) {
      await updatePinnedStatus(key).catch(() => {});
    }

    // Re-render the picker so the `✓` marker follows the newly-selected agent
    // instead of staying stuck on the previous one (B16, mirrors B12). The
    // start keeps the picker message visible (it is neither edited nor deleted),
    // so the stale marker would otherwise persist.
    const cbMsg = ctx.callbackQuery?.message as Message | undefined;
    if (cbMsg) {
      const keyboard = buildAgentKeyboard(getAvailableAdapters(), adapterName);
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
          console.warn('[agent_cb] keyboard re-render failed:', desc || e);
        }
      }
    }
  } catch {
    await ctx.answerCbQuery(t('cb.unknown_agent'));
  }
});

// Inline [resume] buttons posted by `handleSessionsList`. The button only
// carries the list index (`resume_<idx>`) because Telegram caps callback_data
// at 64 bytes; the full id lives in `threadSessionLists`. Shares the resume
// core with the digit-reply path via `resumeSessionByIndex`.
bot.action(/^resume_(\d+)$/, async (ctx) => {
  const key = await authoriseContext(ctx);
  if (!key) { await ctx.answerCbQuery(t('cb.access_denied')); return; }
  await ctx.answerCbQuery();
  const idx = Number(ctx.match[1]);
  // A pick from the button also closes pick-mode (mirrors a digit reply).
  awaitingSessionSelection.delete(keyToString(key));
  const result = await resumeSessionByIndex(key, idx, async () => {
    await replyToThread(key, t('session.expired'));
  });
  if (result !== null) await replyToThread(key, result);
});

bot.action(/^opt_(\d+)$/, async (ctx) => {
  const key = await authoriseContext(ctx);
  if (!key) { await ctx.answerCbQuery(t('cb.access_denied')); return; }
  const optNum = ctx.match[1];
  const adapter = getThreadAdapter(key);
  if (adapter.checkIsActive(key)) {
    markNeedsNewMessage(key);
    adapter.sendInput(key, optNum);
    await ctx.answerCbQuery(t('cb.sent_option', { option: optNum }));
  } else {
    await ctx.answerCbQuery(t('cb.agent_not_running'));
  }
});

bot.action(/^qa_(\d+)_(\d+)$/, async (ctx) => {
  const key = await authoriseContext(ctx);
  if (!key) { await ctx.answerCbQuery(t('cb.access_denied')); return; }
  const qIdx = parseInt(ctx.match[1], 10);
  const optIdx = parseInt(ctx.match[2], 10);
  const kStr = keyToString(key);
  const pending = pendingQuestions.get(kStr);
  if (!pending) { await ctx.answerCbQuery(t('cb.no_pending_question')); return; }
  // A button must belong to the question currently on screen. With sequential
  // posting we only ever show `currentIndex`, so a click for any other index is
  // a stale button from a question that was already answered/advanced.
  if (qIdx !== pending.currentIndex) {
    await ctx.answerCbQuery(t('cb.no_pending_question'));
    return;
  }
  const question = pending.data.questions[qIdx];
  if (!question || !question.options[optIdx]) {
    await ctx.answerCbQuery(t('cb.invalid_option'));
    return;
  }
  const selectedLabel = question.options[optIdx].label;
  await applyQuestionAnswer(key, [selectedLabel]);
  await ctx.answerCbQuery(selectedLabel);
});

/**
 * @description The single choke point for delivering a free-form prompt (text OR
 * voice) to a thread whose agent is already active. In order:
 *  1. If an OpenCode question is pending, route the reply: a bare digit in range
 *     ANSWERS that option (unchanged path); ANY other free-form input CANCELS
 *     the question and is delivered as a fresh prompt — a real message means
 *     "move on", never the question's answer.
 *  2. Else the G2 wedge backstop: an OpenCode turn the bot lost track of can
 *     still be wedged behind an open question (the `pendingQuestions` map empty,
 *     e.g. `question.asked` dropped at ask time). Abort the turn and tell the
 *     user before forwarding so the prompt doesn't queue behind it forever.
 *  3. Forward the prompt (a bare `/clear` first purges thread context + files).
 *
 * Claude/terminal never reach step 1 (their routing returns earlier in the text
 * handler, and `pendingQuestions`/`answerQuestion` are OpenCode-only). For them
 * `forwardPromptToAgent` interrupts the TUI selector itself.
 */
async function deliverActivePrompt(
  key: SessionKey,
  adapter: AgentAdapter,
  text: string,
  sentAtMs?: number,
  replyContext?: string,
): Promise<void> {
  // A genuine USER message (text or voice) — clear the compact-on-idle latch so
  // the next idle period can compact again (D2), whether it answers a pending
  // question or is a fresh prompt.
  noteThreadUserActivity(key);
  const pending = pendingQuestions.get(keyToString(key));
  if (pending && adapter.answerQuestion) {
    const currentQuestion = pending.data.questions[pending.currentIndex];
    const route = getQuestionReplyRoute(text, currentQuestion);
    if (route.kind === 'answer') {
      // Answering a pending question (bare digit) is a pick, not a prompt about
      // the quote — the reply context is deliberately dropped here.
      await applyQuestionAnswer(key, route.labels);
      return;
    }
    await cancelPendingQuestionAndForward(key, adapter, text, sentAtMs, replyContext);
    return;
  }

  // A bare `/clear` forwarded to the agent wipes its context (Claude TUI), so
  // the next prompt must re-carry the thread-context preamble. Reset the marker
  // before forwarding — the slash text itself never gets a preamble. The agent's
  // context is gone, so any intake files it might reference are now useless —
  // purge the thread's files dir in the same breath.
  if (text === forwardedClearCommand) {
    clearThreadContextMarker(key);
    await purgeThreadFiles(getDataDir(), key).catch((e) =>
      console.warn(`[file] purge on /clear failed for ${keyToString(key)}:`, e),
    );
  }

  // Backstop (G2): NO pendingQuestions entry, yet an OpenCode turn can still be
  // wedged behind an open question the bot lost track of (question.asked dropped
  // at ask time, or a restore that couldn't run). Forwarding now would queue the
  // prompt behind the dead turn forever, so if the adapter reports the session
  // wedged, abort the turn and tell the user the previous question was cancelled
  // — THEN forward. Strict check (open question for THIS session only), so a
  // genuinely streaming turn / live sub-agent is never aborted. Claude has no
  // such method → unchanged.
  if (await adapter.checkIsWedgedOnQuestion?.(key)) {
    adapter.sendSignal(key, 'SIGINT');
    await replyToThread(key, t('agent.question_cancelled_for_prompt'));
  }
  await forwardPromptToAgent(key, adapter, text, sentAtMs, { replyContext });
}

/**
 * @description Cancel a pending OpenCode question because the user sent free-form
 * input instead of answering it, then deliver that input as a fresh prompt. In
 * order: clear the bot's pending-question state, neutralize the stale buttons
 * message (edit it to a "cancelled" label so a late tap can't re-answer an
 * aborted question), abort the wedged OpenCode turn (`SIGINT` → `/session/:id/
 * abort`), post the "previous question cancelled" notice, then forward.
 *
 * The buttons-message edit runs through `runQuestionLifecycleOp` (same serializer
 * as the answer path) so it can't race a concurrent re-post-to-bottom. The
 * `messageId` + header are captured BEFORE clearing, since `clearPendingQuestion`
 * drops the state.
 */
async function cancelPendingQuestionAndForward(
  key: SessionKey,
  adapter: AgentAdapter,
  text: string,
  sentAtMs?: number,
  replyContext?: string,
): Promise<void> {
  const pending = pendingQuestions.get(keyToString(key));
  const cancelledMessageId = pending?.messageId ?? null;
  const cancelledQuestion = pending?.data.questions[pending.currentIndex];
  // Whether we relabel the on-screen question bubble itself to "❌ … cancelled"
  // below. When we do, that IS the cancellation notice — a second standalone
  // "previous question cancelled" line is pure noise (the reported triple
  // message). The standalone notice is kept only for the no-bubble case.
  const didLabelQuestionMessage = cancelledMessageId !== null && cancelledQuestion !== undefined;

  clearPendingQuestion(key);

  if (cancelledMessageId !== null && cancelledQuestion) {
    const header = cancelledQuestion.header || cancelledQuestion.question;
    await runQuestionLifecycleOp(key, () =>
      editThreadMessage(key, cancelledMessageId, t('agent.question_cancelled_msg_label', { header })),
    );
  }

  // Close the question on the OpenCode server too (not just the bot-local +
  // Telegram state above): an abandoned-but-still-open question keeps getting
  // re-found by `restoreOpenQuestion` (`GET /question` on every reattach) and
  // re-posted after a restart. Runs while the session is still active — the
  // SIGINT below then unblocks the wedged turn. No-op for Claude / no pending
  // question (the adapter guards both).
  adapter.rejectQuestion?.(key);
  adapter.sendSignal(key, 'SIGINT');
  // Exactly ONE cancellation notice: skip the standalone line when the question
  // bubble was already relabelled to cancelled above.
  if (!didLabelQuestionMessage) {
    await replyToThread(key, t('agent.question_cancelled_for_prompt'));
  }
  await forwardPromptToAgent(key, adapter, text, sentAtMs, { replyContext });
}

/**
 * @description Record one answer for the CURRENTLY shown OpenCode question and
 * either advance to the next unanswered question or, once every question is
 * answered, reply to the agent with the full answer matrix (S2). Shared by the
 * inline-button (`qa_`) and custom-text answer paths so both collect answers
 * locally instead of closing the request on the first answer with empties.
 */
async function applyQuestionAnswer(key: SessionKey, answerForCurrent: string[]): Promise<void> {
  // Serialized: an in-flight re-post (delete+re-send) must fully finish before
  // the answer reads `messageId` for its ✅-edit — otherwise the edit targets
  // a message the re-post just deleted (live 2026-06-10: "message to edit not
  // found" + the next question never reached the topic).
  await runQuestionLifecycleOp(key, () => applyQuestionAnswerInner(key, answerForCurrent));
}

async function applyQuestionAnswerInner(key: SessionKey, answerForCurrent: string[]): Promise<void> {
  const kStr = keyToString(key);
  const pending = pendingQuestions.get(kStr);
  if (!pending) return;

  const answeredQuestion = pending.data.questions[pending.currentIndex];
  const { nextState, action } = recordAnswerAndAdvance(pending, answerForCurrent);

  // Mark the answered question's message as done (the chosen answer in place).
  if (pending.messageId !== null && answeredQuestion) {
    await editThreadMessage(
      key,
      pending.messageId,
      `✅ ${answeredQuestion.header || answeredQuestion.question}: ${answerForCurrent.join(', ')}`,
    );
  }

  if (action.kind === 'submit') {
    const adapter = getThreadAdapter(key);
    clearPendingQuestion(key);
    if (adapter.answerQuestion) {
      // Load-bearing: send the REAL collected answers (all questions), not the
      // old per-answer matrix that blanked every other question.
      adapter.answerQuestion(key, action.matrix);
      markNeedsNewMessage(key);
    }
    return;
  }

  // More questions remain: persist the advanced state, then post the next one
  // (which re-owns `messageId`). DO NOT reply to the agent yet.
  setPendingQuestion(key, nextState);
  await postPendingQuestionAt(key);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Adapter event handlers (output / status / question / closed / error)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * @description Whether the thread's backend streams output the DM draft "cursor"
 * can accumulate. BOTH streaming backends qualify now: OpenCode marks
 * continuations directly (`openCodeAdapter` tracks `lastEmittedLength`), while
 * the Claude scrape adapter emits each poll's prose delta with NO continuation
 * meta — the DM transport synthesises the flag for it (`getDmDraftContinuation`,
 * gated on `checkAdapterOutputsDeltas`) so the answer accumulates into one
 * full-snapshot draft instead of finalizing per poll. Group mode never reaches
 * here (the group transport is the thin `queueOutput` path).
 */
function checkAdapterSupportsDraftStreaming(key: SessionKey): boolean {
  const name = getThreadAdapterNameRaw(key);
  return name === 'opencode' || name === 'claude' || name === claudeJsonStreamAdapterName;
}

/**
 * @description Whether the thread's adapter emits incremental deltas without
 * continuation meta (the Claude scrape adapter). The DM cursor reads this to
 * synthesise the continuation flag so Claude's per-poll prose deltas accumulate
 * into ONE draft rather than each finalizing as its own message.
 */
function checkAdapterOutputsDeltas(key: SessionKey): boolean {
  return getThreadAdapter(key).outputsDeltas === true;
}

function handleAgentOutput(key: SessionKey, output: string, meta?: OutboundHints): void {
  console.log(`[Bot] output ${keyToString(key)} (${output.length}): ${output.slice(0, 100)}...`);
  if (!output.trim()) return;
  traceAgentEmit('output', key, output);

  // Agent output = a turn is producing content (something to compress) AND the
  // topic is active — reset the compact-on-idle watchdog (F2). Both hooks self-
  // skip while THIS thread's own compaction streams (loop guard).
  markThreadTurnProducedOutput(key);
  noteThreadActivity(key);

  // Sub-agent chunk (`/subagent full`, S4): render it visibly marked and
  // OUTSIDE the parent reply's edit-in-place continuation chain — it must
  // never become `lastMessageId`/`lastMessageText` or flip `needsNewMessage`
  // (a child transcript as the continuation base would corrupt the parent's
  // accounting). Each flush is its own marked message (the prefix rides the
  // first chunk of a long split) — acceptable v1, `full` mode is opt-in. It
  // also deliberately does NOT delete the status frame: the parent is still
  // mid-turn while its sub-agent streams.
  if (meta?.isSubagent) {
    void sendStandaloneAgentMessage(key, `${buildSubagentOutputPrefix()} ${output}`);
    return;
  }

  // A scraped Claude question (S4): send it as its OWN message (id captured)
  // instead of the coalescing output cursor, then PIN it so the muted topic
  // fires a notification. `markNeedsNewMessage` so the agent's following answer
  // starts a fresh message below the question rather than appending onto it.
  // The unpin is the adapter's `questionGone` event (selector left) or
  // `clearPendingQuestion` (hard teardown). OpenCode questions never reach here
  // (they use the discrete `question` event + `postPendingQuestionAt`).
  if (meta?.isQuestion) {
    telegramOutbound.setActivity(key, 'idle');
    // The connector owns the whole sequence: land in-flight content ABOVE the
    // question, send it as its OWN pinnable message (`keepVisible`), and pin it
    // so the muted topic fires a notification.
    void telegramOutbound.deliver(key, { text: output, keepVisible: true }, meta);
    markNeedsNewMessage(key);
    return;
  }

  // Bot-side safety net for Claude-CLI "thinking" bursts that slip past
  // the adapter classifier (`checkIsStatusOutput`'s ≤200-char / ≤3-line
  // heuristic). When the diff between two polls happens to contain
  // 4+ progress ticks or pushes the chunk over 200 chars, the adapter
  // routes it as substantive `output` and the thread used to receive a
  // wall of spinner messages. The redirect into `handleAgentStatus`
  // sends the chunk through the same coalescer that single-line ticks
  // already use, so a long-thinking session edits ONE rolling message
  // instead of flooding the topic. Adapter-agnostic — same fix protects
  // OpenCode and any future adapter without touching their code.
  // See `progressLine.ts` for the regex and the chunk-purity rule.
  if (checkIsProgressChunk(output)) {
    // Collapse a redraw burst (many stacked ticks / increasing `/compact`
    // percentages) down to its latest frame before it reaches the
    // coalescer, so the rolling status message shows only the current
    // state instead of a growing wall of intermediate percentages.
    void handleAgentStatus(key, collapseProgressChunk(output));
    return;
  }

  // Recovery: a real answer means the session is working again → retire any
  // pinned logged-out notice and clear its one-notice guard so a LATER logout
  // notifies afresh. Placed AFTER the sub-agent / question / progress-chunk
  // early-returns. Also SKIP when this output is itself an error surface (Claude
  // `⎿ … /login` under `/tool_results full`, or OpenCode's `OpenCode error: …`
  // line): those flow as `output` too, and clearing on them would let a repeated
  // `session.error` clear-then-repin-and-RE-NOTIFY — the very double-notification
  // the one-per-episode guard exists to prevent.
  if (classifyAgentApiError(output, Date.now()) === null) clearAuthNotice(key);

  // The real answer is starting → resolve the thinking message per mode. Only
  // `minimal` removes its live indicator now (nothing should remain); `full` /
  // `short` leave their persisted message in place. No-op when no thinking
  // message exists (non-OpenCode threads, or a turn without reasoning).
  if (getThreadMessageState(key).thinkingMessageId !== null) {
    const thinkingMode = state.getDisplayPrefs(key).thinking;
    if (getThinkingAnswerStartAction(thinkingMode) === 'delete') clearThinkingMessage(key);
  }

  // Real output supersedes any not-yet-sent status frame. Without this,
  // a thinking-text edit queued ~50 ms before could still hit Telegram
  // and briefly overwrite the visible status with stale text after the
  // real output already landed. Clearing `pendingText` here is safe even
  // mid-flush: the loop re-checks `pendingText` after every send.
  getStatusCoalesceState(key).pendingText = null;

  const msgState = getThreadMessageState(key);
  const hadStatusMessage = msgState.statusMessageId !== null;

  if (hadStatusMessage) {
    const adapter = getThreadAdapter(key);
    if (adapter.outputsDeltas) msgState.needsNewMessage = true;
  }
  // S3: do NOT stop the typing loader on the first output. It is a persistent
  // "working" state now — the loader self-sustains while output is streaming OR
  // the agent is busy and self-stops only when the topic is drained + idle
  // (teardown paths clear it). Stopping here made the topic look idle mid-answer.
  // Delete UNCONDITIONALLY — not only when a frame is currently visible. A
  // liveness/scrape `sendStatusFrame` create may be mid-`await` with its id not
  // yet stored; calling `deleteStatusMessage` here bumps the frame generation so
  // that in-flight create discards its message instead of resurrecting it as an
  // orphan under the freshly-arrived output (the leftover-spinner half of #11).
  // When no id is tracked it's a cheap no-op delete that still bumps the gen.
  void deleteStatusMessage(key).catch(() => {});

  // Defense-in-depth backstop (flood 2026-06-16): suppress a FRESH permanent
  // output that is byte-identical to one recently sent to this thread, capping a
  // runaway regardless of which emit path produced it (the table flood was ~500
  // identical copies). Guard ONLY fresh permanent output: a continuation is the
  // OpenCode append chain (its tail is expected to repeat-then-extend), and
  // status/transient/question frames never reach here (separate events). Short
  // blocks pass (the helper's min-chars gate) so a legitimately-repeated short
  // answer is never eaten. On a suppressed duplicate: do NOT deliver, log once.
  if (!meta?.isContinuation && identicalOutputGuard.checkAndRecord(keyToString(key), output, Date.now())) {
    console.log(`[Bot] identical-output backstop suppressed a repeat ${keyToString(key)} (${output.length} chars)`);
    return;
  }

  // Hand the turn's content to the connector as SEMANTIC text plus advisory
  // hints — it decides rendering, splitting and pacing. Inside the Telegram
  // connector the routing is still selected once at boot by CHAT_MODE (the
  // OutputTransport chat-mode seam): group routes to the unchanged `queueOutput`
  // edit-in-place persist path; DM owns the draft-cursor manager (streaming tail
  // → draft, complete one-shot → finalize-then-post, Claude baseline →
  // queueOutput).
  void telegramOutbound.deliver(key, { text: output }, meta);

  // Bug #11: the agent may KEEP working after this chunk (which just deleted the
  // status frame). Arm the liveness loop so that once output streaming pauses
  // while still busy, the activity frame reappears — without waiting for the
  // next opportunistic scraped spinner (which may never come during a quiet
  // think). Claude-only; idempotent if already armed; self-disarms on idle.
  startClaudeLiveness(key);
}

/**
 * @description Adapter `status` event entry point. Wraps {@link handleAgentStatus}
 * (the pure send-a-frame primitive) with the two Claude-only liveness side
 * effects that must NOT happen for the liveness loop's own re-injected frames
 * (those call `handleAgentStatus` directly): record the scraped activity text as
 * the loop's preferred frame text, and arm the busy-state-driven loop (bug #11)
 * so the frame survives the gaps between scrape emits.
 */
function handleAdapterStatus(key: SessionKey, status: string): void {
  if (status.trim()) {
    const adapter = getThreadAdapter(key);
    if (adapter instanceof ClaudeCliAdapter) {
      getThreadMessageState(key).lastActivityText = status;
      startClaudeLiveness(key);
    }
  }
  void handleAgentStatus(key, status);
}

/**
 * @description Receive a `status` (thinking/spinner) event from the adapter.
 *
 * Does not send to Telegram directly — instead it parks the latest text in
 * the per-thread coalescer and (re)starts the flush loop if one isn't
 * already running. See {@link StatusCoalesceState} for the rationale: a
 * burst of status events from a busy agent used to translate 1:1 into
 * `editMessageText` operations on the rate-limiter FIFO, pushing real
 * `output` sends behind a wall of stale thinking frames.
 */
async function handleAgentStatus(key: SessionKey, status: string): Promise<void> {
  if (!status.trim()) return;
  // While an OpenCode question is pending the agent is BLOCKED waiting for the
  // user, so a status frame ("🔧 question…", tool spinner) shows no forward
  // progress — and it actively harms the layout: a new status message lands
  // below the question, the repost-to-bottom then moves the QUESTION below it,
  // trapping the frame ABOVE the (multi-)question stack. Its id becomes
  // `statusMessageId`, so every post-answer frame edits that stranded message far
  // above the answers instead of a fresh one at the bottom (live 2026-08-14).
  // Drop the frame + clear any parked text; a fresh status resumes
  // below the answered questions once the question resolves (`statusMessageId`
  // was nulled by `handleAgentQuestion`'s `deleteStatusMessage`, so the first
  // post-clear frame creates a new bottom-most message). No-op for Claude/
  // terminal — they hold no `pendingQuestions` entry.
  if (pendingQuestions.has(keyToString(key))) {
    getStatusCoalesceState(key).pendingText = null;
    return;
  }
  console.log(`[Bot] status ${keyToString(key)}: ${status.slice(0, 100)}`);
  traceAgentEmit('status', key, status);

  // S3: a status/thinking frame does NOT stop the typing state — both are
  // "working" cues and typing persists while the agent is busy. The loader
  // self-stops when the topic drains + idles; teardown paths clear it explicitly.

  // DM streaming v2 — status is ALWAYS the bottom-most message. If a content
  // cursor draft is still active, finalize it to a permanent message FIRST so the
  // status frame posts BELOW the latest content (never stranded above it). The
  // delete-status-on-output in `handleAgentOutput` is the other half: when content
  // resumes the stale status is removed and the next status re-posts below again.
  // Group mode now drains any coalesced-but-unsent output here too (S2), so the
  // status likewise lands below content rather than above a still-buffered chunk;
  // a fully-delivered turn is a no-op.
  await telegramOutbound.finalize(key);

  const c = getStatusCoalesceState(key);
  c.pendingText = status;
  // Don't start a flush while one is already running OR while a deferred
  // retry is armed for a 429 cooldown — in both cases the newest
  // `pendingText` is picked up by the running loop / the armed timer, and a
  // fresh flush would only re-defer and try to arm a second timer.
  if (!c.inFlight && !c.deferRetryTimer) {
    void flushStatusCoalescer(key);
  }
}

/**
 * @description Drain the per-thread status coalescer.
 *
 * Loops while `pendingText` keeps being refreshed by new `handleAgentStatus`
 * calls. Each iteration consults {@link getStatusFlushAction} for the current
 * `pendingText`, so:
 *
 *  - intermediate frames that arrive during a send are dropped (the loop
 *    only sees the latest one on its next iteration);
 *  - at most one send per thread is in flight at any time, regardless of
 *    how fast Claude's poller emits new frames;
 *  - if `handleAgentOutput` clears `pendingText`, the loop exits cleanly
 *    on the next iteration without queueing a stale edit;
 *  - an identical frame is skipped (no `400 "message is not modified"`);
 *  - while the chat is in a 429 cooldown the loop *defers*: it stops sending
 *    disposable spinner frames (which would burn the budget interactive
 *    replies and real output need) and re-arms once after the cooldown so the
 *    newest frame still shows.
 */
async function flushStatusCoalescer(key: SessionKey): Promise<void> {
  const c = getStatusCoalesceState(key);
  if (c.inFlight) return;
  c.inFlight = true;
  try {
    while (c.pendingText !== null) {
      const text = c.pendingText;
      const action = getStatusFlushAction({
        nextText: text,
        lastSentText: c.lastSentText,
        isRateLimited: checkIsRateLimited(getTelegramChatId(key)),
      });

      if (action === 'defer') {
        // Leave the newest frame in `pendingText`; resume once after the
        // cooldown lifts. Arm at most one timer — new events meanwhile only
        // refresh `pendingText` (see `handleAgentStatus`).
        armStatusDeferRetry(key, c);
        break;
      }

      // Consume the frame for both `send` and `skip`.
      c.pendingText = null;
      if (action === 'skip') continue;

      const sent = await sendStatusFrame(key, text);
      if (sent) c.lastSentText = text;
    }
  } finally {
    c.inFlight = false;
  }
}

/**
 * @description Arm a one-shot timer to resume a status flush deferred during
 * a 429 cooldown. Idempotent: if a retry is already armed, does nothing (the
 * newest `pendingText` will be picked up when it fires).
 */
function armStatusDeferRetry(key: SessionKey, c: StatusCoalesceState): void {
  if (c.deferRetryTimer) return;
  const waitMs = getRateLimitRemainingMs(getTelegramChatId(key)) + COOLDOWN_RETRY_SLACK_MS;
  c.deferRetryTimer = setTimeout(() => {
    c.deferRetryTimer = null;
    void flushStatusCoalescer(key);
  }, waitMs);
}

/**
 * @description Edit (or create) the thread's transient status message
 * with `status`. Lifted out of the old `handleAgentStatus` body so the
 * coalescer loop can call it once per latest-frame, instead of one
 * IIFE per incoming event.
 *
 * Returns `true` if the (first chunk of the) frame reached Telegram, so the
 * coalescer can record it as `lastSentText` and skip a redundant re-send.
 */
async function sendStatusFrame(key: SessionKey, status: string): Promise<boolean> {
  const msgState = getThreadMessageState(key);
  // Render-aware split: status frames are sent through `renderAgentHtml` below,
  // which inflates the source past Telegram's cap, so size chunks by their
  // rendered length (same measure the durable-output flush plan uses).
  const chunks = splitMessage(status, undefined, chunk => renderAgentHtml(chunk).length);
  // Capture the generation BEFORE any create: a `deleteStatusMessage` that races
  // an in-flight create bumps it, telling us to discard the just-created message
  // rather than resurrect `statusMessageId` as an orphan (the leftover-spinner
  // bug). Single source of truth for the frame across liveness tick, scrape
  // coalescer, and the output-supersede delete.
  const generationAtStart = msgState.statusFrameGeneration;
  // Store a freshly-created message id IFF no delete landed mid-create; otherwise
  // the message is already orphaned by that delete → remove it, store nothing.
  const storeOrDiscardCreatedFrame = async (createdId: number | null): Promise<boolean> => {
    if (createdId === null) return false;
    if (getStatusFrameStoreDecision(generationAtStart, msgState.statusFrameGeneration) === 'discard') {
      await deleteThreadMessage(key, createdId);
      return false;
    }
    setStatusFrameId(key, createdId);
    return true;
  };
  let landed = false;
  try {
    const firstRendered = renderAgentHtml(chunks[0]);
    if (msgState.statusMessageId) {
      const editId = msgState.statusMessageId;
      const ok = await editThreadMessage(key, editId, firstRendered, {
        parse_mode: 'HTML',
      });
      // A delete that landed during the edit already nulled (or replaced) the id;
      // don't claim the frame as live — let the create path below re-evaluate.
      if (ok && msgState.statusMessageId === editId) {
        landed = true;
      } else if (!ok) {
        // Edit failed (e.g. the message was deleted under us). Only null it if it
        // still points at the message we tried to edit — a concurrent delete may
        // already have moved it. Then create a replacement under the gen guard.
        if (msgState.statusMessageId === editId) setStatusFrameId(key, null);
        const id = await replyChunkWithFallback(key, firstRendered, chunks[0]);
        landed = await storeOrDiscardCreatedFrame(id);
      }
    } else {
      const id = await replyChunkWithFallback(key, firstRendered, chunks[0]);
      landed = await storeOrDiscardCreatedFrame(id);
    }
    for (let i = 1; i < chunks.length; i++) {
      const rendered = renderAgentHtml(chunks[i]);
      const id = await replyChunkWithFallback(key, rendered, chunks[i]);
      await storeOrDiscardCreatedFrame(id);
    }
  } catch (err) {
    console.error('[sendStatusFrame] Failed:', err);
  }
  // S3: a status/liveness frame landed below any pending question — bring the
  // question back to the bottom (debounced; no-op when no question is pending).
  if (landed) onThreadActivityWhileQuestionPending(key);
  return landed;
}

// ── Thinking (chain-of-thought) lifecycle — OpenCode (#1, #6) ────────────────
//
// SINGLE OWNER of the dedicated `thinkingMessageId`, kept separate from
// `statusMessageId` so the live "☁️ thinking …" indicator persists across tool
// status churn. The adapter emits a mode-AGNOSTIC `thinking` event; the bot
// applies the per-thread mode (`state.getDisplayPrefs(key).thinking`). The live
// indicator shows in ALL modes — the mode only controls what remains after
// reasoning ends. See `utils/thinkingRender.ts` for the pure mode×phase matrix.

/** Headroom (chars) reserved above the per-message cap for the rendered cloud
 * header + the truncation marker when a long `full`-mode reasoning body must be
 * tail-trimmed to fit one editable message. */
const thinkingDetailedHeaderHeadroom = 200;

/**
 * @description Render the thinking-frame body for a mode×phase, ready to pass to
 * `renderAgentHtml`. Pure-ish (only reads i18n): the live label is identical in
 * all modes; `full` appends the accumulated reasoning text (tail-trimmed to
 * one message); `done` collapses to the "💭 thought for {N}s" line for `short`.
 */
function buildThinkingFrameText(mode: DisplayVerbosityMode, payload: ThinkingEvent): string {
  if (payload.phase === 'done') {
    // Only `short` collapses to a duration line here; `full` keeps its last
    // live body (the caller does not re-render on `keep`).
    const seconds = formatThinkingDurationSeconds(payload.durationMs ?? 0);
    return t('thinking.thoughtForSeconds', { seconds: seconds.toString() });
  }
  const header = t('thinking.live');
  if (mode !== 'full' || !payload.text.trim()) return header;
  // Full mode: header + the accumulated reasoning. Keep the TAIL (the most
  // recent reasoning, what is "currently" streaming) when it overflows one
  // message, with a leading "…" so the trim is visible.
  const bodyBudget = MAX_MESSAGE_LEN - thinkingDetailedHeaderHeadroom;
  let body = payload.text;
  if (body.length > bodyBudget) body = `…${body.slice(body.length - bodyBudget)}`;
  return `${header}\n\n${body}`;
}

/**
 * @description Adapter `thinking` event entry point. Reads the per-thread
 * thinking {@link DisplayVerbosityMode}, decides the action via the pure
 * {@link getThinkingEventAction}, and drives the dedicated thinking message.
 *
 * - `editLiveLabel` / `editLiveDetailed` → coalesced live edit of one message.
 * - `collapseToDuration` → final edit to "💭 thought for {N}s", then persist.
 * - `keep` → leave the message as-is (full done), persist.
 *
 * "Persist" means clear `thinkingMessageId` so the NEXT response starts a fresh
 * thinking message — the existing one stays in the chat untouched.
 */
function handleAgentThinking(key: SessionKey, payload: ThinkingEvent): void {
  traceAgentEmit('thinking', key, payload.text);
  const mode = state.getDisplayPrefs(key).thinking;
  const action = getThinkingEventAction(mode, payload.phase);

  if (action === 'keep') {
    // Full done: nothing to send — the last live frame already shows the
    // full reasoning. Detach the id so the next response opens a fresh message.
    finishThinkingMessage(key);
    return;
  }

  if (action === 'holdForAnswer') {
    // Minimal done: leave the live indicator AND keep its id tracked so the
    // answer-start trigger (`handleAgentOutput`) can delete it. Nothing to send.
    return;
  }

  // `editLiveLabel` / `editLiveDetailed` (live) and `collapseToDuration` (short
  // done) all SEND a frame. The short-done frame is terminal: the flush detaches
  // the id only AFTER editing the collapse onto the same message.
  const frameText = buildThinkingFrameText(mode, payload);
  queueThinkingFrame(key, frameText, action === 'collapseToDuration');
}

/**
 * @description Detach the tracked thinking message id WITHOUT deleting the
 * message — it stays in the chat as the persisted reasoning record. The next
 * response's first `thinking` frame then creates a brand-new message. The
 * in-flight coalescer keeps the id it captured, so a frame still being sent
 * finishes against the right message.
 */
function finishThinkingMessage(key: SessionKey): void {
  setThinkingFrameId(key, null);
  const coalescer = thinkingCoalescers.get(keyToString(key));
  // Drop the dedup baseline so the NEXT response's first frame is never skipped
  // as "identical" against this response's last frame.
  if (coalescer) coalescer.lastSentHtml = null;
}

/**
 * @description Park the latest thinking frame in the coalescer and (re)start the
 * single-flight flush loop. Newest frame always wins; at most one edit is in
 * flight per thread. `isTerminal` marks the short-mode collapse frame — after it
 * drains, the flush detaches the tracked id so the next response is fresh.
 */
function queueThinkingFrame(key: SessionKey, frameText: string, isTerminal: boolean): void {
  const c = getThinkingCoalesceState(key);
  c.pendingHtml = renderAgentHtml(frameText);
  if (isTerminal) c.detachAfterDrain = true;
  if (!c.inFlight) void flushThinkingCoalescer(key);
}

/**
 * @description Drain the per-thread thinking coalescer: edit (or create) the
 * single thinking message with the latest pending frame. Identical frames are
 * skipped (no `400 "message is not modified"`); intermediate frames that arrive
 * during a send are dropped (the loop only sees the latest on its next pass).
 * When `detachAfterDrain` is armed (short-mode collapse), the tracked id is
 * detached only AFTER the final frame is edited onto the same message.
 */
async function flushThinkingCoalescer(key: SessionKey): Promise<void> {
  const c = getThinkingCoalesceState(key);
  if (c.inFlight) return;
  c.inFlight = true;
  try {
    while (c.pendingHtml !== null) {
      const html = c.pendingHtml;
      c.pendingHtml = null;
      if (html === c.lastSentHtml) continue;
      const sent = await sendThinkingFrame(key, html);
      if (sent) c.lastSentHtml = html;
    }
    if (c.detachAfterDrain) {
      c.detachAfterDrain = false;
      finishThinkingMessage(key);
    }
  } finally {
    c.inFlight = false;
  }
}

/**
 * @description Edit the thread's thinking message in place, or create it on the
 * first frame. The frame is pre-rendered HTML (one message — `full`-mode bodies
 * are tail-trimmed to fit). Returns `true` when the frame reached Telegram.
 */
async function sendThinkingFrame(key: SessionKey, renderedHtml: string): Promise<boolean> {
  const msgState = getThreadMessageState(key);
  try {
    if (msgState.thinkingMessageId !== null) {
      const editId = msgState.thinkingMessageId;
      const ok = await editThreadMessage(key, editId, renderedHtml, { parse_mode: 'HTML' });
      // A clear (session end / takeover) may have nulled the id mid-edit — only
      // treat the edit as live if the id still points at the message we edited.
      if (ok && msgState.thinkingMessageId === editId) return true;
      if (!ok && msgState.thinkingMessageId === editId) setThinkingFrameId(key, null);
      return false;
    }
    // Create the first frame. Capture the generation BEFORE the send: a
    // `clearThinkingMessage` racing this create bumps it, so we delete the
    // just-created message instead of resurrecting it as an orphan under a
    // "session ended" / question UI (the leftover-frame guard).
    const generationAtStart = msgState.thinkingFrameGeneration;
    const id = await replyChunkWithFallback(key, renderedHtml, renderedHtml);
    if (id === null) return false;
    if (msgState.thinkingFrameGeneration !== generationAtStart) {
      await deleteThreadMessage(key, id);
      return false;
    }
    setThinkingFrameId(key, id);
    return true;
  } catch (err) {
    console.error('[sendThinkingFrame] Failed:', err);
    return false;
  }
}

// ── Tool results — OpenCode (#8, S3) ─────────────────────────────────────────
//
// The adapter emits a mode-AGNOSTIC `toolResult` event for every completed
// tool call that produced output (the transient 🔧 status keeps flowing
// independently in all modes). The bot resolves the per-thread tool-results
// `DisplayVerbosityMode` here and renders the body as its OWN fresh message —
// never edited into the answer's continuation chain. See
// `utils/toolResultRender.ts` for the pure mode matrix + truncation caps.

/**
 * @description Adapter `toolResult` event entry point. `minimal` drops the body
 * (only the transient 🔧 status shows); `short` truncates
 * via the pure caps and appends a "… (truncated, /tool_results full)" footer;
 * `full` renders the whole body. The message is a header line `🔧 <tool> →`
 * (+ the tool's title when present, matching the transient status) over a
 * fenced code block.
 */
function handleAgentToolResult(key: SessionKey, payload: ToolResultEvent): void {
  traceAgentEmit('toolResult', key, payload.output);
  const action = getToolResultRenderAction(state.getDisplayPrefs(key).toolResults);
  if (action === 'drop') return;

  const { text, isTruncated } = action === 'truncated'
    ? getTruncatedToolResult(payload.output)
    : { text: payload.output, isTruncated: false };

  const header = payload.title ? `🔧 ${payload.tool} → ${payload.title}` : `🔧 ${payload.tool} →`;
  const footer = isTruncated ? `\n${t('toolResults.truncated_footer')}` : '';
  void sendStandaloneAgentMessage(key, `${header}\n${buildFencedToolResultBody(text)}${footer}`);
}

/**
 * @description Send a STANDALONE agent message — a tool-result body (S3) or a
 * marked sub-agent chunk (S4) — through the same render machinery agent output
 * uses: render-aware split (`splitMessage` re-balances the ``` fences across
 * chunks — a `full` body can exceed Telegram's cap) + `renderAgentHtml` with
 * plain-text fallback. Unlike `sendOutputImmediate` it deliberately never
 * touches `lastMessageId` / `lastMessageText` / `needsNewMessage`: a
 * standalone message must not become the base of the answer's edit-in-place
 * continuation chain (the in-flight reply keeps growing in its own message
 * above it).
 */
async function sendStandaloneAgentMessage(key: SessionKey, text: string): Promise<void> {
  const chunks = splitMessage(text, undefined, chunk => renderAgentHtml(chunk).length);
  for (const chunk of chunks) {
    await replyChunkWithFallback(key, renderAgentHtml(chunk), chunk);
  }
  // A standalone message is "other output" that landed below any pending
  // question — bring the question back to the bottom (debounced; no-op when
  // none pending).
  onThreadActivityWhileQuestionPending(key);
}

// ── Claude liveness loop (bug #11) ──────────────────────────────────────────
//
// SINGLE OWNER of the "recreate/keep-alive while busy" half of the
// `statusMessageId` lifecycle. The other half — "delete on real output" — stays
// in `handleAgentOutput`. They do not thrash because every liveness tick first
// checks `checkIsOutputStreaming`: while output owns the message the tick is a
// `noop`, so a just-deleted frame is recreated only once streaming pauses while
// the agent is still busy. The frame text rides the SAME coalescer + send path
// (`sendStatusFrame` via `handleAgentStatus`) as scraped spinner ticks, so the
// 429-aware defer/dedup machinery applies unchanged — no second send path.

/**
 * @description Build the liveness frame text via the pure
 * {@link buildClaudeLivenessFrameText}. Prefers the latest scraped activity line
 * (the whimsical `✻ Verb… (Ns · tokens)` the adapter emits as `status`), else a
 * neutral localized fallback, plus a live `m:ss` elapsed tail (S1 un-freeze) so
 * the frame visibly advances even when the scraped text is static — the elapsed
 * is the part the dedup's glyph-strip does NOT remove.
 */
function getClaudeLivenessFrameText(state: ThreadMessageState, nowMs: number): string {
  const glyph = CLAUDE_LIVENESS_GLYPHS[state.livenessGlyphIndex % CLAUDE_LIVENESS_GLYPHS.length];
  return buildClaudeLivenessFrameText({
    glyph,
    activityText: state.lastActivityText,
    fallbackText: t('agent.workingIndicator', { glyph }),
    workingSince: state.workingSince,
    nowMs,
  });
}

/**
 * @description One liveness tick: re-check busy, run the pure decision, execute
 * it on the shared status path, then re-arm or stop. Self-disarming — the timer
 * stops itself the instant the session goes idle, so the lifecycle handlers only
 * need to call {@link stopClaudeLiveness} for the hard teardown paths (stop /
 * close / quit / error), not for the normal busy→idle return.
 */
function runClaudeLivenessTick(key: SessionKey): void {
  const state = getThreadMessageState(key);
  const adapter = getThreadAdapter(key);
  // Gate to Claude: only its tmux-scrape path has the #11 gap (OpenCode liveness
  // is a separate plan). `checkIsBusy` is Claude's cheap sync footer signal.
  if (!(adapter instanceof ClaudeCliAdapter) || !adapter.checkIsBusy) {
    stopClaudeLiveness(key);
    return;
  }

  // S2 hard anti-hang net: the scraped TUI pane has not changed for ≥30s ⇒ the
  // agent is idle no matter what the footer busy signal says. Force-remove the
  // working frame, stop the loop, and LATCH suppression so no fresh frame is
  // created until the next prompt re-arms activity. A genuine long think keeps
  // the pane changing every second, so this never trips mid-think. Mirror the
  // proven question-takeover teardown (stop → clear pending → delete) so no
  // in-flight coalescer frame is stranded with no loop left to remove it.
  if (
    adapter.getMsSincePaneChange &&
    checkShouldForceIdleRemoval({
      msSincePaneChange: adapter.getMsSincePaneChange(key),
      idlePaneThresholdMs: claudeIdlePaneMs,
    })
  ) {
    state.statusIdleSuppressed = true;
    stopClaudeLiveness(key);
    getStatusCoalesceState(key).pendingText = null;
    void deleteStatusMessage(key).catch(() => {});
    return;
  }

  const now = Date.now();
  const isBusy = adapter.checkIsBusy(key);
  // S2: once Claude actually goes busy the busy-onset grace has served its
  // purpose — normal busy ticking owns the frame from here. Clearing it lets the
  // loop stop cleanly when the turn ends instead of lingering for the full grace.
  if (isBusy) state.busyOnsetArmedUntil = 0;
  const withinArmingGrace = !isBusy && state.busyOnsetArmedUntil > now;
  const idleTransition = state.wasBusy && !isBusy;
  state.wasBusy = isBusy;

  const action = getClaudeLivenessAction({
    isBusy,
    hasStatusFrame: state.statusMessageId !== null,
    isOutputStreaming: checkIsOutputStreaming(key),
    idleTransition,
    isSuppressed: state.statusIdleSuppressed,
  });

  switch (action) {
    case 'create':
    case 'tick': {
      // Decouple the SEND cadence from the 1s idle-CHECK cadence: re-render the
      // working frame at most every `claudeWorkingStatusRefreshMs` so the live
      // `m:ss` elapsed advances visibly without a per-second editMessageText
      // flood. A `create` (no frame yet) always sends so the frame appears
      // immediately. The push rides the SAME coalescer scraped ticks use
      // (429-aware, dedups identical text) — no second send path. S3: under a
      // live 429 cooldown the throttle stretches to the remaining cooldown so the
      // frame stops adding edits to an already-throttling chat (it was ~half the
      // 429-storm traffic).
      if (
        checkShouldSendLivenessFrame({
          isCreate: action === 'create',
          msSinceLastSent: now - state.lastLivenessSentAt,
          refreshMs: claudeWorkingStatusRefreshMs,
          remainingCooldownMs: getRateLimitRemainingMs(getTelegramChatId(key)),
        })
      ) {
        state.livenessGlyphIndex = (state.livenessGlyphIndex + 1) % CLAUDE_LIVENESS_GLYPHS.length;
        state.lastLivenessSentAt = now;
        void handleAgentStatus(key, getClaudeLivenessFrameText(state, now));
      }
      break;
    }
    case 'delete':
      void deleteStatusMessage(key).catch(() => {});
      break;
    case 'noop':
      break;
  }

  // Stop only when the session is truly idle, no frame is tracked, AND the status
  // coalescer is fully drained. A coalescer send sets `statusMessageId` only after
  // its network await, so stopping while one is in flight (or queued / deferred
  // behind a 429) would strand the just-sent frame with no loop to delete it on
  // idle — the orphan that lingers until the next message (live 2026-06-29: a hung
  // "☁️ thinking …" whose final frame landed exactly as the agent went idle).
  // While busy, a frame lingers (mid-delete), or a send is pending, keep ticking
  // so the next tick refreshes / removes it. Never leave a frame stuck post-idle.
  const coalescer = getStatusCoalesceState(key);
  const statusSendPending =
    coalescer.inFlight || coalescer.pendingText !== null || coalescer.deferRetryTimer !== null;
  if (
    getClaudeLivenessShouldStop({
      isBusy,
      hasStatusFrame: state.statusMessageId !== null,
      statusSendPending,
      withinArmingGrace,
    })
  ) {
    stopClaudeLiveness(key);
  } else {
    armClaudeLivenessTimer(key, state);
  }
}

/**
 * @description (Re)arm the single per-thread liveness timer. Idempotent on the
 * timer handle: clears any existing one first so two callers can't stack timers.
 */
function armClaudeLivenessTimer(key: SessionKey, state: ThreadMessageState): void {
  if (state.livenessTimer) clearTimeout(state.livenessTimer);
  state.livenessTimer = setTimeout(() => {
    state.livenessTimer = null;
    withThreadLocale(key, () => runClaudeLivenessTick(key));
  }, CLAUDE_LIVENESS_TICK_MS);
  // Don't keep the event loop alive just for a spinner.
  state.livenessTimer.unref?.();
}

/**
 * @description Start the liveness loop for a Claude thread. Called on every
 * proof of activity (a scraped `status`, or an `output` chunk that may be
 * followed by more work). Idempotent: if a timer is already armed the running
 * loop owns the rest, so this returns without touching its edge-tracking
 * (`wasBusy`) — clobbering it here could mask a busy→idle edge the tick is about
 * to act on. Seeds `wasBusy = true` only when arming a FRESH timer: the caller
 * just observed activity, so the next tick should treat an idle reading as a
 * genuine busy→idle transition. The first tick runs on the NEXT cadence, not
 * immediately — the triggering event already painted the frame.
 *
 * Arming a FRESH timer is a new busy turn, so it (re)bases the working-status
 * elapsed (`workingSince`) and clears the S2 idle-suppress latch — genuine new
 * activity re-enables the working frame after a pane-static force-removal.
 *
 * `reason` (S2) distinguishes the two arm triggers:
 *  - `'activity'` (default; scrape `output`/`status`) — busy work was just
 *    observed, so seed `wasBusy = true` (the next idle reading is a real
 *    busy→idle edge) and no grace is needed.
 *  - `'busyOnset'` (a prompt was just forwarded) — Claude may not have flipped
 *    busy yet, so seed `wasBusy = false` and open a {@link claudeBusyOnsetGraceMs}
 *    arming grace so the first idle tick does not self-stop the loop before the
 *    think starts.
 */
type ClaudeLivenessArmReason = 'activity' | 'busyOnset';

function startClaudeLiveness(key: SessionKey, reason: ClaudeLivenessArmReason = 'activity'): void {
  const adapter = getThreadAdapter(key);
  if (!(adapter instanceof ClaudeCliAdapter) || !adapter.checkIsBusy) return;
  const state = getThreadMessageState(key);
  if (state.livenessTimer) return;
  if (reason === 'busyOnset') {
    state.wasBusy = false;
    state.busyOnsetArmedUntil = Date.now() + claudeBusyOnsetGraceMs;
  } else {
    state.wasBusy = true;
    state.busyOnsetArmedUntil = 0;
  }
  state.workingSince = Date.now();
  state.statusIdleSuppressed = false;
  armClaudeLivenessTimer(key, state);
}

/**
 * @description Stop and clear the thread's liveness timer (no leaked timers).
 * Called on every hard lifecycle teardown so the loop can't recreate a frame
 * after the session is gone. Leaves `statusMessageId` alone — the caller's own
 * `deleteStatusMessage` owns removing the visible frame.
 */
function stopClaudeLiveness(key: SessionKey): void {
  const state = threadMessageStates.get(keyToString(key));
  if (!state?.livenessTimer) return;
  clearTimeout(state.livenessTimer);
  state.livenessTimer = null;
  state.wasBusy = false;
  // The turn is over — clear the elapsed base so the next turn restarts at 0:00,
  // and drop any busy-onset arming grace so a teardown can't leave it armed.
  state.workingSince = null;
  state.busyOnsetArmedUntil = 0;
}

// ── Sub-agent status (OpenCode minimal/short) — dedicated self-updating message ─
//
// SINGLE OWNER of the dedicated `subagentStatusMessageId`, kept separate from
// `statusMessageId` so the "🤖 sub-agent: <title> · m:ss" working indicator is
// ONE message edited in place — not the flood the shared transient status
// produced (a NEW `sendMessage` per child-text burst). The adapter emits a
// mode-AGNOSTIC `subagentStatus` event; the bot resolves the lifecycle via the
// pure `getSubagentStatusAction` and ticks an elapsed counter every
// `subagentTickMs`. Only minimal/short produce this event (`/subagent full`
// streams the child transcript as its own chunks — the stream IS the indicator).

/**
 * @description Edit the open sub-agent status message with the current elapsed
 * time. Best-effort: a failed edit just retries on the next tick. No-op (and
 * stops the timer) once the message is gone, so a racing teardown can't leave a
 * self-re-arming timer running.
 */
async function refreshSubagentStatus(key: SessionKey): Promise<void> {
  const state = getThreadMessageState(key);
  const messageId = state.subagentStatusMessageId;
  if (messageId === null) return;
  const elapsedMs = Date.now() - (state.subagentStartedAt ?? Date.now());
  const text = buildSubagentElapsedText(state.subagentTitle, elapsedMs);
  // S1' coalescing: skip when an edit is already draining the pacer, or when the
  // text is unchanged from the last edit we DECIDED to enqueue. Both guards, and
  // recording the decision synchronously BELOW (not after the send resolves), are
  // what keep a burst of same-second `subagentStatus{active:true}` refreshes from
  // stacking hundreds of identical `editMessageText` closures into the per-thread
  // FIFO — that backlog drained one every 2s and head-of-line-blocked the agent's
  // own answer, hanging the topic (live 2026-08-07).
  if (!checkShouldEnqueueSubagentStatus({
    nextText: text,
    lastEnqueuedText: state.lastSubagentText,
    isEditInFlight: state.subagentEditInFlight,
  })) return;
  state.subagentEditInFlight = true;
  // Record the DECISION synchronously (before the pacer-delayed await) so
  // concurrent same-text refreshes are suppressed immediately, not only once the
  // send finally lands.
  state.lastSubagentText = text;
  try {
    const sent = await editThreadMessage(
      key,
      messageId,
      renderAgentHtml(text),
      { parse_mode: 'HTML' },
    );
    // Guard the post-await mutations against a close+reopen that swapped the
    // frame WHILE this edit was draining the pacer: `lastSubagentText` /
    // `subagentEditInFlight` now belong to a DIFFERENT frame that owns its own
    // state (reset on its open), so clobbering them here would drop its dedup or
    // permit a duplicate edit. Only touch them while THIS frame is still open.
    if (state.subagentStatusMessageId !== messageId) return;
    // A GENUINE (non-benign) failure clears the decision record so the next tick
    // retries — `editThreadMessage` already treats "message is not modified" as
    // success, so a benign 400 keeps the dedup and never churns.
    if (!sent) state.lastSubagentText = null;
  } finally {
    if (state.subagentStatusMessageId === messageId) state.subagentEditInFlight = false;
  }
}

/**
 * @description Arm (re-arm) the unref'd self-re-arming tick timer that re-edits
 * the sub-agent status message with the updated elapsed time. Mirrors
 * {@link armClaudeLivenessTimer}: clears any existing timer first (single armed
 * timer), unref'd so it never holds the event loop open, and self-stops once
 * the message is gone (the next tick sees a null id and returns).
 */
function armSubagentTimer(key: SessionKey, state: ThreadMessageState): void {
  if (state.subagentTimer) clearTimeout(state.subagentTimer);
  state.subagentTimer = setTimeout(() => {
    state.subagentTimer = null;
    if (state.subagentStatusMessageId === null) return;
    // S2 safety net: a frame whose owning session is no longer active, or that
    // has outlived any realistic delegation, is CLOSED instead of re-armed — a
    // server-side session death emits no clean idle/finish, so without this the
    // timer would churn the frame forever (live incident 2026-08-03). A silent
    // death leaves `checkIsActive` true, so the age cap is the load-bearing net.
    if (
      checkShouldExpireSubagentStatus({
        startedAtMs: state.subagentStartedAt,
        nowMs: Date.now(),
        maxAgeMs: subagentStatusMaxAgeMs,
        isOwningSessionActive: getThreadAdapter(key).checkIsActive(key),
      })
    ) {
      clearSubagentStatus(key);
      return;
    }
    void withThreadLocale(key, () => refreshSubagentStatus(key).finally(() => {
      // Re-arm only while the message is still open — a close that landed during
      // the edit nulls the id, so we stop instead of resurrecting the loop.
      if (state.subagentStatusMessageId !== null) armSubagentTimer(key, state);
    }));
  }, subagentTickMs);
  state.subagentTimer.unref?.();
}

/**
 * @description Tear down a thread's sub-agent status message + timer. Called on
 * the delegation's end (`active:false`) and on every hard teardown that already
 * clears thinking/status (close, stop, error, question takeover) so the
 * "working" indicator never lingers after the work it described is gone.
 * Best-effort delete; the in-memory fields are nulled synchronously so a racing
 * emit can't resurrect a stale frame.
 */
function clearSubagentStatus(key: SessionKey): void {
  const state = getThreadMessageState(key);
  if (state.subagentTimer) {
    clearTimeout(state.subagentTimer);
    state.subagentTimer = null;
  }
  const id = state.subagentStatusMessageId;
  setSubagentFrameId(key, null);
  state.subagentStartedAt = null;
  state.subagentTitle = null;
  state.lastSubagentText = null;
  // Reset the coalescing flag so a later frame is never wedged silent by a
  // teardown that landed mid-edit (an in-flight edit's own `finally` also
  // clears it; this covers the close-before-resolve race).
  state.subagentEditInFlight = false;
  if (id !== null) deleteThreadMessage(key, id).catch(() => {});
}

/**
 * @description Adapter `subagentStatus` event entry point (OpenCode
 * minimal/short). Drives the dedicated sub-agent status message via the pure
 * {@link getSubagentStatusAction}:
 *
 * - `open`    — record start time + title, create the message, arm the tick timer.
 * - `refresh` — update the sticky title (when the event carried one), re-edit
 *   with the current elapsed time, keep the timer armed.
 * - `close`   — {@link clearSubagentStatus} (stop timer + delete message).
 * - `noop`    — a defensive `active:false` with nothing open; do nothing.
 *
 * Wrapped so async sends never throw back into the EventEmitter (mirrors
 * `handleAgentQuestion`).
 */
function handleSubagentStatus(key: SessionKey, payload: SubagentStatusEvent): void {
  const state = getThreadMessageState(key);
  // `subagentStartedAt` is set synchronously when an `open` begins (before its
  // `await`), so a second `active:true` arriving while the first create is still
  // in flight resolves to `refresh` (a harmless no-op until the id lands) rather
  // than opening a SECOND message that orphans the first.
  const hasMessage = state.subagentStatusMessageId !== null || state.subagentStartedAt !== null;
  const action = getSubagentStatusAction({ hasMessage, eventActive: payload.active });

  if (action === 'noop') return;
  if (action === 'close') {
    clearSubagentStatus(key);
    return;
  }

  (async () => {
    try {
      if (action === 'open') {
        state.subagentStartedAt = Date.now();
        state.subagentTitle = payload.title;
        // Fresh frame — clear the dedup record + coalescing flag so the first
        // tick's edit lands even if it renders the same text as a prior (cleared)
        // frame, and a stale in-flight flag can't wedge the new frame silent.
        state.lastSubagentText = null;
        state.subagentEditInFlight = false;
        const text = buildSubagentElapsedText(state.subagentTitle, 0);
        const id = await replyToThread(key, renderAgentHtml(text), { parse_mode: 'HTML' });
        if (id === null) return;
        // A close (teardown) may have landed during the create — don't leave the
        // just-created message orphaned and untracked; remove it.
        if (state.subagentStartedAt === null) {
          deleteThreadMessage(key, id).catch(() => {});
          return;
        }
        setSubagentFrameId(key, id);
        armSubagentTimer(key, state);
        return;
      }
      // refresh: keep the sticky title (overwrite only with a non-null one).
      if (payload.title !== null) state.subagentTitle = payload.title;
      await refreshSubagentStatus(key);
      if (state.subagentStatusMessageId !== null && state.subagentTimer === null) {
        armSubagentTimer(key, state);
      }
    } catch (err) {
      console.error('[handleSubagentStatus] Failed:', err);
    }
  })();
}

function handleAgentQuestion(key: SessionKey, questionData: OpenCodePendingQuestion): void {
  console.log(`[Bot] question ${keyToString(key)} (${questionData.requestId}): ${questionData.questions.length}`);
  // Idempotent across restart: this handler ALSO fires from the adapter's
  // `restoreOpenQuestion` on reattach (the server still has the question open).
  // If the SAME question (matched by requestId) is already persisted,
  // `restorePendingQuestions` re-arms its original buttons + any local
  // multi-question progress, and `restoreOpenQuestion` already re-set the
  // adapter's own `session.pendingQuestion` BEFORE emitting — so re-posting
  // here would only duplicate the question message in the topic. Skip it. A
  // fresh LIVE question isn't persisted until this handler runs, so this never
  // skips a genuinely new one.
  const persistedQuestion = state.getPendingQuestions()[keyToString(key)];
  if (persistedQuestion && persistedQuestion.data.requestId === questionData.requestId) {
    return;
  }
  // A pending status frame is now stale — the question UI replaces it. Stop the
  // liveness loop first so it can't recreate a frame under the question prompt
  // (Claude-only; a no-op for OpenCode threads, which never arm it).
  stopClaudeLiveness(key);
  getStatusCoalesceState(key).pendingText = null;
  deleteStatusMessage(key).catch(() => {});
  // The question UI takes over — remove any live thinking frame so it doesn't
  // sit above the prompt (it would otherwise persist past the answer).
  clearThinkingMessage(key);
  // A question UI supersedes the sub-agent "working" line — remove it too.
  clearSubagentStatus(key);
  // The question UI takes over mid-stream — FINALIZE any in-flight content (DM:
  // the live draft so its already-accumulated text lands as a permanent message
  // above the prompt, not dropped; the finalize IS the persistence — no parallel
  // queueOutput in DM. Group: drain any coalesced-but-unsent output so the answer
  // lands above the prompt rather than behind it, S2). Fire-and-forget; a
  // fully-delivered turn is a no-op for both.
  void telegramOutbound.finalize(key);
  // The question UI replaces the "working" cue — stop the typing loader.
  telegramOutbound.setActivity(key, 'idle');

  // Audit S13 / #31: register the pending question BEFORE the async
  // network round-trip. A user hammering an inline button right after
  // the question arrives used to find an empty `pendingQuestions` entry
  // (the network reply was still in flight) and get a confusing
  // "no pending question" answerCbQuery. The messageId is patched in
  // after `replyToThread` resolves.
  //
  // S2: post ONLY the first question. The rest are shown one at a time as the
  // user answers, with answers collected locally (`answers`) and replied to the
  // agent as a full matrix once every question is answered. Posting all at once
  // was the bug: answering the first reply-closed the request with empty
  // answers for the rest.
  setPendingQuestion(key, {
    data: questionData,
    messageId: null,
    answers: new Array(questionData.questions.length).fill(null),
    currentIndex: 0,
  });

  void runQuestionLifecycleOp(key, () => postPendingQuestionAt(key));
}

/**
 * @description Render + send ONE OpenCode question (the one at the pending
 * state's `currentIndex`) as the newest thread message, then patch the
 * resulting message id back onto the pending state (in memory + persisted).
 *
 * This is the SINGLE owner of the pending `messageId` for an on-screen
 * transition — the initial post (S1), the "advance to the next question" step
 * (S2), and the "re-post at the bottom" step (S3) all route through here so
 * they never double-set or orphan the id.
 *
 * S1: option descriptions are rendered under each numbered label in the body
 * via {@link buildQuestionBodyLines}; the inline buttons stay label-only.
 * Callback ids stay `qa_<qIdx>_<optIdx>` against the absolute question index so
 * a restored old button still resolves.
 *
 * **Why the send does NOT go through `ConnectorOutbound.deliver`** (unlike the
 * sibling Claude question path, which does):
 *  - `deliver` renders through `renderAgentHtml` and sends as HTML. This body is
 *    classic Markdown escaped by `escapeMarkdown`, so the backslashes it adds
 *    would reach the user literally (`get\_user\_id`, a broken
 *    `\<code>…\</code>`). Re-escaping it for HTML instead is a different render,
 *    which cannot be proven without a live Telegram smoke.
 *  - `deliver` resolves `void`, and this path is the single owner of the pending
 *    `messageId`: it persists it (so buttons still resolve after a restart),
 *    registers it, deletes the message when the question advanced mid-send, and
 *    pins ONLY after that staleness re-check — `deliverStandalone` pins as soon
 *    as the send returns, with no such check.
 * Closing this properly means moving bot-authored Markdown templates onto the
 * connector's dialect, which is a follow-up plan, not a question-path change.
 */
async function postPendingQuestionAt(key: SessionKey): Promise<void> {
  const kStr = keyToString(key);
  const pending = pendingQuestions.get(kStr);
  if (!pending) return;

  const qIdx = pending.currentIndex;
  const question = pending.data.questions[qIdx];
  if (!question) return;

  // Single owner of `messageId` per transition: this post is about to put the
  // question at the bottom, so any armed re-post is moot — and a re-post that
  // fired DURING our send would read the previous question's `messageId` and
  // delete the wrong message (live race 2026-06-10: the answered-Q1 "✅"
  // confirmation vanished and Q2 was posted twice). Cancel the timer and hold
  // the in-flight flag until the new id is stored.
  const repostState = getQuestionRepostState(key);
  if (repostState.repostTimer) {
    clearTimeout(repostState.repostTimer);
    repostState.repostTimer = null;
  }
  repostState.isPostInFlight = true;

  // Ask the connector rather than assuming. The body ALWAYS enumerates the
  // options as numbered text (`buildQuestionBodyLines`), so a surface with no
  // tappable controls loses only the tap — the user answers with the index,
  // which `getOpenCodeReplyRoute` already accepts. Telegram says yes; a tracker
  // comment stream will not. The keyboard itself is the connector's to build:
  // the button width cap and its elision rule are Telegram's, not the core's.
  const keyboard = telegramOutbound.capabilities.tappableOptions
    ? buildQuestionOptionsKeyboard(question, (optionIndex) => `qa_${qIdx}_${optionIndex}`)
    : undefined;

  try {
    let messageId = await replyToThread(
      key,
      buildQuestionBodyLines(question, escapeMarkdown).join('\n'),
      buildKeyboardExtra(keyboard, { parse_mode: 'Markdown' }),
    );
    if (!messageId) {
      // Markdown rejected — retry plain.
      messageId = await replyToThread(
        key,
        buildQuestionBodyLinesPlain(question).join('\n'),
        buildKeyboardExtra(keyboard),
      );
    }

    if (messageId !== null) {
      // Patch the messageId on the existing entry (it may already have been
      // cleared/advanced by an answer callback firing in between). Route
      // through `setPendingQuestion` so the persisted copy gets the live
      // button message id too — that id is what lets the OLD buttons resolve
      // after a restart, and what S3 deletes when re-posting to the bottom.
      const existing = pendingQuestions.get(kStr);
      if (existing && existing.data === pending.data && existing.currentIndex === qIdx) {
        existing.messageId = messageId;
        setPendingQuestion(key, existing);
        markQuestionMessageSent(key, messageId);
        // Pin the question so the muted topic fires a notification (S2). The
        // "unpin previous if different" step inside also retires the prior pin on
        // a Q1→Q2 advance (Q1 stays as a "✅" message but loses its pin).
        // Capability-gated: a surface with no pin just leaves the question as an
        // ordinary message, which is all a tracker comment can be anyway.
        if (telegramOutbound.capabilities.pinMessages) void pinThreadQuestion(key, messageId);
      } else {
        // The question advanced / was answered while our send sat in the
        // queue (a fast digit reply can beat the post — seen live 2026-06-10:
        // a stale unanswered-looking "❓" landed and lingered). The message we
        // just sent describes a question that no longer exists — remove it.
        void deleteThreadMessage(key, messageId);
      }
    }
  } catch (err) {
    console.error('[postPendingQuestionAt] Failed:', err);
  } finally {
    repostState.isPostInFlight = false;
  }
}

/**
 * @description Claude `questionGone` event — the scraped TUI selector left the
 * screen (answered / dismissed), so remove its pin. This is Claude's unpin path
 * for the normal answer case: Claude has no `pendingQuestions` entry, so it can't
 * lean on `clearPendingQuestion` (which OpenCode uses). The hard-teardown paths
 * (stop / quit / unbind / closed / error) still route through
 * `clearPendingQuestion` and unpin there for BOTH backends.
 */
function handleQuestionGone(key: SessionKey): void {
  void unpinThreadQuestion(key);
}

function handleAgentClosed(key: SessionKey): void {
  // Session is gone — drop any not-yet-sent output AND status frame so they
  // don't surface after the "session ended" notice (the trailing-output bug:
  // a 429 backlog could let queued deltas land seconds after the close).
  clearThreadQueues(key);
  // Session gone — stop the liveness loop so it can't recreate a frame after
  // the close (it would otherwise outlive the session via its self-re-arm).
  stopClaudeLiveness(key);
  deleteStatusMessage(key).catch(() => {});
  // A closed session won't finish reasoning — remove a live thinking frame so it
  // doesn't linger above the "session ended" notice.
  clearThinkingMessage(key);
  // A closed session has no running delegation — remove the sub-agent status.
  clearSubagentStatus(key);
  clearPendingQuestion(key);
  // A closed session has nothing to resume — drop any armed retry silently.
  cancelApiRetry(key);
  clearAuthNotice(key); // session closed → retire any pinned logged-out notice
  // A closed session has nothing to compact — drop the idle watchdog + any arm.
  clearThreadCompaction(key);
  const adapter = getThreadAdapter(key);
  replyToThread(key, t('agent.session_ended', { label: adapter.label })).catch(() => {});
  // Banner now reads `idle`; closed sessions may also persist with the
  // wrong model/agent label otherwise.
  updatePinnedStatus(key).catch(() => {});
}

function handleAgentError(key: SessionKey, error: Error): void {
  console.error(`[Bot] adapter error ${keyToString(key)}:`, error.message);
  stopClaudeLiveness(key);
  getStatusCoalesceState(key).pendingText = null;
  deleteStatusMessage(key).catch(() => {});
  clearThinkingMessage(key);
  clearSubagentStatus(key);
  clearPendingQuestion(key);
  replyToThread(key, `Error: ${error.message}`).catch(() => {});
}

/**
 * @description `started` from the adapter — flip the pinned banner to
 * `running` and refresh its model row. Fired by both `claudeCliAdapter`
 * and `openCodeAdapter` (`emit('started', key)`).
 */
function handleAgentStarted(key: SessionKey): void {
  updatePinnedStatus(key).catch(() => {});
  // A fresh/adopted session arms the compact-on-idle watchdog (F2); it won't fire
  // until a turn produces output AND the topic then sits idle (no catch-up burst).
  // NOT `noteThreadActivity`: a session start (including a restart's reattach) is
  // not activity in the topic, so the countdown must continue from the PERSISTED
  // activity instant rather than restart at the full 55 minutes. A genuinely fresh
  // session has no persisted instant and so gets the full window anyway.
  rearmThreadIdleTimer(key);
}

/**
 * @description `stopped` from the adapter — flip the banner back to `idle`.
 * Skipped via the in-flight unbind guard inside `updatePinnedStatus` so the
 * stop-then-unbind sequence doesn't re-pin a stale banner.
 */
function handleAgentStopped(key: SessionKey): void {
  // Single convergence point for every `stopSession`-driven stop path —
  // `/quit` (OpenCode/terminal), `/quit-all`, `/new`, `/unbind`, and adapter
  // switch all emit `stopped`. Drop the thread's queued-but-unsent output here so
  // nothing coalesced before the stop posts after the "stopped" confirmation.
  clearThreadQueues(key);
  // Stop the liveness loop and remove its frame — a stopped session is idle, so
  // a lingering "working…" indicator would be a stuck spinner. Stopping the
  // timer first prevents it from recreating the frame right after this delete.
  stopClaudeLiveness(key);
  deleteStatusMessage(key).catch(() => {});
  // A stopped session is idle — a lingering "thinking …" frame would be a stuck
  // indicator, same rationale as the status frame above.
  clearThinkingMessage(key);
  // A stopped session has no running delegation — remove the sub-agent status.
  clearSubagentStatus(key);
  // F1: this is the convergence point for `/quit`, `/quit-all`, `/new`, and
  // adapter switch — none of which fire the adapter's `questionGone` (Claude's
  // pane is killed; OpenCode emits no resolve), so a pinned question would leak
  // forever. Clear it here (chains `unpinThreadQuestion`), matching
  // `handleAgentClosed` / `handleAgentError`.
  clearPendingQuestion(key);
  // Session ended — a future session starts with empty context, so forget the
  // last-injected thread-context preamble; the next prompt re-carries it.
  clearThreadContextMarker(key);
  // A stopped session has nothing to resume — drop any armed retry silently.
  cancelApiRetry(key);
  clearAuthNotice(key); // session stopped → retire any pinned logged-out notice
  // A stopped session has nothing to compact — drop the idle watchdog + any
  // armed agent-triggered compaction.
  clearThreadCompaction(key);
  updatePinnedStatus(key).catch(() => {});
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Startup orchestration — state init, re-attach, setMyCommands, launch
// ═══════════════════════════════════════════════════════════════════════════════

export const COMMANDS_MENU = [
  { command: 'help', description: '❓ Context-aware help' },
  { command: 'doctor', description: '🔍 Self-diagnostics' },
  { command: 'bind', description: '📁 Bind thread to a subfolder' },
  { command: 'ls', description: '📂 List WORK_ROOT subfolders' },
  { command: 'list', description: '🧵 List all bound threads' },
  { command: 'mcp', description: '🔌 List active MCP servers' },
  { command: 'claude', description: '▶️ Start Claude Code' },
  { command: 'opencode', description: '▶️ Start OpenCode' },
  { command: 'connect', description: '🔑 Connect an OpenCode provider API key' },
  { command: 'disconnect', description: '🔌 Disconnect an OpenCode provider' },
  { command: 'terminal', description: '🖥 Open a raw shell in the bound folder' },
  { command: 'claude_mode', description: '🔀 Claude backend: tmux-scrape ⇄ json-stream' },
  { command: 'new', description: '🆕 Restart session (alias /clear_session)' },
  { command: 'clear_session', description: '🆕 Restart session (alias /new)' },
  { command: 'model', description: '🧠 Switch model' },
  { command: 'effort', description: '⚙️ Reasoning effort' },
  { command: 'verbosity', description: '🔊 Output verbosity (thinking+tools+sub-agents)' },
  { command: 'thinking', description: '☁️ Thinking verbosity' },
  { command: 'tool_results', description: '🔧 Tool-results verbosity' },
  { command: 'subagent', description: '🤖 Sub-agent verbosity' },
  { command: 'sessions', description: '📋 Previous sessions (alias /resume)' },
  { command: 'resume', description: '📋 Resume a previous session' },
  { command: 'rename_session', description: '✏️ Rename the current session (OpenCode)' },
  { command: 'quit', description: '🚪 Quit agent (alias /q)' },
  { command: 'quitall', description: '🚪 Quit ALL agents (General-only)' },
  { command: 'compact', description: '🧹 Compact agent context' },
  { command: 'compact_on_idle', description: '🧹 Auto-compact after idle (toggle)' },
  { command: 'compact_summary', description: '📄 Post the compaction summary (toggle)' },
  { command: 'auto_continue_limits', description: '🚧 Auto-resume after a usage limit (toggle)' },
  { command: 'schedule', description: '⏰ Schedule a prompt (agent does the work)' },
  { command: 'reminders', description: '🔔 Reminders — add, list, delete (no agent)' },
  { command: 'status', description: '📊 Show status' },
  { command: 'output', description: '📜 Last 500 lines' },
  { command: 'trace', description: '🛰 Output-trace recorder on/off' },
  { command: 'timestamps', description: '🕒 Prepend send time to forwarded prompts' },
  { command: 'language', description: '🌐 Bot language for this chat/group' },
  { command: 'timezone', description: '🌍 Timezone for schedules and time context' },
  { command: 'whoami', description: '🪪 Show debug ids' },
  { command: 'pair', description: '🔗 Bind this group to the bot' },
  { command: 'version', description: 'ℹ️ Versions of bot + CLI tools' },
  { command: 'enter', description: '↵ Press Enter' },
  { command: 'up', description: '⬆️ Arrow Up' },
  { command: 'down', description: '⬇️ Arrow Down' },
  { command: 'tab', description: '⇥ Tab' },
  { command: 'esc', description: '⎋ Escape (interrupt / dismiss)' },
  { command: 'y', description: '✅ Send "y"' },
  { command: 'n', description: '❌ Send "n"' },
  { command: 'c', description: '🛑 Ctrl+C' },
  { command: 'clear_messages', description: '🗑 Delete this thread\'s messages' },
];

/**
 * @description Post the silent-reattach recap for one thread after a successful
 * re-adopt: how many AGENT messages were produced while the bot was down (vs the
 * persisted watermark) plus the last few turns. The anti-spam gate
 * ({@link checkShouldPostReattachRecap}) lives in the recap module: post when
 * `missedCount > 0` (real missed output, ANY boot mode) OR — only on a COLD start
 * (`isColdStart`) — the watermark-unknown fallback. The fallback is cold-start
 * gated precisely so a watermark-less session (first run after ship, pruned
 * transcript) does NOT re-spam every active topic on every hot rebuild.
 *
 * Adapters without `getReattachRecap` (Terminal) are skipped. Best-effort: a
 * read/format failure logs and posts nothing — it never blocks the reattach
 * scan or crashes boot.
 *
 * `watermark` is the PRE-adopt snapshot read by the caller BEFORE `adopt/resume`
 * (S1-wiring): the concurrent live-advance (Claude's idle-poll tracker / OpenCode's
 * `session.idle`) starts running the instant the session polls, so re-reading the
 * watermark here could see it already moved to the tail and silently suppress a
 * genuine recap. Taking the snapshot before adopt freezes the recap baseline.
 *
 * Idempotency: after the recap is computed the persisted watermark is ALWAYS
 * advanced to the session's current head (`recap.headWatermark`) — whether or not
 * a recap posted, and even on `missedCount === 0` — so the same gap can never
 * re-report on the next reattach. Skipped only when the head is unknown (the
 * record read failed) → retry on the next reattach. The collaborators are
 * injectable (`deps`) so the orchestration is unit-testable; production uses the
 * real {@link replyToThread} / {@link StateStore.setSeenWatermark}.
 */
interface PostReattachRecapDeps {
  reply: (key: SessionKey, text: string) => Promise<unknown>;
  advanceWatermark: (key: SessionKey, watermark: SeenWatermark) => void;
}

const defaultPostReattachRecapDeps: PostReattachRecapDeps = {
  reply: (key, text) => replyToThread(key, text),
  advanceWatermark: (key, watermark) => {
    void state.setSeenWatermark(key, watermark);
  },
};

export async function postReattachRecap(
  key: SessionKey,
  adapter: Pick<AgentAdapter, 'getReattachRecap'>,
  workDir: string,
  sessionId: string,
  watermark: SeenWatermark | null,
  isColdStart: boolean,
  deps: PostReattachRecapDeps = defaultPostReattachRecapDeps,
): Promise<void> {
  if (!adapter.getReattachRecap) return;
  try {
    const recap = await adapter.getReattachRecap(key, workDir, sessionId, watermark);
    const shouldPost = checkShouldPostReattachRecap({
      missedCount: recap.missedCount,
      isWatermarkKnown: recap.isWatermarkKnown,
      hasTurns: recap.turns.length > 0,
      isColdStart,
    });
    if (shouldPost) {
      const text = withThreadLocale(key, () => formatReattachRecap(recap));
      if (text) await deps.reply(key, text);
    }
    if (recap.headWatermark) {
      deps.advanceWatermark(key, recap.headWatermark);
    }
  } catch (e) {
    console.warn(`[reattach] recap post failed for ${keyToString(key)}:`, e instanceof Error ? e.message : e);
  }
}

/**
 * @description Re-adopt tmux sessions and OpenCode SSE streams that
 * outlived the bot process.
 *
 * Plan §10.2 / §13.19 (E1). Runs **before** `bot.launch()` so the first
 * user message in any thread already finds a live adapter session, not
 * a stale "agent not running" reply.
 *
 * A successful re-adopt is SILENT unless the agent kept WORKING during the
 * downtime: {@link postReattachRecap} then posts ONE bounded recap of the
 * missed output (gated on `missedCount`), so nothing produced while the bot was
 * down is lost (the old "session is still alive" notice it replaced only added
 * noise). `opts.quietReattach` governs ONLY the per-topic ERROR notice this
 * scan can still post — the workDir-refused case (the bound folder
 * vanished, so the session can't be re-adopted): held on a hot reload
 * (nodemon swap, sub-threshold downtime — the user didn't notice the
 * blink), shown on a real cold start. The classifier lives in
 * `bootClassifier.ts`; this function only consumes the flag.
 */
async function reattachExistingSessions(
  opts: { quietReattach: boolean } = { quietReattach: false },
): Promise<void> {
  // 0. Rehydrate per-thread adapter choice from state.agents into the
  //    in-memory `threadAdapterNames` map. Without this, every thread
  //    reverts to the default adapter after a restart, so `getThreadAdapter(key)`
  //    would return the wrong adapter even though the *actual* tmux /
  //    opencode session was correctly adopted below. (Review CRITICAL #3.)
  let rehydrated = 0;
  for (const { key } of state.listBindings()) {
    const agent = state.getAgent(key);
    if (!agent?.name) continue;
    try {
      setThreadAdapter(key, agent.name);
      rehydrated += 1;
    } catch (e) {
      // Unknown adapter in state (renamed / removed). Log and move on.
      console.warn(
        `[reattach] cannot rehydrate ${keyToString(key)} (agent=${agent.name}):`,
        e instanceof Error ? e.message : e,
      );
    }
  }
  console.log(`[reattach] rehydrated adapter choice for ${rehydrated} threads`);

  // 1. Claude — tmux sessions. Always resolve the claude adapter directly,
  //    not via `getThreadAdapter(generalKey)`: General may be unbound or
  //    bound to opencode, which would silently skip the entire claude scan
  //    (review CRITICAL #1).
  const claudeAdapter = getAdapter('claude');
  if (claudeAdapter instanceof ClaudeCliAdapter) {
    try {
      const found = await claudeAdapter.listExistingTmuxSessions();
      let adopted = 0;
      let killed = 0;
      let reconciled = 0;
      for (const { key, sessionName } of found) {
        const binding = state.getBinding(key);
        if (!binding) {
          // No binding at all → genuine orphan, no thread owns it.
          await claudeAdapter.killOrphanTmuxSession(sessionName);
          killed += 1;
          continue;
        }
        // A thread whose resolved backend is json-stream must never re-adopt a
        // stale tmux-claude session — kill it and let the json-stream reattach
        // (2b) own this thread instead.
        if (getThreadAdapterNameRaw(key) === claudeJsonStreamAdapterName) {
          await claudeAdapter.killOrphanTmuxSession(sessionName);
          killed += 1;
          continue;
        }
        let agent = state.getAgent(key);
        // If state and reality disagree (agent missing, or names another
        // adapter, or claudeSessionId is gone), try to reconstruct state
        // from the live tmux argv before declaring the session an orphan.
        // The running tmux session is the source of truth — `state.json`
        // can fall out of sync if the bot crashed mid-write (the 500ms
        // debounce never flushed) or if a previous `switchThreadAdapter`
        // call left a leftover session of the other adapter alive.
        const needsReconcile = !agent || agent.name !== 'claude' || !agent.claudeSessionId;
        if (needsReconcile) {
          const recovered = await claudeAdapter.recoverSessionIdFromTmux(sessionName);
          if (recovered) {
            const patched: { name: string; model?: string; claudeSessionId: string; startedAt?: string } = {
              name: 'claude',
              claudeSessionId: recovered,
            };
            if (agent?.model !== undefined) patched.model = agent.model;
            // Carry the session-start time through the reconcile rebuild so a
            // restart doesn't reset it (a missing one is backfilled below).
            if (agent?.startedAt !== undefined) patched.startedAt = agent.startedAt;
            // Drop the row first so a stale opencodeSessionId doesn't
            // ride along into the new shape (setAgent merges).
            await state.removeAgent(key);
            await state.setAgent(key, patched);
            setThreadAdapter(key, 'claude');
            agent = state.getAgent(key);
            reconciled += 1;
            console.log(`[reattach] reconciled state for ${keyToString(key)} (recovered claudeSessionId=${recovered})`);
          } else {
            await claudeAdapter.killOrphanTmuxSession(sessionName);
            killed += 1;
            continue;
          }
        }
        // After reconcile, agent is always populated with claudeSessionId.
        if (!agent?.claudeSessionId) {
          await claudeAdapter.killOrphanTmuxSession(sessionName);
          killed += 1;
          continue;
        }
        const workDirDecision = getWorkDirStartDecision(key);
        if (!workDirDecision.ok) {
          console.warn(`[reattach] claude ${keyToString(key)} refused: ${workDirDecision.message}`);
          await claudeAdapter.killOrphanTmuxSession(sessionName);
          killed += 1;
          if (!opts.quietReattach) {
            replyToThread(key, workDirDecision.message).catch(() => {});
          }
          continue;
        }
        const workDir = workDirDecision.workDir;
        // Snapshot the persisted watermark BEFORE adopt: the live-advance tracker
        // starts moving it toward EOF the instant the adopted session polls, so a
        // post-adopt read could miss a genuine recap (S1-wiring).
        const preAdoptWatermark = state.getAgent(key)?.seenWatermark ?? null;
        if (await claudeAdapter.adoptExistingTmuxSession(key, sessionName, workDir, agent.claudeSessionId)) {
          adopted += 1;
          // Fire-and-forget: the body (a Claude fs read) must not serialize the
          // reattach scan. postReattachRecap swallows its own errors; the `.catch`
          // is defensive.
          void postReattachRecap(
            key,
            claudeAdapter,
            workDir,
            agent.claudeSessionId,
            preAdoptWatermark,
            !opts.quietReattach,
          ).catch(() => {});
        }
      }
      console.log(`[reattach] tmux: adopted ${adopted}, reconciled ${reconciled}, killed ${killed} orphans (quiet=${opts.quietReattach})`);
    } catch (e) {
      console.error('[reattach] tmux scan failed:', e);
    }
  }

  // 2. OpenCode — server-side sessions; resumeSession reconnects SSE.
  //    Resolve the opencode adapter directly: state.agents[key].name === 'opencode'
  //    is the source of truth here, not the (possibly stale) default-fallback
  //    from `getThreadAdapter(key)` (review CRITICAL #2).
  const opencodeAdapter = getAdapter('opencode');
  let reopened = 0;
  for (const { key } of state.listBindings()) {
    const agent = state.getAgent(key);
    if (!agent || agent.name !== 'opencode' || !agent.opencodeSessionId) continue;
    if (opencodeAdapter.checkIsActive(key)) continue;
    try {
      const workDirDecision = getWorkDirStartDecision(key);
      if (!workDirDecision.ok) {
        console.warn(`[reattach] opencode ${keyToString(key)} refused: ${workDirDecision.message}`);
        if (!opts.quietReattach) {
          replyToThread(key, workDirDecision.message).catch(() => {});
        }
        continue;
      }
      const workDir = workDirDecision.workDir;
      // Snapshot the persisted watermark BEFORE resume: the live-advance (OpenCode's
      // `session.idle`) starts moving it once the reconnected session settles, so a
      // post-resume read could miss a genuine recap (S1-wiring).
      const preAdoptWatermark = state.getAgent(key)?.seenWatermark ?? null;
      await opencodeAdapter.resumeSession(key, workDir, agent.opencodeSessionId);
      reopened += 1;
      // Fire-and-forget: the body (an OpenCode HTTP GET) must not serialize the
      // reattach scan. postReattachRecap swallows its own errors; the `.catch`
      // is defensive.
      void postReattachRecap(
        key,
        opencodeAdapter,
        workDir,
        agent.opencodeSessionId,
        preAdoptWatermark,
        !opts.quietReattach,
      ).catch(() => {});
    } catch (e) {
      console.warn(`[reattach] opencode ${keyToString(key)} failed:`, e instanceof Error ? e.message : e);
    }
  }
  console.log(`[reattach] opencode: reopened ${reopened} sessions (quiet=${opts.quietReattach})`);

  // 2b. Claude JSON-stream — EXTERNAL tmux-hosted processes (plan
  //     2026-07-05-jsonstream-restart-isolation): like the scrape backend, the
  //     sessions outlive the bot. First ADOPT every live `cjson-*` session —
  //     reopen the FIFO writer and resume the stdout tail from the persisted
  //     line-boundary offset, so everything produced during the downtime
  //     replays through the normal pipeline (which is why an adopt posts NO
  //     recap — the replay IS the delivery). A session whose thread released
  //     its persisted id (`/quit`, `/new`) or isn't a json-stream thread is an
  //     orphan and is killed, never adopted (locked decision). Then RESUME
  //     (dead-process fallback, the pre-plan behavior) any bound json-stream
  //     thread that still has a persisted id but no live process — the only
  //     path that still re-spawns `--resume`, and the only one that recaps.
  const claudeJsonAdapter = getAdapter(claudeJsonStreamAdapterName);
  let jsonAdopted = 0;
  let jsonKilled = 0;
  let jsonReopened = 0;
  if (claudeJsonAdapter instanceof ClaudeJsonStreamAdapter) {
    try {
      const found = await claudeJsonAdapter.listExistingTmuxSessions();
      for (const { key, sessionName } of found) {
        const binding = state.getBinding(key);
        const agent = state.getAgent(key);
        if (!binding || agent?.name !== claudeJsonStreamAdapterName || !agent.claudeSessionId) {
          await claudeJsonAdapter.killOrphanTmuxSession(sessionName);
          jsonKilled += 1;
          continue;
        }
        const workDirDecision = getWorkDirStartDecision(key);
        if (!workDirDecision.ok) {
          console.warn(`[reattach] claude-json-stream ${keyToString(key)} refused: ${workDirDecision.message}`);
          await claudeJsonAdapter.killOrphanTmuxSession(sessionName);
          jsonKilled += 1;
          if (!opts.quietReattach) replyToThread(key, workDirDecision.message).catch(() => {});
          continue;
        }
        if (await claudeJsonAdapter.adoptExistingTmuxSession(
          key, sessionName, workDirDecision.workDir, agent.claudeSessionId, agent.jsonStreamTail ?? null,
        )) {
          jsonAdopted += 1;
        } else {
          // Dead/zombie — adopt cleaned it up itself; the resume loop below
          // still reopens this thread from the persisted session id.
          jsonKilled += 1;
        }
      }
    } catch (e) {
      console.error('[reattach] claude-json-stream scan failed:', e);
    }
  }
  for (const { key } of state.listBindings()) {
    const agent = state.getAgent(key);
    if (!agent || agent.name !== claudeJsonStreamAdapterName || !agent.claudeSessionId) continue;
    if (claudeJsonAdapter.checkIsActive(key)) continue; // adopted above
    try {
      const workDirDecision = getWorkDirStartDecision(key);
      if (!workDirDecision.ok) {
        console.warn(`[reattach] claude-json-stream ${keyToString(key)} refused: ${workDirDecision.message}`);
        if (!opts.quietReattach) replyToThread(key, workDirDecision.message).catch(() => {});
        continue;
      }
      const workDir = workDirDecision.workDir;
      const preAdoptWatermark = state.getAgent(key)?.seenWatermark ?? null;
      await claudeJsonAdapter.resumeSession(key, workDir, agent.claudeSessionId);
      jsonReopened += 1;
      void postReattachRecap(
        key, claudeJsonAdapter, workDir, agent.claudeSessionId, preAdoptWatermark, !opts.quietReattach,
      ).catch(() => {});
    } catch (e) {
      console.warn(`[reattach] claude-json-stream ${keyToString(key)} failed:`, e instanceof Error ? e.message : e);
    }
  }
  console.log(`[reattach] claude-json-stream: adopted ${jsonAdopted}, reopened ${jsonReopened}, killed ${jsonKilled} orphans (quiet=${opts.quietReattach})`);

  // 3. Terminal — tmux shells (`term-…`). Like the Claude scan but simpler:
  //    a terminal has no session-id to recover, so adoption keys purely on a
  //    live binding whose agent is `terminal`. The tmux name is derived from
  //    the `SessionKey`. `adoptExistingTmuxSession` itself liveness/zombie-checks
  //    the specific session; a dead/missing one is garbage-collected, never
  //    re-spawned (an explicitly-stopped shell stays gone).
  const terminalAdapter = getAdapter('terminal');
  if (terminalAdapter instanceof TerminalAdapter) {
    try {
      const found = await terminalAdapter.listExistingTmuxSessions();
      let adopted = 0;
      let killed = 0;
      for (const { key, sessionName } of found) {
        const binding = state.getBinding(key);
        const agent = state.getAgent(key);
        // No binding, or the thread isn't a terminal thread → genuine orphan.
        if (!binding || agent?.name !== 'terminal') {
          await terminalAdapter.killOrphanTmuxSession(sessionName);
          killed += 1;
          continue;
        }
        const workDirDecision = getWorkDirStartDecision(key);
        if (!workDirDecision.ok) {
          console.warn(`[reattach] terminal ${keyToString(key)} refused: ${workDirDecision.message}`);
          await terminalAdapter.killOrphanTmuxSession(sessionName);
          killed += 1;
          if (!opts.quietReattach) {
            replyToThread(key, workDirDecision.message).catch(() => {});
          }
          continue;
        }
        if (await terminalAdapter.adoptExistingTmuxSession(key, sessionName, workDirDecision.workDir)) {
          adopted += 1;
        } else {
          // Adopt failed (zombie pane / vanished) — it killed the session itself.
          killed += 1;
        }
      }
      console.log(`[reattach] terminal: adopted ${adopted}, killed ${killed} orphans (quiet=${opts.quietReattach})`);
    } catch (e) {
      console.error('[reattach] terminal scan failed:', e);
    }
  }

  // Backfill a session-start timestamp for any reattached session whose agent
  // row predates the `startedAt` field (older state file) or lost it through
  // the claude reconcile rebuild above. NEVER overwrite an existing value — the
  // displayed start date must survive a restart, not reset to boot time. Only
  // active (reattached) threads get one; a dead/idle row is left untouched
  // (its startedAt, if any, still round-trips for a later `/sessions` resume).
  const backfillIso = formatIsoLocalOffset(Date.now());
  for (const { key } of state.listBindings()) {
    const agent = state.getAgent(key);
    if (!agent || agent.startedAt !== undefined) continue;
    let isActive = false;
    try {
      isActive = getThreadAdapter(key).checkIsActive(key);
    } catch {
      // Unknown adapter from a stale binding — nothing reattached, skip.
    }
    if (isActive) await state.setAgentStartedAt(key, backfillIso);
  }
}

/**
 * @description Restore persisted pending interactive questions into the
 * in-memory `pendingQuestions` map so the existing Telegram option buttons
 * work again after a restart (without this the map is lost, the agent's
 * question tool hangs forever, and the buttons go dead — the live bug this
 * fixes). MUST run AFTER {@link reattachExistingSessions} so session activity
 * is known.
 *
 * A persisted question is restored ONLY when its thread's session reattached
 * and is currently active (`adapter.checkIsActive`). Otherwise the question is
 * unreachable — the agent that asked it is gone — so it is dropped from the
 * store, preventing a stale entry from lingering across boots. The persisted
 * `messageId` is preserved, so the OLD buttons resolve correctly; the question
 * is never re-posted.
 */
function restorePendingQuestions(): void {
  let restored = 0;
  let dropped = 0;
  for (const [keyStr, value] of Object.entries(state.getPendingQuestions())) {
    let key: SessionKey;
    try {
      key = keyFromString(keyStr);
    } catch {
      // Hand-edited / corrupt key (can't come from `keyToString`): skip it,
      // keep booting. Tolerated-and-skipped, like state.ts's own key parsers.
      continue;
    }
    const adapter = getThreadAdapter(key);
    if (adapter.checkIsActive(key)) {
      // Restore-compat (S2): an OLD persisted entry has only `{ data, messageId }`
      // — `answers`/`currentIndex` are undefined and would crash the answer
      // handlers. Migrate to the new shape and re-persist so disk catches up.
      const migrated = migratePendingQuestionState(value);
      setPendingQuestion(key, migrated);
      restored += 1;
    } else {
      clearPendingQuestion(key);
      dropped += 1;
    }
  }
  console.log(`[reattach] pending questions: restored ${restored}, dropped ${dropped}`);
}

/**
 * @description Re-arm persisted API-error retries (S6) so a pending kick —
 * especially a multi-hour usage-limit wait — survives a bot restart. MUST run
 * AFTER {@link reattachExistingSessions} (and right after
 * {@link restorePendingQuestions}) so each thread's session is already
 * adopted/resumed and the kick lands in a live session.
 *
 * The work is `restoreApiRetryTimers` (`apiRetryKick.ts`): each record re-populates
 * `apiRetryTimers` with one unref'd timer at `fireAt - now` (a past one fires ONE
 * catch-up after a short delay, not in the adopt tick). A saved record means ARMED
 * — a retry whose kick already ran is not in the state file any more — so what is
 * restored here has not fired yet. The arm notice is NOT re-posted (the user saw it
 * before the restart); the `↻ resuming` notice fires when the timer fires.
 *
 * A retry of a platform this instance does not serve is neither armed nor
 * dropped (Jira plan J3b, R10): its kick would start that conversation's session
 * here, under this instance's environment and tmux server.
 */
function restoreApiRetries(): void {
  const restored = restoreApiRetryTimers(
    {
      entries: apiRetryTimers,
      now: () => Date.now(),
      isServed: checkIsTelegramKey,
      fire: (key) => {
        void fireApiRetry(key);
      },
    },
    state.getApiRetries(),
  );
  console.log(`[reattach] api retries: re-armed ${restored}`);
}

/**
 * @description Recover a usage/session-limit episode that ENDED BEFORE this boot
 * and left no armed retry behind — the case {@link restoreApiRetries} cannot help
 * with, because there is nothing persisted to re-arm. It happens whenever the
 * limit wording was not yet recognised when the error landed: the topic is parked
 * on a limit error and a bot update alone would never resume it.
 *
 * JSON-STREAM CLAUDE ONLY (see `utils/limitEpisodeRecovery.ts`): that backend is
 * the one whose evidence outlives the bot — its terminal `result` frame sits at the
 * end of the session's append-only `stdout.jsonl`. Only the TAIL is read
 * ({@link limitEpisodeTailMaxBytes}), never the whole log. A recovered episode goes
 * through {@link handleApiError}, so the notice, the timer, the persistence and the
 * `/auto_continue_limits` gate behave exactly as for a live error — there is no second
 * arming path to keep in sync.
 *
 * MUST run AFTER {@link restoreApiRetries} so an already-armed thread is visible
 * and skipped. A re-armed episode whose reset time has passed needs no special
 * case: the retry plan clamps the negative delay to zero.
 *
 * Each arming STAMPS the log's identity (`state.json` `limitEpisodesRecovered`), so
 * an episode is recovered at most once: «⏭ Skip once», a user takeover and a
 * give-up all clear the armed record while leaving the same trailing error in the
 * log, and hot mode reloads the bot on every code change — without the stamp each
 * reload resurrected the settled wait.
 */
function recoverLimitEpisodesFromDisk(): void {
  const jsonStreamAdapter = getAdapter(claudeJsonStreamAdapterName);
  const now = Date.now();
  let recovered = 0;
  for (const { key } of state.listBindings()) {
    const agent = state.getAgent(key);
    if (agent?.name !== claudeJsonStreamAdapterName || !agent.claudeSessionId) continue;
    if (!jsonStreamAdapter.checkIsActive(key)) continue;
    // A topic with auto-continue OFF has nothing to recover — and routing a
    // 12h-old stale error through `handleApiError` would re-post the OFF notice
    // (its dedup is in-memory) after EVERY boot, i.e. on every hot reload.
    if (!state.checkIsAutoContinueOnLimitEnabled(key)) continue;
    const keyStr = keyToString(key);
    const { stdoutFile } = getJsonStreamSessionPaths(resolveJsonStreamSessionDir(getDataDir(), key));

    // ONE stat: size and mtime must describe the same instant, because together
    // they are the episode identity persisted below.
    let log: LimitEpisodeMarker;
    try {
      const stat = fs.statSync(stdoutFile);
      log = { sizeBytes: stat.size, mtimeMs: stat.mtimeMs };
    } catch {
      continue; // no stdout log for this thread (yet) — nothing to recover
    }
    if (log.sizeBytes === 0) continue;

    let errorText: string | null = null;
    try {
      const tail = readFileByteRange(
        stdoutFile,
        Math.max(0, log.sizeBytes - limitEpisodeTailMaxBytes),
        log.sizeBytes,
      );
      errorText = getLastTerminalErrorText(tail.toString('utf8'));
    } catch (e) {
      console.warn(`[limitRecovery] ${keyStr}: cannot read stdout tail:`, e instanceof Error ? e.message : e);
      continue;
    }

    const decision = decideLimitEpisodeRecovery({
      errorText,
      log,
      handled: state.getLimitEpisodeRecovered(key),
      now,
      hasArmedRetry: apiRetryTimers.has(keyStr),
    });
    if (decision.action === 'skip') {
      if (decision.reason !== 'noError') console.log(`[limitRecovery] ${keyStr}: skipped (${decision.reason})`);
      continue;
    }
    console.log(`[limitRecovery] ${keyStr}: re-arming a limit wait left over from before the restart`);
    // Stamp the log identity BEFORE arming: this trailing error is now handled, so
    // a later boot must not recover it again even once the armed record is gone
    // («⏭ Skip once», a user takeover, or a give-up all clear it).
    void state
      .setLimitEpisodeRecovered(key, log)
      .catch(e => console.error('[limitRecovery] marker persist failed:', e));
    void withThreadLocale(key, () => handleApiError(key, decision.cls));
    recovered += 1;
  }
  if (recovered > 0) console.log(`[reattach] limit episodes: recovered ${recovered}`);
}

/**
 * @description Boot self-heal of the bot's OWN injected MCP server on the Claude
 * side — the mirror of OpenCode's `reconcileSchedulerMcpForActiveSessions`. A
 * json-stream session survives every bot restart, but its MCP client never
 * retries a server it once failed to reach, so a session that was alive across
 * the restart can hold a permanently-`failed` `telegramBot` entry and lose
 * `schedule_*` / `compact_conversation` / `send_file_to_user` /
 * `send_messages_to_user` for the rest of its life. Ask every live session whose
 * backend exposes `healMcpServer` and reconnect the ones that report `failed`.
 *
 * Fire-and-forget per thread (boot must not wait on control round-trips), and
 * QUIET unless something was actually healed or the session did not answer — a
 * line per healthy thread would print the whole list on every hot reload.
 */
function healSchedulerMcpForActiveSessions(): void {
  for (const { key } of state.listBindings()) {
    const agent = state.getAgent(key);
    if (!agent?.name) continue;
    let adapter: AgentAdapter;
    try { adapter = getThreadAdapter(key); }
    catch { continue; } // unknown adapter in state — already reported by reattach
    if (!adapter.healMcpServer || !adapter.checkIsActive(key)) continue;
    const keyStr = keyToString(key);
    void adapter.healMcpServer(key, schedulerMcpServerName).then(
      (outcome) => {
        if (outcome === 'healed') {
          console.log(`[scheduler] MCP heal: reconnected ${schedulerMcpServerName} in ${keyStr}`);
        } else if (outcome === 'unavailable') {
          console.warn(`[scheduler] MCP heal: ${keyStr} left unhealed — its status ask went unanswered, or the reconnect was refused`);
        }
      },
      (e) => console.warn(`[scheduler] MCP heal failed for ${keyStr}:`, e instanceof Error ? e.message : e),
    );
  }
}

/**
 * @description Injected collaborators for {@link reconcileTransientFrames}, so the
 * boot reconciliation is unit-testable without a live Telegram client or
 * StateStore (mirrors the `deps` seam {@link postReattachRecap} uses). Defaults
 * wire the real bot client + the persist choke point.
 */
export interface ReconcileTransientFramesDeps {
  /** Best-effort delete of one Telegram message (Telegraf resolves `true`). */
  deleteMessage: (chatId: number, messageId: number) => Promise<boolean>;
  /** Re-sync disk to the thread's LIVE in-memory frame ids after the stale deletes. */
  persistFrames: (key: SessionKey) => void;
}

const defaultReconcileTransientFramesDeps: ReconcileTransientFramesDeps = {
  deleteMessage: (chatId, messageId) => bot.telegram.deleteMessage(chatId, messageId),
  persistFrames: persistTransientFrames,
};

/**
 * @description Delete transient status frames left on screen by an UNGRACEFUL
 * exit (crash / SIGKILL — the graceful shutdown sweep never ran), so a
 * "✽ working…" / thinking / sub-agent frame doesn't stick forever in a topic
 * (S2, the crash safety net behind S1). Deletes every id in the `orphaned`
 * snapshot best-effort (swallowing "message not found" / too-old). The snapshot
 * MUST be captured BEFORE reattach (see {@link startBot}): a reattached
 * session's frame setters persist the fresh in-memory state and would clobber
 * the live persisted set first. Every snapshot id is stale by definition (the
 * fresh process holds no handle to it; a still-busy reattached session repaints
 * its OWN fresh frame), so deleting is always safe. After deleting, re-persist
 * the CURRENT live frame ids per thread so disk reflects post-reattach truth
 * (the repainted frame's id, or empty) instead of the consumed stale ids. A
 * graceful exit already cleared the set in its sweep, so this is normally a
 * no-op.
 */
export function reconcileTransientFrames(
  orphaned: Record<string, number[]>,
  deps: ReconcileTransientFramesDeps = defaultReconcileTransientFramesDeps,
): number {
  let deleted = 0;
  for (const [keyStr, ids] of Object.entries(orphaned)) {
    let key: SessionKey;
    try {
      key = keyFromString(keyStr);
    } catch {
      // Hand-edited / corrupt key (can't come from `keyToString`): skip it,
      // keep booting. Tolerated-and-skipped, like restorePendingQuestions.
      continue;
    }
    for (const id of ids) {
      void deps.deleteMessage(getTelegramChatId(key), id).catch(() => {});
      deleted += 1;
    }
    // Sync disk to the LIVE in-memory frames (post-reattach): a still-busy
    // session that repainted a fresh frame keeps its new id; an idle one clears.
    deps.persistFrames(key);
  }
  if (deleted > 0) console.log(`[reattach] transient frames: deleted ${deleted} stale`);
  return deleted;
}

/**
 * Bot composition for the reusable file-send service. Every gateway method
 * stays on the existing per-thread FIFO + global pacer + 429 retry/output-trace
 * path through `enqueueSend`; `buildSendExtra` preserves topic routing.
 */
const sendFilesToThread = createSendFilesToThread<SessionKey>({
  resolveTargetAndWorkDir: (threadKeyStr) => {
    let key: SessionKey;
    try {
      key = keyFromString(threadKeyStr);
    } catch {
      return { ok: false, error: `invalid threadKey "${threadKeyStr}"` };
    }

    const decision = getWorkDirStartDecision(key);
    return decision.ok
      ? { ok: true, target: key, workDir: decision.workDir }
      : { ok: false, error: decision.message };
  },
  executeDelivery: (key, delivery, signal) => enqueueSend(key, delivery, signal),
  gateway: createTelegramFileSendGateway({
    sendPhoto: (key, input, caption, signal) =>
      bot.telegram.callApi(
        'sendPhoto',
        {
          chat_id: getTelegramChatId(key),
          photo: input,
          ...buildSendExtra(key, caption !== undefined ? { caption } : {}),
        },
        { signal },
      ),
    sendAnimation: (key, input, caption, signal) =>
      bot.telegram.callApi(
        'sendAnimation',
        {
          chat_id: getTelegramChatId(key),
          animation: input,
          ...buildSendExtra(key, caption !== undefined ? { caption } : {}),
        },
        { signal },
      ),
    sendVideo: (key, input, caption, signal) =>
      bot.telegram.callApi(
        'sendVideo',
        {
          chat_id: getTelegramChatId(key),
          video: input,
          ...buildSendExtra(key, caption !== undefined ? { caption } : {}),
        },
        { signal },
      ),
    sendDocument: (key, input, caption, signal) =>
      bot.telegram.callApi(
        'sendDocument',
        {
          chat_id: getTelegramChatId(key),
          document: input,
          ...buildSendExtra(key, caption !== undefined ? { caption } : {}),
        },
        { signal },
      ),
    sendMediaGroup: (key, mediaGroup, signal) => {
      // Album captions already ride the first media item; group-level extra only
      // carries thread routing.
      return bot.telegram.callApi(
        'sendMediaGroup',
        {
          chat_id: getTelegramChatId(key),
          media: mediaGroup,
          ...buildSendExtra(key, {}),
        },
        { signal },
      );
    },
  }),
  recordMessageIds: (key, messageIds) => state.pushMessageIds(key, messageIds),
});

/**
 * Discrete-message sender behind `send_messages_to_user`. Each message is sent as
 * its OWN permanent message through `replyChunkWithFallback` (HTML-first with a
 * plain-text fallback), which paces via the global `enqueueSend` and records the
 * id for `/clear` — but does NOT touch the streaming edit-in-place state, so a
 * later agent reply is unaffected. Ordering holds because each chunk is awaited
 * before the next is enqueued.
 */
const sendMessagesToThread = createSendMessagesToThread<SessionKey>({
  resolveTarget: (threadKeyStr) => {
    try {
      return { ok: true, target: keyFromString(threadKeyStr) };
    } catch {
      return { ok: false, error: `invalid threadKey "${threadKeyStr}"` };
    }
  },
  sendChunk: async (key, chunk) => {
    const id = await replyChunkWithFallback(key, renderAgentHtml(chunk), chunk);
    return id !== null;
  },
  // Reuse the SAME secure file-send pipeline as `send_file_to_user` for an
  // attachment item — no second pipeline, no duplicated path-safety.
  sendFiles: sendFilesToThread,
  splitMessage,
  maxMessageLength: MAX_MESSAGE_LEN,
  measureRendered: (chunk) => renderAgentHtml(chunk).length,
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Requests — answer sinks and the wake-up engine's view of a session
//
//  The core (`requests/`) decides; these are the bot primitives it acts through.
//  Telegram is the only platform this process answers on so far.
// ═══════════════════════════════════════════════════════════════════════════════

/** The localized alert text per reason (the operator reads it in the topic). */
const requestAlertTextKeys: Readonly<Record<RequestAlertReason, string>> = {
  silentTurns: 'requests.alert.notAnsweringNotice',
  wakeCap: 'requests.alert.notAnsweringNotice',
  wakeFailed: 'requests.alert.unreachableNotice',
};

/**
 * @description Build the answer sinks of the platforms this process serves.
 * Built once at boot and shared by `answer_request`, the wake-up alerts and the
 * alert release on close, so all three speak to the same sink.
 */
function createAnswerSinks(): AnswerSinks {
  return new Map([
    ['telegram', createTelegramAnswerSink({
      sendMessages: sendMessagesToThread,
      postAlert: (key, requestId, reason) =>
        withThreadLocale(key, () => replyToThread(key, t(requestAlertTextKeys[reason], { requestId }))),
      // The alert must notify: the operator runs topics muted and a pin is what pierces that.
      pinMessage: (key, messageId) => pinMessageQuiet(key, messageId, { disableNotification: false }),
      unpinMessage: (key, messageId) => unpinMessageQuiet(key, messageId),
    })],
  ]);
}

/**
 * @description Make sure the conversation has a live session of its OWN: a live
 * one is used as is; a dead one is RESUMED from its persisted session id, so a
 * wake-up reminder — or a Jira issue's next request (D5: one conversation per
 * issue) — reaches the same conversation (a fresh session would not know it).
 * Resolves `false` when there is nothing to resume.
 */
async function ensureSessionByResume(key: SessionKey): Promise<boolean> {
  const adapter = getThreadAdapter(key);
  if (adapter.checkIsActive(key)) return true;
  const agent = state.getAgent(key);
  const sessionId = agent?.claudeSessionId ?? agent?.opencodeSessionId;
  const workDirDecision = getWorkDirStartDecision(key);
  if (!sessionId || !adapter.resumeSession || !workDirDecision.ok) return false;
  try {
    await adapter.resumeSession(key, workDirDecision.workDir, sessionId);
    await persistAdapterSessionIds(key, adapter, state);
    return adapter.checkIsActive(key);
  } catch (e) {
    console.warn(`[requests] could not resume ${keyToString(key)} for a wake-up:`, e instanceof Error ? e.message : e);
    return false;
  }
}

/**
 * @description A tracker conversation's own session, back before a post into it
 * (D5): a dead one is resumed by its persisted id, never replaced by a fresh one;
 * a start already under way finishes on its own.
 */
async function resumeOwnSessionUnlessStarting(key: SessionKey): Promise<void> {
  if (!startupPromptBuffer.checkIsStarting(keyToString(key))) await ensureSessionByResume(key);
}

/**
 * @description The session a wake-up goes into: the conversation's own, resumed
 * when it died. A tracker request whose prompt never reached the agent — its post
 * failed before any session came up (R28), or the resume failed — gets a session
 * started the way its post starts one: the wake-up carries the whole request, so
 * nothing the new session lacks is lost. A reminder never starts one: a fresh
 * session would not know what it reminds of. A topic's wake-ups are unchanged.
 */
async function prepareRequestWakeUpSession(key: SessionKey, message: WakeUpMessage, fallbackAdapterName: string | undefined): Promise<boolean> {
  if (await ensureSessionByResume(key)) return true;
  if (checkIsTelegramKey(key) || !message.isRequestPrompt) return false;
  await ensureAgentSession(key, { fallbackAdapterName });
  // A start still under way is not ready: a forward now would not reach it — the next retry will.
  return getThreadAdapter(key).checkIsActive(key);
}

/**
 * @description Remind the agent of an open request inside its own session. Not a
 * request: it carries the open request's id and goes through the ordinary
 * prompt path (the engine only wakes an idle session, so nothing is interrupted),
 * marked as a reminder so a wedge recovery keeps replaying the request's prompt.
 */
async function forwardRequestWakeUp(key: SessionKey, _request: OpenRequestState, message: WakeUpMessage): Promise<void> {
  // The request's own prompt re-posted (R21) counts as that prompt, not a reminder.
  await forwardPromptToAgent(key, getThreadAdapter(key), message.text, undefined, {
    isRequestReminder: !message.isRequestPrompt,
  });
}

/**
 * @description The person took over the conversation (interrupt, quit, restart,
 * switch or resume of the session, a switch to another agent or a shell, leaving
 * the folder): its open request closes silently and nothing wakes it. Safe before
 * the engine exists (early boot).
 */
function cancelConversationRequest(key: SessionKey): void {
  void requestWakeUpEngine?.cancelConversation(key).catch((e) =>
    console.warn(`[requests] cancelling the request of ${keyToString(key)} failed:`, e instanceof Error ? e.message : e),
  );
}

/**
 * @name SchedulerWiringDeps
 * @description What the bot MCP server needs from the boot that `wireScheduler`
 * cannot build itself: the request ledger behind `answer_request` and the gate
 * that opens once the boot re-attached the surviving sessions.
 */
interface SchedulerWiringDeps {
  requestLedger: RequestLedger;
  answerSinks: AnswerSinks;
  whenSessionsRestored: () => Promise<void>;
}

/**
 * @description How a prompt is posted into a conversation's session — the deps of
 * {@link postToSession}, shared by the scheduler's fire and the Jira connector's
 * requests (Jira plan J5, D21).
 */
function createSessionPostDeps(): PostToSessionDeps {
  return {
    holdForLimitResume: (conversationKey, text, heldText) => holdPromptForLimitResume(keyFromString(conversationKey), text, heldText),
    checkBusy: (conversationKey) => {
      const key = keyFromString(conversationKey);
      return getThreadAdapter(key).checkIsBusy?.(key) ?? false;
    },
    ensureSession: async (conversationKey, fallbackAdapterName) => {
      const result = await ensureAgentSession(keyFromString(conversationKey), { fallbackAdapterName });
      return result.ok ? { ok: true } : { ok: false, reason: result.reason };
    },
    forwardPrompt: async (conversationKey, text) => {
      const key = keyFromString(conversationKey);
      await deliverPromptOrBuffer(key, text, startupPromptBuffer.checkIsStarting(conversationKey));
    },
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

/**
 * @description Construct the scheduler stack (S8): run ledger → delivery (thin
 * lambdas over the bot's existing send/session functions) → timer engine
 * (assigned to the module-level {@link schedulerEngine}) → the bot-owned MCP
 * server handle (NOT started — the caller starts it and wires the injection
 * with the actually-bound port). Lives outside `startBot` only for readability;
 * it captures the same module-level state the rest of bot.ts uses.
 */
function wireScheduler(wiring: SchedulerWiringDeps): SchedulerMcpHandle {
  const ledger = new RunLedger();
  const delivery = createScheduleDelivery({
    ...createSessionPostDeps(),
    announce: (threadKeyStr, text) => replyToThread(keyFromString(threadKeyStr), text),
    pin: async (threadKeyStr, messageId, isSilent) => {
      const key = keyFromString(threadKeyStr);
      await enqueueSend(
        key,
        () =>
          bot.telegram.pinChatMessage(getTelegramChatId(key), messageId, {
            disable_notification: isSilent,
          }),
      );
    },
    runCheck: async (threadKeyStr, command, timeoutMs) => {
      const decision = resolveBoundWorkDir(ENV.workRoot, state.getBinding(keyFromString(threadKeyStr)));
      if (decision.kind !== 'proceed') return null;
      return runCheckCommand({ command, cwd: decision.workDir, timeoutMs, env: buildCheckEnv(process.env) });
    },
    setCheckFailing: async (jobId, isFailing) => {
      const record = state.getSchedules()[jobId];
      if (!record) return;
      await state.upsertSchedule({ ...record, isCheckFailing: isFailing, updatedAt: new Date().toISOString() });
      await state.flush();
    },
  });

  /**
   * The engine's deliver callback: the S4 pipeline plus the S8 unbound-pause
   * policy — a fire that hits an unbound topic parks the job (paused +
   * disarmed + one notice) instead of failing forever on every occurrence.
   * The engine's bookkeeping sees the paused record and leaves it disarmed.
   */
  const deliver = async (job: ScheduleRecord, fireContext: FireContext): Promise<DeliveryOutcome> => {
    const key = keyFromString(job.threadKey);
    const outcome = await withThreadLocale(key, () => delivery(job, fireContext));
    if (outcome.status === 'failed' && outcome.error === unboundDeliveryError) {
      await state.setSchedulePaused(job.id, true, 'unbound');
      schedulerEngine?.disarmJob(job.id);
      await withThreadLocale(key, () => replyToThread(key, t('schedule.pausedUnbound', { count: 1 }))).catch(() => {});
    }
    return outcome;
  };

  schedulerEngine = createSchedulerEngine({
    store: state,
    ledger,
    deliver,
    now: () => Date.now(),
  });

  return createSchedulerMcpServer({
    store: state,
    armJob: (record) => schedulerEngine?.armJob(record),
    disarmJob: (jobId) => schedulerEngine?.disarmJob(jobId),
    getThreadsForDirectory: (directory) =>
      getThreadKeysForDirectory(state.listBindings(), ENV.workRoot, directory),
    getThreadAdapterName: (threadKeyStr) => {
      const key = keyFromString(threadKeyStr);
      return getThreadAdapterNameRaw(key) ?? state.getAgent(key)?.name;
    },
    // Routed through the outbound seam: the agent-facing file tool is a
    // connector delivery, not a direct call into the Telegram send pipeline.
    // The MCP surface is string-keyed (its `threadKey` arrives as text), so the
    // decode happens here; an unrecognised string never named a conversation
    // and falls through to the file service, which owns that error's wording.
    sendFilesToThread: (threadKeyString, request) => {
      const key = tryKeyFromString(threadKeyString);
      return key === null
        ? sendFilesToThread(threadKeyString, request)
        : telegramOutbound.deliverFile(key, request);
    },
    sendMessagesToThread,
    compactConversation: (threadKeyStr) => armDeferredCompaction(keyFromString(threadKeyStr)),
    answerRequest: (args) => answerRequest({ ledger: wiring.requestLedger, answerSinks: wiring.answerSinks }, args),
    whenSessionsRestored: wiring.whenSessionsRestored,
    getSecret: () => state.getSchedulerMcpSecret(),
    // Reuse the port persisted from a prior boot (env override wins) so the
    // `telegramBot` registrations injected into agent sessions keep pointing at
    // a live port across restarts instead of orphaning on a fresh ephemeral one.
    port: resolveSchedulerMcpPort(getSchedulerMcpPort(), state.getPersistedSchedulerMcpPort()),
  });
}

/**
 * @description Resolve the bot's admin rights in the paired group, or `null`
 * when it is not an administrator / the rights cannot be read. A bot can never
 * be a group `creator`, so only `administrator` carries the three permission
 * flags (mirrors the `/doctor` probe). Best-effort — any failure yields `null`,
 * which the readiness report treats as all three rights missing.
 */
async function resolveBotAdminRights(
  groupId: number,
  botUserId: number,
): Promise<BotAdminRights | null> {
  try {
    const member = await bot.telegram.getChatMember(groupId, botUserId);
    if (member.status !== 'administrator') return null;
    return {
      manageTopics: !!member.can_manage_topics,
      pin: !!member.can_pin_messages,
      delete: !!member.can_delete_messages,
    };
  } catch (e) {
    console.warn('[startup-status] getChatMember failed:', e instanceof Error ? e.message : e);
    return null;
  }
}

/**
 * @description Boot-time readiness status (plan 2026-07-12): on startup tell the
 * owner whether the bot can process messages, or list the setup steps still
 * missing. Delivery target depends on readiness (`resolveStartupTargets`): the
 * "✅ Ready" status is owner-DM-ONLY (`OWNER_USER_ID`) — it is pure noise in the
 * shared group, so it NEVER falls back to General; no owner DM ⇒ nothing is sent
 * (log only). The actionable NOT-READY checklist tries the owner DM first, then
 * falls back to the paired group's General topic. Cold start always sends; a hot
 * reload stays silent when fully ready (no spam on frequent rebuilds).
 * Best-effort: any send failure is logged, never thrown into the boot path.
 */
async function sendStartupStatus(isHotReload: boolean): Promise<void> {
  const groupId = getAllowedGroupId();
  const ownerUserId = getOwnerUserId();
  const ownerSet = Number.isFinite(ownerUserId);

  const botUserId = bot.botInfo?.id ?? (await bot.telegram.getMe()).id;
  const botRights =
    groupId !== null ? await resolveBotAdminRights(groupId, botUserId) : null;
  const hasBinding =
    groupId !== null && state.listBindings().some(({ key }) => getTelegramChatId(key) === groupId);
  const availableAgents = (['claude', 'opencode'] as const).filter((name) =>
    checkIsInstalled(name),
  );

  // When the owner is unset we fall back to General up front; a SET-but-unopened
  // owner DM surfaces later as a 403 at send time. `usedGeneralFallback` only
  // feeds the `optional_owner` hint, which itself requires `ownerSet` false — so
  // the text is identical whether it lands in the owner DM or General.
  const facts: ReadinessFacts = {
    groupPaired: groupId !== null,
    botRights,
    hasBinding,
    availableAgents,
    hasGroq: !!ENV.groqApiKey,
    ownerSet,
    usedGeneralFallback: !ownerSet,
  };
  const report = buildReadinessReport(facts);

  if (!checkShouldSendStartupStatus({ isHotReload, isReady: report.isReady })) {
    console.log(`[startup-status] hot reload + ready → skipping status message`);
    return;
  }

  const ownerKey: SessionKey | null = ownerSet
    ? makeTelegramKey(ownerUserId, DM_GENERAL_THREAD_ID)
    : null;
  const generalKey: SessionKey | null =
    groupId !== null ? makeTelegramKey(groupId, GENERAL_THREAD_ID) : null;

  const trySend = async (key: SessionKey): Promise<boolean> => {
    const text = withThreadLocale(key, () =>
      buildStartupStatusText(report, (code, opts) => t(code, opts)),
    );
    try {
      await bot.telegram.sendMessage(getTelegramChatId(key), text);
      return true;
    } catch (e) {
      console.warn(
        `[startup-status] send to ${keyToString(key)} failed:`,
        e instanceof Error ? e.message : e,
      );
      return false;
    }
  };

  // Ready → owner DM only (never General); not-ready → owner then General.
  const targets = resolveStartupTargets(report.isReady, ownerKey !== null, generalKey !== null);
  if (targets.length === 0) {
    // Reachable two ways: a READY status with no owner DM (never goes to General),
    // or a NOT-READY status on a bot with neither an owner DM nor a paired group.
    console.log(
      report.isReady
        ? '[startup-status] ready + no owner DM → not delivered (log only)'
        : '[startup-status] not ready + no reachable surface → not delivered (log only)',
    );
    return;
  }

  const keyByTarget: Record<StartupTarget, SessionKey | null> = {
    owner: ownerKey,
    general: generalKey,
  };
  for (const target of targets) {
    const key = keyByTarget[target];
    if (!key) continue; // resolveStartupTargets already filtered to available surfaces
    if (target === 'owner') {
      console.log(`[startup-status] sending (ready=${report.isReady}) to owner DM ${ownerUserId}`);
    } else {
      console.log(`[startup-status] sending (ready=${report.isReady}) to group General ${groupId}`);
    }
    if (await trySend(key)) return;
    if (target === 'owner') console.log('[startup-status] owner DM unreachable');
  }
  console.warn('[startup-status] no reachable target — status not delivered');
}

export async function startBot(): Promise<void> {
  console.log('');
  console.log('=================================');
  console.log('  TelegramCode Bot (multi-thread) starting...');
  console.log('=================================');
  console.log('Access:           forum-group admins/creator (live, cached)');
  console.log(`Work root:        ${ENV.workRoot}`);
  console.log(`Default Claude backend: ${getDefaultClaudeBackendName()}`);
  console.log(`Available agents: ${getAvailableAdapters().map(a => a.name).join(', ')}`);

  // 1. State store. The `[startup] DATA_DIR=` shape is load-bearing: the
  // README's two-instances troubleshooting tells the operator to compare this
  // exact line across instances.
  state = await getStateStore();
  console.log(`[startup] DATA_DIR=${path.dirname(state.stateFilePath)}`);

  // 1a. Apply the operator's timezone to the PROCESS, right after the store
  //     loads and before anything reads a clock. Assigning `process.env.TZ`
  //     re-bases `Date`/`Intl`, so every host-local render downstream (cron fire
  //     times, "missed at", `/timestamps`, schedule descriptions) speaks the
  //     operator's zone with no per-call-site threading. Nothing stored ⇒ the
  //     environment is left exactly as launched.
  applyProcessTimezone(state.getTimezone());
  console.log(`Timezone:         ${getEffectiveTimezone(state.getTimezone())} (host: ${getHostTimezone()})`);

  // 1b. Request ledger: index the closed-request history and reconcile the open
  //     set BEFORE the bot MCP server starts serving (step 5). A session that
  //     survived the restart may call a tool the moment the server listens, and
  //     a request looked up in a not-yet-loaded history would be refused as an
  //     unknown id. An unreadable history file fails the boot loudly.
  //     The answer sinks are built here, once: `answer_request`, the wake-up
  //     alerts and the release of an alert when its request closes all share them.
  const answerSinks = createAnswerSinks();
  const requestLedger = new RequestLedger({
    store: state,
    releaseAlert: (alert) => releaseRequestAlert(answerSinks, alert),
    onRequestCreated: (key) => announceLimitWaitToNewRequest(key),
  });
  await requestLedger.load();
  // The wake-up engine (S4) watches the turns requests start. It is created now
  // but started only once the sessions are restored (its sweep reads them).
  requestWakeUpEngine = new RequestWakeUpEngine({
    ledger: requestLedger,
    probeTurn: createSessionTurnProbe({
      getAdapter: getThreadAdapter,
      checkHasPendingQuestion: (keyString) => pendingQuestions.has(keyString),
      checkHasQuestionPin: (keyString) => questionPinnedMessageId.has(keyString),
      checkIsCompacting: (keyString) => threadsCompacting.has(keyString),
      getApiRetryTimer: (keyString) => apiRetryTimers.get(keyString)?.timer,
      checkIsWedgeRecoveryInFlight: (keyString) => wedgeRecoveriesInFlight.has(keyString),
      checkIsRetryKickInFlight: (keyString) => apiRetryKicksInFlight.has(keyString),
      checkIsSessionStarting: (keyString) => startupPromptBuffer.checkIsStarting(keyString),
      serializeKey: keyToString,
    }),
    prepareWakeUpSession: (key, message) =>
      prepareRequestWakeUpSession(key, message, undefined),
    forwardWakeUp: forwardRequestWakeUp,
    deliverAlert: async (key, request, reason) => {
      const lookup = getAnswerSink(answerSinks, key);
      const result = lookup.ok
        ? await lookup.sink.deliverAlert(key, { requestId: request.id, reason, origin: request.origin })
        : lookup;
      if (!result.ok) console.warn(`[requests] alert for ${request.id} not delivered: ${result.error}`);
      return result.ok ? (result.alertRef ?? null) : null;
    },
    backstopMs: getRequestBackstopMs(process.env.REQUEST_BACKSTOP_MINUTES),
  });
  requestLimitWaitAnswerDeps = { ledger: requestLedger, engine: requestWakeUpEngine, answerSinks };

  // Snapshot the persisted transient status-frame ids (S2) NOW, before reattach
  // can run any frame-id setter. A reattached session's first frame lifecycle
  // call persists the FRESH (all-null) in-memory state and would otherwise
  // clobber this crash-recovery set to empty before `reconcileTransientFrames`
  // reads it. Captured into a local so the orphans survive that clobber.
  const orphanedTransientFrames = state.getTransientFrames();

  // Seed the output-trace toggle from persisted state so a `/trace` setting
  // survives a hot rebuild mid-debug (the writer state lives in outputTrace.ts).
  setTraceConfig(state.getTraceConfig());

  // 1.5. Boot classification — hot reload vs cold start. Read the gap to
  //      the last persisted heartbeat BEFORE we stamp a fresh one
  //      (otherwise the comparison would always be against ourselves and
  //      every boot would look like a hot reload). `null` means "no
  //      heartbeat ever recorded" → conservative cold-start default.
  const downtimeMs = state.getDowntimeMs();
  const bootMode = classifyBoot(downtimeMs);
  console.log(
    `Boot mode:        ${bootMode.isHotReload ? 'HOT RELOAD' : 'COLD START'} ` +
      `(downtime=${downtimeMs === null ? 'unknown' : `${downtimeMs}ms`})`,
  );
  console.log(`Chat mode:        ${getChatMode()}`);
  // In `both`, the DM surface only lights up when an OWNER_USER_ID is set;
  // otherwise the instance serves the group only. Surface that explicitly so an
  // operator who expected DM to work knows why it is silent (the default `both`).
  if (getChatMode() === 'both' && ENV.isDmSurfaceInert) {
    console.log(
      'DM surface:       INERT (no OWNER_USER_ID set — group-only; set OWNER_USER_ID to enable the owner DM)',
    );
  }

  // 1a. Adopt a previously auto-paired group id (unless env locks one).
  if (!isGroupLockedByEnv && effectiveGroupId === null) {
    effectiveGroupId = state.getPairedGroupId();
  }
  console.log(
    `Allowed group:    ${
      getAllowedGroupId() ??
        '(pairing mode — add the bot to your forum supergroup and send a message)'
    }`,
  );
  if (state.wasCorruptedOnLoad()) {
    console.warn(
      `[startup] previous state.json was corrupted; archived to ${state.getCorruptedArchivePath()}`,
    );
    // Best-effort notice into General once the bot is up — only if we
    // already know the group (skipped while still in pairing mode).
    const groupId = getAllowedGroupId();
    if (groupId !== null) {
      setImmediate(() => {
        const generalKey: SessionKey = makeTelegramKey(groupId, GENERAL_THREAD_ID);
        withThreadLocale(generalKey, () => replyToThread(generalKey, t('error.state.corrupted'))).catch(() => {});
      });
    }
  }
  const legacyBackup = state.getLegacyMigrationPath();
  if (legacyBackup) {
    console.log(`[startup] legacy message-ids file archived to ${legacyBackup}`);
  }

  // 2. Wire adapter events.
  registerAdapterEventHandlers({
    onOutput: (key, output, meta) => {
      // Output means a turn is under way — the wake-up engine's busy-onset signal.
      requestWakeUpEngine?.noteAgentOutput(key);
      return withThreadLocale(key, () => handleAgentOutput(key, output, meta));
    },
    onStatus: (key, status) => withThreadLocale(key, () => handleAdapterStatus(key, status)),
    onQuestion: (key, question) => withThreadLocale(key, () => handleAgentQuestion(key, question)),
    onThinking: (key, payload) => withThreadLocale(key, () => handleAgentThinking(key, payload)),
    onToolResult: (key, payload) => withThreadLocale(key, () => handleAgentToolResult(key, payload)),
    onSubagentStatus: (key, payload) => withThreadLocale(key, () => handleSubagentStatus(key, payload)),
    onApiError: (key, error) => withThreadLocale(key, () => handleApiError(key, error)),
    onNoResponse: (key) => handleNoResponse(key),
    onQuestionGone: (key) => withThreadLocale(key, () => handleQuestionGone(key)),
    onClosed: (key) => withThreadLocale(key, () => handleAgentClosed(key)),
    onStarted: (key) => withThreadLocale(key, () => handleAgentStarted(key)),
    onStopped: (key) => withThreadLocale(key, () => handleAgentStopped(key)),
    onError: (key, error) => withThreadLocale(key, () => handleAgentError(key, error)),
  });
  // Both adapters branch on the per-thread display prefs while PRODUCING output
  // (OpenCode: child SSE parts on `subagent`; Claude: scrape-chunk relay routing
  // on `toolResults` + transcript tailing on `subagent`) — the prefs they cannot
  // resolve at render time. Same late-wiring idiom as the event handlers above;
  // before this line they fall back to all-fields-`minimal`.
  registerDisplayPrefsReader((key) => state.getDisplayPrefs(key));
  // Both adapters format user-facing strings on their own hot paths (Claude's
  // poll loop: question hints / tool-result status; OpenCode's SSE handler:
  // delegation status) OUTSIDE the bot's withThreadLocale wrapper. This reader
  // lets them resolve the thread's locale so those t(...) calls don't fall back
  // to en regardless of the chat's resolved locale.
  registerThreadLocaleReader((key) => getLocaleForKey(key));
  // Both adapters advance the per-thread seen-watermark at TURN END through this
  // writer (OpenCode on session.idle, Claude at the ready-prompt turn end) so a
  // later restart can recover output produced while the bot was down. Same
  // late-wiring idiom; inert (no-op) until this line runs.
  registerSeenWatermarkWriter((key, watermark) => {
    void state.setSeenWatermark(key, watermark);
  });
  // The json-stream tail poller persists its line-boundary stdout offset through
  // this writer (debounced save; the shutdown flush seals it) so the next boot
  // adopts the surviving external process and replays exactly the downtime gap.
  registerJsonStreamTailWriter((key, tail) => {
    void state.setJsonStreamTail(key, tail);
  });
  // The output path is selected ONCE here from CHAT_MODE (mirrors the adapter /
  // display-prefs wiring above) instead of a per-call surface branch at each
  // output site. Group is thin (queueOutput); DM owns the draft-cursor manager;
  // `both` dispatches per key via `checkIsDmKey`.
  registerOutputTransport(
    createOutputTransport(getChatMode(), {
      queueOutput,
      sendAgentChunks,
      getThreadMessageState,
      checkSupportsDraft: checkAdapterSupportsDraftStreaming,
      checkOutputsDeltas: checkAdapterOutputsDeltas,
      checkIsGeneral,
      checkIsDmKey,
      callSendMessageDraft,
      splitMessage,
      renderAgentHtml,
      maxMessageLength: MAX_MESSAGE_LEN,
      finalizeGroupOutput,
    }),
  );

  // 3. Connect to Telegram and register commands menu before starting local
  // daemons. If getMe fails, we should not leave an orphan opencode server.
  console.log('Testing Telegram API connection...');
  try {
    const botInfo = await bot.telegram.getMe();
    console.log(`Bot info: @${botInfo.username} (${botInfo.id})`);
    await bot.telegram.setMyCommands(COMMANDS_MENU);
    console.log('Bot commands menu set');
  } catch (err) {
    console.error('Failed to connect to Telegram API:', err);
    throw err;
  }

  // 4. Pre-start OpenCode server if available so first request is fast.
  if (getAvailableAdapters().some(a => a.name === 'opencode')) {
    try {
      console.log('[boot] pre-starting OpenCode server...');
      await ensureOpenCodeServer();
    } catch (e) {
      stopOpenCodeServer();
      console.log('[boot] OpenCode pre-start failed:', e instanceof Error ? e.message : e);
    }
  }

  // 5. Session phase (order owned by `runSessionBootPhase`, see
  //    `scheduler/mcpBoot.ts`). The bot MCP server (S8 scheduler wiring: run
  //    ledger → delivery → timer engine → MCP server) is bound and injection is
  //    configured FIRST, so every session re-attached or resumed below is born
  //    WITH the bot's server — a session spawned while injection was still inert
  //    never gets it, and the Claude heal path cannot add an absent server. A
  //    bind failure (port busy) keeps booting: injection stays inert, sessions
  //    spawned this run lack the agent-facing tools, engine timers still fire.
  let markSessionsRestored: () => void = () => {};
  const sessionsRestored = new Promise<void>((resolve) => {
    markSessionsRestored = resolve;
  });
  const schedulerMcpHandle = wireScheduler({
    requestLedger,
    answerSinks,
    whenSessionsRestored: () => sessionsRestored,
  });
  const isSchedulerMcpStarted = await runSessionBootPhase({
    startBotMcp: () =>
      startSchedulerMcpForBoot({
        handle: schedulerMcpHandle,
        envPort: getSchedulerMcpPort(),
        getPersistedPort: () => state.getPersistedSchedulerMcpPort(),
        persistPort: (port) => state.setSchedulerMcpPort(port),
        getSecret: () => state.getSchedulerMcpSecret(),
      }),
    // A successful re-adopt is silent; `quietReattach` only suppresses the
    // reattach ERROR notice (workDir vanished) during a hot reload, surfaced on
    // a real cold start.
    reattachSessions: () => reattachExistingSessions({ quietReattach: bootMode.isHotReload }),
    restoreAfterReattach: () => {
      // Re-arm pending interactive questions that survived the restart, so the
      // existing option buttons keep working. A question is restored only for a
      // thread whose session came back; otherwise it is unreachable, dropped.
      restorePendingQuestions();
      // Re-arm persisted API-error retries (S6) so a pending kick survives the
      // restart. AFTER restorePendingQuestions so the kick lands in a live
      // session; a past fireAt fires one delayed catch-up.
      restoreApiRetries();
      // Recover a limit episode that ENDED before this boot and left nothing
      // persisted (an unrecognised wording at the time): the json-stream
      // backend's stdout tail still holds its terminal error frame. AFTER
      // restoreApiRetries so an already-armed thread is skipped.
      recoverLimitEpisodesFromDisk();
      // Delete transient status frames orphaned by an UNGRACEFUL exit (S2). Each
      // leftover frame is provably stale now (the session is idle / will
      // repaint). A graceful exit already cleared the set in its sweep, so this
      // is normally a no-op. Uses the pre-reattach snapshot (the setters clobber
      // the live persisted set during reattach).
      reconcileTransientFrames(orphanedTransientFrames);
    },
    // The bot MCP tools that read session state (compact_conversation) wait
    // for this: until now a surviving session would read as not running.
    onSessionsRestored: () => {
      markSessionsRestored();
      // From here the engine can tell a live turn from a dead session.
      requestWakeUpEngine?.start();
    },
    healActiveSessions: () => {
      // When this boot ADOPTED an already-running opencode, that server may
      // still hold a `telegramBot` registration from the previous bot
      // generation pointing at a now-dead port. Reconcile against the live MCP
      // status and force-refresh any directory that is not `connected`.
      // Fire-and-forget: boot must not block on opencode HTTP round-trips
      // before `bot.launch()`. The compaction-plugin step goes FIRST: recreating
      // a directory instance so it loads the plugin drops that directory's MCP
      // registration, which this same reconcile then restores.
      const openCodeAdapter = getAdapter('opencode');
      void (async () => {
        await openCodeAdapter.activateCompactionPluginForActiveSessions?.();
        await openCodeAdapter.reconcileSchedulerMcpForActiveSessions?.();
      })().catch((e) =>
        console.warn('[scheduler] MCP reconcile failed:', e instanceof Error ? e.message : e),
      );
      // Same class of self-heal on the Claude side: a json-stream session that
      // SURVIVED this restart can hold a `telegramBot` entry latched `failed`,
      // and the CLI never retries a failed MCP server. Fire-and-forget.
      healSchedulerMcpForActiveSessions();
    },
    // Boot catch-up replay: arm every persisted job, fire one catch-up per
    // missed run. Independent of the MCP server (delivery does not need it).
    rearmSchedules: () =>
      schedulerEngine!.rearmAll().catch((e) => console.error('[scheduler] rearmAll failed:', e)),
  });

  // 5a. Refresh pinned banners for every binding. Threads that have a
  //     stored `pinnedStatusMessageId` get their banner edited in place;
  //     threads that don't (older state.json from before this feature, or
  //     bindings created while `can_pin_messages` was missing) get one
  //     freshly pinned. Failures are best-effort — `updatePinnedStatus`
  //     logs them itself.
  setImmediate(() => {
    Promise.all(
      state.listBindings().map(({ key }) => updatePinnedStatus(key).catch(() => {})),
    ).catch(() => {});
  });

  // 5b. Audit S13 / #18: periodically GC in-memory per-thread maps
  //     against state.json. Topics deleted via Telegram's UI don't
  //     produce a reliable service event; without this sweep their
  //     entries in `threadMessageStates` / `outputQueues` / etc. linger
  //     until the next failed send.
  const inMemoryGcInterval = setInterval(() => {
    try {
      const live = new Set(state.listBindings().map(({ key }) => keyToString(key)));
      // General-topic key always counts as live: in-memory state for
      // /status, /ls etc. is rooted there even without a binding row.
      const groupId = getAllowedGroupId();
      if (groupId !== null) live.add(`${groupId}:${GENERAL_THREAD_ID}`);
      let removed = 0;
      for (const m of [
        threadMessageStates as Map<string, unknown>,
        outputQueues as Map<string, unknown>,
        pendingQuestions as Map<string, unknown>,
        threadModelLists as Map<string, unknown>,
        threadSessionLists as Map<string, unknown>,
      ]) {
        for (const k of m.keys()) {
          if (!live.has(k)) { m.delete(k); removed += 1; }
        }
      }
      for (const k of awaitingModelSelection) {
        if (!live.has(k)) { awaitingModelSelection.delete(k); removed += 1; }
      }
      for (const k of awaitingSessionSelection) {
        if (!live.has(k)) { awaitingSessionSelection.delete(k); removed += 1; }
      }
      // NOTE: `awaitingFolderName` is intentionally NOT swept here. It arms an
      // UNBOUND thread (folder doesn't exist yet), so its key is never in
      // `live` — sweeping would clear a user who tapped "create folder" but is
      // still typing the name. The flag self-clears on the next message or any
      // command; an abandoned attempt costs one stray Set entry.
      // `reminderWizards` is excluded for the SAME reason and more strongly: a
      // reminder needs no binding at all, so a wizard legitimately lives in an
      // unbound topic and in General. It self-clears on finish, on any command,
      // and on the step-4 timeout.
      // Per-topic-name cache also benefits from the same sweep — entries
      // for live keys are valid until TTL; for dead keys, drop now.
      for (const k of pendingTopicNames.keys()) {
        if (!live.has(k)) { pendingTopicNames.delete(k); removed += 1; }
      }
      if (removed > 0) console.log(`[gc] removed ${removed} orphan in-memory entries`);
    } catch (e) {
      console.warn('[gc] sweep failed:', e);
    }
  }, 60_000);
  // Keep the interval handle so shutdown can clear it (so test-time
  // shutdowns don't leak timers).
  (globalThis as { __telegramCodeGcInterval?: NodeJS.Timeout }).__telegramCodeGcInterval = inMemoryGcInterval;

  // 5c. Heartbeat. Stamps `state.lastHeartbeatAt = Date.now()` every
  //     `HEARTBEAT_INTERVAL_MS`; the next boot reads the stamp to
  //     distinguish a nodemon hot-reload swap (sub-threshold gap) from
  //     the operator stopping/restarting the bot (large gap, or no stamp
  //     after a fresh state.json wipe). `touchHeartbeat()` is debounced
  //     via the existing 500ms save coalescer so this loop is cheap.
  const HEARTBEAT_INTERVAL_MS = 10_000;
  const heartbeatInterval = setInterval(() => {
    try {
      state.touchHeartbeat();
    } catch (e) {
      console.warn('[heartbeat] touchHeartbeat failed:', e);
    }
  }, HEARTBEAT_INTERVAL_MS);
  // Stamp once immediately so a very short-lived first boot still leaves
  // a marker for the next start to read.
  state.touchHeartbeat();

  // 5d. File-intake age sweep. Logrotate-style: delete intake files older
  //     than the retention window and prune now-empty thread dirs. Runs once
  //     at boot (catches files orphaned while the bot was down) and then once
  //     a day. The interval is `unref`'d so it never keeps the process alive.
  //     The same tick also prunes the observability buckets (trace + the
  //     bot-console tee) past the shared 6h retention — whole-bucket deletes,
  //     never the live bucket the writer is appending to.
  const runFileSweep = (): void => {
    const nowMs = Date.now();
    void sweepExpiredThreadFiles(resolveFilesRoot(getDataDir()), fileRetentionMs, nowMs)
      .then((result) => {
        if (result.removedFiles > 0 || result.removedDirs > 0) {
          console.log(
            `[fileSweep] removed ${result.removedFiles} expired files, ${result.removedDirs} empty dirs`,
          );
        }
      })
      .catch((e) => console.warn('[fileSweep] sweep failed:', e));
    // Orphan json-stream host dirs: a crash can leave a host dir behind for a
    // thread that no longer owns a json-stream session (the normal stop /
    // release paths delete the dir themselves; reattach's adopt/orphan-kill
    // covers live tmux sessions — this covers their dirs).
    void sweepOrphanJsonStreamDirs(resolveJsonStreamRoot(getDataDir()), (key) => {
      if (getAdapter(claudeJsonStreamAdapterName).checkIsActive(key)) return true;
      const agent = state.getAgent(key);
      return agent?.name === claudeJsonStreamAdapterName && !!agent.claudeSessionId;
    })
      .then((removedCount) => {
        if (removedCount > 0) console.log(`[fileSweep] removed ${removedCount} orphan jsonstream dirs`);
      })
      .catch((e) => console.warn('[fileSweep] jsonstream sweep failed:', e));
    // Best-effort already (pruneExpiredBuckets never throws) — the .catch is
    // belt-and-braces against an unexpected rejection from the shared helper.
    void pruneTraceBuckets(nowMs).catch((e) => console.warn('[fileSweep] trace prune failed:', e));
    void pruneExpiredBuckets(getDataDir(), consoleFileBase, consoleFileExt, logBucketRetentionMs, nowMs).catch(
      (e) => console.warn('[fileSweep] console prune failed:', e),
    );
  };
  runFileSweep();
  const fileSweepInterval = setInterval(runFileSweep, fileSweepIntervalMs);
  fileSweepInterval.unref();

  // 5e. Periodic per-chat outbound-rate summary (always-on instrumentation,
  //     plan 2026-06-24-rate-limit-429-metrics). Every ~5 min, log a
  //     `[RateLimit] rate chat=… sent/min=… peak10s=…` line for each chat with
  //     activity in the rolling minute (silent chats skipped) into bot-console.
  //     Lets us see how close normal operation runs to the per-chat ceiling
  //     WITHOUT needing a 429. Separate from the daily file sweep because the
  //     cadence differs; `unref`'d so it never keeps the process alive.
  const rateSummaryIntervalMs = 5 * 60 * 1000;
  const runRateSummary = (): void => {
    try {
      for (const summary of getActiveChatRateSummaries()) {
        console.log(formatRateSummaryLine(summary.chatId, summary.sentPerMin, summary.peak10s));
      }
    } catch (e) {
      console.warn('[RateLimit] rate summary failed:', e);
    }
  };
  const rateSummaryInterval = setInterval(runRateSummary, rateSummaryIntervalMs);
  rateSummaryInterval.unref();

  // 6. Global catch — Telegraf swallows handler errors otherwise.
  bot.catch((err, ctx) => {
    if (checkIsStaleAnswerCallbackQueryError(err)) {
      console.debug('[bot.catch] stale answerCallbackQuery ignored:', ctx.updateType);
      return;
    }
    console.error('[bot.catch] unhandled error:', err, 'update:', ctx.updateType);
  });

  // 7. Shutdown — preserve active agents for restart/reattach. Use /quit
  //    (or /quit-all) for an intentional agent stop; process signals only
  //    stop the bot itself. Ordering (bot.stop → state.flush →
  //    releaseLock → exit) is enforced by `gracefulShutdown` so the
  //    previous race against `lock.ts`'s synchronous `process.exit(0)`
  //    can't reappear. D5 (plan): we deliberately do NOT call
  //    `stopOpenCodeServer()` or `adapter.stopSession()` here — tmux and
  //    opencode survive the bot process by design and are picked back up
  //    by `reattachExistingSessions` on the next boot.
  const shutdown = (signal: string): void => {
    void gracefulShutdown({
      signal,
      bot,
      state,
      releaseLock,
      exit: (code) => process.exit(code),
      drainPendingUpdates: () => updateDispatcher.drainIdle(updateDrainTimeoutMs),
      finalizePendingOutput: () => finalizePendingOutputOnShutdown(),
      clearTransientFrames: () => sweepTransientFramesOnShutdown(),
      cleanupTimers: () => {
        clearInterval(inMemoryGcInterval);
        clearInterval(heartbeatInterval);
        clearInterval(fileSweepInterval);
        clearInterval(rateSummaryInterval);
        // Scheduler (S8): clear every armed job timer; persisted nextRunAt
        // means the next boot's rearmAll picks them back up (catch-up replay).
        schedulerEngine?.shutdown();
        requestWakeUpEngine?.stop();
        if (isSchedulerMcpStarted) void schedulerMcpHandle.stop().catch(() => {});
      },
    });
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  // 8. Launch. `dropPendingUpdates` follows the boot classifier: on a hot
  //    reload we KEEP the buffered backlog so a message typed during the
  //    ~1s reload window still routes to its live agent; on a cold start
  //    we drop stale updates that piled up while the bot was actually
  //    down (otherwise the user gets a flood of replies to old messages).
  // 9. Readiness status (plan 2026-07-12): tell the owner whether the bot can
  //    work, or what setup is still missing. Sent BEFORE bot.launch() on
  //    purpose: Telegraf v4's long-poll `launch()` awaits the polling loop and
  //    does NOT resolve until the bot STOPS, so anything after `await
  //    bot.launch()` runs only on shutdown (the "Bot is running!" logs below
  //    share that fate). Everything this needs — the paired group and botInfo
  //    (via a getMe fallback) — is already known, and sending is a direct Bot
  //    API call independent of polling. Best-effort so it can never fail boot.
  try {
    await sendStartupStatus(bootMode.isHotReload);
  } catch (e) {
    console.warn('[startup-status] failed:', e instanceof Error ? e.message : e);
  }

  console.log(`Launching Telegraf bot (long polling, dropPendingUpdates=${bootMode.dropPendingUpdates})...`);
  try {
    await bot.launch({
      dropPendingUpdates: bootMode.dropPendingUpdates,
      allowedUpdates: botAllowedUpdates,
    });
    console.log('');
    console.log('Bot is running! Waiting for messages...');
    console.log('Press Ctrl+C to stop');
    console.log('');
  } catch (err) {
    console.error('Failed to launch bot:', err);
    stopOpenCodeServer();
    throw err;
  }
}
