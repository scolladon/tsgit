/**
 * Cross-tool interop — git matches stat data by whole seconds and judges an entry racy by
 * whole seconds: an index write smudges (size 0) a carried-over entry edited in place, in the
 * second its index was written, and leaves an entry whose content is unchanged alone.
 *
 * @proves
 *   surface:        add
 *   bucket:         cross-tool-interop
 *   unique:         the racily-clean smudge of an index write judges stat data and racy entries by whole seconds as git does
 *   interopSurface: add
 */
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  symlink,
  truncate,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/index.js';
import { add } from '../../src/application/commands/add.js';
import { checkout } from '../../src/application/commands/checkout.js';
import { reset } from '../../src/application/commands/reset.js';
import { sparseCheckoutSet } from '../../src/application/commands/sparse-checkout.js';
import { status } from '../../src/application/commands/status.js';
import type { TsgitError } from '../../src/domain/error.js';
import { GIT_AVAILABLE, git, initBothRepos, makePeerPair } from './interop-helpers.js';

const SECOND_START_OFFSET_MS = 50;
const MAX_FIXTURE_ATTEMPTS = 5;
const SHAPE_STEP_MS = 100;
const SETTLE_GAP_SECONDS = 2n;
const PAST_SECOND_MS = 1_100;
const MS_PER_SECOND = 1_000;
const NS_PER_SECOND = 1_000_000_000n;
const GROUP_WRITABLE_MODE = 0o664;
const SMUDGED_SIZE = 0;
const UNSTAGED_MODIFIED_F = /^.M f$/;
const LINK_TARGET = 'held';
const WORK_FILE_MODE_MASK = 0o7777n;
const STAMP_PATTERN = /(?:ctime|mtime): (\d+):(\d+)/;

class FixturePremiseError extends Error {
  override readonly name = 'FixturePremiseError';
}

const premiseNeverMet = (shape: string): FixturePremiseError =>
  new FixturePremiseError(`${shape}: premise not met in ${MAX_FIXTURE_ATTEMPTS} attempts`);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const toNextSecondStart = async (): Promise<void> => {
  const intoSecond = Date.now() % MS_PER_SECOND;
  await sleep(MS_PER_SECOND - intoSecond + SECOND_START_OFFSET_MS);
};

const put = (repo: string, name: string, content: string): Promise<void> =>
  writeFile(path.join(repo, name), content);

const seed = async (repo: string, ignorecase: string): Promise<void> => {
  git(repo, 'config', 'core.ignorecase', ignorecase);
  git(repo, 'config', 'commit.gpgsign', 'false');
  await put(repo, 'f', 'one\n');
  git(repo, 'add', 'f');
  git(repo, 'commit', '-q', '-m', 'base');
  git(repo, 'branch', 'other');
  git(repo, 'checkout', '-q', 'other');
  await put(repo, 'g', 'g\n');
  git(repo, 'add', 'g');
  git(repo, 'commit', '-q', '-m', 'other');
  git(repo, 'checkout', '-q', 'main');
};

/** git's own view of an index entry's stat data, one trimmed line per field group. */
const entryDebug = (repo: string, file: string): ReadonlyArray<string> =>
  git(repo, 'ls-files', '--debug', '--', file)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');

const debugSize = (repo: string, file: string): number => {
  const sizeLine = entryDebug(repo, file).find((line) => line.startsWith('size:'));
  return Number(/^size: (\d+)/.exec(sizeLine ?? '')?.[1]);
};

interface Stamp {
  readonly seconds: bigint;
  readonly nanoseconds: bigint;
}

const entryStamp = (repo: string, file: string, field: 'ctime' | 'mtime'): Stamp => {
  const line = entryDebug(repo, file).find((candidate) => candidate.startsWith(`${field}:`));
  const [, seconds, nanoseconds] = STAMP_PATTERN.exec(line ?? '') ?? [];
  return { seconds: BigInt(seconds ?? -1), nanoseconds: BigInt(nanoseconds ?? -1) };
};

