import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryFileSystem } from '../../../src/adapters/memory/memory-file-system.js';
import { posixPolicy } from '../../../src/adapters/node/path-policy.js';
import { fileSystemLayoutProbe } from '../../../src/repository/file-system-layout-probe.js';

// `finishLayout` composes `readRepositoryFormat`'s resolved `refStorage` into
// the returned layout — the ref-storage backend is resolved on the layout,
// strictly before any acceptance-tier assertion. `extensions.refStorage`
// stays in the acceptance gate's unbacked-extension refuse set until a
// reftable backend actually lands, so a REAL config declaring `reftable` at
// version 1 still throws `REPOSITORY_EXTENSION_UNSUPPORTED` from
// `readRepositoryFormat` itself — that refusal lifts only once the backend
// exists to act on the value. Mocking the collaborator is therefore the only
// way to observe `finishLayout`'s OWN behaviour (pass-through, no directory
// sniffing) in isolation, mirroring `resolve-layout-trust-options-shape.test.ts`'s
// own precedent for exactly this situation.
vi.mock('../../../src/repository/read-repository-format.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/repository/read-repository-format.js')>();
  return { ...actual, readRepositoryFormat: vi.fn(actual.readRepositoryFormat) };
});

const { readRepositoryFormat } = await import('../../../src/repository/read-repository-format.js');
const { finishLayout } = await import('../../../src/repository/resolve-layout.js');

const readRepositoryFormatSpy = vi.mocked(readRepositoryFormat);

const FILES_FORMAT = {
  bare: false,
  worktree: undefined,
  worktreeConfig: false,
  objectFormat: 'sha1',
  refStorage: 'files',
  refusal: undefined,
} as const;

/** Marks `dir` as a valid git directory: `objects/`, `refs/`, and a `HEAD` file — deliberately no `reftable/` directory. */
const makeGitDir = async (fs: MemoryFileSystem, dir: string): Promise<void> => {
  await fs.mkdir(`${dir}/objects`);
  await fs.mkdir(`${dir}/refs`);
  await fs.writeUtf8(`${dir}/HEAD`, 'ref: refs/heads/main\n');
};

beforeEach(() => {
  readRepositoryFormatSpy.mockReset();
});

describe('finishLayout — the refStorage channel', () => {
  describe('Given readRepositoryFormat resolves refStorage: reftable, and no reftable/ directory exists on disk', () => {
    describe('When finishLayout runs', () => {
      it("Then the returned layout still carries refStorage: 'reftable' — the extension, not the directory, decides", async () => {
        // Arrange
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await makeGitDir(fs, '/repo/normal/.git');
        readRepositoryFormatSpy.mockResolvedValue({ ...FILES_FORMAT, refStorage: 'reftable' });

        // Act
        const result = await finishLayout(
          fileSystemLayoutProbe(fs),
          { route: 'BARE_DIR', gitDir: '/repo/normal/.git' },
          posixPolicy,
          '/repo/normal',
        );

        // Assert
        expect(result.refStorage).toBe('reftable');
      });
    });
  });

  describe('Given readRepositoryFormat resolves refStorage: files', () => {
    describe('When finishLayout runs', () => {
      it("Then the returned layout carries refStorage: 'files'", async () => {
        // Arrange
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await makeGitDir(fs, '/repo/normal/.git');
        readRepositoryFormatSpy.mockResolvedValue(FILES_FORMAT);

        // Act
        const result = await finishLayout(
          fileSystemLayoutProbe(fs),
          { route: 'BARE_DIR', gitDir: '/repo/normal/.git' },
          posixPolicy,
          '/repo/normal',
        );

        // Assert
        expect(result.refStorage).toBe('files');
      });
    });
  });
});
