/**
 * Cross-tool interop — the order a long-running `filter.<d>.process` driver
 * receives clean requests in. git cleans one path at a time in index order;
 * tsgit reads the work tree concurrently, so a large file early in the index
 * must still reach the driver before the small files after it — for `add`
 * over a directory, `add` over literal paths in any argument order, and the
 * hashing `status` does for stat-dirty entries.
 *
 * @proves
 *   surface:        add, status
 *   bucket:         cross-tool-interop
 *   unique:         clean requests reach a process driver in index order
 *   interopSurface: add, status
 */
import { mkdir, mkdtemp, readFile, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/index.js';
import { add } from '../../src/application/commands/add.js';
import { status } from '../../src/application/commands/status.js';
import type { Context } from '../../src/ports/context.js';
import { GIT_AVAILABLE, runGit, runGitEnv } from './interop-helpers.js';

/** Logs each request's pathname; answers a clean with its input, split across packets. */
const LOGGING_PROCESS_FILTER = `const fs = require('node:fs');
const log = process.argv[2];
const MAX = 65516;
const pkt = (bytes) => Buffer.concat([Buffer.from((bytes.length + 4).toString(16).padStart(4, '0')), bytes]);
const flush = Buffer.from('0000');
const write = (...parts) => process.stdout.write(Buffer.concat(parts));
let buffered = Buffer.alloc(0); let pending = []; let step = 0;
const content = (bytes) => { const out = []; for (let i = 0; i < bytes.length; i += MAX) out.push(pkt(bytes.subarray(i, i + MAX))); return out; };
const answers = [
  () => write(pkt(Buffer.from('git-filter-server\\n')), pkt(Buffer.from('version=2\\n')), flush),
  () => write(pkt(Buffer.from('capability=clean\\n')), flush),
  (data) => { const name = /pathname=([^\\n]*)/.exec(data.toString()); fs.appendFileSync(log, name[1] + '\\n'); },
  (data) => write(pkt(Buffer.from('status=success\\n')), flush, ...content(data), flush, flush),
];
process.stdin.on('data', (chunk) => {
  buffered = Buffer.concat([buffered, chunk]);
  while (buffered.length >= 4) {
    const length = parseInt(buffered.subarray(0, 4).toString(), 16);
    if (length !== 0 && buffered.length < length) return;
    if (length !== 0) pending.push(buffered.subarray(4, length));
    buffered = buffered.subarray(length === 0 ? 4 : length);
    if (length !== 0) continue;
    const data = Buffer.concat(pending);
    pending = [];
    if (step === 2) { answers[2](data); step = 3; continue; }
    answers[step](data);
    step = step === 3 ? 2 : step + 1;
  }
});
`;

/** A large file first in index order, small ones after it, one per directory level. */
const FILES: ReadonlyArray<readonly [string, number]> = [
  ['a.t', 4 * 1024 * 1024],
  ['b/1.t', 8],
  ['b/2.t', 8],
  ['c.t', 8],
  ['z/9.t', 8],
];
const INDEX_ORDER = FILES.map(([name]) => name);
const STALE_MTIME = new Date('2020-01-01T00:00:00Z');

describe.skipIf(!GIT_AVAILABLE)('Given a clean process driver over files of mixed sizes', () => {
  let root = '';
  let script = '';

  beforeAll(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-clean-order-')));
    script = path.join(root, 'filter.cjs');
    await writeFile(script, LOGGING_PROCESS_FILTER);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const writeFiles = async (repo: string, fill: string): Promise<void> => {
    for (const [name, size] of FILES) {
      await mkdir(path.dirname(path.join(repo, name)), { recursive: true });
      await writeFile(path.join(repo, name), fill.repeat(size));
    }
  };

  const twin = async (slug: string) => {
    const repo = path.join(root, slug);
    const log = path.join(root, `${slug}.log`);
    runGit(['init', '-q', '-b', 'main', repo]);
    await writeFile(path.join(repo, '.gitattributes'), '*.t filter=d\n');
    runGit([
      '-C',
      repo,
      'config',
      'filter.d.process',
      `"${process.execPath}" "${script}" "${log}"`,
    ]);
    await writeFile(log, '');
    return {
      repo,
      requests: async () => (await readFile(log, 'utf8')).split('\n').filter((line) => line !== ''),
      reset: () => writeFile(log, ''),
    };
  };

  /** Commits the files, then rewrites them same-size with a stale mtime so status must hash each. */
  const committedThenTouched = async (slug: string) => {
    const repo = await twin(slug);
    await writeFiles(repo.repo, 'x');
    runGit(['-C', repo.repo, 'add', '.']);
    runGit(['-C', repo.repo, '-c', 'user.name=A', '-c', 'user.email=a@a', 'commit', '-qm', 'c'], {
      env: runGitEnv(),
    });
    await writeFiles(repo.repo, 'y');
    for (const [name] of FILES) await utimes(path.join(repo.repo, name), STALE_MTIME, STALE_MTIME);
    await repo.reset();
    return repo;
  };

  describe.each([
    {
      label: 'add the whole tree',
      git: ['add', '.'],
      tsgit: (ctx: Context) => add(ctx, ['.']),
    },
    {
      label: 'add literal paths in reverse order',
      git: ['add', ...[...INDEX_ORDER].reverse()],
      tsgit: (ctx: Context) => add(ctx, [...INDEX_ORDER].reverse()),
    },
  ])('When git and tsgit $label', ({ label, git: args, tsgit }) => {
    it('Then both send the clean requests in index order', async () => {
      // Arrange
      const slug = label.replaceAll(' ', '-');
      const gitTwin = await twin(`git-${slug}`);
      const tsgitTwin = await twin(`tsgit-${slug}`);
      await writeFiles(gitTwin.repo, 'x');
      await writeFiles(tsgitTwin.repo, 'x');
      const sut = tsgit;

      // Act
      runGit(['-C', gitTwin.repo, ...args]);
      await sut(createNodeContext({ workDir: tsgitTwin.repo }));

      // Assert
      expect(await gitTwin.requests()).toEqual(INDEX_ORDER);
      expect(await tsgitTwin.requests()).toEqual(INDEX_ORDER);
    });
  });

  /** A repo whose `rec` clean driver appends each file's content to a log, `tee` being the recorder. */
  const recordingTwin = async (slug: string) => {
    const repo = path.join(root, slug);
    const log = path.join(root, `${slug}.log`);
    runGit(['init', '-q', '-b', 'main', repo]);
    await writeFile(path.join(repo, '.gitattributes'), '*.txt filter=rec\n');
    runGit(['-C', repo, 'config', 'filter.rec.clean', `tee -a "${log}"`]);
    await writeFile(path.join(repo, 'b.txt'), 'B\n');
    runGit(['-C', repo, 'add', 'b.txt']);
    await writeFile(log, '');
    await writeFile(path.join(repo, 'a.txt'), 'A\n');
    await writeFile(path.join(repo, 'b.txt'), 'B2\n');
    await writeFile(path.join(repo, 'c.txt'), 'C\n');
    return { repo, heard: async () => readFile(log, 'utf8') };
  };

  describe('When git and tsgit add -A a modified tracked path among untracked ones', () => {
    it('Then both clean the tracked path first, then the untracked ones in walk order', async () => {
      // Arrange
      const gitTwin = await recordingTwin('git-tracked-first');
      const tsgitTwin = await recordingTwin('tsgit-tracked-first');
      const sut = add;

      // Act
      runGit(['-C', gitTwin.repo, 'add', '-A']);
      await sut(createNodeContext({ workDir: tsgitTwin.repo }), [], { all: true });

      // Assert
      expect(await gitTwin.heard()).toBe('B2\nA\nC\n');
      expect(await tsgitTwin.heard()).toBe(await gitTwin.heard());
    });
  });

  describe('When git and tsgit report the status of same-size rewrites', () => {
    it('Then both send the clean requests in index order', async () => {
      // Arrange
      const gitTwin = await committedThenTouched('git-status');
      const tsgitTwin = await committedThenTouched('tsgit-status');
      const sut = status;

      // Act
      runGit(['-C', gitTwin.repo, 'status', '--porcelain']);
      await sut(createNodeContext({ workDir: tsgitTwin.repo }));

      // Assert
      expect(await gitTwin.requests()).toEqual(INDEX_ORDER);
      expect(await tsgitTwin.requests()).toEqual(INDEX_ORDER);
    });
  });
});
