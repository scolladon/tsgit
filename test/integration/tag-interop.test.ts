/**
 * Cross-tool interop — annotated tag object, and `tag.create`'s exists-
 * before-verify order for lightweight tags. Writes a Tag via tsgit's
 * `writeObject`, compares its SHA against `git tag -a` output, and asserts
 * `git cat-file -p` reads back the same content; then runs `tagCreate`
 * against every target type and refusal `git tag` itself pins.
 *
 * @proves
 *   surface:        tag
 *   bucket:         cross-tool-interop
 *   unique:         tag object SHA + cat-file readback match canonical git
 *   interopSurface: tag
 */
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { tagCreate } from '../../src/application/commands/tag.js';
import { writeObject } from '../../src/application/primitives/write-object.js';
import { TsgitError } from '../../src/domain/error.js';
import type { AuthorIdentity, ObjectId } from '../../src/domain/objects/index.js';
import type { Context } from '../../src/ports/context.js';
import {
  disableAutoMaintenance,
  GIT_AVAILABLE,
  git,
  initBothRepos,
  makePeerPair,
  type PeerPair,
  runGit,
  runGitEnv,
  tryRunGitWithExit,
} from './interop-helpers.js';

const TAGGER: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const commitEnv = (epoch: number): NodeJS.ProcessEnv => ({
  ...runGitEnv(),
  GIT_AUTHOR_NAME: TAGGER.name,
  GIT_AUTHOR_EMAIL: TAGGER.email,
  GIT_AUTHOR_DATE: `${epoch} ${TAGGER.timezoneOffset}`,
  GIT_COMMITTER_NAME: TAGGER.name,
  GIT_COMMITTER_EMAIL: TAGGER.email,
  GIT_COMMITTER_DATE: `${epoch} ${TAGGER.timezoneOffset}`,
});

interface TagTargets {
  readonly commitId: string;
  readonly treeId: string;
  readonly blobId: string;
  readonly tagObjectId: string;
}

/**
 * One commit tracking `f.txt`, its tree, that blob, and an inner annotated
 * tag pointing at the commit — pinned dates and identical content, so
 * running this against `peer` and `ours` independently yields matching ids,
 * the deterministic-id proof the rows below lean on.
 */
const seedTagTargets = async (dir: string): Promise<TagTargets> => {
  await writeFile(path.join(dir, 'f.txt'), 'c1\n');
  git(dir, 'add', '-A');
  runGit(['-C', dir, 'commit', '-q', '-m', 'c1'], { env: commitEnv(TAGGER.timestamp) });
  const commitId = git(dir, 'rev-parse', 'HEAD').trim();
  const treeId = git(dir, 'rev-parse', 'HEAD^{tree}').trim();
  const blobId = git(dir, 'hash-object', path.join(dir, 'f.txt')).trim();
  runGit(['-C', dir, 'tag', '-a', 'inner', '-m', 'inner\n', commitId], {
    env: commitEnv(TAGGER.timestamp + 1),
  });
  const tagObjectId = git(dir, 'rev-parse', 'inner').trim();
  return { commitId, treeId, blobId, tagObjectId };
};

const nodeCtx = (dir: string): Context => createNodeContext({ workDir: dir });

/** Runs `tagCreate` against `ours`, capturing success or the refusal thrown
 *  as a `TsgitError` — never lets a refusal escape as an uncaught rejection. */
const runOursTagCreate = async (
  dir: string,
  name: string,
  target: string,
  extra: { readonly force?: boolean; readonly message?: string } = {},
): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: TsgitError }> => {
  try {
    await tagCreate(nodeCtx(dir), { name, target, ...extra });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error as TsgitError };
  }
};

