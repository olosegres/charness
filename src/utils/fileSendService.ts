/**
 * @description Reusable agent→Telegram file-send pipeline. The factory owns the
 * impure path resolution/snapshot work and executes the pure plan/request through
 * an injected typed gateway. Each canonical file is opened by one of two strategies
 * ({@link FileSendOpenStrategy}) — on Linux component-by-component beneath a pinned
 * root descriptor, elsewhere by its verified canonical path — identity-checked, and
 * owned through delivery bookkeeping.
 * Bot-specific stream creation and routing stay in the gateway; pacing/retry is
 * injected through `executeDelivery`. The service imports neither MCP nor Telegraf.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getAbortError } from '../utils';
import { AbortableFifo } from './abortableFifo';
import {
  buildTelegramFileSendRequest,
  classifyFileSendKind,
  getFileSendCountError,
  getTelegramUploadFilename,
  getTelegramFileOversizeError,
  planFileSend,
  resolveSendFileWithinDir,
  telegramSendMaxBytes,
  type FileDescriptorSnapshot,
  type FileIdentity,
  type FileSendItem,
  type FileSendMediaGroup,
} from './fileSendPlan';

export interface SendFilesToThreadOptions {
  paths: string[];
  caption?: string;
  asFile?: boolean;
  /** Canonical directory granted by a directory-scoped MCP token. */
  authorizedWorkDir?: string;
  signal?: AbortSignal;
}

export type SendFilesToThreadResult =
  | { ok: true; summary: string }
  | { ok: false; error: string }
  | { ok: false; kind: 'deliveryUnknown'; error: string };

/** Telegram may have accepted the request, but the response never confirmed it. */
export class FileSendDeliveryUnknownError extends Error {
  constructor(cause: Error) {
    super(`Telegram delivery outcome is unknown: ${cause.message}`, { cause });
    this.name = 'FileSendDeliveryUnknownError';
  }
}

export type SendFilesToThread = (
  threadKey: string,
  options: SendFilesToThreadOptions,
) => Promise<SendFilesToThreadResult>;

export type FileSendTargetResolution<TTarget> =
  | { ok: true; target: TTarget; workDir: string }
  | { ok: false; error: string };

export interface FileSendGatewayResult {
  messageIds: number[];
}

export interface FileSendGateway<TTarget> {
  sendPhoto: (
    target: TTarget,
    source: FileDescriptorSnapshot,
    caption?: string,
    signal?: AbortSignal,
  ) => Promise<FileSendGatewayResult>;
  sendAnimation: (
    target: TTarget,
    source: FileDescriptorSnapshot,
    caption?: string,
    signal?: AbortSignal,
  ) => Promise<FileSendGatewayResult>;
  sendVideo: (
    target: TTarget,
    source: FileDescriptorSnapshot,
    caption?: string,
    signal?: AbortSignal,
  ) => Promise<FileSendGatewayResult>;
  sendDocument: (
    target: TTarget,
    source: FileDescriptorSnapshot,
    caption?: string,
    signal?: AbortSignal,
  ) => Promise<FileSendGatewayResult>;
  sendMediaGroup: (
    target: TTarget,
    mediaGroup: FileSendMediaGroup,
    signal?: AbortSignal,
  ) => Promise<FileSendGatewayResult>;
}

export interface SendFilesToThreadDeps<TTarget> {
  resolveTargetAndWorkDir: (threadKey: string) => FileSendTargetResolution<TTarget>;
  gateway: FileSendGateway<TTarget>;
  recordMessageIds: (target: TTarget, messageIds: number[]) => Promise<void>;
  executeDelivery?: <TResult>(
    target: TTarget,
    delivery: () => Promise<TResult>,
    signal?: AbortSignal,
  ) => Promise<TResult>;
  readFileSnapshot?: typeof readTelegramFileSnapshot;
  /** How files are opened; the platform's own ({@link getFileSendOpenStrategy}) unless a test forces one. */
  openStrategy?: FileSendOpenStrategy;
}

