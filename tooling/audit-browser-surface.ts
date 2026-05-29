#!/usr/bin/env node
/**
 * Browser-surface coverage audit.
 *
 * Verifies that every command and primitive bound on `Repository` is
 * exercised in either a `test/browser/*.spec.ts` file or a
 * `test/parity/scenarios/*.ts` scenario (both reach the OPFS-backed
 * Repository through `test/browser/parity.spec.ts`). Names that are
 * neither covered nor allowlisted exit non-zero.
 *
 * Source of truth: src/repository.ts (parsed by the same regex pair as
 * tooling/check-doc-coverage.ts — see ADR-130 for the coverage
 * definition, ADR-131 for the allowlist shape, ADR-132 for the
 * blocking-gate posture, ADR-133 for the opening exemptions).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as process from 'node:process';
import * as url from 'node:url';

import { fileExists, readTextFile, scanDir } from './audit-browser-surface/io.ts';

const SCRIPT_DIR = path.dirname(url.fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, '..');

const TIER1_RE = /^ {2}readonly (\w+):\s*BindCtx</gm;
// Nested-namespace command bindings (`repo.config`, `repo.remote`, …) are not
// `BindCtx<…>` — they are typed `commands.XNamespace`. Capture them so the
// namespaced CRUD families stay browser-surface-enforced alongside flat
// commands. Kept identical to tooling/check-doc-coverage.ts so both audits
// parse src/repository.ts the same way.
const TIER1_NAMESPACE_RE = /^ {2}readonly (\w+):\s*commands\.\w+Namespace/gm;
const TIER2_RE = /^ {4}readonly (\w+):\s*BindCtx</gm;
const TIER1_SKIP = new Set(['primitives', 'ctx', 'dispose']);

const COMMAND_CALL_RE = /\brepo\.([a-zA-Z][\w]*)\s*\(/g;
const PRIMITIVE_CALL_RE = /\brepo\.primitives\.([a-zA-Z][\w]*)\s*\(/g;
// Dotted namespace invocations (`repo.config.get(`, `repo.remote.add(`): the
// first segment is the bound namespace name; one verb call covers it.
const NAMESPACE_CALL_RE = /\brepo\.([a-zA-Z][\w]*)\.[a-zA-Z][\w]*\s*\(/g;

const COVERAGE_DIRS: ReadonlyArray<string> = ['test/browser', 'test/parity/scenarios'];

const COVERAGE_FILE_RE = /\.(spec|scenario)\.ts$/;

export type Tier = 'commands' | 'primitives';

export interface AllowEntry {
  readonly name: string;
  readonly reason: string;
  readonly deferredTo: string | null;
}

export interface Allowlist {
  readonly commands: ReadonlyArray<AllowEntry>;
  readonly primitives: ReadonlyArray<AllowEntry>;
}

export interface CoveredEntry {
  readonly name: string;
  readonly sources: ReadonlyArray<string>;
}

interface TierSummary {
  readonly bound: number;
  readonly covered: number;
  readonly exempt: number;
  readonly gaps: number;
}

export interface SurfaceReport {
  readonly summary: { readonly commands: TierSummary; readonly primitives: TierSummary };
  readonly covered: {
    readonly commands: ReadonlyArray<CoveredEntry>;
    readonly primitives: ReadonlyArray<CoveredEntry>;
  };
  readonly exempt: {
    readonly commands: ReadonlyArray<AllowEntry>;
    readonly primitives: ReadonlyArray<AllowEntry>;
  };
  readonly gaps: {
    readonly commands: ReadonlyArray<string>;
    readonly primitives: ReadonlyArray<string>;
  };
}

const describeError = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

const matchAll = (re: RegExp, source: string): ReadonlyArray<string> => {
  const fresh = new RegExp(re.source, re.flags);
  const out: string[] = [];
  let match: RegExpExecArray | null = fresh.exec(source);
  while (match !== null) {
    const captured = match[1];
    if (captured !== undefined) out.push(captured);
    match = fresh.exec(source);
  }
  return out;
};

export const parseRepositoryInterface = (
  source: string,
): { readonly commands: ReadonlyArray<string>; readonly primitives: ReadonlyArray<string> } => {
  const tier1Bound = matchAll(TIER1_RE, source);
  const tier1Namespaces = matchAll(TIER1_NAMESPACE_RE, source);
  const tier1 = [...tier1Bound, ...tier1Namespaces].filter((name) => !TIER1_SKIP.has(name));
  const tier2 = matchAll(TIER2_RE, source);
  return { commands: tier1, primitives: tier2 };
};

export const scanCallSites = (
  source: string,
): { readonly commands: ReadonlySet<string>; readonly primitives: ReadonlySet<string> } => {
  const primitives = new Set(matchAll(PRIMITIVE_CALL_RE, source));
  const commands = new Set<string>();
  for (const name of matchAll(COMMAND_CALL_RE, source)) {
    if (TIER1_SKIP.has(name)) continue;
    commands.add(name);
  }
  for (const name of matchAll(NAMESPACE_CALL_RE, source)) {
    if (TIER1_SKIP.has(name)) continue;
    commands.add(name);
  }
  return { commands, primitives };
};

const isAllowEntry = (value: unknown): value is AllowEntry => {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (typeof record['name'] !== 'string' || record['name'].length === 0) return false;
  if (typeof record['reason'] !== 'string' || record['reason'].length === 0) return false;
  const deferredTo = record['deferredTo'];
  return deferredTo === null || typeof deferredTo === 'string';
};

const parseTier = (value: unknown, tier: Tier): ReadonlyArray<AllowEntry> => {
  if (!Array.isArray(value)) {
    throw new Error(`allowlist.${tier}: expected an array`);
  }
  return value.map((entry, index) => {
    if (!isAllowEntry(entry)) {
      throw new Error(
        `allowlist.${tier}[${index}]: malformed entry (need {name, reason, deferredTo})`,
      );
    }
    return { name: entry.name, reason: entry.reason, deferredTo: entry.deferredTo };
  });
};

export const parseAllowlist = (raw: string): Allowlist => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`allowlist: invalid JSON (${describeError(err)})`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('allowlist: expected an object with {commands, primitives}');
  }
  const record = parsed as Record<string, unknown>;
  return {
    commands: parseTier(record['commands'], 'commands'),
    primitives: parseTier(record['primitives'], 'primitives'),
  };
};

export const validateAllowlistNames = (
  allowlist: Allowlist,
  bound: { readonly commands: ReadonlyArray<string>; readonly primitives: ReadonlyArray<string> },
): void => {
  const checkTier = (
    entries: ReadonlyArray<AllowEntry>,
    names: ReadonlyArray<string>,
    tier: Tier,
  ): void => {
    const allowed = new Set(names);
    for (const entry of entries) {
      if (!allowed.has(entry.name)) {
        throw new Error(
          `allowlist.${tier}: '${entry.name}' is not currently bound on the Repository facade. ` +
            'Remove the stale entry or restore the binding.',
        );
      }
    }
  };
  checkTier(allowlist.commands, bound.commands, 'commands');
  checkTier(allowlist.primitives, bound.primitives, 'primitives');
};

export interface ScanFile {
  readonly path: string;
  readonly source: string;
}

// CQS-violating by intent — the caller (`buildCoverage`) owns the maps and
// has no other writer; promoting the mutation into the function name keeps
// the side-effect honest at call sites.
const appendSourceInPlace = (
  target: Map<string, string[]>,
  name: string,
  file: string,
): void => {
  const existing = target.get(name);
  if (existing === undefined) {
    target.set(name, [file]);
    return;
  }
  if (!existing.includes(file)) existing.push(file);
};

const buildCoverage = (
  files: ReadonlyArray<ScanFile>,
): {
  readonly commands: ReadonlyMap<string, ReadonlyArray<string>>;
  readonly primitives: ReadonlyMap<string, ReadonlyArray<string>>;
} => {
  const commands = new Map<string, string[]>();
  const primitives = new Map<string, string[]>();
  for (const file of files) {
    const sites = scanCallSites(file.source);
    for (const name of sites.commands) appendSourceInPlace(commands, name, file.path);
    for (const name of sites.primitives) appendSourceInPlace(primitives, name, file.path);
  }
  return { commands, primitives };
};

const sortedBy = <T>(items: Iterable<T>, key: (item: T) => string): ReadonlyArray<T> =>
  [...items].sort((a, b) => key(a).localeCompare(key(b)));

const tierCovered = (
  bound: ReadonlyArray<string>,
  coverage: ReadonlyMap<string, ReadonlyArray<string>>,
): ReadonlyArray<CoveredEntry> => {
  const out: CoveredEntry[] = [];
  for (const name of bound) {
    const sources = coverage.get(name);
    if (sources === undefined || sources.length === 0) continue;
    out.push({ name, sources: [...sources].sort() });
  }
  return sortedBy(out, (entry) => entry.name);
};

const tierGaps = (
  bound: ReadonlyArray<string>,
  coverage: ReadonlyMap<string, ReadonlyArray<string>>,
  exempt: ReadonlyArray<AllowEntry>,
): ReadonlyArray<string> => {
  const exemptNames = new Set(exempt.map((entry) => entry.name));
  const out: string[] = [];
  for (const name of bound) {
    if (coverage.has(name)) continue;
    if (exemptNames.has(name)) continue;
    out.push(name);
  }
  return [...out].sort();
};

export const buildReport = (
  bound: { readonly commands: ReadonlyArray<string>; readonly primitives: ReadonlyArray<string> },
  files: ReadonlyArray<ScanFile>,
  allowlist: Allowlist,
): SurfaceReport => {
  const coverage = buildCoverage(files);
  const coveredCommands = tierCovered(bound.commands, coverage.commands);
  const coveredPrimitives = tierCovered(bound.primitives, coverage.primitives);
  const gapCommands = tierGaps(bound.commands, coverage.commands, allowlist.commands);
  const gapPrimitives = tierGaps(bound.primitives, coverage.primitives, allowlist.primitives);
  const exemptCommands = sortedBy(allowlist.commands, (entry) => entry.name);
  const exemptPrimitives = sortedBy(allowlist.primitives, (entry) => entry.name);
  return {
    summary: {
      commands: {
        bound: bound.commands.length,
        covered: coveredCommands.length,
        exempt: exemptCommands.length,
        gaps: gapCommands.length,
      },
      primitives: {
        bound: bound.primitives.length,
        covered: coveredPrimitives.length,
        exempt: exemptPrimitives.length,
        gaps: gapPrimitives.length,
      },
    },
    covered: { commands: coveredCommands, primitives: coveredPrimitives },
    exempt: { commands: exemptCommands, primitives: exemptPrimitives },
    gaps: { commands: gapCommands, primitives: gapPrimitives },
  };
};

export const formatGapMessage = (report: SurfaceReport): string => {
  const lines: string[] = [];
  if (report.gaps.commands.length > 0) {
    lines.push('Commands without browser coverage:');
    for (const name of report.gaps.commands) lines.push(`  - repo.${name}`);
  }
  if (report.gaps.primitives.length > 0) {
    lines.push('Primitives without browser coverage:');
    for (const name of report.gaps.primitives) lines.push(`  - repo.primitives.${name}`);
  }
  lines.push(
    '',
    'Close each gap by adding a test/parity/scenarios/<name>.scenario.ts entry ' +
      'that calls the surface (the browser parity spec picks it up automatically), ' +
      'or add an allowlist entry to tooling/audit-browser-surface.allowlist.json ' +
      'with a written reason.',
  );
  return lines.join('\n');
};

export interface CliFlags {
  readonly root: string;
  readonly out: string;
  readonly allowlist: string;
}

export const parseArgs = (argv: ReadonlyArray<string>): CliFlags => {
  let root = DEFAULT_ROOT;
  let out: string | undefined;
  let allowlist: string | undefined;
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
    } else {
      throw new Error(`unknown flag: ${flag}`);
    }
  }
  return {
    root,
    out: out ?? path.join(root, 'reports'),
    allowlist: allowlist ?? path.join(root, 'tooling', 'audit-browser-surface.allowlist.json'),
  };
};

const collectCoverageFiles = async (root: string): Promise<ReadonlyArray<ScanFile>> => {
  const files: ScanFile[] = [];
  for (const dir of COVERAGE_DIRS) {
    const absolute = path.join(root, dir);
    for (const entry of await scanDir(absolute)) {
      if (!COVERAGE_FILE_RE.test(entry)) continue;
      const source = await readTextFile(entry);
      files.push({ path: path.relative(root, entry).replaceAll(path.sep, '/'), source });
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
};

export const runAudit = async (flags: CliFlags): Promise<SurfaceReport> => {
  const repoSource = await readTextFile(path.join(flags.root, 'src', 'repository.ts'));
  const bound = parseRepositoryInterface(repoSource);
  if (bound.commands.length === 0 && bound.primitives.length === 0) {
    throw new Error(
      'audit-browser-surface: parser yielded zero commands AND zero primitives. ' +
        'src/repository.ts may have been refactored in a shape the regex no longer recognises.',
    );
  }
  const allowlistPresent = await fileExists(flags.allowlist);
  const allowlist: Allowlist = allowlistPresent
    ? parseAllowlist(await readTextFile(flags.allowlist))
    : { commands: [], primitives: [] };
  validateAllowlistNames(allowlist, bound);
  const coverageFiles = await collectCoverageFiles(flags.root);
  const report = buildReport(bound, coverageFiles, allowlist);
  await mkdir(flags.out, { recursive: true });
  await writeFile(
    path.join(flags.out, 'browser-surface-coverage.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  return report;
};

const parseFlagsOrExit = (argv: ReadonlyArray<string>): CliFlags => {
  try {
    return parseArgs(argv);
  } catch (err) {
    process.stderr.write(`audit-browser-surface: ${describeError(err)}\n`);
    process.exit(1);
  }
};

const main = async (): Promise<void> => {
  const flags = parseFlagsOrExit(process.argv.slice(2));
  const report = await runAudit(flags);
  const total = report.gaps.commands.length + report.gaps.primitives.length;
  if (total === 0) {
    process.stdout.write(
      `audit-browser-surface: clean — ${report.summary.commands.covered}/${report.summary.commands.bound} commands, ` +
        `${report.summary.primitives.covered}/${report.summary.primitives.bound} primitives covered ` +
        `(${report.summary.commands.exempt + report.summary.primitives.exempt} exempt)\n`,
    );
    return;
  }
  process.stderr.write(`${formatGapMessage(report)}\n`);
  process.stderr.write(`audit-browser-surface: ${total} gap(s) found\n`);
  process.exit(1);
};

const invokedDirectly = (): boolean => {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return url.fileURLToPath(import.meta.url) === path.resolve(entry);
};

if (invokedDirectly()) {
  await main().catch((err: unknown) => {
    process.stderr.write(`audit-browser-surface: ${describeError(err)}\n`);
    process.exit(1);
  });
}
