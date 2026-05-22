import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { init } from '../../../../src/application/commands/init.js';
import {
  type SparseCheckoutResult,
  sparseCheckout,
} from '../../../../src/application/commands/sparse-checkout.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { TsgitError } from '../../../../src/domain/error.js';
import {
  type GitIndex,
  type IndexEntry,
  STAGE0_FLAGS,
  serializeIndex,
} from '../../../../src/domain/git-index/index.js';
import { FILE_MODE } from '../../../../src/domain/objects/file-mode.js';
import type { FilePath, ObjectId } from '../../../../src/domain/objects/object-id.js';
import type { Context } from '../../../../src/ports/context.js';

const encoder = new TextEncoder();

/** Write a blob object; its loose-object id becomes the seeded entry id. */
const writeBlob = async (ctx: Context, content: string): Promise<ObjectId> =>
  writeObject(ctx, { type: 'blob', content: encoder.encode(content), id: '' as ObjectId });

/** A stage-0 index entry with a deterministic stat snapshot. */
const makeEntry = (path: string, id: ObjectId): IndexEntry => ({
  ctimeSeconds: 1,
  ctimeNanoseconds: 0,
  mtimeSeconds: 1,
  mtimeNanoseconds: 0,
  dev: 1,
  ino: 1,
  mode: FILE_MODE.REGULAR,
  uid: 0,
  gid: 0,
  fileSize: 0,
  id,
  flags: STAGE0_FLAGS,
  path: path as FilePath,
});

/** Seed `.git/index` with a SHA-1 trailer so `readIndex` accepts it. */
const seedIndex = async (ctx: Context, entries: ReadonlyArray<IndexEntry>): Promise<void> => {
  const index: GitIndex = { version: 2, entries: [...entries], extensions: [] };
  const body = serializeIndex(index);
  const checksum = await ctx.hash.hash(body);
  const bytes = new Uint8Array(body.length + checksum.length);
  bytes.set(body, 0);
  bytes.set(checksum, body.length);
  await ctx.fs.write(`${ctx.layout.gitDir}/index`, bytes);
};

/** Write a working-tree file at `path` under the repo root. */
const seedWorkFile = (ctx: Context, path: string, content: string): Promise<void> =>
  ctx.fs.write(`${ctx.layout.workDir}/${path}`, encoder.encode(content));

const fileExists = (ctx: Context, path: string): Promise<boolean> =>
  ctx.fs.exists(`${ctx.layout.workDir}/${path}`);