/**
 * @name FileSendOpenStrategy
 * @description How a validated file is opened without reaching outside the bound folder through a swapped path:
 *  - `descriptorWalk` (Linux) — every component opened beneath the pinned root directory descriptor through
 *    `/proc/self/fd/<fd>/<name>` with `O_NOFOLLOW`: a component swapped to a symlink after validation is refused;
 *  - `verifiedPath` (Windows, macOS: no `/proc`, and Node exposes no `openat`) — the canonical path opened read-only, the
 *    opened object's bigint `{dev, ino}` held to the one validated inside the root, then the path resolved again: still
 *    inside the root and still that object. A swapped junction or symlink yields another object or another place. What
 *    it gives up against the walk: a root folder replaced at the same path is used as the root — no reach beyond what
 *    the agent, running with the user's rights in that folder, has anyway.
 */
export type FileSendOpenStrategy = 'descriptorWalk' | 'verifiedPath';

/** Canonical send root: pinned to one open directory descriptor, or (the portable strategy) its canonical path. */
export type PinnedFileSendRoot =
  | { strategy: 'descriptorWalk'; rootPath: string; fd: number }
  | { strategy: 'verifiedPath'; rootPath: string };

/** Bound descriptor-owning operations while Telegram's own queues are occupied. */
export const fileSendSnapshotConcurrency = 4;

export type TelegramFileSnapshotResult =
  | { ok: true; source: FileDescriptorSnapshot }
  | { ok: false; kind: 'read'; error: string }
  | { ok: false; kind: 'oversize'; error: string };

/** Linux exposes descriptor-relative child lookup; other platforms have none. */
export function getFileDescriptorPathRoot(platform: NodeJS.Platform): string | null {
  return platform === 'linux' ? '/proc/self/fd' : null;
}

/** The descriptor walk where the platform has descriptor-relative lookup, the verified path elsewhere. */
export function getFileSendOpenStrategy(platform: NodeJS.Platform): FileSendOpenStrategy {
  return getFileDescriptorPathRoot(platform) === null ? 'verifiedPath' : 'descriptorWalk';
}

const fileDescriptorPathRoot = getFileDescriptorPathRoot(process.platform);
const platformOpenStrategy = getFileSendOpenStrategy(process.platform);

const directoryOpenFlags =
  fs.constants.O_RDONLY |
  fs.constants.O_DIRECTORY |
  fs.constants.O_NOFOLLOW |
  fs.constants.O_NONBLOCK;

const fileOpenFlags =
  fs.constants.O_RDONLY |
  fs.constants.O_NOFOLLOW |
  fs.constants.O_NONBLOCK;

/**
 * The portable strategy's flags: read-only, and non-blocking where the platform has it (a FIFO raced into place must
 * not block the bot; Windows defines no `O_NONBLOCK` — and has no FIFOs a path can name).
 */
const verifiedPathOpenFlags = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0);

/** Canonicalize and pin the operation root before resolving any send item. */
function openPinnedFileSendRoot(workDir: string, strategy: FileSendOpenStrategy): PinnedFileSendRoot {
  const rootPath = fs.realpathSync(workDir);
  if (strategy === 'verifiedPath') return { strategy, rootPath };
  return { strategy, rootPath, fd: fs.openSync(rootPath, directoryOpenFlags) };
}

/** `absPath` relative to `rootPath` when it lies strictly inside it, else `null`. */
function getPathWithinRoot(rootPath: string, absPath: string): string | null {
  const relativePath = path.relative(rootPath, absPath);
  if (
    relativePath.length === 0 ||
    relativePath === '..' ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    return null;
  }
  return relativePath;
}

/** Close one descriptor and return a readable failure instead of throwing. */
function closeFileDescriptor(fileDescriptor: number): string | null {
  try {
    fs.closeSync(fileDescriptor);
    return null;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'unknown error';
    return `cannot close file descriptor: ${errorMessage}`;
  }
}

/** Address one child through its already-open parent directory descriptor. */
function getDescriptorChildPath(parentDescriptor: number, childName: string): string {
  if (fileDescriptorPathRoot === null) {
    throw new Error(`descriptor-relative lookup is unavailable on ${process.platform}`);
  }
  return path.posix.join(fileDescriptorPathRoot, parentDescriptor.toString(), childName);
}

/**
 * Open a canonical file beneath its canonical root without resolving any
 * caller-controlled parent component twice. Each directory descriptor pins the
 * next lookup, and O_NOFOLLOW rejects a component swapped to a symlink.
 */
