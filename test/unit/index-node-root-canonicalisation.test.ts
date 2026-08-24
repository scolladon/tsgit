/**
 * Unit coverage for the Node shim's root-canonicalisation hand-off
 * (`src/index.node.ts`).
 *
 * The adapter side is pinned in `test/unit/adapters/node/node-file-system-injected.test.ts`;
 * what is pinned HERE is the call site — that the shim tells the adapter its
 * roots are already resolved only when its own realpaths actually succeeded.
 * Both live in `test/unit` because Stryker runs only that tier, so a mutant on
 * the shim's condition survives if the observation lives in the integration
 * suite alone.
 *
 * **The oracle is deliberately a split, not a total.** `realpath` calls made
 * before `openRepository` returns are the shim's own; calls made during the
 * first port call afterwards are the adapter re-resolving. The shim's count is
 * one per `canonicalize`, so it is stable everywhere. The adapter's count is
 * NOT — a missing root sends it walking up to the nearest existing ancestor,
 * and that walk is one level longer under a symlinked temp root (darwin's
 * `/var` → `/private/var`) than under linux's `/tmp`. So the adapter side is
 * asserted as "did it re-resolve at all", which is exactly the property the
 * hand-off decides, and is the same answer on every platform.
 */
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, realpath: vi.fn(actual.realpath) };
});

const { realpath } = await import('node:fs/promises');
const { openRepository } = await import('../../src/index.node.js');

const realpathSpy = vi.mocked(realpath);

let tmpdir: string;

beforeEach(async () => {
  tmpdir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-shim-roots-'));
  realpathSpy.mockClear();
});

afterEach(async () => {
  await rm(tmpdir, { recursive: true, force: true });
});

const makeGitDir = async (dir: string): Promise<void> => {
  await mkdir(path.join(dir, 'objects'), { recursive: true });
  await mkdir(path.join(dir, 'refs'), { recursive: true });
  await writeFile(path.join(dir, 'HEAD'), 'ref: refs/heads/main\n');
};

interface RealpathSplit {
  readonly shim: number;
  readonly adapter: number;
}

/**
 * Opens `cwd`, forces the adapter's lazy root-set resolution with one read,
 * and reports how many realpaths each side performed.
 */
const splitRealpathCalls = async (
  cwd: string,
  extraOpts: { readonly workDir?: string; readonly gitDir?: string; readonly bare?: boolean } = {},
): Promise<RealpathSplit> => {
  const repo = await openRepository({ cwd, ...extraOpts });
  const shim = realpathSpy.mock.calls.length;
  try {
    // The read's own outcome is irrelevant — resolving the root set is what is
    // under test, and it happens before any object lookup.
    await repo.primitives.readObject('0'.repeat(40) as never).catch(() => undefined);
  } finally {
    await repo.dispose();
  }
  return { shim, adapter: realpathSpy.mock.calls.length - shim };
};

describe('Given a repository whose layout resolves and whose realpaths all succeed', () => {
  describe('When openRepository is followed by a first object-store read', () => {
    it('Then the shim resolves cwd and gitDir only — a discovered workDir is an ancestor of the realpathed cwd and needs no realpath of its own', async () => {
      // Arrange
      const workDir = path.join(tmpdir, 'repo');
      await mkdir(workDir, { recursive: true });
      await makeGitDir(path.join(workDir, '.git'));
      const sut = splitRealpathCalls;

      // Act
      const result = await sut(workDir);

      // Assert
      expect(result).toEqual({ shim: 2, adapter: 0 });
    });
  });
});

describe('Given a working directory that does not exist yet', () => {
  describe('When openRepository resolves its roots', () => {
    it('Then the hand-off is withheld, because the shim realpath fell back un-resolved', async () => {
      // Arrange — the routine init/clone shape: the shim's realpath rejects and
      // falls back to the lexical path, so the adapter must do its own
      // nearest-existing-ancestor resolution rather than trust that fallback.
      const missing = path.join(tmpdir, 'not-created-yet');
      const sut = splitRealpathCalls;

      // Act
      const result = await sut(missing);

      // Assert
      expect(result.adapter).toBeGreaterThan(0);
    });
  });
});

