/**
 * @description The display names of Claude accounts (`utils/claudeProfileLabels.ts`), the pure rules behind ➕ and ✏️ in `/accounts`:
 * how a typed name is kept, why one is refused (empty, too long, another account's name or id), the id a new account gets from it
 * (slug, transliteration, a number on a clash), how a typed command finds an account by either, how a button shortens a long name, the
 * reason a typed id is refused, and the resolver every screen calls (display name, «Main» for `default`, else the id).
 * The ✏️ / ➕ capture over the real command module: `claudeAccounts.test.ts` › «✏️ Rename».
 */

/** Test case: N/A — Charness has no Jira tracker. */

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runWithLocale } from '../i18n';
import { checkIsValidClaudeProfileName, claudeProfileNameMaxLength } from '../utils/claudeProfiles';
import { convertMarkdownToAdf, getAdfText } from '../connectors/jira/adf';
import {
  buildClaudeProfileNameEntries,
  buildClaudeProfileNameEntry,
  checkClaudeProfileLabel,
  claudeProfileLabelMaxLength,
  deriveClaudeProfileId,
  describeClaudeProfileIdProblem,
  escapeClaudeProfileLabelForMarkdown,
  findClaudeProfileByTypedName,
  getClaudeProfileCommandName,
  getClaudeProfileLabel,
  listMainClaudeProfileLabels,
  normaliseClaudeProfileLabel,
  resolveClaudeProfileCommandName,
  resolveClaudeProfileLabel,
  setClaudeProfileLabelReader,
  shortenClaudeProfileLabel,
  type ClaudeProfileNameEntry,
} from '../utils/claudeProfileLabels';

const accounts: ClaudeProfileNameEntry[] = [
  { name: 'default', labels: ['Main'] },
  { name: 'work', labels: ['Sergei.Solo@work'] },
  { name: 'ada', labels: ['ada'] },
];

describe('claudeProfileLabels: normaliseClaudeProfileLabel', () => {
  it('keeps capitals, dots, @, Cyrillic and emoji; trims and folds every whitespace run (a line break too) into one space', () => {
    assert.equal(normaliseClaudeProfileLabel('  Sergei.Solo@work  '), 'Sergei.Solo@work');
    assert.equal(normaliseClaudeProfileLabel('Работа\n\t 🚀'), 'Работа 🚀');
  });

  it('drops invisible characters (zero-width space, bidi override, controls) but keeps the joiner of an emoji sequence', () => {
    assert.equal(normaliseClaudeProfileLabel('wo​rk‮\u0007'), 'work');
    assert.equal(normaliseClaudeProfileLabel('👩‍💻 dev'), '👩‍💻 dev');
  });

  it('composes Unicode, so a decomposed «é» is the same name as a composed one', () => {
    assert.equal(normaliseClaudeProfileLabel('Café'), 'Café');
  });
});

