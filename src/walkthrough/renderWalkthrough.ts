/**
 * The I/O of the walkthrough: a headless Chromium (`playwright-core`, the browser Playwright installed, or the executable a person names)
 * shoots the pages of `walkthroughPages.ts`, and `ffmpeg` (on `PATH`) makes an H.264 `.mp4` of the video's frames. Nothing leaves the machine.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { chromium, type Browser } from 'playwright-core';
import { buildWalkthroughFrames, planFrameTimings } from './buildWalkthroughFrames';
import { selectShotView } from './selectShotView';
import { buildFramePageHtml, buildShotPageHtml, listTopicColumns, phoneHeightPx, phoneWidthPx, videoHeightPx, videoWidthPx } from './walkthroughPages';
import type { WalkthroughConfig, WalkthroughRecording, WalkthroughShot } from './walkthroughTypes';

const videoFramesPerSecond = 25;
const videoCrf = 23;
const encodeTimeoutMs = 10 * 60 * 1000;
const screenshotDeviceScaleFactor = 2;
const defaultVideoTitle = 'Walkthrough of a flow — passing run';

export interface RenderBrowserOptions {
  /** A browser executable to use instead of the Chromium Playwright installed. */
  browserPath?: string;
}

async function launchBrowser(options: RenderBrowserOptions): Promise<Browser> {
  return chromium.launch({ headless: true, chromiumSandbox: false, ...(options.browserPath === undefined ? {} : { executablePath: options.browserPath }) });
}

/** The list file `ffmpeg`'s concat demuxer reads: each picture with how long it stays (the last one named again, as the demuxer needs). */
function buildConcatList(pictures: readonly { file: string; seconds: number }[]): string {
  const entries = pictures.map((picture) => `file '${picture.file}'\nduration ${picture.seconds.toFixed(2)}`).join('\n');
  const last = pictures.at(-1);
  return last === undefined ? '' : `${entries}\nfile '${last.file}'\n`;
}

/**
 * @description The walkthrough video of `recording` at `outputPath` (H.264 in an `.mp4`, `yuv420p`, so a phone and Telegram play it).
 * Resolves the number of frames and the length in seconds.
 */
export async function renderWalkthroughVideo(input: { recording: WalkthroughRecording; config: WalkthroughConfig; outputPath: string } & RenderBrowserOptions): Promise<{ frameCount: number; seconds: number }> {
  const { recording, config, outputPath } = input;
  const timedFrames = planFrameTimings(buildWalkthroughFrames(recording, { highlightMarker: config.highlightMarker }));
  if (timedFrames.length === 0) throw new Error('the recording holds no step: nothing to draw (was the flow run with the recorder?)');
  const columns = listTopicColumns(timedFrames[timedFrames.length - 1].frame.messages, config);
  const title = config.title ?? defaultVideoTitle;
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walkthrough-'));
  const browser = await launchBrowser(input);
  try {
    const page = await browser.newPage({ viewport: { width: videoWidthPx, height: videoHeightPx } });
    const pictures: { file: string; seconds: number }[] = [];
    for (const [index, timedFrame] of timedFrames.entries()) {
      await page.setContent(buildFramePageHtml({ timedFrame, columns, config, title }), { waitUntil: 'load' });
      const file = path.join(workDir, `frame${index.toString().padStart(4, '0')}.png`);
      await page.screenshot({ path: file });
      pictures.push({ file, seconds: timedFrame.seconds });
    }
    const listPath = path.join(workDir, 'frames.txt');
    fs.writeFileSync(listPath, buildConcatList(pictures));
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const encode = spawnSync('ffmpeg', [
      '-y', '-f', 'concat', '-safe', '0', '-i', listPath,
      '-vf', `fps=${videoFramesPerSecond},format=yuv420p`,
      '-c:v', 'libx264', '-crf', videoCrf.toString(), '-preset', 'medium', '-movflags', '+faststart', outputPath,
    ], { encoding: 'utf8', timeout: encodeTimeoutMs });
    if (encode.error !== undefined) throw new Error(`ffmpeg did not run (is it on PATH?): ${encode.error.message}`);
    if (encode.status !== 0) throw new Error(`ffmpeg failed: ${encode.stderr.slice(-800)}`);
    return { frameCount: timedFrames.length, seconds: pictures.reduce((sum, picture) => sum + picture.seconds, 0) };
  } finally {
    await browser.close();
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

/** @description The phone-size screenshots `shots` name, as `<name>.png` in `outputDir`. Resolves the names it wrote and the names no state of the recording matched. */
export async function renderWalkthroughScreenshots(input: { recording: WalkthroughRecording; shots: readonly WalkthroughShot[]; outputDir: string } & RenderBrowserOptions): Promise<{ written: string[]; unmatched: string[] }> {
  const { recording, shots, outputDir } = input;
  fs.mkdirSync(outputDir, { recursive: true });
  const browser = await launchBrowser(input);
  const written: string[] = [];
  const unmatched: string[] = [];
  try {
    const page = await browser.newPage({ viewport: { width: phoneWidthPx, height: phoneHeightPx }, deviceScaleFactor: screenshotDeviceScaleFactor });
    for (const shot of shots) {
      const messages = selectShotView(recording, shot);
      if (messages === null) {
        unmatched.push(shot.name);
        continue;
      }
      await page.setContent(buildShotPageHtml({ shot, messages }), { waitUntil: 'load' });
      await page.screenshot({ path: path.join(outputDir, `${shot.name}.png`) });
      written.push(shot.name);
    }
  } finally {
    await browser.close();
  }
  return { written, unmatched };
}
