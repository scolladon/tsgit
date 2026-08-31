import { describe, expect, it } from 'vitest';

import {
  MemoryCompressor,
  MemoryFileSystem,
  MemoryHashService,
  MemoryHttpTransport,
} from '../../../src/adapters/memory/index.js';
import * as primitives from '../../../src/application/primitives/index.js';
import { SHA1_CONFIG } from '../../../src/domain/objects/hash-config.js';
import { createLruCache } from '../../../src/domain/storage/lru-cache.js';
import { openRepository, type RuntimeFallback } from '../../../src/repository.js';

/**
 * Kills the B3 wiring-drift class: a `primitives/index.ts` export that is
 * shaped like a Tier-2 primitive — `(ctx, …)` — but never reaches
 * `repo.primitives`. Every such export must be either bound, or listed here
 * with a reason (internal building block reused by commands/other
 * primitives, not part of the documented Tier-2 surface).
 */
const EXCLUDED_PRIMITIVES: ReadonlyArray<{ readonly name: string; readonly reason: string }> = [
  {
    name: 'appendReflog',
    reason:
      'internal reflog-store primitive with no current internal consumer — the files backend and record-ref-update.ts own private copies to avoid an import cycle through ref-store.ts',
  },
  {
    name: 'applyChangeset',
    reason: 'internal working-tree materialisation primitive reused by apply-sparse-checkout',
  },
  {
    name: 'assertValidPackIntConfig',
    reason:
      'internal pack-config refusal gate for pack.window/pack.depth/pack.windowMemory; not yet wired into a repo.primitives-bound command',
  },
  {
    name: 'buildIndexFromTree',
    reason: 'internal index-rebuild primitive reused by stash/reset',
  },
  { name: 'buildPack', reason: 'internal pack-building primitive reused by push/bundle-create' },
  {
    name: 'compareWorkingTreeDelta',
    reason: 'internal working-tree comparison primitive reused by status',
  },
  {
    name: 'compareWorkingTreeEntry',
    reason: 'internal working-tree comparison primitive reused by rm/stash/clean-work-tree',
  },
  { name: 'createTag', reason: 'internal tag-object primitive reused by the tag command' },
  {
    name: 'deleteReflog',
    reason:
      'internal reflog-store primitive with no current internal consumer — the files backend owns a private copy (applyRefUpdates delete) to avoid an import cycle through ref-store.ts',
  },
  { name: 'enumerateObjects', reason: 'internal object-enumeration primitive reused by fsck' },
  {
    name: 'enumeratePushObjects',
    reason: 'internal push-object-enumeration primitive reused by push',
  },
  {
    name: 'enumerateRefs',
    reason:
      'internal ref-enumeration primitive reused by push/bundle-create/remote/describe/name-rev/reflog/fsck',
  },
  {
    name: 'fetchPack',
    reason: 'internal smart-HTTP fetch primitive reused by clone/fetch/fetchMissing',
  },
  {
    name: 'findFirstInvalidPackInt',
    reason:
      'cold-path finder backing assertValidPackIntConfig, not part of the documented Tier-2 surface',
  },
  {
    name: 'findFirstValuelessEntry',
    reason: 'internal config-guard primitive reused by valueless-config-guard/repo-state',
  },
  { name: 'hasObject', reason: 'internal object-existence probe reused by fetch' },
  {
    name: 'invalidateConfigCache',
    reason: 'internal cache-invalidation primitive invoked by the config-write primitives',
  },
  {
    name: 'invalidateScopedConfigCache',
    reason: 'internal cache-invalidation primitive invoked by the config-write primitives',
  },
  {
    name: 'isWorkingTreeDirty',
    reason: 'internal dirty-check primitive reused by apply-sparse-checkout',
  },
  {
    name: 'listReflogs',
    reason: 'internal reflog-store primitive reused by reflog/rev-parse/fsck-roots',
  },
  { name: 'loadNotesTree', reason: 'internal notes-tree primitive reused by the notes command' },
  {
    name: 'loadSparseMatcher',
    reason: 'internal sparse-checkout primitive reused by checkout/sparseCheckout/reset/merge',
  },
  {
    name: 'materializeTree',
    reason:
      'internal working-tree materialisation primitive reused by worktree/checkout/stash/reset/merge',
  },
  {
    name: 'materializeWorktreeFromHead',
    reason: 'internal worktree-materialisation primitive reused by submodule',
  },
  {
    name: 'readConfig',
    reason:
      'internal config-read primitive reused directly by most commands; config values are surfaced via repo.config',
  },
  { name: 'readHeadTree', reason: 'internal HEAD-tree primitive reused by status/rm' },
  {
    name: 'readReflog',
    reason:
      'internal reflog-store primitive reused by branch/reflog/rev-parse/fsck-roots/stash/snapshot-factory',
  },
  {
    name: 'readReflogLenient',
    reason:
      'internal reflog-store primitive reused by reflog/rev-parse/stash/snapshot-factory/fsck-roots',
  },
  {
    name: 'readShallow',
    reason: 'internal shallow-file primitive with no current Tier-1 consumer (write side only)',
  },
  {
    name: 'readSparsePatternText',
    reason: 'internal sparse-checkout primitive reused by the sparseCheckout command',
  },
  {
    name: 'reflogExists',
    reason:
      'internal reflog-store primitive with no current internal consumer — reflog/rev-parse route the same question through the backend-neutral listReflogs instead',
  },
  { name: 'resolveNotesRef', reason: 'internal notes-ref primitive reused by the notes command' },
  {
    name: 'resolveReflogIdentity',
    reason: 'internal reflog-identity primitive reused by stash',
  },
  {
    name: 'runInformationalHook',
    reason:
      'internal non-blocking hook variant reused by checkout/commit/merge/rebase; runHook is the bound sibling',
  },
  { name: 'signPayload', reason: 'internal signing primitive reused by internal/sign-request' },
  {
    name: 'synthesizeTreeFromIndex',
    reason: 'internal index-to-tree primitive reused by checkout/cherry-pick/revert/stash/rebase',
  },
  {
    name: 'updateConfigEntries',
    reason:
      'internal config-write primitive reused by clone; config writes are surfaced via repo.config',
  },
  {
    name: 'updateCoreConfig',
    reason: 'internal core-config-write primitive reused by sparseCheckout',
  },
  {
    name: 'updateShallow',
    reason: 'internal shallow-file-write primitive reused by clone/fetch',
  },
  {
    name: 'writeNotesTree',
    reason: 'internal notes-tree-write primitive reused by the notes command',
  },
  {
    name: 'writeReflog',
    reason:
      'internal reflog-store primitive with no current internal consumer — branch/reflog/stash route whole-reflog rewrites through applyRefUpdates(reflogReplace) instead',
  },
  {
    name: 'writeSparsePatternText',
    reason: 'internal sparse-checkout-write primitive reused by sparseCheckout',
  },
];

