/**
 * What the bot keeps for the accounts notes (`limitNotes/`) in the StateStore: the per-conversation record (`getLimitNoteRecord` /
 * `setLimitNoteRecord`), the fresh-context reset that clears only the fingerprint (`clearLimitNoteFingerprint`), and the topics' own
 * limit-reminder interval (`getLimitRemindersOverride` / `setLimitRemindersOverride`) — all kept on disk so a restart never bursts
 * reminders or forgets a topic's choice, never touching another conversation, and tolerant of a hand-edited file.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { beforeEach, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { StateStore } from '../state';
import { keyToString, type SessionKey } from '../sessionKey';
import { makeTelegramKey } from '../connectors/telegram/sessionKeyCodec';
import { makeJiraKey } from '../connectors/jira/sessionKeyCodec';
import type { LimitNoteRecord } from '../limitNotes/plan';

const threadA: SessionKey = makeTelegramKey(-1001111111111, 11);
const threadB: SessionKey = makeTelegramKey(-1001111111111, 22);
const jiraIssue: SessionKey = makeJiraKey('PROJ-7');

/** Long enough for the 20 ms debounced save of the store under test to have landed. */
const saveSettleMs = 150;

const fullRecord: LimitNoteRecord = { lastNoteAt: 1_700_000_000_000, fingerprint: 'rec=work|work:6uo|gpt=4', lastOrchestratedAt: 1_700_000_100_000, lastProfilesCallAt: 1_700_000_050_000 };

