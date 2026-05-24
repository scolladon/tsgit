#!/usr/bin/env node
/**
 * One-shot codemod that rewrites legacy GWT it() titles into the
 * describe-then-it split convention (ADR-117 / phase 19.3c).
 *
 * Algorithm:
 *   1. Scan it() + describe() positions.
 *   2. Bucket legacy `it()`s by their enclosing scope (closest describe
 *      ancestor, or top-level).
 *   3. Within each scope, walk children in source order; collect runs of
 *      consecutive legacy `it()`s sharing (Given, When) with nothing
 *      meaningful between them.
 *   4. Replace each run with a single 3-level
 *      describe-Given > describe-When > it-Then block.
 *   5. Apply replacements right-to-left to keep offsets valid.
 *
 * Shipped only for the sweep commit; deleted in the next.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { glob } from 'node:fs/promises';
import * as path from 'node:path';
import * as process from 'node:process';

import { minimatch } from 'minimatch';

import { parseManifest } from './test-pyramid/parse-manifest.ts';
import {
  type DescribeBlock,
  scanDescribeBlocks,
} from './test-pyramid/scan-describe-blocks.ts';
import { type ItBlock, scanItBlocks } from './test-pyramid/scan-it-blocks.ts';

const LEGACY_RE = /^Given (.+?), When (.+?), Then (.+)$/;
// Same shape, no anchors — used to splice the rewritten title inside the
// surrounding `it(...)` source slice.
const LEGACY_REPLACE_RE = /Given (.+?), When (.+?), Then ([^'"`]+)/;

interface ParsedLegacy {
  readonly given: string;
  readonly when: string;
  readonly then: string;
}

interface EnrichedIt {
  readonly it: ItBlock;
  readonly parsed: ParsedLegacy | null;
  readonly scopeId: number;
  readonly statementEnd: number;
}

interface Replacement {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

const parseLegacy = (title: string): ParsedLegacy | null => {
  const m = LEGACY_RE.exec(title);
  if (!m) return null;
  // Reject titles that look interpolated — the scanner returns the raw
  // characters between the quotes; a `${…}` in there means the original
  // was a template literal, and our text-splice rewrite would corrupt it.
  if (m[1]!.includes('${') || m[2]!.includes('${') || m[3]!.includes('${')) return null;
  return { given: m[1]!, when: m[2]!, then: m[3]! };
};


const findStatementEnd = (source: string, openerIdx: number): number => {
  let i = openerIdx;
  while (i < source.length && source[i] !== '(') i += 1;
  if (i >= source.length) return openerIdx;
  let depth = 0;
  let inString: string | null = null;
  while (i < source.length) {
    const c = source[i]!;
    if (inString !== null) {
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === inString) inString = null;
      i += 1;
      continue;
    }
    if (c === '/' && source[i + 1] === '/') {
      const nl = source.indexOf('\n', i + 2);
      i = nl < 0 ? source.length : nl + 1;
      continue;
    }
    if (c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      if (end < 0) return i;
      i = end + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      inString = c;
    } else if (c === '(') {
      depth += 1;
    } else if (c === ')') {
      depth -= 1;
      if (depth === 0) {
        i += 1;
        break;
      }
    }
    i += 1;
  }
  if (source[i] === ';') i += 1;
  return i;
};

const closestDescribeId = (
  itOpen: number,
  describes: ReadonlyArray<DescribeBlock>,
): number => {
  let bestOpen = -1;
  for (const d of describes) {
    if (d.openIdx < itOpen && itOpen < d.closeIdx && d.openIdx > bestOpen) {
      bestOpen = d.openIdx;
    }
  }
  return bestOpen;
};

const getIndent = (source: string, idx: number): string => {
  let i = idx;
  while (i > 0 && source[i - 1] !== '\n') i -= 1;
  let end = i;
  while (end < source.length && (source[end] === ' ' || source[end] === '\t')) end += 1;
  return source.slice(i, end);
};

const onlyTrivia = (between: string): boolean => {
  let i = 0;
  while (i < between.length) {
    const c = between[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i += 1;
      continue;
    }
    if (c === '/' && between[i + 1] === '/') {
      const nl = between.indexOf('\n', i + 2);
      i = nl < 0 ? between.length : nl + 1;
      continue;
    }
    if (c === '/' && between[i + 1] === '*') {
      const end = between.indexOf('*/', i + 2);
      if (end < 0) return false;
      i = end + 2;
      continue;
    }
    return false;
  }
  return true;
};

