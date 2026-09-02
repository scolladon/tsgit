/**
 * Cross-tool interop for the pack entry indexer in `internal/index-pack.ts`:
 * `walkPackEntries`'s (id, offset) set over a REAL git-produced pack must
 * agree with `git show-index`'s own listing, and the same pack must satisfy
 * `git verify-pack` with zero complaints. Created here with ONE case —
 * fixture A below; later parts of this change add the rest.
 *
 * Fixture A: a single 2 000-line file churned over 300 commits (20 lines
 * rewritten + 1 appended each), built via one `git fast-import` stream
 * (deterministic xorshift32 content, fixed author/committer identity and
 * timestamps) rather than 300 `git commit` invocations, then
 * `git -c pack.threads=1 repack -a -d` — single-threaded so delta selection
 * (and so the resulting max chain depth) is deterministic. Measured: 903
 * objects (301 commit / 301 tree / 301 blob), max chain depth 50 —
 * saturating git's default `pack.depth`.
 *
 * @proves
 *   surface:        packIndex
 *   bucket:         cross-tool-interop
 *   unique:         walkPackEntries over a real git pack agrees with `git show-index` / `verify-pack`
 *   interopSurface: packfile
 */
import { spawnSync } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../src/adapters/memory/memory-adapter.js';
import { walkPackEntries } from '../../src/application/primitives/internal/index-pack.js';
import {
  disableAutoMaintenance,
  GIT_AVAILABLE,
  makePeerPair,
  type PeerPair,
  runGit,
  runGitEnv,
} from './interop-helpers.js';

const FIXTURE_A_SEED = 1234;
const FIXTURE_A_LINE_COUNT = 2000;
const FIXTURE_A_COMMITS = 300;
const FIXTURE_A_REWRITES_PER_COMMIT = 20;
const AUTHOR = 'Ada <ada@example.com>';
const BASE_TIMESTAMP = 1_700_000_000;

/** Deterministic xorshift32 — same shape as the unit corpus's own
 *  `pseudoRandomBytes`, but driving line content rather than raw bytes. */
const makeXorshift32 = (seed: number): (() => number) => {
  let state = seed >>> 0 || 1;
  return (): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  };
};

const blobRecord = (mark: number, content: string): string =>
  `blob\nmark :${mark}\ndata ${Buffer.byteLength(content)}\n${content}\n`;

const commitRecord = (fileMark: number, timestamp: number, message: string): string =>
  `commit refs/heads/main\n${`author ${AUTHOR} ${timestamp} +0000\n`}${`committer ${AUTHOR} ${timestamp} +0000\n`}data ${Buffer.byteLength(message)}\n${message}M 100644 :${fileMark} churn.txt\n`;

/**
 * Fixture A's own fast-import stream: a seed commit writing `churn.txt` at
 * `FIXTURE_A_LINE_COUNT` deterministic lines, then `FIXTURE_A_COMMITS`
 * commits each rewriting `FIXTURE_A_REWRITES_PER_COMMIT` deterministically
 * chosen lines and appending one more. fast-import auto-chains successive
 * `commit refs/heads/main` records onto the ref's current tip, so no
 * explicit `from` is needed once the seed commit lands.
 */
const buildFixtureAStream = (): string => {
  const rng = makeXorshift32(FIXTURE_A_SEED);
  const lines: string[] = [];
  for (let i = 0; i < FIXTURE_A_LINE_COUNT; i += 1) {
    lines.push(`seed ${i} ${rng().toString(16)}`);
  }

  let mark = 0;
  const nextMark = (): number => {
    mark += 1;
    return mark;
  };

  const seedMark = nextMark();
  let stream = blobRecord(seedMark, `${lines.join('\n')}\n`);
  stream += commitRecord(seedMark, BASE_TIMESTAMP, 'seed churn.txt\n');

  for (let c = 0; c < FIXTURE_A_COMMITS; c += 1) {
    for (let r = 0; r < FIXTURE_A_REWRITES_PER_COMMIT; r += 1) {
      const idx = rng() % lines.length;
      lines[idx] = `rewrite c${c} r${r} ${rng().toString(16)}`;
    }
    lines.push(`append c${c} ${rng().toString(16)}`);
    const fileMark = nextMark();
    stream += blobRecord(fileMark, `${lines.join('\n')}\n`);
    stream += commitRecord(fileMark, BASE_TIMESTAMP + c + 1, `churn ${c}\n`);
  }
  return stream;
};

