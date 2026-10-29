/**
 * @description Coverage for the StateStore collection of the questions the idle compaction re-asked
 * (`setReAskedQuestion` / `clearReAskedQuestion` / `getReAskedQuestions`): the message id of the re-asked copy and its
 * question, kept on disk so that after a bot restart the copy's buttons still work while the conversation sleeps — and so a
 * restart that finds the conversation released can close the message instead of leaving buttons that do nothing.
 *
 *   - set → reload a FRESH StateStore on the same dataDir → restored verbatim (a fresh instance proves the disk, not memory).
 *   - clear → gone, and an emptied map drops the field for a clean `state.json`.
 *   - per-thread isolation: clearing one thread leaves the other intact.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { beforeEach, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { StateStore } from '../state';
import type { ReAskedQuestionRecord } from '../types';
import { keyToString, type SessionKey } from '../sessionKey';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';

const threadA: SessionKey = makeTelegramKey(-1001234567890, 11);
const threadB: SessionKey = makeTelegramKey(-1001234567890, 22);

const sampleRecord = (messageId: number): ReAskedQuestionRecord => ({
  messageId,
  question: {
    question: 'Which database should I use?',
    header: 'Database choice',
    options: [{ label: 'Postgres', description: 'relational' }, { label: 'SQLite' }],
  },
});

describe('StateStore re-asked question collection', () => {
  let dataDir: string;
  let fakeHome: string;
  let originalHome: string | undefined;
  let createdStores: StateStore[] = [];

  function trackStore(store: StateStore): StateStore {
    createdStores.push(store);
    return store;
  }

  beforeEach(() => {
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcode-raq-'));
    dataDir = path.join(fakeHome, '.charness');
    fs.mkdirSync(dataDir, { recursive: true });
    originalHome = process.env.HOME;
    process.env.HOME = fakeHome;
  });

  afterEach(async () => {
    for (const store of createdStores) await store.flush();
    createdStores = [];
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  it('round-trips a re-asked question across a StateStore reload', async () => {
    const store = trackStore(new StateStore(dataDir, { saveDebounceMs: 20 }));
    await store.init();
    await store.setReAskedQuestion(threadA, sampleRecord(4242));
    await store.flush();

    const reloaded = trackStore(new StateStore(dataDir, { saveDebounceMs: 20 }));
    await reloaded.init();
    assert.deepEqual(reloaded.getReAskedQuestions(), { [keyToString(threadA)]: sampleRecord(4242) });
  });

  it('clearing drops the record, and the emptied map leaves no field in state.json', async () => {
    const store = trackStore(new StateStore(dataDir, { saveDebounceMs: 20 }));
    await store.init();
    await store.setReAskedQuestion(threadA, sampleRecord(4242));
    await store.clearReAskedQuestion(threadA);
    await store.flush();

    assert.deepEqual(store.getReAskedQuestions(), {});
    const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8')) as Record<string, unknown>;
    assert.equal('reAskedQuestions' in saved, false);
  });

  it('clearing a thread that has none changes nothing', async () => {
    const store = trackStore(new StateStore(dataDir, { saveDebounceMs: 20 }));
    await store.init();
    await store.clearReAskedQuestion(threadA);
    assert.deepEqual(store.getReAskedQuestions(), {});
  });

  it('keeps one record per thread: clearing one leaves the other', async () => {
    const store = trackStore(new StateStore(dataDir, { saveDebounceMs: 20 }));
    await store.init();
    await store.setReAskedQuestion(threadA, sampleRecord(1));
    await store.setReAskedQuestion(threadB, sampleRecord(2));
    await store.clearReAskedQuestion(threadA);

    assert.deepEqual(Object.keys(store.getReAskedQuestions()), [keyToString(threadB)]);
    assert.equal(store.getReAskedQuestions()[keyToString(threadB)].messageId, 2);
  });
});
