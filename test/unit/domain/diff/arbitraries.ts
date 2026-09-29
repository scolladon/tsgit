import fc from 'fast-check';
import { primaryPath } from '../../../../src/domain/diff/change-path.js';
import type { AddChange, DiffChange, TreeDiff } from '../../../../src/domain/diff/diff-change.js';
import { sortByPath } from '../../../../src/domain/diff/path-compare.js';
import type { RenameSource, SourceOrigin } from '../../../../src/domain/diff/rename-pairing.js';
import type { LineKey, WhitespaceMode } from '../../../../src/domain/diff/whitespace.js';
import type {
  FileMode,
  FilePath,
  ObjectId,
  Tree,
  TreeEntry,
} from '../../../../src/domain/objects/index.js';
import { FILE_MODE } from '../../../../src/domain/objects/index.js';
import { treeEntry } from '../../../../src/domain/objects/tree.js';
import {
  arbObjectId,
  arbTreeEntryAnyMode,
  dedupeTreeEntriesByName,
} from '../objects/arbitraries.js';

const ALL_MODES: ReadonlyArray<WhitespaceMode> = ['all', 'change', 'at-eol', 'none'];

/** Every whitespace mode crossed with both CR-at-eol settings — the full key
 *  space every digest/normalizer property sweeps. */
export function arbLineKey(): fc.Arbitrary<LineKey> {
  return fc.record({
    mode: fc.constantFrom(...ALL_MODES),
    ignoreCrAtEol: fc.boolean(),
  });
}

export function arbBlobBytes(): fc.Arbitrary<Uint8Array> {
  return fc
    .array(fc.integer({ min: 0x20, max: 0x7e }), { minLength: 1, maxLength: 256 })
    .map((codes) => new Uint8Array(codes));
}

const NON_DIR_MODES: ReadonlyArray<FileMode> = [
  FILE_MODE.REGULAR,
  FILE_MODE.EXECUTABLE,
  FILE_MODE.SYMLINK,
  FILE_MODE.GITLINK,
];

export function arbNonDirMode(): fc.Arbitrary<FileMode> {
  return fc.constantFrom(...NON_DIR_MODES);
}

export function arbEntryName(): fc.Arbitrary<string> {
  return fc
    .array(fc.integer({ min: 0x61, max: 0x7a }), { minLength: 1, maxLength: 8 })
    .map((codes) => String.fromCharCode(...codes));
}

export function arbTreeEntry(): fc.Arbitrary<TreeEntry> {
  return fc
    .record({
      name: arbEntryName(),
      mode: arbNonDirMode(),
      id: arbObjectId(),
    })
    .map(({ mode, name, id }) => treeEntry(mode, name, id));
}

export function arbTree(): fc.Arbitrary<Tree> {
  return fc.array(arbTreeEntry(), { minLength: 0, maxLength: 12 }).map((rawEntries) => {
    const byName = new Map<string, TreeEntry>();
    for (const entry of rawEntries) {
      if (!byName.has(entry.name)) byName.set(entry.name, entry);
    }
    return {
      type: 'tree' as const,
      id: '0'.repeat(40) as ObjectId,
      entries: Array.from(byName.values()),
    };
  });
}

// Small pools force id and basename collisions, so the exact pass's one-shot,
// basename-preference and mode-rule branches are all reachable.
const EXACT_RENAME_IDS: ReadonlyArray<ObjectId> = ['a', 'b', 'c'].map(
  (c) => c.repeat(40) as ObjectId,
);
const EXACT_RENAME_KINDS: ReadonlyArray<'add' | 'delete' | 'modify'> = ['add', 'delete', 'modify'];
const EXACT_RENAME_PATHS: ReadonlyArray<FilePath> = ['', 'a/', 'b/'].flatMap((prefix) =>
  ['Foo.meta', 'Bar.meta', 'xFoo.meta'].map((name) => `${prefix}${name}` as FilePath),
);

interface RawExactRenameEntry {
  readonly kind: 'add' | 'delete' | 'modify';
  readonly path: FilePath;
  readonly id: ObjectId;
  readonly mode: FileMode;
}

function toDiffChange(entry: RawExactRenameEntry): DiffChange {
  if (entry.kind === 'add') {
    return { type: 'add', newPath: entry.path, newId: entry.id, newMode: entry.mode };
  }
  if (entry.kind === 'delete') {
    return { type: 'delete', oldPath: entry.path, oldId: entry.id, oldMode: entry.mode };
  }
  return {
    type: 'modify',
    path: entry.path,
    oldId: entry.id,
    newId: entry.id,
    oldMode: entry.mode,
    newMode: entry.mode,
  };
}

