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
import {
  GIT_AVAILABLE,
  initBothRepos,
  makePeerPair,
  type PeerPair,
  runGit,
} from './interop-helpers.js';

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
        const sut = createNodeContext({ workDir: pair.ours });

        // Act
        await writeSparsePatternText(sut, patterns);

        // Assert — canonical git lists the same patterns (one per line).
        const listed = runGit(['-C', pair.ours, 'sparse-checkout', 'list']);
        expect(listed.trim().split('\n')).toEqual(['/*', '!/build', 'src/main/']);
      });
    });
  });
});
