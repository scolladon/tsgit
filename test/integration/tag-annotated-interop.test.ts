/**
 * Cross-tool interop — annotated tag creation via the `tag.create` command.
 * Proves byte-for-byte parity between tsgit's `tagCreate({ annotate, message })`
 * and canonical git's `git tag -a -m` on tag-object bytes, OID, and ref target.
 * Also pins the lightweight-tag path as an unchanged regression.
 *
 * @proves
 *   surface:        tag.create
 *   bucket:         cross-tool-interop
 *   unique:         annotated tag-object bytes + OID parity via the tagCreate
 *                    command (tagger resolved through resolveCurrentIdentity);
 *                    lightweight tag ref-target regression
 *   interopSurface: tag
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { tagCreate } from '../../src/application/commands/tag.js';
import type { ObjectId } from '../../src/domain/objects/index.js';
import {
  GIT_AVAILABLE,
  initBothRepos,
  makePeerPair,
  type PeerPair,
  runGit,
  runGitEnv,
} from './interop-helpers.js';

const PINNED_UNIX = 1_700_000_000;
const IDENTITY_NAME = 'Ada';
const IDENTITY_EMAIL = 'ada@example.com';

/** git env with pinned committer identity/date — tagCreate resolves the tagger the same way. */
const pinnedEnv = (): NodeJS.ProcessEnv => ({
  ...runGitEnv(),
  GIT_AUTHOR_NAME: IDENTITY_NAME,
  GIT_AUTHOR_EMAIL: IDENTITY_EMAIL,
  GIT_AUTHOR_DATE: `${PINNED_UNIX} +0000`,
  GIT_COMMITTER_NAME: IDENTITY_NAME,
  GIT_COMMITTER_EMAIL: IDENTITY_EMAIL,
  GIT_COMMITTER_DATE: `${PINNED_UNIX} +0000`,
});

/** Seed an identical root commit (pinned identity/date) in both peer and ours. */
const seedMatchingRootCommit = (pair: PeerPair): ObjectId => {
  const env = pinnedEnv();
  runGit(['-C', pair.peer, 'commit', '-q', '--allow-empty', '-m', 'seed'], { env });
  runGit(['-C', pair.ours, 'commit', '-q', '--allow-empty', '-m', 'seed'], { env });
  const peerSha = runGit(['-C', pair.peer, 'rev-parse', 'HEAD']).trim();
  const oursSha = runGit(['-C', pair.ours, 'rev-parse', 'HEAD']).trim();
  expect(oursSha).toBe(peerSha);
  return peerSha as ObjectId;
};

describe.skipIf(!GIT_AVAILABLE)('tag annotated-create interop', () => {
  let pair: PeerPair;

  beforeAll(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(PINNED_UNIX * 1000);
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  beforeEach(async () => {
    pair = await makePeerPair('tag-annotated');
    initBothRepos(pair.peer, pair.ours);
  });

  afterEach(async () => {
    await pair.dispose();
  });

  describe('Given a matching root commit in both repos', () => {
    describe('When canonical git tags it with tag -a -m and tsgit tags it via tagCreate({ annotate, message })', () => {
      it('Then the tag object bytes and OID match, and the ref points at the tag object', async () => {
        // Arrange
        const commitSha = seedMatchingRootCommit(pair);
        runGit(['-C', pair.peer, 'tag', '-a', 'v1', '-m', 'v1', commitSha], {
          env: pinnedEnv(),
        });
        const peerTagSha = runGit(['-C', pair.peer, 'rev-parse', 'v1']).trim();
        const ctx = createNodeContext({ workDir: pair.ours });

        // Act
        const sut = await tagCreate(ctx, {
          name: 'v1',
          target: commitSha,
          annotate: true,
          message: 'v1',
        });

        // Assert
        expect(sut.id).toBe(peerTagSha);
        expect(sut.id).not.toBe(commitSha);
        const peerOut = runGit(['-C', pair.peer, 'cat-file', '-p', peerTagSha]);
        const oursOut = runGit(['-C', pair.ours, 'cat-file', '-p', sut.id]);
        expect(oursOut).toBe(peerOut);
        const oursRefTarget = runGit(['-C', pair.ours, 'rev-parse', 'refs/tags/v1']).trim();
        expect(oursRefTarget).toBe(sut.id);
      });
    });
  });

  describe('Given a matching root commit in both repos', () => {
    describe('When canonical git tags it with a plain tag and tsgit tags it via tagCreate() with no annotate/message', () => {
      it('Then both refs point directly at the commit OID — the lightweight path is unchanged', async () => {
        // Arrange
        const commitSha = seedMatchingRootCommit(pair);
        runGit(['-C', pair.peer, 'tag', 'v2', commitSha], { env: pinnedEnv() });
        const peerRefTarget = runGit(['-C', pair.peer, 'rev-parse', 'v2']).trim();
        const ctx = createNodeContext({ workDir: pair.ours });

        // Act
        const sut = await tagCreate(ctx, { name: 'v2', target: commitSha });

        // Assert
        expect(peerRefTarget).toBe(commitSha);
        expect(sut.id).toBe(commitSha);
      });
    });
  });
});