describe('claudeProfileLabels: checkClaudeProfileLabel', () => {
  it('accepts anything up to the cap that no other account is called', () => {
    assert.equal(checkClaudeProfileLabel({ label: 'Работа 🚀', selfName: null, accounts }), null);
    assert.equal(checkClaudeProfileLabel({ label: 'x'.repeat(claudeProfileLabelMaxLength), selfName: null, accounts }), null);
  });

  it('counts characters, not UTF-16 units: forty emoji fit, forty-one do not', () => {
    assert.equal(checkClaudeProfileLabel({ label: '🚀'.repeat(claudeProfileLabelMaxLength), selfName: null, accounts }), null);
    assert.deepEqual(checkClaudeProfileLabel({ label: '🚀'.repeat(claudeProfileLabelMaxLength + 1), selfName: null, accounts }), { kind: 'tooLong', max: claudeProfileLabelMaxLength });
  });

  it('refuses an empty name', () => {
    assert.deepEqual(checkClaudeProfileLabel({ label: '', selfName: null, accounts }), { kind: 'empty' });
  });

  it('refuses another account\'s display name, case ignored, naming that account as it is shown', () => {
    assert.deepEqual(checkClaudeProfileLabel({ label: 'sergei.solo@WORK', selfName: null, accounts }), { kind: 'taken', label: 'Sergei.Solo@work' });
    assert.deepEqual(checkClaudeProfileLabel({ label: 'MAIN', selfName: 'work', accounts }), { kind: 'taken', label: 'Main' });
  });

  it('refuses another account\'s id, case ignored — `default` included — so a typed command can never mean two accounts', () => {
    assert.deepEqual(checkClaudeProfileLabel({ label: 'Work', selfName: 'ada', accounts }), { kind: 'isId', label: 'Sergei.Solo@work' });
    assert.deepEqual(checkClaudeProfileLabel({ label: 'Default', selfName: 'work', accounts }), { kind: 'isId', label: 'Main' });
  });

  it('an account with no display name of its own shows its id: that id is a name taken, not a hidden id', () => {
    assert.deepEqual(checkClaudeProfileLabel({ label: 'ADA', selfName: null, accounts }), { kind: 'taken', label: 'ada' });
  });

  it('lets an account keep its own name or go back to its id', () => {
    assert.equal(checkClaudeProfileLabel({ label: 'sergei.solo@work', selfName: 'work', accounts }), null);
    assert.equal(checkClaudeProfileLabel({ label: 'work', selfName: 'work', accounts }), null);
  });

  it('`default` unrenamed answers to «Main» in every locale, the reader\'s first: none of them is free for another account in any topic', () => {
    const mains = listMainClaudeProfileLabels();
    assert.deepEqual(mains.slice(0, 3), ['Main', 'Hauptkonto', 'Principal'], 'en, de, fr (es and pt share «Principal»: once)');
    assert.equal(mains.length, new Set(mains).size);
    assert.ok(mains.includes('Основной') && mains.includes('Основний') && mains.includes('メイン'));
    const russianDefault = runWithLocale('ru', () => buildClaudeProfileNameEntry('default', {}));
    assert.equal(russianDefault.labels[0], 'Основной', 'the shown one first');
    assert.deepEqual([...russianDefault.labels].sort(), [...mains].sort());
    assert.deepEqual(checkClaudeProfileLabel({ label: 'main', selfName: null, accounts: [russianDefault, ...accounts.slice(1)] }), { kind: 'taken', label: 'Основной' });
    const englishDefault = buildClaudeProfileNameEntry('default', {});
    assert.deepEqual(checkClaudeProfileLabel({ label: 'основной', selfName: null, accounts: [englishDefault, ...accounts.slice(1)] }), { kind: 'taken', label: 'Main' }, 'an English topic refuses the Russian «Main» too');
    assert.equal(findClaudeProfileByTypedName('PRINCIPAL', [englishDefault, ...accounts.slice(1)]), 'default');
    assert.deepEqual(buildClaudeProfileNameEntry('default', { default: { label: 'Personal' } }), { name: 'default', labels: ['Personal'] }, 'renamed: every «Main» is free again');
  });
});

describe('claudeProfileLabels: deriveClaudeProfileId', () => {
  const isFree = (): boolean => false;

  it('makes a lowercase slug of the display name: dots, @ and spaces become one dash, accents are dropped', () => {
    assert.equal(deriveClaudeProfileId('Sergei.Solo@work', isFree), 'sergei-solo-work');
    assert.equal(deriveClaudeProfileId('  Café  Crème ', isFree), 'cafe-creme');
    assert.equal(deriveClaudeProfileId('Straße', isFree), 'strasse');
  });

  it('transliterates Cyrillic before accents are dropped (й stays y, ё stays e)', () => {
    assert.equal(deriveClaudeProfileId('Работа', isFree), 'rabota');
    assert.equal(deriveClaudeProfileId('Мой ёжик', isFree), 'moy-ezhik');
    assert.equal(deriveClaudeProfileId('Їжак', isFree), 'yizhak');
  });

  it('falls back to `account` when nothing of the name survives', () => {
    assert.equal(deriveClaudeProfileId('🚀🚀', isFree), 'account');
    assert.equal(deriveClaudeProfileId('_-_', isFree), 'account');
  });

  it('adds a number on a clash (a known id, `default`, a name, a folder — whatever `isTaken` says)', () => {
    const taken = new Set(['work', 'work-2', 'default', 'account']);
    assert.equal(deriveClaudeProfileId('Work', (id) => taken.has(id)), 'work-3');
    assert.equal(deriveClaudeProfileId('default', (id) => taken.has(id)), 'default-2');
    assert.equal(deriveClaudeProfileId('🙂', (id) => taken.has(id)), 'account-2');
  });

  it('never refuses `default` by itself: the gate does (`default` is no valid new id)', () => {
    assert.equal(deriveClaudeProfileId('Default', isFree), 'default-2');
  });

  it('cuts a long name to the id cap, with the number still fitting and no dash left at the cut', () => {
    const label = `${'a'.repeat(30)} bcdef`;
    const id = deriveClaudeProfileId(label, isFree);
    assert.equal(id, 'a'.repeat(30) + '-b');
    assert.equal(id.length, claudeProfileNameMaxLength);
    const clashed = deriveClaudeProfileId(label, (candidate) => candidate === id);
    assert.equal(clashed, `${'a'.repeat(30)}-2`);
    assert.ok(checkIsValidClaudeProfileName(clashed));
  });

  it('always gives a valid id', () => {
    for (const label of ['A', '9 lives', '-lead', '__x__', 'Ünïcödé', 'Сергей.Соло@работа', '日本語', 'x'.repeat(80)]) {
      assert.ok(checkIsValidClaudeProfileName(deriveClaudeProfileId(label, isFree)), label);
    }
  });
});

