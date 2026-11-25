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
import { chmod, lstat, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/index.js';
import { add } from '../../src/application/commands/add.js';
import { GIT_AVAILABLE, git, initBothRepos, makePeerPair } from './interop-helpers.js';

const SECOND_START_OFFSET_MS = 50;
const MAX_FIXTURE_ATTEMPTS = 5;
const SHAPE_STEP_MS = 100;
const MS_PER_SECOND = 1_000;
const NS_PER_SECOND = 1_000_000_000n;
const GROUP_WRITABLE_MODE = 0o664;
const SMUDGED_SIZE = 0;
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
const sameSecondChmod = async (repo: string): Promise<void> => {
  for (let attempt = 0; attempt < MAX_FIXTURE_ATTEMPTS; attempt += 1) {
    await toNextSecondStart();
    await put(repo, 'f', 'one\n');
    git(repo, 'add', 'f');
    await sleep(SHAPE_STEP_MS);
    await chmod(path.join(repo, 'f'), GROUP_WRITABLE_MODE);
    const worked = await lstat(path.join(repo, 'f'), { bigint: true });
    const recorded = entryStamp(repo, 'f', 'ctime');
    const index = await indexMtime(repo);
    const sameCtimeSecond = worked.ctimeNs / NS_PER_SECOND === recorded.seconds;
    const ctimeMoved = worked.ctimeNs % NS_PER_SECOND !== recorded.nanoseconds;
    const inIndexSecond = entryStamp(repo, 'f', 'mtime').seconds === index.seconds;
    if (sameCtimeSecond && ctimeMoved && inIndexSecond) return;
  }
  throw premiseNeverMet('same-second chmod');
};

const gitAddsUnrelatedPath = async (repo: string): Promise<void> => {
  await put(repo, 'g', 'g\n');
  git(repo, 'add', 'g');
};

const tsgitAddsUnrelatedPath = async (repo: string): Promise<void> => {
  await put(repo, 'g', 'g\n');
  await add(createNodeContext({ workDir: repo }), ['g']);
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
    });
  },
);
