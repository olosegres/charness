/**
 * `yarn walkthrough`: record a flow's passing run and draw its walkthrough — an H.264 video and phone-size screenshots — for a person to
 * judge a user-visible change by looking (DEVELOPMENT.md § Walkthrough videos and screenshots). Run with `tsx src/walkthrough/cli.ts`.
 *
 *   record <flow file> [--out <dir>] [--config <file>] [--shots <file>] [--layout-prefix <p>] [--browser <path>] [--no-video]
 *       run the flow (`yarn build` first: a flow runs the built bot) with the recorder, then draw what it recorded
 *   render <recording file> [--out <dir>] [--config <file>] [--shots <file>] [--browser <path>] [--no-video]
 *       draw a recording again (another config, other shots) without running the flow
 *
 * Output goes to `agent/tmp/walkthroughs/<flow>/` (the repository's ignored temp dir) unless `--out` says otherwise: `<flow>.recording.json`,
 * `<flow>.mp4` and `screens/<name>.png`. `ffmpeg` must be on `PATH`; the browser is the Chromium Playwright installed
 * (`npx playwright install chromium`), or the executable `--browser` names.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import type { z } from 'zod';
import { renderWalkthroughScreenshots, renderWalkthroughVideo } from './renderWalkthrough';
import {
  walkthroughConfigSchema,
  walkthroughLayoutPrefixEnvName,
  walkthroughOutEnvName,
  walkthroughRecordingSchema,
  walkthroughShotsSchema,
  type WalkthroughConfig,
  type WalkthroughRecording,
  type WalkthroughShot,
} from './walkthroughTypes';

const repositoryRoot = path.resolve(__dirname, '..', '..');
const defaultOutputRoot = path.join(repositoryRoot, 'agent', 'tmp', 'walkthroughs');
const globalTestSetupPath = path.join(repositoryRoot, 'src', '__tests__', 'globalTestSetup.ts');
const recorderPath = path.join(__dirname, 'recorder.ts');
/** A flow's own limit (`yarn test:flows`: 20 min per file); the recorder adds nothing to it. */
const flowTimeoutMs = 20 * 60 * 1000;
const flowProcessGraceMs = 60 * 1000;
const flowFileSuffix = /\.test\.ts$/;
const layoutPrefixPattern = /createIsolatedInstanceLayout\(\s*'([^']+)'/;

const usage = `usage:
  yarn walkthrough record <flow file> [--out <dir>] [--config <file>] [--shots <file>] [--layout-prefix <prefix>] [--browser <path>] [--no-video]
  yarn walkthrough render <recording file> [--out <dir>] [--config <file>] [--shots <file>] [--browser <path>] [--no-video]`;

class UsageError extends Error {}

/** @description The JSON file `filePath` holds, checked against `schema`: a malformed file stops with the field it got wrong. */
function readJsonFile<TSchema extends z.ZodType>(filePath: string, schema: TSchema): z.output<TSchema> {
  return schema.parse(JSON.parse(fs.readFileSync(filePath, 'utf8')));
}

/** The prefix the flow gives its instance directory: `createIsolatedInstanceLayout('<prefix>', …)`. */
function readLayoutPrefix(flowFile: string): string {
  const match = layoutPrefixPattern.exec(fs.readFileSync(flowFile, 'utf8'));
  if (match === null) throw new UsageError(`${flowFile} has no createIsolatedInstanceLayout('<prefix>', …): not a process-level flow? Name the prefix with --layout-prefix`);
  return match[1];
}

async function drawWalkthrough(input: {
  recording: WalkthroughRecording;
  config: WalkthroughConfig;
  shots: readonly WalkthroughShot[];
  outputDir: string;
  baseName: string;
  isVideoWanted: boolean;
  browserPath: string | undefined;
}): Promise<void> {
  const { recording, config, shots, outputDir, baseName, browserPath } = input;
  if (input.isVideoWanted) {
    const videoPath = path.join(outputDir, `${baseName}.mp4`);
    const video = await renderWalkthroughVideo({ recording, config, outputPath: videoPath, browserPath });
    process.stdout.write(`video: ${videoPath} (${video.frameCount} frames, ${video.seconds.toFixed(1)} s)\n`);
  }
  if (shots.length > 0) {
    const screensDir = path.join(outputDir, 'screens');
    const screenshots = await renderWalkthroughScreenshots({ recording, shots, outputDir: screensDir, browserPath });
    process.stdout.write(`screenshots: ${screensDir} (${screenshots.written.length} written)\n`);
    if (screenshots.unmatched.length > 0) throw new Error(`no state of the recording matched the shot(s): ${screenshots.unmatched.join(', ')}`);
  }
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: 'string' },
      config: { type: 'string' },
      shots: { type: 'string' },
      'layout-prefix': { type: 'string' },
      browser: { type: 'string' },
      'no-video': { type: 'boolean', default: false },
    },
  });
  const [subcommand, inputFile] = positionals;
  if ((subcommand !== 'record' && subcommand !== 'render') || inputFile === undefined) throw new UsageError(usage);
  const inputPath = path.resolve(inputFile);
  const baseName = path.basename(inputPath).replace(flowFileSuffix, '').replace(/\.recording\.json$/, '');
  const outputDir = path.resolve(values.out ?? path.join(defaultOutputRoot, baseName));
  const config = values.config === undefined ? {} : readJsonFile(path.resolve(values.config), walkthroughConfigSchema);
  const shots = values.shots === undefined ? [] : readJsonFile(path.resolve(values.shots), walkthroughShotsSchema);
  fs.mkdirSync(outputDir, { recursive: true });

  let recordingPath = inputPath;
  if (subcommand === 'record') {
    recordingPath = path.join(outputDir, `${baseName}.recording.json`);
    const flow = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--import', globalTestSetupPath, '--import', recorderPath, '--test', `--test-timeout=${flowTimeoutMs}`, inputPath],
      {
        cwd: repositoryRoot,
        stdio: 'inherit',
        timeout: flowTimeoutMs + flowProcessGraceMs,
        env: { ...process.env, [walkthroughOutEnvName]: recordingPath, [walkthroughLayoutPrefixEnvName]: values['layout-prefix'] ?? readLayoutPrefix(inputPath) },
      },
    );
    if (flow.status !== 0) {
      process.stderr.write(`the flow did not pass (exit ${flow.status ?? flow.signal}): nothing is drawn; what it recorded is ${recordingPath}\n`);
      process.exitCode = flow.status ?? 1;
      return;
    }
  }
  const recording = readJsonFile(recordingPath, walkthroughRecordingSchema);
  await drawWalkthrough({ recording, config, shots, outputDir, baseName, isVideoWanted: !values['no-video'], browserPath: values.browser });
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = error instanceof UsageError ? 2 : 1;
});
