/**
 * Cross-tool interop — a forced checkout that lands on the commit HEAD already holds, or on
 * another one. The same history is built with git plumbing in a canonical-git peer and in a
 * tsgit repo, a work-tree shape is planted over a settled index in both, git runs the forced
 * checkout in its peer and tsgit in the other, and the work tree, the index, its flags and
 * the stale and rewritten sets are compared.
 *
 * @proves
 *   surface:        repo.checkout
 *   bucket:         cross-tool-interop
 *   unique:         forced checkout rewrites every stale entry and resets conflicts as git does
 *   interopSurface: checkout
 */
import { readdirSync, rmSync, symlinkSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openRepository } from '../../src/index.node.js';
import type { Repository } from '../../src/repository.js';
import {
  GIT_AVAILABLE,
  git,
  initBothRepos,
  makePeerPair,
  type PeerPair,
  topReflogSubject,
} from './interop-helpers.js';
import {
  buildHistory,
  observe,
  regular,
  settleIndex,
  statSnapshot,
  WORK_TREE_SHAPES,
} from './occupant-displacement-fixtures.js';

const TAG = 'tg';

interface Spelling {
  readonly name: string;
  readonly detachFirst: boolean;
  readonly resolve: (dir: string) => string;
  readonly comparesHead: boolean;
}

/** A bare `HEAD` keeps the attachment decision out of this suite's comparison. */
const SPELLINGS: ReadonlyArray<Spelling> = [
  { name: '-f HEAD', detachFirst: false, resolve: () => 'HEAD', comparesHead: false },
  { name: '-f main', detachFirst: false, resolve: () => 'main', comparesHead: true },
  {
    name: '-f <oid>',
    detachFirst: false,
    resolve: (dir) => git(dir, 'rev-parse', 'main').trim(),
    comparesHead: true,
  },
  { name: '-f tag', detachFirst: false, resolve: () => TAG, comparesHead: true },
  { name: 'detached -f HEAD', detachFirst: true, resolve: () => 'HEAD', comparesHead: false },
];

const headState = (dir: string): readonly string[] => [
  git(dir, 'rev-parse', '--symbolic-full-name', 'HEAD').trim(),
  git(dir, 'rev-parse', 'HEAD').trim(),
  String(git(dir, 'reflog', 'show', 'HEAD').trim().split('\n').length),
  topReflogSubject(dir, 'HEAD'),
];

describe.skipIf(!GIT_AVAILABLE)('checkout forced same-commit interop', () => {
  let pair: PeerPair;
  let repo: Repository | undefined;

  beforeEach(async () => {
    pair = await makePeerPair('forced-checkout');
    initBothRepos(pair.peer, pair.ours);
    repo = undefined;
  });

  afterEach(async () => {
    await repo?.dispose();
    await pair.dispose();
  });

  describe.each(SPELLINGS)('Given the spelling $name', (spelling) => {
    describe.each(Object.entries(WORK_TREE_SHAPES))(
      'And the work tree shape %s over a settled index',
      (_name, shape) => {
        describe('When git and tsgit force the checkout', () => {
          it('Then the work tree, the index, its flags and the stale and rewritten sets match git', async () => {
            // Arrange
            for (const dir of [pair.peer, pair.ours]) {
              buildHistory(dir, [...shape.tracked, regular('other')], shape.tracked);
              git(dir, 'tag', TAG, 't');
              if (spelling.detachFirst) git(dir, 'checkout', '-q', '--detach');
              settleIndex(dir);
              shape.plant(dir);
            }
            repo = await openRepository({ cwd: pair.ours });
            const peerBefore = statSnapshot(pair.peer);
            const oursBefore = statSnapshot(pair.ours);

            // Act
            git(pair.peer, 'checkout', '-q', '-f', spelling.resolve(pair.peer));
            await repo.checkout({ rev: spelling.resolve(pair.ours), force: true });

            // Assert
            expect(observe(pair.ours, oursBefore)).toEqual(observe(pair.peer, peerBefore));
            if (spelling.comparesHead) expect(headState(pair.ours)).toEqual(headState(pair.peer));
          });
        });
      },
    );
  });

  describe('Given a tracked a/payload and a work tree holding a symlink a to an outside directory', () => {
    describe('When git and tsgit force the checkout of HEAD', () => {
      it('Then a becomes a directory holding payload and the outside directory stays empty', async () => {
        // Arrange
        const outsides = {
          peer: await mkdtemp(path.join(os.tmpdir(), 'tsgit-forced-outside-peer-')),
          ours: await mkdtemp(path.join(os.tmpdir(), 'tsgit-forced-outside-ours-')),
        };
        try {
          for (const [dir, outside] of [
            [pair.peer, outsides.peer],
            [pair.ours, outsides.ours],
          ] as const) {
            buildHistory(dir, [regular('a/payload'), regular('other')], [regular('a/payload')]);
            settleIndex(dir);
            rmSync(path.join(dir, 'a'), { recursive: true });
            symlinkSync(outside, path.join(dir, 'a'));
          }
          repo = await openRepository({ cwd: pair.ours });
          const peerBefore = statSnapshot(pair.peer);
          const oursBefore = statSnapshot(pair.ours);

          // Act
          git(pair.peer, 'checkout', '-q', '-f', 'main');
          await repo.checkout({ rev: 'main', force: true });

          // Assert
          expect(observe(pair.ours, oursBefore)).toEqual(observe(pair.peer, peerBefore));
          expect(readdirSync(outsides.ours)).toEqual(readdirSync(outsides.peer));
        } finally {
          await rm(outsides.peer, { recursive: true, force: true });
          await rm(outsides.ours, { recursive: true, force: true });
        }
      });
    });
  });
});
