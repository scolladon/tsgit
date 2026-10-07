import type { GitPathSyntax } from '../application/primitives/internal/git-path-syntax.js';
import {
  narrowAlternatePathProbe,
  narrowObjectSourceAccess,
} from '../application/primitives/object-store.js';
import type { FileSystem } from '../ports/file-system.js';
import type { AlternatePathProbe, ObjectSourceAccess } from '../ports/object-source-access.js';
import { filesystemRootOf } from './filesystem-root.js';

/** The `Context.objectSourceAccess` capability: a read-only view of one object store. */
type ObjectSourceAccessFor = (objectsDir: string) => ObjectSourceAccess;

/** The `Context.alternatePathProbe` capability: a metadata-only view of any path. */
type AlternatePathProbeFor = (path: string) => AlternatePathProbe;

const memoisedPerKey = <T>(build: (key: string) => T): ((key: string) => T) => {
  const cache = new Map<string, T>();
  return (key) => {
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const built = build(key);
    cache.set(key, built);
    return built;
  };
};

/**
 * Builds the per-store access capability every entry point shares: each store is
 * reached through `confine`, which receives that store's objects dir as its only
 * root, then narrowed read-only. Memoised per objects dir — the store chain asks
 * for the same source on every lookup.
 */
export const createObjectSourceAccess = (
  confine: (objectsDir: string) => FileSystem,
): ObjectSourceAccessFor =>
  memoisedPerKey((objectsDir) => narrowObjectSourceAccess(confine(objectsDir), objectsDir));

/**
 * Builds the alternate path probe every entry point shares: a path is resolved through `confine`
 * rooted at the filesystem root `pathSyntax` reads it under, narrowed to metadata. Memoised per
 * root — every component of every alternate path asks again.
 */
export const createAlternatePathProbe = (
  confine: (root: string) => FileSystem,
  pathSyntax: GitPathSyntax,
): AlternatePathProbeFor => {
  const probeFor = memoisedPerKey((root) => narrowAlternatePathProbe(confine(root)));
  return (path) => probeFor(filesystemRootOf(pathSyntax, path));
};
