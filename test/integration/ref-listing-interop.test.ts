/**
 * Cross-tool interop — ref enumeration over symbolic refs whose chain does
 * not resolve for reading. One shared base is built with canonical git and
 * planted with an over-deep symref chain, a dangling symref and a symref
 * loop, under `refs/heads/` and `refs/tags/` alike; every row compares the
 * names `git branch` / `git tag -l` print against the names tsgit's
 * `branchList` / `tagList` return.
 *
 * @proves
 *   surface:        branchList
 *   bucket:         cross-tool-interop
 *   unique:         branch and tag listings drop a chain git's own iterator drops
 *   interopSurface: branchList
 */
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { branchList } from '../../src/application/commands/branch.js';
import { maintenance } from '../../src/application/commands/maintenance.js';
import { packRefs } from '../../src/application/commands/pack-refs.js';
import { revList } from '../../src/application/commands/rev-list.js';
import { tagList } from '../../src/application/commands/tag.js';
import { getRefStore } from '../../src/application/primitives/ref-store.js';
import { resolveRef } from '../../src/application/primitives/resolve-ref.js';
import type { RefName } from '../../src/domain/objects/index.js';
import { openRepository } from '../../src/index.node.js';
import type { Context } from '../../src/ports/context.js';
import { disableAutoMaintenance, GIT_AVAILABLE, git, runGit } from './interop-helpers.js';

const SETUP_TIMEOUT = 60_000;

/** One hop past git's five-read symref walk. */
const OVER_DEEP_HOPS = 5;