/** A raw tree diff (no rename/copy entries) whose adds/deletes collide on id
 *  and/or basename — the input shape `detectRenames` consumes. Paths are
 *  unique (a raw diff never repeats a path) and sorted like a real one. */
export function arbExactRenameDiff(
  pools: { readonly ids?: ReadonlyArray<ObjectId>; readonly modes?: ReadonlyArray<FileMode> } = {},
): fc.Arbitrary<TreeDiff> {
  return fc
    .uniqueArray(
      fc.record({
        kind: fc.constantFrom(...EXACT_RENAME_KINDS),
        path: fc.constantFrom(...EXACT_RENAME_PATHS),
        id: fc.constantFrom(...(pools.ids ?? EXACT_RENAME_IDS)),
        mode: fc.constantFrom(...(pools.modes ?? NON_DIR_MODES)),
      }),
      { selector: (entry) => entry.path, maxLength: EXACT_RENAME_PATHS.length },
    )
    .map((entries) => ({ changes: sortByPath(entries.map(toDiffChange), primaryPath) }));
}

// Unlike arbTree (deliberately non-directory, above), this family includes
// FILE_MODE.DIRECTORY so the virtual-slash ordering the raw cursor walk
// depends on is exercised by the differential property against diffTrees.
export function arbCanonicalTree(): fc.Arbitrary<Tree> {
  return fc.array(arbTreeEntryAnyMode(), { minLength: 0, maxLength: 12 }).map((rawEntries) => ({
    type: 'tree' as const,
    id: '0'.repeat(40) as ObjectId,
    entries: dedupeTreeEntriesByName(rawEntries),
  }));
}

// Small id/path pools force id and basename collisions between sources and
// destinations, so pairIdenticalFiles's scoring and use-count branches are reachable.
const PAIRING_IDS: ReadonlyArray<ObjectId> = ['a', 'b'].map((c) => c.repeat(40) as ObjectId);
const PAIRING_PATHS: ReadonlyArray<FilePath> = ['a/Foo', 'a/Bar', 'b/Foo', 'b/Bar'].map(
  (p) => p as FilePath,
);

// Every origin the design defines, paired with a seedUses value that origin can carry.
const PAIRING_SEEDS: ReadonlyArray<{ readonly origin: SourceOrigin; readonly seedUses: 0 | 1 }> = [
  { origin: 'deleted', seedUses: 0 },
  { origin: 'broken-delete', seedUses: 0 },
  { origin: 'broken-delete', seedUses: 1 },
  { origin: 'modified', seedUses: 1 },
  { origin: 'unchanged', seedUses: 1 },
];

function arbRenameSource(): fc.Arbitrary<RenameSource> {
  return fc
    .record({
      path: fc.constantFrom(...PAIRING_PATHS),
      id: fc.constantFrom(...PAIRING_IDS),
      mode: arbNonDirMode(),
      seed: fc.constantFrom(...PAIRING_SEEDS),
    })
    .map(({ path, id, mode, seed }) => ({ path, id, mode, ...seed }));
}

function arbPairingDestination(): fc.Arbitrary<AddChange> {
  return fc
    .record({
      newPath: fc.constantFrom(...PAIRING_PATHS),
      newId: fc.constantFrom(...PAIRING_IDS),
      newMode: arbNonDirMode(),
    })
    .map((change) => ({ type: 'add' as const, ...change }));
}

/** A small pool of sources (every origin/seed combination) and destinations —
 *  the input shape pairIdenticalFiles consumes. Kept well under the exact
 *  pass's candidate cap so every property exercises scoring, not the cap. */
export function arbSourcesAndDestinations(): fc.Arbitrary<{
  readonly sources: ReadonlyArray<RenameSource>;
  readonly destinations: ReadonlyArray<AddChange>;
}> {
  return fc.record({
    sources: fc.uniqueArray(arbRenameSource(), {
      selector: (source) => source.path,
      maxLength: PAIRING_PATHS.length,
    }),
    destinations: fc.uniqueArray(arbPairingDestination(), {
      selector: (destination) => destination.newPath,
      maxLength: PAIRING_PATHS.length,
    }),
  });
}
