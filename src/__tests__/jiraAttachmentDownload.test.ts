/**
 * @description The stall timer of `downloadJiraAttachment`, on a clock the test moves by hand. The timer is a plain
 * `setTimeout`, re-armed by every chunk: a download that is slow but steady must survive it, and one that goes quiet for the
 * whole bound must not. Racing a server's timer against the client's cannot decide that — a loaded host that pauses the process
 * for as long as the gap makes the stall timer win, however correct the code — so the arms of the timer are RECORDED and its
 * firing is the test's, over a body the test feeds chunk by chunk. The real server and real `fetch` cases (a connection that
 * stops delivering, one that never answers, a 40 MB stream) are in `jiraAttachmentTool.test.ts`.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { afterEach, beforeEach, describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setTimeout as sleep } from 'node:timers/promises';
import { downloadJiraAttachment } from '../connectors/jira/attachmentDownload';

/** The bound the downloads in this file run with: the only delay the fake clock takes over (any other timer in the process stays real). */
const stallBoundMs = 250;
const waitBoundMs = 2_000;
const siteUrl = 'https://example-site.atlassian.net';
const authorization = 'Basic not-a-real-credential';

interface FakeTimer {
  callback: () => void;
  isCleared: boolean;
}

interface StallTimers {
  /** How many stall timers were armed so far. */
  armedCount: () => number;
  /** How many armed timers were not cleared. */
  liveCount: () => number;
  /** Resolves once `count` timers have been armed. */
  waitForArms: (count: number) => Promise<void>;
  /** The bound passes with no chunk: runs the live timer's callback. */
  fireLive: () => void;
}

/**
 * Replace the global `setTimeout` / `clearTimeout` for the test (restored at its end). A timer armed with the stall bound is not
 * armed for real, so no wall clock can run out behind the test's back; every other timer goes to the real functions.
 */
function recordStallTimers(context: TestContext): StallTimers {
  const timers: FakeTimer[] = [];
  const waiters: Array<{ count: number; resolve: () => void }> = [];
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  context.mock.method(globalThis, 'setTimeout', (callback: () => void, delayMs: number): FakeTimer | NodeJS.Timeout => {
    if (delayMs !== stallBoundMs) return realSetTimeout(callback, delayMs);
    const timer = { callback, isCleared: false };
    timers.push(timer);
    for (const waiter of waiters) if (timers.length >= waiter.count) waiter.resolve();
    return timer;
  });
  context.mock.method(globalThis, 'clearTimeout', (handle: FakeTimer | NodeJS.Timeout) => {
    if ('isCleared' in handle) handle.isCleared = true;
    else realClearTimeout(handle);
  });
  const getLive = (): FakeTimer[] => timers.filter((timer) => !timer.isCleared);
  return {
    armedCount: () => timers.length,
    liveCount: () => getLive().length,
    waitForArms: (count) => (timers.length >= count
      ? Promise.resolve()
      : Promise.race([
        new Promise<void>((resolve) => { waiters.push({ count, resolve }); }),
        // The module's timer, not the replaced global one.
        sleep(waitBoundMs).then(() => { throw new Error(`the code never armed stall timer ${count} (armed: ${timers.length})`); }),
      ])),
    fireLive: () => {
      const live = getLive();
      assert.equal(live.length, 1, 'exactly one stall timer is live');
      live[0].callback();
    },
  };
}

/** A download whose body the test feeds by hand; the abort signal errors the body, as a real fetch's does. */
function createFedDownload(): { fetchImpl: typeof fetch; feed: (text: string) => void; end: () => void } {
  let bodyController: ReadableStreamDefaultController<Uint8Array> | null = null;
  const getBodyController = (): ReadableStreamDefaultController<Uint8Array> => {
    if (!bodyController) throw new Error('the download was not requested yet');
    return bodyController;
  };
  const fetchImpl: typeof fetch = async (_input, init) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        bodyController = controller;
        init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason), { once: true });
      },
    });
    return new Response(body, { status: 200 });
  };
  return { fetchImpl, feed: (text) => getBodyController().enqueue(Buffer.from(text)), end: () => getBodyController().close() };
}

describe('the stall timer of a download, on a clock the test moves by hand', () => {
  let workDir = '';
  let destinationPath = '';

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jira-stall-'));
    destinationPath = path.join(workDir, 'download.bin');
  });

  afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  const startDownload = (fetchImpl: typeof fetch): ReturnType<typeof downloadJiraAttachment> => downloadJiraAttachment(
    { baseUrl: siteUrl, authorization, fetchImpl, stallTimeoutMs: stallBoundMs },
    '8',
    destinationPath,
  );

  it('an arrival that keeps delivering, however slowly, is not a stall: every chunk starts the full bound again', { timeout: 5_000 }, async (context) => {
    const timers = recordStallTimers(context);
    const download = createFedDownload();
    const outcome = startDownload(download.fetchImpl);
    const chunkCount = 3;
    for (let chunkNumber = 1; chunkNumber <= chunkCount; chunkNumber += 1) {
      // Armed once before the request, then once before each read: the reader is waiting under a fresh, full bound.
      await timers.waitForArms(chunkNumber + 1);
      assert.equal(timers.liveCount(), 1, `before chunk ${chunkNumber} exactly one stall timer is live, armed with the whole bound`);
      download.feed('abcd');
    }
    await timers.waitForArms(chunkCount + 2);
    download.end();
    assert.deepEqual(await outcome, { ok: true, bytes: 12 });
    assert.equal(fs.readFileSync(destinationPath, 'utf8'), 'abcdabcdabcd');
    assert.equal(timers.armedCount(), chunkCount + 2, 'one arm for the request and one for each of the four reads');
    assert.equal(timers.liveCount(), 0, 'the finished download leaves no timer');
  });

  it('a bound that passes with no chunk aborts the download, however many chunks came before: no file is left', { timeout: 5_000 }, async (context) => {
    const timers = recordStallTimers(context);
    const download = createFedDownload();
    const outcome = startDownload(download.fetchImpl);
    await timers.waitForArms(2);
    download.feed('abcd');
    await timers.waitForArms(3);
    timers.fireLive();
    const result = await outcome;
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.detail, /no data for/);
    assert.deepEqual(fs.readdirSync(workDir), [], 'neither the file nor its temporary name');
  });
});