describe.skipIf(!GIT_AVAILABLE)('integration — ref listing parity with canonical git', () => {
  let base = '';
  let ctx: Context;

  beforeAll(async () => {
    base = await mkdtemp(path.join(os.tmpdir(), 'tsgit-ref-listing-interop-'));
    runGit(['init', '-q', '-b', 'main', base]);
    git(base, 'config', 'user.name', 'A');
    git(base, 'config', 'user.email', 'a@x');
    git(base, 'config', 'commit.gpgsign', 'false');
    git(base, 'config', 'tag.gpgsign', 'false');
    disableAutoMaintenance(base);
    await writeFile(path.join(base, 'f.txt'), 'c1\n');
    git(base, 'add', '-A');
    git(base, 'commit', '-q', '-m', 'c1');
    git(base, 'tag', 'plain');

    // A chain of symrefs ending on a real branch: `chain0` needs one read
    // more than git takes, `chain1` exactly as many as it takes.
    git(base, 'branch', 'tip', 'main');
    for (let step = OVER_DEEP_HOPS - 1; step >= 0; step -= 1) {
      const target = step === OVER_DEEP_HOPS - 1 ? 'tip' : `chain${step + 1}`;
      git(base, 'symbolic-ref', `refs/heads/chain${step}`, `refs/heads/${target}`);
    }
    git(base, 'symbolic-ref', 'refs/tags/deep', 'refs/heads/chain0');
    git(base, 'symbolic-ref', 'refs/heads/dang', 'refs/heads/gone');
    // A loop, written directly: `symbolic-ref` builds one hop at a time and
    // the second hop would close the cycle on a name it must first read.
    await writeFile(path.join(base, '.git', 'refs', 'heads', 'cyc1'), 'ref: refs/heads/cyc2\n');
    await writeFile(path.join(base, '.git', 'refs', 'heads', 'cyc2'), 'ref: refs/heads/cyc1\n');

    ctx = createNodeContext({ workDir: base });
  }, SETUP_TIMEOUT);

  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  const gitNames = (prefix: string, ...args: ReadonlyArray<string>): ReadonlyArray<string> =>
    git(base, ...args)
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => `${prefix}${line}`)
      .sort();

  /** The branch names one listing form prints, fully qualified and sorted.
   *  `show-ref` leads with an oid and `branch -v` with a current marker plus
   *  a short name, so each shape is reduced to its ref name here. */
  const gitBranchNames = (args: ReadonlyArray<string>): ReadonlyArray<string> =>
    git(base, ...args)
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => {
        if (args[0] === 'show-ref') return line.slice(line.indexOf(' ') + 1);
        if (args[0] === 'branch') return `refs/heads/${line.slice(2).split(/\s+/)[0] ?? ''}`;
        return line;
      })
      .sort();

  describe('Given branch symrefs that are over-deep, dangling and looping', () => {
    describe('When both tools list branches', () => {
      it('Then they name exactly the same branches', async () => {
        // Arrange
        const expected = gitNames('', 'branch', '--format=%(refname)');

        // Act
        const { branches } = await branchList(ctx);

        // Assert
        expect(branches.map((branch) => branch.name as string).sort()).toEqual(expected);
        expect(expected).not.toContain('refs/heads/chain0');
        expect(expected).not.toContain('refs/heads/dang');
        expect(expected).not.toContain('refs/heads/cyc1');
        expect(expected).toContain('refs/heads/chain1');
      });
    });

    describe('When both tools report the tip value of the deepest readable chain', () => {
      it('Then they agree on its object id', async () => {
        // Arrange
        const expected = git(base, 'rev-parse', 'refs/heads/chain1').trim();

        // Act
        const { branches } = await branchList(ctx);

        // Assert
        const chain = branches.find((branch) => branch.name === ('refs/heads/chain1' as RefName));
        expect(chain?.id).toBe(expected);
      });
    });
  });

  describe('Given the other listing forms git offers over the same refs', () => {
    describe.each([
      { label: 'for-each-ref', args: ['for-each-ref', '--format=%(refname)', 'refs/heads'] },
      { label: 'show-ref --heads', args: ['show-ref', '--heads'] },
      { label: 'branch -v', args: ['branch', '-v'] },
    ])('When $label and tsgit branchList both enumerate them', (row) => {
      it('Then every form names exactly the branches tsgit lists', async () => {
        // Arrange — each form prints its own columns, so the names are read
        // back out of the line rather than assumed to be the whole line.
        const expected = gitBranchNames(row.args);

        // Act
        const { branches } = await branchList(ctx);

        // Assert
        expect(branches.map((branch) => branch.name as string).sort()).toEqual(expected);
        expect(expected).not.toContain('refs/heads/chain0');
        expect(expected).toContain('refs/heads/chain1');
      });
    });

    describe('When show-ref and tsgit branchList both report the values', () => {
      it('Then every branch carries the same object id on both sides', async () => {
        // Arrange
        const expected = new Map(
          git(base, 'show-ref', '--heads')
            .split('\n')
            .filter((line) => line.length > 0)
            .map((line) => [line.slice(line.indexOf(' ') + 1), line.slice(0, line.indexOf(' '))]),
        );

        // Act
        const { branches } = await branchList(ctx);

        // Assert
        expect(
          new Map(branches.map((branch) => [branch.name as string, branch.id as string])),
        ).toEqual(expected);
      });
    });

    describe('When for-each-ref and tsgit tagList both enumerate the tags', () => {
      it('Then both name only the tag whose chain resolves', async () => {
        // Arrange
        const expected = gitNames('', 'for-each-ref', '--format=%(refname)', 'refs/tags');

        // Act
        const { tags } = await tagList(ctx);

        // Assert
        expect(tags.map((tag) => tag.name as string).sort()).toEqual(expected);
        expect(expected).toEqual(['refs/tags/plain']);
      });
    });
  });

  describe('Given a tag symref whose chain runs past the reading walk', () => {
    describe('When both tools list tags', () => {
      it('Then they name exactly the same tags', async () => {
        // Arrange
        const expected = gitNames('refs/tags/', 'tag', '-l');

        // Act
        const { tags } = await tagList(ctx);

        // Assert
        expect(tags.map((tag) => tag.name as string).sort()).toEqual(expected);
        expect(expected).not.toContain('refs/tags/deep');
        expect(expected).toContain('refs/tags/plain');
      });
    });
  });
});

const listRefNamesOf = async (ctx: Context): Promise<ReadonlyArray<string>> =>
  (await getRefStore(ctx).listRefs('refs/' as RefName)).map((entry) => entry.name as string).sort();

const UNREADABLE = 0o000;
const READABLE_NOT_SEARCHABLE = 0o400;
const RESTORED = 0o755;
const PERMISSION_BITS_ENFORCED = process.platform !== 'win32' && process.getuid?.() !== 0;