function openFileBeneathRoot(pinnedRoot: PinnedFileSendRoot & { strategy: 'descriptorWalk' }, absPath: string): number {
  const relativePath = getPathWithinRoot(pinnedRoot.rootPath, absPath);
  if (relativePath === null) {
    throw new Error(`file is outside its validated root: ${absPath}`);
  }

  const pathComponents = relativePath.split(path.sep);
  const fileName = pathComponents[pathComponents.length - 1];
  const directoryComponents = pathComponents.slice(0, -1);
  const directoryDescriptors: number[] = [];
  let fileDescriptor: number | null = null;
  let openError: string | null = null;
  try {
    let parentDescriptor = pinnedRoot.fd;
    for (const directoryName of directoryComponents) {
      parentDescriptor = fs.openSync(
        getDescriptorChildPath(parentDescriptor, directoryName),
        directoryOpenFlags,
      );
      directoryDescriptors.push(parentDescriptor);
    }
    fileDescriptor = fs.openSync(
      getDescriptorChildPath(parentDescriptor, fileName),
      fileOpenFlags,
    );
  } catch (error) {
    openError = error instanceof Error ? error.message : 'unknown error';
  }

  let closeError: string | null = null;
  for (const directoryDescriptor of directoryDescriptors.reverse()) {
    const descriptorCloseError = closeFileDescriptor(directoryDescriptor);
    if (closeError === null && descriptorCloseError !== null) {
      closeError = descriptorCloseError;
    }
  }

  if (openError !== null || closeError !== null || fileDescriptor === null) {
    if (fileDescriptor !== null) {
      const descriptorCloseError = closeFileDescriptor(fileDescriptor);
      if (closeError === null && descriptorCloseError !== null) {
        closeError = descriptorCloseError;
      }
    }
    throw new Error(
      [openError, closeError, fileDescriptor === null && openError === null ? 'file open failed' : null]
        .filter((errorMessage) => errorMessage !== null)
        .join('; '),
    );
  }

  return fileDescriptor;
}

/**
 * @description The portable strategy's open: the canonical path, checked to lie inside the root, opened read-only.
 * The identity check and {@link getVerifiedPathChangeError} that follow are what pin it to the validated object.
 */
function openVerifiedPath(rootPath: string, absPath: string): number {
  if (getPathWithinRoot(rootPath, absPath) === null) {
    throw new Error(`file is outside its validated root: ${absPath}`);
  }
  return fs.openSync(absPath, verifiedPathOpenFlags);
}

/**
 * @description After the portable open: the path, resolved again, must still lie inside the root and still name the
 * object that was opened — a parent swapped to an outside folder before the identity was captured passes the identity
 * check (the captured identity is the outside file's), and fails here. `null` when it holds.
 */
function getVerifiedPathChangeError(rootPath: string, absPath: string, openedIdentity: FileIdentity): string | null {
  const changedError = `file changed after validation: ${absPath}`;
  try {
    const currentPath = fs.realpathSync(absPath);
    if (getPathWithinRoot(rootPath, currentPath) === null) return changedError;
    const currentStat = fs.statSync(currentPath, { bigint: true });
    return currentStat.dev === openedIdentity.dev && currentStat.ino === openedIdentity.ino ? null : changedError;
  } catch {
    return changedError;
  }
}

/**
 * @description Open one already-canonical path beneath its canonical root by the root's strategy — the descriptor walk
 * without following swapped parent/final symlinks, or the verified path — validate the opened object's bigint
 * device/inode identity and size (and, for the verified path, that the path still resolves to it inside the root),
 * then transfer ownership of the still-open descriptor to the caller. Every failure closes the descriptor before
 * returning.
 */
