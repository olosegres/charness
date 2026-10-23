/**
 * @description Coverage for `src/selfUpdate/updateMessages.ts` — how the engine's messages read in General: the what's-new block
 * (to-do first, versions, "…and N more"), which messages are pinned, which carry the install tap (its identity baked into the
 * callback data), and that every update string exists in every locale with the same placeholders as English.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { getKeyInLang, localeCodes, runWithLocale, t } from '../i18n';
import { enDict } from '../i18n/en';
import type { WhatsNewSummary } from '../selfUpdate/releaseNotes';
import { renderUpdateMessage, type UpdateMessage } from '../selfUpdate/updateMessages';

function render(message: UpdateMessage) {
  return renderUpdateMessage(message, t);
}

const summary: WhatsNewSummary = {
  todo: ['Rename the old variables before 4.0.'],
  groups: [
    { version: '3.3.0', headlines: ['A conversation that was cleaned up no longer kills the agent.'] },
    { version: '3.4.0', headlines: ['/limits is a switch board.'] },
  ],
  moreCount: 6,
};

describe('"Updated"', () => {
  test('the heading, the to-do first, the headlines by version, then how many more — and a to-do pins it', () => {
    const rendered = render({ kind: 'updated', from: '3.2.0', to: '3.4.0', commitCount: null, summary });
    assert.equal(
      rendered.text,
      [
        '🔄 Charness updated: 3.2.0 → 3.4.0',
        'To do:',
        '• Rename the old variables before 4.0.',
        '3.3.0',
        '• A conversation that was cleaned up no longer kills the agent.',
        '3.4.0',
        '• /limits is a switch board.',
        '…and 6 more — CHANGELOG: https://github.com/olosegres/charness/blob/main/CHANGELOG.md',
      ].join('\n'),
    );
    assert.equal(rendered.pin, true);
    assert.deepEqual(rendered.buttons, []);
  });

  test('without entries to do it is not pinned; without a summary it is the heading alone', () => {
    const noTodo = render({ kind: 'updated', from: '3.2.0', to: '3.4.0', commitCount: null, summary: { ...summary, todo: [], moreCount: 0 } });
    assert.equal(noTodo.pin, false);
    assert.doesNotMatch(noTodo.text, /To do:|…and/);
    assert.deepEqual(render({ kind: 'updated', from: '3.2.0', to: '3.4.0', commitCount: null, summary: null }), { text: '🔄 Charness updated: 3.2.0 → 3.4.0', pin: false, buttons: [] });
  });

  test('a checkout names commits, and its list has no version headings', () => {
    const rendered = render({ kind: 'updated', from: 'a1b2c3d', to: 'd4e5f6a', commitCount: 12, summary: { todo: [], groups: [{ version: null, headlines: ['A new thing.'] }], moreCount: 0 } });
    assert.equal(rendered.text, '🔄 Charness updated: a1b2c3d → d4e5f6a (12 commits)\n• A new thing.');
  });
});

describe('a version change nobody asked this bot for', () => {
  test('is "Charness is now Y (was X)" with the list', () => {
    const rendered = render({ kind: 'nowRunning', from: '3.2.0', to: '3.4.0', summary: { ...summary, todo: [], moreCount: 0 } });
    assert.match(rendered.text, /^🔄 Charness is now 3\.4\.0 \(was 3\.2\.0\)\n3\.3\.0/);
    assert.equal(rendered.pin, false);
  });
});

describe('the offers', () => {
  test('notify carries the tap with the version baked in; read-only says the command instead', () => {
    assert.deepEqual(render({ kind: 'notify', version: '3.5.0', running: '3.4.0', canInstall: true, manualCommand: 'x' }), {
      text: '⬆️ Charness 3.5.0 is out (you run 3.4.0).',
      pin: false,
      buttons: [{ label: '⬆️ Update to 3.5.0', callbackData: 'upd_go_3.5.0' }],
    });
    assert.deepEqual(render({ kind: 'notify', version: '3.5.0', running: '3.4.0', canInstall: false, manualCommand: 'npm install -g charness@latest' }), {
      text: '⬆️ Charness 3.5.0 is out (you run 3.4.0).\nUpdate by hand: npm install -g charness@latest',
      pin: false,
      buttons: [],
    });
  });

  test('a major links its GitHub release notes and carries the tap', () => {
    const rendered = render({ kind: 'offerMajor', version: '4.0.0', running: '3.4.0' });
    assert.equal(rendered.text, '⚠️ Charness 4.0.0 is a major version — not installed by itself. Read the release notes first: https://github.com/olosegres/charness/releases/tag/v4.0.0');
    assert.deepEqual(rendered.buttons, [{ label: '⬆️ Update to 4.0.0', callbackData: 'upd_go_4.0.0' }]);
  });

  test('a checkout\'s migration guide is linked by name; the tap carries the target commit', () => {
    const rendered = render({ kind: 'offerBreaking', from: 'a1b2c3d', to: 'd4e5f6a', migrationGuides: ['MIGRATION_3_TO_4.md', 'MIGRATION_X.md'] });
    assert.match(rendered.text, /adds a migration guide .* https:\/\/github\.com\/olosegres\/charness\/blob\/main\/MIGRATION_3_TO_4\.md https:\/\/github\.com\/olosegres\/charness\/blob\/main\/MIGRATION_X\.md$/);
    assert.deepEqual(rendered.buttons, [{ label: '⬆️ Update to d4e5f6a', callbackData: 'upd_go_d4e5f6a' }]);
  });

  test('a Node that is too old says what is needed and what runs', () => {
    assert.equal(render({ kind: 'needsNode', version: '3.5.0', required: '>=24', runningNode: '22.23.3' }).text, 'ℹ️ Charness 3.5.0 needs Node >=24; this instance runs Node 22.23.3, so it is not installed.');
  });
});

describe('failures', () => {
  test('a failed update names the reason class, what still runs and the manual command — not pinned', () => {
    assert.deepEqual(render({ kind: 'installFailed', target: '3.5.0', reason: 'start', stillRunning: '3.4.0', manualCommand: 'npm install -g charness@3.5.0' }), {
      text: '⚠️ Automatic update to 3.5.0 failed: the new version did not start. Still running 3.4.0.\nUpdate by hand: npm install -g charness@3.5.0',
      pin: false,
      buttons: [],
    });
    for (const reason of ['install', 'start', 'build', 'boot'] as const) {
      assert.doesNotMatch(render({ kind: 'installFailed', target: 'x', reason, stillRunning: 'y', manualCommand: 'z' }).text, /update\.failed/);
    }
  });

  test('a rollback that failed is pinned: the next restart may not start', () => {
    const rendered = render({ kind: 'rollbackFailed', target: '3.5.0', reason: 'start', manualCommand: 'npm install -g charness@3.4.0' });
    assert.equal(rendered.pin, true);
    assert.match(rendered.text, /going back to the previous version failed too/);
  });

  test('a failing check, the announcement per mode, and the old supervisor', () => {
    assert.equal(render({ kind: 'checkFailing', reason: 'the registry did not answer' }).text, '⚠️ Cannot check for a new version: the registry did not answer. I keep trying every hour.');
    assert.equal(render({ kind: 'featureAnnounced', mode: 'on' }).text, 'ℹ️ Automatic updates are on — /update to change.');
    assert.match(render({ kind: 'featureAnnounced', mode: 'notify' }).text, /will tell you when a new version is out/);
    assert.match(render({ kind: 'restartSupervisor' }).text, /restart `charness hot` once \(Docker: `charness-restart-bot`\)/);
  });
});

describe('every locale', () => {
  const updateKeys = Object.keys(enDict).filter((key) => key.startsWith('update.'));

  function getPlaceholders(text: string): string[] {
    return [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
  }

  test('has every update string, with the placeholders English has', () => {
    assert.ok(updateKeys.length >= 21);
    for (const locale of localeCodes) {
      for (const key of updateKeys) {
        const text = getKeyInLang(locale, key);
        assert.ok(text, `${locale} lacks ${key}`);
        assert.deepEqual(getPlaceholders(text), getPlaceholders(enDict[key]), `${locale} ${key} placeholders`);
      }
    }
  });

  test('renders in the chat\'s language: the framework text is localised, the entries stay English', () => {
    const russian = runWithLocale('ru', () => render({ kind: 'updated', from: '3.2.0', to: '3.4.0', commitCount: null, summary: { todo: [], groups: [{ version: '3.4.0', headlines: ['/limits is a switch board.'] }], moreCount: 0 } }));
    assert.equal(russian.text, '🔄 Charness обновлён: 3.2.0 → 3.4.0\n3.4.0\n• /limits is a switch board.');
  });
});
