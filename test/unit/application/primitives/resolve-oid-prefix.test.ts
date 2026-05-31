import { describe, expect, it } from 'vitest';
import {
  MAX_OID_PREFIX_CANDIDATES,
  resolveOidPrefix,
} from '../../../../src/application/primitives/resolve-oid-prefix.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { TsgitError } from '../../../../src/domain/error.js';
import type { Blob, ObjectId } from '../../../../src/domain/objects/index.js';
import { buildSeededContext, instrumentedContext } from './fixtures.js';
import { writeSyntheticPack } from './pack-fixture.js';

const blobOf = (content: Uint8Array): Blob => ({ type: 'blob', id: '' as ObjectId, content });

/** Write a controlled loose object file (name-based scan does not parse content). */
const writeLooseNamed = async (
  ctx: Awaited<ReturnType<typeof buildSeededContext>>,
  oid: string,
): Promise<void> => {
  const path = `${ctx.layout.gitDir}/objects/${oid.slice(0, 2)}/${oid.slice(2)}`;
  await ctx.fs.write(path, new Uint8Array([1]));
};

describe('resolveOidPrefix', () => {
  describe('Given a full 40-hex oid', () => {
    describe('When resolveOidPrefix is called', () => {
      it('Then returns it verbatim without scanning the object store', async () => {
        // Arrange
        const base = await buildSeededContext();
        const wrapped = instrumentedContext(base);
        const full = 'a'.repeat(40);

        // Act
        const sut = await resolveOidPrefix(wrapped.ctx, full);

        // Assert
        expect(sut).toBe(full);
        expect(wrapped.calls().filter((c) => c.method === 'readdir')).toEqual([]);
      });
    });
  });

  describe('Given a unique loose object matching the prefix', () => {
    describe('When resolveOidPrefix is called with a 7-char prefix', () => {
      it('Then returns the full object id', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const id = await writeObject(ctx, blobOf(new Uint8Array([0xca, 0xfe])));

        // Act
        const sut = await resolveOidPrefix(ctx, id.slice(0, 7));

        // Assert
        expect(sut).toBe(id);
      });
    });
  });

  describe('Given a unique packed object matching the prefix', () => {
    describe('When resolveOidPrefix is called', () => {
      it('Then returns the full object id from the pack index', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const [id] = await writeSyntheticPack(ctx, 'p1', [
          { kind: 'base', type: 'blob', content: new Uint8Array([7, 7, 7]) },
        ]);

        // Act
        const sut = await resolveOidPrefix(ctx, (id as string).slice(0, 8));

        // Assert
        expect(sut).toBe(id);
      });
    });
  });

  describe('Given the same oid present both loose and packed', () => {
    describe('When resolveOidPrefix is called', () => {
      it('Then de-duplicates and resolves uniquely', async () => {
        // Arrange — pack a blob, then also drop it loose under the same id
        const ctx = await buildSeededContext();
        const [id] = await writeSyntheticPack(ctx, 'p1', [
          { kind: 'base', type: 'blob', content: new Uint8Array([9, 9]) },
        ]);
        await writeLooseNamed(ctx, id as string);

        // Act
        const sut = await resolveOidPrefix(ctx, (id as string).slice(0, 10));

        // Assert
        expect(sut).toBe(id);
      });
    });
  });

  describe('Given no object matches the prefix', () => {
    describe('When resolveOidPrefix is called', () => {
      it('Then returns undefined', async () => {
        // Arrange
        const ctx = await buildSeededContext();

        // Act
        const sut = await resolveOidPrefix(ctx, 'deadbeef');

        // Assert
        expect(sut).toBeUndefined();
      });
    });
  });

  describe('Given two loose objects sharing the queried prefix', () => {
    describe('When resolveOidPrefix is called', () => {
      it('Then throws AMBIGUOUS_OID_PREFIX carrying both candidates', async () => {
        // Arrange — both oids start abcdef
        const ctx = await buildSeededContext();
        const a = `abcdef${'0'.repeat(34)}`;
        const b = `abcdef${'1'.repeat(34)}`;
        await writeLooseNamed(ctx, a);
        await writeLooseNamed(ctx, b);

        // Act
        let caught: TsgitError | undefined;
        try {
          await resolveOidPrefix(ctx, 'abcdef');
        } catch (err) {
          caught = err as TsgitError;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect(caught?.data.code).toBe('AMBIGUOUS_OID_PREFIX');
        if (caught?.data.code === 'AMBIGUOUS_OID_PREFIX') {
          expect(caught.data.prefix).toBe('abcdef');
          expect([...caught.data.candidates].sort()).toEqual([a, b]);
        }
      });
    });
  });

  describe('Given more matches than the candidate cap', () => {
    describe('When resolveOidPrefix is called', () => {
      it('Then the thrown candidate list is capped', async () => {
        // Arrange — MAX+2 loose objects sharing prefix 'abcd'
        const ctx = await buildSeededContext();
        const count = MAX_OID_PREFIX_CANDIDATES + 2;
        for (let i = 0; i < count; i += 1) {
          await writeLooseNamed(ctx, `abcd${i.toString().padStart(36, '0')}`);
        }

        // Act
        let caught: TsgitError | undefined;
        try {
          await resolveOidPrefix(ctx, 'abcd');
        } catch (err) {
          caught = err as TsgitError;
        }

        // Assert
        expect(caught?.data.code).toBe('AMBIGUOUS_OID_PREFIX');
        if (caught?.data.code === 'AMBIGUOUS_OID_PREFIX') {
          expect(caught.data.candidates.length).toBe(MAX_OID_PREFIX_CANDIDATES);
        }
      });
    });
  });

  describe('Given a loose dir entry that is not a valid 38-hex object name', () => {
    describe('When resolveOidPrefix is called', () => {
      it('Then the entry is ignored', async () => {
        // Arrange — a real object plus a junk tmp file in the same fanout dir
        const ctx = await buildSeededContext();
        const id = await writeObject(ctx, blobOf(new Uint8Array([0x42])));
        await ctx.fs.write(
          `${ctx.layout.gitDir}/objects/${id.slice(0, 2)}/tmp_obj_garbage`,
          new Uint8Array([0]),
        );

        // Act
        const sut = await resolveOidPrefix(ctx, id.slice(0, 7));

        // Assert
        expect(sut).toBe(id);
      });
    });
  });

  describe('Given a directory entry whose name looks like an object suffix', () => {
    describe('When resolveOidPrefix is called', () => {
      it('Then the non-file entry is ignored', async () => {
        // Arrange — a real object plus a subdirectory named like a 38-hex suffix
        const ctx = await buildSeededContext();
        const id = await writeObject(ctx, blobOf(new Uint8Array([0x55])));
        // Writing into the would-be entry creates it as a directory, not a file.
        await ctx.fs.write(
          `${ctx.layout.gitDir}/objects/${id.slice(0, 2)}/${'b'.repeat(38)}/child`,
          new Uint8Array([0]),
        );

        // Act
        const sut = await resolveOidPrefix(ctx, id.slice(0, 7));

        // Assert
        expect(sut).toBe(id);
      });
    });
  });

  describe.each([
    ['too short (3 chars)', 'abc'],
    ['too long (41 chars)', `${'a'.repeat(41)}`],
    ['non-hex', 'zzzz'],
  ])('Given a prefix that is %s', (_label, prefix) => {
    describe('When resolveOidPrefix is called', () => {
      it('Then returns undefined (not a resolvable oid prefix)', async () => {
        // Arrange
        const ctx = await buildSeededContext();

        // Act
        const sut = await resolveOidPrefix(ctx, prefix);

        // Assert
        expect(sut).toBeUndefined();
      });
    });
  });
});
