import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import {
  readGitignore,
  readGlobalExcludes,
  readInfoExclude,
} from '../../../../../src/application/commands/internal/read-gitignore.js';
import { __resetConfigCacheForTests } from '../../../../../src/application/primitives/config-read.js';
import { MAX_GITIGNORE_BYTES } from '../../../../../src/application/primitives/types.js';
import { TsgitError } from '../../../../../src/domain/index.js';
import type { FilePath } from '../../../../../src/domain/objects/object-id.js';

afterEach(() => __resetConfigCacheForTests());

const seed = async (homeDir?: string) => {
  const ctx = homeDir === undefined ? createMemoryContext() : createMemoryContext({ homeDir });
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
  return ctx;
};

const expectError = async (fn: () => Promise<unknown>, code: string): Promise<TsgitError> => {
  let caught: unknown;
  try {
    await fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(TsgitError);
  expect((caught as TsgitError).data.code).toBe(code);
  return caught as TsgitError;
};

describe('readGitignore', () => {
  describe('Given no.gitignore at root', () => {
    describe('When read', () => {
      it('Then returns undefined', async () => {
        // Arrange
        const ctx = await seed();

        // Assert
        expect(await readGitignore(ctx, '')).toBeUndefined();
      });
    });
  });

  describe('Given a present.gitignore at root', () => {
    describe('When read', () => {
      it('Then returns the parsed rules', async () => {
        // Arrange
        const ctx = await seed();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitignore`, '*.log\n!keep.log\n');

        // Act
        const sut = await readGitignore(ctx, '');

        // Assert
        expect(sut).toHaveLength(2);
        expect(sut?.[0]?.pattern).toBe('*.log');
        expect(sut?.[1]?.negated).toBe(true);
      });
    });
  });

  describe('Given a .gitignore in subdir', () => {
    describe('When read with dir="sub"', () => {
      it('Then returns the parsed rules', async () => {
        // Arrange
        const ctx = await seed();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/sub/.gitignore`, '*.tmp\n');

        // Act
        const sut = await readGitignore(ctx, 'sub' as FilePath);

        // Assert
        expect(sut).toHaveLength(1);
        expect(sut?.[0]?.pattern).toBe('*.tmp');
      });
    });
  });

  describe('Given a.gitignore over MAX_GITIGNORE_BYTES', () => {
    describe('When read', () => {
      it('Then throws GITIGNORE_FILE_TOO_LARGE with sanitized basename path + size + limit', async () => {
        // Arrange — generate content one byte over the cap.
        const ctx = await seed();
        const content = 'x'.repeat(MAX_GITIGNORE_BYTES + 1);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitignore`, content);

        // Act
        const err = await expectError(() => readGitignore(ctx, ''), 'GITIGNORE_FILE_TOO_LARGE');

        // Assert — error payload's path is the basename so the absolute
        // home-dir path doesn't leak into error logs.
        const data = err.data as { path: string; size: number; limit: number };
        expect(data.path).toBe('.gitignore');
        expect(data.size).toBe(MAX_GITIGNORE_BYTES + 1);
        expect(data.limit).toBe(MAX_GITIGNORE_BYTES);
      });
    });
  });

  describe('Given a.gitignore of exactly MAX_GITIGNORE_BYTES bytes (boundary)', () => {
    describe('When read', () => {
      it('Then accepts and the ruleset is the single x-glob rule', async () => {
        // Arrange
        const ctx = await seed();
        const content = 'x'.repeat(MAX_GITIGNORE_BYTES);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitignore`, content);

        // Act
        const sut = await readGitignore(ctx, '');

        // Assert — the boundary-sized payload is parsed into a one-rule ruleset
        // (the body is the literal pattern `xx…x`). A bare `toBeDefined()` would
        // also pass if the parser returned `[]` — this assertion proves the
        // content actually round-tripped.
        expect(sut).toHaveLength(1);
      });
    });
  });
});

