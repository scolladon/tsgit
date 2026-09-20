/**
 * Cross-tool interop — `branch -d`'s safety valve measured through annotated
 * tag chains. git never compares raw ref values: `check_branch_commit` runs
 * the branch tip through `lookup_commit_reference` and `branch_merged` runs
 * the reference side (the configured upstream, else HEAD) through the same
 * lookup, so either side standing on an annotated tag is measured at the
 * commit that tag names. A TIP that names no commit is the type refusal, not
 * the not-fully-merged one, and force skips only the second of those; a
 * REFERENCE that names no commit is not a refusal at all — an upstream hands
 * the decision on to HEAD, and a HEAD that names none leaves nothing merged.
 *
 * `update-ref` types what it writes into `refs/heads/*` and refuses a
 * non-commit outright, so the rows carrying a tag or a tree as a branch value
 * write the ref file directly — identically on both twins, read back through
 * git before the act — exactly as a hand-edited or foreign repository
 * presents it. Every row builds its own pair of repositories on a pinned
 * clock, which makes the two byte-identical, runs canonical git as the oracle
 * and tsgit's `branchDelete` as the subject, and compares exit code, the
 * `error:` lines git prints against the refusal data tsgit throws, and the
 * ref state both tools leave behind.
 *
 * @proves
 *   surface:        branch.delete
 *   bucket:         cross-tool-interop
 *   unique:         branch.delete peels both sides of the merge check through
 *                    annotated tags and refuses a non-commit tip on its type
 *                    rather than on the merge
 *   interopSurface: branch
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { branchDelete } from '../../src/application/commands/branch.js';
import { TsgitError } from '../../src/domain/error.js';
import { openRepository } from '../../src/index.node.js';
import {
  disableAutoMaintenance,
  GIT_AVAILABLE,
  git,
  runGit,
  runGitEnv,
  tryRunGitWithExit,
} from './interop-helpers.js';

const ROW_TIMEOUT = 60_000;

const TOPIC = 'refs/heads/topic';
const MAIN = 'refs/heads/main';
const UPSTREAM = 'refs/heads/up';

/** Author, committer and tagger stamp, so the two twins of a row hash to the
 *  same objects and a planted value can be compared across them. */
const PINNED_CLOCK = '1700000000 +0000';
const IDENTITY = 'Ada <ada@example.com>';

const PINNED_ENV: NodeJS.ProcessEnv = {
  ...runGitEnv(),
  GIT_AUTHOR_DATE: PINNED_CLOCK,
  GIT_COMMITTER_DATE: PINNED_CLOCK,
};

/** git's `error: object <oid> is a <type>, not a commit` — printed by the
 *  lookup itself, so it precedes whatever the caller decides. */
const typeLine = (oid: string, type: string): string =>
  `error: object ${oid} is a ${type}, not a commit\n`;

/** git's refusal once a TIP fails that lookup and `-d` was not forced. */
const noCommitLine = (ref: string): string =>
  `error: couldn't look up commit object for '${ref}'\n`;

/** git's unforced refusal when the tip is a commit the reference misses. */
const unmergedLine = (branch: string): string =>
  `error: the branch '${branch}' is not fully merged\n`;

/** `branch` with git's delete advice silenced, so the hint lines it would
 *  otherwise append never enter the comparison. */
const runBranch = (dir: string, ...args: ReadonlyArray<string>) =>
  tryRunGitWithExit(['-C', dir, '-c', 'advice.forceDeleteBranch=false', 'branch', ...args]);

interface Fixture {
  readonly dir: string;
  /** The first commit — contained by `head`. */
  readonly root: string;
  /** The commit `refs/heads/main`, and so HEAD, stands on. */
  readonly head: string;
  /** A sibling of `head` over `root` — contained by neither. */
  readonly side: string;
  /** The empty tree both commits carry. */
  readonly tree: string;
}

interface Twins {
  /** The repository canonical git acts on. */
  readonly peer: Fixture;
  /** The repository tsgit acts on. */
  readonly ours: Fixture;
}

