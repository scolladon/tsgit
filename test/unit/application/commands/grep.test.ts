import { describe, expect, it } from 'vitest';
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
import { TsgitError } from '../../../../src/domain/error.js';
import type { AuthorIdentity } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';

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
    const sut = grep;

    // Act
    let caught: unknown;
    try {
      await sut(ctx, { patterns: [] });
    } catch (e) {
      caught = e;
    }

    // Assert
    expect(caught).toBeInstanceOf(TsgitError);
    const err = caught as TsgitError;
    expect(err.data.code).toBe('INVALID_OPTION');
    expect((err.data as { option: string }).option).toBe('patterns');
  });
});

// ─── Guard: u-flag propagates from matcher ────────────────────────────────────

describe('Given a u-flagged RegExp pattern, When grep is called', () => {
  it('Then it throws INVALID_OPTION with option "pattern"', async () => {
    // Arrange
    const ctx = await seedRepo();
    const sut = grep;

    // Act
    let caught: unknown;
    try {
      await sut(ctx, { patterns: [/x/u] });
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

// ─── Working-tree target (default, #T1) ─────────────────────────────────────

describe('Given a repo with working-tree content, When grep runs with default target', () => {
  it('Then it matches content in the working tree (#T1)', async () => {
    // Arrange
    const ctx = await seedRepo();
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/wt.txt`, 'hello world\nsecond line\n');
    const sut = grep;

    // Act
    const result: GrepResult = await sut(ctx, { patterns: [{ fixed: 'hello' }] });

    // Assert
    expect(result.paths).toHaveLength(1);
    expect(result.paths[0]!.path).toBe('wt.txt');
    expect(result.paths[0]!.hits).toHaveLength(1);
    expect(result.paths[0]!.hits[0]!.lineNumber).toBe(1);
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
    const sut = grep;

    // Act
    const result: GrepResult = await sut(ctx, { patterns: [{ fixed: 'unstaged addition' }] });

    // Assert
    expect(result.paths).toHaveLength(1);
    expect(result.paths[0]!.path).toBe('f.txt');
  });
});

// ─── Index target (--cached, #T2 / #T3) ─────────────────────────────────────

describe('Given a staged file, When grep runs with target "index"', () => {
  it('Then it matches staged content (#T2)', async () => {
    // Arrange
    const ctx = await seedRepo();
    await writeAndStage(ctx, 'staged.txt', 'staged line\n');
    const sut = grep;

    // Act
    const result: GrepResult = await sut(ctx, {
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
    const sut = grep;

    // Act
    const result: GrepResult = await sut(ctx, {
      patterns: [{ fixed: 'unstaged only' }],
      target: 'index',
    });

    // Assert
    expect(result.paths).toHaveLength(0);
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
    const sut = grep;

    // Act
    const result: GrepResult = await sut(ctx, {
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
    const sut = grep;

    // Act
    const result: GrepResult = await sut(ctx, {
      patterns: [{ fixed: 'committed content' }],
      target: { treeish: 'HEAD' },
    });

    // Assert
    expect(result.paths).toHaveLength(1);
    expect(result.paths[0]!.path).toBe('committed.txt');
  });
});

// ─── 1-based line numbering (#L1) ────────────────────────────────────────────

describe('Given a multi-line file, When grep matches line 3', () => {
  it('Then the hit lineNumber is 3 (#L1)', async () => {
    // Arrange
    const ctx = await seedRepo();
    const content = 'line1\nline2\nNEEDLE here\nline4\n';
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/multi.txt`, content);
    const sut = grep;

    // Act
    const result: GrepResult = await sut(ctx, { patterns: [{ fixed: 'NEEDLE' }] });

    // Assert
    const hit: GrepLineHit = result.paths[0]!.hits[0]!;
    expect(hit.lineNumber).toBe(3);
  });
});

// ─── Binary blob handling (#B1) ──────────────────────────────────────────────

describe('Given a binary blob whose bytes contain the pattern, When grep runs', () => {
  it('Then it records binaryMatch:true and empty hits (#B1)', async () => {
    // Arrange
    const ctx = await seedRepo();
    // Construct a blob with NUL byte (binary indicator) + the pattern bytes
    const patternBytes = enc('FIND_ME');
    const binaryBlob = new Uint8Array([0x00, ...patternBytes, 0x00]);
    await ctx.fs.write(`${ctx.layout.workDir}/data.bin`, binaryBlob);
    const sut = grep;

    // Act
    const result: GrepResult = await sut(ctx, { patterns: [{ fixed: 'FIND_ME' }] });

    // Assert
    expect(result.paths).toHaveLength(1);
    const pathResult: GrepPathResult = result.paths[0]!;
    expect(pathResult.binaryMatch).toBe(true);
    expect(pathResult.hits).toHaveLength(0);
  });
});

describe('Given a binary blob whose bytes do NOT contain the pattern, When grep runs', () => {
  it('Then it is omitted from results', async () => {
    // Arrange
    const ctx = await seedRepo();
    const binaryBlob = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
    await ctx.fs.write(`${ctx.layout.workDir}/data.bin`, binaryBlob);
    const sut = grep;

    // Act
    const result: GrepResult = await sut(ctx, { patterns: [{ fixed: 'FIND_ME' }] });

    // Assert
    expect(result.paths).toHaveLength(0);
  });
});

// ─── Pathspec limiter ─────────────────────────────────────────────────────────

describe('Given two files, When grep is restricted to one via pathspec', () => {
  it('Then only the in-scope file is searched', async () => {
    // Arrange
    const ctx = await seedRepo();
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'needle\n');
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/b.txt`, 'needle\n');
    const sut = grep;

    // Act
    const result: GrepResult = await sut(ctx, {
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
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'needle\n');
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/b.txt`, 'needle\n');
    const sut = grep;

    // Act
    const result: GrepResult = await sut(ctx, {
      patterns: [{ fixed: 'needle' }],
      paths: ['b.txt'],
    });

    // Assert
    const paths = result.paths.map((p) => p.path);
    expect(paths).not.toContain('a.txt');
  });
});

// ─── Multi-pattern OR (#F4) ──────────────────────────────────────────────────

describe('Given a file with two distinct lines, When grep uses two patterns', () => {
  it('Then both lines are returned (OR semantics)', async () => {
    // Arrange
    const ctx = await seedRepo();
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/f.txt`, 'alpha\nbeta\ngamma\n');
    const sut = grep;

    // Act
    const result: GrepResult = await sut(ctx, {
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

describe('Given 5 files where 3 match, When grep runs', () => {
  it('Then the matching paths appear in walk order (#M1)', async () => {
    // Arrange
    const ctx = await seedRepo();
    // Use names that sort alphabetically to get predictable order
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'needle\n');
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/b.txt`, 'other\n');
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/c.txt`, 'needle\n');
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/d.txt`, 'other\n');
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/e.txt`, 'needle\n');
    const sut = grep;

    // Act
    const result: GrepResult = await sut(ctx, { patterns: [{ fixed: 'needle' }] });

    // Assert
    expect(result.paths.map((p) => p.path)).toEqual(['a.txt', 'c.txt', 'e.txt']);
  });
});

// ─── Whole-word flag passes through to matcher (-w) ─────────────────────────

describe('Given a file with "word" embedded in another word, When grep uses wholeWord', () => {
  it('Then the embedded occurrence is excluded (whole-word gate)', async () => {
    // Arrange
    const ctx = await seedRepo();
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/f.txt`, 'keyword\nword alone\n');
    const sut = grep;

    // Act
    const result: GrepResult = await sut(ctx, {
      patterns: [{ fixed: 'word' }],
      wholeWord: true,
    });

    // Assert
    expect(result.paths).toHaveLength(1);
    const lineNumbers = result.paths[0]!.hits.map((h) => h.lineNumber);
    expect(lineNumbers).toEqual([2]);
  });
});

