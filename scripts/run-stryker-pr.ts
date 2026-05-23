#!/usr/bin/env node
/**
 * Diff-scoped Stryker invocation (Phase 19.1).
 *
 * Reads `TSGIT_MUTATE_PATHS_FILE` (set by CI from `compute-mutation-scope.sh`)
 * or `--mutate <comma-list>` argv (for local dev), then spawns:
 *
 *   stryker run --mutate <comma-list>
 *
 * If neither is supplied, runs `stryker run` over the full tree (local-dev
 * fallback).
 *
 * If the env-var path resolves to an empty file (no src/ changes in the diff),
 * exits 0 without spawning stryker — the CI step gates on the empty case
 * before calling this, but the defensive path keeps local invocation cheap.
 *
 * See `docs/design/phase-19-1-mutation-pyramid.md`.
 */
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import * as process from 'node:process';
import { pathToFileURL } from 'node:url';

export interface SpawnedProcess {
  on(event: 'exit', listener: (code: number | null) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
}

export type SpawnLike = (
  command: string,
  args: readonly string[],
  options?: { stdio?: 'inherit' },
) => SpawnedProcess;

interface RunOptions {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly spawn: SpawnLike;
  readonly stdout: (line: string) => void;
}

const readMutateListFromArgv = (argv: readonly string[]): string | null => {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--mutate') {
      const next = argv[i + 1];
      if (next === undefined || next.length === 0) return null;
      return next;
    }
  }
  return null;
};

const readMutateListFromFile = (filePath: string): string | null => {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf8').trim();
  } catch {
    return null;
  }
  if (content.length === 0) return null;
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(',');
};

export const runStrykerPr = async (opts: RunOptions): Promise<number> => {
  const envFile = opts.env.TSGIT_MUTATE_PATHS_FILE;
  let mutateList: string | null = null;
  let source: 'env' | 'argv' | 'none' = 'none';

  if (envFile !== undefined && envFile.length > 0) {
    mutateList = readMutateListFromFile(envFile);
    source = 'env';
    if (mutateList === null) {
      opts.stdout(`No src/ files in ${envFile} — skipping mutation`);
      return 0;
    }
  }
  if (mutateList === null) {
    mutateList = readMutateListFromArgv(opts.argv);
    if (mutateList !== null) source = 'argv';
  }

  const strykerArgs: string[] = ['run'];
  if (mutateList !== null) {
    strykerArgs.push('--mutate', mutateList);
    opts.stdout(`stryker --mutate (${source}): ${mutateList}`);
  } else {
    opts.stdout('stryker run (full tree — local-dev fallback)');
  }

  return new Promise<number>((resolve) => {
    const child = opts.spawn('stryker', strykerArgs, { stdio: 'inherit' });
    child.on('exit', (code) => {
      resolve(code ?? 1);
    });
    child.on('error', (err) => {
      opts.stdout(`failed to spawn stryker: ${err.message}`);
      resolve(1);
    });
  });
};

const isEntryPoint = (): boolean => {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return import.meta.url === pathToFileURL(entry).href;
};

if (isEntryPoint()) {
  const code = await runStrykerPr({
    argv: process.argv.slice(2),
    env: process.env,
    spawn: spawn as unknown as SpawnLike,
    stdout: (line) => process.stdout.write(`${line}\n`),
  });
  process.exit(code);
}