describe('Given an existing directory with no repository anywhere above it', () => {
  describe('When openRepository resolves its roots', () => {
    it('Then the hand-off is withheld, because the synthesised layout was never realpathed', async () => {
      // Arrange — `findLayout` finds nothing, so the layout is the synthesised
      // fallback and reports itself un-canonical even though the cwd realpath
      // succeeded. The two flags disagree here, which is what separates `&&`
      // from `||` and catches the fallback branch claiming canonical.
      const plain = path.join(tmpdir, 'plain');
      await mkdir(plain, { recursive: true });
      const sut = splitRealpathCalls;

      // Act
      const result = await sut(plain);

      // Assert
      expect(result).toEqual({ shim: 1, adapter: 1 });
    });
  });
});

describe('Given a not-yet-created directory inside an existing repository', () => {
  describe('When openRepository resolves its roots', () => {
    it('Then the hand-off is withheld even though the layout itself resolved', async () => {
      // Arrange — the only shape where the cwd realpath fails while the
      // layout's own realpaths succeed, so it is the one that catches
      // `canonicalize`'s catch arm claiming success.
      const workDir = path.join(tmpdir, 'repo');
      await mkdir(workDir, { recursive: true });
      await makeGitDir(path.join(workDir, '.git'));
      const sut = splitRealpathCalls;

      // Act
      const result = await sut(path.join(workDir, 'not-created-yet'));

      // Assert — cwd, gitDir and workDir, each realpathed once by the shim.
      expect(result.shim).toBe(3);
      expect(result.adapter).toBeGreaterThan(0);
    });
  });
});

describe('Given a linked worktree whose gitDir and commonDir both resolve', () => {
  describe('When openRepository resolves its roots', () => {
    it('Then the shim resolves all three roots and the adapter re-resolves none', async () => {
      // Arrange — a linked worktree is the only layout with two distinct
      // containment roots, so it is the only shape where the canonical flag is
      // an AND over two realpaths rather than a pass-through of one.
      const mainRepo = path.join(tmpdir, 'main');
      const adminDir = path.join(mainRepo, '.git', 'worktrees', 'wt');
      await makeGitDir(path.join(mainRepo, '.git'));
      await mkdir(adminDir, { recursive: true });
      await writeFile(path.join(adminDir, 'HEAD'), 'ref: refs/heads/wt\n');
      await writeFile(path.join(adminDir, 'commondir'), '../..\n');
      const linked = path.join(tmpdir, 'linked');
      await mkdir(linked, { recursive: true });
      await writeFile(path.join(linked, '.git'), `gitdir: ${adminDir}\n`);
      const sut = splitRealpathCalls;

      // Act
      const result = await sut(linked);

      // Assert — cwd, gitDir and commonDir, each realpathed once by the shim;
      // the linked worktree's own path IS the realpathed cwd, so it is skipped.
      expect(result).toEqual({ shim: 3, adapter: 0 });
    });
  });
});

describe('Given an explicit workDir argument outside the discovery chain', () => {
  describe('When openRepository resolves its roots', () => {
    it('Then the shim pays one extra realpath for the lexical work-tree source', async () => {
      // Arrange — an explicit workDir is not derived from the realpathed cwd,
      // so the zero-syscall proof of canonical form does not apply and the shim
      // must physically resolve it like any other lexical layout path.
      const workDir = path.join(tmpdir, 'repo');
      await mkdir(workDir, { recursive: true });
      await makeGitDir(path.join(workDir, '.git'));
      const elsewhere = path.join(tmpdir, 'elsewhere-wt');
      await mkdir(elsewhere, { recursive: true });
      const sut = splitRealpathCalls;

      // Act
      const result = await sut(workDir, { workDir: elsewhere });

      // Assert — cwd, gitDir, and the explicit workDir.
      expect(result).toEqual({ shim: 3, adapter: 0 });
    });
  });
});

