/**
 * Cross-adapter parity — the caller-supplied `commonDir` open option. A
 * split layout (a work-tree admin dir plus a separately-rooted shared dir,
 * each carrying its own decoy/real `[probe] marker` config key) is staged
 * identically on the Node and Memory adapters, then both are opened with the
 * same explicit `{ gitDir, commonDir }` shape and asserted against one
 * shared golden. Deliberately outside the `SCENARIOS` registry the other
 * parity drivers share: those drivers stage a plain `cwd`-rooted repo via
 * `files`/`stageFiles`, with no way to express a work-tree admin dir living
 * OUTSIDE the seeded repo root — this fixture's split shape needs its own
 * staging on each adapter. Parity is cross-adapter only; it does not
 * substitute for the interop pins in
 * `test/integration/common-dir-open-option-interop.test.ts`.
 */
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openRepository as openMemoryRepository } from '../../src/index.default.js';
import { openRepository as openNodeRepository } from '../../src/index.node.js';
import type { Repository } from '../../src/repository.js';

const ENCODER = new TextEncoder();

const HEAD_TEXT = 'ref: refs/heads/main\n';
const SHARED_CONFIG_TEXT = '[core]\n\tbare = true\n[probe]\n\tmarker = shared\n';
const LOCAL_CONFIG_TEXT = '[core]\n\tbare = true\n[probe]\n\tmarker = local\n';

/**
 * The expected layout + config-read shape for a repo rooted at `root`, with
 * `wt/.git` the admin dir and `shared` the common dir — one golden, called
 * with each adapter's own root, so a divergence between drivers reads as a
 * parity failure rather than two expectations silently drifting apart.
 */
const golden = (root: string) => ({
  commonDir: `${root}/shared`,
  gitDir: `${root}/wt/.git`,
  workDir: root,
  bare: false,
});

const assertGolden = async (repo: Repository, root: string): Promise<void> => {
  const expected = golden(root);

  // layout
  expect(repo.layout.commonDir).toBe(expected.commonDir);
  expect(repo.layout.gitDir).toBe(expected.gitDir);
  expect(repo.layout.workDir).toBe(expected.workDir);
  expect(repo.layout.bare).toBe(expected.bare);

  // primitives.commonGitDir agrees with the layout field
  expect(repo.primitives.commonGitDir()).toBe(expected.commonDir);

  // a real cross-adapter config read: the shared marker wins, not the decoy
  const marker = await repo.config.get({ key: 'probe.marker' });
  expect(marker.value).toBe('shared');
};

describe('Given a split commonDir layout staged identically on Node and Memory (cross-adapter parity)', () => {
  describe('When the Memory driver opens it', () => {
    it('Then layout, commonGitDir and the config read all match the golden', async () => {
      // Arrange
      const root = '/repo';
      const files: Record<string, Uint8Array> = {
        [`${root}/wt/.git/HEAD`]: ENCODER.encode(HEAD_TEXT),
        [`${root}/wt/.git/config`]: ENCODER.encode(LOCAL_CONFIG_TEXT),
        [`${root}/shared/objects/.keep`]: new Uint8Array(),
        [`${root}/shared/refs/.keep`]: new Uint8Array(),
        [`${root}/shared/config`]: ENCODER.encode(SHARED_CONFIG_TEXT),
      };
      const sut = await openMemoryRepository({
        files,
        cwd: root,
        gitDir: `${root}/wt/.git`,
        commonDir: `${root}/shared`,
      });

      try {
        // Act & Assert
        await assertGolden(sut, root);
      } finally {
        await sut.dispose();
      }
    });
  });

  describe('When the Node driver opens it', () => {
    let root = '';

    afterEach(async () => {
      if (root !== '') await rm(root, { recursive: true, force: true });
    });

    it('Then layout, commonGitDir and the config read all match the golden', async () => {
      // Arrange
      root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-parity-cdo-')));
      await mkdir(path.join(root, 'wt', '.git'), { recursive: true });
      await writeFile(path.join(root, 'wt', '.git', 'HEAD'), HEAD_TEXT);
      await writeFile(path.join(root, 'wt', '.git', 'config'), LOCAL_CONFIG_TEXT);
      await mkdir(path.join(root, 'shared', 'objects'), { recursive: true });
      await mkdir(path.join(root, 'shared', 'refs'), { recursive: true });
      await writeFile(path.join(root, 'shared', 'config'), SHARED_CONFIG_TEXT);

      const sut = await openNodeRepository({
        cwd: root,
        gitDir: path.join(root, 'wt', '.git'),
        commonDir: path.join(root, 'shared'),
      });

      try {
        // Act & Assert
        await assertGolden(sut, root);
      } finally {
        await sut.dispose();
      }
    });
  });
});
