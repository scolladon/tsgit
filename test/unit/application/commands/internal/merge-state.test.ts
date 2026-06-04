import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { init } from '../../../../../src/application/commands/init.js';
import {
  clearMergeState,
  readMergeHead,
  readMergeMsg,
  readOrigHead,
  writeMergeHead,
  writeMergeMsg,
  writeOrigHead,
} from '../../../../../src/application/commands/internal/merge-state.js';
import type { ObjectId } from '../../../../../src/domain/objects/index.js';

describe('merge-state', () => {
  describe('writeMergeHead', () => {
    describe('Given a target ObjectId', () => {
      describe('When writeMergeHead is called', () => {
        it('Then .git/MERGE_HEAD contains the id followed by a single newline', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await init(ctx);
          const targetId = 'a'.repeat(40) as ObjectId;

          // Act
          await writeMergeHead(ctx, targetId);

          // Assert — exact content (not just contains), kills mutants that drop the LF.
          const sut = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/MERGE_HEAD`);
          expect(sut).toBe(`${'a'.repeat(40)}\n`);
        });
      });
    });

    describe('Given a pre-existing MERGE_HEAD', () => {
      describe('When writeMergeHead is called again', () => {
        it('Then the file is replaced (idempotent overwrite)', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await init(ctx);
          const first = 'a'.repeat(40) as ObjectId;
          const second = 'b'.repeat(40) as ObjectId;

          // Act
          await writeMergeHead(ctx, first);
          await writeMergeHead(ctx, second);

          // Assert
          const sut = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/MERGE_HEAD`);
          expect(sut).toBe(`${'b'.repeat(40)}\n`);
        });
      });
    });
  });

  describe('writeMergeMsg', () => {
    describe('Given a merge message', () => {
      describe('When writeMergeMsg is called', () => {
        it('Then .git/MERGE_MSG contains exactly the message (no trailing LF added)', async () => {
          // Arrange the message is stored verbatim, no
          // Conflicts trailer, no LF normalisation.
          const ctx = createMemoryContext();
          await init(ctx);

          // Act
          await writeMergeMsg(ctx, 'Merge branch feature');

          // Assert
          const sut = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/MERGE_MSG`);
          expect(sut).toBe('Merge branch feature');
        });
      });
    });

    describe('Given a multi-line message', () => {
      describe('When writeMergeMsg is called', () => {
        it('Then the file preserves the lines verbatim', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await init(ctx);
          const message = 'Merge branch feature\n\nResolves the dep upgrade.';

          // Act
          await writeMergeMsg(ctx, message);

          // Assert
          const sut = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/MERGE_MSG`);
          expect(sut).toBe(message);
        });
      });
    });
  });

  describe('writeOrigHead', () => {
    describe('Given a pre-merge HEAD id', () => {
      describe('When writeOrigHead is called', () => {
        it('Then .git/ORIG_HEAD contains the id followed by a single newline', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await init(ctx);
          const oldHead = 'c'.repeat(40) as ObjectId;

          // Act
          await writeOrigHead(ctx, oldHead);

          // Assert
          const sut = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/ORIG_HEAD`);
          expect(sut).toBe(`${'c'.repeat(40)}\n`);
        });
      });
    });
  });

  describe('readMergeHead', () => {
    describe('Given no MERGE_HEAD file', () => {
      describe('When readMergeHead is called', () => {
        it('Then returns undefined', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await init(ctx);

          // Act
          const sut = await readMergeHead(ctx);

          // Assert
          expect(sut).toBeUndefined();
        });
      });
    });

    describe('Given a written MERGE_HEAD', () => {
      describe('When readMergeHead is called', () => {
        it('Then returns the recorded ObjectId without the trailing newline', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await init(ctx);
          const targetId = 'd'.repeat(40) as ObjectId;
          await writeMergeHead(ctx, targetId);

          // Act
          const sut = await readMergeHead(ctx);

          // Assert
          expect(sut).toBe(targetId);
        });
      });
    });

    describe('Given a whitespace-only MERGE_HEAD', () => {
      describe('When readMergeHead is called', () => {
        it('Then returns undefined (defensive: treats as absent)', async () => {
          // Arrange — write a file containing only whitespace.
          const ctx = createMemoryContext();
          await init(ctx);
          await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/MERGE_HEAD`, '   \n');

          // Act
          const sut = await readMergeHead(ctx);

          // Assert
          expect(sut).toBeUndefined();
        });
      });
    });

    describe('Given a malformed (non-hex) MERGE_HEAD', () => {
      describe('When readMergeHead is called', () => {
        it('Then throws INVALID_OBJECT_ID with the offending value', async () => {
          // Arrange — a corrupt MERGE_HEAD (e.g., from a mid-write crash)
          // must NOT silently produce a malformed second parent. The
          // validation gate ensures `commit` cannot build a corrupt commit
          // object from poisoned state.
          const ctx = createMemoryContext();
          await init(ctx);
          await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/MERGE_HEAD`, 'not-a-hex-oid\n');

          // Act
          let caught: unknown;
          try {
            await readMergeHead(ctx);
          } catch (err) {
            caught = err;
          }

          // Assert
          const data = (caught as { data?: { code?: string; value?: string } })?.data;
          expect(data?.code).toBe('INVALID_OBJECT_ID');
          expect(data?.value).toBe('not-a-hex-oid');
        });
      });
    });
  });

  describe('readOrigHead', () => {
    describe('Given no ORIG_HEAD file', () => {
      describe('When readOrigHead is called', () => {
        it('Then returns undefined', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await init(ctx);

          // Act
          const sut = await readOrigHead(ctx);

          // Assert
          expect(sut).toBeUndefined();
        });
      });
    });

    describe('Given a written ORIG_HEAD', () => {
      describe('When readOrigHead is called', () => {
        it('Then returns the recorded ObjectId without the trailing newline', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await init(ctx);
          const preMergeHead = 'e'.repeat(40) as ObjectId;
          await writeOrigHead(ctx, preMergeHead);

          // Act
          const sut = await readOrigHead(ctx);

          // Assert
          expect(sut).toBe(preMergeHead);
        });
      });
    });

    describe('Given a whitespace-only ORIG_HEAD', () => {
      describe('When readOrigHead is called', () => {
        it('Then returns undefined (defensive: treats as absent)', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await init(ctx);
          await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/ORIG_HEAD`, '   \n');

          // Act
          const sut = await readOrigHead(ctx);

          // Assert
          expect(sut).toBeUndefined();
        });
      });
    });

    describe('Given a malformed (non-hex) ORIG_HEAD', () => {
      describe('When readOrigHead is called', () => {
        it('Then throws INVALID_OBJECT_ID with the offending value', async () => {
          // Arrange — a corrupt ORIG_HEAD must NOT silently route mergeAbort
          // to an invalid commit. The factory rejection guards downstream
          // consumers that resolve to a tree.
          const ctx = createMemoryContext();
          await init(ctx);
          await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/ORIG_HEAD`, 'not-a-hex-oid\n');

          // Act
          let caught: unknown;
          try {
            await readOrigHead(ctx);
          } catch (err) {
            caught = err;
          }

          // Assert
          const data = (caught as { data?: { code?: string; value?: string } })?.data;
          expect(data?.code).toBe('INVALID_OBJECT_ID');
          expect(data?.value).toBe('not-a-hex-oid');
        });
      });
    });
  });

  describe('readMergeMsg', () => {
    describe('Given no MERGE_MSG file', () => {
      describe('When readMergeMsg is called', () => {
        it('Then returns undefined', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await init(ctx);

          // Act
          const sut = await readMergeMsg(ctx);

          // Assert
          expect(sut).toBeUndefined();
        });
      });
    });

    describe('Given a written MERGE_MSG', () => {
      describe('When readMergeMsg is called', () => {
        it('Then returns the verbatim content', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await init(ctx);
          await writeMergeMsg(ctx, 'Merge branch feature\nbody');

          // Act
          const sut = await readMergeMsg(ctx);

          // Assert
          expect(sut).toBe('Merge branch feature\nbody');
        });
      });
    });
  });

  describe('clearMergeState', () => {
    describe('Given existing MERGE_HEAD and MERGE_MSG', () => {
      describe('When clearMergeState is called', () => {
        it('Then both files are removed (ORIG_HEAD is preserved as a recovery aid)', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await init(ctx);
          await writeMergeHead(ctx, 'a'.repeat(40) as ObjectId);
          await writeMergeMsg(ctx, 'msg');
          await writeOrigHead(ctx, 'b'.repeat(40) as ObjectId);

          // Act
          await clearMergeState(ctx);

          // Assert — MERGE_HEAD and MERGE_MSG gone; ORIG_HEAD survives so the
          // user can `reset --hard ORIG_HEAD` after the resolved commit.
          expect(await ctx.fs.exists(`${ctx.layout.gitDir}/MERGE_HEAD`)).toBe(false);
          expect(await ctx.fs.exists(`${ctx.layout.gitDir}/MERGE_MSG`)).toBe(false);
          expect(await ctx.fs.exists(`${ctx.layout.gitDir}/ORIG_HEAD`)).toBe(true);
        });
      });
    });

    describe('Given no merge-state files', () => {
      describe('When clearMergeState is called', () => {
        it('Then no error is thrown (idempotent)', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await init(ctx);

          // Act / Assert
          await expect(clearMergeState(ctx)).resolves.toBeUndefined();
        });
      });
    });
  });
});