const indexMtime = async (repo: string): Promise<Stamp> => {
  const { mtimeNs } = await lstat(path.join(repo, '.git', 'index'), { bigint: true });
  return { seconds: mtimeNs / NS_PER_SECOND, nanoseconds: mtimeNs % NS_PER_SECOND };
};

/** Same bytes, staged then edited in place within the second the index was written. */
const sameSecondSameSizeEdit = async (repo: string): Promise<void> => {
  for (let attempt = 0; attempt < MAX_FIXTURE_ATTEMPTS; attempt += 1) {
    await toNextSecondStart();
    await put(repo, 'f', 'abc\n');
    await sleep(SHAPE_STEP_MS);
    git(repo, 'add', 'f');
    await sleep(SHAPE_STEP_MS);
    await put(repo, 'f', 'xyz\n');
    const entry = entryStamp(repo, 'f', 'mtime');
    const index = await indexMtime(repo);
    if (entry.seconds === index.seconds && entry.nanoseconds < index.nanoseconds) return;
  }
  throw premiseNeverMet('same-second same-size edit');
};

/** Content staged unchanged, then chmod-ed in the same second: only the ctime moves. */
const sameSecondChmod = async (repo: string, file = 'f'): Promise<void> => {
  for (let attempt = 0; attempt < MAX_FIXTURE_ATTEMPTS; attempt += 1) {
    await toNextSecondStart();
    await mkdir(path.dirname(path.join(repo, file)), { recursive: true });
    await put(repo, file, 'one\n');
    git(repo, 'add', file);
    await sleep(SHAPE_STEP_MS);
    await chmod(path.join(repo, file), GROUP_WRITABLE_MODE);
    const worked = await lstat(path.join(repo, file), { bigint: true });
    const recorded = entryStamp(repo, file, 'ctime');
    const index = await indexMtime(repo);
    const sameCtimeSecond = worked.ctimeNs / NS_PER_SECOND === recorded.seconds;
    const ctimeMoved = worked.ctimeNs % NS_PER_SECOND !== recorded.nanoseconds;
    const inIndexSecond = entryStamp(repo, file, 'mtime').seconds === index.seconds;
    if (sameCtimeSecond && ctimeMoved && inIndexSecond) return;
  }
  throw premiseNeverMet('same-second chmod');
};

/** Sets the index file's own mtime (never a work file's, whose ctime it would move). */
const armIndexTime = (repo: string, seconds: bigint): Promise<void> =>
  utimes(path.join(repo, '.git', 'index'), Number(seconds), Number(seconds));

/** The index second the entry's mtime second has left behind: the entry is no longer racy. */
const settleIndexTime = (repo: string): Promise<void> =>
  armIndexTime(repo, entryStamp(repo, 'f', 'mtime').seconds + SETTLE_GAP_SECONDS);

/** A same-size, different-content file renamed over `f`: a new inode under the entry's mtime. */
const sameSizeEditNewInode = async (repo: string): Promise<void> => {
  await sleep(PAST_SECOND_MS);
  git(repo, 'update-index', '-q', '--really-refresh');
  await settleIndexTime(repo);
  const file = path.join(repo, 'f');
  const before = await lstat(file, { bigint: true });
  const sibling = path.join(repo, 'f.sibling');
  await put(repo, 'f.sibling', 'two\n');
  await utimes(sibling, before.atime, before.mtime);
  await rename(sibling, file);
  const after = await lstat(file, { bigint: true });
  const sameSecond = after.mtimeNs / NS_PER_SECOND === entryStamp(repo, 'f', 'mtime').seconds;
  if (after.ino !== before.ino && sameSecond) return;
  throw premiseNeverMet('same-size edit on a new inode');
};

/** Index written a second later by git itself, then a chmod a second after that: only the ctime second moved. */
const chmodSecondsLater = async (repo: string, file = 'f'): Promise<void> => {
  await sleep(PAST_SECOND_MS);
  git(repo, 'status', '--porcelain');
  await sleep(PAST_SECOND_MS);
  await chmod(path.join(repo, file), GROUP_WRITABLE_MODE);
  const worked = await lstat(path.join(repo, file), { bigint: true });
  if (worked.ctimeNs / NS_PER_SECOND > entryStamp(repo, file, 'ctime').seconds) return;
  throw premiseNeverMet('chmod a second later');
};

