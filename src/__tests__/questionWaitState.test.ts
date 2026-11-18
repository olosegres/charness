/**
 * @description The topics' own question waits in the StateStore (`getQuestionWaitOverride` / `setQuestionWaitOverride`): kept on disk so a
 * choice made with `/question_wait` survives a restart, one topic's choice never touches another's, `null` hands a topic back to the
 * instance value (an emptied map leaves no field in `state.json`), and a value no choice names — a hand-edited file — counts as none.
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { beforeEach, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { StateStore } from '../state';
import type { SessionKey } from '../sessionKey';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';

const threadA: SessionKey = makeTelegramKey(-1001234567890, 11);
const threadB: SessionKey = makeTelegramKey(-1001234567890, 22);

describe('StateStore question wait overrides', () => {
  let dataDir: string;
  let fakeHome: string;
  let originalHome: string | undefined;
  let createdStores: StateStore[] = [];

  async function createStore(): Promise<StateStore> {
    const store = new StateStore(dataDir, { saveDebounceMs: 20 });
    createdStores.push(store);
    await store.init();
    return store;
  }

  function readStateFile(): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
  }

  beforeEach(() => {
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcode-qw-'));
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

  it('a topic that never chose follows the instance value: nothing is stored', async () => {
    const store = await createStore();
    assert.equal(store.getQuestionWaitOverride(threadA), undefined);
  });

  it('a choice is the topic\'s own, survives a reload of the store, and does not touch another topic', async () => {
    const store = await createStore();
    await store.setQuestionWaitOverride(threadA, 'dontWait');
    await store.setQuestionWaitOverride(threadB, 'untilAnswered');
    await store.flush();

    const reloaded = await createStore();
    assert.equal(reloaded.getQuestionWaitOverride(threadA), 'dontWait');
    assert.equal(reloaded.getQuestionWaitOverride(threadB), 'untilAnswered');
  });

  it('a new choice replaces the old one', async () => {
    const store = await createStore();
    await store.setQuestionWaitOverride(threadA, 'tenMinutes');
    await store.setQuestionWaitOverride(threadA, 'oneHour');
    assert.equal(store.getQuestionWaitOverride(threadA), 'oneHour');
  });

  it('`null` hands the topic back to the instance value, leaves the others alone, and an emptied map leaves no field in state.json', async () => {
    const store = await createStore();
    await store.setQuestionWaitOverride(threadA, 'tenMinutes');
    await store.setQuestionWaitOverride(threadB, 'oneHour');
    await store.setQuestionWaitOverride(threadA, null);
    await store.flush();
    assert.equal(store.getQuestionWaitOverride(threadA), undefined);
    assert.equal(store.getQuestionWaitOverride(threadB), 'oneHour');
    assert.deepEqual(readStateFile().questionWaitOverrides, { [`${threadB.space}:${threadB.thread}`]: 'oneHour' });

    await store.setQuestionWaitOverride(threadB, null);
    await store.flush();
    assert.equal('questionWaitOverrides' in readStateFile(), false);
  });

  it('dropping a choice the topic never made changes nothing', async () => {
    const store = await createStore();
    await store.setQuestionWaitOverride(threadA, null);
    assert.equal(store.getQuestionWaitOverride(threadA), undefined);
  });

  it('a value no choice names — a hand-edited state file — counts as no choice', async () => {
    const store = await createStore();
    await store.setQuestionWaitOverride(threadA, 'tenMinutes');
    await store.flush();
    const state = readStateFile();
    (state.questionWaitOverrides as Record<string, string>)[`${threadA.space}:${threadA.thread}`] = 'forever';
    fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify(state));

    const reloaded = await createStore();
    assert.equal(reloaded.getQuestionWaitOverride(threadA), undefined);
  });
});