// ─── Invert flag passes through to matcher (-v) ──────────────────────────────

describe('Given a file with three lines, When grep uses invert', () => {
  it('Then lines NOT matching the pattern are returned', async () => {
    // Arrange
    const ctx = await seedRepo();
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/f.txt`, 'match\nskip\nmatch\n');
    const sut = grep;

    // Act
    const result: GrepResult = await sut(ctx, {
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

describe('Given a line with a regex match, When grep returns spans', () => {
  it('Then the span slice equals the matched bytes', async () => {
    // Arrange
    const ctx = await seedRepo();
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/f.txt`, 'pre MATCH post\n');
    const sut = grep;

    // Act
    const result: GrepResult = await sut(ctx, { patterns: [/MATCH/] });

    // Assert
    const hit = result.paths[0]!.hits[0]!;
    const span = hit.spans[0]!;
    const matched = dec(hit.line.slice(span.start, span.end));
    expect(matched).toBe('MATCH');
  });
});

// ─── No results for unmatched files ──────────────────────────────────────────

describe('Given a file with no matching content, When grep runs', () => {
  it('Then the result paths is empty', async () => {
    // Arrange
    const ctx = await seedRepo();
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/f.txt`, 'nothing here\n');
    const sut = grep;

    // Act
    const result: GrepResult = await sut(ctx, { patterns: [{ fixed: 'MISSING' }] });

    // Assert
    expect(result.paths).toHaveLength(0);
  });
});
