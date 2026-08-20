#!/usr/bin/env node
/**
 * Assert-tier coverage audit.
 *
 * The three-tier repository-acceptance shape fails open: `assertRepository`
 * keeps the shortest, most natural-sounding name, so a future command that
 * reaches for it bare inherits none of the acceptance gates (repository
 * format, unsupported extension, dubious ownership, implicit bare) and would
 * silently operate on a rejected or untrusted repository. This audit fences
 * that tier mechanically: every exported verb under `src/**\/*.ts` that calls
 * the primitives module's `assertRepository` — directly, through any
 * re-export barrel, or under any local alias — must be named in
 * `tooling/audit-assert-tier.allowlist.json`, or the audit fails. It also
 * fails on a stale allowlist entry (matches no call site) and on a call it
 * cannot attribute to an exported declaration — that unattributable shape is
 * exactly what a bypass would look like, so it is a finding, not a skip.
 *
 * Not `check:architecture`: dependency-cruiser rules are module-granular,
 * but the four survivors share `config.ts` with the five writers that must
 * refuse — no `from`/`to` path rule can separate them without splitting a
 * published subpath. Verb granularity is the whole point.
 *
 * How a legitimate fifth verb is added, in order:
 *   1. Pin the survival against real git — the verb exits 0 on a v99 fixture
 *      *and* a v1-unknown-extension fixture, in both git and tsgit.
 *   2. Add the interop row to the tier co-truth sweep in
 *      `test/integration/repository-format-acceptance-interop.test.ts`.
 *   3. Add the `{ module, verb, reason }` entry, naming that row in `reason`.
 * Editing source alone cannot widen the surviving set — that is the whole
 * difference between this and a convention.
 *
 * Deliberately NOT guarded: `assertAcceptedRepository` itself. A verb taking
 * it instead of `assertOperationalRepository` misses only the eager `[core]`
 * gate — a measured DIFFERENT tier with no attacker-relevant content.
 * Widening this guard there would fence a boundary no measurement makes
 * load-bearing.
 *
 * Blocking from day one — unlike `check:write-surfaces`, this has no
 * warn-only phase.
 */
import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as process from 'node:process';
import * as url from 'node:url';
import * as ts from 'typescript';

import { analyzeCallSites } from './audit-assert-tier/analyze-call-sites.ts';
import { type AssertTierFindings, computeFindings } from './audit-assert-tier/compute-findings.ts';
import { findUngatedVerbs } from './audit-assert-tier/find-ungated-verbs.ts';
import { parseAllowlist } from './audit-assert-tier/load-allowlist.ts';

const SCRIPT_DIR = path.dirname(url.fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, '..');

const TARGET_MODULE = 'src/application/primitives/internal/repo-state.ts';
const TARGET_EXPORT_NAME = 'assertRepository';

const COMPILER_OPTIONS: ts.CompilerOptions = {
  allowJs: false,
  checkJs: false,
  declaration: false,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  target: ts.ScriptTarget.ES2022,
  skipLibCheck: true,
  noEmit: true,
};

interface AuditFlags {
  readonly root: string;
  readonly allowlist: string;
}

export const parseArgs = (argv: ReadonlyArray<string>): AuditFlags => {
  let root = DEFAULT_ROOT;
  let allowlist: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--root') {
      if (value === undefined) throw new Error('--root requires a value');
      root = path.resolve(value);
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
    allowlist: allowlist ?? path.join(root, 'tooling', 'audit-assert-tier.allowlist.json'),
  };
};

const walkTsFiles = async (rootDir: string): Promise<ReadonlyArray<string>> => {
  const out: string[] = [];
  const visit = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile() && full.endsWith('.ts')) out.push(full);
    }
  };
  await visit(rootDir);
  out.sort();
  return out;
};

