import { narrowObjectSourceAccess } from '../application/primitives/object-store.js';
import type { FileSystem } from '../ports/file-system.js';
import type { ObjectSourceAccess } from '../ports/object-source-access.js';

/** The `Context.objectSourceAccess` capability: a read-only view of one object store. */
type ObjectSourceAccessFor = (objectsDir: string) => ObjectSourceAccess;

/**
 * Builds the per-store access capability every entry point shares: each store is
 * reached through `confine`, which receives that store's objects dir as its only
 * root, then narrowed read-only. Memoised per objects dir — the store chain asks
 * for the same source on every lookup.
 */
export const createObjectSourceAccess = (
  confine: (objectsDir: string) => FileSystem,
): ObjectSourceAccessFor => {
  const cache = new Map<string, ObjectSourceAccess>();
  return (objectsDir) => {
    const cached = cache.get(objectsDir);
    if (cached !== undefined) return cached;
    const built = narrowObjectSourceAccess(confine(objectsDir), objectsDir);
    cache.set(objectsDir, built);
    return built;
  };
};
