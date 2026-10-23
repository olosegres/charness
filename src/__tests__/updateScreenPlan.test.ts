/**
 * @description Coverage for `src/utils/updateScreenPlan.ts` — the `/update` screen: what the install is, the mode and "what's new"
 * lines, what the last check saw or what is going on now, and the buttons (a radio row for the mode with ✓ on the current one, the
 * what's-new switch, "Check now", "Update to X now" only when there is something to install) — in General; the same text without
 * buttons and with "Change it in General." elsewhere.
 *
 * Test case: N/A — Charness has no Jira tracker.
 */

import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { t } from '../i18n';
import type { UpdateOffer, UpdateStatus } from '../selfUpdate/updateEngine';
import { buildUpdateScreen, formatAgo, type UpdateScreenInput } from '../utils/updateScreenPlan';

const now = 1_800_000_000_000;
const minuteMs = 60 * 1000;

function createStatus(overrides: Partial<UpdateStatus> = {}): UpdateStatus {
  return {
    running: { version: '3.4.0', commit: null },
    installKind: { kind: 'npmGlobal', prefix: '/home/u/.npm-global' },
    isHotMode: false,
    runningNode: '22.23.3',
    settings: { autoUpdate: 'on', whatsNew: true },
    lastCheckAt: now - 20 * minuteMs,
    observation: { kind: 'npm', latestVersion: '3.4.0', engines: null, isDeprecated: false },
    isCheckFailing: false,
    offer: null,
    phase: 'idle',
    inProgressTarget: null,
    ...overrides,
  };
}

function createOffer(overrides: Partial<UpdateOffer> = {}): UpdateOffer {
  return { target: '3.5.0', action: 'installWhenIdle', until: null, required: null, skipReason: null, canInstallNow: true, ...overrides };
}

function render(status: UpdateStatus, overrides: Partial<UpdateScreenInput> = {}) {
  return buildUpdateScreen({ status, isGeneral: true, now, formatClock: () => '14:20', ...overrides }, t);
}

const buttonLabels = (screen: ReturnType<typeof render>): string[] => screen.rows.flat().map((button) => `${button.text}|${button.data}`);

