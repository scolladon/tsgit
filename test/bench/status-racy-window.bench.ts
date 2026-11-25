/**
 * Bench scenario: `status()` on a repository whose every tracked file shares the index's
 * second (the racy window, where each entry's content is compared) against the same scan on
 * a settled index followed by reading and hashing every tracked file — the floor the racy
 * scan cannot beat, since both must read every byte. tsgit-only: no comparable baseline.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { openRepository, type Repository } from '../../src/index.node.js';
import { benchScenario } from './support/bench-dsl.js';
import { removeSync } from './support/fixture-scratch.js';

const FILE_COUNT = 5_000;
const FILE_BYTES = 2_048;
const DIRECTORY_COUNT = 50;
const SHARED_SECOND = 1_700_000_000;
const HALF_SECOND = 0.5;
const SETTLED_OFFSET_SECONDS = 5;
const AUTHOR = {
  name: 'Bench',
  email: 'bench@tsgit.dev',
  timestamp: SHARED_SECOND,
  timezoneOffset: '+0000',
} as const;

interface RacyFixture {
  readonly cwd: string;
  readonly files: ReadonlyArray<string>;
  readonly repo: Repository;
}

const fileNameOf = (index: number): string =>
  `d${String(index % DIRECTORY_COUNT)}/f${String(index)}.txt`;

const writeTrackedFiles = async (cwd: string): Promise<ReadonlyArray<string>> => {
  const files = Array.from({ length: FILE_COUNT }, (_, index) => fileNameOf(index));
  for (let directory = 0; directory < DIRECTORY_COUNT; directory += 1) {
    await mkdir(path.join(cwd, `d${String(directory)}`));
  }
  for (const [index, file] of files.entries()) {
    const target = path.join(cwd, file);
    await writeFile(target, String(index).padEnd(FILE_BYTES, 'x'));
    await utimes(target, SHARED_SECOND + HALF_SECOND, SHARED_SECOND + HALF_SECOND);
  }
  return files;
};

const buildFixture = async (): Promise<RacyFixture> => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'tsgit-bench-racy-window-'));
  const repo = await openRepository({ cwd });
  await repo.init();
  const files = await writeTrackedFiles(cwd);
  await repo.add([...files]);
  await repo.commit({ message: 'racy window fixture', author: AUTHOR });
  return { cwd, files, repo };
};

/** The index file's own times, never a work file's: a work file's `utimes` would move its ctime. */
const armIndex = (cwd: string, seconds: number): Promise<void> =>
  utimes(path.join(cwd, '.git', 'index'), seconds, seconds);

/**
 * The cheapest content check there is, as git pays it: one synchronous read and one blob
 * SHA-1 per file. An asynchronous read per file would cost more than the scan it floors.
 */
const hashEveryFile = (cwd: string, files: ReadonlyArray<string>): void => {
  for (const file of files) {
    const bytes = readFileSync(path.join(cwd, file));
    createHash('sha1')
      .update(`blob ${String(bytes.length)}\0`)
      .update(bytes)
      .digest();
  }
};

type Scan = (fixture: RacyFixture) => Promise<void>;

const racyScan: Scan = async ({ cwd, repo }) => {
  await armIndex(cwd, SHARED_SECOND);
  await repo.status();
};

const settledScan: Scan = async ({ cwd, files, repo }) => {
  await armIndex(cwd, SHARED_SECOND + SETTLED_OFFSET_SECONDS);
  await repo.status();
  hashEveryFile(cwd, files);
};

const racyAdd: Scan = async ({ cwd, repo }) => {
  await armIndex(cwd, SHARED_SECOND);
  await repo.add(['.']);
};

const settledAdd: Scan = async ({ cwd, files, repo }) => {
  await armIndex(cwd, SHARED_SECOND + SETTLED_OFFSET_SECONDS);
  await repo.add(['.']);
  hashEveryFile(cwd, files);
};

const racyWindowScenario = (given: string, whenThen: string, scan: Scan): void => {
  benchScenario(given, whenThen, async () => {
    const fixture = await buildFixture();
    let lastCall: Promise<unknown> = Promise.resolve();
    return {
      // A scan still in flight would recreate files under the directory being removed.
      teardown: async (): Promise<void> => {
        await lastCall;
        removeSync(fixture.cwd);
        await fixture.repo.dispose();
      },
      sut: async (): Promise<void> => {
        lastCall = scan(fixture);
        await lastCall;
      },
    };
  });
};

racyWindowScenario(
  'Given 5000 tracked files whose mtimes share the index second',
  'When status() runs in the racy window, Then measure tsgit alone',
  racyScan,
);
racyWindowScenario(
  'Given 5000 tracked files in a settled index',
  'When status() runs and every tracked file is read and hashed, Then measure tsgit alone',
  settledScan,
);
racyWindowScenario(
  'Given 5000 tracked files whose mtimes share the index second',
  'When add() restages them in the racy window, Then measure tsgit alone',
  racyAdd,
);
racyWindowScenario(
  'Given 5000 tracked files in a settled index',
  'When add() runs and every tracked file is read and hashed, Then measure tsgit alone',
  settledAdd,
);