const readConfigText = (ctx: Context): Promise<string> =>
  ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`);

const readSparseFile = (ctx: Context): Promise<string> =>
  ctx.fs.readUtf8(`${ctx.layout.gitDir}/info/sparse-checkout`);

/** Overwrite `.git/config` to flip sparse on directly (no pattern file written). */
const enableSparse = (ctx: Context, cone: boolean): Promise<void> =>
  ctx.fs.writeUtf8(
    `${ctx.layout.gitDir}/config`,
    `[core]\n\tsparseCheckout = true\n\tsparseCheckoutCone = ${cone}\n`,
  );

/**
 * An initialised repo seeded with three tracked files across two directories,
 * all materialised on disk. Returns the ready-to-use context.
 */
const seedRepoWithTree = async (): Promise<Context> => {
  const ctx = createMemoryContext();
  await init(ctx);
  const srcId = await writeBlob(ctx, 'aaa');
  const appId = await writeBlob(ctx, 'bbb');
  const docId = await writeBlob(ctx, 'ccc');
  await seedIndex(ctx, [
    makeEntry('src/app/main.ts', appId),
    makeEntry('src/util.ts', srcId),
    makeEntry('docs/guide.md', docId),
  ]);
  await seedWorkFile(ctx, 'src/app/main.ts', 'bbb');
  await seedWorkFile(ctx, 'src/util.ts', 'aaa');
  await seedWorkFile(ctx, 'docs/guide.md', 'ccc');
  return ctx;
};

/** Run a thunk, return the `TsgitError` it threw. Fails the test if none. */
const expectError = async (thunk: () => Promise<unknown>): Promise<TsgitError> => {
  try {
    await thunk();
  } catch (err) {
    if (err instanceof TsgitError) return err;
    throw err;
  }
  throw new Error('expected the call to throw a TsgitError');
};

describe('sparseCheckout command', () => {
  describe('guards', () => {
    it('Given a non-repo ctx, When sparseCheckout list, Then throws NOT_A_REPOSITORY', async () => {
      // Arrange
      const ctx = createMemoryContext();

      // Act
      const err = await expectError(() => sparseCheckout(ctx, { action: 'list' }));

      // Assert
      expect(err.data.code).toBe('NOT_A_REPOSITORY');
    });

    it('Given a bare repo, When sparseCheckout list, Then throws BARE_REPOSITORY for sparse-checkout', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await init(ctx);
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[core]\n\tbare = true\n');

      // Act
      const err = await expectError(() => sparseCheckout(ctx, { action: 'list' }));

      // Assert
      expect(err.data).toEqual({ code: 'BARE_REPOSITORY', operation: 'sparse-checkout' });
    });

    it('Given a pending merge, When sparseCheckout list, Then throws OPERATION_IN_PROGRESS', async () => {
      // Arrange
      const ctx = await seedRepoWithTree();
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/MERGE_HEAD`, `${'a'.repeat(40)}\n`);

      // Act
      const err = await expectError(() => sparseCheckout(ctx, { action: 'list' }));

      // Assert
      expect(err.data).toEqual({ code: 'OPERATION_IN_PROGRESS', operation: 'merge' });
    });
  });

  describe('list', () => {
    it('Given sparse disabled, When list, Then returns empty non-cone list', async () => {
      // Arrange
      const ctx = await seedRepoWithTree();

      // Act
      const sut = await sparseCheckout(ctx, { action: 'list' });

      // Assert
      expect(sut).toEqual({ kind: 'list', cone: false, patterns: [] });
    });

    it('Given a cone repo, When list, Then returns the sorted recursive directories', async () => {
      // Arrange — enable via a cone `set`, then list.
      const ctx = await seedRepoWithTree();
      await sparseCheckout(ctx, { action: 'set', patterns: ['src/app', 'docs'], cone: true });

      // Act
      const sut = await sparseCheckout(ctx, { action: 'list' });

      // Assert — recursive dirs only, sorted; parent `src` excluded.
      expect(sut).toEqual({ kind: 'list', cone: true, patterns: ['docs', 'src/app'] });
    });

    it('Given a non-cone repo, When list, Then returns the raw pattern lines verbatim', async () => {
      // Arrange
      const ctx = await seedRepoWithTree();
      await sparseCheckout(ctx, {
        action: 'set',
        patterns: ['/src/', '!/src/app/'],
        cone: false,
      });

      // Act
      const sut = await sparseCheckout(ctx, { action: 'list' });

      // Assert
      expect(sut).toEqual({ kind: 'list', cone: false, patterns: ['/src/', '!/src/app/'] });
    });

    it('Given sparse enabled with no pattern file, When list, Then returns an empty list', async () => {
      // Arrange — `core.sparseCheckout` true but `.git/info/sparse-checkout` absent.
      const ctx = await seedRepoWithTree();
      await enableSparse(ctx, false);

      // Act
      const sut = await sparseCheckout(ctx, { action: 'list' });

      // Assert — the absent file is treated as empty text.
      expect(sut).toEqual({ kind: 'list', cone: false, patterns: [] });
    });

    it('Given a cone-shaped file but non-cone config, When list, Then it is read as non-cone raw lines', async () => {
      // Arrange — `sparseCheckoutCone=false`, so the cone-shaped file is parsed
      // in non-cone mode: `coneRequested` must follow the config, not the text.
      const ctx = await seedRepoWithTree();
      await enableSparse(ctx, false);
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/info/sparse-checkout`, '/*\n!/*/\n/src/\n');

      // Act
      const sut = await sparseCheckout(ctx, { action: 'list' });

      // Assert — non-cone: raw pattern lines, `cone:false` (blank line dropped).
      expect(sut).toEqual({ kind: 'list', cone: false, patterns: ['/*', '!/*/', '/src/'] });
    });

    it('Given a hand-written unsorted cone file, When list, Then the recursive dirs are sorted', async () => {
      // Arrange — recursive dirs deliberately out of file order.
      const ctx = await seedRepoWithTree();
      await enableSparse(ctx, true);
      await ctx.fs.writeUtf8(
        `${ctx.layout.gitDir}/info/sparse-checkout`,
        '/*\n!/*/\n/src/\n/docs/\n',
      );

      // Act
      const sut = await sparseCheckout(ctx, { action: 'list' });

      // Assert — output is sorted regardless of file order.
      expect(sut).toEqual({ kind: 'list', cone: true, patterns: ['docs', 'src'] });
    });
  });

  describe('set', () => {
    it('Given empty patterns, When set, Then throws INVALID_OPTION for patterns', async () => {
      // Arrange
      const ctx = await seedRepoWithTree();

      // Act
      const err = await expectError(() => sparseCheckout(ctx, { action: 'set', patterns: [] }));

      // Assert — try/catch + direct `.data` field assertions.
      expect(err.data.code).toBe('INVALID_OPTION');
      if (err.data.code === 'INVALID_OPTION') {
        expect(err.data.option).toBe('patterns');
        expect(err.data.reason).toContain('at least one pattern');
      }
    });

    it('Given a cone of docs, When set, Then both src files are removed and docs stays', async () => {
      // Arrange
      const ctx = await seedRepoWithTree();

      // Act
      const sut = await sparseCheckout(ctx, { action: 'set', patterns: ['docs'], cone: true });

      // Assert — neither src file is navigable from `docs`; both removed.
      expect(sut).toEqual({
        kind: 'applied',
        cone: true,
        materialized: 0,
        removed: 2,
        retained: [],
      });
      expect(await fileExists(ctx, 'docs/guide.md')).toBe(true);
      expect(await fileExists(ctx, 'src/app/main.ts')).toBe(false);
      expect(await fileExists(ctx, 'src/util.ts')).toBe(false);
    });

    it('Given a cone of src/app, When set, Then src/util.ts stays as a navigable parent file', async () => {
      // Arrange
      const ctx = await seedRepoWithTree();

      // Act — `src` becomes a parent dir; its direct file `src/util.ts` is in.
      const sut = await sparseCheckout(ctx, { action: 'set', patterns: ['src/app'], cone: true });

      // Assert — only docs/guide.md leaves the working tree.
      expect((sut as Extract<SparseCheckoutResult, { kind: 'applied' }>).removed).toBe(1);
      expect(await fileExists(ctx, 'src/util.ts')).toBe(true);
      expect(await fileExists(ctx, 'src/app/main.ts')).toBe(true);
      expect(await fileExists(ctx, 'docs/guide.md')).toBe(false);
    });

    it('Given cone set, When set, Then config records sparseCheckout and cone true and the file is the cone shape', async () => {
      // Arrange
      const ctx = await seedRepoWithTree();

      // Act
      await sparseCheckout(ctx, { action: 'set', patterns: ['src/app'], cone: true });

      // Assert
      const config = await readConfigText(ctx);
      expect(config).toContain('sparseCheckout = true');
      expect(config).toContain('sparseCheckoutCone = true');
      expect(await readSparseFile(ctx)).toBe('/*\n!/*/\n/src/\n!/src/*/\n/src/app/\n');
    });

    it('Given non-cone patterns, When set, Then the file is the raw lines and cone is false', async () => {
      // Arrange
      const ctx = await seedRepoWithTree();

      // Act
      const sut = await sparseCheckout(ctx, {
        action: 'set',
        patterns: ['/src/'],
        cone: false,
      });

      // Assert — `/src/` recursively covers both src files; docs excluded.
      expect(sut).toEqual({
        kind: 'applied',
        cone: false,
        materialized: 0,
        removed: 1,
        retained: [],
      });
      expect(await readSparseFile(ctx)).toBe('/src/');
      expect(await readConfigText(ctx)).toContain('sparseCheckoutCone = false');
      expect(await fileExists(ctx, 'docs/guide.md')).toBe(false);
      expect(await fileExists(ctx, 'src/util.ts')).toBe(true);
    });

    it('Given no explicit cone flag, When set, Then cone defaults to true', async () => {
      // Arrange
      const ctx = await seedRepoWithTree();

      // Act — omit `cone`; the default for a fresh enable is cone mode.
      const sut = await sparseCheckout(ctx, { action: 'set', patterns: ['src/app'] });

      // Assert
      expect((sut as Extract<SparseCheckoutResult, { kind: 'applied' }>).cone).toBe(true);
      expect(await readConfigText(ctx)).toContain('sparseCheckoutCone = true');
    });

    it('Given an existing non-cone repo and no cone flag, When set, Then the prior cone mode is reused', async () => {
      // Arrange — first establish non-cone mode.
      const ctx = await seedRepoWithTree();
      await sparseCheckout(ctx, { action: 'set', patterns: ['/src/'], cone: false });

      // Act — re-set without a cone flag: it must reuse the recorded false.
      const sut = await sparseCheckout(ctx, { action: 'set', patterns: ['/docs/'] });

      // Assert
      expect((sut as Extract<SparseCheckoutResult, { kind: 'applied' }>).cone).toBe(false);
    });

    it('Given a failed apply (index locked), When set, Then config and pattern file are untouched', async () => {
      // Arrange — hold the index lock so `applySparseCheckout` throws first.
      const ctx = await seedRepoWithTree();
      const configBefore = await readConfigText(ctx);
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/index.lock`, '');

      // Act
      const err = await expectError(() =>
        sparseCheckout(ctx, { action: 'set', patterns: ['src/app'], cone: true }),
      );

      // Assert — apply failed before any persistence: `.git` unchanged.
      expect(err.data.code).toBe('RESOURCE_LOCKED');
      expect(await readConfigText(ctx)).toBe(configBefore);
      expect(await ctx.fs.exists(`${ctx.layout.gitDir}/info/sparse-checkout`)).toBe(false);
    });

    it('Given non-cone mode with cone-shaped patterns, When set, Then they stay non-cone', async () => {
      // Arrange — `/*` + `!/*/` + `/src/` is the literal cone-file shape. With
      // `cone: false` the command must parse them as non-cone gitignore
      // patterns, NOT recognise the cone grammar — a cone parse would select a
      // different path set and wrongly flip `result.cone` / `sparseCheckoutCone`.
      const ctx = await seedRepoWithTree();

      // Act
      const sut = await sparseCheckout(ctx, {
        action: 'set',
        patterns: ['/*', '!/*/', '/src/'],
        cone: false,
      });

      // Assert — non-cone is preserved end to end.
      expect((sut as Extract<SparseCheckoutResult, { kind: 'applied' }>).cone).toBe(false);
      expect(await readConfigText(ctx)).toContain('sparseCheckoutCone = false');
    });
  });

  describe('add', () => {
    it('Given empty patterns, When add, Then throws INVALID_OPTION for patterns', async () => {
      // Arrange — sparse enabled so the empty-pattern guard, not the
      // sparse-disabled guard, is the one that fires.
      const ctx = await seedRepoWithTree();
      await sparseCheckout(ctx, { action: 'set', patterns: ['src/app'], cone: true });

      // Act
      const err = await expectError(() => sparseCheckout(ctx, { action: 'add', patterns: [] }));

      // Assert — try/catch + direct `.data` field assertions.
      expect(err.data.code).toBe('INVALID_OPTION');
      if (err.data.code === 'INVALID_OPTION') {
        expect(err.data.option).toBe('patterns');
        expect(err.data.reason).toBe('add requires at least one pattern');
      }
    });

    it('Given sparse disabled, When add, Then throws INVALID_OPTION for action', async () => {
      // Arrange
      const ctx = await seedRepoWithTree();

      // Act
      const err = await expectError(() =>
        sparseCheckout(ctx, { action: 'add', patterns: ['docs'] }),
      );

      // Assert
      expect(err.data.code).toBe('INVALID_OPTION');
      if (err.data.code === 'INVALID_OPTION') {
        expect(err.data.option).toBe('action');
        expect(err.data.reason).toContain('add requires sparse checkout to be enabled');
      }
    });

    it('Given a cone repo, When add, Then the new directory is folded into the cone and materialised', async () => {
      // Arrange — start with only src/app; docs is excluded.
      const ctx = await seedRepoWithTree();
      await sparseCheckout(ctx, { action: 'set', patterns: ['src/app'], cone: true });
      expect(await fileExists(ctx, 'docs/guide.md')).toBe(false);

      // Act — add docs.
      const sut = await sparseCheckout(ctx, { action: 'add', patterns: ['docs'] });

      // Assert — docs/guide.md re-materialised; cone file now lists docs.
      expect((sut as Extract<SparseCheckoutResult, { kind: 'applied' }>).materialized).toBe(1);
      expect(await fileExists(ctx, 'docs/guide.md')).toBe(true);
      expect(await readSparseFile(ctx)).toBe('/*\n!/*/\n/docs/\n/src/\n!/src/*/\n/src/app/\n');
    });

    it('Given a cone repo whose pattern file was hand-written non-cone-shaped, When add a directory, Then the cone is rebuilt from only the added dirs', async () => {
      // Arrange — cone mode is enabled in config, but `.git/info/sparse-checkout`
      // is hand-written into a NON-cone shape. `combineSpecAndText` parses the
      // existing file in cone mode; the parse degrades to `no-cone`, so the
      // prior shape cannot contribute recursive dirs. The design intent is that
      // `add` rebuilds the cone from the added directories alone.
      const ctx = await seedRepoWithTree();
      await enableSparse(ctx, true);
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/info/sparse-checkout`, '*.ts\n');

      // Act — add `docs`.
      const sut = await sparseCheckout(ctx, { action: 'add', patterns: ['docs'] });

      // Assert — the rewritten file is a clean cone built from `docs` only;
      // the prior `*.ts` line is gone. `docs/guide.md` is materialised.
      expect((sut as Extract<SparseCheckoutResult, { kind: 'applied' }>).cone).toBe(true);
      expect(await readSparseFile(ctx)).toBe('/*\n!/*/\n/docs/\n');
      expect(await fileExists(ctx, 'docs/guide.md')).toBe(true);
      // src files fall outside the rebuilt `docs`-only cone — removed.
      expect(await fileExists(ctx, 'src/util.ts')).toBe(false);
    });

    it('Given a non-cone repo, When add, Then the new pattern lines are appended to the file', async () => {
      // Arrange
      const ctx = await seedRepoWithTree();
      await sparseCheckout(ctx, { action: 'set', patterns: ['/src/'], cone: false });

      // Act
      await sparseCheckout(ctx, { action: 'add', patterns: ['/docs/'] });

      // Assert — appended verbatim.
      expect(await readSparseFile(ctx)).toBe('/src/\n/docs/');
      expect(await fileExists(ctx, 'docs/guide.md')).toBe(true);
    });

    it('Given non-cone enabled with no pattern file, When add, Then the file holds only the new lines', async () => {
      // Arrange — sparse on, but `.git/info/sparse-checkout` does not exist yet.
      const ctx = await seedRepoWithTree();
      await enableSparse(ctx, false);

      // Act
      await sparseCheckout(ctx, { action: 'add', patterns: ['/docs/'] });

      // Assert — empty existing text means the file is exactly the added lines,
      // with no leading blank line from a `['', ...]` join.
      expect(await readSparseFile(ctx)).toBe('/docs/');
    });

    it('Given non-cone mode, When add makes the combined file cone-shaped, Then it stays non-cone', async () => {
      // Arrange — non-cone mode whose file is already the cone header.
      const ctx = await seedRepoWithTree();
      await sparseCheckout(ctx, { action: 'set', patterns: ['/*', '!/*/'], cone: false });

      // Act — appending `/src/` makes the combined text a full cone-file shape;
      // the command must still treat it as non-cone, not switch interpretation.
      const sut = await sparseCheckout(ctx, { action: 'add', patterns: ['/src/'] });

      // Assert
      expect((sut as Extract<SparseCheckoutResult, { kind: 'applied' }>).cone).toBe(false);
      expect(await readConfigText(ctx)).toContain('sparseCheckoutCone = false');
    });

    it('Given a non-cone file ending in a newline, When add, Then no blank line is joined in', async () => {
      // Arrange — a hand-edited pattern file that ends with a trailing newline.
      const ctx = await seedRepoWithTree();
      await enableSparse(ctx, false);
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/info/sparse-checkout`, '/keep/\n');

      // Act
      await sparseCheckout(ctx, { action: 'add', patterns: ['/docs/'] });

      // Assert — the appended pattern follows directly; no `\n\n`.
      expect(await readSparseFile(ctx)).toBe('/keep/\n/docs/');
    });
  });

  describe('reapply', () => {
    it('Given sparse disabled, When reapply, Then throws INVALID_OPTION for action', async () => {
      // Arrange
      const ctx = await seedRepoWithTree();

      // Act
      const err = await expectError(() => sparseCheckout(ctx, { action: 'reapply' }));

      // Assert
      expect(err.data.code).toBe('INVALID_OPTION');
      if (err.data.code === 'INVALID_OPTION') {
        expect(err.data.option).toBe('action');
        expect(err.data.reason).toContain('reapply requires sparse checkout to be enabled');
      }
    });

    it('Given a cone repo with a re-created excluded file, When reapply, Then the on-disk patterns are re-enforced', async () => {
      // Arrange — set the cone, then a user re-creates an excluded file.
      const ctx = await seedRepoWithTree();
      await sparseCheckout(ctx, { action: 'set', patterns: ['src/app'], cone: true });
      await seedWorkFile(ctx, 'docs/guide.md', 'ccc');

      // Act
      const sut = await sparseCheckout(ctx, { action: 'reapply' });

      // Assert — the stray excluded file is removed again; cone flag preserved.
      expect(sut).toEqual({
        kind: 'applied',
        cone: true,
        materialized: 0,
        removed: 1,
        retained: [],
      });
      expect(await fileExists(ctx, 'docs/guide.md')).toBe(false);
    });

    it('Given a non-cone repo, When reapply, Then the result reports cone false and no file is rewritten', async () => {
      // Arrange
      const ctx = await seedRepoWithTree();
      await sparseCheckout(ctx, { action: 'set', patterns: ['/src/'], cone: false });

      // Act
      const sut = await sparseCheckout(ctx, { action: 'reapply' });

      // Assert
      expect((sut as Extract<SparseCheckoutResult, { kind: 'applied' }>).cone).toBe(false);
      expect(await readSparseFile(ctx)).toBe('/src/');
    });
  });

  describe('disable', () => {
    it('Given a cone repo, When disable, Then every file is re-materialised and config flips to false', async () => {
      // Arrange — narrow to the docs cone (both src files excluded), then disable.
      const ctx = await seedRepoWithTree();
      await sparseCheckout(ctx, { action: 'set', patterns: ['docs'], cone: true });
      expect(await fileExists(ctx, 'src/util.ts')).toBe(false);

      // Act
      const sut = await sparseCheckout(ctx, { action: 'disable' });

      // Assert — both src files back on disk; sparse off.
      expect(sut).toEqual({
        kind: 'applied',
        cone: false,
        materialized: 2,
        removed: 0,
        retained: [],
      });
      expect(await fileExists(ctx, 'src/app/main.ts')).toBe(true);
      expect(await fileExists(ctx, 'src/util.ts')).toBe(true);
      expect(await readConfigText(ctx)).toContain('sparseCheckout = false');
    });

    it('Given a disabled repo, When disable, Then the pattern file is kept on disk', async () => {
      // Arrange
      const ctx = await seedRepoWithTree();
      await sparseCheckout(ctx, { action: 'set', patterns: ['src/app'], cone: true });

      // Act
      await sparseCheckout(ctx, { action: 'disable' });

      // Assert — git keeps the file so a later `reapply` can reuse it.
      expect(await ctx.fs.exists(`${ctx.layout.gitDir}/info/sparse-checkout`)).toBe(true);
    });
  });

  describe('dirty-file retention', () => {
    it('Given a modified out-of-cone file and no force, When set, Then the file is retained', async () => {
      // Arrange — edit docs/guide.md so excluding it would lose work.
      const ctx = await seedRepoWithTree();
      await seedWorkFile(ctx, 'docs/guide.md', 'edited');

      // Act
      const sut = await sparseCheckout(ctx, { action: 'set', patterns: ['src'], cone: true });

      // Assert — the dirty excludee is left on disk and surfaced in `retained`.
      const applied = sut as Extract<SparseCheckoutResult, { kind: 'applied' }>;
      expect(applied.retained).toEqual(['docs/guide.md']);
      expect(await fileExists(ctx, 'docs/guide.md')).toBe(true);
    });

    it('Given a modified out-of-cone file and force, When set, Then the file is removed', async () => {
      // Arrange
      const ctx = await seedRepoWithTree();
      await seedWorkFile(ctx, 'docs/guide.md', 'edited');

      // Act
      const sut = await sparseCheckout(ctx, {
        action: 'set',
        patterns: ['src'],
        cone: true,
        force: true,
      });

      // Assert — `force` overrides the retain policy.
      const applied = sut as Extract<SparseCheckoutResult, { kind: 'applied' }>;
      expect(applied.retained).toEqual([]);
      expect(await fileExists(ctx, 'docs/guide.md')).toBe(false);
    });
  });
});