describe.skipIf(!GIT_AVAILABLE)('tag interop', () => {
  let pair: PeerPair;

  beforeEach(async () => {
    pair = await makePeerPair('tag');
    initBothRepos(pair.peer, pair.ours);
  });

  afterEach(async () => {
    await pair.dispose();
  });

  describe('Given an annotated tag on an empty commit', () => {
    describe('When tsgit writes the tag and canonical git tag -a does the same', () => {
      it('Then SHAs match and cat-file readback agrees', async () => {
        // Arrange — make a commit in peer with pinned dates, tag it
        const env = {
          ...runGitEnv(),
          GIT_AUTHOR_NAME: TAGGER.name,
          GIT_AUTHOR_EMAIL: TAGGER.email,
          GIT_AUTHOR_DATE: `${TAGGER.timestamp} ${TAGGER.timezoneOffset}`,
          GIT_COMMITTER_NAME: TAGGER.name,
          GIT_COMMITTER_EMAIL: TAGGER.email,
          GIT_COMMITTER_DATE: `${TAGGER.timestamp} ${TAGGER.timezoneOffset}`,
        };
        runGit(['-C', pair.peer, 'commit', '-q', '--allow-empty', '-m', 'seed'], { env });
        const commitSha = runGit(['-C', pair.peer, 'rev-parse', 'HEAD']).trim() as ObjectId;
        runGit(['-C', pair.peer, 'tag', '-a', 'v1', '-m', 'release one', commitSha], { env });
        const peerTagSha = runGit(['-C', pair.peer, 'rev-parse', 'v1']).trim();
        const ctx = createNodeContext({ workDir: pair.ours });
        runGit(['-C', pair.ours, 'commit', '-q', '--allow-empty', '-m', 'seed'], { env });

        // Act
        const oursTagSha = await writeObject(ctx, {
          type: 'tag',
          id: '' as ObjectId,
          data: {
            object: commitSha,
            objectType: 'commit',
            tagName: 'v1',
            tagger: TAGGER,
            message: 'release one\n',
            extraHeaders: [],
          },
        });

        // Assert
        expect(oursTagSha).toBe(peerTagSha);
        const peerOut = runGit(['-C', pair.peer, 'cat-file', '-p', peerTagSha]);
        const oursOut = runGit(['-C', pair.ours, 'cat-file', '-p', oursTagSha]);
        expect(oursOut).toBe(peerOut);
      });
    });
  });

  describe('Given a commit, a tree, a blob and an inner annotated tag object as lightweight tag targets', () => {
    let target: TagTargets;

    beforeEach(async () => {
      target = await seedTagTargets(pair.peer);
      await seedTagTargets(pair.ours);
    });

    describe('When git tag and tsgit tag create each write a lightweight tag to every type', () => {
      it.each([
        { type: 'commit' as const, id: () => target.commitId },
        { type: 'tree' as const, id: () => target.treeId },
        { type: 'blob' as const, id: () => target.blobId },
        { type: 'tag' as const, id: () => target.tagObjectId },
      ])(
        'Then both accept the $type target and for-each-ref reports its type',
        async ({ type, id }) => {
          // Arrange
          const oid = id();
          const name = `l-${type}`;

          // Act
          const peerResult = tryRunGitWithExit(['-C', pair.peer, 'tag', name, oid]);
          const oursResult = await tagCreate(nodeCtx(pair.ours), { name, target: oid });

          // Assert
          expect(peerResult.exitCode).toBe(0);
          expect(oursResult.id).toBe(oid);
          const peerType = git(
            pair.peer,
            'for-each-ref',
            '--format=%(objecttype)',
            `refs/tags/${name}`,
          ).trim();
          const oursType = git(
            pair.ours,
            'for-each-ref',
            '--format=%(objecttype)',
            `refs/tags/${name}`,
          ).trim();
          expect(oursType).toBe(type);
          expect(oursType).toBe(peerType);
        },
      );
    });
  });

  describe('Given a nonexistent full-oid target on a fresh tag name', () => {
    const missing = '2'.repeat(40);

    beforeEach(async () => {
      await seedTagTargets(pair.peer);
      await seedTagTargets(pair.ours);
    });

    describe('When git tag and tsgit tag create each attempt it', () => {
      it('Then both refuse in the transaction and write no ref', async () => {
        // Arrange
        const name = 'l-nx';

        // Act
        const peerResult = tryRunGitWithExit(['-C', pair.peer, 'tag', name, missing]);
        const oursResult = await runOursTagCreate(pair.ours, name, missing);

        // Assert
        expect(peerResult.exitCode).toBe(128);
        expect(peerResult.stderr).toContain('nonexistent object');
        expect(oursResult.ok).toBe(false);
        if (!oursResult.ok) expect(oursResult.error.data.code).toBe('OBJECT_NOT_FOUND');
        expect(
          tryRunGitWithExit(['-C', pair.peer, 'rev-parse', '--verify', `refs/tags/${name}`])
            .exitCode,
        ).not.toBe(0);
        expect(
          tryRunGitWithExit(['-C', pair.ours, 'rev-parse', '--verify', `refs/tags/${name}`])
            .exitCode,
        ).not.toBe(0);
      });
    });
  });

  describe('Given a target that is neither a full oid nor an existing ref', () => {
    beforeEach(async () => {
      await seedTagTargets(pair.peer);
      await seedTagTargets(pair.ours);
    });

    describe('When git tag and tsgit tag create each attempt to resolve it', () => {
      it.each([
        { label: 'a short hex fragment', value: '0123456' },
        { label: 'a nonexistent ref name', value: 'nope' },
      ])('Then both refuse resolution for $label before any verification', async ({ value }) => {
        // Arrange
        const name = 'l-unresolved';

        // Act
        const peerResult = tryRunGitWithExit(['-C', pair.peer, 'tag', name, value]);
        const oursResult = await runOursTagCreate(pair.ours, name, value);

        // Assert
        expect(peerResult.exitCode).toBe(128);
        expect(peerResult.stderr).toContain(`Failed to resolve '${value}' as a valid ref`);
        expect(oursResult.ok).toBe(false);
        if (!oursResult.ok) expect(oursResult.error.data.code).toBe('REF_NOT_FOUND');
      });
    });
  });

  describe('Given an existing tag name', () => {
    let target: TagTargets;
    const missing = '3'.repeat(40);

    beforeEach(async () => {
      target = await seedTagTargets(pair.peer);
      await seedTagTargets(pair.ours);
      git(pair.peer, 'tag', 'l-commit', target.commitId);
      await tagCreate(nodeCtx(pair.ours), { name: 'l-commit', target: target.commitId });
    });

    describe('When git tag and tsgit tag create each attempt to recreate it pointing at a missing target', () => {
      it('Then both report the name already exists, before the target is verified', async () => {
        // Arrange
        const name = 'l-commit';
        const seededTarget = target.commitId;

        // Act
        const peerResult = tryRunGitWithExit(['-C', pair.peer, 'tag', name, missing]);
        const oursResult = await runOursTagCreate(pair.ours, name, missing);

        // Assert
        expect(peerResult.exitCode).toBe(128);
        expect(peerResult.stderr).toContain(`tag '${name}' already exists`);
        expect(oursResult.ok).toBe(false);
        if (!oursResult.ok) expect(oursResult.error.data.code).toBe('TAG_EXISTS');
        expect(git(pair.peer, 'rev-parse', name).trim()).toBe(seededTarget);
        expect(git(pair.ours, 'rev-parse', name).trim()).toBe(seededTarget);
      });
    });
  });

  describe('Given force and a nonexistent target on a fresh tag name', () => {
    const missing = '4'.repeat(40);

    beforeEach(async () => {
      await seedTagTargets(pair.peer);
      await seedTagTargets(pair.ours);
    });

    describe('When git tag -f and tsgit tag create with force each attempt it', () => {
      it('Then both refuse in the transaction — force bypasses the exists check, not verification', async () => {
        // Arrange
        const name = 't';

        // Act
        const peerResult = tryRunGitWithExit(['-C', pair.peer, 'tag', '-f', name, missing]);
        const oursResult = await runOursTagCreate(pair.ours, name, missing, { force: true });

        // Assert
        expect(peerResult.exitCode).toBe(128);
        expect(peerResult.stderr).toContain('nonexistent object');
        expect(oursResult.ok).toBe(false);
        if (!oursResult.ok) expect(oursResult.error.data.code).toBe('OBJECT_NOT_FOUND');
      });
    });
  });

  describe('Given an invalid tag name and a nonexistent target', () => {
    const missing = '5'.repeat(40);

    beforeEach(async () => {
      await seedTagTargets(pair.peer);
      await seedTagTargets(pair.ours);
    });

    describe('When git tag and tsgit tag create each attempt it', () => {
      it('Then both refuse the name before the target is looked at', async () => {
        // Arrange
        const name = 'bad..name';

        // Act
        const peerResult = tryRunGitWithExit(['-C', pair.peer, 'tag', name, missing]);
        const oursResult = await runOursTagCreate(pair.ours, name, missing);

        // Assert
        expect(peerResult.exitCode).toBe(128);
        expect(peerResult.stderr).toContain(`'${name}' is not a valid tag name`);
        expect(oursResult.ok).toBe(false);
        if (!oursResult.ok) expect(oursResult.error.data.code).toBe('INVALID_REF');
      });
    });
  });

  describe('Given an annotated tag targeting a tree', () => {
    let target: TagTargets;

    beforeEach(async () => {
      target = await seedTagTargets(pair.peer);
      await seedTagTargets(pair.ours);
    });

    describe('When git tag -a and tsgit tag create (message implies annotate) each attempt it', () => {
      it('Then both accept it and the tag object peels back to the tree', async () => {
        // Arrange
        const name = 'a-tree';
        const treeId = target.treeId;

        // Act
        const peerResult = tryRunGitWithExit([
          '-C',
          pair.peer,
          'tag',
          '-a',
          '-m',
          'x',
          name,
          treeId,
        ]);
        const oursResult = await runOursTagCreate(pair.ours, name, treeId, { message: 'x' });

        // Assert
        expect(peerResult.exitCode).toBe(0);
        expect(oursResult.ok).toBe(true);
        const ref = `refs/tags/${name}`;
        expect(git(pair.peer, 'for-each-ref', '--format=%(objecttype)', ref).trim()).toBe('tag');
        expect(git(pair.ours, 'for-each-ref', '--format=%(objecttype)', ref).trim()).toBe('tag');
        expect(git(pair.peer, 'rev-parse', `${ref}^{}`).trim()).toBe(treeId);
        expect(git(pair.ours, 'rev-parse', `${ref}^{}`).trim()).toBe(treeId);
      });
    });
  });

  describe('Given an annotated tag targeting a nonexistent object', () => {
    const missing = '6'.repeat(40);

    beforeEach(async () => {
      await seedTagTargets(pair.peer);
      await seedTagTargets(pair.ours);
    });

    describe('When git tag -a and tsgit tag create (message implies annotate) each attempt it', () => {
      it('Then both refuse and write no ref', async () => {
        // Arrange
        const name = 'a-nx';

        // Act
        const peerResult = tryRunGitWithExit([
          '-C',
          pair.peer,
          'tag',
          '-a',
          '-m',
          'x',
          name,
          missing,
        ]);
        const oursResult = await runOursTagCreate(pair.ours, name, missing, { message: 'x' });

        // Assert
        expect(peerResult.exitCode).toBe(128);
        expect(peerResult.stderr).toContain('bad object type');
        expect(oursResult.ok).toBe(false);
        if (!oursResult.ok) expect(oursResult.error.data.code).toBe('OBJECT_NOT_FOUND');
        expect(
          tryRunGitWithExit(['-C', pair.peer, 'rev-parse', '--verify', `refs/tags/${name}`])
            .exitCode,
        ).not.toBe(0);
        expect(
          tryRunGitWithExit(['-C', pair.ours, 'rev-parse', '--verify', `refs/tags/${name}`])
            .exitCode,
        ).not.toBe(0);
      });
    });
  });
});