describe('Given an explicit workDir reached through a symlink', () => {
  describe('When openRepository resolves its roots', () => {
    it("Then layout.workDir is the realpathed target, not the symlink's own lexical path", async () => {
      // Arrange — the raw (pre-realpath) explicit workDir is the symlink path
      // itself; only `canonicalize` resolves it to the real target. If the
      // shim dropped its own `{ workDir: workDir.path }` override, the
      // EARLIER `...resolved` spread would leave the raw (symlink) path
      // standing instead — observable ONLY because the two differ here.
      const realWt = path.join(tmpdir, 'real-wt');
      await mkdir(realWt, { recursive: true });
      const linkWt = path.join(tmpdir, 'link-wt');
      await symlink(realWt, linkWt);
      const workDir = path.join(tmpdir, 'repo');
      await mkdir(workDir, { recursive: true });
      await makeGitDir(path.join(workDir, '.git'));
      const resolvedRealWt = await realpath(realWt);

      // Act
      const repo = await openRepository({ cwd: workDir, workDir: linkWt });

      try {
        // Assert
        expect(repo.ctx.layout.workDir).toBe(resolvedRealWt);
        expect(repo.ctx.layout.workDir).not.toBe(linkWt);
      } finally {
        await repo.dispose();
      }
    });
  });
});

describe('Given a linked worktree whose commondir is reached through a symlink', () => {
  describe('When openRepository resolves its roots', () => {
    it("Then layout.commonDir is the realpathed target, not the symlink's own lexical path", async () => {
      // Arrange — `resolveCommonDir`'s `../..` collapse is purely lexical, so
      // the raw commonDir it derives from a symlinked gitDir still names the
      // symlink; only `canonicalize` resolves it to the real target. If the
      // shim dropped its own `{ commonDir: commonDir.path }` override, the
      // EARLIER `...resolved` spread would leave that raw (symlink-lexical)
      // path standing instead — observable ONLY because the two differ here.
      const realMain = path.join(tmpdir, 'real-main');
      await makeGitDir(path.join(realMain, '.git'));
      const mainLink = path.join(tmpdir, 'main-link');
      await symlink(realMain, mainLink);
      const adminDir = path.join(mainLink, '.git', 'worktrees', 'wt');
      await mkdir(adminDir, { recursive: true });
      await writeFile(path.join(adminDir, 'HEAD'), 'ref: refs/heads/wt\n');
      await writeFile(path.join(adminDir, 'commondir'), '../..\n');
      const linked = path.join(tmpdir, 'linked');
      await mkdir(linked, { recursive: true });
      await writeFile(path.join(linked, '.git'), `gitdir: ${adminDir}\n`);
      const resolvedRealCommonDir = await realpath(path.join(realMain, '.git'));

      // Act
      const repo = await openRepository({ cwd: linked });

      try {
        // Assert
        expect(repo.ctx.layout.commonDir).toBe(resolvedRealCommonDir);
        expect(repo.ctx.layout.commonDir).not.toBe(path.join(mainLink, '.git'));
      } finally {
        await repo.dispose();
      }
    });
  });
});

describe('Given an explicit commonDir override reached through a symlink', () => {
  describe('When openRepository resolves its roots', () => {
    it("Then layout.commonDir is the realpathed target, not the symlink's own lexical path", async () => {
      // Arrange
      const gitDir = path.join(tmpdir, 'main', '.git');
      await makeGitDir(gitDir);
      const realCommon = path.join(tmpdir, 'real-common');
      await mkdir(realCommon, { recursive: true });
      const linkCommon = path.join(tmpdir, 'link-common');
      await symlink(realCommon, linkCommon);
      const resolvedRealCommon = await realpath(realCommon);

      // Act
      const repo = await openRepository({ cwd: tmpdir, gitDir, commonDir: linkCommon });

      try {
        // Assert
        expect(repo.ctx.layout.commonDir).toBe(resolvedRealCommon);
        expect(repo.ctx.layout.commonDir).not.toBe(linkCommon);
      } finally {
        await repo.dispose();
      }
    });
  });
});