describe('claudeProfileLabels: findClaudeProfileByTypedName', () => {
  it('finds an account by its id or its display name, case and spacing ignored', () => {
    assert.equal(findClaudeProfileByTypedName('WORK', accounts), 'work');
    assert.equal(findClaudeProfileByTypedName(' sergei.solo@work ', accounts), 'work');
    assert.equal(findClaudeProfileByTypedName('main', accounts), 'default');
    assert.equal(findClaudeProfileByTypedName('default', accounts), 'default');
  });

  it('an id wins over a display name (an older state may hold one that equals another id)', () => {
    assert.equal(findClaudeProfileByTypedName('ada', [{ name: 'other', labels: ['ada'] }, { name: 'ada', labels: ['Ada'] }]), 'ada');
  });

  it('`null` for an empty or unknown name', () => {
    assert.equal(findClaudeProfileByTypedName('  ', accounts), null);
    assert.equal(findClaudeProfileByTypedName('nobody', accounts), null);
  });
});

describe('claudeProfileLabels: shortenClaudeProfileLabel', () => {
  it('keeps a name that fits and cuts a longer one with an ellipsis, between characters', () => {
    assert.equal(shortenClaudeProfileLabel('Work', 24), 'Work');
    assert.equal(shortenClaudeProfileLabel('x'.repeat(24), 24), 'x'.repeat(24));
    assert.equal(shortenClaudeProfileLabel('abcdefghij', 5), 'abcd…');
    assert.equal(shortenClaudeProfileLabel('🚀🚀🚀🚀🚀🚀', 4), '🚀🚀🚀…');
    assert.equal(shortenClaudeProfileLabel('ab  cdef', 4), 'ab…', 'no space before the ellipsis');
  });
});

describe('claudeProfileLabels: describeClaudeProfileIdProblem', () => {
  it('names the first character an id cannot hold — never a capital: a typed id is lowercased before', () => {
    assert.deepEqual(describeClaudeProfileIdProblem('sergei.solo'), { kind: 'character', character: '.' });
    assert.deepEqual(describeClaudeProfileIdProblem('my work'), { kind: 'character', character: ' ' });
    assert.deepEqual(describeClaudeProfileIdProblem('работа'), { kind: 'firstCharacter', character: 'р' });
    assert.deepEqual(describeClaudeProfileIdProblem('_work'), { kind: 'firstCharacter', character: '_' });
  });

  it('says what else is wrong: empty, reserved, too long; `null` for a good id', () => {
    assert.deepEqual(describeClaudeProfileIdProblem(''), { kind: 'empty' });
    assert.deepEqual(describeClaudeProfileIdProblem('default'), { kind: 'reserved' });
    assert.deepEqual(describeClaudeProfileIdProblem('a'.repeat(claudeProfileNameMaxLength + 1)), { kind: 'tooLong', max: claudeProfileNameMaxLength });
    assert.equal(describeClaudeProfileIdProblem('work_2-b'), null);
  });
});

describe('claudeProfileLabels: escapeClaudeProfileLabelForMarkdown', () => {
  it('escapes what Markdown reads as inline markup, and a Jira comment then shows the name as written, unformatted and with no link', () => {
    // (A bare web address would still be linked by Jira's autolinking, to the safe target it names: not markup the name could hide.)
    const label = 'my_work*[x](y) **b** `a` <b> ~s~ | \\';
    const escaped = escapeClaudeProfileLabelForMarkdown(label);
    assert.equal(escaped, 'my\\_work\\*\\[x\\](y) \\*\\*b\\*\\* \\`a\\` \\<b\\> \\~s\\~ \\| \\\\');
    const document = convertMarkdownToAdf(`Moved to «${escaped}».`);
    assert.equal(getAdfText(document).trim(), `Moved to «${label}».`);
    const marks = JSON.stringify(document).match(/"marks"/g) ?? [];
    assert.equal(marks.length, 0, `no emphasis, code or link mark: ${JSON.stringify(document)}`);
  });

  it('leaves a name with no such character as it is (dots, @, spaces, Cyrillic, emoji)', () => {
    assert.equal(escapeClaudeProfileLabelForMarkdown('Sergei.Solo@work Работа 🚀'), 'Sergei.Solo@work Работа 🚀');
  });
});