const rewriteLeafSnippet = (
  source: string,
  enriched: EnrichedIt,
  leafIndent: string,
  originalIndent: string,
): string => {
  const orig = source.slice(enriched.it.openIdx, enriched.statementEnd);
  const rewritten = orig.replace(LEGACY_REPLACE_RE, `Then ${enriched.parsed!.then}`);
  const lines = rewritten.split('\n');
  const indented = lines.map((line, idx) =>
    idx === 0 ? line : leafIndent.slice(originalIndent.length) + line,
  );
  return leafIndent + indented.join('\n');
};

const groupOrdered = <K, V>(items: ReadonlyArray<V>, keyOf: (v: V) => K): Map<K, V[]> => {
  const out = new Map<K, V[]>();
  for (const item of items) {
    const key = keyOf(item);
    const bucket = out.get(key) ?? [];
    bucket.push(item);
    out.set(key, bucket);
  }
  return out;
};

const buildReplacement = (
  source: string,
  run: ReadonlyArray<EnrichedIt>,
  indent: string,
): string => {
  const givenIndent = indent;
  const whenIndent = `${indent}  `;
  const leafIndent = `${whenIndent}  `;
  const byGiven = groupOrdered(run, (e) => e.parsed!.given);
  const givenBlocks: string[] = [];
  for (const [given, givenItems] of byGiven) {
    const byWhen = groupOrdered(givenItems, (e) => e.parsed!.when);
    const whenBlocks: string[] = [];
    for (const [when, whenItems] of byWhen) {
      const leaves = whenItems
        .map((e) => rewriteLeafSnippet(source, e, leafIndent, indent))
        .join('\n');
      whenBlocks.push(
        `${whenIndent}describe('When ${when}', () => {\n${leaves}\n${whenIndent}});`,
      );
    }
    givenBlocks.push(
      `describe('Given ${given}', () => {\n${whenBlocks.join('\n')}\n${givenIndent}});`,
    );
  }
  return givenBlocks.join(`\n${givenIndent}`);
};

export const rewriteSource = (source: string): string => {
  if (source.length === 0) return source;
  const its = scanItBlocks(source);
  if (its.length === 0) return source;
  const describes = scanDescribeBlocks(source);

  const enriched: EnrichedIt[] = its.map((it) => ({
    it,
    parsed: parseLegacy(it.title),
    scopeId: closestDescribeId(it.openIdx, describes),
    statementEnd: findStatementEnd(source, it.openIdx),
  }));

  const byScope = new Map<number, EnrichedIt[]>();
  for (const e of enriched) {
    const bucket = byScope.get(e.scopeId) ?? [];
    bucket.push(e);
    byScope.set(e.scopeId, bucket);
  }

  const describesByScope = new Map<number, DescribeBlock[]>();
  for (const d of describes) {
    const scope = closestDescribeId(d.openIdx, describes);
    const bucket = describesByScope.get(scope) ?? [];
    bucket.push(d);
    describesByScope.set(scope, bucket);
  }

  const replacements: Replacement[] = [];
  for (const [scopeId, items] of byScope) {
    items.sort((a, b) => a.it.openIdx - b.it.openIdx);
    const siblings = describesByScope.get(scopeId) ?? [];
    let cursor = 0;
    while (cursor < items.length) {
      const start = items[cursor]!;
      if (start.parsed === null) {
        cursor += 1;
        continue;
      }
      let end = cursor + 1;
      while (end < items.length) {
        const candidate = items[end]!;
        if (candidate.parsed === null) break;
        // Extend on shared Given so sibling Whens regroup under one outer
        // describe. Different Givens break the run — the next run starts
        // a fresh Given block.
        if (candidate.parsed.given !== start.parsed.given) break;
        const prevEnd = items[end - 1]!.statementEnd;
        const nextOpen = candidate.it.openIdx;
        const between = source.slice(prevEnd, nextOpen);
        if (!onlyTrivia(between)) break;
        const interveningDescribe = siblings.some(
          (d) => d.openIdx >= prevEnd && d.openIdx < nextOpen,
        );
        if (interveningDescribe) break;
        end += 1;
      }
      const run = items.slice(cursor, end);
      const replStart = run[0]!.it.openIdx;
      const replEnd = run[run.length - 1]!.statementEnd;
      const indent = getIndent(source, replStart);
      replacements.push({
        start: replStart,
        end: replEnd,
        text: buildReplacement(source, run, indent),
      });
      cursor = end;
    }
  }

  if (replacements.length === 0) return source;
  replacements.sort((a, b) => b.start - a.start);
  let out = source;
  for (const r of replacements) {
    out = out.slice(0, r.start) + r.text + out.slice(r.end);
  }
  return out;
};

