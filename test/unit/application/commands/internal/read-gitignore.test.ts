import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { __resetConfigCacheForTests } from '../../../../../src/application/commands/internal/config-read.js';
import {
  readGitignore,
  readGlobalExcludes,
  readInfoExclude,
} from '../../../../../src/application/commands/internal/read-gitignore.js';
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
  it('Given no .gitignore at root, When read, Then returns undefined', async () => {
    const ctx = await seed();

    expect(await readGitignore(ctx, '')).toBeUndefined();
  });

  it('Given a present .gitignore at root, When read, Then returns the parsed rules', async () => {
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

  it('Given a .gitignore in subdir, When read with dir="sub", Then returns the parsed rules', async () => {
    // Arrange
    const ctx = await seed();
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/sub/.gitignore`, '*.tmp\n');

    // Act
    const sut = await readGitignore(ctx, 'sub' as FilePath);

    // Assert
    expect(sut).toHaveLength(1);
    expect(sut?.[0]?.pattern).toBe('*.tmp');
  });

  it('Given a .gitignore over MAX_GITIGNORE_BYTES, When read, Then throws GITIGNORE_FILE_TOO_LARGE with path/size/limit', async () => {
    // Arrange — generate content one byte over the cap.
    const ctx = await seed();
    const content = 'x'.repeat(MAX_GITIGNORE_BYTES + 1);
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitignore`, content);

    // Act
    const err = await expectError(() => readGitignore(ctx, ''), 'GITIGNORE_FILE_TOO_LARGE');

    // Assert
    const data = err.data as { path: string; size: number; limit: number };
    expect(data.path).toBe(`${ctx.layout.workDir}/.gitignore`);
    expect(data.size).toBe(MAX_GITIGNORE_BYTES + 1);
    expect(data.limit).toBe(MAX_GITIGNORE_BYTES);
  });

  it('Given a .gitignore of exactly MAX_GITIGNORE_BYTES bytes (boundary), When read, Then accepts', async () => {
    // Arrange
    const ctx = await seed();
    const content = 'x'.repeat(MAX_GITIGNORE_BYTES);
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitignore`, content);

    // Act
    const sut = await readGitignore(ctx, '');

    // Assert — parser yields rules for non-empty content.
    expect(sut).toBeDefined();
  });
});

describe('readInfoExclude', () => {
  it('Given no .git/info/exclude, When read, Then returns undefined', async () => {
    const ctx = await seed();

    expect(await readInfoExclude(ctx)).toBeUndefined();
  });

  it('Given a present .git/info/exclude, When read, Then returns the parsed rules', async () => {
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

describe('readGlobalExcludes', () => {
  it('Given no core.excludesFile in config, When read, Then returns undefined', async () => {
    const ctx = await seed();

    expect(await readGlobalExcludes(ctx)).toBeUndefined();
  });

  it('Given core.excludesFile = absolute path under the FS rootDir and the file exists, When read, Then returns the parsed rules', async () => {
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

  it('Given core.excludesFile starting with `~/` and homeDir is set, When read, Then ~ is expanded and the file loaded', async () => {
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

  it('Given core.excludesFile starting with `~/` but homeDir is undefined, When read, Then returns undefined (silent miss per ADR-034)', async () => {
    // Arrange
    const ctx = await seed();
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[core]\n  excludesFile = ~/ignore\n');

    // Act
    const sut = await readGlobalExcludes(ctx);

    // Assert
    expect(sut).toBeUndefined();
  });

  it('Given core.excludesFile = "~" alone and homeDir is set, When read, Then resolves to the home directory itself', async () => {
    // Arrange — pathological but valid.
    const ctx = await seed('/repo/home-alone');
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[core]\n  excludesFile = ~\n');
    await ctx.fs.writeUtf8('/repo/home-alone', 'global-rule\n');

    // Act
    const sut = await readGlobalExcludes(ctx);

    // Assert — resolves to homeDir verbatim and reads the file there.
    expect(sut).toHaveLength(1);
  });

  it('Given core.excludesFile set with EXCLUDESFILE key casing, When read, Then still picks it up (case-insensitive config keys)', async () => {
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
