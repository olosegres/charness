/**
 * @description The native-Windows notice: which platforms get it, when General hears it (once per cold start), the same
 * text on the console, in General and in `/doctor`, its wording in every locale, and that its link points at a real
 * section of SETUP.md. The platform is a parameter, so none of this needs a Windows machine.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { t, checkKeyInAllLangs, getKeyInLang, localeCodes, runWithLocale } from '../i18n';
import { formatDoctorLine } from '../utils/doctorLine';
import {
  checkIsNativeWindows,
  getNativeWindowsConsoleLine,
  getNativeWindowsDoctorLine,
  getNativeWindowsGeneralNotice,
  getNativeWindowsNotice,
  nativeWindowsSetupUrl,
} from '../utils/nativeWindows';

const nonWindowsPlatforms: Array<typeof process.platform> = ['linux', 'darwin', 'freebsd', 'openbsd', 'sunos', 'aix', 'android'];

test('only win32 is native Windows', () => {
  assert.equal(checkIsNativeWindows('win32'), true);
  for (const platform of nonWindowsPlatforms) assert.equal(checkIsNativeWindows(platform), false, platform);
});

test('off Windows nothing is said: no notice, console line, General post or doctor line', () => {
  for (const platform of nonWindowsPlatforms) {
    assert.equal(getNativeWindowsNotice(platform, t), null, platform);
    assert.equal(getNativeWindowsConsoleLine(platform, t), null, platform);
    assert.equal(getNativeWindowsGeneralNotice({ platform, isHotReload: false }, t), null, platform);
    assert.equal(getNativeWindowsDoctorLine(platform, t), null, platform);
  }
});

test('on Windows the notice names what does not work and points at WSL2 with the link', () => {
  const notice = getNativeWindowsNotice('win32', t);
  assert.ok(notice !== null);
  for (const limitedFeature of ['tmux', 'self-update', 'hot mode', 'voice recognition', 'WSL2', nativeWindowsSetupUrl]) {
    assert.ok(notice.includes(limitedFeature), `the notice names ${limitedFeature}: "${notice}"`);
  }
  assert.ok(!notice.includes('{'), `no placeholder is left unfilled: "${notice}"`);
});

test('the console line is the notice behind a [platform] tag', () => {
  assert.equal(getNativeWindowsConsoleLine('win32', t), `[platform] ${getNativeWindowsNotice('win32', t)}`);
});

test('General hears it on a cold start and stays silent on a hot reload', () => {
  const coldStart = getNativeWindowsGeneralNotice({ platform: 'win32', isHotReload: false }, t);
  assert.equal(coldStart, `⚠️ ${getNativeWindowsNotice('win32', t)}`);
  assert.equal(getNativeWindowsGeneralNotice({ platform: 'win32', isHotReload: true }, t), null);
});

test('/doctor shows the notice as a warning line with no hint, and it renders without a dangling dash', () => {
  const doctorLine = getNativeWindowsDoctorLine('win32', t);
  assert.deepEqual(doctorLine, { status: 'warn', label: getNativeWindowsNotice('win32', t) });
  assert.equal(formatDoctorLine(doctorLine!, t), `⚠️ ${getNativeWindowsNotice('win32', t)}`);
});

test('the notice exists in every locale, keeps {setupUrl} and is safe inside a Markdown /doctor reply', () => {
  assert.ok(checkKeyInAllLangs('nativeWindows.limitedNotice'));
  for (const locale of localeCodes) {
    const template = getKeyInLang(locale, 'nativeWindows.limitedNotice') ?? '';
    assert.ok(template.includes('{setupUrl}'), `${locale} lost the {setupUrl} placeholder`);
    // /doctor replies in legacy Markdown, where an unpaired * _ ` [ makes Telegram refuse the whole message.
    assert.ok(!/[*_`\[]/.test(template), `${locale} holds a Markdown control character`);
    const rendered = runWithLocale(locale, () => getNativeWindowsNotice('win32', t));
    assert.ok(rendered !== null && rendered.includes(nativeWindowsSetupUrl) && !rendered.includes('{'), `${locale} renders the link: "${rendered}"`);
  }
});

test('the link points at a real SETUP.md section', () => {
  const [, anchor] = nativeWindowsSetupUrl.split('#');
  const setupText = fs.readFileSync(path.join(__dirname, '..', '..', 'SETUP.md'), 'utf8');
  // GitHub's heading anchor: lower-case, punctuation dropped, spaces to hyphens.
  const anchors = [...setupText.matchAll(/^#{1,6} (.+)$/gm)].map(([, heading]) => heading.toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-'));
  assert.ok(anchors.includes(anchor), `SETUP.md has a heading for #${anchor}`);
});
