import { describe, expect, it } from 'vitest';
import { resolveRebaseReplay } from '../../../../../src/application/commands/internal/rebase-replay.js';
import { createCommit } from '../../../../../src/application/primitives/create-commit.js';
import { writeObject } from '../../../../../src/application/primitives/write-object.js';
import { writeTree } from '../../../../../src/application/primitives/write-tree.js';
import { FILE_MODE } from '../../../../../src/domain/objects/file-mode.js';
import type { AuthorIdentity, Blob, ObjectId } from '../../../../../src/domain/objects/index.js';
import { treeEntry } from '../../../../../src/domain/objects/tree.js';
import type { Context } from '../../../../../src/ports/context.js';
import { buildSeededContext } from '../../primitives/fixtures.js';

const EPOCH = 1_700_000_000;
const AUTHOR: AuthorIdentity = {
  name: 'Alice',
  email: 'a@a.com',
  timestamp: EPOCH,
  timezoneOffset: '+0000',
};

/**
 * `[name, committer-date offset, parent names, file]`, parents declared first.
 * Each commit adds `file` (its own name unless given) to the union of its
 * parents' files, so two commits adding the same file carry the same patch.
 */
type Spec = ReadonlyArray<
  readonly [name: string, offset: number, parents: ReadonlyArray<string>, file?: string]
>;

interface History {
  readonly ctx: Context;
  readonly id: (name: string) => ObjectId;
  readonly names: (ids: ReadonlyArray<ObjectId>) => ReadonlyArray<string>;
}

const blobOf = (ctx: Context, file: string): Promise<ObjectId> => {
  const blob: Blob = {
    type: 'blob',
    content: new TextEncoder().encode(`${file}\n`),
    id: '' as ObjectId,
  };
  return writeObject(ctx, blob);
};

const buildHistory = async (spec: Spec): Promise<History> => {
  const ctx = await buildSeededContext();
  const ids = new Map<string, ObjectId>();
  const files = new Map<string, ReadonlySet<string>>();
  const id = (name: string): ObjectId => ids.get(name) as ObjectId;
  for (const [name, offset, parents, file = name] of spec) {
    const own = new Set([file, ...parents.flatMap((parent) => [...(files.get(parent) ?? [])])]);
    files.set(name, own);
    const entries = await Promise.all(
      [...own]
        .sort()
        .map(async (path) => treeEntry(FILE_MODE.REGULAR, path, await blobOf(ctx, path))),
    );
    const when = { ...AUTHOR, timestamp: EPOCH + offset };
    const commit = await createCommit(ctx, {
      tree: await writeTree(ctx, entries),
      parents: parents.map(id),
      author: when,
      committer: when,
      message: name,
    });
    ids.set(name, commit);
  }
  const byId = new Map([...ids].map(([key, value]) => [value, key]));
  return { ctx, id, names: (oids) => oids.map((oid) => byId.get(oid) as string) };
};

describe('resolveRebaseReplay', () => {
  describe.each([
    {
      label: 'a merge on the rebased side',
      spec: [
        ['root', 100, []],
        ['u1', 900, ['root']],
        ['f1', 200, ['root']],
        ['s1', 300, ['root']],
        ['s2', 350, ['s1']],
        ['fm', 400, ['f1', 's2']],
        ['f2', 500, ['fm']],
      ],
      upstream: 'u1',
      head: 'f2',
      replayed: ['f1', 's1', 's2', 'f2'],
    },
    {
      label: 'equal dates around a merge',
      spec: [
        ['root', 100, []],
        ['u1', 900, ['root']],
        ['t1', 300, ['root']],
        ['t2', 300, ['root']],
        ['tm', 300, ['t1', 't2']],
        ['t3', 300, ['tm']],
      ],
      upstream: 'u1',
      head: 't3',
      replayed: ['t1', 't2', 't3'],
    },
    {
      label: 'a clock-skewed rebased line',
      spec: [
        ['root', 100, []],
        ['u1', 900, ['root']],
        ['g1', 600, ['root']],
        ['g2', 250, ['g1']],
        ['g3', 700, ['g2']],
      ],
      upstream: 'u1',
      head: 'g3',
      replayed: ['g1', 'g2', 'g3'],
    },
    {
      label: 'a commit whose patch the upstream already carries',
      spec: [
        ['root', 100, []],
        ['u1', 200, ['root'], 'same'],
        ['u2', 300, ['u1']],
        ['h1', 250, ['root'], 'same'],
        ['h2', 400, ['h1']],
      ],
      upstream: 'u2',
      head: 'h2',
      replayed: ['h2'],
    },
    {
      label: 'unrelated histories',
      spec: [
        ['u1', 100, []],
        ['h1', 200, []],
        ['h2', 300, ['h1']],
      ],
      upstream: 'u1',
      head: 'h2',
      replayed: ['h1', 'h2'],
    },
  ] as const)('Given $label', ({ spec, upstream, head, replayed }) => {
    describe('When the rebase resolves the commits to replay', () => {
      it(`Then it replays ${replayed.join(', ')}`, async () => {
        // Arrange
        const history = await buildHistory(spec);
        const sut = resolveRebaseReplay;

        // Act
        const result = await sut(history.ctx, {
          upstream: history.id(upstream),
          head: history.id(head),
        });

        // Assert
        expect(history.names(result)).toEqual(replayed);
      });
    });
  });
});
