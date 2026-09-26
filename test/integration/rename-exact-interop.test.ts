/**
 * Cross-tool interop — the exact rename pass (`detectRenames`) against real
 * `git diff -M`/`diff-tree -M`.
 *
 * Builds one throwaway repo per row (before/after commit pair) and compares
 * tsgit's structured `TreeDiff`, reconstructed as a `--name-status` line, to
 * live git byte-for-byte: one-shot source consumption, basename preference,
 * the exec-bit/mode rule, the 100-candidate cap, and limit-freedom.
 *
 * @proves
 *   surface:        diff.renames
 *   bucket:         cross-tool-interop
 *   unique:         exact rename pairing (one-shot source, basename preference, mode rule, 100-candidate cap, limit-free) matches git diff --name-status
 *   interopSurface: diff
 */
import { rm } from 'node:fs/promises';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GIT_AVAILABLE } from './interop-helpers.js';
import { buildRenameRow, manyFiles, type RenameRow, runRenameRow } from './rename-interop-rows.js';

// ~20 throwaway repos, each spawning several git processes — the shared type
// change interop suite needs the same headroom under the full validate run's
// parallel git load.
const SETUP_TIMEOUT = 120_000;
const DEFAULT_CONTENT = 'x\n';
const TMP_PREFIX = 'tsgit-rename-exact-';
const GITLINK_OID = '1'.repeat(40);
const GITLINK_OID_2 = '2'.repeat(40);

