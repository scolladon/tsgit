/**
 * Cross-tool interop — an index write smudges a racily-clean entry to size 0,
 * as git's `do_write_index` does. git's side pins the stats with `utimes` and
 * `core.checkStat=minimal`/`core.trustctime=false`; tsgit's side pins them with
 * a frozen clock on the memory filesystem. Each index is then read back by
 * `git ls-files --debug` and projected onto what both sides can share.
 *
 * @proves
 *   surface:        index
 *   bucket:         cross-tool-interop
 *   unique:         an index rewrite smudges a racily-clean entry whose content changed
 *   interopSurface: index
 */
import { mkdir, utimes, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../src/adapters/memory/memory-adapter.js';
import { add } from '../../src/application/commands/add.js';
import { init } from '../../src/application/commands/init.js';
import { git, makePeerPair, runGit } from './interop-helpers.js';

const PINNED_SECONDS = 1_577_836_800;
const TICK_MS = 1_700_000_000_100;
const NEXT_SECOND_MS = TICK_MS + 1000;
const ADDED_LATER = 'add/new.txt';
const STAGED_FIRST = 'del/y.txt';
const REWRITTEN = 'mod/m.txt';
const ENTRY_SIZE_LINE = /^\s+size: (\d+)\tflags: (\S+)$/;

/** Each path's cached size and flags, as git reads them from the index. */
const sizesByPath = (debug: string): Record<string, string> => {
  const sizes: Record<string, string> = {};
  let current = '';
  for (const line of debug.split('\n')) {
    const size = ENTRY_SIZE_LINE.exec(line);
    if (size !== null) sizes[current] = `size ${size[1]} flags ${size[2]}`;
    else if (!line.startsWith(' ')) current = line;
  }
  return sizes;
};

const indexAsGitReadsIt = (dir: string) => ({
  stage: git(dir, 'ls-files', '--stage'),
  sizes: sizesByPath(git(dir, 'ls-files', '--debug')),
});

const writePinned = async (dir: string, rel: string, content: string): Promise<void> => {
  await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
  await writeFile(path.join(dir, rel), content);
  await utimes(path.join(dir, rel), PINNED_SECONDS, PINNED_SECONDS);
};

/** git: stage `m1`, make the index as old as the entry, rewrite `m2` with the same stat, add another path. */
const gitSide = async (peer: string) => {
  runGit(['init', '-q', '-b', 'main', peer]);
  git(peer, 'config', 'core.checkStat', 'minimal');
  git(peer, 'config', 'core.trustctime', 'false');
  await writePinned(peer, STAGED_FIRST, 'y\n');
  await writePinned(peer, REWRITTEN, 'm1\n');
  git(peer, 'add', STAGED_FIRST, REWRITTEN);
  await utimes(path.join(peer, '.git/index'), PINNED_SECONDS, PINNED_SECONDS);
  await writePinned(peer, REWRITTEN, 'm2\n');
  await writePinned(peer, ADDED_LATER, 'new\n');
  git(peer, 'add', ADDED_LATER);
  return indexAsGitReadsIt(peer);
};

/** tsgit: the same sequence in one clock tick, adding the other path a second later. */
const tsgitSide = async (ours: string) => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(TICK_MS);
  const ctx = createMemoryContext();
  await init(ctx);
  const write = (rel: string, content: string) =>
    ctx.fs.writeUtf8(`${ctx.layout.workDir}/${rel}`, content);
  await write(STAGED_FIRST, 'y\n');
  await write(REWRITTEN, 'm1\n');
  await add(ctx, [STAGED_FIRST, REWRITTEN]);
  await write(REWRITTEN, 'm2\n');
  vi.setSystemTime(NEXT_SECOND_MS);
  await write(ADDED_LATER, 'new\n');
  await add(ctx, [ADDED_LATER]);
  runGit(['init', '-q', '-b', 'main', ours]);
  await writeFile(path.join(ours, '.git/index'), await ctx.fs.read(`${ctx.layout.gitDir}/index`));
  return indexAsGitReadsIt(ours);
};

describe('index racy-clean smudge interop', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Given a same-size rewrite that keeps the stat of an entry as new as the index', () => {
    describe('When another path is added and the index is rewritten', () => {
      it('Then the rewritten entry is smudged to size 0, as git reads both indexes', async () => {
        // Arrange
        const pair = await makePeerPair('index-racy-smudge');
        try {
          const expected = await gitSide(pair.peer);
          const sut = tsgitSide;

          // Act
          const result = await sut(pair.ours);

          // Assert
          expect(expected.sizes[REWRITTEN]).toBe('size 0 flags 0');
          expect(result).toEqual(expected);
        } finally {
          await pair.dispose();
        }
      });
    });
  });
});
