#!/usr/bin/env node
/**
 * Write-surface coverage audit.
 *
 * Verifies that every module under `src/` carrying a `@writes` JSDoc tag
 * is exercised by at least one `cross-tool-interop` integration test
 * whose `interopSurface:` key names that surface (or by an entry in
 * `tooling/audit-write-surfaces.allowlist.json`). Static analysis only —
 * does not invoke `git` (the matrix CI jobs do that, see design §3.6).
 *
 * Posture: ships warn-only on the sweep PR (ADR-139). The audit emits
 * the report and a stderr warning for any gap, but exits 0 unless
 * `--blocking` is passed.
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as process from 'node:process';
import * as url from 'node:url';

import type { IntegrationProofHeuristic } from './test-pyramid/parse-manifest.ts';
import { parseProvesHeader } from './test-pyramid/parse-proves-header.ts';
import { type AllowEntry, computeGaps } from './audit-write-surfaces/compute-gaps.ts';
import { parseAllowlist } from './audit-write-surfaces/load-allowlist.ts';
import { parseInteropSurface } from './audit-write-surfaces/parse-interop-surface.ts';
import {
  type WritesTagConfig,
  parseWritesTag,
} from './audit-write-surfaces/parse-writes-tag.ts';

const SCRIPT_DIR = path.dirname(url.fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, '..');

const SURFACE_REGEX = /^[a-z][a-zA-Z0-9.-]{1,40}$/;
const FORMAT_REGEX = /^[a-z][a-z0-9-]+$/;
const FORMAT_MIN = 4;
const FORMAT_MAX = 40;

const INTEROP_BUCKETS = new Set(['cross-tool-interop']);

const WRITES_TAG_CONFIG: WritesTagConfig = {
  surfaceRegex: SURFACE_REGEX,
  formatRegex: FORMAT_REGEX,
  formatMinLength: FORMAT_MIN,
  formatMaxLength: FORMAT_MAX,
};

const INTEROP_CONFIG = {
  surfaceRegex: SURFACE_REGEX,
  interopBuckets: INTEROP_BUCKETS,
};

const PROVES_CONFIG: IntegrationProofHeuristic = {
  tier: 'integration',
  buckets: [
    'real-fs',
    'real-http',
    'real-process',
    'cross-tool-interop',
    'platform-only',
    'multi-adapter-parity',
    'coverage-gap',
  ],
  surfaceRegex: SURFACE_REGEX,
  surfaceRegexSource: SURFACE_REGEX.source,
  uniqueMinLength: 12,
  uniqueMaxLength: 200,
  directoryRules: new Map(),
};

interface AuditFlags {
  readonly root: string;
  readonly out: string;
  readonly allowlist: string;
  readonly blocking: boolean;
}

export const parseArgs = (argv: ReadonlyArray<string>): AuditFlags => {
  let root = DEFAULT_ROOT;
  let out: string | undefined;
  let allowlist: string | undefined;
  let blocking = false;
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--root') {
      if (value === undefined) throw new Error('--root requires a value');
      root = path.resolve(value);
      i += 1;
    } else if (flag === '--out') {
      if (value === undefined) throw new Error('--out requires a value');
      out = path.resolve(value);
      i += 1;
    } else if (flag === '--allowlist') {
      if (value === undefined) throw new Error('--allowlist requires a value');
      allowlist = path.resolve(value);
      i += 1;
    } else if (flag === '--blocking') {
      blocking = true;
    } else {
      throw new Error(`unknown flag: ${flag}`);
    }
  }
  return {
    root,
    out: out ?? path.join(root, 'reports'),
    allowlist:
      allowlist ?? path.join(root, 'tooling', 'audit-write-surfaces.allowlist.json'),
    blocking,
  };
};

const fileExists = async (target: string): Promise<boolean> => {
  try {
    await readFile(target);
    return true;
  } catch {
    return false;
  }
};

const walkDir = async (
  rootDir: string,
  match: (relPath: string) => boolean,
): Promise<ReadonlyArray<string>> => {
  const out: string[] = [];
  const visit = async (current: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(full);
      } else if (entry.isFile()) {
        if (match(full)) out.push(full);
      }
    }
  };
  await visit(rootDir);
  out.sort();
  return out;
};

const isCodeFile = (p: string): boolean =>
  p.endsWith('.ts') &&
  !p.endsWith('.test.ts') &&
  !p.endsWith('.spec.ts') &&
  !p.endsWith('.properties.test.ts') &&
  path.basename(p) !== 'index.ts';

const isIntegrationTest = (p: string): boolean => p.endsWith('.test.ts');

interface WriteSurfaceDecl {
  readonly name: string;
  readonly kind: 'byte-identical' | 'equivalent-under-readback' | 'readback-only';
  readonly format: string;
  readonly declaredIn: string;
}

interface CoverageDecl {
  readonly surface: string;
  readonly coveredBy: ReadonlyArray<string>;
}

interface ParseFinding {
  readonly path: string;
  readonly kind: 'src-malformed' | 'test-malformed';
  readonly detail: string;
}

interface CollectedSources {
  readonly surfaces: ReadonlyArray<WriteSurfaceDecl>;
  readonly malformedSrc: ReadonlyArray<ParseFinding>;
}

const collectWriteSurfaces = async (root: string): Promise<CollectedSources> => {
  const srcDir = path.join(root, 'src');
  const files = await walkDir(srcDir, isCodeFile);
  const surfaces: WriteSurfaceDecl[] = [];
  const malformed: ParseFinding[] = [];
  for (const absPath of files) {
    const source = await readFile(absPath, 'utf8');
    if (!source.includes('@writes')) continue;
    const result = parseWritesTag(source, WRITES_TAG_CONFIG);
    const rel = path.relative(root, absPath).replaceAll(path.sep, '/');
    if (!result.ok) {
      malformed.push({
        path: rel,
        kind: 'src-malformed',
        detail: `${result.error.reason}${result.error.detail !== undefined ? `: ${result.error.detail}` : ''}`,
      });
      continue;
    }
    surfaces.push({
      name: result.tag.surface,
      kind: result.tag.kind,
      format: result.tag.format,
      declaredIn: rel,
    });
  }
  return { surfaces, malformedSrc: malformed };
};

interface CollectedCoverage {
  readonly coverage: ReadonlyArray<CoverageDecl>;
  readonly malformedTest: ReadonlyArray<ParseFinding>;
}

const collectCoverage = async (root: string): Promise<CollectedCoverage> => {
  const testDir = path.join(root, 'test', 'integration');
  const files = await walkDir(testDir, isIntegrationTest);
  const byName = new Map<string, string[]>();
  const malformed: ParseFinding[] = [];
  for (const absPath of files) {
    const source = await readFile(absPath, 'utf8');
    const proves = parseProvesHeader(source, PROVES_CONFIG);
    if (!proves.ok) continue;
    const interop = parseInteropSurface(source, proves.header.bucket, INTEROP_CONFIG);
    const rel = path.relative(root, absPath).replaceAll(path.sep, '/');
    if (!interop.ok) {
      malformed.push({
        path: rel,
        kind: 'test-malformed',
        detail: `${interop.error.reason}${interop.error.detail !== undefined ? `: ${interop.error.detail}` : ''}`,
      });
      continue;
    }
    for (const name of interop.surfaces) {
      const existing = byName.get(name);
      if (existing === undefined) byName.set(name, [rel]);
      else if (!existing.includes(rel)) existing.push(rel);
    }
  }
  const coverage: CoverageDecl[] = [];
  for (const [surface, paths] of byName) {
    coverage.push({ surface, coveredBy: paths });
  }
  return { coverage, malformedTest: malformed };
};

const loadAllowlistIfPresent = async (
  allowlistPath: string,
): Promise<ReadonlyArray<AllowEntry>> => {
  if (!(await fileExists(allowlistPath))) return [];
  const raw = await readFile(allowlistPath, 'utf8');
  return parseAllowlist(raw, { surfaceRegex: SURFACE_REGEX });
};

export interface AuditReport {
  readonly summary: {
    readonly declared: number;
    readonly covered: number;
    readonly exempt: number;
    readonly gaps: number;
    readonly allowlistRot: number;
    readonly orphanCoverage: number;
    readonly malformed: number;
  };
  readonly covered: ReadonlyArray<{
    readonly surface: string;
    readonly kind: string;
    readonly format: string;
    readonly declaredIn: string;
    readonly coveredBy: ReadonlyArray<string>;
  }>;
  readonly exempt: ReadonlyArray<AllowEntry>;
  readonly gaps: ReadonlyArray<{
    readonly surface: string;
    readonly kind: string;
    readonly declaredIn: string;
  }>;
  readonly allowlistRot: ReadonlyArray<string>;
  readonly orphanCoverage: ReadonlyArray<{
    readonly surface: string;
    readonly coveredBy: ReadonlyArray<string>;
  }>;
  readonly malformed: ReadonlyArray<ParseFinding>;
}

export const runAudit = async (flags: AuditFlags): Promise<AuditReport> => {
  const { surfaces, malformedSrc } = await collectWriteSurfaces(flags.root);
  const { coverage, malformedTest } = await collectCoverage(flags.root);
  const exempt = await loadAllowlistIfPresent(flags.allowlist);

  const gaps = computeGaps({
    surfaces: surfaces.map((s) => ({
      name: s.name,
      kind: s.kind,
      format: s.format,
      declaredIn: s.declaredIn,
    })),
    covered: coverage,
    exempt: [...exempt],
  });

  const malformed = [...malformedSrc, ...malformedTest].sort((a, b) =>
    a.path.localeCompare(b.path),
  );

  const report: AuditReport = {
    summary: {
      declared: surfaces.length,
      covered: gaps.covered.length,
      exempt: gaps.exempt.length,
      gaps: gaps.gaps.length,
      allowlistRot: gaps.allowlistRot.length,
      orphanCoverage: gaps.orphanCoverage.length,
      malformed: malformed.length,
    },
    covered: gaps.covered.map((c) => ({
      surface: c.name,
      kind: c.kind,
      format: c.format,
      declaredIn: c.declaredIn,
      coveredBy: c.coveredBy,
    })),
    exempt: gaps.exempt,
    gaps: gaps.gaps.map((g) => ({
      surface: g.name,
      kind: g.kind,
      declaredIn: g.declaredIn,
    })),
    allowlistRot: gaps.allowlistRot,
    orphanCoverage: gaps.orphanCoverage.map((o) => ({
      surface: o.surface,
      coveredBy: [...o.coveredBy],
    })),
    malformed,
  };

  await mkdir(flags.out, { recursive: true });
  await writeFile(
    path.join(flags.out, 'write-surface-coverage.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  return report;
};

const formatFindings = (report: AuditReport): string => {
  const lines: string[] = [];
  if (report.gaps.length > 0) {
    lines.push('Write surfaces without cross-tool-interop coverage:');
    for (const g of report.gaps) {
      lines.push(`  - ${g.surface} [${g.kind}] declared in ${g.declaredIn}`);
    }
  }
  if (report.allowlistRot.length > 0) {
    lines.push('Allowlist entries for surfaces no @writes tag declares:');
    for (const name of report.allowlistRot) lines.push(`  - ${name}`);
  }
  if (report.orphanCoverage.length > 0) {
    lines.push('Tests claiming interopSurface for names no @writes tag declares:');
    for (const o of report.orphanCoverage) {
      lines.push(`  - ${o.surface}  (covered by ${o.coveredBy.join(', ')})`);
    }
  }
  if (report.malformed.length > 0) {
    lines.push('Malformed headers:');
    for (const m of report.malformed) {
      lines.push(`  - ${m.path}  (${m.detail})`);
    }
  }
  return lines.join('\n');
};

const totalFindings = (report: AuditReport): number =>
  report.gaps.length +
  report.allowlistRot.length +
  report.orphanCoverage.length +
  report.malformed.length;

const describeError = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

const parseFlagsOrExit = (argv: ReadonlyArray<string>): AuditFlags => {
  try {
    return parseArgs(argv);
  } catch (err) {
    process.stderr.write(`audit-write-surfaces: ${describeError(err)}\n`);
    process.exit(1);
  }
};

const main = async (): Promise<void> => {
  const flags = parseFlagsOrExit(process.argv.slice(2));
  const report = await runAudit(flags);
  const total = totalFindings(report);
  if (total === 0) {
    process.stdout.write(
      `audit-write-surfaces: clean — ${report.summary.covered}/${report.summary.declared} ` +
        `surfaces covered (${report.summary.exempt} exempt)\n`,
    );
    return;
  }
  const findings = formatFindings(report);
  const prefix = flags.blocking ? 'audit-write-surfaces' : 'audit-write-surfaces [warn-only]';
  process.stderr.write(`${findings}\n${prefix}: ${total} finding(s)\n`);
  if (flags.blocking) process.exit(1);
};

const invokedDirectly = (): boolean => {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return url.fileURLToPath(import.meta.url) === path.resolve(entry);
};

if (invokedDirectly()) {
  await main().catch((err: unknown) => {
    process.stderr.write(`audit-write-surfaces: ${describeError(err)}\n`);
    process.exit(1);
  });
}
