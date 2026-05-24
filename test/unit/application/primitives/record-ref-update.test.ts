import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { __resetConfigCacheForTests } from '../../../../src/application/primitives/config-read.js';
import { recordRefUpdate } from '../../../../src/application/primitives/record-ref-update.js';
import { readReflog, reflogExists } from '../../../../src/application/primitives/reflog-store.js';
import type { ObjectId, RefName } from '../../../../src/domain/objects/index.js';
import { ZERO_OID } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';

const OID_A = 'a'.repeat(40) as ObjectId;
const OID_B = 'b'.repeat(40) as ObjectId;
const BRANCH = 'refs/heads/main' as RefName;
const TAG = 'refs/tags/v1.0.0' as RefName;

const seedConfig = async (ctx: Context, content: string): Promise<void> => {
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, content);
};

describe('recordRefUpdate', () => {
  beforeEach(() => {
    __resetConfigCacheForTests();
  });

  afterEach(() => {
    __resetConfigCacheForTests();
  });

  describe('gate open', () => {
    describe('Given a default-loggable branch ref', () => {
      describe('When recordRefUpdate', () => {
        it('Then an entry is appended', async () => {
          // Arrange
          const ctx = createMemoryContext();

          // Act
          await recordRefUpdate(ctx, BRANCH, ZERO_OID, OID_A, 'commit (initial): seed');

          // Assert
          const entries = await readReflog(ctx, BRANCH);
          expect(entries).toHaveLength(1);
          expect(entries[0]?.oldId).toBe(ZERO_OID);
          expect(entries[0]?.newId).toBe(OID_A);
          expect(entries[0]?.message).toBe('commit (initial): seed');
        });
      });
    });

    describe('Given a default-loggable ref', () => {
      describe('When recordRefUpdate', () => {
        it('Then the entry carries the resolved identity', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedConfig(ctx, '[user]\n  name = Ada\n  email = ada@example.com\n');

          // Act
          await recordRefUpdate(ctx, BRANCH, ZERO_OID, OID_A, 'commit: x');

          // Assert
          const entries = await readReflog(ctx, BRANCH);
          expect(entries[0]?.identity.name).toBe('Ada');
          expect(entries[0]?.identity.email).toBe('ada@example.com');
        });
      });
    });
  });

  describe('gate closed', () => {
    describe('Given a tag ref under default config', () => {
      describe('When recordRefUpdate', () => {
        it('Then no reflog is written', async () => {
          // Arrange
          const ctx = createMemoryContext();

          // Act
          await recordRefUpdate(ctx, TAG, ZERO_OID, OID_A, 'tag: v1.0.0');

          // Assert
          expect(await reflogExists(ctx, TAG)).toBe(false);
        });
      });
    });

    describe('Given logAllRefUpdates=false', () => {
      describe('When recordRefUpdate on a branch', () => {
        it('Then no reflog is written', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedConfig(ctx, '[core]\n  logallrefupdates = false\n');

          // Act
          await recordRefUpdate(ctx, BRANCH, ZERO_OID, OID_A, 'commit: x');

          // Assert
          expect(await reflogExists(ctx, BRANCH)).toBe(false);
        });
      });
    });
  });

  describe('existing-log arm', () => {
    describe('Given an existing tag reflog', () => {
      describe('When recordRefUpdate on that tag', () => {
        it('Then it appends despite the non-default prefix', async () => {
          // Arrange — a tag is not default-loggable, but an existing log keeps
          // growing. Seed the first entry under `always`, then drop to defaults.
          const ctx = createMemoryContext();
          await seedConfig(ctx, '[core]\n  logallrefupdates = always\n');
          await recordRefUpdate(ctx, TAG, ZERO_OID, OID_A, 'tag: created');
          await seedConfig(ctx, '[core]\n  bare = false\n');
          __resetConfigCacheForTests();

          // Act — default config now; the gate must still pass on the existing file.
          await recordRefUpdate(ctx, TAG, OID_A, OID_B, 'tag: moved');

          // Assert
          const entries = await readReflog(ctx, TAG);
          expect(entries).toHaveLength(2);
          expect(entries[1]?.message).toBe('tag: moved');
        });
      });
    });
  });

  describe('logAllRefUpdates always', () => {
    describe('Given logAllRefUpdates=always', () => {
      describe('When recordRefUpdate on a tag', () => {
        it('Then the tag is logged', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedConfig(ctx, '[core]\n  logallrefupdates = always\n');

          // Act
          await recordRefUpdate(ctx, TAG, ZERO_OID, OID_A, 'tag: v1.0.0');

          // Assert
          expect(await reflogExists(ctx, TAG)).toBe(true);
        });
      });
    });
  });

  describe('message sanitising', () => {
    describe('Given a message with embedded line breaks', () => {
      describe('When recordRefUpdate', () => {
        it('Then the stored message is collapsed to one line', async () => {
          // Arrange
          const ctx = createMemoryContext();

          // Act
          await recordRefUpdate(ctx, BRANCH, ZERO_OID, OID_A, '  first\nsecond\r\nthird  ');

          // Assert
          const entries = await readReflog(ctx, BRANCH);
          expect(entries[0]?.message).toBe('first second third');
        });
      });
    });
  });
});