describe('claudeProfileLabels: what an account is called', () => {
  afterEach(() => setClaudeProfileLabelReader(() => ({})));

  it('its display name, else «Main» for `default` in the reader\'s language, else its id', () => {
    assert.equal(resolveClaudeProfileLabel('work', { work: { label: 'Работа' } }), 'Работа');
    assert.equal(resolveClaudeProfileLabel('work', { work: {} }), 'work');
    assert.equal(resolveClaudeProfileLabel('default', {}), 'Main');
    assert.equal(runWithLocale('ru', () => resolveClaudeProfileLabel('default', {})), 'Основной');
    assert.equal(resolveClaudeProfileLabel('default', { default: { label: 'Personal' } }), 'Personal');
  });

  it('a stored value that is no usable name (a hand edit: blank, not a string) counts as none', () => {
    assert.equal(resolveClaudeProfileLabel('work', { work: { label: '   ' } }), 'work');
    assert.equal(resolveClaudeProfileLabel('work', { work: { label: 42 } }), 'work');
  });

  it('~/.claude is «Main (~/.claude)» while another account answers to a «Main» of any locale — an id `main` from before display names, `principal`, or such a display name — and «Main» again once none does', () => {
    for (const records of [{ main: {} }, { principal: {} }, { x: { label: 'Основной' } }, { y: { label: 'MAIN' } }]) {
      assert.equal(resolveClaudeProfileLabel('default', records), 'Main (~/.claude)', JSON.stringify(records));
      assert.equal(runWithLocale('ru', () => resolveClaudeProfileLabel('default', records)), 'Основной (~/.claude)', JSON.stringify(records));
    }
    assert.equal(resolveClaudeProfileLabel('default', { mainline: {}, default: {} }), 'Main', 'a longer id is no claim');
    assert.equal(resolveClaudeProfileLabel('default', { default: { label: 'Personal' }, main: {} }), 'Personal', 'a name of its own needs no telling apart');
    assert.equal(resolveClaudeProfileLabel('main', { main: {} }), 'main');
  });

  it('each typed name finds its own account: the claimed «Main» goes to the account that claims it, ~/.claude answers to the rest and to its shown name', () => {
    const byId = buildClaudeProfileNameEntries({ main: {} });
    assert.deepEqual(byId.map((entry) => entry.name), ['default', 'main'], '`default` first, always');
    assert.equal(findClaudeProfileByTypedName('Main', byId), 'main');
    assert.equal(findClaudeProfileByTypedName('main (~/.claude)', byId), 'default');
    assert.equal(findClaudeProfileByTypedName('Основной', byId), 'default');
    const byLabel = buildClaudeProfileNameEntries({ x: { label: 'Основной' } });
    assert.equal(findClaudeProfileByTypedName('основной', byLabel), 'x', 'not ~/.claude, which is listed first');
    assert.equal(findClaudeProfileByTypedName('Main', byLabel), 'default');
  });

  it('a command a message asks for types the shown name only when it finds that very account, else the id', () => {
    const records = { main: {}, twin: {}, 'twin-2': { label: 'Twin' }, work: { label: 'Sergei.Solo@work' } };
    assert.equal(resolveClaudeProfileCommandName('default', records), 'Main (~/.claude)');
    assert.equal(resolveClaudeProfileCommandName('main', records), 'main');
    assert.equal(resolveClaudeProfileCommandName('twin', records), 'twin');
    assert.equal(resolveClaudeProfileCommandName('twin-2', records), 'twin-2', '«Twin» would find `twin` (an id wins)');
    assert.equal(resolveClaudeProfileCommandName('work', records), 'Sergei.Solo@work');
    assert.equal(resolveClaudeProfileCommandName('default', {}), 'Main');
  });

  it('the screens read the registered registry, and show ids until one is registered', () => {
    assert.equal(getClaudeProfileLabel('work'), 'work');
    setClaudeProfileLabelReader(() => ({ work: { label: 'Sergei.Solo@work' }, main: {} }));
    assert.equal(getClaudeProfileLabel('work'), 'Sergei.Solo@work');
    assert.equal(getClaudeProfileLabel('default'), 'Main (~/.claude)');
    assert.equal(getClaudeProfileCommandName('default'), 'Main (~/.claude)');
  });
});