/**
 * A primitive is shaped `(ctx, …)` when its FIRST positional parameter is
 * literally named `ctx` — the same convention every bound Tier-2 primitive
 * follows. Reading the compiled function's own source text (rather than
 * hand-maintaining a signature list) keeps the audit self-verifying: it
 * reflects the actual runtime shape, not a copy that can drift from it.
 */
const isCtxFirstPrimitive = (value: unknown): boolean => {
  if (typeof value !== 'function') return false;
  const source = value.toString();
  const openParen = source.indexOf('(');
  if (openParen === -1) return false;
  const closeParen = source.indexOf(')', openParen);
  const params = source.slice(openParen + 1, closeParen === -1 ? undefined : closeParen);
  return params.split(',')[0]?.trim() === 'ctx';
};

const makeFallback = (): RuntimeFallback => ({
  fs: new MemoryFileSystem({ rootDir: '/repo' }),
  hash: new MemoryHashService('sha1'),
  compressor: new MemoryCompressor(),
  transport: new MemoryHttpTransport(),
  runtime: 'memory',
  layout: { workDir: '/repo', gitDir: '/repo/.git', bare: false, refStorage: 'files' },
  hashConfig: SHA1_CONFIG,
  deltaCache: createLruCache<Uint8Array>(1024),
});

describe('Given the primitives barrel and the repository primitives binding table', () => {
  describe('When every ctx-first barrel export is audited', () => {
    it('Then each is either bound on repo.primitives or explicitly excluded with a reason', async () => {
      // Arrange
      const sut = await openRepository({ cwd: '/repo' }, makeFallback());
      const boundNames = new Set(Object.keys(sut.primitives));
      const excludedNames = new Set(EXCLUDED_PRIMITIVES.map((entry) => entry.name));
      const ctxFirstNames = Object.entries(primitives)
        .filter(([, value]) => isCtxFirstPrimitive(value))
        .map(([name]) => name);

      // Act
      const unaccounted = ctxFirstNames.filter(
        (name) => !boundNames.has(name) && !excludedNames.has(name),
      );

      // Assert
      expect(unaccounted).toEqual([]);
    });

    it('Then every excluded name is a real barrel export that is NOT bound', async () => {
      // Arrange
      const sut = await openRepository({ cwd: '/repo' }, makeFallback());
      const boundNames = new Set(Object.keys(sut.primitives));
      const barrel = primitives as Record<string, unknown>;

      // Act
      const stale = EXCLUDED_PRIMITIVES.filter(
        (entry) => barrel[entry.name] === undefined || boundNames.has(entry.name),
      );

      // Assert
      expect(stale).toEqual([]);
    });

    it('Then every excluded entry carries a non-empty reason', () => {
      // Arrange
      const sut = EXCLUDED_PRIMITIVES;

      // Act
      const withoutReason = sut.filter((entry) => entry.reason.trim().length === 0);

      // Assert
      expect(withoutReason).toEqual([]);
    });
  });

  describe('When checking the flattenTree binding specifically', () => {
    it('Then flattenTree is bound on repo.primitives', async () => {
      // Arrange
      const sut = await openRepository({ cwd: '/repo' }, makeFallback());

      // Act
      const bound = Object.keys(sut.primitives);

      // Assert
      expect(bound).toContain('flattenTree');
    });
  });
});
