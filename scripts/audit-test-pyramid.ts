#!/usr/bin/env node
/**
 * Testing-pyramid audit (Phase 19.2). Report-only — see ADR-104.
 *
 * Usage:
 *   node --experimental-strip-types scripts/audit-test-pyramid.ts
 *     [--root <repo-root>] [--manifest <path>] [--out <dir>]
 *
 * Defaults to the current working directory, `./test-pyramid-budgets.json`,
 * and `./reports/`. Always exits 0 on a clean run; exits 1 only when the
 * manifest is malformed or a filesystem error prevents the run.
 */
import { glob, mkdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as process from 'node:process';

import { classifyTestFile } from './test-pyramid/classify-test-file.ts';
import { tallyTierFiles } from './test-pyramid/count-tier-files.ts';
import { detectOverMocked, type SourceFile } from './test-pyramid/detect-over-mocked.ts';
import { detectUnderAsserted } from './test-pyramid/detect-under-asserted.ts';
import { parseManifest, type PyramidManifest } from './test-pyramid/parse-manifest.ts';
import {
  renderJson,
  renderMarkdown,
  type AuditOutcome,
} from './test-pyramid/render-report.ts';

interface CliArgs {
  readonly root: string;
  readonly manifestPath: string;
  readonly outDir: string;
}

const DEFAULT_MANIFEST = 'test-pyramid-budgets.json';
const DEFAULT_OUT = 'reports';

export const parseArgs = (argv: readonly string[]): CliArgs => {
  let root = process.cwd();
  let manifestPath = DEFAULT_MANIFEST;
  let outDir = DEFAULT_OUT;
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
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { root, manifestPath, outDir };
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

export const runAudit = async (args: CliArgs): Promise<AuditOutcome> => {
  const manifestRaw = await readFile(path.resolve(args.root, args.manifestPath), 'utf8');
  const manifest = parseManifest(manifestRaw);

  const allPaths = await collectFiles(args.root, manifest);
  const classifiedPaths = allPaths.filter(
    (p) => classifyTestFile(manifest, p) !== 'unclassified',
  );
  const files = await readSourceFiles(args.root, classifiedPaths);

  return {
    tally: tallyTierFiles(manifest, classifiedPaths),
    findings: {
      overMocked: detectOverMocked(manifest, files),
      underAsserted: detectUnderAsserted(manifest, files),
    },
  };
};

export const writeReports = async (outDir: string, outcome: AuditOutcome): Promise<void> => {
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, 'test-pyramid.json'), renderJson(outcome), 'utf8');
  await writeFile(path.join(outDir, 'test-pyramid.md'), renderMarkdown(outcome), 'utf8');
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
    const outcome = await runAudit(args);
    await writeReports(path.resolve(args.root, args.outDir), outcome);
    process.stdout.write(renderMarkdown(outcome));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`audit failed: ${message}\n`);
    code = 1;
  }
  process.exit(code);
}
