#!/usr/bin/env node
/**
 * Mutation budget gate (Phase 19.1).
 *
 * Reads the Stryker mutation report + the bucket manifest, evaluates per-bucket
 * scores against thresholds, prints a table, exits 0 (pass) or 1 (fail).
 *
 * Usage:
 *   node --experimental-strip-types scripts/check-mutation-budgets.ts
 *     [--manifest <path>] [--report <path>]
 *
 * Defaults to `./mutation-budgets.json` + `./reports/mutation/mutation-report.json`.
 *
 * See `docs/design/phase-19-1-mutation-pyramid.md`.
 */
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as process from 'node:process';

import {
  evaluateBudgets,
  parseManifest,
  parseReport,
} from './mutation-budgets.ts';
import type { BudgetCheckOutcome } from './mutation-budgets.ts';

interface CliArgs {
  readonly manifestPath: string;
  readonly reportPath: string;
}

const DEFAULT_MANIFEST = 'mutation-budgets.json';
const DEFAULT_REPORT = path.join('reports', 'mutation', 'mutation-report.json');

export const parseArgs = (argv: readonly string[]): CliArgs => {
  let manifestPath = DEFAULT_MANIFEST;
  let reportPath = DEFAULT_REPORT;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--manifest') {
      const next = argv[i + 1];
      if (next === undefined) throw new Error('--manifest requires a path argument');
      manifestPath = next;
      i++;
    } else if (arg === '--report') {
      const next = argv[i + 1];
      if (next === undefined) throw new Error('--report requires a path argument');
      reportPath = next;
      i++;
    } else if (arg === '--help' || arg === '-h') {
      throw new Error(
        'usage: check-mutation-budgets [--manifest <path>] [--report <path>]',
      );
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { manifestPath, reportPath };
};

const readJson = async (filePath: string, what: string): Promise<unknown> => {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`${what} not found: ${filePath} (${reason})`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`${what} not valid JSON: ${filePath} (${reason})`);
  }
};

const formatScore = (score: number): string =>
  Number.isNaN(score) ? '   n/a' : `${score.toFixed(2).padStart(6, ' ')}`;

export const renderTable = (outcome: BudgetCheckOutcome): string => {
  const header =
    '  bucket       files  mutants  killed  surv  noCov  timeo   score  break  status';
  const sep = '  ' + '-'.repeat(header.length - 2);
  const rows = outcome.results.map((r) => {
    const status =
      r.status === 'pass' ? 'PASS' : r.status === 'fail' ? 'FAIL' : ' n/a';
    return [
      '  ',
      r.bucket.padEnd(13),
      String(r.fileCount).padStart(4),
      String(r.mutants.total).padStart(9),
      String(r.mutants.killed).padStart(8),
      String(r.mutants.survived).padStart(6),
      String(r.mutants.noCoverage).padStart(7),
      String(r.mutants.timeout).padStart(7),
      formatScore(r.score).padStart(8),
      String(r.threshold).padStart(7),
      status.padStart(8),
    ].join('');
  });

  const trailing: string[] = [];
  if (outcome.unassignedFiles.length > 0) {
    trailing.push('', 'Unassigned files (every src/ file must belong to a bucket):');
    for (const p of outcome.unassignedFiles) {
      trailing.push(`  - ${p}`);
    }
  }
  if (outcome.overlaps.length > 0) {
    trailing.push('', 'Bucket overlap (one file matched multiple buckets):');
    for (const o of outcome.overlaps) {
      trailing.push(`  - ${o.path} matched: ${o.buckets.join(', ')}`);
    }
  }
  return [header, sep, ...rows, ...trailing].join('\n');
};

export interface RunDeps {
  readonly cwd: () => string;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
}

export const run = async (
  argv: readonly string[],
  deps: RunDeps,
): Promise<number> => {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    deps.stderr(err instanceof Error ? err.message : String(err));
    return 1;
  }

  const cwd = deps.cwd();
  const manifestPath = path.isAbsolute(args.manifestPath)
    ? args.manifestPath
    : path.join(cwd, args.manifestPath);
  const reportPath = path.isAbsolute(args.reportPath)
    ? args.reportPath
    : path.join(cwd, args.reportPath);

  try {
    const rawManifest = await readJson(manifestPath, 'manifest');
    const rawReport = await readJson(reportPath, 'report');
    const manifest = parseManifest(rawManifest);
    const report = parseReport(rawReport);
    const outcome = evaluateBudgets(report, manifest);
    deps.stdout(renderTable(outcome));
    if (!outcome.ok) {
      deps.stderr('\nMutation budget gate FAILED — see table above.');
      return 1;
    }
    deps.stdout('\nMutation budget gate passed.');
    return 0;
  } catch (err) {
    deps.stderr(err instanceof Error ? err.message : String(err));
    return 1;
  }
};

const isEntryPoint = (): boolean => {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  const meta = import.meta.url;
  return meta === `file://${entry}` || meta.endsWith(path.basename(entry));
};

if (isEntryPoint()) {
  const exitCode = await run(process.argv.slice(2), {
    cwd: () => process.cwd(),
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
  });
  process.exit(exitCode);
}