describe('StateStore: the accounts notes and the limit reminders', () => {
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

  /** Edit `state.json` the way a hand edit would, between two stores. */
  function editStateFile(edit: (state: Record<string, unknown>) => void): void {
    const state = readStateFile();
    edit(state);
    fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify(state));
  }

  beforeEach(() => {
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcode-ln-'));
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

  describe('the note record', () => {
    it('a conversation that never orchestrated has none: nothing is stored, nothing is in state.json', async () => {
      const store = await createStore();
      assert.equal(store.getLimitNoteRecord(threadA), undefined);
      await store.flush();
      assert.equal('limitNotes' in readStateFile(), false);
    });

    it('a record survives a restart (so a restart never bursts a reminder), is a copy, and belongs to its conversation alone — a Jira one included', async () => {
      const store = await createStore();
      store.setLimitNoteRecord(threadA, fullRecord);
      store.setLimitNoteRecord(jiraIssue, { lastOrchestratedAt: 42 });
      await store.flush();

      const reloaded = await createStore();
      assert.deepEqual(reloaded.getLimitNoteRecord(threadA), fullRecord);
      assert.deepEqual(reloaded.getLimitNoteRecord(jiraIssue), { lastOrchestratedAt: 42 });
      assert.equal(reloaded.getLimitNoteRecord(threadB), undefined);

      const copy = reloaded.getLimitNoteRecord(threadA);
      if (copy === undefined) throw new Error('the record is missing');
      copy.lastNoteAt = 1;
      assert.equal(reloaded.getLimitNoteRecord(threadA)?.lastNoteAt, fullRecord.lastNoteAt, 'a reader cannot change the stored record');
    });

    it('a new record replaces the old one whole — a field it leaves out is gone', async () => {
      const store = await createStore();
      store.setLimitNoteRecord(threadA, fullRecord);
      store.setLimitNoteRecord(threadA, { lastOrchestratedAt: 5 });
      assert.deepEqual(store.getLimitNoteRecord(threadA), { lastOrchestratedAt: 5 });
    });

    it('`null` drops the record and leaves the others alone; an emptied map leaves no field in state.json', async () => {
      const store = await createStore();
      store.setLimitNoteRecord(threadA, fullRecord);
      store.setLimitNoteRecord(threadB, { lastNoteAt: 7 });
      store.setLimitNoteRecord(threadA, null);
      await store.flush();
      assert.equal(store.getLimitNoteRecord(threadA), undefined);
      assert.deepEqual(store.getLimitNoteRecord(threadB), { lastNoteAt: 7 });
      assert.deepEqual(readStateFile().limitNotes, { [keyToString(threadB)]: { lastNoteAt: 7 } });

      store.setLimitNoteRecord(threadB, null);
      await store.flush();
      assert.equal('limitNotes' in readStateFile(), false);
      store.setLimitNoteRecord(threadB, null);
    });

    it('a record with nothing valid in it is no record; a field of the wrong type in a hand-edited file counts as absent', async () => {
      const store = await createStore();
      store.setLimitNoteRecord(threadA, {});
      assert.equal(store.getLimitNoteRecord(threadA), undefined, 'an empty record is dropped, not stored');
      store.setLimitNoteRecord(threadA, fullRecord);
      await store.flush();

      editStateFile((state) => {
        const records = state.limitNotes as Record<string, Record<string, unknown>>;
        records[keyToString(threadA)] = { lastNoteAt: 'yesterday', fingerprint: 5, lastOrchestratedAt: null, lastProfilesCallAt: Number.MAX_SAFE_INTEGER };
        records[keyToString(threadB)] = { lastNoteAt: 'x', fingerprint: '' };
      });
      const reloaded = await createStore();
      assert.deepEqual(reloaded.getLimitNoteRecord(threadA), { lastProfilesCallAt: Number.MAX_SAFE_INTEGER }, 'only the valid field survives');
      assert.equal(reloaded.getLimitNoteRecord(threadB), undefined, 'nothing valid: no record');
    });
  });

  describe('the fresh-context reset', () => {
    it('clears the fingerprint ONLY: the last note and the last `claude_profiles` call keep the reminder clock, the orchestration mark stays', async () => {
      const store = await createStore();
      store.setLimitNoteRecord(threadA, fullRecord);
      store.clearLimitNoteFingerprint(threadA);
      assert.deepEqual(store.getLimitNoteRecord(threadA), { lastNoteAt: fullRecord.lastNoteAt, lastOrchestratedAt: fullRecord.lastOrchestratedAt, lastProfilesCallAt: fullRecord.lastProfilesCallAt });
      await store.flush();
      const reloaded = await createStore();
      assert.equal(reloaded.getLimitNoteRecord(threadA)?.fingerprint, undefined, 'and it stays cleared across a restart');
      assert.equal(reloaded.getLimitNoteRecord(threadA)?.lastNoteAt, fullRecord.lastNoteAt);
    });

    it('touches no other conversation', async () => {
      const store = await createStore();
      store.setLimitNoteRecord(threadA, fullRecord);
      store.setLimitNoteRecord(threadB, fullRecord);
      store.clearLimitNoteFingerprint(threadA);
      assert.deepEqual(store.getLimitNoteRecord(threadB), fullRecord);
    });

    it('a record that held nothing else is dropped with its fingerprint', async () => {
      const store = await createStore();
      store.setLimitNoteRecord(threadA, { fingerprint: 'rec=none' });
      store.clearLimitNoteFingerprint(threadA);
      assert.equal(store.getLimitNoteRecord(threadA), undefined);
      await store.flush();
      assert.equal('limitNotes' in readStateFile(), false);
    });

    it('a conversation with no record, or none with a fingerprint, is a no-op: it creates nothing and schedules no save', async () => {
      const store = await createStore();
      store.clearLimitNoteFingerprint(threadA);
      assert.equal(store.getLimitNoteRecord(threadA), undefined);
      store.setLimitNoteRecord(threadB, { lastNoteAt: 9 });
      await store.flush();
      const statePath = path.join(dataDir, 'state.json');
      const stampBefore = fs.statSync(statePath).mtimeMs;
      // The store saves debounced (20 ms here): a save scheduled by the clear would land within the wait.
      store.clearLimitNoteFingerprint(threadB);
      await new Promise((resolve) => setTimeout(resolve, saveSettleMs));
      assert.deepEqual(store.getLimitNoteRecord(threadB), { lastNoteAt: 9 });
      assert.equal(fs.statSync(statePath).mtimeMs, stampBefore, 'nothing to clear: the file is not rewritten');
      assert.equal(keyToString(threadA) in (readStateFile().limitNotes as Record<string, unknown>), false, 'and no record was created for the conversation that had none');

      // Control: a clear that DOES change something is saved inside the same wait, so the wait above would have seen a save.
      store.setLimitNoteRecord(threadB, { lastNoteAt: 9, fingerprint: 'rec=none' });
      await new Promise((resolve) => setTimeout(resolve, saveSettleMs));
      const stampAfterSet = fs.statSync(statePath).mtimeMs;
      assert.notEqual(stampAfterSet, stampBefore, 'the debounced save of a changed record lands within the wait');
      store.clearLimitNoteFingerprint(threadB);
      await new Promise((resolve) => setTimeout(resolve, saveSettleMs));
      assert.notEqual(fs.statSync(statePath).mtimeMs, stampAfterSet, 'clearing a fingerprint is saved');
    });

    it('bot.ts clears the fingerprint at both fresh-context boundaries — where the project board is told the same (a session start / stop / /clear, a completed compaction or a lost transcript)', () => {
      // `bot.ts` cannot be imported by a test (module-scope `parseEnv()` exits the process), so its two functions are read as source,
      // the way `jiraConnector.test.ts` pins the neighbouring call order.
      const botSource = fs.readFileSync(path.join(__dirname, '..', 'bot.ts'), 'utf8');
      for (const functionName of ['clearThreadContextMarker', 'noteConversationContextReset']) {
        const start = botSource.indexOf(`function ${functionName}(`);
        assert.notEqual(start, -1, `${functionName} exists`);
        const body = botSource.slice(start, botSource.indexOf('\n}\n', start));
        assert.match(body, /noteTodoFreshContext\(key\);/, `${functionName} resets the board`);
        assert.match(body, /state\.clearLimitNoteFingerprint\(key\);/, `${functionName} resets the accounts note's fingerprint`);
      }
    });
  });

  describe('the topics\' own limit-reminder interval', () => {
    it('a topic that never chose follows the instance value: nothing is stored', async () => {
      const store = await createStore();
      assert.equal(store.getLimitRemindersOverride(threadA), undefined);
      await store.flush();
      assert.equal('limitRemindersOverrides' in readStateFile(), false);
    });

    it('a choice is the topic\'s own, Off (0) included — a value, not «no choice» — survives a restart, and does not touch another topic', async () => {
      const store = await createStore();
      await store.setLimitRemindersOverride(threadA, 240);
      await store.setLimitRemindersOverride(threadB, 0);
      await store.flush();

      const reloaded = await createStore();
      assert.equal(reloaded.getLimitRemindersOverride(threadA), 240);
      assert.equal(reloaded.getLimitRemindersOverride(threadB), 0);
      assert.equal(reloaded.getLimitRemindersOverride(jiraIssue), undefined);
    });

    it('a new choice replaces the old one', async () => {
      const store = await createStore();
      await store.setLimitRemindersOverride(threadA, 60);
      await store.setLimitRemindersOverride(threadA, 120);
      assert.equal(store.getLimitRemindersOverride(threadA), 120);
    });

    it('`null` hands the topic back to the instance value, leaves the others alone, and an emptied map leaves no field in state.json', async () => {
      const store = await createStore();
      await store.setLimitRemindersOverride(threadA, 60);
      await store.setLimitRemindersOverride(threadB, 120);
      await store.setLimitRemindersOverride(threadA, null);
      await store.flush();
      assert.equal(store.getLimitRemindersOverride(threadA), undefined);
      assert.equal(store.getLimitRemindersOverride(threadB), 120);
      assert.deepEqual(readStateFile().limitRemindersOverrides, { [keyToString(threadB)]: 120 });

      await store.setLimitRemindersOverride(threadB, null);
      await store.setLimitRemindersOverride(threadB, null);
      await store.flush();
      assert.equal('limitRemindersOverrides' in readStateFile(), false);
    });

    it('a value no choice names — a hand-edited file — counts as none', async () => {
      const store = await createStore();
      await store.setLimitRemindersOverride(threadA, 60);
      await store.flush();
      editStateFile((state) => {
        state.limitRemindersOverrides = { [keyToString(threadA)]: 90, [keyToString(threadB)]: 'often' };
      });
      const reloaded = await createStore();
      assert.equal(reloaded.getLimitRemindersOverride(threadA), undefined);
      assert.equal(reloaded.getLimitRemindersOverride(threadB), undefined);
    });
  });
});
