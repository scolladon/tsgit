import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { __resetConfigCacheForTests } from '../../../../src/application/primitives/config-read.js';
import { __resetSectionsCacheForTests } from '../../../../src/application/primitives/config-scoped-read.js';
import {
  loadSparseMatcher,
  MAX_SPARSE_PATTERN_FILE_BYTES,
  readSparseMatchOptions,
  readSparsePatternText,
} from '../../../../src/application/primitives/read-sparse-checkout.js';
import { TsgitError } from '../../../../src/domain/error.js';
import type { FilePath } from '../../../../src/domain/objects/object-id.js';
import type { Context } from '../../../../src/ports/context.js';

const sparsePath = (ctx: Context): string => `${ctx.layout.gitDir}/info/sparse-checkout`;
const configPath = (ctx: Context): string => `${ctx.layout.gitDir}/config`;

const seedPatternFile = async (ctx: Context, text: string): Promise<void> => {
  await ctx.fs.writeUtf8(sparsePath(ctx), text);
};

const seedWorktreeConfig = async (ctx: Context, text: string): Promise<void> => {
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config.worktree`, text);
};

const seedConfig = async (ctx: Context, text: string): Promise<void> => {
  await ctx.fs.writeUtf8(configPath(ctx), text);
};

describe('primitives/read-sparse-checkout', () => {
  beforeEach(() => {
    __resetConfigCacheForTests();
    __resetSectionsCacheForTests();
  });

  describe('readSparsePatternText', () => {
    describe('Given no sparse-checkout file', () => {
      describe('When readSparsePatternText', () => {
        it('Then returns undefined', async () => {
          // Arrange
          const ctx = createMemoryContext();

          // Act
          const result = await readSparsePatternText(ctx);

          // Assert
          expect(result).toBeUndefined();
        });
      });
    });

    describe('Given a sparse-checkout file', () => {
      describe('When readSparsePatternText', () => {
        it('Then returns its UTF-8 text', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedPatternFile(ctx, '/src/\n');

          // Act
          const result = await readSparsePatternText(ctx);

          // Assert
          expect(result).toBe('/src/\n');
        });
      });
    });

    describe('Given a file exactly at the byte cap', () => {
      describe('When readSparsePatternText', () => {
        it('Then it is accepted', async () => {
          // Arrange — `limit` bytes must NOT throw (the cap is exclusive).
          const ctx = createMemoryContext();
          const atCap = 'a'.repeat(MAX_SPARSE_PATTERN_FILE_BYTES);
          await ctx.fs.write(sparsePath(ctx), new TextEncoder().encode(atCap));

          // Act
          const result = await readSparsePatternText(ctx);

          // Assert
          expect(result).toBe(atCap);
        });
      });
    });

    describe('Given a file one byte over the cap', () => {
      describe('When readSparsePatternText', () => {
        it('Then it throws SPARSE_PATTERN_FILE_TOO_LARGE', async () => {
          // Arrange — `limit + 1` bytes must throw.
          const ctx = createMemoryContext();
          const overCap = 'a'.repeat(MAX_SPARSE_PATTERN_FILE_BYTES + 1);
          await ctx.fs.write(sparsePath(ctx), new TextEncoder().encode(overCap));

          // Act
          let caught: unknown;
          try {
            await readSparsePatternText(ctx);
          } catch (err) {
            caught = err;
          }

          // Assert — every payload field is pinned.
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data).toEqual({
            code: 'SPARSE_PATTERN_FILE_TOO_LARGE',
            path: 'info/sparse-checkout',
            size: MAX_SPARSE_PATTERN_FILE_BYTES + 1,
            limit: MAX_SPARSE_PATTERN_FILE_BYTES,
          });
        });
      });
    });

    describe('Given fs.read rejects with a non-FILE_NOT_FOUND TsgitError', () => {
      describe('When readSparsePatternText', () => {
        it('Then the error propagates', async () => {
          // Arrange — only FILE_NOT_FOUND is swallowed.
          const ctx = createMemoryContext();
          const denied = new TsgitError({ code: 'PERMISSION_DENIED', path: '/x' });
          vi.spyOn(ctx.fs, 'read').mockRejectedValue(denied);

          // Act
          let caught: unknown;
          try {
            await readSparsePatternText(ctx);
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBe(denied);
        });
      });
    });

    describe('Given fs.read rejects with a non-TsgitError', () => {
      describe('When readSparsePatternText', () => {
        it('Then the error is rethrown', async () => {
          // Arrange
          const ctx = createMemoryContext();
          const boom = new Error('disk on fire');
          vi.spyOn(ctx.fs, 'read').mockRejectedValue(boom);

          // Act
          let caught: unknown;
          try {
            await readSparsePatternText(ctx);
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBe(boom);
        });
      });
    });
  });

  describe('loadSparseMatcher', () => {
    describe('Given core.sparseCheckout absent', () => {
      describe('When loadSparseMatcher', () => {
        it('Then returns undefined', async () => {
          // Arrange — no config at all.
          const ctx = createMemoryContext();

          // Act
          const result = await loadSparseMatcher(ctx);

          // Assert
          expect(result).toBeUndefined();
        });
      });
    });

    describe('Given core.sparseCheckout = false', () => {
      describe('When loadSparseMatcher', () => {
        it('Then returns undefined', async () => {
          // Arrange — an explicit falsy gate is still inactive.
          const ctx = createMemoryContext();
          await seedConfig(ctx, '[core]\n\tsparseCheckout = false\n');

          // Act
          const result = await loadSparseMatcher(ctx);

          // Assert
          expect(result).toBeUndefined();
        });
      });
    });

    describe('Given the extension on and config.worktree setting sparseCheckout and sparseCheckoutCone true with a cone file', () => {
      describe('When loadSparseMatcher', () => {
        it('Then a cone matcher is built from the worktree keys', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedConfig(ctx, '[extensions]\n\tworktreeConfig = true\n');
          await seedWorktreeConfig(
            ctx,
            '[core]\n\tsparseCheckout = true\n\tsparseCheckoutCone = true\n',
          );
          await seedPatternFile(ctx, '/*\n!/*/\n/src/\n');

          // Act
          const result = await loadSparseMatcher(ctx);

          // Assert
          expect(result).toBeDefined();
          expect(result?.('src/main.ts' as FilePath)).toBe(true);
          expect(result?.('docs/readme.md' as FilePath)).toBe(false);
        });
      });
    });

    describe('Given the extension off and config.worktree setting sparseCheckout true', () => {
      describe('When loadSparseMatcher', () => {
        it('Then returns undefined', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedWorktreeConfig(ctx, '[core]\n\tsparseCheckout = true\n');

          // Act
          const result = await loadSparseMatcher(ctx);

          // Assert
          expect(result).toBeUndefined();
        });
      });
    });

    describe('Given core.sparseCheckout = true with a cone file', () => {
      describe('When loadSparseMatcher', () => {
        it('Then a cone matcher is built', async () => {
          // Arrange — cone mode, recursive dir `src`.
          const ctx = createMemoryContext();
          await seedConfig(ctx, '[core]\n\tsparseCheckout = true\n\tsparseCheckoutCone = true\n');
          await seedPatternFile(ctx, '/*\n!/*/\n/src/\n');

          // Act
          const result = await loadSparseMatcher(ctx);

          // Assert — under `src` included, sibling dir excluded.
          expect(result).toBeDefined();
          expect(result?.('src/main.ts' as FilePath)).toBe(true);
          expect(result?.('docs/readme.md' as FilePath)).toBe(false);
        });
      });
    });

    describe('Given core.sparseCheckout = true with non-cone mode', () => {
      describe('When loadSparseMatcher', () => {
        it('Then a non-cone matcher is built', async () => {
          // Arrange — non-cone last-match-wins pattern.
          const ctx = createMemoryContext();
          await seedConfig(ctx, '[core]\n\tsparseCheckout = true\n');
          await seedPatternFile(ctx, '/src/\n');

          // Act
          const result = await loadSparseMatcher(ctx);

          // Assert
          expect(result?.('src/main.ts' as FilePath)).toBe(true);
          expect(result?.('docs/readme.md' as FilePath)).toBe(false);
        });
      });
    });

    describe('Given core.sparseCheckout = true with no pattern file', () => {
      describe('When loadSparseMatcher (non-cone)', () => {
        it('Then an includes-nothing matcher is built', async () => {
          // Arrange — absent file is treated as the empty string; non-cone parse
          // of `''` yields zero rules, so the matcher selects nothing.
          const ctx = createMemoryContext();
          await seedConfig(ctx, '[core]\n\tsparseCheckout = true\n');

          // Act
          const result = await loadSparseMatcher(ctx);

          // Assert — nothing is in the sparse set. The literal `Stryker was here!`
          // pins the `?? ''` fallback: a non-empty fallback would compile that
          // string into a rule and this path would flip to `true`.
          expect(result?.('src/main.ts' as FilePath)).toBe(false);
          expect(result?.('Stryker was here!' as FilePath)).toBe(false);
        });
      });
    });

    describe('Given a cone-shaped file but cone NOT requested', () => {
      describe('When loadSparseMatcher', () => {
        it('Then it is parsed as non-cone (a wildcard directory line matches by glob)', async () => {
          // Arrange — cone-shaped text whose directory line carries a wildcard:
          // non-cone git reads `/docs*/` as a glob, a cone reading would take it
          // as the literal directory `docs*`. `sparseCheckoutCone` is absent → non-cone.
          const ctx = createMemoryContext();
          await seedConfig(ctx, '[core]\n\tsparseCheckout = true\n');
          await seedPatternFile(ctx, '/*\n!/*/\n/docs*/\n');

          // Act
          const result = await loadSparseMatcher(ctx);

          // Assert — `docs-x/f` included proves the glob reading (git: `H ab/f` for
          // `/a*/`); a `coneRequested = true` mutant would exclude it.
          expect(result?.('docs-x/f' as FilePath)).toBe(true);
          expect(result?.('other/f' as FilePath)).toBe(false);
        });
      });
    });

    describe('Given a cone-shaped file WITH cone requested', () => {
      describe('When loadSparseMatcher', () => {
        it('Then it is parsed as cone (a root file is included)', async () => {
          // Arrange — a cone-shaped text and `sparseCheckoutCone = true` flips the
          // interpretation to cone, where root files are always included.
          const ctx = createMemoryContext();
          await seedConfig(ctx, '[core]\n\tsparseCheckout = true\n\tsparseCheckoutCone = true\n');
          await seedPatternFile(ctx, '/*\n!/*/\n/docs/\n');

          // Act
          const result = await loadSparseMatcher(ctx);

          // Assert — cone mode includes the root file.
          expect(result?.('readme' as FilePath)).toBe(true);
        });
      });
    });

    describe('Given a cone-requested config but a non-cone-shaped file', () => {
      describe('When loadSparseMatcher', () => {
        it('Then it logs one warning and falls back', async () => {
          // Arrange — cone requested, but the file is hand-edited into a non-cone
          // shape, so the parse degrades.
          const warn = vi.fn();
          const ctx: Context = { ...createMemoryContext(), logger: { warn } };
          await seedConfig(ctx, '[core]\n\tsparseCheckout = true\n\tsparseCheckoutCone = true\n');
          await seedPatternFile(ctx, '*.ts\n');

          // Act
          const result = await loadSparseMatcher(ctx);

          // Assert — degraded → exactly one warning with the exact message;
          // non-cone matching applies.
          expect(warn).toHaveBeenCalledTimes(1);
          expect(warn).toHaveBeenCalledWith(
            '.git/info/sparse-checkout is not cone-shaped; falling back to non-cone matching',
          );
          expect(result?.('src/main.ts' as FilePath)).toBe(true);
        });
      });
    });

    describe('Given a degraded cone parse but no logger', () => {
      describe('When loadSparseMatcher', () => {
        it('Then it still builds a matcher without throwing', async () => {
          // Arrange — `ctx.logger` undefined; the optional-chain warn is a no-op.
          const ctx = createMemoryContext();
          await seedConfig(ctx, '[core]\n\tsparseCheckout = true\n\tsparseCheckoutCone = true\n');
          await seedPatternFile(ctx, '*.ts\n');

          // Act
          const result = await loadSparseMatcher(ctx);

          // Assert
          expect(result?.('src/main.ts' as FilePath)).toBe(true);
        });
      });
    });

    describe('Given cone mode with no pattern file', () => {
      describe('When loadSparseMatcher', () => {
        it('Then a matcher is built and NO warning is logged', async () => {
          // Arrange — `core.sparseCheckout` and `sparseCheckoutCone` are both true
          // but `.git/info/sparse-checkout` is absent. An absent file is NOT a
          // degraded cone file, so it must not emit the degraded warning.
          const warn = vi.fn();
          const ctx: Context = { ...createMemoryContext(), logger: { warn } };
          await seedConfig(ctx, '[core]\n\tsparseCheckout = true\n\tsparseCheckoutCone = true\n');

          // Act
          const result = await loadSparseMatcher(ctx);

          // Assert — a callable matcher is returned, and no warning was logged.
          expect(typeof result).toBe('function');
          expect(warn).not.toHaveBeenCalled();
        });
      });
    });

    describe('Given a cone file that parses cleanly', () => {
      describe('When loadSparseMatcher', () => {
        it('Then no warning is logged', async () => {
          // Arrange — a well-formed cone file must NOT trigger the degraded warn.
          const warn = vi.fn();
          const ctx: Context = { ...createMemoryContext(), logger: { warn } };
          await seedConfig(ctx, '[core]\n\tsparseCheckout = true\n\tsparseCheckoutCone = true\n');
          await seedPatternFile(ctx, '/*\n!/*/\n/src/\n');

          // Act
          await loadSparseMatcher(ctx);

          // Assert
          expect(warn).not.toHaveBeenCalled();
        });
      });
    });

    describe.each([
      { label: 'core.ignorecase = true', config: '\tignorecase = true\n', accepts: true },
      { label: 'core.ignorecase absent', config: '', accepts: false },
      { label: 'core.ignorecase = false', config: '\tignorecase = false\n', accepts: false },
    ])('Given a cone file and $label', ({ config, accepts }) => {
      describe('When loadSparseMatcher', () => {
        it('Then a differently cased path is matched only under ignorecase', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedConfig(
            ctx,
            `[core]\n\tsparseCheckout = true\n\tsparseCheckoutCone = true\n${config}`,
          );
          await seedPatternFile(ctx, '/*\n!/*/\n/b/\n');

          // Act
          const sut = loadSparseMatcher;
          const result = await sut(ctx);

          // Assert
          expect(result?.('B/f' as FilePath)).toBe(accepts);
          expect(result?.('b/f' as FilePath)).toBe(true);
        });
      });
    });
  });

  describe.each([
    { label: 'core.ignorecase = true', config: '[core]\n\tignorecase = true\n', expected: true },
    { label: 'core.ignorecase = false', config: '[core]\n\tignorecase = false\n', expected: false },
    { label: 'core.ignorecase absent', config: '', expected: false },
  ])('Given $label', ({ config, expected }) => {
    describe('When readSparseMatchOptions', () => {
      it('Then ignoreCase follows the setting', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedConfig(ctx, config);
        const sut = readSparseMatchOptions;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result).toEqual({ ignoreCase: expected });
      });
    });
  });
});
