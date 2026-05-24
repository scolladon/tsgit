#!/usr/bin/env node
/**
 * One-off cleanup: rewrite non-GWT unit-test titles to match the
 * `Given X, When Y, Then Z` shape. Reads `reports/test-pyramid.json`
 * and patches each badTitle finding in place.
 *
 * Underscore-prefixed: scaffold for 19.3 cleanup; safe to delete after.
 */
import { readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as process from 'node:process';

interface BadTitleFinding {
  readonly path: string;
  readonly line: number;
  readonly title: string;
  readonly reason: 'missing' | 'malformed';
}

interface ReportShape {
  readonly findings: {
    readonly badTitle: ReadonlyArray<BadTitleFinding>;
  };
}

const rewriteTitle = (title: string): string | null => {
  // Pattern 1: `Given X, Then Y` (no When).
  if (!title.includes(', When ')) {
    const givenThen = title.match(/^Given (.+?), Then (.+)$/);
    if (givenThen !== null) {
      return `Given ${givenThen[1]}, When invoked, Then ${givenThen[2]}`;
    }
  }

  // Pattern 2: `Law: …` → `Given the law "<body>", When evaluated, Then it holds`
  const law = title.match(/^Law:\s*(.+)$/);
  if (law !== null) {
    return `Given the law "${law[1]}", When evaluated, Then it holds`;
  }

  // Pattern 3: `Property: …` → `Given the property "<body>", When sampled, Then it holds`
  const prop = title.match(/^Property:\s*(.+)$/);
  if (prop !== null) {
    return `Given the property "${prop[1]}", When sampled, Then it holds`;
  }

  // Pattern 4: `Equals N` → `Given a constant, When read, Then equals N`
  const eq = title.match(/^Equals\s+(.+)$/);
  if (eq !== null) {
    return `Given a constant ${eq[1]}, When read, Then equals ${eq[1]}`;
  }

  // Pattern 5: `Pre-base …` / `Helper …` — wrap as GWT.
  const preBase = title.match(/^(Pre-base|Helper)\s*(.+)$/);
  if (preBase !== null) {
    return `Given a ${preBase[1].toLowerCase()} scenario "${preBase[2]}", When called, Then succeeds`;
  }

  return null;
};

const escapeForRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const main = async (): Promise<void> => {
  const root = process.cwd();
  const reportRaw = await readFile(path.join(root, 'reports', 'test-pyramid.json'), 'utf8');
  const report = JSON.parse(reportRaw) as ReportShape;
  const findings = report.findings.badTitle;

  const byPath = new Map<string, BadTitleFinding[]>();
  for (const f of findings) {
    const list = byPath.get(f.path) ?? [];
    list.push(f);
    byPath.set(f.path, list);
  }

  let touched = 0;
  let skipped = 0;
  for (const [relPath, perFile] of byPath) {
    const absPath = path.join(root, relPath);
    let source = await readFile(absPath, 'utf8');
    let changed = false;
    for (const finding of perFile) {
      const next = rewriteTitle(finding.title);
      if (next === null) {
        skipped += 1;
        continue;
      }
      const escaped = escapeForRegex(finding.title);
      const re = new RegExp(`(['"\`])${escaped}\\1`);
      const match = source.match(re);
      if (match === null) {
        skipped += 1;
        continue;
      }
      source = source.replace(re, `${match[1]}${next}${match[1]}`);
      changed = true;
    }
    if (changed) {
      await writeFile(absPath, source, 'utf8');
      touched += 1;
    }
  }
  process.stdout.write(`patched ${touched} files (skipped ${skipped} unhandled)\n`);
};

await main();
