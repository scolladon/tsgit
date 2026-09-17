/**
 * Cross-tool interop — ref updates verify their target as git's ref
 * transaction does: the object must exist and its stored bytes must hash to
 * it, and a branch (`HEAD` or `refs/heads/*`) additionally needs a commit.
 * One shared base repo is built once with canonical git (files backend) and
 * a reftable twin; every row copies the relevant base into a fresh `peer`
 * (mutated by git) and `ours` (mutated by tsgit), then compares exit code,
 * reconstructed stderr and ref presence.
 *
 * @proves
 *   surface:        updateRef
 *   bucket:         cross-tool-interop
 *   unique:         ref updates verify their target as git's ref transaction does
 *   interopSurface: updateRef
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { updateRef } from '../../src/application/primitives/update-ref.js';
import { writeSymbolicRef } from '../../src/application/primitives/write-symbolic-ref.js';
import type { TsgitError } from '../../src/domain/error.js';
import type { ObjectId, RefName } from '../../src/domain/objects/index.js';
import type { Context } from '../../src/ports/context.js';
import {
  disableAutoMaintenance,
  GIT_AVAILABLE,
  git,
  runGit,
  runGitEnv,
  tryRunGitWithExit,
} from './interop-helpers.js';

const SETUP_TIMEOUT = 60_000;
const COMMITTER_EPOCH = 1_700_000_000;
const REFLOG_MESSAGE = 'ref write verification interop';

const IDENTITY_ENV: NodeJS.ProcessEnv = {
  GIT_AUTHOR_NAME: 'A',
  GIT_AUTHOR_EMAIL: 'a@x',
  GIT_COMMITTER_NAME: 'A',
  GIT_COMMITTER_EMAIL: 'a@x',
};

const pinnedEnv = (epoch: number): NodeJS.ProcessEnv => ({
  ...runGitEnv(),
  ...IDENTITY_ENV,
  GIT_AUTHOR_DATE: `${epoch} +0000`,
  GIT_COMMITTER_DATE: `${epoch} +0000`,
});

const withReftableStorage = (ctx: Context): Context => ({
  ...ctx,
  layout: { ...ctx.layout, refStorage: 'reftable' },
});

const nodeCtx = (dir: string): Context => createNodeContext({ workDir: dir });

/** git's `fatal: update_ref failed for ref '<ref>': trying to write ref
 *  '<ref>' with nonexistent object <id>` — the shape every OBJECT_NOT_FOUND
 *  refusal composes from the ref name plus the id. */
const nonexistentFatal = (ref: string, id: string): string =>
  `fatal: update_ref failed for ref '${ref}': trying to write ref '${ref}' with nonexistent object ${id}`;

/** git's `fatal: update_ref failed for ref '<ref>': trying to write
 *  non-commit object <id> to branch '<ref>'` — typed by the ref name the
 *  caller passed, never the chain's terminal. */
const nonCommitFatal = (ref: string, id: string): string =>
  `fatal: update_ref failed for ref '${ref}': trying to write non-commit object ${id} to branch '${ref}'`;

/** The `--stdin` form of `nonCommitFatal`: no per-ref `update_ref failed`
 *  prefix, since `--stdin` reports the whole transaction's failure once. */
const nonCommitFatalStdin = (ref: string, id: string): string =>
  `fatal: trying to write non-commit object ${id} to branch '${ref}'`;

/** git's hash-mismatch shape: `error: hash mismatch <id>` on its own line,
 *  then the nonexistent-object fatal — `parse_object` hashes before it
 *  reports the object missing. */
const hashMismatchStderr = (ref: string, id: string): string =>
  `error: hash mismatch ${id}\n${nonexistentFatal(ref, id)}`;

/** Copies a loose object's on-disk bytes to a DIFFERENT (fabricated) id's
 *  own path — the hash-mismatch fixture: the file exists and inflates, but
 *  its bytes don't hash to the id naming it. */
const plantLooseAt = (repoDir: string, fakeId: string, sourceId: string): void => {
  const srcPath = path.join(repoDir, '.git', 'objects', sourceId.slice(0, 2), sourceId.slice(2));
  const dstDir = path.join(repoDir, '.git', 'objects', fakeId.slice(0, 2));
  mkdirSync(dstDir, { recursive: true });
  const bytes = readFileSync(srcPath);
  const dstPath = path.join(dstDir, fakeId.slice(2));
  writeFileSync(dstPath, bytes);
  chmodSync(dstPath, 0o644);
};

interface TsgitOutcome {
  readonly ok: boolean;
  readonly code: string | undefined;
}

/** Runs `updateRef` against `ours`, capturing success or the refusal's data
 *  code — never lets a refusal escape as an uncaught rejection. */
const runOurs = async (
  ours: string,
  name: string,
  id: string,
  options: { readonly expected?: string; readonly noDeref?: boolean } = {},
): Promise<TsgitOutcome> => {
  const ctx = nodeCtx(ours);
  try {
    await updateRef(ctx, name as RefName, id as ObjectId, {
      reflogMessage: REFLOG_MESSAGE,
      ...(options.expected !== undefined ? { expected: options.expected as ObjectId } : {}),
      ...(options.noDeref !== undefined ? { noDeref: options.noDeref } : {}),
    });
    return { ok: true, code: undefined };
  } catch (error) {
    return { ok: false, code: (error as TsgitError).data.code };
  }
};

