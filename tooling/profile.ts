#!/usr/bin/env node
/**
 * V8 CPU profiling captures, per registered command.
 *
 *   npm run profile          # builds dist/, then profiles every registered command
 *   npm run profile <cmd>    # profiles a single command (e.g. `npm run profile log`)
 *
 * Parent mode: for each resolved command, spawn a `node --prof` child, post-process
 * the emitted `isolate-*.log` with `node --prof-process`, parse the digest into
 * normalised tsgit-frame self-shares, and accumulate them into the committed
 * `docs/perf/baseline.json` + `docs/perf/baseline.md` artifact.
 * Child mode (`--child <cmd>`): drives the one workload under the profiler — a
 * read command loops over the cached medium fixture, a write command loops a
 * fresh scratch repo built through the library's own structured API.
 *
 * Profiles the compiled `dist/` (a plain `node` script cannot resolve the
 * source tree's `.js`-extension imports) — the `profile` npm script builds
 * first. Read commands need the cached medium fixture (and therefore the
 * `git` CLI); write commands build their own scratch repos and do not.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ensureScaledFixture, MEDIUM_FIXTURE } from '../test/bench/support/fixture-generator.ts';
import { type Baseline, machineBanner, writeBaseline } from './profile-baseline.js';
import { parseDigest, partitionWriteDigest } from './profile-digest.js';
import { profileEnv } from './profile-env.js';
import type { ProfileWorkload } from './profile-registry.js';
import {
  READ_ITERATIONS,
  resolveWorkloads,
  UnknownCommandError,
  WORKLOADS,
  WRITE_ITERATIONS,
} from './profile-registry.js';
import type { ScratchRepo } from './profile-scratch-repo.js';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..');
const DIST_ENTRY = path.join(ROOT, 'dist', 'esm', 'index.node.js');

// ── Child mode — runs under `node --prof` ───────────────────────────────────

const runReadChild = async (
  workload: Extract<ProfileWorkload, { kind: 'read' }>,
): Promise<void> => {
  const fixture = await ensureScaledFixture(workload.fixture);
  const { openRepository } = await import(pathToFileURL(DIST_ENTRY).href);
  const env = profileEnv();
  const target = workload.setup === undefined ? undefined : await workload.setup(fixture.cwd, env);
  const iterations = workload.iterations ?? READ_ITERATIONS;

  const repo = await openRepository({ cwd: fixture.cwd });
  try {
    for (let i = 0; i < iterations; i += 1) {
      if (workload.perIterationRepo === true) {
        const fresh = await openRepository({ cwd: fixture.cwd });
        try {
          await workload.run(fresh, fixture, target);
        } finally {
          await fresh.dispose();
        }
      } else {
        await workload.run(repo, fixture, target);
      }
    }
  } finally {
    await repo.dispose();
  }
};

const runWriteChild = async (
  workload: Extract<ProfileWorkload, { kind: 'write' }>,
): Promise<void> => {
  const iterations = workload.iterations ?? WRITE_ITERATIONS;
  const scratches: ScratchRepo[] = [];
  try {
    for (let i = 0; i < iterations; i += 1) {
      const scratch = await workload.build(profileEnv());
      scratches.push(scratch); // teardown deferred off the sampled path
      await workload.run(scratch.repo, scratch);
    }
  } finally {
    for (const scratch of scratches) {
      await scratch.dispose();
    }
  }
};

const runChild = async (cmd: string): Promise<void> => {
  const workload = WORKLOADS[cmd];
  if (workload === undefined) {
    throw new UnknownCommandError(cmd);
  }
  if (workload.kind === 'read') {
    await runReadChild(workload);
    return;
  }
  await runWriteChild(workload);
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

/** Spawns the `--prof` child for one command and returns the raw `--prof-process` digest. */
const captureProfile = async (cmd: string): Promise<string> => {
  const workDir = await mkdtemp(path.join(os.tmpdir(), `tsgit-prof-${cmd}-`));
  try {
    await spawnToCompletion(
      process.execPath,
      ['--prof', '--experimental-strip-types', SCRIPT_PATH, '--child', cmd],
      workDir,
    );
    const entries = await readdir(workDir);
    const isolateLog = entries.find((e) => e.startsWith('isolate-') && e.endsWith('.log'));
    if (isolateLog === undefined) {
      throw new Error(`no isolate log produced for ${cmd}`);
    }
    return await processProfile(path.join(workDir, isolateLog));
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
};

const captureBaseline = async (
  resolved: ReadonlyArray<[string, ProfileWorkload]>,
): Promise<Baseline> => {
  const commands: Record<string, Baseline['commands'][string]> = {};
  for (const [name, workload] of resolved) {
    process.stdout.write(`profiling ${name}…\n`);
    const digest = await captureProfile(name);
    commands[name] =
      workload.kind === 'read' ? { hotShares: parseDigest(digest) } : partitionWriteDigest(digest);
  }
  return { generatedOn: machineBanner(), commands };
};

const main = async (): Promise<void> => {
  const childIndex = process.argv.indexOf('--child');
  if (childIndex !== -1) {
    await runChild(process.argv[childIndex + 1] ?? '');
    return;
  }

  let resolved: ReadonlyArray<[string, ProfileWorkload]>;
  try {
    resolved = resolveWorkloads(process.argv[2]);
  } catch (err) {
    if (err instanceof UnknownCommandError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  const needsFixture = resolved.some(([, workload]) => workload.kind === 'read');
  if (needsFixture) {
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
  }

  const baseline = await captureBaseline(resolved);
  await writeBaseline(baseline, ROOT);
  process.stdout.write(`baseline written to ${path.join(ROOT, 'docs', 'perf')}\n`);
};

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
