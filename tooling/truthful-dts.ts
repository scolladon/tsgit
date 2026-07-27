#!/usr/bin/env node
/**
 * Rewrites every published entry's built declaration file so it declares
 * exactly the value exports its own runtime module provides.
 *
 * rollup-plugin-dts shares declaration chunks across the package's several
 * entry points; a symbol that is a genuine runtime value on one entry's
 * chunk carries that value-shaped declaration into every other entry
 * re-exporting the same chunk, even one whose runtime bundle never binds
 * it. Declaring such a symbol `export type` instead of `export` turns the
 * bad import into a compile error rather than a runtime `undefined`.
 *
 * Runs as the last step of `build:js` (wireit) — never a manual fixup.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import * as url from 'node:url';

import * as ts from 'typescript';
import { getPublishedEntries, type PublishedEntry } from './dts-entries.ts';
import {
  analyzeDeclaredExports,
  type EntryDeclarations,
  findUndefinedValueExports,
} from './dts-value-exports.ts';

const SCRIPT_DIR = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, '..');

const requireCjs = createRequire(import.meta.url);

const loadRuntimeExportNames = async (entry: PublishedEntry): Promise<ReadonlySet<string>> => {
  const runtimeModule =
    entry.format === 'cjs' ? requireCjs(entry.runtimePath) : await import(entry.runtimePath);
  return new Set(Object.keys(runtimeModule as Record<string, unknown>));
};

const collectSpecifierEdits = (
  sourceFile: ts.SourceFile,
  leakedNames: ReadonlySet<string>,
): readonly number[] => {
  const positions: number[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isExportDeclaration(node) &&
      !node.isTypeOnly &&
      node.exportClause &&
      ts.isNamedExports(node.exportClause)
    ) {
      for (const specifier of node.exportClause.elements) {
        if (!specifier.isTypeOnly && leakedNames.has(specifier.name.text)) {
          positions.push(specifier.getStart(sourceFile));
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return positions;
};

const downgradeToTypeOnly = (sourceText: string, positions: readonly number[]): string =>
  [...positions]
    .sort((a, b) => b - a)
    .reduce(
      (text, position) => `${text.slice(0, position)}type ${text.slice(position)}`,
      sourceText,
    );

const fixEntry = async (
  entry: PublishedEntry,
  declarations: EntryDeclarations,
): Promise<number> => {
  const runtimeNames = await loadRuntimeExportNames(entry);
  const leaked = new Set(findUndefinedValueExports(declarations.exports, runtimeNames));
  if (leaked.size === 0) return 0;

  const positions = collectSpecifierEdits(declarations.sourceFile, leaked);
  if (positions.length !== leaked.size) {
    throw new Error(
      `truthful-dts: ${entry.label} — expected ${leaked.size} rewritable specifier(s) for ` +
        `[${[...leaked].join(', ')}], found ${positions.length}`,
    );
  }

  const originalText = readFileSync(entry.dtsPath, 'utf8');
  writeFileSync(entry.dtsPath, downgradeToTypeOnly(originalText, positions));
  return positions.length;
};

const main = async (): Promise<void> => {
  const entries = getPublishedEntries(ROOT);
  const declaredByPath = analyzeDeclaredExports(entries.map((entry) => entry.dtsPath));

  for (const entry of entries) {
    const declarations = declaredByPath.get(entry.dtsPath);
    if (!declarations) {
      throw new Error(`truthful-dts: no declarations parsed for ${entry.label}`);
    }
    const fixedCount = await fixEntry(entry, declarations);
    if (fixedCount > 0) {
      console.log(
        `truthful-dts: downgraded ${fixedCount} leaked value export(s) in ${entry.label}`,
      );
    }
  }
};

await main();
