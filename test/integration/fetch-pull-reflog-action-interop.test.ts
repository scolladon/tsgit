/**
 * Cross-tool interop — the reflog action a fetch or a pull records. git names
 * every ref update after its own command line (`fetch <args>`, `pull <args>`),
 * and a pull's fetch inherits pull's. tsgit rebuilds that prefix from the
 * structured remote and refspecs; each row runs the same request in both
 * tools after the peer moves on and compares the newest reflog subject of
 * every ref the request moved.
 *
 * @proves
 *   surface:        fetch, pull
 *   bucket:         cross-tool-interop
 *   unique:         fetch and pull reflog subjects carry git's argv-derived action
 *   interopSurface: fetch
 */

import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { fetch } from '../../src/application/commands/fetch.js';
import { pull } from '../../src/application/commands/pull.js';
import type { Context } from '../../src/ports/context.js';
import { backendTransport } from './http-backend-transport.js';
import { GIT_AVAILABLE, runGit, runGitEnv, topReflogSubject } from './interop-helpers.js';

const PEER_URL = 'https://example.com/peer.git';
const ROW_TIMEOUT = 60_000;
const DATED_ENV = {
  ...runGitEnv(),
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
  GIT_AUTHOR_DATE: '1700000000 +0000',
  GIT_COMMITTER_DATE: '1700000000 +0000',
};

let root: string;

const dated = (args: ReadonlyArray<string>): string => runGit(args, { env: DATED_ENV });

const commitFile = (dir: string, file: string): void => {
  writeFileSync(path.join(dir, file), `${file}\n`);
  dated(['-C', dir, 'add', file]);
  dated(['-C', dir, 'commit', '-q', '-m', file]);
};

beforeAll(() => {
  if (!GIT_AVAILABLE) return;
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'tsgit-interop-reflog-action-')));
});

afterAll(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

/** One clone per tool with `main` tracking the peer's `main`, then the peer moves on. */
const setUp = (label: string) => {
  const work = path.join(root, `${label}-work`);
  const peerRoot = path.join(root, `${label}-peer`);
  const peerPath = path.join(peerRoot, 'peer.git');
  dated(['init', '-q', '-b', 'main', work]);
  commitFile(work, 'a.txt');
  dated(['clone', '-q', '--bare', work, peerPath]);
  const ours = path.join(root, `${label}-ours`);
  const theirs = path.join(root, `${label}-theirs`);
  for (const [dir, url] of [
    [ours, PEER_URL],
    [theirs, peerPath],
  ] as const) {
    dated(['clone', '-q', '-b', 'main', peerPath, dir]);
    dated(['-C', dir, 'remote', 'set-url', 'origin', url]);
  }
  commitFile(work, 'b.txt');
  dated(['-C', work, 'push', '-q', peerPath, 'main']);
  return { ours, theirs, peerRoot };
};

interface Row {
  readonly label: string;
  readonly gitArgs: ReadonlyArray<string>;
  readonly run: (ctx: Context) => Promise<unknown>;
  readonly refs: ReadonlyArray<string>;
}

const ROWS: ReadonlyArray<Row> = [
  {
    label: 'a fetch naming no remote',
    gitArgs: ['fetch'],
    run: (ctx) => fetch(ctx),
    refs: ['refs/remotes/origin/main'],
  },
  {
    label: 'a fetch naming the remote and a refspec',
    gitArgs: ['fetch', 'origin', 'main:refs/heads/x'],
    run: (ctx) => fetch(ctx, { remote: 'origin', refspecs: ['main:refs/heads/x'] }),
    refs: ['refs/heads/x', 'refs/remotes/origin/main'],
  },
  {
    label: 'a pull naming nothing',
    gitArgs: ['pull'],
    run: (ctx) => pull(ctx),
    refs: ['refs/remotes/origin/main', 'refs/heads/main', 'HEAD'],
  },
  {
    label: 'a pull naming the remote and a branch',
    gitArgs: ['pull', 'origin', 'main'],
    run: (ctx) => pull(ctx, { remote: 'origin', ref: 'main' }),
    refs: ['refs/remotes/origin/main', 'refs/heads/main', 'HEAD'],
  },
];

const subjects = (dir: string, refs: ReadonlyArray<string>): ReadonlyArray<string> =>
  refs.map((ref) => topReflogSubject(dir, ref));

describe.skipIf(!GIT_AVAILABLE)('fetch and pull reflog action interop', () => {
  describe.each(ROWS)('Given $label', ({ label, gitArgs, run, refs }) => {
    describe('When both tools run it after the peer moves on', () => {
      it(
        'Then every moved ref records the same reflog subject',
        async () => {
          // Arrange
          const { ours, theirs, peerRoot } = setUp(label.replaceAll(' ', '-'));
          const ctx = {
            ...createNodeContext({ workDir: ours }),
            transport: backendTransport(peerRoot),
          };
          const sut = run;

          // Act
          dated(['-C', theirs, ...gitArgs]);
          await sut(ctx);

          // Assert
          const expected = subjects(theirs, refs);
          expect(subjects(ours, refs)).toEqual(expected);
          expect(expected.every((subject) => subject.length > 0)).toBe(true);
        },
        ROW_TIMEOUT,
      );
    });
  });
});