const ROWS: ReadonlyArray<RenameRow> = [
  {
    label: '1 source, 2 identical adds — first in path order folds (R Foo→Bar ; A Baz)',
    before: [{ path: 'a/Foo.meta', content: DEFAULT_CONTENT }],
    after: [
      { path: 'b/Bar.meta', content: DEFAULT_CONTENT },
      { path: 'b/Baz.meta', content: DEFAULT_CONTENT },
    ],
  },
  {
    label: 'basename-matching add processed second — path order still wins (R Foo→Bar ; A b/Foo)',
    before: [{ path: 'a/Foo.meta', content: DEFAULT_CONTENT }],
    after: [
      { path: 'b/Bar.meta', content: DEFAULT_CONTENT },
      { path: 'b/Foo.meta', content: DEFAULT_CONTENT },
    ],
  },
  {
    label:
      '2 sources sharing an id, no basename match — first in path order folds (D Qux ; R Foo→Bar)',
    before: [
      { path: 'a/Foo.meta', content: DEFAULT_CONTENT },
      { path: 'a/Qux.meta', content: DEFAULT_CONTENT },
    ],
    after: [{ path: 'b/Bar.meta', content: DEFAULT_CONTENT }],
  },
  {
    label: '2 sources sharing an id, basename = second delete (D Foo ; R Qux→Qux)',
    before: [
      { path: 'a/Foo.meta', content: DEFAULT_CONTENT },
      { path: 'a/Qux.meta', content: DEFAULT_CONTENT },
    ],
    after: [{ path: 'b/Qux.meta', content: DEFAULT_CONTENT }],
  },
  {
    label: '2 sources, 2 adds, no basename overlap (R Foo→Bar ; R Qux→Baz)',
    before: [
      { path: 'a/Foo.meta', content: DEFAULT_CONTENT },
      { path: 'a/Qux.meta', content: DEFAULT_CONTENT },
    ],
    after: [
      { path: 'b/Bar.meta', content: DEFAULT_CONTENT },
      { path: 'b/Baz.meta', content: DEFAULT_CONTENT },
    ],
  },
  {
    label: '1 source, 3 identical adds — first in path order folds (R Foo→A ; A B ; A C)',
    before: [{ path: 'a/Foo.meta', content: DEFAULT_CONTENT }],
    after: [
      { path: 'b/A.meta', content: DEFAULT_CONTENT },
      { path: 'b/B.meta', content: DEFAULT_CONTENT },
      { path: 'b/C.meta', content: DEFAULT_CONTENT },
    ],
  },
  {
    label: '2 sources, 2 adds, basename preference per add (R Qux→Qux ; R Foo→Zed)',
    before: [
      { path: 'a/Foo.meta', content: DEFAULT_CONTENT },
      { path: 'a/Qux.meta', content: DEFAULT_CONTENT },
    ],
    after: [
      { path: 'b/Qux.meta', content: DEFAULT_CONTENT },
      { path: 'b/Zed.meta', content: DEFAULT_CONTENT },
    ],
  },
  {
    label:
      '2 sources sharing an id with rename limit 1 — exact pairing unaffected (D Qux ; R Foo→Bar)',
    before: [
      { path: 'a/Foo.meta', content: DEFAULT_CONTENT },
      { path: 'a/Qux.meta', content: DEFAULT_CONTENT },
    ],
    after: [{ path: 'b/Bar.meta', content: DEFAULT_CONTENT }],
    gitFlags: ['-l1'],
    renameOptions: { limit: 1 },
  },
  {
    label:
      'symlink source pairs with the symlink add, not the mode-incompatible regular add (A b/file ; R link→link2)',
    before: [{ path: 'a/link', content: 'target', kind: 'symlink' }],
    after: [
      { path: 'b/file', content: 'target' },
      { path: 'b/link2', content: 'target', kind: 'symlink' },
    ],
  },
  {
    label: 'regular source pairs across the executable bit (R Foo→Bar ; A Baz)',
    before: [{ path: 'a/Foo.sh', content: DEFAULT_CONTENT }],
    after: [
      { path: 'b/Bar.sh', content: DEFAULT_CONTENT, kind: 'exec' },
      { path: 'b/Baz.sh', content: DEFAULT_CONTENT },
    ],
  },
  {
    label: 'empty blob — 1 source, 2 adds (R Foo→Bar ; A Baz)',
    before: [{ path: 'a/Foo.meta', content: '' }],
    after: [
      { path: 'b/Bar.meta', content: '' },
      { path: 'b/Baz.meta', content: '' },
    ],
  },
  {
    label:
      '101 sources sharing an id, no basename match — cap holds the first (R F001→Bar + 100 D)',
    before: manyFiles(101),
    after: [{ path: 'b/Bar.meta', content: DEFAULT_CONTENT }],
  },
  {
    label:
      '101 sources + a basename match as the 102nd eligible — cap hides it (R F001→Zzz + D Zzz)',
    before: [...manyFiles(101), { path: 'a/Zzz.meta', content: DEFAULT_CONTENT }],
    after: [{ path: 'b/Zzz.meta', content: DEFAULT_CONTENT }],
  },
  {
    label:
      '99 sources + a basename match as the 100th eligible — the cap is not yet reached (R Zzz→Zzz)',
    before: [...manyFiles(99), { path: 'a/Zzz.meta', content: DEFAULT_CONTENT }],
    after: [{ path: 'b/Zzz.meta', content: DEFAULT_CONTENT }],
  },
  {
    label: '100 sources + a basename match as the 101st eligible — cap hides it (R F001→Zzz)',
    before: [...manyFiles(100), { path: 'a/Zzz.meta', content: DEFAULT_CONTENT }],
    after: [{ path: 'b/Zzz.meta', content: DEFAULT_CONTENT }],
  },
  {
    label:
      '101 sources sharing an id with rename limit 1 — exact pairing unaffected (R F001→Bar + 100 D)',
    before: manyFiles(101),
    after: [{ path: 'b/Bar.meta', content: DEFAULT_CONTENT }],
    gitFlags: ['-l1'],
    renameOptions: { limit: 1 },
  },
  {
    label: '3 sources sharing an id, basename = third delete (D Foo ; D Qux ; R Zed→Zed)',
    before: [
      { path: 'a/Foo.meta', content: DEFAULT_CONTENT },
      { path: 'a/Qux.meta', content: DEFAULT_CONTENT },
      { path: 'a/Zed.meta', content: DEFAULT_CONTENT },
    ],
    after: [{ path: 'b/Zed.meta', content: DEFAULT_CONTENT }],
  },
  {
    label:
      'directory rename + copy, diff-tree non-recursive — tree entries pair by id (R x→y ; A z)',
    before: [
      { path: 'x/f', content: 'l1\n' },
      { path: 'x/g', content: 'l2\n' },
    ],
    after: [
      { path: 'y/f', content: 'l1\n' },
      { path: 'y/g', content: 'l2\n' },
      { path: 'z/f', content: 'l1\n' },
      { path: 'z/g', content: 'l2\n' },
    ],
    recursive: false,
    gitCommand: 'diff-tree',
  },
  {
    label:
      'directory rename + copy, recursive — every leaf pairs by id (R x/f→y/f ; R x/g→y/g ; A z/f ; A z/g)',
    before: [
      { path: 'x/f', content: 'l1\n' },
      { path: 'x/g', content: 'l2\n' },
    ],
    after: [
      { path: 'y/f', content: 'l1\n' },
      { path: 'y/g', content: 'l2\n' },
      { path: 'z/f', content: 'l1\n' },
      { path: 'z/g', content: 'l2\n' },
    ],
    recursive: true,
  },
  {
    label: 'gitlink source and gitlink add sharing an oid — exact pair (R sub→sub)',
    before: [{ path: 'a/sub', content: GITLINK_OID, kind: 'gitlink' }],
    after: [{ path: 'b/sub', content: GITLINK_OID, kind: 'gitlink' }],
  },
  {
    label: 'rename detection off — identical delete and add stay unpaired (D Foo ; A Bar)',
    before: [{ path: 'a/Foo.meta', content: DEFAULT_CONTENT }],
    after: [{ path: 'b/Bar.meta', content: DEFAULT_CONTENT }],
    detectRenames: false,
  },
  {
    label: '-C: 1 delete, 2 identical adds — copy then rename by use count (C Foo→Bar ; R Foo→Baz)',
    before: [{ path: 'a/Foo.meta', content: DEFAULT_CONTENT }],
    after: [
      { path: 'b/Bar.meta', content: DEFAULT_CONTENT },
      { path: 'b/Baz.meta', content: DEFAULT_CONTENT },
    ],
    gitFlags: ['-C'],
    renameOptions: { copies: 'on' },
  },
  {
    label: '-C -C: same as -C — 1 delete, 2 identical adds (C Foo→Bar ; R Foo→Baz)',
    before: [{ path: 'a/Foo.meta', content: DEFAULT_CONTENT }],
    after: [
      { path: 'b/Bar.meta', content: DEFAULT_CONTENT },
      { path: 'b/Baz.meta', content: DEFAULT_CONTENT },
    ],
    gitFlags: ['-C', '-C'],
    renameOptions: { copies: 'harder' },
  },
  {
    label:
      '-C: 1 delete, 3 identical adds — 2 copies then a rename, last in path order (C ; C ; R)',
    before: [{ path: 'a/Foo.meta', content: DEFAULT_CONTENT }],
    after: [
      { path: 'b/A.meta', content: DEFAULT_CONTENT },
      { path: 'b/B.meta', content: DEFAULT_CONTENT },
      { path: 'b/C.meta', content: DEFAULT_CONTENT },
    ],
    gitFlags: ['-C'],
    renameOptions: { copies: 'on' },
  },
  {
    label:
      '-C: 2 identical deletes, 3 identical adds — a delete can supply both a copy and a rename (C Foo→A ; R Qux→B ; R Foo→C)',
    before: [
      { path: 'a/Foo.meta', content: DEFAULT_CONTENT },
      { path: 'a/Qux.meta', content: DEFAULT_CONTENT },
    ],
    after: [
      { path: 'b/A.meta', content: DEFAULT_CONTENT },
      { path: 'b/B.meta', content: DEFAULT_CONTENT },
      { path: 'b/C.meta', content: DEFAULT_CONTENT },
    ],
    gitFlags: ['-C'],
    renameOptions: { copies: 'on' },
  },
  {
    label:
      '-C: a modified preimage (first in path order) beats a same-content delete for the one identical add (M ; C100 a/Bar→c/Bar ; D z/Aaa)',
    before: [
      { path: 'a/Bar', content: DEFAULT_CONTENT },
      { path: 'z/Aaa', content: DEFAULT_CONTENT },
    ],
    after: [
      { path: 'a/Bar', content: 'x-edited\n' },
      { path: 'c/Bar', content: DEFAULT_CONTENT },
    ],
    gitFlags: ['-C'],
    renameOptions: { copies: 'on' },
  },
  {
    label:
      '-C -C: an unchanged preimage (first in path order) beats a same-content delete for the one identical add (C100 a/Bar→c/Bar ; M k ; D z/Aaa)',
    before: [
      { path: 'a/Bar', content: DEFAULT_CONTENT },
      { path: 'k', content: 'k1\n' },
      { path: 'z/Aaa', content: DEFAULT_CONTENT },
    ],
    after: [
      { path: 'a/Bar', content: DEFAULT_CONTENT },
      { path: 'k', content: 'k2\n' },
      { path: 'c/Bar', content: DEFAULT_CONTENT },
    ],
    gitFlags: ['-C', '-C'],
    renameOptions: { copies: 'harder' },
  },
  {
    label: '-C -l1: 1 delete, 2 identical adds — the exact copy fan-out is never limited (C ; R)',
    before: [{ path: 'a/Foo.meta', content: DEFAULT_CONTENT }],
    after: [
      { path: 'b/Bar.meta', content: DEFAULT_CONTENT },
      { path: 'b/Baz.meta', content: DEFAULT_CONTENT },
    ],
    gitFlags: ['-C', '-l1'],
    renameOptions: { copies: 'on', limit: 1 },
  },
  {
    label:
      '-C -C -l1: an unchanged exact source pairs regardless of the tiny inexact limit (C100 a/Bar→c/Bar ; M k)',
    before: [
      { path: 'a/Bar', content: DEFAULT_CONTENT },
      { path: 'k', content: 'k1\n' },
    ],
    after: [
      { path: 'a/Bar', content: DEFAULT_CONTENT },
      { path: 'k', content: 'k2\n' },
      { path: 'c/Bar', content: DEFAULT_CONTENT },
    ],
    gitFlags: ['-C', '-C', '-l1'],
    renameOptions: { copies: 'harder', limit: 1 },
  },
  {
    label:
      '-C: a modified gitlink preimage exact-copies to an added gitlink with the old oid (M a/sub ; C100 a/sub→b/sub2)',
    before: [{ path: 'a/sub', content: GITLINK_OID, kind: 'gitlink' }],
    after: [
      { path: 'a/sub', content: GITLINK_OID_2, kind: 'gitlink' },
      { path: 'b/sub2', content: GITLINK_OID, kind: 'gitlink' },
    ],
    gitFlags: ['-C'],
    renameOptions: { copies: 'on' },
  },
  {
    label:
      '-C -C: an unchanged gitlink exact-copies to an added gitlink with the same oid (C100 a/sub→b/sub2 ; M k)',
    before: [
      { path: 'a/sub', content: GITLINK_OID, kind: 'gitlink' },
      { path: 'k', content: 'k1\n' },
    ],
    after: [
      { path: 'a/sub', content: GITLINK_OID, kind: 'gitlink' },
      { path: 'k', content: 'k2\n' },
      { path: 'b/sub2', content: GITLINK_OID, kind: 'gitlink' },
    ],
    gitFlags: ['-C', '-C'],
    renameOptions: { copies: 'harder' },
  },
];

const fixtures = new Map<string, { readonly dir: string }>();

function fixtureOf(label: string): { readonly dir: string } {
  const found = fixtures.get(label);
  if (found === undefined) throw new Error(`fixture not built for row: ${label}`);
  return found;
}

describe.skipIf(!GIT_AVAILABLE)('exact rename pass interop', () => {
  beforeAll(async () => {
    for (const row of ROWS) {
      fixtures.set(row.label, await buildRenameRow(row, TMP_PREFIX));
    }
  }, SETUP_TIMEOUT);

  afterAll(async () => {
    for (const { dir } of fixtures.values()) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  describe('Given a raw diff pair exercising the exact rename pass', () => {
    describe('When diff is called with detectRenames', () => {
      it.each(ROWS)('Then name-status matches live git for: $label', async (row) => {
        // Arrange
        const { dir } = fixtureOf(row.label);

        // Act
        const { ours, peer } = await runRenameRow(row, dir);

        // Assert
        expect(ours).toBe(peer);
      });
    });
  });
});
