/**
 * @description Coverage for the StateStore collection of the questions the bot set aside (`setSetAsideQuestions` /
 * `getSetAsideQuestions`) and the counter their ids come from (`takeNextSetAsideQuestionSequence`): kept on disk so that after
 * a bot restart the open questions' buttons still resolve, and so an id is never reused.
 *
 *   - set → reload a FRESH StateStore on the same dataDir → restored verbatim, in order (a fresh instance proves the disk, not memory).
 *   - an empty list drops the topic's entry, and the emptied map leaves no field in `state.json`.
 *   - per-thread isolation: one topic's list and counter never touch another's.
 *   - the counter only goes up: two calls never get the same number, and neither does a call after a reload, a close or an empty list.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { beforeEach, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { StateStore } from '../state';
import type { SetAsideQuestionRecord } from '../types';
import { keyToString, type SessionKey } from '../sessionKey';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';

const threadA: SessionKey = makeTelegramKey(-1001234567890, 11);
const threadB: SessionKey = makeTelegramKey(-1001234567890, 22);

const createRecord = (id: string, messageId: number): SetAsideQuestionRecord => ({
  id,
  messageId,
  questions: [{ question: 'Which database should I use?', header: 'Database choice', options: [{ label: 'Postgres', description: 'relational' }, { label: 'SQLite' }] }],
  answers: [null],
  lateFromIndex: 0,
  askedAt: 1_800_000_000_000,
  setAsideAt: 1_800_001_800_000,
});

describe('StateStore set-aside question collection', () => {
  let dataDir: string;
  let fakeHome: string;
  let originalHome: string | undefined;
  let createdStores: StateStore[] = [];

  function trackStore(store: StateStore): StateStore {
    createdStores.push(store);
    return store;
  }

  async function createStore(): Promise<StateStore> {
    const store = trackStore(new StateStore(dataDir, { saveDebounceMs: 20 }));
    await store.init();
    return store;
  }

  function readStateFile(): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
  }

  beforeEach(() => {
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcode-saq-'));
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

  it('nothing is set aside in a fresh store', async () => {
    const store = await createStore();
    assert.deepEqual(store.getSetAsideQuestions(), {});
  });

  it('round-trips the records of a topic, in order, across a StateStore reload', async () => {
    const store = await createStore();
    await store.setSetAsideQuestions(threadA, [createRecord('1', 101), createRecord('2', 102)]);
    await store.flush();

    const reloaded = await createStore();
    assert.deepEqual(reloaded.getSetAsideQuestions(), { [keyToString(threadA)]: [createRecord('1', 101), createRecord('2', 102)] });
  });

  it('replacing the list replaces it: a record that is gone from it is gone', async () => {
    const store = await createStore();
    await store.setSetAsideQuestions(threadA, [createRecord('1', 101), createRecord('2', 102)]);
    await store.setSetAsideQuestions(threadA, [createRecord('2', 102)]);
    assert.deepEqual(store.getSetAsideQuestions(), { [keyToString(threadA)]: [createRecord('2', 102)] });
  });

  it('an empty list drops the topic\'s entry, and the emptied map leaves no field in state.json', async () => {
    const store = await createStore();
    await store.setSetAsideQuestions(threadA, [createRecord('1', 101)]);
    await store.setSetAsideQuestions(threadA, []);
    await store.flush();

    assert.deepEqual(store.getSetAsideQuestions(), {});
    assert.equal('setAsideQuestions' in readStateFile(), false);
  });

  it('an empty list for a topic that has none changes nothing', async () => {
    const store = await createStore();
    await store.setSetAsideQuestions(threadA, []);
    assert.deepEqual(store.getSetAsideQuestions(), {});
  });

  it('one topic\'s list is its own: emptying it leaves the other intact', async () => {
    const store = await createStore();
    await store.setSetAsideQuestions(threadA, [createRecord('1', 101)]);
    await store.setSetAsideQuestions(threadB, [createRecord('1', 201)]);
    await store.setSetAsideQuestions(threadA, []);
    assert.deepEqual(store.getSetAsideQuestions(), { [keyToString(threadB)]: [createRecord('1', 201)] });
  });

  it('the copy a caller gets cannot change the store', async () => {
    const store = await createStore();
    await store.setSetAsideQuestions(threadA, [createRecord('1', 101)]);
    delete store.getSetAsideQuestions()[keyToString(threadA)];
    assert.deepEqual(Object.keys(store.getSetAsideQuestions()), [keyToString(threadA)]);

    const given = [createRecord('1', 101)];
    await store.setSetAsideQuestions(threadB, given);
    given.push(createRecord('2', 102));
    assert.equal(store.getSetAsideQuestions()[keyToString(threadB)].length, 1, 'a list the store was given is not kept by reference');
  });

  describe('the counter the record ids come from', () => {
    it('starts at 1 and goes up by one, per topic', async () => {
      const store = await createStore();
      assert.equal(await store.takeNextSetAsideQuestionSequence(threadA), 1);
      assert.equal(await store.takeNextSetAsideQuestionSequence(threadA), 2);
      assert.equal(await store.takeNextSetAsideQuestionSequence(threadB), 1, 'another topic counts on its own');
      assert.equal(await store.takeNextSetAsideQuestionSequence(threadA), 3);
    });

    it('never gives the same number twice, even for calls made at once', async () => {
      const store = await createStore();
      const numbers = await Promise.all(Array.from({ length: 20 }, () => store.takeNextSetAsideQuestionSequence(threadA)));
      assert.equal(new Set(numbers).size, 20);
      assert.deepEqual([...numbers].sort((first, second) => first - second), Array.from({ length: 20 }, (_, index) => index + 1));
    });

    it('goes on after a reload — the disk keeps the count, so an id made before the restart is not made again', async () => {
      const store = await createStore();
      await store.takeNextSetAsideQuestionSequence(threadA);
      await store.takeNextSetAsideQuestionSequence(threadA);
      await store.flush();

      const reloaded = await createStore();
      assert.equal(await reloaded.takeNextSetAsideQuestionSequence(threadA), 3);
    });

    it('is not reset by closing every record: an empty list leaves the count alone', async () => {
      const store = await createStore();
      assert.equal(await store.takeNextSetAsideQuestionSequence(threadA), 1);
      await store.setSetAsideQuestions(threadA, [createRecord('1', 101)]);
      await store.setSetAsideQuestions(threadA, []);
      await store.flush();

      const reloaded = await createStore();
      assert.equal(await reloaded.takeNextSetAsideQuestionSequence(threadA), 2);
    });
  });
});
