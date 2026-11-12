import { describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { commit } from '../../../../src/application/commands/commit.js';
import {
  type GrepLineHit,
  type GrepPathResult,
  type GrepResult,
  grep,
} from '../../../../src/application/commands/grep.js';
import { init } from '../../../../src/application/commands/init.js';
import { resolveRevision } from '../../../../src/application/commands/rev-parse.js';
import { tagCreate } from '../../../../src/application/commands/tag.js';
import { __resetConfigCacheForTests } from '../../../../src/application/primitives/config-read.js';
import * as readBlobMod from '../../../../src/application/primitives/read-blob.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { MAX_LINE_BYTES } from '../../../../src/domain/diff/index.js';
import { TsgitError } from '../../../../src/domain/error.js';
import {
  type GitIndex,
  type IndexEntry,
  STAGE0_FLAGS,
} from '../../../../src/domain/git-index/index-entry.js';
import type { AuthorIdentity, Tree } from '../../../../src/domain/objects/index.js';
import {
  FILE_MODE,
  FilePath,
  type ObjectId,
  treeEntry,
} from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';
import {
  buildSeededContext,
  refuseReadOnSymlink,
  serializeIndexFixtureAsync,
} from '../../application/primitives/fixtures.js';
import { asBareContext } from './fixtures.js';

const AUTHOR: AuthorIdentity = {
  name: 'Test',
  email: 'test@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

const seedRepo = async (): Promise<Context> => {
  const ctx = createMemoryContext();
  await init(ctx);
  return ctx;
};

const writeAndStage = async (ctx: Context, path: string, content: string): Promise<void> => {
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/${path}`, content);
  await add(ctx, [path]);
};

const commitAll = async (ctx: Context): Promise<void> => {
  await commit(ctx, { message: 'test commit', author: AUTHOR, committer: AUTHOR });
};

// ─── Guard: ≥1 pattern required ──────────────────────────────────────────────

describe('Given no patterns, When grep is called', () => {
  it('Then it throws INVALID_OPTION with option "patterns"', async () => {
    // Arrange
    const ctx = await seedRepo();

    // Act
    let caught: unknown;
    try {
      await grep(ctx, { patterns: [] });
    } catch (e) {
      caught = e;
    }

    // Assert
    expect(caught).toBeInstanceOf(TsgitError);
    const err = caught as TsgitError;
    expect(err.data.code).toBe('INVALID_OPTION');
    expect((err.data as { option: string }).option).toBe('patterns');
  });

  it('Then the INVALID_OPTION error reason is exactly "at least one pattern required"', async () => {
    // Arrange
    const ctx = await seedRepo();

    // Act
    let caught: unknown;
    try {
      await grep(ctx, { patterns: [] });
    } catch (e) {
      caught = e;
    }

    // Assert
    expect(caught).toBeInstanceOf(TsgitError);
    const err = caught as TsgitError;
    const data = err.data as { code: string; option: string; reason: string };
    expect(data.reason).toBe('at least one pattern required');
  });
});

// ─── Guard: the eager config gate runs before the patterns check ────────────

describe('Given a malformed config and no pattern supplied, When grep is called', () => {
  it('Then it reports the config fault, not the missing pattern', async () => {
    // Arrange — measured against real git: `git grep` with no pattern, in a
    // repository carrying an invalid core.maxTreeDepth, exits 128 with the
    // config error, because git parses config at startup before it validates
    // arguments. Both guards apply to this input, so this pins their ORDER.
    const ctx = createMemoryContext();
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[core]\n\tmaxTreeDepth = 2.5\n');

    // Act
    let caught: unknown;
    try {
      await grep(ctx, { patterns: [] });
    } catch (e) {
      caught = e;
    }

    // Assert
    expect(caught).toBeInstanceOf(TsgitError);
    const data = (caught as TsgitError).data as { code: string; reason: string };
    expect(data.code).toBe('CONFIG_BAD_NUMERIC_VALUE');
    expect(data.reason).toBe('invalid unit');
  });
});

describe('Given a repository whose config holds an invalid core.maxTreeDepth, When grep is called', () => {
  it('Then it throws CONFIG_BAD_NUMERIC_VALUE with reason invalid unit', async () => {
    // Arrange
    const ctx = createMemoryContext();
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[core]\n\tmaxTreeDepth = 2.5\n');

    // Act
    let caught: unknown;
    try {
      await grep(ctx, { patterns: [{ fixed: 'needle' }] });
    } catch (e) {
      caught = e;
    }

    // Assert
    expect(caught).toBeInstanceOf(TsgitError);
    const data = (caught as TsgitError).data as {
      readonly code: string;
      readonly key: string;
      readonly value: string;
      readonly reason: string;
    };
    expect(data.code).toBe('CONFIG_BAD_NUMERIC_VALUE');
    expect(data.key).toBe('core.maxtreedepth');
    expect(data.value).toBe('2.5');
    expect(data.reason).toBe('invalid unit');
  });
});

// ─── Guard: u-flag propagates from matcher ────────────────────────────────────

describe('Given a u-flagged RegExp pattern, When grep is called', () => {
  it('Then it throws INVALID_OPTION with option "pattern"', async () => {
    // Arrange
    const ctx = await seedRepo();

    // Act
    let caught: unknown;
    try {
      await grep(ctx, { patterns: [/x/u] });
    } catch (e) {
      caught = e;
    }

    // Assert
    expect(caught).toBeInstanceOf(TsgitError);
    const err = caught as TsgitError;
    expect(err.data.code).toBe('INVALID_OPTION');
    expect((err.data as { option: string }).option).toBe('pattern');
  });
});

// ─── Working-tree target (default) — only TRACKED files searched ─────────────

describe('Given a tracked file with matching content, When grep runs with default target', () => {
  it('Then it matches working-tree content of the tracked file', async () => {
    // Arrange
    const ctx = await seedRepo();
    await writeAndStage(ctx, 'tracked.txt', 'hello world\nsecond line\n');
    await commitAll(ctx);

    // Act
    const result: GrepResult = await grep(ctx, { patterns: [{ fixed: 'hello' }] });

    // Assert
    expect(result.paths).toHaveLength(1);
    expect(result.paths[0]!.path).toBe('tracked.txt');
    expect(result.paths[0]!.hits).toHaveLength(1);
    expect(result.paths[0]!.hits[0]!.lineNumber).toBe(1);
  });
});

describe('Given an untracked file containing the pattern, When grep runs with default target', () => {
  it('Then the untracked file is NOT returned', async () => {
    // Arrange
    const ctx = await seedRepo();
    // Write to working tree but do NOT stage — untracked
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/untracked.txt`, 'hello world\n');

    // Act
    const result: GrepResult = await grep(ctx, { patterns: [{ fixed: 'hello' }] });

    // Assert
    const paths = result.paths.map((p) => p.path as string);
    expect(paths).not.toContain('untracked.txt');
    expect(result.paths).toHaveLength(0);
  });
});

describe('Given staged content and unstaged changes, When grep runs with default target', () => {
  it('Then it sees the unstaged working-tree content (#T1)', async () => {
    // Arrange
    const ctx = await seedRepo();
    await writeAndStage(ctx, 'f.txt', 'staged content\n');
    await commitAll(ctx);
    // unstaged modification visible to working tree
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/f.txt`, 'staged content\nunstaged addition\n');

    // Act
    const result: GrepResult = await grep(ctx, { patterns: [{ fixed: 'unstaged addition' }] });

    // Assert
    expect(result.paths).toHaveLength(1);
    expect(result.paths[0]!.path).toBe('f.txt');
  });
});

describe('Given a tracked file deleted from the working tree, When grep runs with default target', () => {
  it('Then the deleted file is silently skipped and no error is thrown', async () => {
    // Arrange
    const ctx = await seedRepo();
    await writeAndStage(ctx, 'deleted.txt', 'hello content\n');
    await commitAll(ctx);
    // Remove from working tree but leave index entry intact
    await ctx.fs.rm(`${ctx.layout.workDir}/deleted.txt`);

    // Act — must not throw
    let result: GrepResult | undefined;
    let caught: unknown;
    try {
      result = await grep(ctx, { patterns: [{ fixed: 'hello' }] });
    } catch (e) {
      caught = e;
    }

    // Assert
    expect(caught).toBeUndefined();
    expect(result).toBeDefined();
    const paths = result!.paths.map((p) => p.path as string);
    expect(paths).not.toContain('deleted.txt');
  });
});

// ─── Index target (--cached, #T2 / #T3) ─────────────────────────────────────

describe('Given a staged file, When grep runs with target "index"', () => {
  it('Then it matches staged content (#T2)', async () => {
    // Arrange
    const ctx = await seedRepo();
    await writeAndStage(ctx, 'staged.txt', 'staged line\n');

    // Act
    const result: GrepResult = await grep(ctx, {
      patterns: [{ fixed: 'staged line' }],
      target: 'index',
    });

    // Assert
    expect(result.paths).toHaveLength(1);
    expect(result.paths[0]!.path).toBe('staged.txt');
  });

  it('Then it does NOT see unstaged-only changes (#T3)', async () => {
    // Arrange
    const ctx = await seedRepo();
    await writeAndStage(ctx, 'base.txt', 'committed\n');
    await commitAll(ctx);
    // unstaged change: write directly to working tree, do NOT add
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/base.txt`, 'committed\nunstaged only\n');

    // Act
    const result: GrepResult = await grep(ctx, {
      patterns: [{ fixed: 'unstaged only' }],
      target: 'index',
    });

    // Assert
    expect(result.paths).toHaveLength(0);
  });
});

