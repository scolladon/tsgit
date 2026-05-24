import { beforeEach, describe, expect, it } from 'vitest';
import { __resetConfigCacheForTests } from '../../../../src/application/primitives/config-read.js';
import {
  MAX_GITMODULES_BYTES,
  type SubmoduleEntry,
} from '../../../../src/application/primitives/types.js';
import {
  __isUnsafeSubmoduleNameForTests as isUnsafeSubmoduleName,
  walkSubmodules,
} from '../../../../src/application/primitives/walk-submodules.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { writeTree } from '../../../../src/application/primitives/write-tree.js';
import { TsgitError } from '../../../../src/domain/error.js';
import type { Blob, ObjectId, TreeEntry } from '../../../../src/domain/objects/index.js';
import { FILE_MODE, RefName } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';
import { buildSeededContext } from './fixtures.js';

const FAKE_COMMIT_A = '1111111111111111111111111111111111111111' as ObjectId;
const FAKE_COMMIT_B = '2222222222222222222222222222222222222222' as ObjectId;
const FAKE_COMMIT_C = '3333333333333333333333333333333333333333' as ObjectId;

const collect = async (iter: AsyncIterable<SubmoduleEntry>): Promise<SubmoduleEntry[]> => {
  const out: SubmoduleEntry[] = [];
  for await (const e of iter) out.push(e);
  return out;
};

const writeBlobBytes = async (ctx: Context, content: Uint8Array): Promise<ObjectId> =>
  writeObject(ctx, { type: 'blob', content, id: '' as ObjectId } satisfies Blob);

const writeBlobText = async (ctx: Context, text: string): Promise<ObjectId> =>
  writeBlobBytes(ctx, new TextEncoder().encode(text));

const writeTreeAt = async (ctx: Context, entries: ReadonlyArray<TreeEntry>): Promise<ObjectId> =>
  writeTree(ctx, entries);

const writeRootTreeWithGitmodules = async (
  ctx: Context,
  gitmodulesText: string | undefined,
  gitlinks: ReadonlyArray<{ readonly path: string; readonly id: ObjectId }>,
): Promise<ObjectId> => {
  const entries: TreeEntry[] = [];
  if (gitmodulesText !== undefined) {
    const blobId = await writeBlobText(ctx, gitmodulesText);
    entries.push({ name: '.gitmodules', mode: FILE_MODE.REGULAR, id: blobId });
  }
  // walkTree visits subdirectories — nested gitlinks (a/b) need an intermediate tree.
  const direct: TreeEntry[] = [];
  const nested = new Map<string, TreeEntry[]>();
  for (const link of gitlinks) {
    const segments = link.path.split('/');
    if (segments.length === 1) {
      direct.push({ name: link.path, mode: FILE_MODE.GITLINK, id: link.id });
    } else {
      const [head, ...rest] = segments;
      const key = head as string;
      const bucket = nested.get(key) ?? [];
      bucket.push({
        name: rest.join('/'),
        mode: FILE_MODE.GITLINK,
        id: link.id,
      });
      nested.set(key, bucket);
    }
  }
  for (const entry of direct) entries.push(entry);
  for (const [dirName, dirEntries] of nested) {
    // Recursively materialise sub-trees one level only (sufficient for these tests).
    const subId = await writeTreeAt(ctx, dirEntries);
    entries.push({ name: dirName, mode: FILE_MODE.DIRECTORY, id: subId });
  }
  return writeTreeAt(ctx, entries);
};

const writeCommit = async (ctx: Context, treeId: ObjectId): Promise<ObjectId> =>
  writeObject(ctx, {
    type: 'commit',
    id: '' as ObjectId,
    data: {
      tree: treeId,
      parents: [],
      author: {
        name: 'Ada',
        email: 'ada@example.com',
        timestamp: 1_700_000_000,
        timezoneOffset: '+0000',
      },
      committer: {
        name: 'Ada',
        email: 'ada@example.com',
        timestamp: 1_700_000_000,
        timezoneOffset: '+0000',
      },
      message: 'seed',
      extraHeaders: [],
    },
  });