describe('General: an npm install that is up to date', () => {
  test('the install, the mode, what\'s new, the last check — and the three mode buttons, the switch and "Check now"', () => {
    const screen = render(createStatus());
    assert.equal(
      screen.text,
      [
        'Charness 3.4.0 · npm (/home/u/.npm-global)',
        '',
        'Automatic updates: ON — a new version is installed by itself when the bot is idle; a major version is offered here.',
        "What's new after an update: shown",
        '',
        'Checked 20 min ago · up to date',
      ].join('\n'),
    );
    assert.deepEqual(screen.rows.map((row) => row.map((button) => `${button.text}|${button.data}`)), [
      ['✓ Automatic|upd_mode_on', 'Notify only|upd_mode_notify', 'Off|upd_mode_off'],
      ["📰 What's new: ON|upd_notes_off"],
      ['🔄 Check now|upd_check'],
    ]);
  });

  test('the ✓ follows the mode, and the what\'s-new button carries the value it will set', () => {
    const screen = render(createStatus({ settings: { autoUpdate: 'notify', whatsNew: false } }));
    assert.deepEqual(screen.rows[0].map((button) => button.text), ['Automatic', '✓ Notify only', 'Off']);
    assert.deepEqual(screen.rows[1], [{ text: "📰 What's new: OFF", data: 'upd_notes_on' }]);
    assert.match(screen.text, /^Automatic updates: NOTIFY ONLY/m);
    assert.match(screen.text, /What's new after an update: not shown/);
    assert.equal(render(createStatus({ settings: { autoUpdate: 'off', whatsNew: true } })).rows[0][2].text, '✓ Off');
  });
});

describe('General: a new version', () => {
  test('in its hold: when it will install by itself, and the button to install now', () => {
    const screen = render(createStatus({ offer: createOffer({ action: 'waitHold', until: now + 3 * 60 * minuteMs }) }));
    assert.match(screen.text, /Checked 20 min ago · 3\.5\.0 is out — will install by itself ~14:20, when the bot is idle$/);
    assert.deepEqual(screen.rows.at(-1), [{ text: '⬆️ Update to 3.5.0 now', data: 'upd_go_3.5.0' }]);
  });

  test('in notify mode the hold says it will be announced, not installed', () => {
    const screen = render(createStatus({ settings: { autoUpdate: 'notify', whatsNew: true }, offer: createOffer({ action: 'waitHold', until: now + minuteMs }) }));
    assert.match(screen.text, /3\.5\.0 is out — I will say so ~14:20$/);
  });

  test('waiting for the bot to be idle, notify, a major, a Node that is too old', () => {
    assert.match(render(createStatus({ offer: createOffer() })).text, /3\.5\.0 is out — installing as soon as the bot is idle$/);
    assert.match(render(createStatus({ offer: createOffer({ action: 'notify' }) })).text, /Checked 20 min ago · 3\.5\.0 is out$/);
    assert.match(render(createStatus({ offer: createOffer({ target: '4.0.0', action: 'offerMajor' }) })).text, /4\.0\.0 is a major version — not installed by itself$/);
    const needsNode = render(createStatus({ offer: createOffer({ action: 'needsNode', required: '>=24', canInstallNow: false }) }));
    assert.match(needsNode.text, /3\.5\.0 needs Node >=24 \(this one runs 22\.23\.3\)$/);
    assert.equal(needsNode.rows.flat().some((button) => button.data.startsWith('upd_go_')), false, 'nothing to install, no button');
  });

  test('with the mode off the screen still shows what is out, and the way to install it', () => {
    const screen = render(createStatus({ settings: { autoUpdate: 'off', whatsNew: true }, offer: createOffer({ action: 'notify' }) }));
    assert.match(screen.text, /3\.5\.0 is out$/);
    assert.ok(buttonLabels(screen).includes('⬆️ Update to 3.5.0 now|upd_go_3.5.0'));
  });
});

describe('General: while an update runs', () => {
  test('installing, waiting for the turns to end, restarting: the text says so and the install button is gone', () => {
    const offer = createOffer();
    const installing = render(createStatus({ offer, phase: 'installing', inProgressTarget: '3.5.0' }));
    assert.match(installing.text, /Installing 3\.5\.0…$/);
    const waiting = render(createStatus({ offer, phase: 'waitingForIdle', inProgressTarget: '3.5.0' }));
    assert.match(waiting.text, /Waiting for the running turns to end, then installing 3\.5\.0$/);
    const restarting = render(createStatus({ offer, phase: 'restartPending', inProgressTarget: '3.5.0' }));
    assert.match(restarting.text, /3\.5\.0 is installed — restarting once the running turns end$/);
    for (const screen of [installing, restarting]) assert.equal(screen.rows.flat().some((button) => button.data.startsWith('upd_go_')), false);
  });
});

describe('what the last check saw', () => {
  test('never checked, a failed check, a check that is "ago" in minutes / hours / days', () => {
    assert.match(render(createStatus({ lastCheckAt: null, observation: null })).text, /Not checked yet\.$/);
    assert.match(render(createStatus({ observation: { kind: 'error', reason: 'the registry did not answer' } })).text, /Check failed 20 min ago: the registry did not answer$/);
    assert.equal(formatAgo(30 * 1000, t), 'just now');
    assert.equal(formatAgo(59 * minuteMs, t), '59 min ago');
    assert.equal(formatAgo(3 * 60 * minuteMs, t), '3 h ago');
    assert.equal(formatAgo(50 * minuteMs, t), '50 min ago');
    assert.equal(formatAgo(2 * 24 * 60 * minuteMs, t), '2 d ago');
  });
});

describe('a git checkout', () => {
  const checkout = { installKind: { kind: 'checkout', root: '/srv/charness' } as const, running: { version: '3.4.0', commit: 'a1b2c3d' } };

  test('names its commit; hot mode says so', () => {
    assert.match(render(createStatus(checkout)).text, /^Charness 3\.4\.0 · git @ a1b2c3d\n/);
    assert.match(render(createStatus({ ...checkout, isHotMode: true })).text, /^Charness 3\.4\.0 · git @ a1b2c3d · hot\n/);
  });

  test('skipped: the reason in words (never an error); a migration guide is offered, not pulled', () => {
    for (const [reason, words] of [
      ['dirty', 'local changes in the checkout'],
      ['diverged', 'the checkout has commits of its own'],
      ['noUpstream', 'the branch tracks no upstream'],
      ['inProgress', 'a merge or rebase is in progress'],
    ] as const) {
      const screen = render(createStatus({ ...checkout, offer: createOffer({ action: 'skipped', skipReason: reason, canInstallNow: false }) }));
      assert.match(screen.text, new RegExp(`Checked 20 min ago · skipped: ${words}$`));
      assert.equal(screen.rows.flat().some((button) => button.data.startsWith('upd_go_')), false);
    }
    assert.match(render(createStatus({ ...checkout, offer: createOffer({ target: 'd4e5f6a', action: 'offerBreaking' }) })).text, /d4e5f6a adds a migration guide — not pulled by itself$/);
  });
});

describe('an install that can only notify', () => {
  test('says why, names the command to run by hand, shows no install button — the mode row still sets notify / off', () => {
    const readOnly = createStatus({
      installKind: { kind: 'notifyOnly', reason: 'readOnlyPrefix', manualCommand: 'npm install -g charness@latest', isCheckout: false },
      offer: createOffer({ action: 'notify', canInstallNow: false }),
    });
    const screen = render(readOnly);
    assert.match(screen.text, /^Charness 3\.4\.0 · npm, read-only folder — can only notify\n/);
    assert.match(screen.text, /Automatic updates: ON — but this install can only notify\./);
    assert.match(screen.text, /3\.5\.0 is out — update by hand\nUpdate by hand: npm install -g charness@latest$/);
    assert.equal(screen.rows.flat().some((button) => button.data.startsWith('upd_go_')), false);
    assert.equal(screen.rows[0].length, 3);
  });

  test('every reason has its own words; npx has nothing to update', () => {
    for (const reason of ['readOnlyPrefix', 'readOnlyCheckout', 'packageManager', 'localInstall', 'noExecve'] as const) {
      const text = render(createStatus({ installKind: { kind: 'notifyOnly', reason, manualCommand: 'x', isCheckout: reason === 'readOnlyCheckout' } })).text;
      assert.doesNotMatch(text, /update\.screen/, reason);
    }
    assert.match(render(createStatus({ installKind: { kind: 'ephemeral' } })).text, /^Charness 3\.4\.0 · npx — nothing to update\n/);
  });
});

describe('another topic than General', () => {
  test('the same text without buttons, and where to change it', () => {
    const screen = render(createStatus({ offer: createOffer() }), { isGeneral: false });
    assert.deepEqual(screen.rows, []);
    assert.match(screen.text, /Checked 20 min ago · 3\.5\.0 is out — installing as soon as the bot is idle\n\nChange it in General\.$/);
    assert.equal(render(createStatus({ offer: createOffer() })).text, screen.text.replace('\n\nChange it in General.', ''), 'nothing else differs');
  });
});