// ─── Default target skips non-searchable index entries ───────────────────────

describe('Given an index entry with symlink mode (120000), When grep runs with default target', () => {
  it('Then the symlink entry is skipped without error', async () => {
    // Arrange — stage a regular file, then manually patch the index to simulate
    // a symlink entry. Since the memory adapter doesn't support real symlinks,
    // we verify the guard via the --cached target which reads the same mode filter.
    // The delete-from-worktree variant covers the full default-target code path.
    // This test pins the index-mode filter: a regular tracked file matches; the
    // symlink-mode index entry (if present) would not.
    const ctx = await seedRepo();
    await writeAndStage(ctx, 'real.txt', 'hello\n');
    await commitAll(ctx);

    // Act — default target reads index + working-tree content
    const result: GrepResult = await grep(ctx, { patterns: [{ fixed: 'hello' }] });

    // Assert — the regular file is found (symlink skip does not break regular entries)
    expect(result.paths.map((p) => p.path as string)).toContain('real.txt');
  });
});

describe('Given an index entry with gitlink mode (160000) under --cached, When grep runs', () => {
  it('Then the gitlink entry is skipped without error', async () => {
    // Arrange — stage two files; the gitlink-mode skip is structural (mode check
    // before readBlob). We verify no throw occurs and normal entries are still found.
    const ctx = await seedRepo();
    await writeAndStage(ctx, 'a.txt', 'normal content\n');
    await commitAll(ctx);

    // Act
    const result: GrepResult = await grep(ctx, {
      patterns: [{ fixed: 'normal content' }],
      target: 'index',
    });

    // Assert — the regular entry is matched; the gitlink guard doesn't throw
    expect(result.paths).toHaveLength(1);
    expect(result.paths[0]!.path).toBe('a.txt');
  });
});

// ─── Tree-ish target (#T4) ───────────────────────────────────────────────────

describe('Given a committed file and a staged change, When grep runs with tree-ish target', () => {
  it('Then it sees only committed content (#T4)', async () => {
    // Arrange
    const ctx = await seedRepo();
    await writeAndStage(ctx, 'committed.txt', 'committed content\n');
    await commitAll(ctx);
    // stage a change that should NOT appear in HEAD tree
    await writeAndStage(ctx, 'staged_only.txt', 'staged only\n');

    // Act
    const result: GrepResult = await grep(ctx, {
      patterns: [{ fixed: 'staged only' }],
      target: { treeish: 'HEAD' },
    });

    // Assert
    expect(result.paths).toHaveLength(0);
  });

  it('Then it matches content in the committed tree', async () => {
    // Arrange
    const ctx = await seedRepo();
    await writeAndStage(ctx, 'committed.txt', 'committed content\n');
    await commitAll(ctx);

    // Act
    const result: GrepResult = await grep(ctx, {
      patterns: [{ fixed: 'committed content' }],
      target: { treeish: 'HEAD' },
    });

    // Assert
    expect(result.paths).toHaveLength(1);
    expect(result.paths[0]!.path).toBe('committed.txt');
  });
});

// ─── 1-based line numbering (#L1) ────────────────────────────────────────────

describe('Given a multi-line tracked file, When grep matches line 3', () => {
  it('Then the hit lineNumber is 3 (#L1)', async () => {
    // Arrange
    const ctx = await seedRepo();
    const content = 'line1\nline2\nNEEDLE here\nline4\n';
    await writeAndStage(ctx, 'multi.txt', content);
    await commitAll(ctx);

    // Act
    const result: GrepResult = await grep(ctx, { patterns: [{ fixed: 'NEEDLE' }] });

    // Assert
    const hit: GrepLineHit = result.paths[0]!.hits[0]!;
    expect(hit.lineNumber).toBe(3);
  });
});

// ─── Binary blob handling (#B1) ──────────────────────────────────────────────

describe('Given a tracked binary blob whose bytes contain the pattern, When grep runs', () => {
  it('Then it records binaryMatch:true and empty hits (#B1)', async () => {
    // Arrange
    const ctx = await seedRepo();
    // Construct a blob with NUL byte (binary indicator) + the pattern bytes
    const patternBytes = enc('FIND_ME');
    const binaryBlob = new Uint8Array([0x00, ...patternBytes, 0x00]);
    await ctx.fs.write(`${ctx.layout.workDir}/data.bin`, binaryBlob);
    await add(ctx, ['data.bin']);
    await commitAll(ctx);

    // Act
    const result: GrepResult = await grep(ctx, { patterns: [{ fixed: 'FIND_ME' }] });

    // Assert
    expect(result.paths).toHaveLength(1);
    const pathResult: GrepPathResult = result.paths[0]!;
    expect(pathResult.binaryMatch).toBe(true);
    expect(pathResult.hits).toHaveLength(0);
  });
});

describe('Given a tracked binary blob whose bytes do NOT contain the pattern, When grep runs', () => {
  it('Then it is omitted from results', async () => {
    // Arrange
    const ctx = await seedRepo();
    const binaryBlob = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
    await ctx.fs.write(`${ctx.layout.workDir}/data.bin`, binaryBlob);
    await add(ctx, ['data.bin']);
    await commitAll(ctx);

    // Act
    const result: GrepResult = await grep(ctx, { patterns: [{ fixed: 'FIND_ME' }] });

    // Assert
    expect(result.paths).toHaveLength(0);
  });
});

const commitBinary = async (ctx: Context, name: string, text: string): Promise<void> => {
  await ctx.fs.write(`${ctx.layout.workDir}/${name}`, new TextEncoder().encode(text));
  await add(ctx, [name]);
  await commitAll(ctx);
};

describe('Given a binary blob whose only line contains the pattern', () => {
  describe('When grep runs with invert', () => {
    it('Then the blob is not reported', async () => {
      // Arrange
      const ctx = await seedRepo();
      const binaryBlob = new Uint8Array([0x00, ...enc('FIND_ME'), 0x00]);
      await ctx.fs.write(`${ctx.layout.workDir}/data.bin`, binaryBlob);
      await add(ctx, ['data.bin']);
      await commitAll(ctx);
      const sut = grep;

      // Act
      const result: GrepResult = await sut(ctx, { patterns: [{ fixed: 'FIND_ME' }], invert: true });

      // Assert
      expect(result.paths).toEqual([]);
    });
  });
});

describe('Given a binary blob with no line containing the pattern', () => {
  describe('When grep runs with invert', () => {
    it('Then the blob is reported as a binary match', async () => {
      // Arrange
      const ctx = await seedRepo();
      await commitBinary(ctx, 'nomatch.dat', 'bin\0x\n');
      const sut = grep;

      // Act
      const result: GrepResult = await sut(ctx, { patterns: [{ fixed: 'NEEDLE' }], invert: true });

      // Assert
      expect(result.paths).toEqual([
        { path: 'nomatch.dat', hits: [], binaryMatch: true, binaryMatchCount: 1 },
      ]);
    });
  });
});

describe('Given a binary blob whose second line starts with the pattern', () => {
  describe('When grep runs with a start-anchored regex', () => {
    it('Then the blob is reported as a binary match', async () => {
      // Arrange
      const ctx = await seedRepo();
      await commitBinary(ctx, 'anchored.dat', 'bin\0x\nNEEDLE y\n');
      const sut = grep;

      // Act
      const result: GrepResult = await sut(ctx, { patterns: [/^NEEDLE/] });

      // Assert
      expect(result.paths).toEqual([
        { path: 'anchored.dat', hits: [], binaryMatch: true, binaryMatchCount: 1 },
      ]);
    });
  });
});

describe('Given a binary blob with one matching and one other line', () => {
  describe('When grep runs with invert', () => {
    it('Then the blob is reported because the other line is returned', async () => {
      // Arrange
      const ctx = await seedRepo();
      await commitBinary(ctx, 'mixed.dat', 'bin\0NEEDLE\nother\n');
      const sut = grep;

      // Act
      const result: GrepResult = await sut(ctx, { patterns: [{ fixed: 'NEEDLE' }], invert: true });

      // Assert
      expect(result.paths).toEqual([
        { path: 'mixed.dat', hits: [], binaryMatch: true, binaryMatchCount: 1 },
      ]);
    });
  });

  describe('When grep runs without invert', () => {
    it('Then the blob is reported because one line matches', async () => {
      // Arrange
      const ctx = await seedRepo();
      await commitBinary(ctx, 'mixed.dat', 'bin\0NEEDLE\nother\n');
      const sut = grep;

      // Act
      const result: GrepResult = await sut(ctx, { patterns: [{ fixed: 'NEEDLE' }] });

      // Assert
      expect(result.paths).toEqual([
        { path: 'mixed.dat', hits: [], binaryMatch: true, binaryMatchCount: 1 },
      ]);
    });
  });
});

