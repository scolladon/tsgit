/**
 * Enumerates every published `(declaration file, runtime module)` pair the
 * package's `exports` map exposes — the entry matrix a per-entry truthful-
 * types audit or fix must cover. Wildcard subpaths (e.g. `./commands/*`)
 * are expanded against the files that actually exist under `dist/`, so a
 * future per-command split is picked up without touching this module.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

export type EntryFormat = 'esm' | 'cjs';

export interface PublishedEntry {
  readonly label: string;
  readonly dtsPath: string;
  readonly runtimePath: string;
  readonly format: EntryFormat;
}

interface LeafPair {
  readonly types: string;
  readonly runtime: string;
  readonly format: EntryFormat;
}

const FORMAT_BY_CONDITION: Readonly<Record<string, EntryFormat>> = {
  import: 'esm',
  require: 'cjs',
};

const collectLeafPairs = (node: unknown, format: EntryFormat): readonly LeafPair[] => {
  if (node === null || typeof node !== 'object') return [];

  const record = node as Record<string, unknown>;
  const { types, default: runtime } = record;
  if (typeof types === 'string' && typeof runtime === 'string') {
    return [{ types, runtime, format }];
  }

  return Object.entries(record).flatMap(([condition, child]) =>
    collectLeafPairs(child, FORMAT_BY_CONDITION[condition] ?? format),
  );
};

const toEntry = (rootDir: string, pair: LeafPair): PublishedEntry => ({
  label: pair.types.replace(/^\.\//, ''),
  dtsPath: path.join(rootDir, pair.types),
  runtimePath: path.join(rootDir, pair.runtime),
  format: pair.format,
});

const expandWildcard = (rootDir: string, pair: LeafPair): readonly PublishedEntry[] => {
  if (!pair.types.includes('*')) return [toEntry(rootDir, pair)];

  const typesDir = path.posix.dirname(pair.types);
  const suffix = path.posix.basename(pair.types).replace('*', '');
  const absTypesDir = path.join(rootDir, typesDir);
  if (!existsSync(absTypesDir)) return [];

  return readdirSync(absTypesDir)
    .filter((file) => file.endsWith(suffix))
    .flatMap((file) => {
      const stem = file.slice(0, -suffix.length);
      const concreteTypes = `${typesDir}/${stem}${suffix}`;
      const concreteRuntime = pair.runtime.replace('*', stem);
      if (!existsSync(path.join(rootDir, concreteRuntime))) return [];
      return [toEntry(rootDir, { ...pair, types: concreteTypes, runtime: concreteRuntime })];
    });
};

/** Every unique `(dtsPath, runtimePath)` pair the package's `exports` map publishes. */
export const getPublishedEntries = (rootDir: string): readonly PublishedEntry[] => {
  const pkg = JSON.parse(readFileSync(path.join(rootDir, 'package.json'), 'utf8')) as {
    readonly exports?: unknown;
  };
  const pairs = collectLeafPairs(pkg.exports, 'esm').flatMap((pair) =>
    expandWildcard(rootDir, pair),
  );

  const seen = new Map<string, PublishedEntry>();
  for (const entry of pairs) {
    seen.set(`${entry.dtsPath}|${entry.runtimePath}`, entry);
  }
  return [...seen.values()].sort((a, b) => a.label.localeCompare(b.label));
};