interface CliArgs {
  readonly root: string;
  readonly patterns: ReadonlyArray<string>;
  readonly check: boolean;
  readonly dryRun: boolean;
}

const DEFAULT_PATTERNS: ReadonlyArray<string> = [
  'test/unit/**/*.test.ts',
  'tooling/test/unit/**/*.test.ts',
];

// Files whose source contains legacy GWT strings as test fixtures rather
// than as real test titles — rewriting them would corrupt the fixtures.
// We hydrate this from the audit manifest's excludePaths (same set the
// audit silences) plus the codemod's own self-test.
const CODEMOD_SELF_EXCLUDE: ReadonlyArray<string> = [
  'tooling/test/unit/codemod-gwt-describe-split.test.ts',
];

const buildExcludeMatcher = async (
  root: string,
): Promise<(rel: string) => boolean> => {
  const patterns: string[] = [...CODEMOD_SELF_EXCLUDE];
  try {
    const raw = await readFile(path.join(root, 'test-pyramid-budgets.json'), 'utf8');
    const manifest = parseManifest(raw);
    patterns.push(...manifest.excludePaths);
  } catch {
    // Manifest optional — fall back to the bare codemod self-exclude.
  }
  return (rel: string) => patterns.some((pattern) => minimatch(rel, pattern));
};

export const parseArgs = (argv: readonly string[]): CliArgs => {
  let root = process.cwd();
  const patterns: string[] = [];
  let check = false;
  let dryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root') {
      const next = argv[i + 1];
      if (next === undefined) throw new Error('--root requires a path argument');
      root = next;
      i += 1;
    } else if (arg === '--glob') {
      const next = argv[i + 1];
      if (next === undefined) throw new Error('--glob requires a pattern');
      patterns.push(next);
      i += 1;
    } else if (arg === '--check') {
      check = true;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return {
    root,
    patterns: patterns.length === 0 ? DEFAULT_PATTERNS : patterns,
    check,
    dryRun,
  };
};

const collectFiles = async (
  root: string,
  patterns: ReadonlyArray<string>,
): Promise<string[]> => {
  const seen = new Set<string>();
  for (const pattern of patterns) {
    const iter = glob(pattern, { cwd: root });
    for await (const entry of iter) {
      seen.add(entry.replace(/\\/g, '/'));
    }
  }
  return [...seen].sort();
};

const isMainModule = (): boolean => {
  const entryUrl = process.argv[1];
  if (entryUrl === undefined) return false;
  const entryPath = path.resolve(entryUrl);
  const thisPath = path.resolve(new URL(import.meta.url).pathname);
  return entryPath === thisPath;
};

if (isMainModule()) {
  const args = parseArgs(process.argv.slice(2));
  const isExcluded = await buildExcludeMatcher(args.root);
  const files = (await collectFiles(args.root, args.patterns)).filter(
    (rel) => !isExcluded(rel),
  );
  let changed = 0;
  for (const rel of files) {
    const abs = path.join(args.root, rel);
    const source = await readFile(abs, 'utf8');
    const rewritten = rewriteSource(source);
    if (rewritten === source) continue;
    changed += 1;
    if (args.dryRun || args.check) {
      process.stdout.write(`would rewrite: ${rel}\n`);
    } else {
      await writeFile(abs, rewritten, 'utf8');
      process.stdout.write(`rewrote: ${rel}\n`);
    }
  }
  const verb = args.dryRun || args.check ? 'would change' : 'changed';
  process.stdout.write(`\n${changed} file(s) ${verb} of ${files.length}\n`);
  process.exit(args.check && changed > 0 ? 1 : 0);
}
