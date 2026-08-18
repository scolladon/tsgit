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
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
const splitRealpathCalls = async (cwd: string): Promise<RealpathSplit> => {
  const repo = await openRepository({ cwd });
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
    it('Then the shim resolves cwd, gitDir and workDir, and the adapter re-resolves nothing', async () => {
      // Arrange
      const workDir = path.join(tmpdir, 'repo');
      await mkdir(workDir, { recursive: true });
      await makeGitDir(path.join(workDir, '.git'));
      const sut = splitRealpathCalls;

      // Act
      const result = await sut(workDir);

      // Assert
      expect(result).toEqual({ shim: 3, adapter: 0 });
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

      // Assert — cwd, gitDir, commonDir and workDir, each realpathed once by
      // the shim.
      expect(result).toEqual({ shim: 4, adapter: 0 });
    });
  });
});