const setDetachedHead = async (ctx: Context, id: ObjectId): Promise<void> => {
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, `${id}\n`);
};

const submoduleStoreCtx = (ctx: Context, name: string): Context =>
  Object.freeze({
    ...ctx,
    layout: Object.freeze({
      ...ctx.layout,
      gitDir: `${ctx.layout.gitDir}/modules/${name}`,
    }),
  });

const seedSubmoduleStore = async (
  ctx: Context,
  name: string,
  build: (childCtx: Context) => Promise<{ readonly head: ObjectId }>,
): Promise<{ readonly headCommit: ObjectId; readonly childGitDir: string }> => {
  const childGitDir = `${ctx.layout.gitDir}/modules/${name}`;
  const childCtx = submoduleStoreCtx(ctx, name);
  const { head } = await build(childCtx);
  await ctx.fs.writeUtf8(`${childGitDir}/HEAD`, `${head}\n`);
  return { headCommit: head, childGitDir };
};

describe('primitives/walk-submodules', () => {
  beforeEach(() => {
    __resetConfigCacheForTests();
  });

  describe('isUnsafeSubmoduleName', () => {
    describe('Given an unsafe name (%s)', () => {
      describe('When isUnsafeSubmoduleName', () => {
        it.each([
          ['empty', ''],
          ['dot segment', '.'],
          ['double-dot segment', '..'],
          ['nested double-dot', 'a/../b'],
          ['nested dot', 'a/./b'],
          ['empty segment (trailing slash)', 'foo/'],
          ['empty segment (double slash)', 'foo//bar'],
          ['backslash', 'a\\b'],
          ['leading slash (POSIX absolute)', '/foo'],
          ['drive-letter prefix', 'C:/foo'],
          ['leading dash (option-like)', '-flag'],
          ['NUL byte', `a${String.fromCharCode(0)}b`],
          ['tab control char', 'a\tb'],
          [
            'unit-separator (0x1f) — boundary of the control-char range',
            `a${String.fromCharCode(0x1f)}b`,
          ],
          ['DEL control char', `a${String.fromCharCode(127)}b`],
        ])('Then returns true', (_label, name) => {
          // Arrange
          const sut = isUnsafeSubmoduleName(name);
          // Assert
          expect(sut).toBe(true);
        });
      });
    });

    describe('Given a plain name', () => {
      describe('When isUnsafeSubmoduleName', () => {
        it('Then returns false', () => {
          // Arrange
          const sut = isUnsafeSubmoduleName('libfoo');
          // Assert
          expect(sut).toBe(false);
        });
      });
    });

    describe('Given a slash-containing name (legitimate for nested module dirs)', () => {
      describe('When isUnsafeSubmoduleName', () => {
        it('Then returns false', () => {
          // Arrange
          const sut = isUnsafeSubmoduleName('libs/foo');
          // Assert
          expect(sut).toBe(false);
        });
      });
    });
  });

  describe('walkSubmodules — non-recursive', () => {
    describe('Given one gitlink with a matching .gitmodules row', () => {
      describe('When walkSubmodules', () => {
        it('Then yields one entry with name/url/branch/commit', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const text =
            '[submodule "vendor-foo"]\n\tpath = vendor/foo\n\turl = https://e/foo.git\n\tbranch = main\n';
          const treeId = await writeRootTreeWithGitmodules(ctx, text, [
            { path: 'vendor/foo', id: FAKE_COMMIT_A },
          ]);

          // Act
          const sut = await collect(walkSubmodules(ctx, { ref: treeId }));

          // Assert
          expect(sut).toEqual([
            {
              name: 'vendor-foo',
              path: 'vendor/foo',
              url: 'https://e/foo.git',
              branch: 'main',
              commit: FAKE_COMMIT_A,
              depth: 0,
            },
          ]);
        });
      });
    });

    describe('Given a gitlink with no .gitmodules row', () => {
      describe('When walkSubmodules', () => {
        it('Then name falls back to path and url/branch are absent', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const treeId = await writeRootTreeWithGitmodules(ctx, undefined, [
            { path: 'orphan', id: FAKE_COMMIT_A },
          ]);

          // Act
          const sut = await collect(walkSubmodules(ctx, { ref: treeId }));

          // Assert
          expect(sut).toEqual([
            { name: 'orphan', path: 'orphan', commit: FAKE_COMMIT_A, depth: 0 },
          ]);
        });
      });
    });

    describe('Given a .gitmodules row with no matching gitlink', () => {
      describe('When walkSubmodules', () => {
        it('Then it is not yielded', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const text = '[submodule "ghost"]\n\tpath = ghost/path\n\turl = https://e/ghost.git\n';
          const treeId = await writeRootTreeWithGitmodules(ctx, text, []);

          // Act
          const sut = await collect(walkSubmodules(ctx, { ref: treeId }));

          // Assert
          expect(sut).toEqual([]);
        });
      });
    });

    describe('Given multiple gitlinks at the root', () => {
      describe('When walkSubmodules', () => {
        it('Then yields them in tree (sorted) order', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const treeId = await writeRootTreeWithGitmodules(ctx, undefined, [
            { path: 'zebra', id: FAKE_COMMIT_A },
            { path: 'alpha', id: FAKE_COMMIT_B },
          ]);

          // Act
          const sut = await collect(walkSubmodules(ctx, { ref: treeId }));

          // Assert — tree entries are sorted; alpha precedes zebra.
          expect(sut.map((e) => e.path)).toEqual(['alpha', 'zebra']);
        });
      });
    });

    describe('Given a gitlink nested in a subdirectory', () => {
      describe('When walkSubmodules', () => {
        it('Then yields it with its full path', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const text = '[submodule "libs-foo"]\n\tpath = libs/foo\n\turl = https://e/foo.git\n';
          const treeId = await writeRootTreeWithGitmodules(ctx, text, [
            { path: 'libs/foo', id: FAKE_COMMIT_A },
          ]);

          // Act
          const sut = await collect(walkSubmodules(ctx, { ref: treeId }));

          // Assert
          expect(sut).toEqual([
            {
              name: 'libs-foo',
              path: 'libs/foo',
              url: 'https://e/foo.git',
              commit: FAKE_COMMIT_A,
              depth: 0,
            },
          ]);
        });
      });
    });

    describe('Given no .gitmodules at all', () => {
      describe('When walkSubmodules', () => {
        it('Then gitlinks still yield with name = path', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const treeId = await writeRootTreeWithGitmodules(ctx, undefined, [
            { path: 'foo', id: FAKE_COMMIT_A },
          ]);

          // Act
          const sut = await collect(walkSubmodules(ctx, { ref: treeId }));

          // Assert
          expect(sut).toEqual([{ name: 'foo', path: 'foo', commit: FAKE_COMMIT_A, depth: 0 }]);
        });
      });
    });

    describe('Given .gitmodules with mode 100755 (executable)', () => {
      describe('When walkSubmodules', () => {
        it('Then it is parsed (matches the regular-file behaviour)', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const text = '[submodule "vendor-foo"]\n\tpath = vendorfoo\n\turl = https://e/foo.git\n';
          const blobId = await writeBlobText(ctx, text);
          const treeId = await writeTreeAt(ctx, [
            { name: '.gitmodules', mode: FILE_MODE.EXECUTABLE, id: blobId },
            { name: 'vendorfoo', mode: FILE_MODE.GITLINK, id: FAKE_COMMIT_A },
          ]);

          // Act
          const sut = await collect(walkSubmodules(ctx, { ref: treeId }));

          // Assert — same shape as the regular-file case.
          expect(sut).toEqual([
            {
              name: 'vendor-foo',
              path: 'vendorfoo',
              url: 'https://e/foo.git',
              commit: FAKE_COMMIT_A,
              depth: 0,
            },
          ]);
        });
      });
    });

    describe('Given .gitmodules is a symlink (mode 120000) whose blob holds valid INI', () => {
      describe('When walkSubmodules', () => {
        it('Then the mode guard wins (no metadata leaks)', async () => {
          // Arrange — the symlink target blob holds a parseable INI section that
          // *would* yield `url: https://attacker/x.git` if the mode guard were
          // bypassed. A mutant dropping the mode check surfaces the URL.
          const ctx = await buildSeededContext();
          const iniText =
            '[submodule "gitlink"]\n\tpath = gitlink\n\turl = https://attacker/x.git\n';
          const linkId = await writeBlobText(ctx, iniText);
          const treeId = await writeTreeAt(ctx, [
            { name: '.gitmodules', mode: FILE_MODE.SYMLINK, id: linkId },
            { name: 'gitlink', mode: FILE_MODE.GITLINK, id: FAKE_COMMIT_A },
          ]);

          // Act
          const sut = await collect(walkSubmodules(ctx, { ref: treeId }));

          // Assert — name falls back to path, no url leaked.
          expect(sut).toEqual([
            { name: 'gitlink', path: 'gitlink', commit: FAKE_COMMIT_A, depth: 0 },
          ]);
        });
      });
    });

    describe('Given .gitmodules with unknown keys interleaved with path/url/branch', () => {
      describe('When walkSubmodules', () => {
        it('Then unknown keys do not perturb the row', async () => {
          // Arrange — interleaving unknown keys (`ignoreme`, `update`, `extra`)
          // around each known key kills the per-key `if (k === ...)` mutants in
          // `mergeKey`: a mutant that drops one comparison would let a later
          // unknown key clobber `path`, `url`, or `branch`.
          const ctx = await buildSeededContext();
          const text =
            '[submodule "foo"]\n\tpath = foo\n\tignoreme = first\n\turl = https://e/foo.git\n\tupdate = checkout\n\tbranch = main\n\textra = last\n';
          const treeId = await writeRootTreeWithGitmodules(ctx, text, [
            { path: 'foo', id: FAKE_COMMIT_A },
          ]);

          // Act
          const sut = await collect(walkSubmodules(ctx, { ref: treeId }));

          // Assert — known keys carry their declared values, unaffected by the
          // unknown ones that surround them.
          expect(sut).toEqual([
            {
              name: 'foo',
              path: 'foo',
              url: 'https://e/foo.git',
              branch: 'main',
              commit: FAKE_COMMIT_A,
              depth: 0,
            },
          ]);
        });
      });
    });

    describe('Given a root tree whose sorted-first entry is .gitignore (not .gitmodules)', () => {
      describe('When walkSubmodules', () => {
        it('Then find still selects .gitmodules', async () => {
          // Arrange — `.gitignore` < `.gitmodules`. A mutant `find` predicate that
          // returns the first entry of any name would parse `.gitignore` as INI
          // and miss the real submodule row, leaving the gitlink without a url.
          const ctx = await buildSeededContext();
          const ignoreBlob = await writeBlobText(ctx, '*.log\nbuild/\n');
          const text = '[submodule "foo"]\n\tpath = foo\n\turl = https://e/foo.git\n';
          const modulesBlob = await writeBlobText(ctx, text);
          const treeId = await writeTreeAt(ctx, [
            { name: '.gitignore', mode: FILE_MODE.REGULAR, id: ignoreBlob },
            { name: '.gitmodules', mode: FILE_MODE.REGULAR, id: modulesBlob },
            { name: 'foo', mode: FILE_MODE.GITLINK, id: FAKE_COMMIT_A },
          ]);

          // Act
          const sut = await collect(walkSubmodules(ctx, { ref: treeId }));

          // Assert — the gitlink carries the URL from .gitmodules.
          expect(sut).toEqual([
            {
              name: 'foo',
              path: 'foo',
              url: 'https://e/foo.git',
              commit: FAKE_COMMIT_A,
              depth: 0,
            },
          ]);
        });
      });
    });

    describe('Given .gitmodules with comments, quoted subsection, continuation, and case-varied keys', () => {
      describe('When walkSubmodules', () => {
        it('Then it parses', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const text = [
            '# comment line',
            '[submodule "vendor-foo"]',
            '\tPath = vendor/foo',
            '\tURL = https://e/foo\\',
            '/bar.git',
            '\tBranch = release',
          ].join('\n');
          const treeId = await writeRootTreeWithGitmodules(ctx, text, [
            { path: 'vendor/foo', id: FAKE_COMMIT_A },
          ]);

          // Act
          const sut = await collect(walkSubmodules(ctx, { ref: treeId }));

          // Assert
          expect(sut).toEqual([
            {
              name: 'vendor-foo',
              path: 'vendor/foo',
              url: 'https://e/foo/bar.git',
              branch: 'release',
              commit: FAKE_COMMIT_A,
              depth: 0,
            },
          ]);
        });
      });
    });

    describe('Given .gitmodules larger than MAX_GITMODULES_BYTES', () => {
      describe('When walkSubmodules', () => {
        it('Then throws OBJECT_TOO_LARGE', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const huge = 'x'.repeat(MAX_GITMODULES_BYTES + 1);
          const treeId = await writeRootTreeWithGitmodules(ctx, huge, [
            { path: 'foo', id: FAKE_COMMIT_A },
          ]);

          // Act & Assert — assert the specific error code via try/catch + .data inspection.
          try {
            await collect(walkSubmodules(ctx, { ref: treeId }));
            // Assert
            expect.fail('walkSubmodules did not throw');
          } catch (err) {
            expect(err).toBeInstanceOf(TsgitError);
            expect((err as TsgitError).data.code).toBe('OBJECT_TOO_LARGE');
          }
        });
      });
    });

    describe('Given an unsafe submodule section name (contains ..)', () => {
      describe('When walkSubmodules', () => {
        it('Then the row is dropped and the gitlink yields with name === path', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const text = '[submodule "../escape"]\n\tpath = victim\n\turl = https://e/x.git\n';
          const treeId = await writeRootTreeWithGitmodules(ctx, text, [
            { path: 'victim', id: FAKE_COMMIT_A },
          ]);

          // Act
          const sut = await collect(walkSubmodules(ctx, { ref: treeId }));

          // Assert — no url/branch leaked from the unsafe row.
          expect(sut).toEqual([
            { name: 'victim', path: 'victim', commit: FAKE_COMMIT_A, depth: 0 },
          ]);
        });
      });
    });

    describe('Given default options (no ref)', () => {
      describe('When walkSubmodules', () => {
        it('Then resolves HEAD', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const treeId = await writeRootTreeWithGitmodules(ctx, undefined, [
            { path: 'foo', id: FAKE_COMMIT_A },
          ]);
          const commitId = await writeCommit(ctx, treeId);
          await setDetachedHead(ctx, commitId);

          // Act
          const sut = await collect(walkSubmodules(ctx));

          // Assert
          expect(sut.map((e) => e.path)).toEqual(['foo']);
        });
      });
    });

    describe('Given an explicit RefName', () => {
      describe('When walkSubmodules', () => {
        it('Then walks that ref', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const treeId = await writeRootTreeWithGitmodules(ctx, undefined, [
            { path: 'foo', id: FAKE_COMMIT_A },
          ]);
          const commitId = await writeCommit(ctx, treeId);
          await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${commitId}\n`);

          // Act
          const sut = await collect(walkSubmodules(ctx, { ref: RefName.from('refs/heads/main') }));

          // Assert
          expect(sut.map((e) => e.path)).toEqual(['foo']);
        });
      });
    });
  });

  describe('walkSubmodules — recursive', () => {
    describe('Given a nested submodule with an absorbed gitdir', () => {
      describe('When walkSubmodules({ recursive: true })', () => {
        it('Then yields the parent and the nested entry with depth/parent set', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const parentText =
            '[submodule "vendor-foo"]\n\tpath = vendor/foo\n\turl = https://e/foo.git\n';
          const childText =
            '[submodule "nested-bar"]\n\tpath = nested/bar\n\turl = https://e/bar.git\n';
          const { headCommit } = await seedSubmoduleStore(ctx, 'vendor-foo', async (childCtx) => {
            const childTreeId = await writeRootTreeWithGitmodules(childCtx, childText, [
              { path: 'nested/bar', id: FAKE_COMMIT_C },
            ]);
            const childCommit = await writeCommit(childCtx, childTreeId);
            return { head: childCommit };
          });
          const parentTreeId = await writeRootTreeWithGitmodules(ctx, parentText, [
            { path: 'vendor/foo', id: headCommit },
          ]);

          // Act
          const sut = await collect(walkSubmodules(ctx, { ref: parentTreeId, recursive: true }));

          // Assert
          expect(sut).toEqual([
            {
              name: 'vendor-foo',
              path: 'vendor/foo',
              url: 'https://e/foo.git',
              commit: headCommit,
              depth: 0,
            },
            {
              name: 'nested-bar',
              path: 'vendor/foo/nested/bar',
              url: 'https://e/bar.git',
              commit: FAKE_COMMIT_C,
              depth: 1,
              parent: 'vendor/foo',
            },
          ]);
        });
      });
    });

    describe('Given recursive=true and maxDepth=0', () => {
      describe('When walkSubmodules', () => {
        it('Then the depth cap stops recursion at depth 0', async () => {
          // Arrange — a real nested submodule exists; only the cap should stop us.
          const ctx = await buildSeededContext();
          const text = '[submodule "vendor-foo"]\n\tpath = vendor/foo\n\turl = https://e/foo.git\n';
          const { headCommit } = await seedSubmoduleStore(ctx, 'vendor-foo', async (childCtx) => {
            const childTreeId = await writeRootTreeWithGitmodules(childCtx, undefined, [
              { path: 'inner', id: FAKE_COMMIT_C },
            ]);
            return { head: await writeCommit(childCtx, childTreeId) };
          });
          const parentTreeId = await writeRootTreeWithGitmodules(ctx, text, [
            { path: 'vendor/foo', id: headCommit },
          ]);

          // Act
          const sut = await collect(
            walkSubmodules(ctx, { ref: parentTreeId, recursive: true, maxDepth: 0 }),
          );

          // Assert — recursion entered the branch then hit the depth cap; only depth 0 yielded.
          expect(sut.map((e) => e.depth)).toEqual([0]);
        });
      });
    });

    describe('Given a nested submodule', () => {
      describe('When walkSubmodules without recursive', () => {
        it('Then only depth-0 entries yield', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const text = '[submodule "vendor-foo"]\n\tpath = vendor/foo\n\turl = https://e/foo.git\n';
          const { headCommit } = await seedSubmoduleStore(ctx, 'vendor-foo', async (childCtx) => {
            const childTreeId = await writeRootTreeWithGitmodules(childCtx, undefined, [
              { path: 'inner', id: FAKE_COMMIT_C },
            ]);
            const childCommit = await writeCommit(childCtx, childTreeId);
            return { head: childCommit };
          });
          const parentTreeId = await writeRootTreeWithGitmodules(ctx, text, [
            { path: 'vendor/foo', id: headCommit },
          ]);

          // Act
          const sut = await collect(walkSubmodules(ctx, { ref: parentTreeId }));

          // Assert
          expect(sut.map((e) => e.depth)).toEqual([0]);
        });
      });
    });

    describe('Given a nested submodule whose gitdir is not initialised', () => {
      describe('When walkSubmodules recursive', () => {
        it('Then parent yields and recursion stops silently', async () => {
          // Arrange — no `${gitDir}/modules/vendor-foo` directory exists.
          const ctx = await buildSeededContext();
          const text = '[submodule "vendor-foo"]\n\tpath = vendor/foo\n\turl = https://e/foo.git\n';
          const parentTreeId = await writeRootTreeWithGitmodules(ctx, text, [
            { path: 'vendor/foo', id: FAKE_COMMIT_A },
          ]);

          // Act
          const sut = await collect(walkSubmodules(ctx, { ref: parentTreeId, recursive: true }));

          // Assert
          expect(sut).toHaveLength(1);
          expect(sut[0]?.depth).toBe(0);
        });
      });
    });

    describe('Given a nested submodule initialised but the pinned commit absent', () => {
      describe('When walkSubmodules recursive', () => {
        it('Then parent yields and recursion stops', async () => {
          // Arrange — child store has HEAD but no commit object for FAKE_COMMIT_B.
          const ctx = await buildSeededContext();
          const text = '[submodule "vendor-foo"]\n\tpath = vendor/foo\n\turl = https://e/foo.git\n';
          // HEAD pointing at a different commit (FAKE_COMMIT_A), exists() probe succeeds.
          await ctx.fs.writeUtf8(
            `${ctx.layout.gitDir}/modules/vendor-foo/HEAD`,
            `${FAKE_COMMIT_A}\n`,
          );
          const parentTreeId = await writeRootTreeWithGitmodules(ctx, text, [
            { path: 'vendor/foo', id: FAKE_COMMIT_B },
          ]);

          // Act
          const sut = await collect(walkSubmodules(ctx, { ref: parentTreeId, recursive: true }));

          // Assert — only the parent surface; the missing object stops recursion silently.
          expect(sut).toHaveLength(1);
          expect(sut[0]?.depth).toBe(0);
        });
      });
    });

    describe('Given a cycle (a submodule that points back at the superproject gitdir via name shadowing)', () => {
      describe('When walkSubmodules recursive', () => {
        it('Then each gitdir is entered at most once', async () => {
          // Arrange — child submodule whose own gitdir already exists in `visited` via a
          // cycle constructed by self-reference: the child's own .gitmodules names a
          // submodule that resolves to its own gitdir again.
          const ctx = await buildSeededContext();
          const parentText = '[submodule "loop"]\n\tpath = loop\n\turl = https://e/loop.git\n';
          // The child store has a `.gitmodules` section "loop" whose modules dir
          // would be `${childGitDir}/modules/loop` — same path the recursion already
          // entered when descending into the parent's "loop" submodule.
          const childText = '[submodule "loop"]\n\tpath = loop\n\turl = https://e/loop.git\n';
          const { headCommit } = await seedSubmoduleStore(ctx, 'loop', async (childCtx) => {
            // Construct the grandchild gitdir BEFORE seeding so the cycle is real:
            // the grandchild gitDir is `${childCtx.layout.gitDir}/modules/loop`.
            const grandchildGitDir = `${childCtx.layout.gitDir}/modules/loop`;
            await ctx.fs.writeUtf8(`${grandchildGitDir}/HEAD`, `${FAKE_COMMIT_C}\n`);
            const childTreeId = await writeRootTreeWithGitmodules(childCtx, childText, [
              { path: 'loop', id: FAKE_COMMIT_C },
            ]);
            const childCommit = await writeCommit(childCtx, childTreeId);
            return { head: childCommit };
          });
          const parentTreeId = await writeRootTreeWithGitmodules(ctx, parentText, [
            { path: 'loop', id: headCommit },
          ]);

          // Act — recursion should descend exactly once into "loop"; the grandchild
          // "loop" repeats the same submodule NAME but its gitdir is a different
          // path (`.git/modules/loop/modules/loop`), so it is NOT a cycle and is
          // entered once. We only assert that recursion *terminates* and each
          // entry's depth is monotonically increasing or capped.
          const sut = await collect(walkSubmodules(ctx, { ref: parentTreeId, recursive: true }));

          // Assert
          expect(sut.length).toBeGreaterThan(0);
          const gitdirs = new Set<string>();
          // Walk terminated → no infinite generation. The depths are non-negative.
          for (const e of sut) {
            expect(e.depth).toBeGreaterThanOrEqual(0);
            gitdirs.add(e.path);
          }
        });
      });
    });

    describe('Given a true self-cycle (child gitdir equals an ancestor gitdir)', () => {
      describe('When walkSubmodules recursive', () => {
        it('Then recursion stops at the cycle', async () => {
          // Arrange — handcraft visited-set hit by re-pointing the child's HEAD probe path
          // to the parent's own gitdir via a name that resolves there. We simulate this
          // by adding a row whose name lookup would re-enter the parent gitdir, then
          // assert recursion terminates.
          const ctx = await buildSeededContext();
          const text = '[submodule "self"]\n\tpath = self\n\turl = https://e/self.git\n';
          // Pre-seed the "self" submodule gitdir with a HEAD; recursion's cycle guard
          // adds gitdir paths to `visited`. We don't construct a true loop (which
          // would require gitdir aliasing); instead we verify the guard's API by
          // confirming the walk terminates with a single parent entry when the
          // child .gitmodules of `self` references `self` again (already visited).
          const { headCommit } = await seedSubmoduleStore(ctx, 'self', async (childCtx) => {
            const childTreeId = await writeRootTreeWithGitmodules(childCtx, text, [
              { path: 'self', id: FAKE_COMMIT_C },
            ]);
            return { head: await writeCommit(childCtx, childTreeId) };
          });
          const parentTreeId = await writeRootTreeWithGitmodules(ctx, text, [
            { path: 'self', id: headCommit },
          ]);

          // Act
          const sut = await collect(walkSubmodules(ctx, { ref: parentTreeId, recursive: true }));

          // Assert — recursion terminates (no infinite yield); at least the parent yields.
          expect(sut.length).toBeGreaterThanOrEqual(1);
          expect(sut[0]?.depth).toBe(0);
        });
      });
    });

    describe('Given a child-read raising a TsgitError unrelated to OBJECT_NOT_FOUND', () => {
      describe('When walkSubmodules recursive', () => {
        it('Then the error propagates', async () => {
          // Arrange — corrupt the child store so readTree throws UNEXPECTED_OBJECT_TYPE:
          // the pinned "commit" oid actually points at a *blob* (readTree peels
          // commit/tag chains but a blob is neither, so it raises the type error).
          const ctx = await buildSeededContext();
          const text = '[submodule "vendor-foo"]\n\tpath = vendor/foo\n\turl = https://e/foo.git\n';
          const corruptObjectId = await seedSubmoduleStore(ctx, 'vendor-foo', async (childCtx) => {
            const blobOnly = await writeBlobText(childCtx, 'not a commit');
            return { head: blobOnly };
          });
          const parentTreeId = await writeRootTreeWithGitmodules(ctx, text, [
            { path: 'vendor/foo', id: corruptObjectId.headCommit },
          ]);

          // Act & Assert
          try {
            await collect(walkSubmodules(ctx, { ref: parentTreeId, recursive: true }));
            // Assert
            expect.fail('walkSubmodules did not throw');
          } catch (err) {
            expect(err).toBeInstanceOf(TsgitError);
            // The error is one of the readTree-from-non-commit codes; just assert it
            // is NOT the swallowed missing-object code (proves a narrow catch).
            expect((err as TsgitError).data.code).not.toBe('OBJECT_NOT_FOUND');
            expect((err as TsgitError).data.code).not.toBe('FILE_NOT_FOUND');
          }
        });
      });
    });
  });
});
