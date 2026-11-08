import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import * as configRead from '../../../../src/application/primitives/config-read.js';
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
const HEAD = 'HEAD' as RefName;

const adminDir = (ctx: Context): string => `${ctx.layout.gitDir}/worktrees/wt`;

// Reframe a main-repo Context as a linked-worktree child Context.
const asWorktreeChild = (ctx: Context): Context => ({
  ...ctx,
  layout: { ...ctx.layout, gitDir: adminDir(ctx), commonDir: ctx.layout.gitDir },
});

const seedConfig = async (ctx: Context, content: string): Promise<void> => {
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, content);
};

describe('recordRefUpdate', () => {
  beforeEach(() => {
    __resetConfigCacheForTests();
  });

  afterEach(() => {
    __resetConfigCacheForTests();
    vi.restoreAllMocks();
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
    describe('Given no main logs/HEAD and the default core.logAllRefUpdates', () => {
      describe('When recordRefUpdate logs main-worktree/HEAD', () => {
        it('Then no log file is created', async () => {
          // Arrange
          const ctx = createMemoryContext();
          const sut = recordRefUpdate;

          // Act
          await sut(ctx, 'main-worktree/HEAD' as RefName, ZERO_OID, OID_A, 'x');

          // Assert
          expect(await reflogExists(ctx, HEAD)).toBe(false);
        });
      });
    });

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
    describe('Given the main logs/HEAD', () => {
      describe('When recordRefUpdate logs main-worktree/HEAD from the child', () => {
        it('Then the entry is appended to the main logs/HEAD', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await recordRefUpdate(ctx, HEAD, ZERO_OID, OID_A, 'commit (initial): seed');
          const child = asWorktreeChild(ctx);
          const sut = recordRefUpdate;

          // Act
          await sut(child, 'main-worktree/HEAD' as RefName, OID_A, OID_B, 'link');

          // Assert
          const entries = await readReflog(ctx, HEAD);
          expect(entries.map((entry) => entry.message)).toEqual(['commit (initial): seed', 'link']);
        });
      });
    });

    describe("Given the admin dir's logs/HEAD", () => {
      describe('When recordRefUpdate logs worktrees/wt/HEAD from the main worktree', () => {
        it('Then it is appended there', async () => {
          // Arrange
          const ctx = createMemoryContext();
          const child = asWorktreeChild(ctx);
          await recordRefUpdate(child, HEAD, ZERO_OID, OID_A, 'commit (initial): seed');
          const sut = recordRefUpdate;

          // Act
          await sut(ctx, 'worktrees/wt/HEAD' as RefName, OID_A, OID_B, 'moved');

          // Assert
          const entries = await readReflog(child, HEAD);
          expect(entries.map((entry) => entry.message)).toEqual([
            'commit (initial): seed',
            'moved',
          ]);
        });
      });
    });

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

  describe('config reads', () => {
    describe('Given a default-loggable branch ref with no existing reflog', () => {
      describe('When recordRefUpdate runs (the gate check AND identity resolution both need config)', () => {
        it('Then readConfig is called exactly once', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedConfig(ctx, '[user]\n  name = Ada\n  email = ada@example.com\n');
          const spy = vi.spyOn(configRead, 'readConfig');

          // Act
          await recordRefUpdate(ctx, BRANCH, ZERO_OID, OID_A, 'commit: x');

          // Assert
          expect(spy).toHaveBeenCalledTimes(1);
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