/** A smudged entry whose file is emptied in place, then left behind by a later index write. */
const smudgedTruncation = async (repo: string): Promise<void> => {
  for (let attempt = 0; attempt < MAX_FIXTURE_ATTEMPTS; attempt += 1) {
    await toNextSecondStart();
    await put(repo, 'f', 'abc\n');
    git(repo, 'add', 'f');
    await put(repo, 'f', 'xyz\n');
    await put(repo, 'g', 'g\n');
    git(repo, 'update-index', '--add', 'g');
    await truncate(path.join(repo, 'f'), 0);
    const emptiedInEntrySecond = await isEmptiedInEntrySecond(repo);
    await toNextSecondStart();
    await put(repo, 'h', 'h\n');
    git(repo, 'update-index', '--add', 'h');
    const index = await indexMtime(repo);
    const laterIndex = index.seconds > entryStamp(repo, 'f', 'mtime').seconds;
    if (emptiedInEntrySecond && laterIndex && debugSize(repo, 'f') === SMUDGED_SIZE) {
      await toNextSecondStart();
      return;
    }
  }
  throw premiseNeverMet('smudged truncation');
};

const staleSameSizeEdit = async (repo: string): Promise<void> => {
  await sameSecondSameSizeEdit(repo);
  await sleep(PAST_SECOND_MS);
};

const isEmptiedInEntrySecond = async (repo: string): Promise<boolean> => {
  const worked = await lstat(path.join(repo, 'f'), { bigint: true });
  const smudged = debugSize(repo, 'f') === SMUDGED_SIZE;
  return smudged && worked.mtimeNs / NS_PER_SECOND === entryStamp(repo, 'f', 'mtime').seconds;
};

const gitReportsModified = (repo: string): boolean =>
  git(repo, 'status', '--porcelain')
    .split('\n')
    .some((line) => UNSTAGED_MODIFIED_F.test(line));

const tsgitReportsModified = async (repo: string): Promise<boolean> => {
  const result = await status(createNodeContext({ workDir: repo }));
  return result.changes.find((change) => change.path === 'f')?.unstaged === 'modified';
};

const gitAddsUnrelatedPath = async (repo: string): Promise<void> => {
  await put(repo, 'g', 'g\n');
  git(repo, 'add', 'g');
};

const tsgitAddsUnrelatedPath = async (repo: string): Promise<void> => {
  await put(repo, 'g', 'g\n');
  await add(createNodeContext({ workDir: repo }), ['g']);
};

interface WorkFile {
  readonly inode: bigint;
  readonly mode: bigint;
  readonly ctimeNs: bigint;
}

const workFileOf = async (repo: string): Promise<WorkFile> => {
  const { ino, mode, ctimeNs } = await lstat(path.join(repo, 'f'), { bigint: true });
  return { inode: ino, mode: mode & WORK_FILE_MODE_MASK, ctimeNs };
};

/** One way of asking each tool to bring `f` in line with what it holds, with the git twin first. */
interface Act {
  readonly git: (repo: string) => void;
  readonly tsgit: (repo: string) => Promise<unknown>;
}

const ctxOf = (repo: string) => createNodeContext({ workDir: repo });

const checkoutPath: Act = {
  git: (repo) => git(repo, 'checkout', '--', 'f'),
  tsgit: (repo) => checkout(ctxOf(repo), { paths: ['f'] }),
};

const forcedSwitch: Act = {
  git: (repo) => git(repo, 'checkout', '-q', '-f', 'other'),
  tsgit: (repo) => checkout(ctxOf(repo), { rev: 'other', force: true }),
};

const plainSwitch: Act = {
  git: (repo) => git(repo, 'checkout', '-q', 'other'),
  tsgit: (repo) => checkout(ctxOf(repo), { rev: 'other' }),
};

const hardReset: Act = {
  git: (repo) => git(repo, 'reset', '-q', '--hard', 'HEAD'),
  tsgit: (repo) => reset(ctxOf(repo), { mode: 'hard', rev: 'HEAD' }),
};

