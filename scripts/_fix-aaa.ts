#!/usr/bin/env node
/**
 * One-off cleanup script — inserts missing `// Arrange` / `// Assert`
 * markers into unit tests so the AAA gate (19.3) passes. Reads the audit
 * report at `reports/test-pyramid.json` and patches each finding in place.
 *
 * Intentionally underscore-prefixed: not part of the shipped tooling, just a
 * scaffold the 19.3 cleanup commit used. Safe to delete once 19.3 lands.
 */
import { readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as process from 'node:process';

interface MissingAaaFinding {
  readonly path: string;
  readonly line: number;
  readonly title: string;
  readonly missing: ReadonlyArray<string>;
}

interface ReportShape {
  readonly findings: {
    readonly missingAaa: ReadonlyArray<MissingAaaFinding>;
  };
}

const ARRANGE_LINE = /(?:^|\n)\s*\/\/\s*Arrange\b/;
const ASSERT_LINE = /(?:^|\n)\s*\/\/\s*Assert\b/;
const ASSERTION_CALL = /\b(?:expect|assert)[a-zA-Z]*[(<.]/;

interface FileEdit {
  readonly insertAt: number;
  readonly text: string;
}

const indexOfLineStart = (source: string, line: number): number => {
  if (line <= 1) return 0;
  let curLine = 1;
  for (let i = 0; i < source.length; i += 1) {
    if (source.charCodeAt(i) === 10) {
      curLine += 1;
      if (curLine === line) return i + 1;
    }
  }
  return -1;
};

const indentOfLine = (source: string, lineStart: number): string => {
  let i = lineStart;
  let out = '';
  while (i < source.length) {
    const c = source[i];
    if (c === ' ' || c === '\t') {
      out += c;
      i += 1;
    } else {
      break;
    }
  }
  return out;
};

const findFirstBodyBrace = (source: string, openerStart: number): number => {
  let parenDepth = 0;
  let inString: string | null = null;
  let i = openerStart;
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
    if (c === '"' || c === "'" || c === '`') {
      inString = c;
      i += 1;
      continue;
    }
    if (c === '(') parenDepth += 1;
    else if (c === ')') parenDepth -= 1;
    else if (c === '{') return i;
    i += 1;
  }
  return -1;
};

const findMatchingClose = (source: string, openIdx: number): number => {
  let depth = 1;
  let inString: string | null = null;
  let i = openIdx + 1;
  while (i < source.length) {
    const c = source[i]!;
    if (inString !== null) {
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === inString) inString = null;
    } else {
      if (c === '"' || c === "'" || c === '`') inString = c;
      else if (c === '{') depth += 1;
      else if (c === '}') {
        depth -= 1;
        if (depth === 0) return i;
      }
    }
    i += 1;
  }
  return -1;
};

const computeEdits = (
  source: string,
  finding: MissingAaaFinding,
): ReadonlyArray<FileEdit> => {
  const lineStart = indexOfLineStart(source, finding.line);
  if (lineStart < 0) return [];
  const indent = indentOfLine(source, lineStart);
  const inner = `${indent}  `;

  const braceIdx = findFirstBodyBrace(source, lineStart);
  if (braceIdx < 0) return [];
  const closeIdx = findMatchingClose(source, braceIdx);
  if (closeIdx < 0) return [];

  const body = source.slice(braceIdx + 1, closeIdx);
  const edits: FileEdit[] = [];

  const needsArrange = finding.missing.includes('Arrange') && !ARRANGE_LINE.test(body);
  const needsAssert = finding.missing.includes('Assert') && !ASSERT_LINE.test(body);

  if (needsArrange) {
    edits.push({ insertAt: braceIdx + 1, text: `\n${inner}// Arrange` });
  }

  if (needsAssert) {
    const tail = source.slice(braceIdx + 1, closeIdx);
    const match = tail.match(ASSERTION_CALL);
    if (match !== null && match.index !== undefined) {
      const absIdx = braceIdx + 1 + match.index;
      let assertLineStart = absIdx;
      while (assertLineStart > 0 && source[assertLineStart - 1] !== '\n') {
        assertLineStart -= 1;
      }
      edits.push({ insertAt: assertLineStart, text: `${inner}// Assert\n` });
    } else {
      let beforeClose = closeIdx;
      while (
        beforeClose > braceIdx + 1 &&
        (source[beforeClose - 1] === ' ' ||
          source[beforeClose - 1] === '\t' ||
          source[beforeClose - 1] === '\n')
      ) {
        beforeClose -= 1;
      }
      edits.push({ insertAt: beforeClose, text: `\n${inner}// Assert\n${indent}` });
    }
  }

  return edits;
};

const applyEdits = (source: string, edits: ReadonlyArray<FileEdit>): string => {
  const sorted = [...edits].sort((a, b) => b.insertAt - a.insertAt);
  let out = source;
  for (const edit of sorted) {
    out = out.slice(0, edit.insertAt) + edit.text + out.slice(edit.insertAt);
  }
  return out;
};

const main = async (): Promise<void> => {
  const root = process.cwd();
  const reportRaw = await readFile(path.join(root, 'reports', 'test-pyramid.json'), 'utf8');
  const report = JSON.parse(reportRaw) as ReportShape;
  const findings = report.findings.missingAaa;

  const byPath = new Map<string, MissingAaaFinding[]>();
  for (const f of findings) {
    const list = byPath.get(f.path) ?? [];
    list.push(f);
    byPath.set(f.path, list);
  }

  let touched = 0;
  for (const [relPath, perFile] of byPath) {
    const absPath = path.join(root, relPath);
    const original = await readFile(absPath, 'utf8');
    const allEdits: FileEdit[] = [];
    for (const finding of perFile) {
      const edits = computeEdits(original, finding);
      allEdits.push(...edits);
    }
    if (allEdits.length === 0) continue;
    const next = applyEdits(original, allEdits);
    if (next !== original) {
      await writeFile(absPath, next, 'utf8');
      touched += 1;
    }
  }
  process.stdout.write(`patched ${touched} files\n`);
};

await main();