describe.skipIf(!GIT_AVAILABLE || !PERMISSION_BITS_ENFORCED)(
  'integration — an unreadable loose-ref directory, as canonical git treats it',
  () => {
    const roots: string[] = [];
    const restorers: Array<() => void> = [];

    afterAll(async () => {
      for (const restore of restorers) restore();
      for (const root of roots) await rm(root, { recursive: true, force: true });
    });

    const newRepo = async (): Promise<{ dir: string; ctx: Context; commit: string }> => {
      const dir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-unreadable-dir-'));
      roots.push(dir);
      runGit(['init', '-q', '-b', 'main', dir]);
      git(dir, 'config', 'user.name', 'A');
      git(dir, 'config', 'user.email', 'a@x');
      git(dir, 'config', 'commit.gpgsign', 'false');
      disableAutoMaintenance(dir);
      await writeFile(path.join(dir, 'f.txt'), 'c1\n');
      git(dir, 'add', '-A');
      git(dir, 'commit', '-q', '-m', 'c1');
      const commit = git(dir, 'rev-parse', 'HEAD').trim();
      return { dir, ctx: createNodeContext({ workDir: dir }), commit };
    };

    const heads = (dir: string): string => path.join(dir, '.git', 'refs', 'heads');

    /** A ref `refs/heads/d/x` whose directory `d/` then gets `mode`. */
    const withDirAt = (dir: string, commit: string, mode: number, extra = 'd/x'): void => {
      const target = path.join(heads(dir), path.dirname(extra));
      mkdirSync(target, { recursive: true });
      git(dir, 'update-ref', `refs/heads/${extra}`, commit);
      chmodSync(target, mode);
      restorers.push(() => chmodSync(target, RESTORED));
    };

    const lines = (out: string): ReadonlyArray<string> =>
      out
        .split('\n')
        .filter((line) => line.length > 0)
        .sort();

    describe('Given refs/heads/d/ is unreadable', () => {
      describe('When both tools list the refs', () => {
        it('Then tsgit names what for-each-ref names', async () => {
          // Arrange
          const { dir, ctx, commit } = await newRepo();
          withDirAt(dir, commit, UNREADABLE);
          const expected = lines(git(dir, 'for-each-ref', '--format=%(refname)'));
          const sut = listRefNamesOf;

          // Act
          const result = await sut(ctx);

          // Assert
          expect(result).toEqual(expected);
          expect(expected).toEqual(['refs/heads/main']);
        });

        it('Then branchList names what branch -a names', async () => {
          // Arrange
          const { dir, ctx, commit } = await newRepo();
          withDirAt(dir, commit, UNREADABLE);
          const expected = lines(git(dir, 'branch', '-a', '--format=%(refname)'));
          const sut = branchList;

          // Act
          const result = await sut(ctx);

          // Assert
          expect(result.branches.map((branch) => branch.name as string).sort()).toEqual(expected);
        });

        it('Then show-ref and rev-list --all agree with tsgit', async () => {
          // Arrange
          const { dir, ctx, commit } = await newRepo();
          const hiddenCommit = git(
            dir,
            'commit-tree',
            `${commit}^{tree}`,
            '-p',
            commit,
            '-m',
            'd',
          ).trim();
          withDirAt(dir, hiddenCommit, UNREADABLE);
          const expectedRefs = lines(git(dir, 'show-ref'));
          const expectedCount = Number(git(dir, 'rev-list', '--all', '--count').trim());
          const sut = revList;

          // Act
          const result = await sut(ctx, { all: true, count: true });
          const listed = (await getRefStore(ctx).listRefs('refs/' as RefName)).map(
            (entry) => `${entry.value.kind === 'direct' ? entry.value.id : ''} ${entry.name}`,
          );

          // Assert
          expect(result.count).toBe(expectedCount);
          expect([...listed].sort()).toEqual(expectedRefs);
          expect(expectedRefs).toEqual([`${commit} refs/heads/main`]);
          expect(expectedCount).toBe(1);
        });
      });

      describe('When both tools pack refs', () => {
        it('Then packed-refs is byte-identical', async () => {
          // Arrange
          const git1 = await newRepo();
          const tsgit = await newRepo();
          withDirAt(git1.dir, git1.commit, UNREADABLE);
          withDirAt(tsgit.dir, tsgit.commit, UNREADABLE);
          const sut = packRefs;

          // Act
          git(git1.dir, 'pack-refs', '--all');
          await sut(tsgit.ctx);

          // Assert
          const read = (dir: string): string =>
            readFileSync(path.join(dir, '.git', 'packed-refs'), 'utf8').replace(
              /^[0-9a-f]{40}/gm,
              'OID',
            );
          expect(read(tsgit.dir)).toBe(read(git1.dir));
        });
      });

      describe('When both tools resolve the ref inside it', () => {
        it('Then git dies and tsgit refuses with PERMISSION_DENIED', async () => {
          // Arrange
          const { dir, ctx, commit } = await newRepo();
          withDirAt(dir, commit, UNREADABLE);
          const sut = resolveRef;

          // Act
          let gitStatus = 0;
          try {
            git(dir, 'rev-parse', '--verify', '-q', 'refs/heads/d/x');
          } catch (err) {
            gitStatus = (err as { status: number }).status;
          }
          let code: unknown;
          try {
            await sut(ctx, 'refs/heads/d/x' as RefName);
          } catch (err) {
            code = (err as { data?: { code?: string } }).data?.code;
          }

          // Assert
          expect(gitStatus).not.toBe(0);
          expect(code).toBe('PERMISSION_DENIED');
        });
      });
    });

    describe('Given refs/heads/a/ and refs/heads/z/ bracket a readable ref', () => {
      describe.each([
        { label: 'first', dir: 'a/x' },
        { label: 'last', dir: 'z/x' },
      ])('When the $label directory is unreadable', (row) => {
        it('Then tsgit names what for-each-ref names', async () => {
          // Arrange
          const { dir, ctx, commit } = await newRepo();
          git(dir, 'update-ref', 'refs/heads/a/x', commit);
          git(dir, 'update-ref', 'refs/heads/z/x', commit);
          withDirAt(dir, commit, UNREADABLE, row.dir);
          const expected = lines(git(dir, 'for-each-ref', '--format=%(refname)'));
          const sut = listRefNamesOf;

          // Act
          const result = await sut(ctx);

          // Assert
          expect(result).toEqual(expected);
        });
      });
    });

    describe('Given refs/heads is itself unreadable', () => {
      describe('When both tools list the refs', () => {
        it('Then tsgit names what for-each-ref names', async () => {
          // Arrange
          const { dir, ctx } = await newRepo();
          git(dir, 'update-ref', 'refs/tags/t', 'HEAD');
          chmodSync(heads(dir), UNREADABLE);
          restorers.push(() => chmodSync(heads(dir), RESTORED));
          const expected = lines(git(dir, 'for-each-ref', '--format=%(refname)'));
          const sut = listRefNamesOf;

          // Act
          const result = await sut(ctx);

          // Assert
          expect(result).toEqual(expected);
        });
      });
    });

    describe('Given d/x is also packed while refs/heads/d/ is unreadable', () => {
      describe('When both tools list the refs', () => {
        it('Then the packed ref is still named', async () => {
          // Arrange
          const { dir, ctx, commit } = await newRepo();
          git(dir, 'update-ref', 'refs/heads/d/x', commit);
          git(dir, 'pack-refs', '--all');
          mkdirSync(path.join(heads(dir), 'd'), { recursive: true });
          chmodSync(path.join(heads(dir), 'd'), UNREADABLE);
          restorers.push(() => chmodSync(path.join(heads(dir), 'd'), RESTORED));
          const expected = lines(git(dir, 'for-each-ref', '--format=%(refname)'));
          const sut = listRefNamesOf;

          // Act
          const result = await sut(ctx);

          // Assert
          expect(result).toEqual(expected);
          expect(expected).toContain('refs/heads/d/x');
        });
      });
    });

    describe('Given a symlink to an unreadable directory under refs/heads', () => {
      describe('When both tools list the refs', () => {
        it('Then tsgit names what for-each-ref names', async () => {
          // Arrange
          const { dir, ctx, commit } = await newRepo();
          withDirAt(dir, commit, UNREADABLE);
          symlinkSync(path.join(heads(dir), 'd'), path.join(heads(dir), 'link'));
          const expected = lines(git(dir, 'for-each-ref', '--format=%(refname)'));
          const sut = listRefNamesOf;

          // Act
          const result = await sut(ctx);

          // Assert
          expect(result).toEqual(expected);
        });
      });
    });

    const gitFailureStatus = (dir: string, ...args: ReadonlyArray<string>): number => {
      try {
        git(dir, ...args);
        return 0;
      } catch (err) {
        return (err as { status: number }).status;
      }
    };

    const refusalCodeOf = async (attempt: () => Promise<unknown>): Promise<unknown> => {
      try {
        await attempt();
        return undefined;
      } catch (err) {
        return (err as { data?: { code?: string } }).data?.code;
      }
    };

    describe.each([
      { label: 'a nested directory', refs: ['d/e/x', 'd/f'], dir: 'd/e/x', root: 'heads' },
      { label: 'a directory under refs/tags', refs: ['d/x'], dir: 'd/x', root: 'tags' },
      { label: 'the only directory under refs/heads', refs: ['d/x'], dir: 'd/x', root: 'heads' },
      {
        label: 'a directory that is searchable but not readable',
        refs: ['d/x'],
        dir: 'd/x',
        root: 'heads',
        mode: 0o300,
      },
    ])('Given $label is unreadable', (row) => {
      describe('When both tools list the refs', () => {
        it('Then tsgit names what for-each-ref names', async () => {
          // Arrange
          const { dir, ctx, commit } = await newRepo();
          for (const name of row.refs) git(dir, 'update-ref', `refs/${row.root}/${name}`, commit);
          if (row.label.includes('only')) git(dir, 'update-ref', '-d', 'refs/heads/main');
          const target = path.join(dir, '.git', 'refs', row.root, path.dirname(row.dir));
          chmodSync(target, row.mode ?? UNREADABLE);
          restorers.push(() => chmodSync(target, RESTORED));
          const expected = lines(git(dir, 'for-each-ref', '--format=%(refname)'));
          const sut = listRefNamesOf;

          // Act
          const result = await sut(ctx);

          // Assert
          expect(result).toEqual(expected);
        });
      });
    });

    describe('Given refs/heads/d/ is readable but not searchable', () => {
      describe('When both tools walk every ref', () => {
        it('Then git dies on rev-list --all and tsgit revList refuses, while listings agree', async () => {
          // Arrange
          const { dir, ctx, commit } = await newRepo();
          withDirAt(dir, commit, READABLE_NOT_SEARCHABLE);
          const expected = lines(git(dir, 'for-each-ref', '--format=%(refname)'));
          const sut = revList;

          // Act
          const gitStatus = gitFailureStatus(dir, 'rev-list', '--all');
          const code = await refusalCodeOf(() => sut(ctx, { all: true }));
          const listed = await listRefNamesOf(ctx);

          // Assert
          expect(gitStatus).toBe(128);
          expect(code).toBeDefined();
          expect(listed).toEqual(expected);
        });
      });
    });

    describe('Given d/x is packed while refs/heads/d/ is unreadable', () => {
      describe('When both tools resolve refs/heads/d/x', () => {
        it('Then git dies and tsgit refuses with PERMISSION_DENIED', async () => {
          // Arrange
          const { dir, ctx, commit } = await newRepo();
          git(dir, 'update-ref', 'refs/heads/d/x', commit);
          git(dir, 'pack-refs', '--all');
          mkdirSync(path.join(heads(dir), 'd'), { recursive: true });
          chmodSync(path.join(heads(dir), 'd'), UNREADABLE);
          restorers.push(() => chmodSync(path.join(heads(dir), 'd'), RESTORED));
          const sut = resolveRef;

          // Act
          const gitStatus = gitFailureStatus(dir, 'rev-parse', 'refs/heads/d/x');
          const code = await refusalCodeOf(() => sut(ctx, 'refs/heads/d/x' as RefName));

          // Assert
          expect(gitStatus).toBe(128);
          expect(code).toBe('PERMISSION_DENIED');
        });
      });
    });

    describe('Given a linked worktree whose own refs root has no access', () => {
      describe('When the refs are listed from the linked worktree', () => {
        it('Then tsgit lists what git for-each-ref lists', async () => {
          // Arrange
          const { dir } = await newRepo();
          const linked = `${dir}-linked`;
          roots.push(linked);
          git(dir, 'worktree', 'add', '-q', '-b', 'wtb', linked);
          const ownRefs = path.join(dir, '.git', 'worktrees', path.basename(linked), 'refs');
          mkdirSync(path.join(ownRefs, 'bisect'), { recursive: true });
          writeFileSync(path.join(ownRefs, 'bisect', 'good'), git(linked, 'rev-parse', 'HEAD'));
          chmodSync(ownRefs, UNREADABLE);
          restorers.push(() => chmodSync(ownRefs, RESTORED));
          const expected = git(linked, 'for-each-ref', '--format=%(refname)')
            .split('\n')
            .filter(Boolean);
          const repo = await openRepository({ cwd: linked });
          const sut = listRefNamesOf;

          // Act
          const result = await sut(repo.ctx);

          // Assert
          expect(result).toEqual(expected.sort());
        });
      });
    });

    describe('Given an unreferenced commit named only by a ref under a refs root that is searchable but not listable', () => {
      const SEARCHABLE_NOT_LISTABLE = 0o300;
      const orphanBehindRefsRoot = async (): Promise<{ dir: string; ctx: Context; id: string }> => {
        const repo = await newRepo();
        git(repo.dir, 'config', 'gc.pruneExpire', 'now');
        const tree = git(repo.dir, 'rev-parse', 'HEAD^{tree}').trim();
        const id = git(repo.dir, 'commit-tree', tree, '-m', 'orphan').trim();
        git(repo.dir, '-c', 'core.logAllRefUpdates=false', 'update-ref', 'refs/heads/side', id);
        git(repo.dir, 'update-ref', '-d', 'HEAD');
        const refsRoot = path.join(repo.dir, '.git', 'refs');
        chmodSync(refsRoot, SEARCHABLE_NOT_LISTABLE);
        restorers.push(() => chmodSync(refsRoot, RESTORED));
        return { ...repo, id };
      };
      const exists = (dir: string, id: string): boolean => {
        try {
          git(dir, 'cat-file', '-t', id);
          return true;
        } catch {
          return false;
        }
      };

      describe('When gc prunes', () => {
        it('Then git and tsgit both complete and the object is gone', async () => {
          // Arrange
          const g = await orphanBehindRefsRoot();
          const t = await orphanBehindRefsRoot();
          const sut = maintenance;

          // Act
          git(g.dir, 'gc', '-q', '--prune=now');
          const result = await sut(t.ctx, { tasks: ['gc'] });

          // Assert
          chmodSync(path.join(g.dir, '.git', 'refs'), RESTORED);
          chmodSync(path.join(t.dir, '.git', 'refs'), RESTORED);
          expect(result.tasksFailed).toEqual([]);
          expect(exists(g.dir, g.id)).toBe(false);
          expect(exists(t.dir, t.id)).toBe(false);
        });
      });
    });

    describe('Given an unreferenced commit named only by a ref in an unreadable directory', () => {
      const orphan = async (mode: number): Promise<{ dir: string; ctx: Context; id: string }> => {
        const repo = await newRepo();
        git(repo.dir, 'config', 'gc.pruneExpire', 'now');
        const tree = git(repo.dir, 'rev-parse', 'HEAD^{tree}').trim();
        const id = git(repo.dir, 'commit-tree', tree, '-m', 'orphan').trim();
        git(repo.dir, '-c', 'core.logAllRefUpdates=false', 'update-ref', 'refs/heads/d/x', id);
        git(repo.dir, 'update-ref', '-d', 'HEAD');
        const target = path.join(heads(repo.dir), 'd');
        chmodSync(target, mode);
        restorers.push(() => chmodSync(target, RESTORED));
        return { ...repo, id };
      };
      const exists = (dir: string, id: string): boolean => {
        try {
          git(dir, 'cat-file', '-t', id);
          return true;
        } catch {
          return false;
        }
      };

      describe('When gc prunes at mode 000', () => {
        it('Then git and tsgit both complete and the object is gone', async () => {
          // Arrange
          const g = await orphan(UNREADABLE);
          const t = await orphan(UNREADABLE);
          const sut = maintenance;

          // Act
          git(g.dir, 'gc', '-q');
          const result = await sut(t.ctx, { tasks: ['gc'] });

          // Assert
          expect(result.tasksFailed).toEqual([]);
          chmodSync(path.join(heads(g.dir), 'd'), RESTORED);
          chmodSync(path.join(heads(t.dir), 'd'), RESTORED);
          expect(exists(g.dir, g.id)).toBe(false);
          expect(exists(t.dir, t.id)).toBe(false);
        });
      });

      describe('When gc prunes at mode 0400', () => {
        it('Then git dies and tsgit does not complete, keeping the object', async () => {
          // Arrange
          const g = await orphan(READABLE_NOT_SEARCHABLE);
          const t = await orphan(READABLE_NOT_SEARCHABLE);
          const sut = maintenance;

          // Act
          let gitStatus = 0;
          try {
            git(g.dir, 'gc', '-q');
          } catch (err) {
            gitStatus = (err as { status: number }).status;
          }
          const outcome = await sut(t.ctx, { tasks: ['gc'] }).then(
            (result) => result.tasksFailed.length > 0,
            () => true,
          );

          // Assert
          chmodSync(path.join(heads(g.dir), 'd'), RESTORED);
          chmodSync(path.join(heads(t.dir), 'd'), RESTORED);
          expect(gitStatus).toBe(128);
          expect(outcome).toBe(true);
          expect(exists(g.dir, g.id)).toBe(true);
          expect(exists(t.dir, t.id)).toBe(true);
        });
      });
    });
  },
);