export function readTelegramFileSnapshot(
  absPath: string,
  expectedIdentity: FileIdentity,
  pinnedRoot: PinnedFileSendRoot,
): TelegramFileSnapshotResult {
  let fileDescriptor: number | null = null;
  let result: TelegramFileSnapshotResult;
  try {
    fileDescriptor = pinnedRoot.strategy === 'descriptorWalk'
      ? openFileBeneathRoot(pinnedRoot, absPath)
      : openVerifiedPath(pinnedRoot.rootPath, absPath);
    const fileStat = fs.fstatSync(fileDescriptor, { bigint: true });
    const pathChangeError = pinnedRoot.strategy === 'verifiedPath' && fileStat.isFile()
      ? getVerifiedPathChangeError(pinnedRoot.rootPath, absPath, { dev: fileStat.dev, ino: fileStat.ino })
      : null;
    if (!fileStat.isFile()) {
      result = { ok: false, kind: 'read', error: `not a regular file: ${absPath}` };
    } else if (fileStat.dev !== expectedIdentity.dev || fileStat.ino !== expectedIdentity.ino) {
      result = { ok: false, kind: 'read', error: `file changed after validation: ${absPath}` };
    } else if (pathChangeError !== null) {
      result = { ok: false, kind: 'read', error: pathChangeError };
    } else if (fileStat.size > BigInt(telegramSendMaxBytes)) {
      result = {
        ok: false,
        kind: 'oversize',
        error: getTelegramFileOversizeError(absPath),
      };
    } else {
      result = {
        ok: true,
        source: {
          fd: fileDescriptor,
          filename: getTelegramUploadFilename(absPath),
          sizeBytes: Number(fileStat.size),
        },
      };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'unknown error';
    result = { ok: false, kind: 'read', error: errorMessage };
  }

  if (!result.ok && fileDescriptor !== null) {
    const descriptorCloseError = closeFileDescriptor(fileDescriptor);
    if (descriptorCloseError !== null) {
      return {
        ok: false,
        kind: 'read',
        error: `${result.error}; ${descriptorCloseError}`,
      };
    }
  }
  return result;
}

const messageIdRecordingWarning =
  'Telegram delivery succeeded, but message IDs could not be recorded';
const descriptorCleanupWarning =
  'Telegram delivery succeeded, but local descriptor cleanup failed';

/** Preserve the normal success summary while surfacing a post-delivery local failure. */
function appendFileSendWarning(summary: string, warning: string): string {
  return `${summary} Warning: ${warning}`;
}

/**
 * @description Compose the complete file-send operation around a target/workdir
 * resolver and Telegram gateway. A gateway return confirms delivery; subsequent
 * message-id persistence or descriptor cleanup failures are success warnings so
 * callers do not retry and duplicate an already-delivered message or album.
 */
export function createSendFilesToThread<TTarget>(
  deps: SendFilesToThreadDeps<TTarget>,
): SendFilesToThread {
  let activeSnapshotOperations = 0;
  const snapshotOperationWaiters = new AbortableFifo();

  async function executeWithSnapshotSlot<TResult>(
    operation: () => Promise<TResult>,
    signal?: AbortSignal,
  ): Promise<TResult> {
    if (signal?.aborted) throw getAbortError(signal);
    if (activeSnapshotOperations < fileSendSnapshotConcurrency) {
      activeSnapshotOperations += 1;
    } else {
      await snapshotOperationWaiters.wait(signal);
    }

    try {
      if (signal?.aborted) throw getAbortError(signal);
      return await operation();
    } finally {
      if (!snapshotOperationWaiters.resolveNext()) {
        activeSnapshotOperations -= 1;
      }
    }
  }

  return async (threadKey, options) => executeWithSnapshotSlot(async () => {
    const ownedFileDescriptors: number[] = [];
    const ownedRoot: { pinnedRoot: PinnedFileSendRoot | null } = { pinnedRoot: null };
    let operationResult: SendFilesToThreadResult;
    let closeError: string | null = null;

    try {
      operationResult = await (async (): Promise<SendFilesToThreadResult> => {
        const targetResolution = deps.resolveTargetAndWorkDir(threadKey);
        if (!targetResolution.ok) return { ok: false, error: targetResolution.error };
        const { target, workDir } = targetResolution;
        if (
          options.authorizedWorkDir !== undefined &&
          workDir !== options.authorizedWorkDir
        ) {
          return {
            ok: false,
            error: 'thread is no longer bound to the authorized directory',
          };
        }

        const countError = getFileSendCountError(options.paths.length);
        if (countError !== null) return { ok: false, error: countError };

        const pinnedRoot = openPinnedFileSendRoot(workDir, deps.openStrategy ?? platformOpenStrategy);
        ownedRoot.pinnedRoot = pinnedRoot;
        const items: FileSendItem[] = [];
        const readFileSnapshot = deps.readFileSnapshot ?? readTelegramFileSnapshot;
        for (const rawPath of options.paths) {
          const resolved = resolveSendFileWithinDir(
            workDir,
            rawPath,
            pinnedRoot.rootPath,
          );
          if (!resolved.ok) return { ok: false, error: resolved.error };

          const snapshot = readFileSnapshot(resolved.absPath, resolved.identity, pinnedRoot);
          if (!snapshot.ok) {
            return {
              ok: false,
              error: snapshot.kind === 'oversize'
                ? snapshot.error
                : `cannot read ${rawPath}: ${snapshot.error}`,
            };
          }
          ownedFileDescriptors.push(snapshot.source.fd);
          items.push({
            absPath: resolved.absPath,
            source: snapshot.source,
            kind: classifyFileSendKind(resolved.absPath),
          });
        }

        const plan = planFileSend(items, options.asFile ?? false);
        if (plan.kind === 'error') return { ok: false, error: plan.error };

        const request = buildTelegramFileSendRequest(plan, options.caption);
        const executeDelivery = deps.executeDelivery ?? ((_target, delivery) => delivery());
        return executeDelivery(target, async () => {
          let deliveryTarget = target;
          if (options.authorizedWorkDir !== undefined) {
            const currentTargetResolution = deps.resolveTargetAndWorkDir(threadKey);
            if (!currentTargetResolution.ok) {
              return { ok: false, error: currentTargetResolution.error };
            }
            if (currentTargetResolution.workDir !== options.authorizedWorkDir) {
              return {
                ok: false,
                error: 'thread is no longer bound to the authorized directory',
              };
            }
            deliveryTarget = currentTargetResolution.target;
          }

          const requestMethod = request.method;
          let gatewayResult: FileSendGatewayResult;
          switch (requestMethod) {
            case 'sendPhoto':
              gatewayResult = await deps.gateway.sendPhoto(
                deliveryTarget,
                request.source,
                request.caption,
                options.signal,
              );
              break;
            case 'sendAnimation':
              gatewayResult = await deps.gateway.sendAnimation(
                deliveryTarget,
                request.source,
                request.caption,
                options.signal,
              );
              break;
            case 'sendVideo':
              gatewayResult = await deps.gateway.sendVideo(
                deliveryTarget,
                request.source,
                request.caption,
                options.signal,
              );
              break;
            case 'sendDocument':
              gatewayResult = await deps.gateway.sendDocument(
                deliveryTarget,
                request.source,
                request.caption,
                options.signal,
              );
              break;
            case 'sendMediaGroup':
              gatewayResult = await deps.gateway.sendMediaGroup(
                deliveryTarget,
                request.mediaGroup,
                options.signal,
              );
              break;
            default: {
              const unsupportedMethod: never = requestMethod;
              throw new Error(`Unsupported file send method: ${unsupportedMethod}`);
            }
          }
          const summary = `Sent ${items.length} file(s) to the topic.`;
          try {
            await deps.recordMessageIds(deliveryTarget, gatewayResult.messageIds);
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'unknown error';
            return {
              ok: true,
              summary: appendFileSendWarning(
                summary,
                `${messageIdRecordingWarning}: ${errorMessage}`,
              ),
            };
          }
          return { ok: true, summary };
        }, options.signal);
      })();
    } catch (error) {
      if (error instanceof FileSendDeliveryUnknownError) {
        operationResult = {
          ok: false,
          kind: 'deliveryUnknown',
          error: `${error.message}. Telegram may already have accepted this delivery; MUST NOT retry automatically.`,
        };
      } else {
        if (options.signal?.aborted) throw getAbortError(options.signal);
        const errorMessage = error instanceof Error ? error.message : 'unknown error';
        operationResult = { ok: false, error: errorMessage };
      }
    } finally {
      for (const fileDescriptor of ownedFileDescriptors) {
        const descriptorCloseError = closeFileDescriptor(fileDescriptor);
        if (closeError === null && descriptorCloseError !== null) {
          closeError = descriptorCloseError;
        }
      }
      if (ownedRoot.pinnedRoot?.strategy === 'descriptorWalk') {
        const descriptorCloseError = closeFileDescriptor(ownedRoot.pinnedRoot.fd);
        if (closeError === null && descriptorCloseError !== null) {
          closeError = descriptorCloseError;
        }
      }
    }

    if (closeError !== null) {
      return operationResult.ok
        ? {
          ok: true,
          summary: appendFileSendWarning(
            operationResult.summary,
            `${descriptorCleanupWarning}: ${closeError}`,
          ),
        }
        : { ...operationResult, error: `${operationResult.error}; ${closeError}` };
    }
    return operationResult;
  }, options.signal);
}