const actOnBoth = async (act: Act, peer: string, ours: string): Promise<void> => {
  act.git(peer);
  await act.tsgit(ours);
};

interface Switch {
  readonly refused: boolean;
  readonly head: string;
}

const switchOutcome = async (repo: string, run: () => unknown): Promise<Switch> => {
  let refused = false;
  try {
    await run();
  } catch {
    refused = true;
  }
  return { refused, head: git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim() };
};

const workTreeNames = async (repo: string): Promise<ReadonlyArray<string>> =>
  (await readdir(repo)).filter((name) => name !== '.git').sort();

/** A tracked file reached through a symlinked directory, its stat moved within its second. */
const chmodBeneathLink = async (repo: string): Promise<void> => {
  for (let attempt = 0; attempt < MAX_FIXTURE_ATTEMPTS; attempt += 1) {
    await toNextSecondStart();
    await put(repo, 'd/x', 'one\n');
    git(repo, 'add', 'd/x');
    await sleep(SHAPE_STEP_MS);
    await rename(path.join(repo, 'd'), path.join(repo, LINK_TARGET));
    await symlink(LINK_TARGET, path.join(repo, 'd'));
    const reached = path.join(repo, LINK_TARGET, 'x');
    await chmod(reached, GROUP_WRITABLE_MODE);
    const worked = await lstat(reached, { bigint: true });
    const recorded = entryStamp(repo, 'd/x', 'ctime');
    const index = await indexMtime(repo);
    const sameCtimeSecond = worked.ctimeNs / NS_PER_SECOND === recorded.seconds;
    const ctimeMoved = worked.ctimeNs % NS_PER_SECOND !== recorded.nanoseconds;
    const inIndexSecond = entryStamp(repo, 'd/x', 'mtime').seconds === index.seconds;
    if (sameCtimeSecond && ctimeMoved && inIndexSecond) return;
    await unlink(path.join(repo, 'd'));
    await rename(path.join(repo, LINK_TARGET), path.join(repo, 'd'));
  }
  throw premiseNeverMet('chmod beneath a symlinked directory');
};

/** `f` committed, then a branch `tgt` that holds `dir/x`, back on main. */
const seedDirectoryTarget = async (repo: string, ignorecase: string): Promise<void> => {
  git(repo, 'config', 'core.ignorecase', ignorecase);
  git(repo, 'config', 'commit.gpgsign', 'false');
  await put(repo, 'f', 'f\n');
  git(repo, 'add', 'f');
  git(repo, 'commit', '-q', '-m', 'base');
  git(repo, 'checkout', '-q', '-b', 'tgt');
  await mkdir(path.join(repo, 'dir'));
  await put(repo, 'dir/x', 'x\n');
  git(repo, 'add', 'dir/x');
  git(repo, 'commit', '-q', '-m', 'tgt');
  git(repo, 'checkout', '-q', 'main');
};

type StagedFileArrange = (repo: string) => Promise<void>;

/** A file staged at `dir` whose stat then moved within the second of its add. */
const stageFileMovedInItsSecond: StagedFileArrange = (repo) => sameSecondChmod(repo, 'dir');

/** A file staged at `dir`, chmod-ed a second later while the config tells git to ignore ctime. */
const stageFileMovedLaterCtimeIgnored: StagedFileArrange = async (repo) => {
  git(repo, 'config', 'core.trustCtime', 'false');
  await put(repo, 'dir', 'one\n');
  git(repo, 'add', 'dir');
  await chmodSecondsLater(repo, 'dir');
};

/** `a/f` and `b/h` committed on main. */
const seedTwoDirectories = async (repo: string, ignorecase: string): Promise<void> => {
  git(repo, 'config', 'core.ignorecase', ignorecase);
  git(repo, 'config', 'commit.gpgsign', 'false');
  await mkdir(path.join(repo, 'a'));
  await mkdir(path.join(repo, 'b'));
  await put(repo, 'a/f', 'one\n');
  await put(repo, 'b/h', 'h\n');
  git(repo, 'add', 'a/f', 'b/h');
  git(repo, 'commit', '-q', '-m', 'base');
};