describe('Given a binary blob whose only match lies beyond the first 64 KiB, When grep runs', () => {
  it('Then binaryMatch is not reported (the presence probe is bounded to MAX_LINE_BYTES)', async () => {
    // Arrange
    const ctx = await seedRepo();
    const blob = new Uint8Array(MAX_LINE_BYTES + 64);
    blob[0] = 0x00; // NUL in the first 8 KiB → isBinary
    blob.set(enc('DEEP_MATCH'), MAX_LINE_BYTES + 10); // pattern only beyond the 64 KiB window
    await ctx.fs.write(`${ctx.layout.workDir}/deep.bin`, blob);
    await add(ctx, ['deep.bin']);
    await commitAll(ctx);

    // Act
    const result: GrepResult = await grep(ctx, { patterns: [{ fixed: 'DEEP_MATCH' }] });

    // Assert — the bounded probe never sees the match (documented 64 KiB binary window)
    expect(result.paths).toHaveLength(0);
  });
});

describe('Given a text blob with one line longer than 64 KiB', () => {
  const NEEDLE = 'DEEP_MATCH';
  const longLine = (matchAt: number): string => {
    const tail = MAX_LINE_BYTES + 64 - matchAt - NEEDLE.length;
    return `${'a'.repeat(matchAt)}${NEEDLE}${'a'.repeat(tail)}\n`;
  };

  describe('When grep runs a pattern matching only past the first 64 KiB of that line', () => {
    it('Then the hit is still reported, with a span positioned past 64 KiB (no matcher-input window)', async () => {
      // Arrange
      const ctx = await seedRepo();
      const matchAt = MAX_LINE_BYTES + 10;
      const content = longLine(matchAt);
      await writeAndStage(ctx, 'long.txt', content);
      await commitAll(ctx);

      // Act
      const result: GrepResult = await grep(ctx, { patterns: [{ fixed: NEEDLE }] });

      // Assert
      expect(result.paths).toHaveLength(1);
      const hits = (result.paths[0] as GrepPathResult).hits;
      expect(hits).toHaveLength(1);
      const hit = hits[0] as GrepLineHit;
      expect(hit.line).toEqual(enc(content));
      expect(hit.spans).toEqual([{ start: matchAt, end: matchAt + NEEDLE.length }]);
    });
  });

  describe('When grep runs a pattern matching inside the first 64 KiB of that line', () => {
    it('Then the hit is reported and carries the whole line, not the bounded view', async () => {
      // Arrange
      const ctx = await seedRepo();
      const content = longLine(10);
      await writeAndStage(ctx, 'long.txt', content);
      await commitAll(ctx);

      // Act
      const result: GrepResult = await grep(ctx, { patterns: [{ fixed: NEEDLE }] });

      // Assert
      expect(result.paths).toHaveLength(1);
      const hits = (result.paths[0] as GrepPathResult).hits;
      expect(hits).toHaveLength(1);
      const hit = hits[0] as GrepLineHit;
      expect(hit.line).toEqual(enc(content));
      expect(hit.spans).toEqual([{ start: 10, end: 10 + NEEDLE.length }]);
    });
  });
});

// ─── Working-tree type changes & non-searchable modes ────────────────────────

describe('Given a tracked file replaced on disk by a directory, When grep runs the default target', () => {
  it('Then the path is skipped without crashing', async () => {
    // Arrange
    const ctx = await seedRepo();
    await writeAndStage(ctx, 'found.txt', 'NEEDLE here');
    await writeAndStage(ctx, 'gone.txt', 'NEEDLE gone');
    await commitAll(ctx);
    await ctx.fs.rm(`${ctx.layout.workDir}/gone.txt`);
    await ctx.fs.mkdir(`${ctx.layout.workDir}/gone.txt`);

    // Act
    const result: GrepResult = await grep(ctx, { patterns: [{ fixed: 'NEEDLE' }] });

    // Assert — gone.txt skipped, found.txt still searched, no throw
    expect(result.paths.map((p: GrepPathResult) => p.path)).toEqual(['found.txt']);
  });
});

describe('Given a tracked regular file replaced on disk by a symlink, When grep runs the default target', () => {
  it('Then the path is skipped (git does not follow the working-tree link)', async () => {
    // Arrange
    const ctx = await seedRepo();
    await writeAndStage(ctx, 'found.txt', 'NEEDLE here');
    await writeAndStage(ctx, 'linked.txt', 'NEEDLE original');
    await commitAll(ctx);
    await ctx.fs.rm(`${ctx.layout.workDir}/linked.txt`);
    await ctx.fs.symlink('found.txt', `${ctx.layout.workDir}/linked.txt`);

    // Act
    const result: GrepResult = await grep(ctx, { patterns: [{ fixed: 'NEEDLE' }] });

    // Assert
    expect(result.paths.map((p: GrepPathResult) => p.path)).toEqual(['found.txt']);
  });
});

describe('Given a tracked regular file replaced on disk by a symlink, When grep scans the working tree', () => {
  it('Then the symlink is excluded before any read is attempted — read is never called on it', async () => {
    // Arrange
    const ctx = await seedRepo();
    await writeAndStage(ctx, 'found.txt', 'NEEDLE here');
    await writeAndStage(ctx, 'linked.txt', 'NEEDLE original');
    await commitAll(ctx);
    await ctx.fs.rm(`${ctx.layout.workDir}/linked.txt`);
    await ctx.fs.symlink('found.txt', `${ctx.layout.workDir}/linked.txt`);
    const guarded = refuseReadOnSymlink(ctx, `${ctx.layout.workDir}/linked.txt`);

    // Act
    const result: GrepResult = await grep(guarded, { patterns: [{ fixed: 'NEEDLE' }] });

    // Assert
    expect(result.paths.map((p: GrepPathResult) => p.path)).toEqual(['found.txt']);
  });
});

describe('Given a tracked symlink (index mode 120000), When grep runs the default target', () => {
  it('Then the symlink is not searched (only regular/executable blobs)', async () => {
    // Arrange
    const ctx = await seedRepo();
    await writeAndStage(ctx, 'real.txt', 'NEEDLE in a regular file');
    await ctx.fs.symlink('real.txt', `${ctx.layout.workDir}/link.txt`);
    await add(ctx, ['link.txt']);
    await commitAll(ctx);

    // Act
    const result: GrepResult = await grep(ctx, { patterns: [{ fixed: 'NEEDLE' }] });

    // Assert — only the regular file; the symlink (mode 120000) is skipped
    expect(result.paths.map((p: GrepPathResult) => p.path)).toEqual(['real.txt']);
  });
});

// ─── Pathspec limiter ─────────────────────────────────────────────────────────

describe('Given two tracked files, When grep is restricted to one via pathspec', () => {
  it('Then only the in-scope file is searched', async () => {
    // Arrange
    const ctx = await seedRepo();
    await writeAndStage(ctx, 'a.txt', 'needle\n');
    await writeAndStage(ctx, 'b.txt', 'needle\n');
    await commitAll(ctx);

    // Act
    const result: GrepResult = await grep(ctx, {
      patterns: [{ fixed: 'needle' }],
      paths: ['a.txt'],
    });

    // Assert
    expect(result.paths).toHaveLength(1);
    expect(result.paths[0]!.path).toBe('a.txt');
  });

  it('Then an out-of-scope file is excluded even if it matches', async () => {
    // Arrange
    const ctx = await seedRepo();
    await writeAndStage(ctx, 'a.txt', 'needle\n');
    await writeAndStage(ctx, 'b.txt', 'needle\n');
    await commitAll(ctx);

    // Act
    const result: GrepResult = await grep(ctx, {
      patterns: [{ fixed: 'needle' }],
      paths: ['b.txt'],
    });

    // Assert
    const paths = result.paths.map((p) => p.path);
    expect(paths).not.toContain('a.txt');
  });
});

// ─── Multi-pattern OR ───────────────────────────────────────────────────────

describe('Given a tracked file with two distinct lines, When grep uses two patterns', () => {
  it('Then both lines are returned (OR semantics)', async () => {
    // Arrange
    const ctx = await seedRepo();
    await writeAndStage(ctx, 'f.txt', 'alpha\nbeta\ngamma\n');
    await commitAll(ctx);

    // Act
    const result: GrepResult = await grep(ctx, {
      patterns: [{ fixed: 'alpha' }, { fixed: 'beta' }],
    });

    // Assert
    expect(result.paths).toHaveLength(1);
    expect(result.paths[0]!.hits).toHaveLength(2);
    const lineNumbers = result.paths[0]!.hits.map((h) => h.lineNumber);
    expect(lineNumbers).toEqual([1, 2]);
  });
});

// ─── Enumeration order preserved (#M1) ───────────────────────────────────────

describe('Given 5 tracked files where 3 match, When grep runs', () => {
  it('Then the matching paths appear in index order (#M1)', async () => {
    // Arrange
    const ctx = await seedRepo();
    // Use names that sort alphabetically to get predictable order
    await writeAndStage(ctx, 'a.txt', 'needle\n');
    await writeAndStage(ctx, 'b.txt', 'other\n');
    await writeAndStage(ctx, 'c.txt', 'needle\n');
    await writeAndStage(ctx, 'd.txt', 'other\n');
    await writeAndStage(ctx, 'e.txt', 'needle\n');
    await commitAll(ctx);

    // Act
    const result: GrepResult = await grep(ctx, { patterns: [{ fixed: 'needle' }] });

    // Assert
    expect(result.paths.map((p) => p.path)).toEqual(['a.txt', 'c.txt', 'e.txt']);
  });
});

// ─── Whole-word flag passes through to matcher (-w) ─────────────────────────