/**
 * Pipes `streamContent` into `git fast-import` from a real file descriptor
 * (never buffered through the child's `input` option) — the throwaway
 * stream file lives outside the fixture repository and is removed
 * regardless of outcome, matching `rev-bitmap-closure-fixtures.ts`'s own
 * recipe for the same shape of fixture.
 */
const runFastImport = async (dir: string, streamContent: string): Promise<void> => {
  const streamPath = path.join(
    os.tmpdir(),
    `tsgit-index-pack-fixture-${path.basename(dir)}-${process.pid}.fi`,
  );
  await writeFile(streamPath, streamContent);
  try {
    const fd = openSync(streamPath, 'r');
    try {
      const result = spawnSync('git', ['-C', dir, 'fast-import', '--quiet'], {
        env: runGitEnv(),
        stdio: [fd, 'ignore', 'inherit'],
      });
      if (result.status !== 0) {
        throw new Error(`git fast-import exited with status ${String(result.status)}`);
      }
    } finally {
      closeSync(fd);
    }
  } finally {
    await rm(streamPath, { force: true });
  }
};

interface ShowIndexEntry {
  readonly offset: number;
  readonly id: string;
}

const SHOW_INDEX_LINE = /^(\d+) ([0-9a-f]+) \([0-9a-f]+\)$/;

/** `git show-index`'s own line shape: `<offset> <oid> (<crc32>)`, one per
 *  object. The crc32 group is matched (to validate the line shape) but not
 *  captured into the result — this row only pins the (id, offset) set. */
const parseShowIndexOutput = (output: string): ShowIndexEntry[] =>
  output
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const match = SHOW_INDEX_LINE.exec(line);
      if (match === null) throw new Error(`show-index: unparsable line: ${line}`);
      return { offset: Number(match[1]), id: match[2] as string };
    });

/** Offsets are unique per entry, so sorting by offset gives a canonical
 *  order for comparing two (id, offset) sets built by different tools. */
const byOffsetAscending = <T extends { readonly offset: number }>(items: ReadonlyArray<T>): T[] =>
  [...items].sort((a, b) => a.offset - b.offset);

describe.skipIf(!GIT_AVAILABLE)('index-pack interop', () => {
  let pair: PeerPair;
  let packBytes: Uint8Array;
  let idxBytes: Uint8Array;
  let idxPath: string;

  beforeAll(async () => {
    pair = await makePeerPair('index-pack');
    runGit(['init', '-q', '-b', 'main', pair.peer]);
    runGit(['-C', pair.peer, 'config', 'user.name', 'Ada']);
    runGit(['-C', pair.peer, 'config', 'user.email', 'ada@example.com']);
    runGit(['-C', pair.peer, 'config', 'commit.gpgsign', 'false']);
    disableAutoMaintenance(pair.peer);

    await runFastImport(pair.peer, buildFixtureAStream());
    runGit(['-C', pair.peer, 'checkout', '-f', 'main']);
    runGit(['-C', pair.peer, '-c', 'pack.threads=1', 'repack', '-a', '-d']);

    const packDir = path.join(pair.peer, '.git', 'objects', 'pack');
    const packName = (await readdir(packDir)).find((name) => name.endsWith('.pack'));
    if (packName === undefined) {
      throw new Error('index-pack interop: no pack survived repack -a -d');
    }
    const stem = packName.slice(0, -'.pack'.length);
    idxPath = path.join(packDir, `${stem}.idx`);
    packBytes = await readFile(path.join(packDir, `${stem}.pack`));
    idxBytes = await readFile(idxPath);
  }, 60_000);

  afterAll(async () => {
    await pair.dispose();
  });

  describe('Given fixture A (a 300-commit text churn) repacked by canonical git', () => {
    describe('When walkPackEntries walks the pack bytes', () => {
      it('Then its (id, offset) set matches `git show-index`, and `git verify-pack` accepts the pack', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        const walked = await walkPackEntries(ctx, packBytes);
        const showIndexOutput = runGit(['show-index'], { input: idxBytes });
        const verifyOut = runGit(['verify-pack', idxPath]);

        // Assert
        const walkedSet = byOffsetAscending(walked).map((e) => ({ offset: e.offset, id: e.id }));
        const showIndexSet = byOffsetAscending(parseShowIndexOutput(showIndexOutput));
        expect(walkedSet).toEqual(showIndexSet);
        expect(verifyOut).toBe('');
      });
    });
  });
});