describe('readInfoExclude', () => {
  describe('Given no.git/info/exclude', () => {
    describe('When read', () => {
      it('Then returns undefined', async () => {
        // Arrange
        const ctx = await seed();

        // Assert
        expect(await readInfoExclude(ctx)).toBeUndefined();
      });
    });
  });

  describe('Given a present.git/info/exclude', () => {
    describe('When read', () => {
      it('Then returns the parsed rules', async () => {
        // Arrange
        const ctx = await seed();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/info/exclude`, 'secret.txt\n');

        // Act
        const sut = await readInfoExclude(ctx);

        // Assert
        expect(sut).toHaveLength(1);
        expect(sut?.[0]?.pattern).toBe('secret.txt');
      });
    });
  });
});

describe('readGlobalExcludes', () => {
  describe('Given no core.excludesFile in config', () => {
    describe('When read', () => {
      it('Then returns undefined', async () => {
        // Arrange
        const ctx = await seed();

        // Assert
        expect(await readGlobalExcludes(ctx)).toBeUndefined();
      });
    });
  });

  describe('Given core.excludesFile = "" (empty, feature-off)', () => {
    describe('When readGlobalExcludes runs', () => {
      it('Then it returns undefined', async () => {
        // Arrange
        const ctx = await seed();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[core]\n\texcludesFile = \n');

        // Act
        const sut = await readGlobalExcludes(ctx);

        // Assert
        expect(sut).toBeUndefined();
      });

      it('Then it never lstats the empty path', async () => {
        // Arrange — the memory adapter resolves lstat('') to the rootDir
        // directory, which masks a bare toBeUndefined() assertion. The
        // behavioral kill is that the empty path is short-circuited before
        // it can ever reach resolution.
        const ctx = await seed();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[core]\n\texcludesFile = \n');
        const lstatSpy = vi.spyOn(ctx.fs, 'lstat');

        // Act
        await readGlobalExcludes(ctx);

        // Assert
        expect(lstatSpy).not.toHaveBeenCalledWith('');
      });
    });
  });

  describe('Given core.excludesFile = absolute path under the FS rootDir and the file exists', () => {
    describe('When read', () => {
      it('Then returns the parsed rules', async () => {
        // Arrange — memory FS contains paths under /repo only; we test absolute
        // path resolution by pointing inside the FS root.
        const ctx = await seed();
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/config`,
          '[core]\n  excludesFile = /repo/global-ignore\n',
        );
        await ctx.fs.writeUtf8('/repo/global-ignore', '*.swp\n');

        // Act
        const sut = await readGlobalExcludes(ctx);

        // Assert
        expect(sut).toHaveLength(1);
        expect(sut?.[0]?.pattern).toBe('*.swp');
      });
    });
  });

  describe('Given core.excludesFile starting with `~/` and homeDir is set', () => {
    describe('When read', () => {
      it('Then ~ is expanded and the file loaded', async () => {
        // Arrange — homeDir is placed under the memory FS rootDir.
        const ctx = await seed('/repo/home');
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/config`,
          '[core]\n  excludesFile = ~/.config/git/ignore\n',
        );
        await ctx.fs.writeUtf8('/repo/home/.config/git/ignore', '*.bak\n');

        // Act
        const sut = await readGlobalExcludes(ctx);

        // Assert
        expect(sut).toHaveLength(1);
        expect(sut?.[0]?.pattern).toBe('*.bak');
      });
    });
  });

  describe('Given core.excludesFile starting with `~/` but homeDir is undefined', () => {
    describe('When read', () => {
      it('Then returns undefined (silent miss)', async () => {
        // Arrange
        const ctx = await seed();
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/config`,
          '[core]\n  excludesFile = ~/ignore\n',
        );

        // Act
        const sut = await readGlobalExcludes(ctx);

        // Assert
        expect(sut).toBeUndefined();
      });
    });
  });

  describe('Given core.excludesFile = "~" alone and homeDir is undefined', () => {
    describe('When read', () => {
      it('Then returns undefined (silent miss — symmetric with the `~/...` case)', async () => {
        // Arrange — covers the bare-`~` branch of expandUserPath when no
        // homeDir is configured. The branch must NOT return `undefined as
        // string` downstream — verify by asserting the loader silently
        // misses without throwing.
        const ctx = await seed();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[core]\n  excludesFile = ~\n');

        // Act
        const sut = await readGlobalExcludes(ctx);

        // Assert
        expect(sut).toBeUndefined();
      });
    });
  });

  describe('Given a non-FILE_NOT_FOUND error from lstat', () => {
    describe('When read', () => {
      it('Then the error propagates (kills mutants that widen the FILE_NOT_FOUND swallow)', async () => {
        // Arrange — wrap lstat to throw a non-TsgitError, which must not
        // be silenced by the FILE_NOT_FOUND check.
        const ctx = await seed();
        const hostileFs = new Proxy(ctx.fs, {
          get(target, prop, receiver) {
            if (prop === 'lstat') {
              return async () => {
                throw new Error('unexpected I/O failure');
              };
            }
            return Reflect.get(target, prop, receiver);
          },
        });
        const hostileCtx = { ...ctx, fs: hostileFs };

        // Act / Assert
        let caught: unknown;
        try {
          await readGitignore(hostileCtx, '');
        } catch (err) {
          caught = err;
        }
        // Assert
        expect(caught).toBeInstanceOf(Error);
        expect((caught as Error).message).toBe('unexpected I/O failure');
      });
    });
  });

  describe('Given core.excludesFile = directory (non-regular file)', () => {
    describe('When read', () => {
      it('Then returns undefined (defends against /dev/zero and friends)', async () => {
        // Arrange — config points at the workDir itself, which IS a directory.
        const ctx = await seed();
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/config`,
          `[core]\n  excludesFile = ${'/repo'}\n`,
        );

        // Act
        const sut = await readGlobalExcludes(ctx);

        // Assert
        expect(sut).toBeUndefined();
      });
    });
  });

  describe('Given the error payload from oversize.gitignore', () => {
    describe('When read', () => {
      it('Then path is sanitized to basename (does not leak home-dir layout)', async () => {
        // Arrange — write an oversize file at a sub-path; capture the error
        // and assert the path field is the basename.
        const ctx = await seed();
        const content = 'x'.repeat(MAX_GITIGNORE_BYTES + 1);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitignore`, content);

        // Act
        const err = await expectError(() => readGitignore(ctx, ''), 'GITIGNORE_FILE_TOO_LARGE');

        // Assert
        expect((err.data as { path: string }).path).toBe('.gitignore');
      });
    });
  });

  describe('Given core.excludesFile = "~" alone and homeDir is set', () => {
    describe('When read', () => {
      it('Then resolves to the home directory itself', async () => {
        // Arrange — pathological but valid.
        const ctx = await seed('/repo/home-alone');
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[core]\n  excludesFile = ~\n');
        await ctx.fs.writeUtf8('/repo/home-alone', 'global-rule\n');

        // Act
        const sut = await readGlobalExcludes(ctx);

        // Assert — resolves to homeDir verbatim and reads the file there.
        expect(sut).toHaveLength(1);
      });
    });
  });

  describe('Given lstat throws a TsgitError with a non-FILE_NOT_FOUND code', () => {
    describe('When read', () => {
      it('Then the error propagates (the swallow is FILE_NOT_FOUND-specific)', async () => {
        // Arrange — lstat throws a TsgitError whose code is NOT
        // FILE_NOT_FOUND. The loader's catch must only swallow
        // FILE_NOT_FOUND; the `err.data.code === 'FILE_NOT_FOUND'` check
        // mutated to `true` would silence this error and return undefined.
        const ctx = await seed();
        const permError = new TsgitError({ code: 'PERMISSION_DENIED', path: '/repo/.gitignore' });
        const hostileFs = new Proxy(ctx.fs, {
          get(target, prop, receiver) {
            if (prop === 'lstat') {
              return async () => {
                throw permError;
              };
            }
            return Reflect.get(target, prop, receiver);
          },
        });
        const hostileCtx = { ...ctx, fs: hostileFs };

        // Act
        let caught: unknown;
        try {
          await readGitignore(hostileCtx, '');
        } catch (err) {
          caught = err;
        }

        // Assert — the PERMISSION_DENIED error escaped instead of being swallowed.
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('PERMISSION_DENIED');
      });
    });
  });

  describe('Given a present root .gitignore', () => {
    describe('When read with dir="" ', () => {
      it('Then it is loaded from `<workDir>/.gitignore` verbatim', async () => {
        // Arrange — pins the literal `/.gitignore` template segment of the
        // root-branch path. A StringLiteral mutant replacing the template
        // would point the loader at a bogus path and yield undefined.
        const ctx = await seed();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitignore`, 'build/\n');

        // Act
        const sut = await readGitignore(ctx, '');

        // Assert — content proves the exact `<workDir>/.gitignore` path.
        expect(sut).toHaveLength(1);
        expect(sut?.[0]?.pattern).toBe('build/');
      });
    });
  });

  describe('Given core.excludesFile set with EXCLUDESFILE key casing', () => {
    describe('When read', () => {
      it('Then still picks it up (case-insensitive config keys)', async () => {
        // Arrange — git config keys are case-insensitive.
        const ctx = await seed();
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/config`,
          '[core]\n  EXCLUDESFILE = /repo/abs-path\n',
        );
        await ctx.fs.writeUtf8('/repo/abs-path', '*.tmp\n');

        // Act
        const sut = await readGlobalExcludes(ctx);

        // Assert
        expect(sut).toHaveLength(1);
      });
    });
  });
});