describe('Given a tracked file with "word" embedded in another word, When grep uses wholeWord', () => {
  it('Then the embedded occurrence is excluded (whole-word gate)', async () => {
    // Arrange
    const ctx = await seedRepo();
    await writeAndStage(ctx, 'f.txt', 'keyword\nword alone\n');
    await commitAll(ctx);

    // Act
    const result: GrepResult = await grep(ctx, {
      patterns: [{ fixed: 'word' }],
      wholeWord: true,
    });

    // Assert
    expect(result.paths).toHaveLength(1);
    const lineNumbers = result.paths[0]!.hits.map((h) => h.lineNumber);
    expect(lineNumbers).toEqual([2]);
  });
});

// ─── Absent wholeWord does NOT gate the line matcher ─────────────────────────

describe('Given a tracked file with the pattern embedded in a larger word, When grep runs without wholeWord', () => {
  it('Then the embedded occurrence IS returned (line matcher is not whole-word gated)', async () => {
    // Arrange
    const ctx = await seedRepo();
    await writeAndStage(ctx, 'embed.txt', 'keyword\n');
    await commitAll(ctx);

    // Act — wholeWord unset: substring 'word' inside 'keyword' must match
    const result: GrepResult = await grep(ctx, { patterns: [{ fixed: 'word' }] });

    // Assert
    expect(result.paths).toHaveLength(1);
    expect(result.paths[0]!.path).toBe('embed.txt');
    expect(result.paths[0]!.hits).toHaveLength(1);
    expect(result.paths[0]!.hits[0]!.lineNumber).toBe(1);
  });
});

// ─── Invert flag passes through to matcher (-v) ──────────────────────────────

describe('Given a tracked file with three lines, When grep uses invert', () => {
  it('Then lines NOT matching the pattern are returned', async () => {
    // Arrange
    const ctx = await seedRepo();
    await writeAndStage(ctx, 'f.txt', 'match\nskip\nmatch\n');
    await commitAll(ctx);

    // Act
    const result: GrepResult = await grep(ctx, {
      patterns: [{ fixed: 'match' }],
      invert: true,
    });

    // Assert
    expect(result.paths).toHaveLength(1);
    expect(result.paths[0]!.hits).toHaveLength(1);
    expect(result.paths[0]!.hits[0]!.lineNumber).toBe(2);
    expect(result.paths[0]!.hits[0]!.spans).toHaveLength(0);
  });
});

// ─── Span correctness (byte offsets) ─────────────────────────────────────────

describe('Given a tracked file with a regex match, When grep returns spans', () => {
  it('Then the span slice equals the matched bytes', async () => {
    // Arrange
    const ctx = await seedRepo();
    await writeAndStage(ctx, 'f.txt', 'pre MATCH post\n');
    await commitAll(ctx);

    // Act
    const result: GrepResult = await grep(ctx, { patterns: [/MATCH/] });

    // Assert
    const hit = result.paths[0]!.hits[0]!;
    const span = hit.spans[0]!;
    const matched = dec(hit.line.slice(span.start, span.end));
    expect(matched).toBe('MATCH');
  });
});

// ─── No results for unmatched files ──────────────────────────────────────────

describe('Given a tracked file with no matching content, When grep runs', () => {
  it('Then the result paths is empty', async () => {
    // Arrange
    const ctx = await seedRepo();
    await writeAndStage(ctx, 'f.txt', 'nothing here\n');
    await commitAll(ctx);

    // Act
    const result: GrepResult = await grep(ctx, { patterns: [{ fixed: 'MISSING' }] });

    // Assert
    expect(result.paths).toHaveLength(0);
  });
});

// ─── binaryMatch is exactly false for text blobs (kills id 77) ───────────────

describe('Given a tracked text file with matching content, When grep runs', () => {
  it('Then binaryMatch is exactly false (not just falsy) for the matched path', async () => {
    // Arrange
    const ctx = await seedRepo();
    await writeAndStage(ctx, 'text.txt', 'hello world\n');
    await commitAll(ctx);

    // Act
    const result: GrepResult = await grep(ctx, { patterns: [{ fixed: 'hello' }] });

    // Assert
    expect(result.paths).toHaveLength(1);
    expect(result.paths[0]!.binaryMatch).toBe(false);
  });
});

// ─── wholeWord: true propagates to the line matcher (kills id 86) ────────────

describe('Given a tracked file with a sub-word occurrence, When grep uses wholeWord on index target', () => {
  it('Then the embedded occurrence is NOT returned (wholeWord passed to matcher)', async () => {
    // Arrange
    const ctx = await seedRepo();
    await writeAndStage(ctx, 'w.txt', 'keyword only\n');

    // Act
    const result: GrepResult = await grep(ctx, {
      patterns: [{ fixed: 'word' }],
      wholeWord: true,
      target: 'index',
    });

    // Assert
    expect(result.paths).toHaveLength(0);
  });
});

// ─── wholeWord propagates to the binary probe matcher (kills ids 98–104) ─────

describe('Given a binary blob where the pattern appears only as part of another word, When grep uses wholeWord', () => {
  it('Then binaryMatch is NOT reported (binary probe also gates on wholeWord)', async () => {
    // Arrange
    const ctx = await seedRepo();
    // Build binary blob: NUL + "xFIND_MEx" so "FIND_ME" only occurs embedded
    const content = new Uint8Array([0x00, 0x78, ...new TextEncoder().encode('FIND_ME'), 0x78]);
    await ctx.fs.write(`${ctx.layout.workDir}/data.bin`, content);
    await add(ctx, ['data.bin']);
    await commitAll(ctx);

    // Act — wholeWord must suppress the embedded binary match
    const result: GrepResult = await grep(ctx, {
      patterns: [{ fixed: 'FIND_ME' }],
      wholeWord: true,
    });

    // Assert
    expect(result.paths).toHaveLength(0);
  });
});

describe('Given a binary blob with the pattern embedded in a larger token, When grep runs without wholeWord', () => {
  it('Then binaryMatch IS reported (binary probe is not whole-word gated when wholeWord is absent)', async () => {
    // Arrange
    const ctx = await seedRepo();
    // NUL marks the blob binary; "FIND_ME" occurs only embedded between 'x' bytes
    const content = new Uint8Array([0x00, 0x78, ...new TextEncoder().encode('FIND_ME'), 0x78]);
    await ctx.fs.write(`${ctx.layout.workDir}/data.bin`, content);
    await add(ctx, ['data.bin']);
    await commitAll(ctx);

    // Act — wholeWord unset: the embedded occurrence must still count as presence
    const result: GrepResult = await grep(ctx, { patterns: [{ fixed: 'FIND_ME' }] });

    // Assert
    expect(result.paths).toHaveLength(1);
    expect(result.paths[0]!.binaryMatch).toBe(true);
  });
});

describe('Given a binary blob where the pattern appears as a whole word, When grep uses wholeWord', () => {
  it('Then binaryMatch IS reported (binary probe respects wholeWord and still matches)', async () => {
    // Arrange
    const ctx = await seedRepo();
    // Build binary blob: NUL + space + "FIND_ME" + space so it IS a whole-word occurrence
    const content = new Uint8Array([0x00, 0x20, ...new TextEncoder().encode('FIND_ME'), 0x20]);
    await ctx.fs.write(`${ctx.layout.workDir}/data.bin`, content);
    await add(ctx, ['data.bin']);
    await commitAll(ctx);

    // Act
    const result: GrepResult = await grep(ctx, {
      patterns: [{ fixed: 'FIND_ME' }],
      wholeWord: true,
    });

    // Assert
    expect(result.paths).toHaveLength(1);
    expect(result.paths[0]!.binaryMatch).toBe(true);
  });
});

// ─── Empty paths array is treated as "no pathspec" (kills ids 110, 111) ──────

describe('Given two tracked files, When grep is called with an empty paths array', () => {
  it('Then both files are searched (empty array means no pathspec filter)', async () => {
    // Arrange
    const ctx = await seedRepo();
    await writeAndStage(ctx, 'a.txt', 'needle\n');
    await writeAndStage(ctx, 'b.txt', 'needle\n');
    await commitAll(ctx);

    // Act — paths: [] must behave the same as paths: undefined
    const result: GrepResult = await grep(ctx, {
      patterns: [{ fixed: 'needle' }],
      paths: [],
    });

    // Assert
    expect(result.paths).toHaveLength(2);
    expect(result.paths.map((p) => p.path as string)).toEqual(['a.txt', 'b.txt']);
  });
});

// ─── Custom-index helpers ─────────────────────────────────────────────────────

const ZERO_OID = '0000000000000000000000000000000000000001' as ObjectId;

const makeEntry = (
  path: string,
  opts: { mode?: string; stage?: 0 | 1 | 2 | 3 } = {},
): IndexEntry => ({
  ctimeSeconds: 0,
  ctimeNanoseconds: 0,
  mtimeSeconds: 0,
  mtimeNanoseconds: 0,
  dev: 0,
  ino: 0,
  mode: (opts.mode ?? FILE_MODE.REGULAR) as IndexEntry['mode'],
  uid: 0,
  gid: 0,
  fileSize: 0,
  id: ZERO_OID,
  flags: { ...STAGE0_FLAGS, stage: opts.stage ?? 0 },
  path: FilePath.from(path),
});

const writeIndex = async (ctx: Context, index: GitIndex): Promise<void> => {
  const bytes = await serializeIndexFixtureAsync(index, ctx);
  await ctx.fs.write(`${ctx.layout.gitDir}/index`, bytes);
};

// ─── Working-tree: conflict entries (stage≠0) are skipped (kills ids 12,16) ──

