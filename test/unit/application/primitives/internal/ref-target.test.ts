import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { assertRefTargetValid } from '../../../../../src/application/primitives/internal/ref-target.js';
import { writeObject } from '../../../../../src/application/primitives/write-object.js';
import type { ObjectId, RefName } from '../../../../../src/domain/objects/index.js';
import { computeLooseObjectPath } from '../../../../../src/domain/storage/loose-path.js';
import { instrumentedContext } from '../fixtures.js';

const REMEMBERED_TARGETS = 4096;
const TAG_REF = 'refs/tags/verified' as RefName;
const ENCODER = new TextEncoder();

describe('assertRefTargetValid', () => {
  describe('Given more distinct blobs verified on one Context than it remembers', () => {
    describe('When the oldest and the newest are verified again', () => {
      it('Then only the oldest has been forgotten — its stored bytes are read again', async () => {
        // Arrange — ctx.deltaCache is disabled so this test isolates the
        // property it means to prove (`verifiedTargets`' own bounded memo
        // evicting its oldest entry) from openBlobSource's buffered arms,
        // which would otherwise keep every tiny blob content-cached forever
        // and mask the eviction behind a content-cache hit.
        const base = createMemoryContext({ deltaCacheMaxBytes: 0 });
        const ids: ObjectId[] = [];
        for (let index = 0; index <= REMEMBERED_TARGETS; index += 1) {
          const content = ENCODER.encode(`blob ${index}`);
          ids.push(await writeObject(base, { type: 'blob', id: '' as ObjectId, content }));
        }
        const { ctx, calls } = instrumentedContext(base);
        for (const id of ids) await assertRefTargetValid(ctx, TAG_REF, id);
        const oldest = ids[0] as ObjectId;
        const newest = ids[REMEMBERED_TARGETS] as ObjectId;
        const before = calls().length;
        const sut = assertRefTargetValid;

        // Act
        await sut(ctx, TAG_REF, oldest);
        await sut(ctx, TAG_REF, newest);

        // Assert
        const touchesOf = (id: ObjectId): readonly string[] => {
          const path = `${base.layout.gitDir}/objects/${computeLooseObjectPath(id)}`;
          return calls()
            .slice(before)
            .filter((call) => call.path === path && call.method !== 'exists')
            .map((call) => call.method);
        };
        expect(touchesOf(oldest).length).toBeGreaterThan(0);
        expect(touchesOf(newest)).toEqual([]);
      });
    });
  });
});
