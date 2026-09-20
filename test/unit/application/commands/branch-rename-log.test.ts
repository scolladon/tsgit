/**
 * What a rename leaves in the renamed branch's own log.
 *
 * The source's history moves across whole — through git's staging path on the
 * files backend, merged in place on the reftable one — and the rename entry
 * appended behind it is shaped per backend: one `<id> <id>` line for the
 * files backend, the delete-then-create pair `<id> 0{40}` / `0{40} <id>` for
 * reftable. A log with no live ref under it survives an unforced rename and
 * takes the entry as an append (all measured, git 2.55.0).
 */
import { describe, expect, it } from 'vitest';

import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { branchCreate, branchRename } from '../../../../src/application/commands/branch.js';
import { init } from '../../../../src/application/commands/init.js';
import { getRefStore } from '../../../../src/application/primitives/ref-store.js';
import { appendReflog, readReflog } from '../../../../src/application/primitives/reflog-store.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { writeSymbolicRef } from '../../../../src/application/primitives/write-symbolic-ref.js';
import type { AuthorIdentity, ObjectId, RefName } from '../../../../src/domain/objects/index.js';
import { zeroOid } from '../../../../src/domain/objects/index.js';
import type { ReflogEntry } from '../../../../src/domain/reflog/reflog-entry.js';
import type { Context } from '../../../../src/ports/context.js';
import { withReftableStorage } from '../primitives/reftable-fixtures.js';

const author: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const HEADS = 'refs/heads/';
const MAIN = 'refs/heads/main' as RefName;

interface Movement {
  readonly oldId: ObjectId;
  readonly newId: ObjectId;
  readonly message: string;
}

/** A reflog entry reduced to the movement it records — identity and timestamp
 *  belong to the appender, not to the rename's shape. */
const movement = (entry: ReflogEntry): Movement => ({
  oldId: entry.oldId,
  newId: entry.newId,
  message: entry.message,
});

const movementsOf = async (ctx: Context, name: RefName): Promise<ReadonlyArray<Movement>> =>
  (await readReflog(ctx, name)).map(movement);

const renameMessage = (from: string, to: string): string =>
  `Branch: renamed ${HEADS}${from} to ${HEADS}${to}`;

const seedRepository = async (refStorage: 'files' | 'reftable'): Promise<Context> => {
  const base = createMemoryContext();
  const ctx = refStorage === 'reftable' ? withReftableStorage(base) : base;
  await init(ctx);
  await writeSymbolicRef(ctx, 'HEAD' as RefName, MAIN);
  return ctx;
};

const seedCommit = async (ctx: Context): Promise<ObjectId> => {
  const tree = await writeObject(ctx, { type: 'tree', id: '' as ObjectId, entries: [] });
  const id = await writeObject(ctx, {
    type: 'commit',
    id: '' as ObjectId,
    data: { tree, parents: [], author, committer: author, message: 'seed', extraHeaders: [] },
  });
  await getRefStore(ctx).applyRefUpdates([{ kind: 'set', name: MAIN, id }]);
  return id;
};

/** The rename entries the renamed branch's log takes, per backend. */
const renameEntries = (
  refStorage: 'files' | 'reftable',
  id: ObjectId,
  zero: ObjectId,
  message: string,
): ReadonlyArray<Movement> =>
  refStorage === 'reftable'
    ? [
        { oldId: id, newId: zero, message },
        { oldId: zero, newId: id, message },
      ]
    : [{ oldId: id, newId: id, message }];

describe.each(['files', 'reftable'] as const)('branchRename — %s ref backend', (refStorage) => {
  describe('Given a branch renamed onto a name nested under it', () => {
    describe('When branchRename runs', () => {
      it('Then the destination log carries the source history and the backend rename entries', async () => {
        // Arrange
        const ctx = await seedRepository(refStorage);
        const id = await seedCommit(ctx);
        await branchCreate(ctx, { name: 'a', startPoint: 'main' });
        const before = await movementsOf(ctx, `${HEADS}a` as RefName);
        const sut = branchRename;

        // Act
        await sut(ctx, { from: 'a', to: 'a/b' });

        // Assert
        expect(before).toHaveLength(1);
        expect(await movementsOf(ctx, `${HEADS}a/b` as RefName)).toEqual([
          ...before,
          ...renameEntries(refStorage, id, zeroOid(ctx.hashConfig), renameMessage('a', 'a/b')),
        ]);
      });
    });
  });

  describe('Given a branch renamed onto the name it sits under', () => {
    describe('When branchRename runs', () => {
      it('Then the destination log carries the source history and the backend rename entries', async () => {
        // Arrange
        const ctx = await seedRepository(refStorage);
        const id = await seedCommit(ctx);
        await branchCreate(ctx, { name: 'c/d', startPoint: 'main' });
        const before = await movementsOf(ctx, `${HEADS}c/d` as RefName);
        const sut = branchRename;

        // Act
        await sut(ctx, { from: 'c/d', to: 'c' });

        // Assert
        expect(before).toHaveLength(1);
        expect(await movementsOf(ctx, `${HEADS}c` as RefName)).toEqual([
          ...before,
          ...renameEntries(refStorage, id, zeroOid(ctx.hashConfig), renameMessage('c/d', 'c')),
        ]);
      });
    });
  });
});

describe('branchRename — a destination log with no live ref under it', () => {
  describe('Given a forced rename onto a name only an orphan log occupies', () => {
    describe('When branchRename runs', () => {
      it('Then the orphan log survives and takes the rename entry as an append', async () => {
        // Arrange
        const ctx = await seedRepository('files');
        const id = await seedCommit(ctx);
        const orphan: ReflogEntry = {
          oldId: zeroOid(ctx.hashConfig),
          newId: id,
          identity: author,
          message: 'branch: Created from main',
        };
        await appendReflog(ctx, `${HEADS}dst` as RefName, orphan);
        await getRefStore(ctx).applyRefUpdates([
          { kind: 'set', name: `${HEADS}src` as RefName, id },
        ]);
        const sut = branchRename;

        // Act
        await sut(ctx, { from: 'src', to: 'dst', force: true });

        // Assert
        expect(await movementsOf(ctx, `${HEADS}dst` as RefName)).toEqual([
          movement(orphan),
          { oldId: id, newId: id, message: renameMessage('src', 'dst') },
        ]);
      });
    });
  });
});
