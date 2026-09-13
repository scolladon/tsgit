/**
 * Cross-tool interop — the repo-settings tier (`core.maxTreeDepth` validated
 * at the object-store, index and commit-graph boundaries, plus explicit
 * per-builtin transcriptions, instead of the eager operational gate).
 *
 * `test/integration/max-tree-depth-config-interop.test.ts` re-proves the
 * ROWS THAT ALREADY EXISTED under the eager gate hold unchanged. This file
 * covers what only the new tier gets right: the three previously
 * over-refused verbs now run; the two fixture-conditional verbs agree with
 * git in BOTH fixtures; the transcribed per-builtin prologues refuse on
 * their own boundary-free paths, in git's OWN measured order against the
 * work-tree requirement; and the residual two-class ordering split this
 * tier deliberately does not close.
 *
 * @proves
 *   surface:        repo-settings-gate
 *   bucket:         cross-tool-interop
 *   unique:         the three over-refused verbs now run, the two
 *                    fixture-conditional verbs agree with git in both
 *                    fixtures, and the residual two-class ordering split is
 *                    pinned, not silently divergent
 *   interopSurface: branch, tag, rev-parse, sparse-checkout, stash, reflog,
 *                    notes, pack-refs, status, show
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import {
  branchCreate,
  branchDelete,
  branchList,
  branchRename,
} from '../../src/application/commands/branch.js';
import { notesList } from '../../src/application/commands/notes.js';
import { packRefs } from '../../src/application/commands/pack-refs.js';
import { reflog } from '../../src/application/commands/reflog.js';
import { revParse } from '../../src/application/commands/rev-parse.js';
import { show } from '../../src/application/commands/show.js';
import { sparseCheckoutList } from '../../src/application/commands/sparse-checkout.js';
import { stashList } from '../../src/application/commands/stash.js';
import { status } from '../../src/application/commands/status.js';
import { tagCreate, tagDelete, tagList } from '../../src/application/commands/tag.js';
import { TsgitError } from '../../src/domain/error.js';
import type { Context } from '../../src/ports/context.js';
import { GIT_AVAILABLE, git, runGit, runGitEnv, tryRunGitWithExit } from './interop-helpers.js';

const SETUP_TIMEOUT = 60_000;

const datedEnv = (epoch: number): NodeJS.ProcessEnv => ({
  ...runGitEnv(),
  GIT_AUTHOR_NAME: 'A U Thor',
  GIT_AUTHOR_EMAIL: 'author@example.com',
  GIT_AUTHOR_DATE: `${epoch} +0000`,
  GIT_COMMITTER_NAME: 'A U Thor',
  GIT_COMMITTER_EMAIL: 'author@example.com',
  GIT_COMMITTER_DATE: `${epoch} +0000`,
});

interface BadNumericData {
  readonly code: string;
  readonly key: string;
  readonly value: string;
  readonly reason: string;
}

const assertRefusesWithBadMaxTreeDepth = async (op: () => Promise<unknown>): Promise<void> => {
  let caught: unknown;
  try {
    await op();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(TsgitError);
  const data = (caught as TsgitError).data as BadNumericData;
  expect(data.code).toBe('CONFIG_BAD_NUMERIC_VALUE');
  expect(data.key).toBe('core.maxtreedepth');
};

/** A non-bare repo with one commit, a branch, and a tag — the shared
 *  read-only fixture for rows that never mutate it. */
const buildReadonlyRepo = async (dir: string): Promise<void> => {
  const env = datedEnv(1_700_000_000);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'A U Thor');
  git(dir, 'config', 'user.email', 'author@example.com');
  git(dir, 'config', 'commit.gpgsign', 'false');
  await writeFile(path.join(dir, 'file.txt'), 'hello\n');
  git(dir, 'add', '-A');
  runGit(['-C', dir, 'commit', '-q', '--no-gpg-sign', '-m', 'c0'], { env });
  git(dir, 'branch', 'feature');
  git(dir, 'tag', 'v1.0');
};

