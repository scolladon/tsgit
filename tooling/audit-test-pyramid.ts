#!/usr/bin/env node
/**
 * Testing-pyramid audit. Gates on findings whose heuristic key is set to
 * `true` in the manifest's `gating` block; everything else is report-only.
 *
 * Usage:
 *   node --experimental-strip-types scripts/audit-test-pyramid.ts
 *     [--root <repo-root>] [--manifest <path>] [--out <dir>] [--report-only]
 *
 * Defaults to the current working directory, `./test-pyramid-budgets.json`,
 * and `./reports/`. With `--report-only`, exit is `0` regardless of
 * findings. Without it, any gated heuristic with ≥ 1 finding exits `1`.
 * Manifest / filesystem errors also exit `1`.
 */
import { glob, mkdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as process from 'node:process';

import { minimatch } from 'minimatch';

import { classifyTestFile } from './test-pyramid/classify-test-file.ts';
import { tallyTierFiles } from './test-pyramid/count-tier-files.ts';
import { detectBadTitle } from './test-pyramid/detect-bad-title.ts';
import { detectBannedSutName } from './test-pyramid/detect-banned-sut-name.ts';
import { detectBareClassThrow } from './test-pyramid/detect-bare-class-throw.ts';
import { detectEmptyAaaSection } from './test-pyramid/detect-empty-aaa-section.ts';
import { detectMissingAaa } from './test-pyramid/detect-missing-aaa.ts';
import { detectOverMocked } from './test-pyramid/detect-over-mocked.ts';
import { detectUnderAsserted } from './test-pyramid/detect-under-asserted.ts';
import {
  GATING_KEYS,
  parseManifest,
  type GatingKey,
  type PyramidManifest,
} from './test-pyramid/parse-manifest.ts';
import {
  renderJson,
  renderMarkdown,
  type AuditOutcome,
} from './test-pyramid/render-report.ts';
import type { SourceFile } from './test-pyramid/types.ts';

interface CliArgs {
  readonly root: string;
  readonly manifestPath: string;
  readonly outDir: string;
  readonly reportOnly: boolean;
}

const DEFAULT_MANIFEST = 'test-pyramid-budgets.json';
const DEFAULT_OUT = 'reports';

export const parseArgs = (argv: readonly string[]): CliArgs => {
  let root = process.cwd();
  let manifestPath = DEFAULT_MANIFEST;
  let outDir = DEFAULT_OUT;
  let reportOnly = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root') {
      const next = argv[i + 1];
      if (next === undefined) throw new Error('--root requires a path argument');
      root = next;
      i += 1;
    } else if (arg === '--manifest') {
      const next = argv[i + 1];
      if (next === undefined) throw new Error('--manifest requires a path argument');
      manifestPath = next;
      i += 1;
    } else if (arg === '--out') {
      const next = argv[i + 1];
      if (next === undefined) throw new Error('--out requires a path argument');
      outDir = next;
      i += 1;
    } else if (arg === '--report-only') {
      reportOnly = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { root, manifestPath, outDir, reportOnly };
};

const collectFiles = async (
  root: string,
  manifest: PyramidManifest,
): Promise<ReadonlyArray<string>> => {
  const seen = new Set<string>();
  for (const tier of manifest.tiers) {
    const iter = glob(tier.glob, { cwd: root });
    for await (const entry of iter) {
      const normalised = entry.replace(/\\/g, '/');
      seen.add(normalised);
    }
  }
  return [...seen].sort();
};

const readSourceFiles = async (
  root: string,
  paths: ReadonlyArray<string>,
): Promise<ReadonlyArray<SourceFile>> => {
  const out: SourceFile[] = [];
  for (const relPath of paths) {
    const source = await readFile(path.join(root, relPath), 'utf8');
    out.push({ path: relPath, source });
  }
  return out;
};

export const runAudit = async (args: CliArgs): Promise<{
  readonly manifest: PyramidManifest;
  readonly outcome: AuditOutcome;
}> => {
  const manifestRaw = await readFile(path.resolve(args.root, args.manifestPath), 'utf8');
  const manifest = parseManifest(manifestRaw);

  const allPaths = await collectFiles(args.root, manifest);
  const isExcluded = (filePath: string): boolean =>
    manifest.excludePaths.some((pattern) => minimatch(filePath, pattern));
  const classifiedPaths = allPaths.filter(
    (p) => classifyTestFile(manifest, p) !== 'unclassified',
  );
  const filesForTally = classifiedPaths;
  const filesForHeuristics = classifiedPaths.filter((p) => !isExcluded(p));
  const files = await readSourceFiles(args.root, filesForHeuristics);

  const outcome: AuditOutcome = {
    tally: tallyTierFiles(manifest, filesForTally),
    excludePaths: manifest.excludePaths,
    findings: {
      overMocked: detectOverMocked(manifest, files),
      underAsserted: detectUnderAsserted(manifest, files),
      badTitle: detectBadTitle(manifest, files),
      missingAaa: detectMissingAaa(manifest, files),
      bannedSut: detectBannedSutName(manifest, files),
      bareClassThrow: detectBareClassThrow(manifest, files),
      emptyAaaSection: detectEmptyAaaSection(manifest, files),
    },
  };
  return { manifest, outcome };
};

export const writeReports = async (outDir: string, outcome: AuditOutcome): Promise<void> => {
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, 'test-pyramid.json'), renderJson(outcome), 'utf8');
  await writeFile(path.join(outDir, 'test-pyramid.md'), renderMarkdown(outcome), 'utf8');
};

const FINDING_KEY_BY_GATING: Readonly<Record<GatingKey, keyof AuditOutcome['findings']>> = {
  overMockedIntegration: 'overMocked',
  underAssertedUnit: 'underAsserted',
  gwtTitle: 'badTitle',
  aaaBody: 'missingAaa',
  sutNaming: 'bannedSut',
  bareClassToThrow: 'bareClassThrow',
  emptyAaaSection: 'emptyAaaSection',
};

export const collectGatingViolations = (
  manifest: PyramidManifest,
  outcome: AuditOutcome,
): ReadonlyArray<GatingKey> => {
  const out: GatingKey[] = [];
  for (const key of GATING_KEYS) {
    if (!manifest.gating[key]) continue;
    const findingKey = FINDING_KEY_BY_GATING[key];
    if (outcome.findings[findingKey].length > 0) out.push(key);
  }
  return out;
};

const isMainModule = (): boolean => {
  const entryUrl = process.argv[1];
  if (entryUrl === undefined) return false;
  const entryPath = path.resolve(entryUrl);
  const thisPath = path.resolve(new URL(import.meta.url).pathname);
  return entryPath === thisPath;
};

if (isMainModule()) {
  let code = 0;
  try {
    const args = parseArgs(process.argv.slice(2));
    const { manifest, outcome } = await runAudit(args);
    await writeReports(path.resolve(args.root, args.outDir), outcome);
    process.stdout.write(renderMarkdown(outcome));
    if (!args.reportOnly) {
      const violations = collectGatingViolations(manifest, outcome);
      if (violations.length > 0) {
        process.stderr.write(
          `audit gating failed: ${violations.join(', ')}\n`,
        );
        code = 1;
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`audit failed: ${message}\n`);
    code = 1;
  }
  process.exit(code);
}