const tsgitSwitchError = async (repo: string, rev: string): Promise<TsgitError | undefined> => {
  try {
    await checkout(ctxOf(repo), { rev });
    return undefined;
  } catch (error) {
    return error as TsgitError;
  }
};

const seedBeneathLink = async (repo: string, ignorecase: string): Promise<void> => {
  git(repo, 'config', 'core.ignorecase', ignorecase);
  git(repo, 'config', 'commit.gpgsign', 'false');
  await mkdir(path.join(repo, 'd'));
  await put(repo, 'd/x', 'one\n');
  git(repo, 'add', 'd/x');
  git(repo, 'commit', '-q', '-m', 'base');
  git(repo, 'branch', 'other');
  git(repo, 'checkout', '-q', 'other');
  await put(repo, 'd/x', 'two\n');
  git(repo, 'commit', '-q', '-a', '-m', 'other');
  git(repo, 'checkout', '-q', 'main');
};

describe.skipIf(!GIT_AVAILABLE || process.platform === 'win32')(
  'whole-second stat match against git',
  () => {
    describe.each(['false', 'true'])('Given core.ignorecase is %s', (ignorecase) => {
      describe('When an unrelated path is added in the second of a same-size edit', () => {
        it('Then both tools smudge the edited entry to size 0', async () => {
          // Arrange
          const pair = await makePeerPair('whole-second-smudge');
          try {
            initBothRepos(pair.peer, pair.ours);
            for (const repo of [pair.peer, pair.ours]) {
              await seed(repo, ignorecase);
              await sameSecondSameSizeEdit(repo);
            }

            // Act
            await gitAddsUnrelatedPath(pair.peer);
            await tsgitAddsUnrelatedPath(pair.ours);

            // Assert
            expect(debugSize(pair.peer, 'f')).toBe(SMUDGED_SIZE);
            expect(debugSize(pair.ours, 'f')).toBe(SMUDGED_SIZE);
          } finally {
            await pair.dispose();
          }
        });
      });

      describe('When an unrelated path is added after a same-second chmod of unchanged content', () => {
        it('Then neither tool smudges the entry', async () => {
          // Arrange
          const pair = await makePeerPair('whole-second-chmod');
          try {
            initBothRepos(pair.peer, pair.ours);
            for (const repo of [pair.peer, pair.ours]) {
              await seed(repo, ignorecase);
              await sameSecondChmod(repo);
            }
            const sizeBefore = debugSize(pair.peer, 'f');

            // Act
            await gitAddsUnrelatedPath(pair.peer);
            await tsgitAddsUnrelatedPath(pair.ours);

            // Assert
            expect(debugSize(pair.peer, 'f')).toBe(sizeBefore);
            expect(debugSize(pair.ours, 'f')).toBe(sizeBefore);
          } finally {
            await pair.dispose();
          }
        });
      });

      describe('When status runs under core.checkStat minimal after a same-size edit that changed only the inode', () => {
        it('Then both tools report the file clean', async () => {
          // Arrange
          const pair = await makePeerPair('whole-second-minimal-inode');
          try {
            initBothRepos(pair.peer, pair.ours);
            for (const repo of [pair.peer, pair.ours]) {
              await seed(repo, ignorecase);
              git(repo, 'config', 'core.checkStat', 'minimal');
              await sameSizeEditNewInode(repo);
            }

            // Act
            const gitModified = gitReportsModified(pair.peer);
            const tsgitModified = await tsgitReportsModified(pair.ours);

            // Assert
            expect(gitModified).toBe(false);
            expect(tsgitModified).toBe(false);
          } finally {
            await pair.dispose();
          }
        });
      });

      describe('When a file whose mode changed in the index second is added again with the index settled', () => {
        it('Then both tools keep its recorded stat', async () => {
          // Arrange
          const pair = await makePeerPair('whole-second-readd-chmod');
          try {
            initBothRepos(pair.peer, pair.ours);
            for (const repo of [pair.peer, pair.ours]) {
              await seed(repo, ignorecase);
              await sameSecondChmod(repo);
              await settleIndexTime(repo);
            }
            const recorded = entryDebug(pair.peer, 'f');
            const recordedByTsgit = entryDebug(pair.ours, 'f');

            // Act
            git(pair.peer, 'add', 'f');
            await add(createNodeContext({ workDir: pair.ours }), ['f']);

            // Assert
            expect(entryDebug(pair.peer, 'f')).toEqual(recorded);
            expect(entryDebug(pair.ours, 'f')).toEqual(recordedByTsgit);
          } finally {
            await pair.dispose();
          }
        });
      });

      describe.each([
        ['racy', 0n],
        ['settled', SETTLE_GAP_SECONDS],
      ] as const)(
        'When status runs after a same-second chmod, with the index %s',
        (_label, gap) => {
          it('Then both tools report it clean and keep its recorded stat', async () => {
            // Arrange
            const pair = await makePeerPair('whole-second-status-chmod');
            try {
              initBothRepos(pair.peer, pair.ours);
              for (const repo of [pair.peer, pair.ours]) {
                await seed(repo, ignorecase);
                await sameSecondChmod(repo);
                await armIndexTime(repo, entryStamp(repo, 'f', 'mtime').seconds + gap);
              }
              const recorded = entryDebug(pair.peer, 'f');
              const recordedByTsgit = entryDebug(pair.ours, 'f');

              // Act
              const gitModified = gitReportsModified(pair.peer);
              const tsgitModified = await tsgitReportsModified(pair.ours);

              // Assert
              expect([gitModified, tsgitModified]).toEqual([false, false]);
              expect(entryDebug(pair.peer, 'f')).toEqual(recorded);
              expect(entryDebug(pair.ours, 'f')).toEqual(recordedByTsgit);
            } finally {
              await pair.dispose();
            }
          });
        },
      );

      describe.each([
        ['core.trustCtime', 'false'],
        ['core.checkStat', 'minimal'],
      ] as const)('When status runs under %s %s after a chmod a second later', (key, value) => {
        it('Then both tools keep its recorded stat', async () => {
          // Arrange
          const pair = await makePeerPair('whole-second-ignored-ctime');
          try {
            initBothRepos(pair.peer, pair.ours);
            for (const repo of [pair.peer, pair.ours]) {
              await seed(repo, ignorecase);
              git(repo, 'config', key, value);
              await chmodSecondsLater(repo);
            }
            const recorded = entryDebug(pair.peer, 'f');
            const recordedByTsgit = entryDebug(pair.ours, 'f');

            // Act
            const gitModified = gitReportsModified(pair.peer);
            const tsgitModified = await tsgitReportsModified(pair.ours);

            // Assert
            expect([gitModified, tsgitModified]).toEqual([false, false]);
            expect(entryDebug(pair.peer, 'f')).toEqual(recorded);
            expect(entryDebug(pair.ours, 'f')).toEqual(recordedByTsgit);
          } finally {
            await pair.dispose();
          }
        });
      });

      describe('When status runs after a chmod a second later under the default policy', () => {
        it('Then both tools report it clean and refresh its recorded stat', async () => {
          // Arrange
          const pair = await makePeerPair('whole-second-default-ctime');
          try {
            initBothRepos(pair.peer, pair.ours);
            for (const repo of [pair.peer, pair.ours]) {
              await seed(repo, ignorecase);
              await chmodSecondsLater(repo);
            }
            const recorded = entryDebug(pair.peer, 'f');
            const recordedByTsgit = entryDebug(pair.ours, 'f');

            // Act
            const gitModified = gitReportsModified(pair.peer);
            const tsgitModified = await tsgitReportsModified(pair.ours);

            // Assert
            expect([gitModified, tsgitModified]).toEqual([false, false]);
            expect(entryDebug(pair.peer, 'f')).not.toEqual(recorded);
            expect(entryDebug(pair.ours, 'f')).not.toEqual(recordedByTsgit);
          } finally {
            await pair.dispose();
          }
        });
      });

      describe.each([
        ['a same-size edit that changed only the inode', sameSizeEditNewInode],
        ['a same-size edit in the index second, one second later', staleSameSizeEdit],
        ['a file emptied in place while its entry is smudged', smudgedTruncation],
      ] as const)('When status runs after %s', (_label, shape) => {
        it('Then both tools report the file modified', async () => {
          // Arrange
          const pair = await makePeerPair('whole-second-reports-modified');
          try {
            initBothRepos(pair.peer, pair.ours);
            for (const repo of [pair.peer, pair.ours]) {
              await seed(repo, ignorecase);
              await shape(repo);
            }

            // Act
            const gitModified = gitReportsModified(pair.peer);
            const tsgitModified = await tsgitReportsModified(pair.ours);

            // Assert
            expect([gitModified, tsgitModified]).toEqual([true, true]);
          } finally {
            await pair.dispose();
          }
        });
      });
      describe.each([
        ['racy', 0n, checkoutPath],
        ['settled', SETTLE_GAP_SECONDS, checkoutPath],
        ['racy', 0n, forcedSwitch],
        ['racy', 0n, hardReset],
        ['racy', 0n, plainSwitch],
      ] as const)(
        'When a file stat-moved within its second meets an act with the index %s',
        (_label, gap, act) => {
          it('Then both tools leave the file in place', async () => {
            // Arrange
            const pair = await makePeerPair('whole-second-stays');
            try {
              initBothRepos(pair.peer, pair.ours);
              for (const repo of [pair.peer, pair.ours]) {
                await seed(repo, ignorecase);
                await sameSecondChmod(repo);
                await armIndexTime(repo, entryStamp(repo, 'f', 'mtime').seconds + gap);
              }
              const before = await workFileOf(pair.peer);
              const beforeByTsgit = await workFileOf(pair.ours);

              // Act
              await actOnBoth(act, pair.peer, pair.ours);

              // Assert
              expect(await workFileOf(pair.peer)).toEqual(before);
              expect(await workFileOf(pair.ours)).toEqual(beforeByTsgit);
              expect(before.mode).toBe(BigInt(GROUP_WRITABLE_MODE));
            } finally {
              await pair.dispose();
            }
          });
        },
      );

      describe.each([
        ['core.trustCtime', 'false'],
        ['core.checkStat', 'minimal'],
      ] as const)(
        'When checkout restores a file chmod-ed a second later under %s %s',
        (key, value) => {
          it('Then both tools leave the file in place', async () => {
            // Arrange
            const pair = await makePeerPair('whole-second-restore-ignored-ctime');
            try {
              initBothRepos(pair.peer, pair.ours);
              for (const repo of [pair.peer, pair.ours]) {
                await seed(repo, ignorecase);
                git(repo, 'config', key, value);
                await chmodSecondsLater(repo);
              }
              const before = await workFileOf(pair.peer);
              const beforeByTsgit = await workFileOf(pair.ours);

              // Act
              await actOnBoth(checkoutPath, pair.peer, pair.ours);

              // Assert
              expect(await workFileOf(pair.peer)).toEqual(before);
              expect(await workFileOf(pair.ours)).toEqual(beforeByTsgit);
              expect(before.mode).toBe(BigInt(GROUP_WRITABLE_MODE));
            } finally {
              await pair.dispose();
            }
          });
        },
      );

      describe('When checkout restores a file chmod-ed a second later under the default policy', () => {
        it('Then both tools rewrite the file', async () => {
          // Arrange
          const pair = await makePeerPair('whole-second-restore-default-ctime');
          try {
            initBothRepos(pair.peer, pair.ours);
            for (const repo of [pair.peer, pair.ours]) {
              await seed(repo, ignorecase);
              await chmodSecondsLater(repo);
            }
            const before = await workFileOf(pair.peer);
            const beforeByTsgit = await workFileOf(pair.ours);

            // Act
            await actOnBoth(checkoutPath, pair.peer, pair.ours);

            // Assert
            expect((await workFileOf(pair.peer)).ctimeNs).toBeGreaterThan(before.ctimeNs);
            expect((await workFileOf(pair.ours)).ctimeNs).toBeGreaterThan(beforeByTsgit.ctimeNs);
          } finally {
            await pair.dispose();
          }
        });
      });

      describe.each([
        ['a same-size edit in the index second, one second later', staleSameSizeEdit],
        ['a file emptied in place while its entry is smudged', smudgedTruncation],
      ] as const)('When checkout restores a file after %s', (_label, shape) => {
        it('Then both tools restore the staged content', async () => {
          // Arrange
          const pair = await makePeerPair('whole-second-restore-edited');
          try {
            initBothRepos(pair.peer, pair.ours);
            for (const repo of [pair.peer, pair.ours]) {
              await seed(repo, ignorecase);
              await shape(repo);
            }

            // Act
            await actOnBoth(checkoutPath, pair.peer, pair.ours);

            // Assert
            expect(await readFile(path.join(pair.peer, 'f'), 'utf8')).toBe('abc\n');
            expect(await readFile(path.join(pair.ours, 'f'), 'utf8')).toBe('abc\n');
          } finally {
            await pair.dispose();
          }
        });
      });

      describe('When a switch changes a path beneath a symlinked directory whose file stat moved within its second', () => {
        it('Then both tools switch as git does', async () => {
          // Arrange
          const pair = await makePeerPair('whole-second-beneath-link');
          try {
            initBothRepos(pair.peer, pair.ours);
            for (const repo of [pair.peer, pair.ours]) {
              await seedBeneathLink(repo, ignorecase);
              await chmodBeneathLink(repo);
            }

            // Act
            const gitOutcome = await switchOutcome(pair.peer, () => plainSwitch.git(pair.peer));
            const tsgitOutcome = await switchOutcome(pair.ours, () => plainSwitch.tsgit(pair.ours));

            // Assert
            expect(gitOutcome).toEqual({ refused: false, head: 'other' });
            expect(tsgitOutcome).toEqual(gitOutcome);
            expect(await workTreeNames(pair.ours)).toEqual(await workTreeNames(pair.peer));
          } finally {
            await pair.dispose();
          }
        });
      });

      describe.each([
        ['stat-moved within its second', stageFileMovedInItsSecond],
        [
          'was chmod-ed a second later under core.trustCtime false',
          stageFileMovedLaterCtimeIgnored,
        ],
      ] as const)('When a switch needs a directory where a staged file %s', (_shape, arrange) => {
        it('Then both tools switch under core.ignorecase true and refuse under false', async () => {
          // Arrange
          const pair = await makePeerPair('whole-second-icase-exists');
          try {
            initBothRepos(pair.peer, pair.ours);
            for (const repo of [pair.peer, pair.ours]) {
              await seedDirectoryTarget(repo, ignorecase);
              await arrange(repo);
            }

            // Act
            const gitOutcome = await switchOutcome(pair.peer, () =>
              git(pair.peer, 'checkout', '-q', 'tgt'),
            );
            const tsgitError = await tsgitSwitchError(pair.ours, 'tgt');

            // Assert
            const refused = ignorecase === 'false';
            expect(gitOutcome).toEqual({ refused, head: refused ? 'main' : 'tgt' });
            expect(tsgitError?.data).toEqual(
              refused
                ? { code: 'CHECKOUT_OVERWRITE_DIRTY', localChanges: [], untracked: ['dir'] }
                : undefined,
            );
            expect(await workTreeNames(pair.ours)).toEqual(await workTreeNames(pair.peer));
          } finally {
            await pair.dispose();
          }
        });
      });

      describe('When a sparse checkout excludes a directory whose file stat-moved within its second', () => {
        it('Then both tools remove the file', async () => {
          // Arrange
          const pair = await makePeerPair('whole-second-sparse-mover');
          try {
            initBothRepos(pair.peer, pair.ours);
            for (const repo of [pair.peer, pair.ours]) {
              await seedTwoDirectories(repo, ignorecase);
              await sameSecondChmod(repo, 'a/f');
            }

            // Act
            git(pair.peer, 'sparse-checkout', 'set', '--no-cone', '/b/');
            await sparseCheckoutSet(ctxOf(pair.ours), { patterns: ['/b/'], cone: false });

            // Assert
            expect(await workTreeNames(pair.peer)).toEqual(['b']);
            expect(await workTreeNames(pair.ours)).toEqual(['b']);
          } finally {
            await pair.dispose();
          }
        });
      });
    });
  },
);