const poison = async (dir: string): Promise<void> => {
  await writeFile(path.join(dir, '.git', 'config'), '[core]\n\tmaxTreeDepth = 2.5\n', {
    flag: 'a',
  });
};

/** Same as {@link poison}, for a `--bare` repository (config sits at `<dir>/config`). */
const poisonBare = async (dir: string): Promise<void> => {
  await writeFile(path.join(dir, 'config'), '[core]\n\tmaxTreeDepth = 2.5\n', { flag: 'a' });
};

/** `createNodeContext` always sets a `workDir`, even for `bare: true` — drop
 *  it so `requireWorkTree` sees a genuinely work-tree-less repository, the
 *  same shape `openRepository`'s own discovery produces for a bare repo. */
const asBareContext = (ctx: Context): Context => {
  const { workDir: _workDir, ...bareLayout } = ctx.layout;
  return { ...ctx, layout: { ...bareLayout, bare: true } };
};

describe.skipIf(!GIT_AVAILABLE)('repo-settings tier — cross-tool interop', () => {
  describe('Given a repo with a branch and a tag, poisoned AFTER setup', () => {
    let dir = '';
    let ctx: Context;

    beforeAll(async () => {
      dir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-repo-settings-readonly-'));
      await buildReadonlyRepo(dir);
      await poison(dir);
      ctx = createNodeContext({ workDir: dir });
    }, SETUP_TIMEOUT);

    afterAll(async () => rm(dir, { recursive: true, force: true }));

    describe('When branch --list runs', () => {
      it('Then git exits 0 and tsgit branchList succeeds — no longer over-refused', async () => {
        // Arrange + Act — against the shared beforeAll repo, whose local
        // config already holds an invalid core.maxTreeDepth.
        const g = tryRunGitWithExit(['-C', dir, 'branch', '--list']);
        const result = await branchList(ctx);

        // Assert
        expect(g.exitCode).toBe(0);
        expect(result.branches.map((b) => b.name)).toContain('refs/heads/main');
      });
    });

    describe('When tag --list runs', () => {
      it('Then git exits 0 and tsgit tagList succeeds — no longer over-refused', async () => {
        // Arrange + Act
        const g = tryRunGitWithExit(['-C', dir, 'tag', '--list']);
        const result = await tagList(ctx);

        // Assert
        expect(g.exitCode).toBe(0);
        expect(result.tags.map((t) => t.name)).toContain('refs/tags/v1.0');
      });
    });

    describe('When reflog exists runs', () => {
      it('Then git exits 0 and tsgit reflog(exists) succeeds', async () => {
        // Arrange + Act
        const g = tryRunGitWithExit(['-C', dir, 'reflog', 'exists', 'refs/heads/main']);
        const result = await reflog(ctx, { action: 'exists', ref: 'refs/heads/main' });

        // Assert
        expect(g.exitCode).toBe(0);
        expect(result).toEqual({ kind: 'exists', exists: true });
      });
    });

    describe('When notes list runs (idle: the notes ref was never touched)', () => {
      it('Then git exits 0 and tsgit notesList succeeds', async () => {
        // Arrange + Act
        const g = tryRunGitWithExit(['-C', dir, 'notes', 'list']);
        const result = await notesList(ctx);

        // Assert
        expect(g.exitCode).toBe(0);
        expect(result).toEqual([]);
      });
    });

    describe('When rev-parse --git-dir runs', () => {
      it('Then git exits 128 and tsgit revParse throws — O6: even --git-dir dies', async () => {
        // Arrange + Act
        const g = tryRunGitWithExit(['-C', dir, 'rev-parse', '--git-dir']);

        // Assert
        expect(g.exitCode).toBe(128);
        await assertRefusesWithBadMaxTreeDepth(() => revParse(ctx, '--git-dir'));
      });
    });

    describe('When rev-parse nope (an unresolvable argument) runs', () => {
      it('Then git exits 128 and tsgit revParse throws the class, not an unresolved-ref error', async () => {
        // Arrange + Act
        const g = tryRunGitWithExit(['-C', dir, 'rev-parse', 'nope']);

        // Assert
        expect(g.exitCode).toBe(128);
        await assertRefusesWithBadMaxTreeDepth(() => revParse(ctx, 'nope'));
      });
    });

    describe('When branch -d nope (unforced, nonexistent) runs', () => {
      it('Then git exits 128 and tsgit branchDelete throws the class — O1: dies before "not found"', async () => {
        // Arrange + Act
        const g = tryRunGitWithExit(['-C', dir, 'branch', '-d', 'nope']);

        // Assert
        expect(g.exitCode).toBe(128);
        await assertRefusesWithBadMaxTreeDepth(() => branchDelete(ctx, { name: 'nope' }));
      });
    });

    describe('When tag -d nope (nonexistent) runs', () => {
      it('Then git exits 1 ("not found") and tsgit tagDelete throws TAG_NOT_FOUND, not the class — O2', async () => {
        // Arrange + Act
        const g = tryRunGitWithExit(['-C', dir, 'tag', '-d', 'nope']);
        let caught: unknown;
        try {
          await tagDelete(ctx, { name: 'nope' });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(g.exitCode).toBe(1);
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('TAG_NOT_FOUND');
      });
    });

    describe('When tag t3 nope (an unresolvable target) runs', () => {
      it('Then git exits 128 with an unresolved-ref fatal, and tsgit tagCreate throws REF_NOT_FOUND, not the class — O3', async () => {
        // Arrange + Act
        const g = tryRunGitWithExit(['-C', dir, 'tag', 't3', 'nope']);
        let caught: unknown;
        try {
          await tagCreate(ctx, { name: 't3', target: 'nope' });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(g.exitCode).toBe(128);
        expect(g.stderr).not.toContain('bad numeric config value');
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('REF_NOT_FOUND');
      });
    });

    describe('When tag t2 HEAD (a resolvable target) runs', () => {
      it('Then git exits 128 on the class and tsgit tagCreate throws it too', async () => {
        // Arrange + Act
        const g = tryRunGitWithExit(['-C', dir, 'tag', 't2', 'HEAD']);

        // Assert
        expect(g.exitCode).toBe(128);
        await assertRefusesWithBadMaxTreeDepth(() =>
          tagCreate(ctx, { name: 't2', target: 'HEAD' }),
        );
      });
    });
  });

  describe('Given a bare repository, poisoned AFTER setup', () => {
    let dir = '';
    let ctx: Context;

    beforeAll(async () => {
      dir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-repo-settings-bare-'));
      git(dir, 'init', '-q', '--bare', '-b', 'main');
      git(dir, 'config', 'user.name', 'A U Thor');
      git(dir, 'config', 'user.email', 'author@example.com');
      await poisonBare(dir);
      ctx = asBareContext(createNodeContext({ workDir: dir, gitDir: dir, bare: true }));
    }, SETUP_TIMEOUT);

    afterAll(async () => rm(dir, { recursive: true, force: true }));

    describe('When sparse-checkout list runs', () => {
      it('Then both die on the class — W1: the class is checked before the work-tree requirement', async () => {
        // Arrange + Act
        const g = tryRunGitWithExit(['-C', dir, 'sparse-checkout', 'list']);

        // Assert
        expect(g.exitCode).toBe(128);
        expect(g.stderr).toContain('bad numeric config value');
        await assertRefusesWithBadMaxTreeDepth(() => sparseCheckoutList(ctx));
      });
    });

    describe('When stash list runs', () => {
      it('Then both die on the WORK TREE requirement, not the class — W1: git checks NEED_WORK_TREE first', async () => {
        // Arrange + Act
        const g = tryRunGitWithExit(['-C', dir, 'stash', 'list']);
        let caught: unknown;
        try {
          await stashList(ctx);
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(g.exitCode).toBe(128);
        expect(g.stderr).toContain('work tree');
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('WORK_TREE_REQUIRED');
      });
    });
  });

  describe('Given a freshly initialised repo with no refs at all, poisoned AFTER init', () => {
    let dir = '';
    let ctx: Context;

    beforeAll(async () => {
      dir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-repo-settings-pack-refs-idle-'));
      git(dir, 'init', '-q', '-b', 'main');
      git(dir, 'config', 'user.name', 'A U Thor');
      git(dir, 'config', 'user.email', 'author@example.com');
      await poison(dir);
      ctx = createNodeContext({ workDir: dir });
    }, SETUP_TIMEOUT);

    afterAll(async () => rm(dir, { recursive: true, force: true }));

    describe('When pack-refs --all runs with nothing packable', () => {
      it('Then both succeed — N1: the idle fixture runs in both tools', async () => {
        // Arrange + Act
        const g = tryRunGitWithExit(['-C', dir, 'pack-refs', '--all']);
        const result = await packRefs(ctx);

        // Assert
        expect(g.exitCode).toBe(0);
        expect(result.packedRefCount).toBe(0);
      });
    });
  });

  describe('Given a repo with one loose branch ref, poisoned AFTER setup', () => {
    let dir = '';
    let ctx: Context;

    beforeAll(async () => {
      dir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-repo-settings-pack-refs-loose-'));
      await buildReadonlyRepo(dir);
      await poison(dir);
      ctx = createNodeContext({ workDir: dir });
    }, SETUP_TIMEOUT);

    afterAll(async () => rm(dir, { recursive: true, force: true }));

    describe('When pack-refs --all runs', () => {
      it('Then both refuse — peeling the loose ref reads an object, reaching the class boundary', async () => {
        // Arrange + Act
        const g = tryRunGitWithExit(['-C', dir, 'pack-refs', '--all']);

        // Assert
        expect(g.exitCode).toBe(128);
        await assertRefusesWithBadMaxTreeDepth(() => packRefs(ctx));
      });
    });
  });

  describe('Given a repo with one commit and one existing note, poisoned AFTER the note was added', () => {
    let dir = '';
    let ctx: Context;

    beforeAll(async () => {
      dir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-repo-settings-notes-'));
      await buildReadonlyRepo(dir);
      runGit(['-C', dir, 'notes', 'add', '-m', 'a note'], { env: datedEnv(1_700_000_000) });
      await poison(dir);
      ctx = createNodeContext({ workDir: dir });
    }, SETUP_TIMEOUT);

    afterAll(async () => rm(dir, { recursive: true, force: true }));

    describe('When notes list runs', () => {
      it('Then both refuse — the populated fixture dies once there is a note tree to read', async () => {
        // Arrange + Act
        const g = tryRunGitWithExit(['-C', dir, 'notes', 'list']);

        // Assert
        expect(g.exitCode).toBe(128);
        await assertRefusesWithBadMaxTreeDepth(() => notesList(ctx));
      });
    });
  });

  describe('Given a repo where core.loosecompression AND core.maxTreeDepth are both malformed', () => {
    let dir = '';
    let ctx: Context;

    beforeAll(async () => {
      dir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-repo-settings-ordering-'));
      await buildReadonlyRepo(dir);
      await writeFile(
        path.join(dir, '.git', 'config'),
        '[core]\n\tloosecompression = bogus\n\tmaxTreeDepth = 2.5\n',
        { flag: 'a' },
      );
      ctx = createNodeContext({ workDir: dir });
    }, SETUP_TIMEOUT);

    afterAll(async () => rm(dir, { recursive: true, force: true }));

    describe('When status runs', () => {
      it('Then git names the repo-settings class (maxtreedepth) but tsgit names the streaming class (loosecompression) — the recorded residual', async () => {
        // Arrange + Act — against the shared beforeAll repo, whose local
        // config already holds BOTH malformed classes.
        const g = tryRunGitWithExit(['-C', dir, 'status', '--porcelain']);

        // Assert — git 2.55.0's own measured ordering: status calls
        // prepare_repo_settings ahead of its config pass.
        expect(g.exitCode).toBe(128);
        expect(g.stderr).toContain("'core.maxtreedepth'");

        // Assert — tsgit's eager gate (the streaming five) still runs first;
        // the repo-settings class no longer competes there.
        let caught: unknown;
        try {
          await status(ctx);
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data).toMatchObject({
          code: 'CONFIG_BAD_NUMERIC_VALUE',
          key: 'core.loosecompression',
        });
      });
    });
  });

  describe('Given a repo with a malformed core.deltaBaseCacheLimit, poisoned AFTER setup', () => {
    let dir = '';
    let ctx: Context;

    beforeAll(async () => {
      dir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-repo-settings-delta-base-'));
      await buildReadonlyRepo(dir);
      await writeFile(path.join(dir, '.git', 'config'), '[core]\n\tdeltaBaseCacheLimit = -1\n', {
        flag: 'a',
      });
      ctx = createNodeContext({ workDir: dir });
    }, SETUP_TIMEOUT);

    afterAll(async () => rm(dir, { recursive: true, force: true }));

    describe('When rev-parse HEAD runs', () => {
      it('Then both refuse — C1: a malformed core.deltaBaseCacheLimit dies on the class', async () => {
        // Arrange + Act
        const g = tryRunGitWithExit(['-C', dir, 'rev-parse', 'HEAD']);
        let caught: unknown;
        try {
          await revParse(ctx, 'HEAD');
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(g.exitCode).toBe(128);
        expect(g.stderr).toContain("'core.deltabasecachelimit'");
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data).toMatchObject({
          code: 'CONFIG_BAD_NUMERIC_VALUE',
          key: 'core.deltabasecachelimit',
        });
      });
    });

    describe('When the file value is overridden — git by -c, tsgit by cacheBudgets', () => {
      it('Then both succeed — C5: an option-overridden file value is never validated', async () => {
        // Arrange + Act
        const g = tryRunGitWithExit([
          '-C',
          dir,
          '-c',
          'core.deltaBaseCacheLimit=1m',
          'rev-parse',
          'HEAD',
        ]);
        const overridden: Context = { ...ctx, cacheBudgets: { deltaBaseCacheMaxBytes: 1024 } };
        const result = await revParse(overridden, 'HEAD');

        // Assert
        expect(g.exitCode).toBe(0);
        expect(result).toMatch(/^[0-9a-f]{40}$/);
      });
    });
  });

  describe('Given a repo with core.deltaBaseCacheLimit = 4m (line 2) then = -1 (line 3) — valid-then-invalid', () => {
    let dir = '';
    let ctx: Context;

    beforeAll(async () => {
      dir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-repo-settings-delta-base-order-'));
      await buildReadonlyRepo(dir);
      await writeFile(
        path.join(dir, '.git', 'config'),
        '[core]\n\tdeltaBaseCacheLimit = 4m\n\tdeltaBaseCacheLimit = -1\n',
        { flag: 'a' },
      );
      ctx = createNodeContext({ workDir: dir });
    }, SETUP_TIMEOUT);

    afterAll(async () => rm(dir, { recursive: true, force: true }));

    describe('When rev-parse HEAD runs', () => {
      it('Then both refuse — C4: the gate observes the effective (last-wins) value', async () => {
        // Arrange + Act
        const g = tryRunGitWithExit(['-C', dir, 'rev-parse', 'HEAD']);
        let caught: unknown;
        try {
          await revParse(ctx, 'HEAD');
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(g.exitCode).toBe(128);
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data).toMatchObject({
          code: 'CONFIG_BAD_NUMERIC_VALUE',
          key: 'core.deltabasecachelimit',
          value: '-1',
        });
      });
    });
  });

  describe('Given a repo with a branch to rename', () => {
    // Two independently-built, identical repos — one renamed by real git,
    // one by tsgit — so the two tools never mutate the same on-disk ref.
    let gitDir = '';
    let tsgitDir = '';
    let ctx: Context;

    beforeAll(async () => {
      gitDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-repo-settings-rename-git-'));
      tsgitDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-repo-settings-rename-tsgit-'));
      await buildReadonlyRepo(gitDir);
      await buildReadonlyRepo(tsgitDir);
      await poison(gitDir);
      await poison(tsgitDir);
      ctx = createNodeContext({ workDir: tsgitDir });
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      await rm(gitDir, { recursive: true, force: true });
      await rm(tsgitDir, { recursive: true, force: true });
    });

    describe('When branch -m feature trunk runs', () => {
      it('Then git exits 0 and tsgit branchRename succeeds — no longer over-refused', async () => {
        // Arrange + Act — two independently-built repos, one per tool.
        const g = tryRunGitWithExit(['-C', gitDir, 'branch', '-m', 'feature', 'trunk']);
        const result = await branchRename(ctx, { from: 'feature', to: 'trunk' });

        // Assert
        expect(g.exitCode).toBe(0);
        expect(result).toEqual({ from: 'refs/heads/feature', to: 'refs/heads/trunk' });
      });
    });
  });

  describe('Given ONE tsgit Context reused across two commands, poisoned BETWEEN them', () => {
    // The repo-settings verdict fast path (`repoSettingsVerdictSettled`) is a
    // per-SESSION memo that only a persistent Context can observe going
    // stale — a fresh `git` process reads `.git/config` cold on every
    // invocation, so this row's tsgit side is the only one that can actually
    // exercise the fast path's own staleness handling. The first command
    // settles the verdict against the repo's ORIGINAL, valid config; the
    // rewrite lands with no `invalidateConfigCache` call in between (an
    // external edit this Context's own write surface never observes); the
    // second command — a DIFFERENT verb, so the fix is proven at more than
    // one fast-pathed call site — must still refuse.
    let dir = '';
    let ctx: Context;

    beforeAll(async () => {
      dir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-repo-settings-warm-session-'));
      await buildReadonlyRepo(dir);
      ctx = createNodeContext({ workDir: dir });
    }, SETUP_TIMEOUT);

    afterAll(async () => rm(dir, { recursive: true, force: true }));

    describe('When show HEAD runs on the still-valid config, the config is then poisoned, and branch warm-branch runs', () => {
      it('Then the first command succeeds and the second refuses — the warm session never serves a superseded verdict', async () => {
        // Arrange — the first command warms the session against the VALID config.
        const warm = await show(ctx, 'HEAD');
        expect(warm.kind).toBe('commit');

        // Act — poison AFTER the warm command, with no invalidation call.
        await poison(dir);
        const g = tryRunGitWithExit(['-C', dir, 'branch', 'warm-branch']);
        let caught: unknown;
        try {
          await branchCreate(ctx, { name: 'warm-branch' });
        } catch (err) {
          caught = err;
        }

        // Assert — a fresh git process reads the poisoned file cold and dies;
        // the warm tsgit Context must reach the identical refusal, not the
        // stale settled verdict from before the poisoning.
        expect(g.exitCode).toBe(128);
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data as BadNumericData;
        expect(data.code).toBe('CONFIG_BAD_NUMERIC_VALUE');
        expect(data.key).toBe('core.maxtreedepth');
        expect(data.value).toBe('2.5');
        expect(data.reason).toBe('invalid unit');
      });
    });
  });
});
