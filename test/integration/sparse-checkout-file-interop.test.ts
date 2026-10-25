/**
 * Cross-tool interop — `.git/info/sparse-checkout` pattern file.
 *
 * @proves
 *   surface:        sparseCheckoutFile
 *   bucket:         cross-tool-interop
 *   unique:         sparse-checkout file readable by git sparse-checkout list
 *   interopSurface: sparseCheckoutFile
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { writeSparsePatternText } from '../../src/application/primitives/write-sparse-checkout.js';
import { openRepository } from '../../src/index.node.js';
import type { Repository } from '../../src/repository.js';
import {
  GIT_AVAILABLE,
  initBothRepos,
  makePeerPair,
  type PeerPair,
  runGit,
} from './interop-helpers.js';
import {
  buildHistory,
  danglingLinkAt,
  directoryHolding,
  fileAt,
  indexState,
  listing,
  type Occupant,
  regular,
  replacing,
  symlink,
  type TreeEntry,
} from './occupant-displacement-fixtures.js';

interface ReincludeRow {
  readonly shape: string;
  readonly due: ReadonlyArray<TreeEntry>;
  readonly included: string;
  readonly occupant: Occupant;
}

const REINCLUDE_ROWS: ReadonlyArray<ReincludeRow> = [
  { shape: 'S1', due: [regular('d/x')], included: 'd', occupant: fileAt('d') },
  { shape: 'S2', due: [regular('f')], included: 'f', occupant: directoryHolding('f', 'u') },
  { shape: 'S3a', due: [regular('d/x')], included: 'd', occupant: danglingLinkAt('d') },
  { shape: 'S3b', due: [regular('f')], included: 'f', occupant: danglingLinkAt('f') },
  {
    shape: 'S3c',
    due: [symlink('l')],
    included: 'l',
    occupant: replacing('l', directoryHolding('l', 'u')),
  },
  { shape: 'S3d', due: [symlink('d/l')], included: 'd', occupant: replacing('d/l', fileAt('d')) },
];

describe.skipIf(!GIT_AVAILABLE)('sparse-checkout file interop', () => {
  let pair: PeerPair;

  beforeEach(async () => {
    pair = await makePeerPair('sparse');
    initBothRepos(pair.peer, pair.ours);
  });

  afterEach(async () => {
    await pair.dispose();
  });

  describe('Given a non-cone sparse pattern list', () => {
    describe('When tsgit writes the file and canonical git lists it', () => {
      it('Then git surfaces the same patterns we wrote', async () => {
        // Arrange
        const patterns = '/*\n!/build\nsrc/main/\n';
        // Enable sparse-checkout via canonical git so the file becomes
        // "active" (git refuses to list patterns without the config flag).
        runGit(['-C', pair.ours, 'config', 'core.sparseCheckout', 'true']);
        const ctx = createNodeContext({ workDir: pair.ours });

        // Act
        await writeSparsePatternText(ctx, patterns);

        // Assert — canonical git lists the same patterns (one per line).
        const listed = runGit(['-C', pair.ours, 'sparse-checkout', 'list']);
        expect(listed.trim().split('\n')).toEqual(['/*', '!/build', 'src/main/']);
      });
    });
  });

  describe.each(REINCLUDE_ROWS)('Given the $shape occupant on a due path', (row) => {
    describe('When both tools re-include the path', () => {
      it('Then the work tree and index match git', async () => {
        // Arrange
        let repo: Repository | undefined;
        for (const dir of [pair.peer, pair.ours]) {
          buildHistory(dir, [], row.due);
          runGit(['-C', dir, 'config', 'core.sparseCheckout', 'true']);
        }
        runGit(['-C', pair.peer, 'sparse-checkout', 'set', '--no-cone', '/keep']);
        repo = await openRepository({ cwd: pair.ours });
        await repo.sparseCheckout.set({ patterns: ['/keep'], cone: false });
        for (const dir of [pair.peer, pair.ours]) row.occupant(dir);

        try {
          // Act
          runGit([
            '-C',
            pair.peer,
            'sparse-checkout',
            'set',
            '--no-cone',
            '/keep',
            `/${row.included}`,
          ]);
          await repo.sparseCheckout.set({ patterns: ['/keep', `/${row.included}`], cone: false });

          // Assert
          expect(listing(pair.ours)).toEqual(listing(pair.peer));
          expect(indexState(pair.ours)).toEqual(indexState(pair.peer));
        } finally {
          await repo.dispose();
        }
      });
    });
  });
});