describe.skipIf(!GIT_AVAILABLE)('branch delete — commit-reference peeling interop', () => {
  const caseRoots: string[] = [];

  /** One repository per twin: rows delete refs and plant values `update-ref`
   *  would refuse, so no two of them may share a checkout — nor a repository
   *  facade, whose session cache would outlive the tree it was opened on. */
  const caseRepo = async (slug: string): Promise<Fixture> => {
    const root = await mkdtemp(path.join(os.tmpdir(), `tsgit-branch-peel-${slug}-`));
    caseRoots.push(root);
    const dir = path.join(root, 'repo');
    runGit(['init', '-q', '-b', 'main', dir]);
    git(dir, 'config', 'user.name', 'Ada');
    git(dir, 'config', 'user.email', 'ada@example.com');
    disableAutoMaintenance(dir);
    runGit(['-C', dir, 'commit', '-q', '--allow-empty', '-m', 'root'], { env: PINNED_ENV });
    const first = git(dir, 'rev-parse', 'HEAD').trim();
    runGit(['-C', dir, 'commit', '-q', '--allow-empty', '-m', 'head'], { env: PINNED_ENV });
    const head = git(dir, 'rev-parse', 'HEAD').trim();
    const tree = git(dir, 'rev-parse', 'HEAD^{tree}').trim();
    const side = runGit(['-C', dir, 'commit-tree', tree, '-p', first, '-m', 'side'], {
      env: PINNED_ENV,
    }).trim();
    return { dir, root: first, head, side, tree };
  };

  /** Points `ref` at `oid` by writing the ref file, below the typing gate
   *  `update-ref` enforces on `refs/heads/*`. */
  const plantRef = (fixture: Fixture, ref: string, oid: string): Promise<void> =>
    writeFile(path.join(fixture.dir, '.git', ...ref.split('/')), `${oid}\n`);

  /** An annotated tag over `target`, left unreferenced by any branch. */
  const annotatedTag = (fixture: Fixture, target: string, name: string): string => {
    runGit(['-C', fixture.dir, 'tag', '-a', '-m', name, name, target], { env: PINNED_ENV });
    return git(fixture.dir, 'rev-parse', `refs/tags/${name}`).trim();
  };

  /** An annotated tag whose own target is an annotated tag. */
  const tagOverTag = (fixture: Fixture, inner: string, name: string): string =>
    runGit(['-C', fixture.dir, 'mktag'], {
      input: `object ${inner}\ntype tag\ntag ${name}\ntagger ${IDENTITY} ${PINNED_CLOCK}\n\n${name}\n`,
    }).trim();

  /** Configures `topic` to track `up` through git's pseudo-remote for this
   *  repository, which takes the merge ref verbatim. */
  const trackLocally = (fixture: Fixture, upstream: string): void => {
    git(fixture.dir, 'config', 'branch.topic.remote', '.');
    git(fixture.dir, 'config', 'branch.topic.merge', upstream);
  };

  /** Both twins of one row, seeded by the same steps in the same order. */
  const twins = async (slug: string, seed: (fixture: Fixture) => Promise<void>): Promise<Twins> => {
    const peer = await caseRepo(`${slug}-peer`);
    const ours = await caseRepo(slug);
    await seed(peer);
    await seed(ours);
    return { peer, ours };
  };

  /** The raw value `ref` holds, read back through git rather than the file,
   *  so a planted value is confirmed the way the oracle itself sees it. */
  const refValue = (fixture: Fixture, ref: string): string =>
    git(fixture.dir, 'rev-parse', ref).trim();

  /** Asserts both twins really carry `oid` at `ref` before either tool runs. */
  const expectPlanted = (pair: Twins, ref: string, oid: string): void => {
    expect(refValue(pair.peer, ref)).toBe(oid);
    expect(refValue(pair.ours, ref)).toBe(oid);
  };

  /** Whether `ref` still names something, read back through git itself. */
  const survives = (fixture: Fixture, ref: string): boolean =>
    tryRunGitWithExit(['-C', fixture.dir, 'show-ref', '--verify', ref]).exitCode === 0;

  const expectBothRemoved = (pair: Twins, ref: string): void => {
    expect(survives(pair.peer, ref)).toBe(false);
    expect(survives(pair.ours, ref)).toBe(false);
  };

  const expectBothSurvive = (pair: Twins, ref: string): void => {
    expect(survives(pair.peer, ref)).toBe(true);
    expect(survives(pair.ours, ref)).toBe(true);
  };

  /** tsgit's delete, run through the facade so it sees the same repository
   *  layout git discovers from the same directory. */
  const deleteWithTsgit = async (
    fixture: Fixture,
    input: { readonly name: string; readonly force?: boolean },
  ): Promise<{ readonly result?: unknown; readonly error?: TsgitError }> => {
    const sut = branchDelete;
    const repo = await openRepository({ cwd: fixture.dir });
    try {
      return { result: await sut(repo.ctx, input) };
    } catch (caught) {
      expect(caught).toBeInstanceOf(TsgitError);
      return { error: caught as TsgitError };
    } finally {
      await repo.dispose();
    }
  };

  afterAll(async () => {
    await Promise.all(
      caseRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  describe('Given a branch standing on an annotated tag whose commit HEAD contains', () => {
    describe('When git branch -d and tsgit branchDelete both target it', () => {
      it(
        'Then both delete it, measuring the commit the tag names',
        async () => {
          // Arrange
          const tags: string[] = [];
          const pair = await twins('tag-merged', async (fixture) => {
            const tag = annotatedTag(fixture, fixture.root, 'merged');
            tags.push(tag);
            await plantRef(fixture, TOPIC, tag);
          });
          expectPlanted(pair, TOPIC, tags[0] as string);

          // Act
          const gitResult = runBranch(pair.peer.dir, '-d', 'topic');
          const { error } = await deleteWithTsgit(pair.ours, { name: 'topic' });

          // Assert
          expect(gitResult.exitCode).toBe(0);
          expect(gitResult.stderr).toBe('');
          expect(error).toBeUndefined();
          expectBothRemoved(pair, TOPIC);
        },
        ROW_TIMEOUT,
      );
    });
  });

  describe('Given a branch standing on an annotated tag whose commit HEAD does not contain', () => {
    describe('When git branch -d and tsgit branchDelete both target it', () => {
      it(
        'Then both refuse it as not fully merged and the branch survives',
        async () => {
          // Arrange
          const pair = await twins('tag-unmerged', async (fixture) => {
            await plantRef(fixture, TOPIC, annotatedTag(fixture, fixture.side, 'unmerged'));
          });

          // Act
          const gitResult = runBranch(pair.peer.dir, '-d', 'topic');
          const { error } = await deleteWithTsgit(pair.ours, { name: 'topic' });

          // Assert
          expect(gitResult.exitCode).toBe(1);
          expect(gitResult.stderr).toBe(unmergedLine('topic'));
          expect(error?.data).toEqual({ code: 'BRANCH_NOT_FULLY_MERGED', name: TOPIC });
          expectBothSurvive(pair, TOPIC);
        },
        ROW_TIMEOUT,
      );
    });
  });

  describe('Given a branch standing on a tag over a tag whose commit HEAD contains', () => {
    describe('When git branch -d and tsgit branchDelete both target it', () => {
      it(
        'Then both walk the whole chain and delete it',
        async () => {
          // Arrange
          const pair = await twins('tag-over-tag', async (fixture) => {
            const inner = annotatedTag(fixture, fixture.root, 'inner');
            await plantRef(fixture, TOPIC, tagOverTag(fixture, inner, 'outer'));
          });

          // Act
          const gitResult = runBranch(pair.peer.dir, '-d', 'topic');
          const { error } = await deleteWithTsgit(pair.ours, { name: 'topic' });

          // Assert
          expect(gitResult.exitCode).toBe(0);
          expect(gitResult.stderr).toBe('');
          expect(error).toBeUndefined();
          expectBothRemoved(pair, TOPIC);
        },
        ROW_TIMEOUT,
      );
    });
  });

  describe('Given a branch standing on a tree', () => {
    describe('When git branch -d and tsgit branchDelete both target it', () => {
      it(
        'Then both refuse on the object type rather than on the merge',
        async () => {
          // Arrange
          const pair = await twins('tree-tip', (fixture) => plantRef(fixture, TOPIC, fixture.tree));
          expectPlanted(pair, TOPIC, pair.ours.tree);

          // Act
          const gitResult = runBranch(pair.peer.dir, '-d', 'topic');
          const { error } = await deleteWithTsgit(pair.ours, { name: 'topic' });

          // Assert
          expect(gitResult.exitCode).toBe(1);
          expect(gitResult.stderr).toBe(typeLine(pair.peer.tree, 'tree') + noCommitLine(TOPIC));
          expect(error?.data).toEqual({
            code: 'UNEXPECTED_OBJECT_TYPE',
            expected: 'commit',
            actual: 'tree',
            id: pair.ours.tree,
          });
          expectBothSurvive(pair, TOPIC);
        },
        ROW_TIMEOUT,
      );
    });

    describe('When git branch -D and tsgit branchDelete with force both target it', () => {
      it(
        'Then both delete it, the failed lookup deciding nothing',
        async () => {
          // Arrange
          const pair = await twins('tree-tip-forced', (fixture) =>
            plantRef(fixture, TOPIC, fixture.tree),
          );
          expectPlanted(pair, TOPIC, pair.ours.tree);

          // Act
          const gitResult = runBranch(pair.peer.dir, '-D', 'topic');
          const { error } = await deleteWithTsgit(pair.ours, { name: 'topic', force: true });

          // Assert
          expect(gitResult.exitCode).toBe(0);
          expect(gitResult.stderr).toBe(typeLine(pair.peer.tree, 'tree'));
          expect(error).toBeUndefined();
          expectBothRemoved(pair, TOPIC);
        },
        ROW_TIMEOUT,
      );
    });
  });

  describe('Given a configured upstream standing on a tree', () => {
    describe('When git branch -d and tsgit branchDelete both target the branch tracking it', () => {
      it(
        'Then both fall back to HEAD and delete it',
        async () => {
          // Arrange
          const pair = await twins('upstream-tree', async (fixture) => {
            await plantRef(fixture, TOPIC, fixture.root);
            await plantRef(fixture, UPSTREAM, fixture.tree);
            trackLocally(fixture, UPSTREAM);
          });
          expectPlanted(pair, UPSTREAM, pair.ours.tree);

          // Act
          const gitResult = runBranch(pair.peer.dir, '-d', 'topic');
          const { error } = await deleteWithTsgit(pair.ours, { name: 'topic' });

          // Assert
          expect(gitResult.exitCode).toBe(0);
          expect(gitResult.stderr).toBe(typeLine(pair.peer.tree, 'tree'));
          expect(error).toBeUndefined();
          expectBothRemoved(pair, TOPIC);
        },
        ROW_TIMEOUT,
      );
    });
  });

  describe("Given a configured upstream standing on an annotated tag over HEAD's commit", () => {
    describe('When git branch -d and tsgit branchDelete both target the branch tracking it', () => {
      it(
        'Then both peel the upstream tag and delete it',
        async () => {
          // Arrange
          const tags: string[] = [];
          const pair = await twins('upstream-tag', async (fixture) => {
            await plantRef(fixture, TOPIC, fixture.root);
            const tag = annotatedTag(fixture, fixture.head, 'upstream');
            tags.push(tag);
            await plantRef(fixture, UPSTREAM, tag);
            trackLocally(fixture, UPSTREAM);
          });
          expectPlanted(pair, UPSTREAM, tags[0] as string);

          // Act
          const gitResult = runBranch(pair.peer.dir, '-d', 'topic');
          const { error } = await deleteWithTsgit(pair.ours, { name: 'topic' });

          // Assert
          expect(gitResult.exitCode).toBe(0);
          expect(gitResult.stderr).toBe('');
          expect(error).toBeUndefined();
          expectBothRemoved(pair, TOPIC);
        },
        ROW_TIMEOUT,
      );
    });
  });

  describe("Given HEAD's own branch standing on a tree and no configured upstream", () => {
    describe('When git branch -d and tsgit branchDelete both target a branch that commit stands behind', () => {
      it(
        'Then nothing counts as merged and both refuse it as not fully merged',
        async () => {
          // Arrange
          const pair = await twins('head-tree', async (fixture) => {
            await plantRef(fixture, TOPIC, fixture.root);
            await plantRef(fixture, MAIN, fixture.tree);
          });
          expectPlanted(pair, MAIN, pair.ours.tree);

          // Act
          const gitResult = runBranch(pair.peer.dir, '-d', 'topic');
          const { error } = await deleteWithTsgit(pair.ours, { name: 'topic' });

          // Assert
          expect(gitResult.exitCode).toBe(1);
          expect(gitResult.stderr).toBe(typeLine(pair.peer.tree, 'tree') + unmergedLine('topic'));
          expect(error?.data).toEqual({ code: 'BRANCH_NOT_FULLY_MERGED', name: TOPIC });
          expectBothSurvive(pair, TOPIC);
        },
        ROW_TIMEOUT,
      );
    });
  });
});