export const runAudit = async (flags: AuditFlags): Promise<AssertTierFindings> => {
  const srcDir = path.join(flags.root, 'src');
  const filePaths = await walkTsFiles(srcDir);
  const program = ts.createProgram([...filePaths], COMPILER_OPTIONS);
  const callSites = analyzeCallSites(program, filePaths, flags.root, {
    targetModule: path.join(flags.root, TARGET_MODULE),
    targetExportName: TARGET_EXPORT_NAME,
  });

  const raw = await readFile(flags.allowlist, 'utf8');
  const allowlist = parseAllowlist(raw);

  // The public command surface only: `internal/` helpers and the primitives
  // below them compose freely under a tier their caller established, so a
  // gate-less helper is normal rather than a bypass.
  const commandFiles = filePaths.filter(
    (file) =>
      path
        .relative(flags.root, file)
        .replaceAll(path.sep, '/')
        .match(/^src\/application\/commands\/[^/]+\.ts$/) !== null,
  );
  const ungated = findUngatedVerbs(program, commandFiles, flags.root).filter(
    (verb) =>
      !allowlist.ungated.some((entry) => entry.module === verb.module && entry.verb === verb.verb),
  );

  return { ...computeFindings(callSites, allowlist.callers), ungated };
};

const formatFindings = (findings: AssertTierFindings, allowlistRelPath: string): string => {
  const lines: string[] = [];
  for (const f of findings.unguarded) {
    lines.push(
      `audit-assert-tier: ${f.module}:${f.line} \`${f.verb}\` calls bare \`assertRepository\`. ` +
        'That tier skips the acceptance gates (repository format, unsupported extension, dubious ' +
        'ownership, implicit bare) — a rejected or untrusted repository would be operated on. Use ' +
        '`assertAcceptedRepository` (or `assertOperationalRepository`), or, if canonical git really ' +
        'does let this verb survive a rejected repository, add it to ' +
        `${allowlistRelPath} with the measurement that proves it.`,
    );
  }
  for (const f of findings.ungated) {
    lines.push(
      `audit-assert-tier: ${f.module}:${f.line} \`${f.verb}\` is an exported command verb taking ` +
        'a Context that reaches no acceptance tier at all — weaker than calling the bare tier, ' +
        'since it inherits no repository check either. Call `assertAcceptedRepository` (or ' +
        '`assertOperationalRepository`), or, if canonical git lets this verb run on a rejected ' +
        `repository, add it to ${allowlistRelPath}'s \`ungated\` list with the measurement.`,
    );
  }
  for (const f of findings.unattributable) {
    lines.push(
      `audit-assert-tier: ${f.module}:${f.line} calls bare \`assertRepository\` from a call site ` +
        'that cannot be attributed to an exported declaration. That is the exact shape a bypass ' +
        'would take — move the call into an exported verb.',
    );
  }
  for (const entry of findings.stale) {
    lines.push(
      `audit-assert-tier: allowlist entry \`${entry.module}\` / \`${entry.verb}\` matches no call ` +
        'site. Remove the stale entry or restore the caller.',
    );
  }
  return lines.join('\n');
};

const totalFindings = (findings: AssertTierFindings): number =>
  findings.unguarded.length +
  findings.unattributable.length +
  findings.stale.length +
  findings.ungated.length;

const describeError = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const parseFlagsOrExit = (argv: ReadonlyArray<string>): AuditFlags => {
  try {
    return parseArgs(argv);
  } catch (err) {
    process.stderr.write(`audit-assert-tier: ${describeError(err)}\n`);
    process.exit(1);
  }
};

const main = async (): Promise<void> => {
  const flags = parseFlagsOrExit(process.argv.slice(2));
  const findings = await runAudit(flags);
  const total = totalFindings(findings);
  if (total === 0) {
    process.stdout.write('audit-assert-tier: clean\n');
    return;
  }
  const allowlistRelPath = path.relative(flags.root, flags.allowlist).replaceAll(path.sep, '/');
  process.stderr.write(`${formatFindings(findings, allowlistRelPath)}\n`);
  process.exit(1);
};

const invokedDirectly = (): boolean => {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return url.fileURLToPath(import.meta.url) === path.resolve(entry);
};

if (invokedDirectly()) {
  await main().catch((err: unknown) => {
    process.stderr.write(`audit-assert-tier: ${describeError(err)}\n`);
    process.exit(1);
  });
}
