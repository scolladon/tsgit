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
 * The observable is the realpath COUNT across `openRepository` plus the first
 * port call: without the hand-off each root is realpathed twice (once by the
 * shim, once by the adapter), with it exactly once.
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

describe('Given a repository whose layout resolves and whose realpaths all succeed', () => {
  describe('When openRepository is followed by a first object-store read', () => {
    it('Then each root is realpathed exactly once, not twice', async () => {
      // Arrange
      const workDir = path.join(tmpdir, 'repo');
      await mkdir(workDir, { recursive: true });
      await makeGitDir(path.join(workDir, '.git'));

      // Act
      const sut = await openRepository({ cwd: workDir });
      try {
        await sut.primitives.readObject('0'.repeat(40) as never).catch(() => undefined);
      } finally {
        await sut.dispose();
      }

      // Assert — the shim realpathed cwd and gitDir; the adapter must add
      // none of its own on top. Counting every call, because the shim resolves
      // the raw cwd while the adapter would resolve its realpathed form.
      expect(realpathSpy.mock.calls.length).toBe(2);
    });
  });
});

describe('Given a working directory that does not exist yet', () => {
  describe('When openRepository resolves its roots', () => {
    it('Then the hand-off is withheld, because the shim realpath fell back un-resolved', async () => {
      // Arrange — the routine init/clone shape: the shim's realpath rejects and
      // falls back to the lexical path, so the adapter must do its own
      // nearest-existing-ancestor resolution rather than trust the fallback.
      const missing = path.join(tmpdir, 'not-created-yet');

      // Act
      const sut = await openRepository({ cwd: missing });
      try {
        // The read's own outcome is irrelevant — the root-set resolution is
        // what is under test, and it happens before any object lookup.
        await sut.primitives.readObject('0'.repeat(40) as never).catch(() => undefined);
      } finally {
        await sut.dispose();
      }

      // Assert — the shim's own realpath rejected, so it must NOT claim the
      // roots are resolved: the adapter re-resolves them itself, walking up to
      // the nearest existing ancestor. Claiming them resolved collapses this to
      // a single call and gates on an un-resolved prefix — fail-closed, but
      // wrong. The parent probe is the adapter's alone, so its presence in the
      // ledger is what distinguishes the two.
      expect(realpathSpy.mock.calls.length).toBe(4);
      expect(realpathSpy.mock.calls.map(([target]) => target)).toContain(tmpdir);
    });
  });
});

describe('Given an existing directory with no repository anywhere above it', () => {
  describe('When openRepository resolves its roots', () => {
    it('Then the hand-off still applies, because every realpath the shim ran succeeded', async () => {
      // Arrange — `findLayout` finds nothing, so the layout is the synthesised
      // fallback and reports itself un-canonical. The cwd realpath DID succeed,
      // so the two flags disagree: this is the shape that separates `&&` from
      // `||`, and the one that catches the fallback branch claiming canonical.
      const plain = path.join(tmpdir, 'plain');
      await mkdir(plain, { recursive: true });

      // Act
      const sut = await openRepository({ cwd: plain });
      try {
        await sut.primitives.readObject('0'.repeat(40) as never).catch(() => undefined);
      } finally {
        await sut.dispose();
      }

      // Assert — shim realpath + the adapter's own resolution of the root.
      expect(realpathSpy.mock.calls.length).toBe(2);
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
      const missingChild = path.join(workDir, 'not-created-yet');

      // Act
      const sut = await openRepository({ cwd: missingChild });
      try {
        await sut.primitives.readObject('0'.repeat(40) as never).catch(() => undefined);
      } finally {
        await sut.dispose();
      }

      // Assert
      expect(realpathSpy.mock.calls.length).toBe(4);
    });
  });
});

describe('Given a linked worktree whose gitDir and commonDir both resolve', () => {
  describe('When openRepository resolves its roots', () => {
    it('Then the hand-off applies and BOTH roots are counted, not just the gitDir', async () => {
      // Arrange — a linked worktree is the only layout with two distinct
      // containment roots, so it is the only shape where the canonical flag
      // is an AND over two realpaths rather than a pass-through of one.
      const mainRepo = path.join(tmpdir, 'main');
      const adminDir = path.join(mainRepo, '.git', 'worktrees', 'wt');
      await makeGitDir(path.join(mainRepo, '.git'));
      await mkdir(adminDir, { recursive: true });
      await writeFile(path.join(adminDir, 'HEAD'), 'ref: refs/heads/wt\n');
      await writeFile(path.join(adminDir, 'commondir'), '../..\n');
      const linked = path.join(tmpdir, 'linked');
      await mkdir(linked, { recursive: true });
      await writeFile(path.join(linked, '.git'), `gitdir: ${adminDir}\n`);

      // Act
      const sut = await openRepository({ cwd: linked });
      try {
        await sut.primitives.readObject('0'.repeat(40) as never).catch(() => undefined);
      } finally {
        await sut.dispose();
      }

      // Assert — cwd, gitDir and commonDir, each realpathed exactly once by
      // the shim, with nothing left for the adapter to redo.
      expect(realpathSpy.mock.calls.length).toBe(3);
    });
  });
});