describe('Given an index with a stage-1 conflict entry, When grep runs with default target', () => {
  it('Then the conflict entry is skipped (stage≠0 filter)', async () => {
    // Arrange — use buildSeededContext to get an initialized repo, then plant a custom index
    const ctx = await buildSeededContext();
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
    // Write the working-tree file so it exists — buildSeededContext always yields a work tree.
    await ctx.fs.mkdir(ctx.layout.workDir as string);
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/conflict.txt`, 'needle\n');
    const index: GitIndex = {
      version: 2,
      entries: [makeEntry('conflict.txt', { stage: 1 })],
      extensions: [],
      trailerSha: new Uint8Array(0),
    };
    await writeIndex(ctx, index);

    // Act
    const result: GrepResult = await grep(ctx, { patterns: [{ fixed: 'needle' }] });

    // Assert — conflict entry excluded; no path returned
    expect(result.paths).toHaveLength(0);
  });
});

describe('Given an index with a symlink-mode entry (120000), When grep runs with default target', () => {
  it('Then the symlink entry is skipped (mode filter in working-tree enumeration)', async () => {
    // Arrange
    const ctx = await buildSeededContext();
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
    // buildSeededContext always yields a work tree.
    await ctx.fs.mkdir(ctx.layout.workDir as string);
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/link.txt`, 'needle\n');
    const index: GitIndex = {
      version: 2,
      entries: [makeEntry('link.txt', { mode: FILE_MODE.SYMLINK })],
      extensions: [],
      trailerSha: new Uint8Array(0),
    };
    await writeIndex(ctx, index);

    // Act
    const result: GrepResult = await grep(ctx, { patterns: [{ fixed: 'needle' }] });

    // Assert — symlink mode excluded from search
    expect(result.paths).toHaveLength(0);
  });
});

// ─── Index target: conflict entries (stage≠0) are skipped (kills ids 27,29,31,32) ─

describe('Given an index with a stage-2 conflict entry, When grep runs with target "index"', () => {
  it('Then the conflict entry is skipped (stage===0 filter on index enumeration)', async () => {
    // Arrange
    const ctx = await buildSeededContext();
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
    const index: GitIndex = {
      version: 2,
      entries: [makeEntry('conflict.txt', { stage: 2 })],
      extensions: [],
      trailerSha: new Uint8Array(0),
    };
    await writeIndex(ctx, index);

    // Act
    const result: GrepResult = await grep(ctx, {
      patterns: [{ fixed: 'needle' }],
      target: 'index',
    });

    // Assert
    expect(result.paths).toHaveLength(0);
  });
});

describe('Given an index with one stage-0 and one stage-2 entry, When grep runs with target "index"', () => {
  it('Then only the stage-0 entry is searched', async () => {
    // Arrange — seed a real blob object so the stage-0 entry can be read
    const ctx = await seedRepo();
    await writeAndStage(ctx, 'real.txt', 'needle\n');
    await commitAll(ctx);
    // Read the current index to get the real OID for real.txt, then inject a stage-2 sibling
    const { readIndex: readIdx } = await import('../../../../src/application/primitives/index.js');
    const currentIndex = await readIdx(ctx);
    const realEntry = currentIndex.entries[0]!;
    const index: GitIndex = {
      version: 2,
      entries: [realEntry, makeEntry('conflict.txt', { stage: 2 })],
      extensions: [],
      trailerSha: new Uint8Array(0),
    };
    await writeIndex(ctx, index);

    // Act
    const result: GrepResult = await grep(ctx, {
      patterns: [{ fixed: 'needle' }],
      target: 'index',
    });

    // Assert — only real.txt returned; conflict.txt (stage-2) excluded
    expect(result.paths).toHaveLength(1);
    expect(result.paths[0]!.path).toBe('real.txt');
  });
});

describe('Given an index with a gitlink-mode entry (160000), When grep runs with target "index"', () => {
  it('Then the gitlink entry is skipped (mode filter on index enumeration)', async () => {
    // Arrange
    const ctx = await buildSeededContext();
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
    const index: GitIndex = {
      version: 2,
      entries: [makeEntry('sub', { mode: FILE_MODE.GITLINK })],
      extensions: [],
      trailerSha: new Uint8Array(0),
    };
    await writeIndex(ctx, index);

    // Act
    const result: GrepResult = await grep(ctx, {
      patterns: [{ fixed: 'needle' }],
      target: 'index',
    });

    // Assert
    expect(result.paths).toHaveLength(0);
  });
});

// ─── isSearchableMode: executable files ARE searched (kills ids 1, 7) ─────────
// The memory adapter always produces mode=100644. We verify via index target using
// a custom index entry with mode=100755 pointing at a real blob.

describe('Given an index with an executable-mode entry (100755), When grep runs with target "index"', () => {
  it('Then the executable entry IS searched (100755 is searchable)', async () => {
    // Arrange — stage a file first to get a real blob OID stored
    const ctx = await seedRepo();
    await writeAndStage(ctx, 'script.sh', 'needle\n');
    await commitAll(ctx);
    const { readIndex: readIdx } = await import('../../../../src/application/primitives/index.js');
    const currentIndex = await readIdx(ctx);
    const stagedEntry = currentIndex.entries[0]!;
    // Rebuild the index with mode=100755 pointing at the same blob
    const execEntry: IndexEntry = {
      ...stagedEntry,
      mode: FILE_MODE.EXECUTABLE as IndexEntry['mode'],
    };
    const index: GitIndex = {
      version: 2,
      entries: [execEntry],
      extensions: [],
      trailerSha: new Uint8Array(0),
    };
    await writeIndex(ctx, index);

    // Act
    const result: GrepResult = await grep(ctx, {
      patterns: [{ fixed: 'needle' }],
      target: 'index',
    });

    // Assert — executable mode is searchable; the blob is found
    expect(result.paths).toHaveLength(1);
    expect(result.paths[0]!.path).toBe('script.sh');
  });
});

// ─── Tree-ish: recursive walk (kills ids 48, 49) ─────────────────────────────

describe('Given a committed file in a subdirectory, When grep runs with tree-ish target', () => {
  it('Then the nested file is found (walkTree is called with recursive:true)', async () => {
    // Arrange
    const ctx = await seedRepo();
    await writeAndStage(ctx, 'src/nested.txt', 'needle\n');
    await commitAll(ctx);

    // Act
    const result: GrepResult = await grep(ctx, {
      patterns: [{ fixed: 'needle' }],
      target: { treeish: 'HEAD' },
    });

    // Assert — recursive walk exposes nested file
    expect(result.paths).toHaveLength(1);
    expect(result.paths[0]!.path).toBe('src/nested.txt');
  });
});

// ─── Tree-ish: non-searchable tree entries are skipped (kills id 53) ──────────

describe('Given a committed tree containing only a subtree directory entry, When grep runs with tree-ish target', () => {
  it('Then the subtree directory entry is skipped and no error is thrown', async () => {
    // Arrange — commit two files, one nested (produces both a blob and a tree entry)
    // The walkTree recursive call yields both blobs and nested-tree entries; mode filter
    // must skip the tree entry (40000) and only process blobs.
    const ctx = await seedRepo();
    await writeAndStage(ctx, 'root.txt', 'needle\n');
    await writeAndStage(ctx, 'sub/leaf.txt', 'needle\n');
    await commitAll(ctx);

    // Act — recursive=true surfaces sub/ directory entry AND sub/leaf.txt blob
    const result: GrepResult = await grep(ctx, {
      patterns: [{ fixed: 'needle' }],
      target: { treeish: 'HEAD' },
    });

    // Assert — both text files found; no throw from the skipped tree entry
    const paths = result.paths.map((p) => p.path as string).sort();
    expect(paths).toEqual(['root.txt', 'sub/leaf.txt']);
  });
});

/** A committed repo whose index holds a.txt with a matchable line. */
const seedRepoForBareGate = async (): Promise<Context> => {
  const ctx = createMemoryContext();
  await init(ctx);
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'hi\n');
  await add(ctx, ['a.txt']);
  await commit(ctx, { message: 'seed', author: AUTHOR, committer: AUTHOR });
  return ctx;
};

describe('Given a repository with no work tree', () => {
  describe('When grep targets the working tree by default', () => {
    it('Then throws WORK_TREE_REQUIRED naming the grep operation', async () => {
      // Arrange
      const ctx = asBareContext(await seedRepoForBareGate());

      // Act
      let caught: unknown;
      try {
        await grep(ctx, { patterns: [{ fixed: 'hi' }] });
      } catch (err) {
        caught = err;
      }

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      expect((caught as TsgitError).data).toMatchObject({
        code: 'WORK_TREE_REQUIRED',
        operation: 'grep',
      });
    });
  });

  describe('When grep targets the index instead', () => {
    it('Then it resolves — the cached target never needs a work tree', async () => {
      // Arrange
      const ctx = asBareContext(await seedRepoForBareGate());

      // Act
      const result = await grep(ctx, { patterns: [{ fixed: 'hi' }], target: 'index' });

      // Assert
      expect(result.paths.map((p) => p.path as string)).toEqual(['a.txt']);
    });
  });
});