describe.skipIf(!GIT_AVAILABLE)(
  'integration — updateRef target verification parity with canonical git',
  () => {
    let filesBase = '';
    let reftableBase = '';
    let mainId = '';
    let treeId = '';
    let blobId = '';
    let annotatedTagId = '';
    let reftableMainId = '';
    let noTreeLineCommitId = '';
    let nonHexParentCommitId = '';
    let bogusTypeTagId = '';
    let shortObjectLineTagId = '';
    let noAuthorCommitId = '';
    let garbageTreeId = '';
    let selfParentCommitId = '';
    let upperCaseTreeCommitId = '';
    let junkAfterAuthorCommitId = '';
    let emptyTagNameId = '';
    let tooShortTagId = '';
    const NX = '1'.repeat(40);
    const caseRoots: string[] = [];

    /** `git hash-object --literally -w -t <type> --stdin` against the files
     *  base — plants an object both twins hold without validating it, the
     *  same way a hostile advertisement or a hand-crafted object would
     *  arrive. Every row below only WRITES a ref to one of these, through
     *  git in `peer` and `updateRef` in `ours`. */
    const plantObject = (type: string, body: string): string =>
      runGit(['-C', filesBase, 'hash-object', '--literally', '-w', '-t', type, '--stdin'], {
        input: body,
      }).trim();

    beforeAll(async () => {
      filesBase = await mkdtemp(path.join(os.tmpdir(), 'tsgit-ref-write-verify-files-'));
      runGit(['init', '-q', '-b', 'main', filesBase]);
      git(filesBase, 'config', 'user.name', 'A');
      git(filesBase, 'config', 'user.email', 'a@x');
      git(filesBase, 'config', 'commit.gpgsign', 'false');
      git(filesBase, 'config', 'tag.gpgsign', 'false');
      disableAutoMaintenance(filesBase);
      await writeFile(path.join(filesBase, 'f.txt'), 'c1\n');
      git(filesBase, 'add', '-A');
      runGit(['-C', filesBase, 'commit', '-q', '-m', 'c1'], { env: pinnedEnv(COMMITTER_EPOCH) });
      mainId = git(filesBase, 'rev-parse', 'HEAD').trim();
      treeId = git(filesBase, 'rev-parse', 'HEAD^{tree}').trim();
      blobId = git(filesBase, 'hash-object', path.join(filesBase, 'f.txt')).trim();
      runGit(['-C', filesBase, 'tag', '-a', 'at1', '-m', 'x', treeId], {
        env: pinnedEnv(COMMITTER_EPOCH + 1),
      });
      annotatedTagId = git(filesBase, 'rev-parse', 'at1').trim();

      // Parse-acceptance fixtures — every object below is planted once, in
      // the base, before any peer/ours copy is made.
      noTreeLineCommitId = plantObject('commit', `parent ${mainId}\n\nmsg\n`);
      nonHexParentCommitId = plantObject(
        'commit',
        `tree ${treeId}\nparent ${treeId.slice(0, 39)}z\n\nmsg\n`,
      );
      bogusTypeTagId = plantObject('tag', `object ${mainId}\ntype bogus\ntag t\n\nmsg\n`);
      shortObjectLineTagId = plantObject(
        'tag',
        `object ${treeId.slice(0, 30)}\ntype commit\ntag t\n\nmsg\n`,
      );
      noAuthorCommitId = plantObject('commit', `tree ${treeId}\nparent ${mainId}\n\nmsg\n`);
      garbageTreeId = plantObject('tree', 'not a real tree body');
      selfParentCommitId = plantObject('commit', `tree ${treeId}\nparent ${treeId}\n\nmsg\n`);
      upperCaseTreeCommitId = plantObject('commit', `tree ${treeId.toUpperCase()}\n\nmsg\n`);
      junkAfterAuthorCommitId = plantObject(
        'commit',
        `tree ${treeId}\nauthor A <a@x> 0 +0000\nparent ${mainId}\n\nmsg\n`,
      );
      emptyTagNameId = plantObject('tag', `object ${mainId}\ntype commit\ntag \n\nmsg\n`);
      tooShortTagId = plantObject('tag', `object ${mainId}\ntype commit\n`);

      reftableBase = await mkdtemp(path.join(os.tmpdir(), 'tsgit-ref-write-verify-reftable-'));
      runGit(['init', '-q', '-b', 'main', '--ref-format=reftable', reftableBase]);
      git(reftableBase, 'config', 'user.name', 'A');
      git(reftableBase, 'config', 'user.email', 'a@x');
      git(reftableBase, 'config', 'commit.gpgsign', 'false');
      disableAutoMaintenance(reftableBase);
      await writeFile(path.join(reftableBase, 'f.txt'), 'c1\n');
      git(reftableBase, 'add', '-A');
      runGit(['-C', reftableBase, 'commit', '-q', '-m', 'c1'], {
        env: pinnedEnv(COMMITTER_EPOCH),
      });
      reftableMainId = git(reftableBase, 'rev-parse', 'HEAD').trim();
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      await rm(filesBase, { recursive: true, force: true });
      await rm(reftableBase, { recursive: true, force: true });
      await Promise.all(
        caseRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
      );
    });

    /** A fresh `{ peer, ours }` pair, each an independent copy of `source`. */
    const pairFrom = async (
      source: string,
      slug: string,
    ): Promise<{ readonly peer: string; readonly ours: string }> => {
      const root = await mkdtemp(path.join(os.tmpdir(), `tsgit-ref-write-verify-${slug}-`));
      caseRoots.push(root);
      const peer = path.join(root, 'peer');
      const ours = path.join(root, 'ours');
      await cp(source, peer, { recursive: true });
      await cp(source, ours, { recursive: true });
      return { peer, ours };
    };

    const filesPair = (slug: string): Promise<{ readonly peer: string; readonly ours: string }> =>
      pairFrom(filesBase, slug);

    describe('Given a target commit, tree, blob, annotated tag or missing id, When update-ref writes refs/heads/u', () => {
      it.each([
        { label: 'commit', target: () => mainId, ok: true },
        { label: 'tree', target: () => treeId, ok: false },
        { label: 'blob', target: () => blobId, ok: false },
        { label: 'annotated tag (not peeled)', target: () => annotatedTagId, ok: false },
        { label: 'missing', target: () => NX, ok: false },
      ])('Then $label matches git', async ({ target, ok }) => {
        // Arrange
        const { peer, ours } = await filesPair('fresh-branch-target');
        const id = target();

        // Act
        const gitResult = tryRunGitWithExit(['-C', peer, 'update-ref', 'refs/heads/u', id]);
        const oursResult = await runOurs(ours, 'refs/heads/u', id);

        // Assert
        expect(oursResult.ok).toBe(ok);
        expect(gitResult.exitCode).toBe(ok ? 0 : 128);
        if (!ok) {
          expect(
            oursResult.code === 'UNEXPECTED_OBJECT_TYPE' || oursResult.code === 'OBJECT_NOT_FOUND',
          ).toBe(true);
          const expectedStderr =
            oursResult.code === 'OBJECT_NOT_FOUND'
              ? nonexistentFatal('refs/heads/u', id)
              : nonCommitFatal('refs/heads/u', id);
          expect(gitResult.stderr.trim()).toBe(expectedStderr);
        }
      });
    });

    describe('Given every non-branch namespace, When update-ref writes a commit/tree/blob/tag', () => {
      const NAMESPACES = [
        'refs/tags/u',
        'refs/remotes/o/u',
        'refs/notes/u',
        'refs/u',
        'refs/stash',
      ];
      const TYPES: ReadonlyArray<{ readonly label: string; readonly target: () => string }> = [
        { label: 'commit', target: () => mainId },
        { label: 'tree', target: () => treeId },
        { label: 'blob', target: () => blobId },
        { label: 'annotated tag', target: () => annotatedTagId },
      ];
      const ROWS = NAMESPACES.flatMap((ref) => TYPES.map((type) => ({ ref, ...type })));

      it.each(ROWS)('Then $ref accepts $label', async ({ ref, target }) => {
        // Arrange
        const { peer, ours } = await filesPair(`non-branch-namespace-${ref.replace(/\//g, '_')}`);
        const id = target();

        // Act
        const gitResult = tryRunGitWithExit(['-C', peer, 'update-ref', ref, id]);
        const oursResult = await runOurs(ours, ref, id);

        // Assert
        expect(gitResult.exitCode).toBe(0);
        expect(oursResult.ok).toBe(true);
      });
    });

    describe('Given the same five refs with a missing target, When update-ref runs', () => {
      it.each(['refs/tags/u', 'refs/remotes/o/u', 'refs/notes/u', 'refs/u', 'refs/stash'])(
        'Then %s refuses nonexistent object',
        async (ref) => {
          // Arrange
          const { peer, ours } = await filesPair(`missing-target-${ref.replace(/\//g, '_')}`);

          // Act
          const gitResult = tryRunGitWithExit(['-C', peer, 'update-ref', ref, NX]);
          const oursResult = await runOurs(ours, ref, NX);

          // Assert
          expect(gitResult.exitCode).toBe(128);
          expect(gitResult.stderr.trim()).toBe(nonexistentFatal(ref, NX));
          expect(oursResult.ok).toBe(false);
          expect(oursResult.code).toBe('OBJECT_NOT_FOUND');
        },
      );
    });

    describe('Given HEAD (a branch symref), When update-ref writes a tree', () => {
      it.each([
        { label: 'deref (default)', noDeref: false },
        { label: '--no-deref', noDeref: true },
      ])('Then $label refuses non-commit typed by HEAD', async ({ noDeref }) => {
        // Arrange
        const { peer, ours } = await filesPair(`head-tree-${String(noDeref)}`);
        const args = noDeref
          ? ['-C', peer, 'update-ref', '--no-deref', 'HEAD', treeId]
          : ['-C', peer, 'update-ref', 'HEAD', treeId];

        // Act
        const gitResult = tryRunGitWithExit(args);
        const oursResult = await runOurs(ours, 'HEAD', treeId, { noDeref });

        // Assert
        expect(gitResult.exitCode).toBe(128);
        expect(gitResult.stderr.trim()).toBe(nonCommitFatal('HEAD', treeId));
        expect(oursResult.ok).toBe(false);
        expect(oursResult.code).toBe('UNEXPECTED_OBJECT_TYPE');
      });
    });

    describe('Given ORIG_HEAD and FOO_HEAD (non-branch pseudo-refs), When update-ref runs', () => {
      it('Then --no-deref HEAD with a missing id refuses nonexistent', async () => {
        // Arrange
        const { peer, ours } = await filesPair('no-deref-head-missing');

        // Act
        const gitResult = tryRunGitWithExit(['-C', peer, 'update-ref', '--no-deref', 'HEAD', NX]);
        const oursResult = await runOurs(ours, 'HEAD', NX, { noDeref: true });

        // Assert
        expect(gitResult.exitCode).toBe(128);
        expect(gitResult.stderr.trim()).toBe(nonexistentFatal('HEAD', NX));
        expect(oursResult.ok).toBe(false);
        expect(oursResult.code).toBe('OBJECT_NOT_FOUND');
      });

      it('Then ORIG_HEAD accepts a tree (not branch-typed)', async () => {
        // Arrange
        const { peer, ours } = await filesPair('orig-head-tree');

        // Act
        const gitResult = tryRunGitWithExit(['-C', peer, 'update-ref', 'ORIG_HEAD', treeId]);
        const oursResult = await runOurs(ours, 'ORIG_HEAD', treeId);

        // Assert
        expect(gitResult.exitCode).toBe(0);
        expect(oursResult.ok).toBe(true);
      });

      it('Then FOO_HEAD with a missing id refuses nonexistent (not branch-typed)', async () => {
        // Arrange
        const { peer, ours } = await filesPair('foo-head-missing');

        // Act
        const gitResult = tryRunGitWithExit(['-C', peer, 'update-ref', 'FOO_HEAD', NX]);
        const oursResult = await runOurs(ours, 'FOO_HEAD', NX);

        // Assert
        expect(gitResult.exitCode).toBe(128);
        expect(gitResult.stderr.trim()).toBe(nonexistentFatal('FOO_HEAD', NX));
        expect(oursResult.ok).toBe(false);
        expect(oursResult.code).toBe('OBJECT_NOT_FOUND');
      });
    });

    describe('Given a git --stdin transaction beside tsgit’s single updateRef, When each writes a tree to a branch', () => {
      it('Then create refs/heads/s <tree> refuses the same way, without the update_ref-failed prefix', async () => {
        // Arrange
        const { peer, ours } = await filesPair('stdin-create-branch');

        // Act
        const gitResult = tryRunGitWithExit(['-C', peer, 'update-ref', '--stdin'], {
          input: `create refs/heads/s ${treeId}\n`,
        });
        const oursResult = await runOurs(ours, 'refs/heads/s', treeId);

        // Assert
        expect(gitResult.exitCode).toBe(128);
        expect(gitResult.stderr.trim()).toBe(nonCommitFatalStdin('refs/heads/s', treeId));
        expect(gitResult.stderr).not.toContain('update_ref failed');
        expect(oursResult.ok).toBe(false);
        expect(oursResult.code).toBe('UNEXPECTED_OBJECT_TYPE');
      });

      it('Then update refs/heads/main <tree> refuses the same way', async () => {
        // Arrange
        const { peer, ours } = await filesPair('stdin-update-branch');

        // Act
        const gitResult = tryRunGitWithExit(['-C', peer, 'update-ref', '--stdin'], {
          input: `update refs/heads/main ${treeId}\n`,
        });
        const oursResult = await runOurs(ours, 'refs/heads/main', treeId);

        // Assert
        expect(gitResult.exitCode).toBe(128);
        expect(gitResult.stderr.trim()).toBe(nonCommitFatalStdin('refs/heads/main', treeId));
        expect(oursResult.ok).toBe(false);
        expect(oursResult.code).toBe('UNEXPECTED_OBJECT_TYPE');
      });
    });

    describe('Given a compare-and-swap plus an invalid target, When update-ref runs', () => {
      it('Then a missing target on refs/tags/t is reported before the wrong-old CAS', async () => {
        // Arrange
        const { peer, ours } = await filesPair('cas-missing-tag');

        // Act
        const gitResult = tryRunGitWithExit(['-C', peer, 'update-ref', 'refs/tags/t', NX, mainId]);
        const oursResult = await runOurs(ours, 'refs/tags/t', NX, { expected: mainId });

        // Assert
        expect(gitResult.exitCode).toBe(128);
        expect(gitResult.stderr.trim()).toBe(nonexistentFatal('refs/tags/t', NX));
        expect(oursResult.ok).toBe(false);
        expect(oursResult.code).toBe('OBJECT_NOT_FOUND');
      });

      it('Then a non-commit target on refs/heads/main is reported before the wrong-old CAS', async () => {
        // Arrange
        const { peer, ours } = await filesPair('cas-non-commit-branch');

        // Act
        const gitResult = tryRunGitWithExit([
          '-C',
          peer,
          'update-ref',
          'refs/heads/main',
          treeId,
          NX,
        ]);
        const oursResult = await runOurs(ours, 'refs/heads/main', treeId, { expected: NX });

        // Assert
        expect(gitResult.exitCode).toBe(128);
        expect(gitResult.stderr.trim()).toBe(nonCommitFatal('refs/heads/main', treeId));
        expect(oursResult.ok).toBe(false);
        expect(oursResult.code).toBe('UNEXPECTED_OBJECT_TYPE');
      });
    });

    describe('Given a hash-mismatching planted object, When update-ref runs', () => {
      it('Then refs/tags/cb reports hash mismatch then nonexistent', async () => {
        // Arrange
        const { peer, ours } = await filesPair('hash-mismatch-tag');
        const fakeId = 'c'.repeat(40);
        plantLooseAt(peer, fakeId, blobId);
        plantLooseAt(ours, fakeId, blobId);

        // Act
        const gitResult = tryRunGitWithExit(['-C', peer, 'update-ref', 'refs/tags/cb', fakeId]);
        const oursResult = await runOurs(ours, 'refs/tags/cb', fakeId);

        // Assert
        expect(gitResult.exitCode).toBe(128);
        expect(gitResult.stderr.trim()).toBe(hashMismatchStderr('refs/tags/cb', fakeId));
        expect(oursResult.ok).toBe(false);
        expect(oursResult.code).toBe('OBJECT_HASH_MISMATCH');
      });

      it('Then refs/heads/cc reports hash mismatch then nonexistent (not the branch-typing refusal)', async () => {
        // Arrange
        const { peer, ours } = await filesPair('hash-mismatch-branch');
        const fakeId = 'd'.repeat(40);
        plantLooseAt(peer, fakeId, mainId);
        plantLooseAt(ours, fakeId, mainId);

        // Act
        const gitResult = tryRunGitWithExit(['-C', peer, 'update-ref', 'refs/heads/cc', fakeId]);
        const oursResult = await runOurs(ours, 'refs/heads/cc', fakeId);

        // Assert
        expect(gitResult.exitCode).toBe(128);
        expect(gitResult.stderr.trim()).toBe(hashMismatchStderr('refs/heads/cc', fakeId));
        expect(oursResult.ok).toBe(false);
        expect(oursResult.code).toBe('OBJECT_HASH_MISMATCH');
      });
    });

    describe('Given deletes, null ids and symbolic writes, When update-ref runs', () => {
      it('Then -d with a wrong old id is a CAS refusal, not verification', async () => {
        // Arrange
        const { peer, ours } = await filesPair('delete-wrong-old');
        runGit(['-C', peer, 'branch', 'delete-target', 'main']);
        const ctx = nodeCtx(ours);
        await updateRef(ctx, 'refs/heads/delete-target' as RefName, mainId as ObjectId, {
          reflogMessage: REFLOG_MESSAGE,
        });

        // Act
        const gitResult = tryRunGitWithExit([
          '-C',
          peer,
          'update-ref',
          '-d',
          'refs/heads/delete-target',
          NX,
        ]);
        let oursCode: string | undefined;
        try {
          await updateRef(ctx, 'refs/heads/delete-target' as RefName, '0'.repeat(40) as ObjectId, {
            delete: true,
            expected: NX as ObjectId,
          });
        } catch (error) {
          oursCode = (error as TsgitError).data.code;
        }

        // Assert
        expect(gitResult.exitCode).toBe(1);
        expect(oursCode).toBe('REF_UPDATE_CONFLICT');
      });

      it('Then symbolic-ref writes agree, and a typed write through it refuses by the given name', async () => {
        // Arrange
        const { peer, ours } = await filesPair('dangling-symbolic-write');

        // Act
        const gitSym = tryRunGitWithExit([
          '-C',
          peer,
          'symbolic-ref',
          'refs/heads/s',
          'refs/heads/nope',
        ]);
        await writeSymbolicRef(
          nodeCtx(ours),
          'refs/heads/s' as RefName,
          'refs/heads/nope' as RefName,
        );
        const gitWrite = tryRunGitWithExit(['-C', peer, 'update-ref', 'refs/heads/s', treeId]);
        const oursWrite = await runOurs(ours, 'refs/heads/s', treeId);

        // Assert
        expect(gitSym.exitCode).toBe(0);
        expect(gitWrite.exitCode).toBe(128);
        expect(gitWrite.stderr.trim()).toBe(nonCommitFatal('refs/heads/s', treeId));
        expect(oursWrite.ok).toBe(false);
        expect(oursWrite.code).toBe('UNEXPECTED_OBJECT_TYPE');
      });

      it('Then a tag symref to a branch writes through, typed by the terminal', async () => {
        // Arrange
        const { peer, ours } = await filesPair('tag-symref-to-branch');
        runGit(['-C', peer, 'branch', 'x', 'main']);
        await updateRef(nodeCtx(ours), 'refs/heads/x' as RefName, mainId as ObjectId, {
          reflogMessage: REFLOG_MESSAGE,
        });
        const gitSym = tryRunGitWithExit([
          '-C',
          peer,
          'symbolic-ref',
          'refs/tags/ts',
          'refs/heads/x',
        ]);
        await writeSymbolicRef(nodeCtx(ours), 'refs/tags/ts' as RefName, 'refs/heads/x' as RefName);

        // Act
        const gitWrite = tryRunGitWithExit(['-C', peer, 'update-ref', 'refs/tags/ts', treeId]);
        const oursWrite = await runOurs(ours, 'refs/tags/ts', treeId);

        // Assert
        expect(gitSym.exitCode).toBe(0);
        expect(gitWrite.exitCode).toBe(0);
        expect(oursWrite.ok).toBe(true);
      });

      it('Then a branch symref to a tag refuses non-commit typed by the given (branch) name', async () => {
        // Arrange
        const { peer, ours } = await filesPair('branch-symref-to-tag');
        runGit(['-C', peer, 'tag', 'tt', 'main']);
        await updateRef(nodeCtx(ours), 'refs/tags/tt' as RefName, mainId as ObjectId, {
          reflogMessage: REFLOG_MESSAGE,
        });
        const gitSym = tryRunGitWithExit([
          '-C',
          peer,
          'symbolic-ref',
          'refs/heads/bt',
          'refs/tags/tt',
        ]);
        await writeSymbolicRef(
          nodeCtx(ours),
          'refs/heads/bt' as RefName,
          'refs/tags/tt' as RefName,
        );

        // Act
        const gitWrite = tryRunGitWithExit(['-C', peer, 'update-ref', 'refs/heads/bt', treeId]);
        const oursWrite = await runOurs(ours, 'refs/heads/bt', treeId);

        // Assert
        expect(gitSym.exitCode).toBe(0);
        expect(gitWrite.exitCode).toBe(128);
        expect(gitWrite.stderr.trim()).toBe(nonCommitFatal('refs/heads/bt', treeId));
        expect(oursWrite.ok).toBe(false);
        expect(oursWrite.code).toBe('UNEXPECTED_OBJECT_TYPE');
      });
    });

    describe('Given the empty-tree and empty-blob well-known ids, When update-ref runs', () => {
      const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
      const EMPTY_BLOB = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';

      it('Then the (never stored) empty tree is accepted on a non-branch ref', async () => {
        // Arrange
        const { peer, ours } = await filesPair('empty-tree-tag');

        // Act
        const gitResult = tryRunGitWithExit(['-C', peer, 'update-ref', 'refs/tags/et', EMPTY_TREE]);
        const oursResult = await runOurs(ours, 'refs/tags/et', EMPTY_TREE);

        // Assert
        expect(gitResult.exitCode).toBe(0);
        expect(oursResult.ok).toBe(true);
      });

      it('Then the (never stored) empty tree refuses non-commit on a branch', async () => {
        // Arrange
        const { peer, ours } = await filesPair('empty-tree-branch');

        // Act
        const gitResult = tryRunGitWithExit([
          '-C',
          peer,
          'update-ref',
          'refs/heads/et',
          EMPTY_TREE,
        ]);
        const oursResult = await runOurs(ours, 'refs/heads/et', EMPTY_TREE);

        // Assert
        expect(gitResult.exitCode).toBe(128);
        expect(gitResult.stderr.trim()).toBe(nonCommitFatal('refs/heads/et', EMPTY_TREE));
        expect(oursResult.ok).toBe(false);
        expect(oursResult.code).toBe('UNEXPECTED_OBJECT_TYPE');
      });

      it('Then the (never stored) empty blob refuses nonexistent', async () => {
        // Arrange
        const { peer, ours } = await filesPair('empty-blob');

        // Act
        const gitResult = tryRunGitWithExit(['-C', peer, 'update-ref', 'refs/tags/eb', EMPTY_BLOB]);
        const oursResult = await runOurs(ours, 'refs/tags/eb', EMPTY_BLOB);

        // Assert
        expect(gitResult.exitCode).toBe(128);
        expect(gitResult.stderr.trim()).toBe(nonexistentFatal('refs/tags/eb', EMPTY_BLOB));
        expect(oursResult.ok).toBe(false);
        expect(oursResult.code).toBe('OBJECT_NOT_FOUND');
      });
    });

    describe('Given commit and tag targets git’s own parser accepts or refuses, When update-ref writes them', () => {
      it('Then a commit with no tree line refuses bogus commit object', async () => {
        // Arrange
        const { peer, ours } = await filesPair('no-tree-line');

        // Act
        const gitResult = tryRunGitWithExit([
          '-C',
          peer,
          'update-ref',
          'refs/tags/x',
          noTreeLineCommitId,
        ]);
        const oursResult = await runOurs(ours, 'refs/tags/x', noTreeLineCommitId);

        // Assert
        expect(gitResult.exitCode).toBe(128);
        expect(gitResult.stderr.trim()).toBe(
          `error: bogus commit object ${noTreeLineCommitId}\n${nonexistentFatal('refs/tags/x', noTreeLineCommitId)}`,
        );
        expect(oursResult.ok).toBe(false);
        expect(oursResult.code).toBe('INVALID_COMMIT');
      });

      it('Then a parent line with a non-hex character refuses', async () => {
        // Arrange
        const { peer, ours } = await filesPair('non-hex-parent');

        // Act
        const gitResult = tryRunGitWithExit([
          '-C',
          peer,
          'update-ref',
          'refs/tags/x',
          nonHexParentCommitId,
        ]);
        const oursResult = await runOurs(ours, 'refs/tags/x', nonHexParentCommitId);

        // Assert
        expect(gitResult.exitCode).toBe(128);
        expect(oursResult.ok).toBe(false);
        expect(oursResult.code).toBe('INVALID_COMMIT');
      });

      it('Then an unknown tag type refuses, reporting the type name', async () => {
        // Arrange
        const { peer, ours } = await filesPair('bogus-tag-type');

        // Act
        const gitResult = tryRunGitWithExit([
          '-C',
          peer,
          'update-ref',
          'refs/tags/x',
          bogusTypeTagId,
        ]);
        const oursResult = await runOurs(ours, 'refs/tags/x', bogusTypeTagId);

        // Assert
        expect(gitResult.exitCode).toBe(128);
        expect(gitResult.stderr).toContain(`unknown tag type 'bogus' in ${bogusTypeTagId}`);
        expect(oursResult.ok).toBe(false);
        expect(oursResult.code).toBe('INVALID_TAG');
      });

      it('Then a tag whose object line is cut short refuses (fatal only, no error: line)', async () => {
        // Arrange
        const { peer, ours } = await filesPair('short-object-line');

        // Act
        const gitResult = tryRunGitWithExit([
          '-C',
          peer,
          'update-ref',
          'refs/tags/x',
          shortObjectLineTagId,
        ]);
        const oursResult = await runOurs(ours, 'refs/tags/x', shortObjectLineTagId);

        // Assert
        expect(gitResult.exitCode).toBe(128);
        expect(gitResult.stderr).not.toContain('error:');
        expect(oursResult.ok).toBe(false);
        expect(oursResult.code).toBe('INVALID_TAG');
      });

      it('Then a commit with a tree and a parent but no author or committer is accepted on a branch', async () => {
        // Arrange
        const { peer, ours } = await filesPair('no-author');

        // Act
        const gitResult = tryRunGitWithExit([
          '-C',
          peer,
          'update-ref',
          'refs/heads/x',
          noAuthorCommitId,
        ]);
        const oursResult = await runOurs(ours, 'refs/heads/x', noAuthorCommitId);

        // Assert
        expect(gitResult.exitCode).toBe(0);
        expect(oursResult.ok).toBe(true);
      });

      it('Then a garbage tree body is accepted on a non-branch ref', async () => {
        // Arrange
        const { peer, ours } = await filesPair('garbage-tree');

        // Act
        const gitResult = tryRunGitWithExit([
          '-C',
          peer,
          'update-ref',
          'refs/tags/x',
          garbageTreeId,
        ]);
        const oursResult = await runOurs(ours, 'refs/tags/x', garbageTreeId);

        // Assert
        expect(gitResult.exitCode).toBe(0);
        expect(oursResult.ok).toBe(true);
      });

      it('Then a parent equal to the tree refuses bad parent, naming the tree in both tools', async () => {
        // Arrange
        const { peer, ours } = await filesPair('self-parent');

        // Act
        const gitResult = tryRunGitWithExit([
          '-C',
          peer,
          'update-ref',
          'refs/tags/x',
          selfParentCommitId,
        ]);
        const oursResult = await runOurs(ours, 'refs/tags/x', selfParentCommitId);

        // Assert
        expect(gitResult.exitCode).toBe(128);
        expect(gitResult.stderr).toContain(`bad parent ${treeId} in commit ${selfParentCommitId}`);
        expect(oursResult.ok).toBe(false);
        expect(oursResult.code).toBe('INVALID_COMMIT');
      });

      it('Then the same commit listed in .git/shallow in both twins is accepted on a tag and a branch', async () => {
        // Arrange
        const { peer, ours } = await filesPair('self-parent-shallow');
        await writeFile(path.join(peer, '.git', 'shallow'), `${selfParentCommitId}\n`);
        await writeFile(path.join(ours, '.git', 'shallow'), `${selfParentCommitId}\n`);

        // Act
        const gitTag = tryRunGitWithExit([
          '-C',
          peer,
          'update-ref',
          'refs/tags/x',
          selfParentCommitId,
        ]);
        const oursTag = await runOurs(ours, 'refs/tags/x', selfParentCommitId);
        const gitBranch = tryRunGitWithExit([
          '-C',
          peer,
          'update-ref',
          'refs/heads/x',
          selfParentCommitId,
        ]);
        const oursBranch = await runOurs(ours, 'refs/heads/x', selfParentCommitId);

        // Assert
        expect(gitTag.exitCode).toBe(0);
        expect(oursTag.ok).toBe(true);
        expect(gitBranch.exitCode).toBe(0);
        expect(oursBranch.ok).toBe(true);
      });

      it('Then an upper-case tree hex is accepted', async () => {
        // Arrange
        const { peer, ours } = await filesPair('upper-case-tree');

        // Act
        const gitResult = tryRunGitWithExit([
          '-C',
          peer,
          'update-ref',
          'refs/heads/x',
          upperCaseTreeCommitId,
        ]);
        const oursResult = await runOurs(ours, 'refs/heads/x', upperCaseTreeCommitId);

        // Assert
        expect(gitResult.exitCode).toBe(0);
        expect(oursResult.ok).toBe(true);
      });

      it('Then a junk "parent"-looking line after author is accepted', async () => {
        // Arrange
        const { peer, ours } = await filesPair('junk-after-author');

        // Act
        const gitResult = tryRunGitWithExit([
          '-C',
          peer,
          'update-ref',
          'refs/heads/x',
          junkAfterAuthorCommitId,
        ]);
        const oursResult = await runOurs(ours, 'refs/heads/x', junkAfterAuthorCommitId);

        // Assert
        expect(gitResult.exitCode).toBe(0);
        expect(oursResult.ok).toBe(true);
      });

      it('Then an empty tag name is accepted', async () => {
        // Arrange
        const { peer, ours } = await filesPair('empty-tag-name');

        // Act
        const gitResult = tryRunGitWithExit([
          '-C',
          peer,
          'update-ref',
          'refs/tags/x',
          emptyTagNameId,
        ]);
        const oursResult = await runOurs(ours, 'refs/tags/x', emptyTagNameId);

        // Assert
        expect(gitResult.exitCode).toBe(0);
        expect(oursResult.ok).toBe(true);
      });

      it('Then a tag body shorter than h + 24 refuses tag object too short', async () => {
        // Arrange
        const { peer, ours } = await filesPair('too-short-tag');

        // Act
        const gitResult = tryRunGitWithExit([
          '-C',
          peer,
          'update-ref',
          'refs/tags/x',
          tooShortTagId,
        ]);
        const oursResult = await runOurs(ours, 'refs/tags/x', tooShortTagId);

        // Assert
        expect(gitResult.exitCode).toBe(128);
        expect(oursResult.ok).toBe(false);
        expect(oursResult.code).toBe('INVALID_TAG');
      });
    });

    describe('Given a reftable-backend repository, When update-ref runs', () => {
      it('Then a commit target is accepted', async () => {
        // Arrange
        const { peer, ours } = await pairFrom(reftableBase, 'reftable-commit-target');
        const ctx = withReftableStorage(nodeCtx(ours));

        // Act
        const gitResult = tryRunGitWithExit([
          '-C',
          peer,
          'update-ref',
          'refs/heads/u',
          reftableMainId,
        ]);
        let oursOk = true;
        try {
          await updateRef(ctx, 'refs/heads/u' as RefName, reftableMainId as ObjectId, {
            reflogMessage: REFLOG_MESSAGE,
          });
        } catch {
          oursOk = false;
        }

        // Assert
        expect(gitResult.exitCode).toBe(0);
        expect(oursOk).toBe(true);
      });

      it('Then a tree target refuses non-commit', async () => {
        // Arrange
        const { peer, ours } = await pairFrom(reftableBase, 'reftable-tree-target');
        const treeGit = git(reftableBase, 'rev-parse', 'HEAD^{tree}').trim();
        const ctx = withReftableStorage(nodeCtx(ours));

        // Act
        const gitResult = tryRunGitWithExit(['-C', peer, 'update-ref', 'refs/heads/u', treeGit]);
        let oursCode: string | undefined;
        try {
          await updateRef(ctx, 'refs/heads/u' as RefName, treeGit as ObjectId, {
            reflogMessage: REFLOG_MESSAGE,
          });
        } catch (error) {
          oursCode = (error as TsgitError).data.code;
        }

        // Assert
        expect(gitResult.exitCode).toBe(128);
        expect(oursCode).toBe('UNEXPECTED_OBJECT_TYPE');
      });

      it('Then a missing target refuses nonexistent', async () => {
        // Arrange
        const { peer, ours } = await pairFrom(reftableBase, 'reftable-missing-target');
        const ctx = withReftableStorage(nodeCtx(ours));

        // Act
        const gitResult = tryRunGitWithExit(['-C', peer, 'update-ref', 'refs/heads/u', NX]);
        let oursCode: string | undefined;
        try {
          await updateRef(ctx, 'refs/heads/u' as RefName, NX as ObjectId, {
            reflogMessage: REFLOG_MESSAGE,
          });
        } catch (error) {
          oursCode = (error as TsgitError).data.code;
        }

        // Assert
        expect(gitResult.exitCode).toBe(128);
        expect(oursCode).toBe('OBJECT_NOT_FOUND');
      });
    });
  },
);
