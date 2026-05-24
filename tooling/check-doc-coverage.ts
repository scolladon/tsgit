#!/usr/bin/env node
/**
 * Verifies that every command and primitive bound on the Repository handle has
 * a corresponding page under docs/use/{commands,primitives}/ and is listed in
 * the funnel README.md index table.
 *
 * Source of truth: src/repository.ts (ADR-096).
 * Parser strategy: anchored regex over the file text (ADR-097).
 */
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const TIER1_RE = /^ {2}readonly (\w+):\s*BindCtx</gm;
const TIER2_RE = /^ {4}readonly (\w+):\s*BindCtx</gm;
const TIER1_SKIP = new Set(['primitives', 'ctx', 'dispose']);

interface AllowList {
  readonly commands: ReadonlyArray<string>;
  readonly primitives: ReadonlyArray<string>;
}

interface Gap {
  readonly kind: 'commands' | 'primitives';
  readonly name: string;
  readonly missing: 'file' | 'index-row';
  readonly expectedPath: string;
}

const matchAll = (re: RegExp, source: string): ReadonlyArray<string> => {
  const out: string[] = [];
  let m: RegExpExecArray | null = re.exec(source);
  while (m !== null) {
    const name = m[1];
    if (name !== undefined) out.push(name);
    m = re.exec(source);
  }
  return out;
};

export const parseRepositoryInterface = (
  source: string,
): { commands: ReadonlyArray<string>; primitives: ReadonlyArray<string> } => {
  const tier1 = matchAll(new RegExp(TIER1_RE.source, TIER1_RE.flags), source).filter(
    (name) => !TIER1_SKIP.has(name),
  );
  const tier2 = matchAll(new RegExp(TIER2_RE.source, TIER2_RE.flags), source);
  return { commands: tier1, primitives: tier2 };
};

export const kebabCase = (camel: string): string =>
  camel.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();

export const checkDocsExist = (
  kind: 'commands' | 'primitives',
  names: ReadonlyArray<string>,
  docsRoot: string,
  allow: ReadonlyArray<string>,
  fileExists: (p: string) => boolean = existsSync,
): ReadonlyArray<Gap> => {
  const allowSet = new Set(allow);
  const gaps: Gap[] = [];
  for (const name of names) {
    if (allowSet.has(name)) continue;
    const expectedPath = path.join(docsRoot, kind, `${kebabCase(name)}.md`);
    if (!fileExists(expectedPath)) {
      gaps.push({ kind, name, missing: 'file', expectedPath });
    }
  }
  return gaps;
};

export const checkIndexRow = (
  kind: 'commands' | 'primitives',
  names: ReadonlyArray<string>,
  docsRoot: string,
  allow: ReadonlyArray<string>,
  readFile: (p: string) => string = (p) => readFileSync(p, 'utf8'),
): ReadonlyArray<Gap> => {
  const allowSet = new Set(allow);
  const indexPath = path.join(docsRoot, kind, 'README.md');
  let indexContent: string;
  try {
    indexContent = readFile(indexPath);
  } catch {
    return names
      .filter((name) => !allowSet.has(name))
      .map((name) => ({
        kind,
        name,
        missing: 'index-row' as const,
        expectedPath: indexPath,
      }));
  }
  const gaps: Gap[] = [];
  for (const name of names) {
    if (allowSet.has(name)) continue;
    const expectedRow = `[\`${name}\`](${kebabCase(name)}.md)`;
    if (!indexContent.includes(expectedRow)) {
      gaps.push({ kind, name, missing: 'index-row', expectedPath: indexPath });
    }
  }
  return gaps;
};

export const formatGapStanza = (gap: Gap): string => {
  if (gap.missing === 'file') {
    const indexFile = path.join(path.dirname(gap.expectedPath), 'README.md');
    return [
      `ERROR ${gap.expectedPath} missing`,
      `  Surface symbol: repo.${gap.kind === 'commands' ? '' : 'primitives.'}${gap.name}`,
      `  Expected file:  ${gap.expectedPath}`,
      `  Expected index entry in ${indexFile}:`,
      `    | [\`${gap.name}\`](${kebabCase(gap.name)}.md) | <one-line summary> |`,
    ].join('\n');
  }
  return [
    `ERROR ${gap.expectedPath} missing index row for \`${gap.name}\``,
    `  Add a row that links to ${path.dirname(gap.expectedPath)}/${kebabCase(gap.name)}.md.`,
  ].join('\n');
};

const asStringArray = (value: unknown): ReadonlyArray<string> => {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
};

export const parseAllowList = (raw: string): AllowList => {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') {
      return { commands: [], primitives: [] };
    }
    const record = parsed as Record<string, unknown>;
    return {
      commands: asStringArray(record['commands']),
      primitives: asStringArray(record['primitives']),
    };
  } catch {
    return { commands: [], primitives: [] };
  }
};

const loadAllowList = (allowPath: string): AllowList => {
  try {
    return parseAllowList(readFileSync(allowPath, 'utf8'));
  } catch {
    return { commands: [], primitives: [] };
  }
};

export const runCheck = (
  repoRoot: string,
  readSource: (p: string) => string = (p) => readFileSync(p, 'utf8'),
): ReadonlyArray<Gap> => {
  const source = readSource(path.join(repoRoot, 'src', 'repository.ts'));
  const { commands, primitives } = parseRepositoryInterface(source);
  if (commands.length === 0 && primitives.length === 0) {
    throw new Error(
      'check-doc-coverage: parser yielded zero commands AND zero primitives. ' +
        'The Repository interface in src/repository.ts may have been refactored ' +
        'in a shape the regex no longer recognises (see ADR-097).',
    );
  }
  const allow = loadAllowList(path.join(repoRoot, 'scripts', 'check-doc-coverage.allowlist.json'));
  const docsRoot = path.join(repoRoot, 'docs', 'use');
  return [
    ...checkDocsExist('commands', commands, docsRoot, allow.commands),
    ...checkDocsExist('primitives', primitives, docsRoot, allow.primitives),
    ...checkIndexRow('commands', commands, docsRoot, allow.commands),
    ...checkIndexRow('primitives', primitives, docsRoot, allow.primitives),
  ];
};

const main = (): void => {
  const gaps = runCheck(ROOT);
  if (gaps.length === 0) {
    process.stdout.write('check-doc-coverage: clean\n');
    return;
  }
  for (const gap of gaps) {
    process.stderr.write(`${formatGapStanza(gap)}\n\n`);
  }
  process.stderr.write(`check-doc-coverage: ${gaps.length} gap(s) found\n`);
  process.exitCode = 1;
};

const invokedDirectly = (): boolean => {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return url.fileURLToPath(import.meta.url) === path.resolve(entry);
};

if (invokedDirectly()) {
  main();
}