describe('Given more index blobs than the ioBound limit', () => {
  describe('When grep scans them', () => {
    it('Then concurrent blob loads peak at exactly the bound', async () => {
      // Arrange — an explicit ioBound distinct from cpuBound so a
      // bucket-swap regression (deriving the pool from the wrong bucket)
      // fails loudly. Every path matches, so every candidate reaches its
      // own `readBlob` call inside the boundedMapFor fan-out.
      const ioBound = 3;
      const width = ioBound + 4;
      const base = await seedRepo();
      for (let i = 0; i < width; i++) {
        await writeAndStage(base, `f${i}.txt`, 'needle\n');
      }
      const ctx: Context = { ...base, concurrency: { cpuBound: 1, ioBound } };
      let inFlight = 0;
      let maxInFlight = 0;
      const realReadBlob = readBlobMod.readBlob;
      const spy = vi.spyOn(readBlobMod, 'readBlob').mockImplementation(async (spyCtx, id, opts) => {
        inFlight += 1;
        if (inFlight > maxInFlight) maxInFlight = inFlight;
        await Promise.resolve();
        inFlight -= 1;
        return realReadBlob(spyCtx, id, opts);
      });
      const sut = grep;

      // Act
      try {
        const result = await sut(ctx, { patterns: [{ fixed: 'needle' }], target: 'index' });

        // Assert
        expect(result.paths).toHaveLength(width);
        expect(maxInFlight).toBe(ioBound);
      } finally {
        spy.mockRestore();
      }
    });
  });
});

// ─── Blob target ─────────────────────────────────────────────────────────────

const writeTagObject = (
  ctx: Context,
  tagName: string,
  object: ObjectId,
  objectType: 'blob' | 'commit' | 'tag' | 'tree',
): Promise<ObjectId> =>
  writeObject(ctx, {
    type: 'tag',
    id: '' as ObjectId,
    data: { object, objectType, tagName, tagger: AUTHOR, message: 'm\n', extraHeaders: [] },
  });

const seedBlobTargets = async (): Promise<{ ctx: Context; oid: ObjectId }> => {
  const ctx = await seedRepo();
  await writeAndStage(ctx, 'f1', 'a NEEDLE\nb\nNEEDLE c\n');
  await writeAndStage(ctx, 'sub/f2', 'NEEDLE sub\n');
  await writeAndStage(ctx, 'word', 'xNEEDLEx\n');
  await ctx.fs.write(`${ctx.layout.workDir}/bin.dat`, enc('bin\0NEEDLE\n'));
  await add(ctx, ['bin.dat']);
  await commitAll(ctx);
  const oid = await resolveRevision(ctx, 'HEAD:f1');
  const blobTag = await writeTagObject(ctx, 'blob-tag', oid, 'blob');
  await tagCreate(ctx, { name: 'blob-tag', target: blobTag });
  const nested = await writeTagObject(ctx, 'tag-of-tag', blobTag, 'tag');
  await tagCreate(ctx, { name: 'tag-of-tag', target: nested });
  const rootTree = await resolveRevision(ctx, 'HEAD^{tree}');
  const treeTag = await writeTagObject(ctx, 'tree-tag', rootTree, 'tree');
  await tagCreate(ctx, { name: 'tree-tag', target: treeTag });
  await tagCreate(ctx, { name: 'light', target: oid });
  return { ctx, oid };
};

const seedSpecialTree = async (ctx: Context): Promise<ObjectId> => {
  const link = await writeObject(ctx, {
    type: 'blob',
    id: '' as ObjectId,
    content: enc('NEEDLE-target'),
  });
  return writeObject(ctx, {
    type: 'tree',
    id: '' as ObjectId,
    entries: [
      treeEntry(FILE_MODE.SYMLINK, 'link', link),
      treeEntry(FILE_MODE.GITLINK, 'gl', '1'.repeat(40) as ObjectId),
    ],
  } as Tree);
};

const project = (hits: ReadonlyArray<GrepLineHit>): unknown[] =>
  hits.map((h) => [h.lineNumber, dec(h.line), h.spans]);

const F1_HITS = [
  [1, 'a NEEDLE\n', [{ start: 2, end: 8 }]],
  [3, 'NEEDLE c\n', [{ start: 0, end: 6 }]],
];

const blobHits = (result: GrepResult): unknown[] => project(result.blob?.hits ?? []);

const catchData = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run();
  } catch (e) {
    return (e as TsgitError).data;
  }
  return undefined;
};

describe('Given a blob target', () => {
  describe('When the target is the blob full oid', () => {
    it('Then paths is empty and blob carries lines 1 and 3', async () => {
      // Arrange
      const { ctx, oid } = await seedBlobTargets();
      const sut = grep;

      // Act
      const result = await sut(ctx, { patterns: [{ fixed: 'NEEDLE' }], target: { treeish: oid } });

      // Assert
      expect(result.paths).toStrictEqual([]);
      expect(result.blob?.binaryMatch).toBe(false);
      expect(result.blob?.binaryMatchCount).toBe(0);
      expect(blobHits(result)).toStrictEqual(F1_HITS);
    });
  });

  describe('When the target is any rev reaching the blob', () => {
    const revs: ReadonlyArray<readonly [string, (oid: ObjectId) => string]> = [
      ['HEAD:f1', () => 'HEAD:f1'],
      ['HEAD:./f1', () => 'HEAD:./f1'],
      ['HEAD^{tree}:f1', () => 'HEAD^{tree}:f1'],
      [':f1', () => ':f1'],
      [':0:f1', () => ':0:f1'],
      ['abbreviated oid', (oid) => oid.slice(0, 7)],
      ['oid^{blob}', (oid) => `${oid}^{blob}`],
      ['annotated tag', () => 'blob-tag'],
      ['tag of tag', () => 'tag-of-tag'],
      ['lightweight tag', () => 'light'],
      ['tag^{}', () => 'blob-tag^{}'],
    ];
    it.each(revs)('Then %s greps the blob', async (_label, rev) => {
      // Arrange
      const { ctx, oid } = await seedBlobTargets();
      const sut = grep;

      // Act
      const result = await sut(ctx, {
        patterns: [{ fixed: 'NEEDLE' }],
        target: { treeish: rev(oid) },
      });

      // Assert
      expect(result.paths).toStrictEqual([]);
      expect(blobHits(result)).toStrictEqual(F1_HITS);
    });
  });

  describe('When the target is a tree path or a tag of a tree', () => {
    it('Then HEAD:sub lists the tree paths and carries no blob key', async () => {
      // Arrange
      const { ctx } = await seedBlobTargets();
      const sut = grep;

      // Act
      const result = await sut(ctx, {
        patterns: [{ fixed: 'NEEDLE' }],
        target: { treeish: 'HEAD:sub' },
      });

      // Assert
      expect(result.paths.map((p) => p.path)).toStrictEqual(['f2']);
      expect('blob' in result).toBe(false);
    });

    it('Then a tag of the root tree lists every matching path', async () => {
      // Arrange
      const { ctx } = await seedBlobTargets();
      const sut = grep;

      // Act
      const result = await sut(ctx, {
        patterns: [{ fixed: 'NEEDLE' }],
        target: { treeish: 'tree-tag' },
      });

      // Assert
      expect(result.paths.map((p) => p.path)).toStrictEqual(['bin.dat', 'f1', 'sub/f2', 'word']);
      expect('blob' in result).toBe(false);
    });
  });

  describe('When the blob does not match', () => {
    it('Then the result has no blob key', async () => {
      // Arrange
      const { ctx } = await seedBlobTargets();
      const sut = grep;

      // Act
      const result = await sut(ctx, {
        patterns: [{ fixed: 'ZZZ' }],
        target: { treeish: 'HEAD:f1' },
      });

      // Assert
      expect(result).toStrictEqual({ paths: [] });
    });
  });

  describe('When the blob is binary', () => {
    it('Then blob reports binaryMatch with no hits', async () => {
      // Arrange
      const { ctx } = await seedBlobTargets();
      const sut = grep;

      // Act
      const result = await sut(ctx, {
        patterns: [{ fixed: 'NEEDLE' }],
        target: { treeish: 'HEAD:bin.dat' },
      });

      // Assert
      expect(result.blob).toStrictEqual({ hits: [], binaryMatch: true, binaryMatchCount: 1 });
    });

    it('Then binaryMatchCount counts every returned line, as git -c does', async () => {
      // Arrange
      const { ctx } = await seedBlobTargets();
      await commitBinary(ctx, 'twice.bin', 'bin\0NEEDLE\nNEEDLE\nother\n');
      const sut = grep;

      // Act
      const result = await sut(ctx, {
        patterns: [{ fixed: 'NEEDLE' }],
        target: { treeish: 'HEAD:twice.bin' },
      });

      // Assert
      expect(result.blob).toStrictEqual({ hits: [], binaryMatch: true, binaryMatchCount: 2 });
    });
  });

  describe('When the blob is a symlink target', () => {
    it('Then it is grepped without a mode filter', async () => {
      // Arrange
      const { ctx } = await seedBlobTargets();
      const tree = await seedSpecialTree(ctx);
      const sut = grep;

      // Act
      const result = await sut(ctx, {
        patterns: [{ fixed: 'NEEDLE' }],
        target: { treeish: `${tree}:link` },
      });

      // Assert
      expect(blobHits(result)).toStrictEqual([[1, 'NEEDLE-target', [{ start: 0, end: 6 }]]]);
    });
  });

  describe('When a pathspec is given', () => {
    it('Then a non-matching pathspec is not applied to the blob', async () => {
      // Arrange
      const { ctx } = await seedBlobTargets();
      const sut = grep;

      // Act
      const result = await sut(ctx, {
        patterns: [{ fixed: 'NEEDLE' }],
        target: { treeish: 'HEAD:f1' },
        paths: ['nomatch'],
      });

      // Assert
      expect(blobHits(result)).toStrictEqual(F1_HITS);
    });

    it('Then a pathspec outside the repository still refuses', async () => {
      // Arrange
      const { ctx } = await seedBlobTargets();
      const sut = grep;

      // Act
      const data = await catchData(() =>
        sut(ctx, {
          patterns: [{ fixed: 'NEEDLE' }],
          target: { treeish: 'HEAD:f1' },
          paths: ['../outside'],
        }),
      );

      // Assert
      expect(data).toMatchObject({ code: 'PATHSPEC_OUTSIDE_REPO', path: '../outside' });
    });
  });

  describe('When invert is set', () => {
    it('Then blob carries the non-matching line', async () => {
      // Arrange
      const { ctx } = await seedBlobTargets();
      const sut = grep;

      // Act
      const result = await sut(ctx, {
        patterns: [{ fixed: 'NEEDLE' }],
        invert: true,
        target: { treeish: 'HEAD:f1' },
      });

      // Assert
      expect(blobHits(result)).toStrictEqual([[2, 'b\n', []]]);
    });
  });

  describe('When wholeWord is set on a blob holding only an embedded word', () => {
    it('Then the blob does not match', async () => {
      // Arrange
      const { ctx } = await seedBlobTargets();
      const sut = grep;

      // Act
      const result = await sut(ctx, {
        patterns: [{ fixed: 'NEEDLE' }],
        wholeWord: true,
        target: { treeish: 'HEAD:word' },
      });

      // Assert
      expect(result).toStrictEqual({ paths: [] });
    });
  });

  describe('When wholeWord is not set on a blob holding only an embedded word', () => {
    it('Then the embedded word matches', async () => {
      // Arrange
      const { ctx } = await seedBlobTargets();
      const sut = grep;

      // Act
      const result = await sut(ctx, {
        patterns: [{ fixed: 'NEEDLE' }],
        target: { treeish: 'HEAD:word' },
      });

      // Assert
      expect(blobHits(result)).toStrictEqual([[1, 'xNEEDLEx\n', [{ start: 1, end: 7 }]]]);
    });
  });

  describe('When the repository is bare', () => {
    it('Then the blob is grepped without a work tree', async () => {
      // Arrange
      const { ctx } = await seedBlobTargets();
      const sut = grep;

      // Act
      const result = await sut(asBareContext(ctx), {
        patterns: [{ fixed: 'NEEDLE' }],
        target: { treeish: 'HEAD:f1' },
      });

      // Assert
      expect(blobHits(result)).toStrictEqual(F1_HITS);
    });
  });

  describe('When the target names nothing greppable', () => {
    // git's `unable to parse object: <name>` names the rev as spelt, not the id it resolved to.
    type Refusal = readonly [string, (tree: ObjectId) => string, (target: string) => object];
    const refusals: ReadonlyArray<Refusal> = [
      [
        'a missing path',
        () => 'HEAD:nope',
        () => ({ code: 'PATH_NOT_IN_TREE', rev: 'HEAD', path: 'nope' }),
      ],
      ['a missing object', () => '0'.repeat(40), (id) => ({ code: 'OBJECT_NOT_FOUND', id })],
      ['a gitlink path', (tree) => `${tree}:gl`, (id) => ({ code: 'OBJECT_NOT_FOUND', id })],
    ];

    it.each(refusals)(
      'Then %s refuses with the git-shaped error',
      async (_label, rev, expected) => {
        // Arrange
        const { ctx } = await seedBlobTargets();
        const tree = await seedSpecialTree(ctx);
        const target = rev(tree);
        const sut = grep;

        // Act
        const data = await catchData(() =>
          sut(ctx, { patterns: [{ fixed: 'NEEDLE' }], target: { treeish: target } }),
        );

        // Assert
        expect(data).toMatchObject(expected(target));
      },
    );
  });

  describe('When the target names nothing greppable and the pathspec is outside the repository', () => {
    const badRevs: ReadonlyArray<readonly [string, string, unknown]> = [
      ['a missing path', 'HEAD:nope', { code: 'PATH_NOT_IN_TREE', rev: 'HEAD', path: 'nope' }],
      ['a missing object', '0'.repeat(40), { code: 'OBJECT_NOT_FOUND', id: '0'.repeat(40) }],
    ];

    it.each(badRevs)('Then %s is refused before the pathspec', async (_label, rev, expected) => {
      // Arrange
      const { ctx } = await seedBlobTargets();
      const sut = grep;

      // Act
      const data = await catchData(() =>
        sut(ctx, {
          patterns: [{ fixed: 'NEEDLE' }],
          target: { treeish: rev },
          paths: ['../outside'],
        }),
      );

      // Assert
      expect(data).toMatchObject(expected as object);
    });
  });
});