describe.skipIf(!GIT_AVAILABLE)('tag interop — reftable backend', () => {
  const SETUP_TIMEOUT = 60_000;
  let reftableBase = '';
  let treeId = '';

  beforeAll(async () => {
    reftableBase = await mkdtemp(path.join(os.tmpdir(), 'tsgit-tag-verify-reftable-'));
    runGit(['init', '-q', '-b', 'main', '--ref-format=reftable', reftableBase]);
    git(reftableBase, 'config', 'user.name', TAGGER.name);
    git(reftableBase, 'config', 'user.email', TAGGER.email);
    disableAutoMaintenance(reftableBase);
    await writeFile(path.join(reftableBase, 'f.txt'), 'c1\n');
    git(reftableBase, 'add', '-A');
    runGit(['-C', reftableBase, 'commit', '-q', '-m', 'c1'], { env: commitEnv(TAGGER.timestamp) });
    treeId = git(reftableBase, 'rev-parse', 'HEAD^{tree}').trim();
  }, SETUP_TIMEOUT);

  afterAll(async () => {
    await rm(reftableBase, { recursive: true, force: true });
  });

  let pair: PeerPair;

  beforeEach(async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tsgit-tag-verify-reftable-pair-'));
    const peer = path.join(root, 'peer');
    const ours = path.join(root, 'ours');
    await cp(reftableBase, peer, { recursive: true });
    await cp(reftableBase, ours, { recursive: true });
    pair = {
      peer,
      ours,
      dispose: () => rm(root, { recursive: true, force: true }),
    };
  });

  afterEach(async () => {
    await pair.dispose();
  });

  const withReftableStorage = (ctx: Context): Context => ({
    ...ctx,
    layout: { ...ctx.layout, refStorage: 'reftable' },
  });

  describe('Given a reftable-backed repository, a tree target and a missing target', () => {
    describe('When git tag and tsgit tag create each attempt both, same as the files backend', () => {
      it('Then the tree is accepted and the missing target is refused', async () => {
        // Arrange
        const missing = '7'.repeat(40);
        const ctx = withReftableStorage(nodeCtx(pair.ours));

        // Act
        const peerTreeResult = tryRunGitWithExit(['-C', pair.peer, 'tag', 'l-tree', treeId]);
        const oursTreeResult = await tagCreate(ctx, { name: 'l-tree', target: treeId });
        const peerMissingResult = tryRunGitWithExit(['-C', pair.peer, 'tag', 'l-nx', missing]);
        let caught: unknown;
        try {
          await tagCreate(ctx, { name: 'l-nx', target: missing });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(peerTreeResult.exitCode).toBe(0);
        expect(oursTreeResult.id).toBe(treeId);
        expect(peerMissingResult.exitCode).toBe(128);
        expect(peerMissingResult.stderr).toContain('nonexistent object');
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('OBJECT_NOT_FOUND');
      });
    });
  });
});
