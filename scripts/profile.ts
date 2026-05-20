#!/usr/bin/env node
/**
 * V8 CPU profiling captures for the three hot paths.
 *
 *   npm run profile        # builds dist/, then profiles log / status / pack-read
 *
 * Parent mode: for each hot path, spawn a `node --prof` child, post-process
 * the emitted `isolate-*.log` with `node --prof-process`, and write the digest
 * to `reports/profiles/<path>.txt` (git-ignored — captures are host-specific).
 * Child mode (`--child <path>`): open the cached medium fixture and loop the
 * one operation under the profiler.
 *
 * Profiles the compiled `dist/` (a plain `node` script cannot resolve the
 * source tree's `.js`-extension imports) — the `profile` npm script builds
 * first. Needs the cached medium fixture (and therefore the `git` CLI).
 */
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { MEDIUM_FIXTURE, ensureScaledFixture } from '../test/bench/support/fixture-generator.ts';

const HOT_PATHS = ['log', 'status', 'pack-read'] as const;
type HotPath = (typeof HOT_PATHS)[number];

const CHILD_ITERATIONS = 100;
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..');
const PROFILE_DIR = path.join(ROOT, 'reports', 'profiles');
const DIST_ENTRY = path.join(ROOT, 'dist', 'esm', 'index.node.js');

const isHotPath = (value: string | undefined): value is HotPath =>
  value !== undefined && (HOT_PATHS as ReadonlyArray<string>).includes(value);

// ── Child mode — runs under `node --prof` ───────────────────────────────────

const runChild = async (hotPath: HotPath): Promise<void> => {
  const fixture = await ensureScaledFixture(MEDIUM_FIXTURE);
  const { openRepository } = await import(pathToFileURL(DIST_ENTRY).href);

  const repo = await openRepository({ cwd: fixture.cwd });
  try {
    for (let i = 0; i < CHILD_ITERATIONS; i += 1) {
      if (hotPath === 'log') {
        await repo.log();
      } else if (hotPath === 'status') {
        await repo.status();
      } else {
        const fresh = await openRepository({ cwd: fixture.cwd });
        try {
          await fresh.primitives.readBlob(fixture.firstBlobId);
        } finally {
          await fresh.dispose();
        }
      }
    }
  } finally {
    await repo.dispose();
  }
};

// ── Parent mode — orchestrates the captures ─────────────────────────────────

const spawnToCompletion = (
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { cwd, stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`\`${command}\` exited with ${code}`)),
    );
  });

const processProfile = (isolateLog: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['--prof-process', isolateLog]);
    let out = '';
    let err = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString();
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      err += chunk.toString();
    });
    proc.on('error', reject);
    proc.on('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(`--prof-process failed: ${err}`)),
    );
  });

const captureProfile = async (hotPath: HotPath): Promise<void> => {
  const workDir = await mkdtemp(path.join(os.tmpdir(), `tsgit-prof-${hotPath}-`));
  try {
    await spawnToCompletion(
      process.execPath,
      ['--prof', '--experimental-strip-types', SCRIPT_PATH, '--child', hotPath],
      workDir,
    );
    const entries = await readdir(workDir);
    const isolateLog = entries.find((e) => e.startsWith('isolate-') && e.endsWith('.log'));
    if (isolateLog === undefined) {
      throw new Error(`no isolate log produced for ${hotPath}`);
    }
    const digest = await processProfile(path.join(workDir, isolateLog));
    await writeFile(path.join(PROFILE_DIR, `${hotPath}.txt`), digest, 'utf8');
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
};

const main = async (): Promise<void> => {
  const childIndex = process.argv.indexOf('--child');
  if (childIndex !== -1) {
    const hotPath = process.argv[childIndex + 1];
    if (!isHotPath(hotPath)) {
      throw new Error(`unknown hot path: ${String(hotPath)}`);
    }
    await runChild(hotPath);
    return;
  }

  try {
    await ensureScaledFixture(MEDIUM_FIXTURE);
  } catch (err) {
    process.stderr.write(
      `cannot profile: medium fixture unavailable ` +
        `(${err instanceof Error ? err.message : String(err)})\n` +
        'install the `git` CLI and retry.\n',
    );
    process.exit(1);
  }

  await mkdir(PROFILE_DIR, { recursive: true });
  for (const hotPath of HOT_PATHS) {
    process.stdout.write(`profiling ${hotPath}…\n`);
    await captureProfile(hotPath);
  }
  process.stdout.write(`profiles written to ${PROFILE_DIR}\n`);
};

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
