import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { findTreeEntry } from '../../../../../src/application/primitives/internal/resolve-tree-path.js';
import { readObject } from '../../../../../src/application/primitives/read-object.js';
import { writeObject } from '../../../../../src/application/primitives/write-object.js';
import { writeTree } from '../../../../../src/application/primitives/write-tree.js';
import { FILE_MODE } from '../../../../../src/domain/objects/file-mode.js';
import type { ObjectId, Tree, TreeEntry } from '../../../../../src/domain/objects/index.js';
import { treeEntry } from '../../../../../src/domain/objects/tree.js';
import type { Context } from '../../../../../src/ports/context.js';
import { buildSeededContext } from '../fixtures.js';
import {
  duplicateDirectoryArb,
  type TreePathShapeEntry,
  treePathArb,
  treePathShapeArb,
} from './arbitraries.js';

// ---------------------------------------------------------------------------
// Pre-rewrite oracle — `findTreeEntry`'s descent before this change's
// byte-cursor rewrite, copied verbatim: never re-implemented, never
// paraphrased, and never the production code under test. Descends through
// `readObject`'s fully-parsed `Tree` at every level, the way the production
// implementation did before this part.
//
// Still a faithful model of the production descent below: `TREE_PATH_NAME_POOL`
// (arbitraries.ts) holds only plain ASCII names with no `/`, and each level's
// names are drawn without replacement, so the round-trip property below never
// generates a byte-distinct-but-lossily-equal name pair, a duplicate name
// within one directory, or a literal entry name containing `/` — the three
// cases where a string-keyed `.find` and the production byte-cursor descent
// (first-wins, whole-remaining-path fallback) could disagree. Those cases are
// each covered by their own dedicated tests instead.
// ---------------------------------------------------------------------------
async function findTreeEntryOracle(
  ctx: Context,
  root: ObjectId | Tree,
  path: string,
): Promise<TreeEntry | undefined> {
  const segments = path.split('/');
  const lastIndex = segments.length - 1;
  let current: Tree = typeof root === 'string' ? await readTreeOracle(ctx, root) : root;
  for (let i = 0; i < lastIndex; i += 1) {
    const entry = findEntryOracle(current, segments[i] as string);
    if (entry === undefined) return undefined;
    const object = await readObject(ctx, entry.id);
    if (object.type !== 'tree') return undefined;
    current = object;
  }
  return findEntryOracle(current, segments[lastIndex] as string);
}

function findEntryOracle(tree: Tree, name: string): TreeEntry | undefined {
  return tree.entries.find((candidate) => candidate.name === name);
}

async function readTreeOracle(ctx: Context, id: ObjectId): Promise<Tree> {
  const object = await readObject(ctx, id);
  if (object.type !== 'tree') throw new Error('expected a tree root in this property');
  return object;
}

// ---------------------------------------------------------------------------
// Materialise a generated tree shape into real objects via the production
// writers (writeObject/writeTree).
// ---------------------------------------------------------------------------
async function materialize(
  ctx: Context,
  entries: ReadonlyArray<TreePathShapeEntry>,
): Promise<TreeEntry[]> {
  const out: TreeEntry[] = [];
  for (const entry of entries) {
    out.push(await materializeEntry(ctx, entry));
  }
  return out;
}

async function materializeEntry(ctx: Context, entry: TreePathShapeEntry): Promise<TreeEntry> {
  if (entry.kind === 'blob') {
    const id = await writeObject(ctx, {
      type: 'blob',
      content: new TextEncoder().encode(entry.content),
      id: '' as ObjectId,
    });
    return treeEntry(FILE_MODE.REGULAR, entry.name, id);
  }
  if (entry.kind === 'gitlink') {
    const id = await writeObject(ctx, {
      type: 'blob',
      content: new TextEncoder().encode(`gitlink:${entry.name}`),
      id: '' as ObjectId,
    });
    return treeEntry(FILE_MODE.GITLINK, entry.name, id);
  }
  if (entry.kind === 'symlink') {
    const id = await writeObject(ctx, {
      type: 'blob',
      content: new TextEncoder().encode(entry.target),
      id: '' as ObjectId,
    });
    return treeEntry(FILE_MODE.SYMLINK, entry.name, id);
  }
  const children = await materialize(ctx, entry.children);
  const id = await writeTree(ctx, children);
  return treeEntry(FILE_MODE.DIRECTORY, entry.name, id);
}

describe('findTreeEntry properties', () => {
  describe('Given an arbitrary tree grammar', () => {
    describe('When resolved by the byte-cursor descent', () => {
      it('Then it resolves exactly the paths the parsed-tree descent resolves', async () => {
        // Arrange + Act + Assert
        await fc.assert(
          fc.asyncProperty(
            treePathShapeArb().chain((shape) => fc.tuple(fc.constant(shape), treePathArb(shape))),
            async ([shape, path]) => {
              const ctx = await buildSeededContext();
              const rootEntries = await materialize(ctx, shape);
              const rootId = await writeTree(ctx, rootEntries);

              const production = await findTreeEntry(ctx, rootId, path);
              const oracle = await findTreeEntryOracle(ctx, rootId, path);

              expect(production).toEqual(oracle);
            },
          ),
          { numRuns: 100 },
        );
      });
    });
  });

  describe('Given a tree whose directory holds a duplicate entry name', () => {
    describe('When findTreeEntry scans that directory', () => {
      it('Then it always resolves the FIRST entry sharing the searched name', async () => {
        // Arrange + Act + Assert — a plain array `.find` over the same
        // entries, in the same on-disk (sorted, insertion-stable) order, is
        // the independent first-wins oracle: `writeTree`'s sort is a plain
        // `Array.prototype.sort`, stable since ES2019, so two entries
        // sharing a sort key (an exact duplicate name) keep the relative
        // order they were passed in.
        await fc.assert(
          fc.asyncProperty(
            duplicateDirectoryArb(),
            async ({ duplicateName, siblings, searchSegment }) => {
              const ctx = await buildSeededContext();
              const dupBlobIdA = await writeObject(ctx, {
                type: 'blob',
                content: new TextEncoder().encode('dup-a'),
                id: '' as ObjectId,
              });
              const dupBlobIdB = await writeObject(ctx, {
                type: 'blob',
                content: new TextEncoder().encode('dup-b'),
                id: '' as ObjectId,
              });
              const orderedEntries = [
                ...siblings.map((name) => ({ name, id: dupBlobIdA })),
                { name: duplicateName, id: dupBlobIdA },
                { name: duplicateName, id: dupBlobIdB },
              ];
              const dirId = await writeTree(
                ctx,
                orderedEntries.map(({ name, id }) => treeEntry(FILE_MODE.REGULAR, name, id)),
              );
              const rootId = await writeTree(ctx, [treeEntry(FILE_MODE.DIRECTORY, 'dir', dirId)]);
              const expected = orderedEntries.find((candidate) => candidate.name === searchSegment);

              const result = await findTreeEntry(ctx, rootId, `dir/${searchSegment}`);

              expect(result?.id).toBe(expected?.id);
            },
          ),
          { numRuns: 100 },
        );
      });
    });
  });
});