describe('Given a commonDir that is a symlink alias OF the gitDir itself', () => {
  describe('When openRepository resolves its roots', () => {
    it('Then realpathing collapses them and the degenerate field is dropped — presence still means "differs from gitDir"', async () => {
      // Arrange — lexically the two paths differ, so the lexical
      // normalisation upstream keeps the field; only the post-realpath
      // re-check can catch the collapse.
      const gitDir = path.join(tmpdir, 'aliased', '.git');
      await makeGitDir(gitDir);
      const aliasCommon = path.join(tmpdir, 'alias-of-gitdir');
      await symlink(gitDir, aliasCommon);

      // Act
      const repo = await openRepository({ cwd: tmpdir, gitDir, commonDir: aliasCommon });

      try {
        // Assert
        expect('commonDir' in repo.ctx.layout).toBe(false);
      } finally {
        await repo.dispose();
      }
    });
  });
});

describe('Given cwd nested (a true descendant, not equal) inside the discovered workDir', () => {
  describe('When openRepository resolves its roots', () => {
    it("Then the workDir shortcut still avoids its own realpath (isDerivedFromCanonicalCwd's startsWith, not endsWith)", async () => {
      // Arrange — cwd !== workDir here, so `isDerivedFromCanonicalCwd`'s
      // first disjunct (`workDir === cwd`) cannot short-circuit the
      // evaluation; only the second (`cwd.startsWith(workDir + sep)`) can.
      // The MethodExpression mutant (`startsWith` → `endsWith`) fails that
      // check for an ordinary descendant path, forcing an extra realpath.
      const workDir = path.join(tmpdir, 'repo');
      await mkdir(workDir, { recursive: true });
      await makeGitDir(path.join(workDir, '.git'));
      const nested = path.join(workDir, 'nested');
      await mkdir(nested, { recursive: true });
      const sut = splitRealpathCalls;

      // Act
      const result = await sut(nested);

      // Assert — cwd + gitDir only; the workDir shortcut avoided a 3rd realpath.
      expect(result).toEqual({ shim: 2, adapter: 0 });
    });
  });
});

describe('Given an explicit gitDir that does not exist yet, combined with bare:true', () => {
  describe('When openRepository resolves its roots', () => {
    it("Then the hand-off is withheld, because gitDir's own realpath failed", async () => {
      // Arrange — the explicit-gitDir route is lenient about a not-yet-existing
      // path, so `gitDir.canonical` is false while `commonDir`/`workDir` fall
      // back to their `?? true` defaults (bare: no workDir; no linked
      // worktree: no commonDir). gitDir.canonical is the ONLY false conjunct,
      // which is what separates `&&` from `||` at both nesting levels of the
      // canonical expression, and what separates the whole expression from an
      // always-true mutant.
      const ghostGitDir = path.join(tmpdir, 'ghost.git');
      const sut = splitRealpathCalls;

      // Act
      const result = await sut(tmpdir, { gitDir: ghostGitDir, bare: true });

      // Assert — canonical came out false, so the adapter re-resolves its roots.
      expect(result.adapter).toBeGreaterThan(0);
    });
  });
});

describe('Given a discovered bare repository (workDir undefined, gitDir real)', () => {
  describe('When openRepository resolves its roots', () => {
    it('Then the hand-off proceeds, because the workDir fallback (no work tree to canonicalize) is true', async () => {
      // Arrange — gitDir is realpathed successfully (it exists) and workDir is
      // undefined (bare), so `workDir?.canonical ?? true` hits its fallback —
      // the BooleanLiteral mutant on that `true` is what this pins: flipping
      // it to `false` would make the overall AND false, forcing the adapter
      // to re-resolve.
      await makeGitDir(path.join(tmpdir, '.git'));
      const sut = splitRealpathCalls;

      // Act
      const result = await sut(tmpdir, { bare: true });

      // Assert — canonical came out true, so the adapter trusts the hand-off.
      expect(result.adapter).toBe(0);
    });
  });
});