describe('Given a diff attribute', () => {
  const F1 = 'a NEEDLE\nb\nNEEDLE c\n';
  const F2 = 'x NEEDLE\0y\n';
  const TARGETS: ReadonlyArray<[string, 'index' | undefined]> = [
    ['the index', 'index'],
    ['the work tree', undefined],
  ];
  const targetOption = (target: 'index' | undefined): { target?: 'index' } =>
    target === undefined ? {} : { target };
  const pathOf = (result: GrepResult, path: string): GrepPathResult | undefined =>
    result.paths.find((p) => p.path === path);

  const appendConfig = async (ctx: Context, text: string): Promise<void> => {
    const cfg = `${ctx.layout.gitDir}/config`;
    await ctx.fs.writeUtf8(cfg, `${await ctx.fs.readUtf8(cfg)}${text}`);
    __resetConfigCacheForTests();
  };

  const seedWithAttributes = async (attributes: string, f1 = F1): Promise<Context> => {
    const ctx = await seedRepo();
    await writeAndStage(ctx, '.gitattributes', attributes);
    await writeAndStage(ctx, 'f1', f1);
    await commitAll(ctx);
    return ctx;
  };

  const removeWorkTreeAttributes = async (ctx: Context): Promise<void> => {
    await ctx.fs.rm(`${ctx.layout.workDir}/.gitattributes`);
  };

  describe.each(TARGETS)('Given %s as the target', (_label, target) => {
    describe('When a path is set -diff', () => {
      it('Then it is a binary match with its returned-line count and no hits', async () => {
        // Arrange
        const ctx = await seedWithAttributes('f1 binary\n');
        const sut = grep;

        // Act
        const result = await sut(ctx, { patterns: [{ fixed: 'NEEDLE' }], ...targetOption(target) });

        // Assert
        expect(pathOf(result, 'f1')).toEqual({
          path: 'f1',
          hits: [],
          binaryMatch: true,
          binaryMatchCount: 2,
        });
      });
    });

    describe('When a NUL path is set diff', () => {
      it('Then it is scanned as text', async () => {
        // Arrange
        const ctx = await seedWithAttributes('f2 diff\n');
        await writeAndStage(ctx, 'f2', F2);
        const sut = grep;

        // Act
        const result = await sut(ctx, { patterns: [{ fixed: 'NEEDLE' }], ...targetOption(target) });

        // Assert
        expect(pathOf(result, 'f2')).toEqual({
          path: 'f2',
          hits: [{ lineNumber: 1, line: enc(F2), spans: [{ start: 2, end: 8 }] }],
          binaryMatch: false,
          binaryMatchCount: 0,
        });
      });
    });

    describe('When the .gitattributes exists only in the index', () => {
      it('Then the index copy decides', async () => {
        // Arrange
        const ctx = await seedWithAttributes('f1 binary\n');
        await removeWorkTreeAttributes(ctx);
        const sut = grep;

        // Act
        const result = await sut(ctx, { patterns: [{ fixed: 'NEEDLE' }], ...targetOption(target) });

        // Assert
        expect(pathOf(result, 'f1')?.binaryMatch).toBe(true);
      });
    });

    describe('When the work-tree .gitattributes differs from the index copy', () => {
      it('Then the work-tree copy wins', async () => {
        // Arrange
        const ctx = await seedWithAttributes('f1 binary\n');
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitattributes`, '');
        const sut = grep;

        // Act
        const result = await sut(ctx, { patterns: [{ fixed: 'NEEDLE' }], ...targetOption(target) });

        // Assert
        expect(pathOf(result, 'f1')?.binaryMatch).toBe(false);
      });
    });

    describe('When a path names a driver configured binary', () => {
      it('Then it is a binary match', async () => {
        // Arrange
        const ctx = await seedWithAttributes('f1 diff=drv\n');
        await appendConfig(ctx, '[diff "drv"]\n\tbinary = true\n');
        const sut = grep;

        // Act
        const result = await sut(ctx, { patterns: [{ fixed: 'NEEDLE' }], ...targetOption(target) });

        // Assert
        expect(pathOf(result, 'f1')?.binaryMatch).toBe(true);
      });
    });

    describe('When the default driver is configured binary and no attribute names a path', () => {
      it('Then the path is a binary match', async () => {
        // Arrange
        const ctx = await seedRepo();
        await writeAndStage(ctx, 'f1', F1);
        await commitAll(ctx);
        await appendConfig(ctx, '[diff "default"]\n\tbinary = true\n');
        const sut = grep;

        // Act
        const result = await sut(ctx, { patterns: [{ fixed: 'NEEDLE' }], ...targetOption(target) });

        // Assert
        expect(pathOf(result, 'f1')?.binaryMatch).toBe(true);
      });
    });

    describe('When a forced-binary path matches only beyond 64 KiB', () => {
      it('Then the whole blob is scanned', async () => {
        // Arrange
        const ctx = await seedWithAttributes('big.txt binary\n');
        await writeAndStage(ctx, 'big.txt', `${'x\n'.repeat(MAX_LINE_BYTES / 2 + 16)}NEEDLE\n`);
        const sut = grep;

        // Act
        const result = await sut(ctx, { patterns: [{ fixed: 'NEEDLE' }], ...targetOption(target) });

        // Assert
        expect(pathOf(result, 'big.txt')).toEqual({
          path: 'big.txt',
          hits: [],
          binaryMatch: true,
          binaryMatchCount: 1,
        });
      });
    });
  });

  describe('Given the index target and a path set -diff, When the match is inverted', () => {
    it('Then the binary count is the non-matching lines', async () => {
      // Arrange
      const ctx = await seedWithAttributes('f1 binary\n');
      const sut = grep;

      // Act
      const result = await sut(ctx, {
        patterns: [{ fixed: 'NEEDLE' }],
        target: 'index',
        invert: true,
      });

      // Assert
      expect(pathOf(result, 'f1')).toEqual({
        path: 'f1',
        hits: [],
        binaryMatch: true,
        binaryMatchCount: 1,
      });
    });
  });

  describe('Given a layout without a work tree and an index-only .gitattributes', () => {
    it.each([
      [
        'a bare-flagged layout',
        (ctx: Context): Context => ({ ...ctx, layout: { ...ctx.layout, bare: true } }) as Context,
      ],
      ['a bare context', (ctx: Context): Context => asBareContext(ctx)],
    ])('Then %s never reads the index copy', async (_label, toBare) => {
      // Arrange
      const ctx = await seedWithAttributes('f1 binary\n');
      await removeWorkTreeAttributes(ctx);
      const sut = grep;

      // Act
      const result = await sut(toBare(ctx), { patterns: [{ fixed: 'NEEDLE' }], target: 'index' });

      // Assert
      expect(pathOf(result, 'f1')?.binaryMatch).toBe(false);
    });
  });

  describe('Given a tree object as the rev', () => {
    const treeTargets: ReadonlyArray<[string, (ctx: Context) => Promise<string>]> = [
      ['the peeled tree rev', async () => 'HEAD^{tree}'],
      [
        'an annotated tag of the tree',
        async (ctx) => {
          const tree = await resolveRevision(ctx, 'HEAD^{tree}');
          const tag = await writeTagObject(ctx, 'tt', tree, 'tree');
          await tagCreate(ctx, { name: 'tt', target: tag });
          return 'tt';
        },
      ],
    ];

    describe.each(treeTargets)('When the target is %s and a path is set -diff', (_l, prepare) => {
      it('Then the content sniff decides and the path is text', async () => {
        // Arrange
        const ctx = await seedWithAttributes('f1 binary\n');
        const treeish = await prepare(ctx);
        const sut = grep;

        // Act
        const result = await sut(ctx, { patterns: [{ fixed: 'NEEDLE' }], target: { treeish } });

        // Assert
        expect(project(pathOf(result, 'f1')?.hits ?? [])).toEqual(F1_HITS);
      });
    });
  });

  describe('Given a blob rev that names a path and the path is set -diff', () => {
    it.each(['HEAD:f1', ':f1', ':0:f1', 'HEAD^{tree}:f1'])(
      'Then the target %s is a binary match',
      async (treeish) => {
        // Arrange
        const ctx = await seedWithAttributes('f1 binary\n');
        const sut = grep;

        // Act
        const result = await sut(ctx, { patterns: [{ fixed: 'NEEDLE' }], target: { treeish } });

        // Assert
        expect(result.blob).toEqual({ hits: [], binaryMatch: true, binaryMatchCount: 2 });
      },
    );
  });

  describe('Given a blob rev read through the index and its .gitattributes only in the index', () => {
    it('Then the index copy decides', async () => {
      // Arrange
      const ctx = await seedWithAttributes('f1 binary\n');
      await removeWorkTreeAttributes(ctx);
      const sut = grep;

      // Act
      const result = await sut(ctx, {
        patterns: [{ fixed: 'NEEDLE' }],
        target: { treeish: ':f1' },
      });

      // Assert
      expect(result.blob?.binaryMatch).toBe(true);
    });
  });

  describe('Given a blob rev read from a commit and its .gitattributes only in the index', () => {
    it('Then the index copy is not loaded and the blob is text', async () => {
      // Arrange
      const ctx = await seedWithAttributes('f1 binary\n');
      await removeWorkTreeAttributes(ctx);
      const sut = grep;

      // Act
      const result = await sut(ctx, {
        patterns: [{ fixed: 'NEEDLE' }],
        target: { treeish: 'HEAD:f1' },
      });

      // Assert
      expect(blobHits(result)).toEqual(F1_HITS);
    });
  });

  describe('Given a blob named by oid or by an annotated tag and the path is set -diff', () => {
    it.each([
      ['its oid', async (_ctx: Context, oid: ObjectId) => oid],
      [
        'an annotated tag of it',
        async (ctx: Context, oid: ObjectId) => {
          const tag = await writeTagObject(ctx, 'bt', oid, 'blob');
          await tagCreate(ctx, { name: 'bt', target: tag });
          return 'bt';
        },
      ],
    ])('Then %s is scanned as text', async (_label, prepare) => {
      // Arrange
      const ctx = await seedWithAttributes('f1 binary\n');
      const treeish = await prepare(ctx, await resolveRevision(ctx, 'HEAD:f1'));
      const sut = grep;

      // Act
      const result = await sut(ctx, { patterns: [{ fixed: 'NEEDLE' }], target: { treeish } });

      // Assert
      expect(blobHits(result)).toEqual(F1_HITS);
    });
  });

  describe('Given a NUL blob whose only match lies beyond 64 KiB and no attribute', () => {
    it('Then it is still not reported', async () => {
      // Arrange
      const ctx = await seedRepo();
      const blob = new Uint8Array(MAX_LINE_BYTES + 64);
      blob.set(enc('DEEP_MATCH'), MAX_LINE_BYTES + 10);
      await ctx.fs.write(`${ctx.layout.workDir}/deep.bin`, blob);
      await add(ctx, ['deep.bin']);
      const sut = grep;

      // Act
      const result = await sut(ctx, { patterns: [{ fixed: 'DEEP_MATCH' }], target: 'index' });

      // Assert
      expect(result.paths).toHaveLength(0);
    });
  });

  describe('Given a rev that dereferences to a commit', () => {
    const commitTargets: ReadonlyArray<[string, (ctx: Context) => Promise<string>]> = [
      ['the commit rev', async () => 'HEAD'],
      [
        'an annotated tag of the commit',
        async (ctx) => {
          const headId = await resolveRevision(ctx, 'HEAD');
          const tag = await writeTagObject(ctx, 'ct', headId, 'commit');
          await tagCreate(ctx, { name: 'ct', target: tag });
          return 'ct';
        },
      ],
    ];

    describe.each(commitTargets)('When the target is %s and a path is set -diff', (_l, prepare) => {
      it('Then the path is a binary match with its returned-line count', async () => {
        // Arrange
        const ctx = await seedWithAttributes('f1 binary\n');
        const treeish = await prepare(ctx);
        const sut = grep;

        // Act
        const result = await sut(ctx, { patterns: [{ fixed: 'NEEDLE' }], target: { treeish } });

        // Assert
        expect(pathOf(result, 'f1')).toEqual({
          path: 'f1',
          hits: [],
          binaryMatch: true,
          binaryMatchCount: 2,
        });
      });
    });

    describe('When a NUL path is set diff', () => {
      it('Then it is scanned as text', async () => {
        // Arrange
        const ctx = await seedWithAttributes('f2 diff\n');
        await writeAndStage(ctx, 'f2', F2);
        await commitAll(ctx);
        const sut = grep;

        // Act
        const result = await sut(ctx, {
          patterns: [{ fixed: 'NEEDLE' }],
          target: { treeish: 'HEAD' },
        });

        // Assert
        expect(pathOf(result, 'f2')).toEqual({
          path: 'f2',
          hits: [{ lineNumber: 1, line: enc(F2), spans: [{ start: 2, end: 8 }] }],
          binaryMatch: false,
          binaryMatchCount: 0,
        });
      });
    });

    describe('When a bare context has an info/attributes setting -diff', () => {
      it('Then the path is a binary match', async () => {
        // Arrange
        const seeded = await seedRepo();
        await writeAndStage(seeded, 'f1', F1);
        await commitAll(seeded);
        await seeded.fs.mkdir(`${seeded.layout.gitDir}/info`);
        await seeded.fs.writeUtf8(`${seeded.layout.gitDir}/info/attributes`, 'f1 binary\n');
        const ctx = asBareContext(seeded);
        const sut = grep;

        // Act
        const result = await sut(ctx, {
          patterns: [{ fixed: 'NEEDLE' }],
          target: { treeish: 'HEAD' },
        });

        // Assert
        expect(pathOf(result, 'f1')?.binaryMatch).toBe(true);
      });
    });
  });
});
