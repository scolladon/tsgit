/**
 * Cross-tool interop — the `FETCH_HEAD` a fetch writes. git's `get_ref_map`
 * marks the refs for merging — the current branch's configured upstream, an
 * exact first refspec, every command-line refspec — and `store_updated_refs`
 * lists them first, the rest `not-for-merge`, each described by its kind and
 * the shortened url. Command-line refspecs still update the tracking refs the
 * configured refspecs (or `--refmap`) map them onto. tsgit fetches through
 * `git http-backend`, git over a local path; the url each tool records is
 * swapped for one before the files are compared.
 *
 * @proves
 *   surface:        fetch
 *   bucket:         cross-tool-interop
 *   unique:         fetch writes FETCH_HEAD and honours command-line refspecs and refmap
 */
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { type FetchOptions, fetch } from '../../src/application/commands/fetch.js';
import { backendTransport } from './http-backend-transport.js';
import { GIT_AVAILABLE, git, runGit } from './interop-helpers.js';

const PEER_URL = 'https://example.com/peer.git';
const SHORT_URL = 'https://example.com/peer';

let root: string;
let peerRoot: string;
let peerPath: string;

beforeAll(() => {
  if (!GIT_AVAILABLE) return;
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'tsgit-interop-fetch-head-')));
  peerRoot = path.join(root, 'peer');
  peerPath = path.join(peerRoot, 'peer.git');
  const work = path.join(root, 'work');
  runGit(['init', '-q', '-b', 'main', work]);
  runGit(['-C', work, 'commit', '-q', '--allow-empty', '-m', 'a']);
  runGit(['-C', work, 'branch', 'b2']);
  runGit(['-C', work, 'tag', 'v1']);
  runGit(['-C', work, 'tag', '-a', '-m', 't', 'va']);
  runGit(['-C', work, 'commit', '-q', '--allow-empty', '-m', 'b']);
  runGit(['clone', '-q', '--bare', work, peerPath]);
});

afterAll(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

/** One repository per tool, configured alike but for the url each one reaches the peer by. */
const setUp = (label: string, config: ReadonlyArray<readonly [string, string]>) => {
  const dirs = {
    ours: path.join(root, `${label}-ours`),
    theirs: path.join(root, `${label}-theirs`),
  };
  for (const [dir, url] of [
    [dirs.ours, PEER_URL],
    [dirs.theirs, peerPath],
  ] as const) {
    runGit(['init', '-q', '-b', 'main', dir]);
    runGit(['-C', dir, 'remote', 'add', 'origin', url]);
    for (const [key, value] of config) runGit(['-C', dir, 'config', '--add', key, value]);
  }
  return dirs;
};

const fetchHead = (dir: string): string =>
  readFileSync(path.join(dir, '.git', 'FETCH_HEAD'), 'utf8');

const trackingRefs = (dir: string): string =>
  git(dir, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/remotes', 'refs/heads');

describe.skipIf(!GIT_AVAILABLE)('fetch FETCH_HEAD interop', () => {
  describe.each([
    { label: 'default', config: [], opts: {}, args: [] },
    {
      label: 'upstream',
      config: [
        ['branch.main.remote', 'origin'],
        ['branch.main.merge', 'refs/heads/b2'],
      ],
      opts: {},
      args: [],
    },
    {
      label: 'exact-first',
      config: [
        ['remote.origin.fetch', 'refs/heads/b2:refs/remotes/origin/b2'],
        ['remote.origin.fetch', 'refs/heads/main:refs/remotes/origin/main'],
      ],
      opts: {},
      args: [],
    },
    { label: 'cli', config: [], opts: { refspecs: ['main', 'b2'] }, args: ['main', 'b2'] },
    {
      label: 'cli-refmap',
      config: [],
      opts: { refspecs: ['main'], refmap: ['refs/heads/*:refs/remotes/rm/*'] },
      args: ['--refmap=refs/heads/*:refs/remotes/rm/*', 'main'],
    },
    {
      label: 'cli-empty-refmap',
      config: [],
      opts: { refspecs: ['main'], refmap: [''] },
      args: ['--refmap=', 'main'],
    },
  ] as ReadonlyArray<{
    label: string;
    config: ReadonlyArray<readonly [string, string]>;
    opts: FetchOptions;
    args: ReadonlyArray<string>;
  }>)('Given the $label fetch configuration', ({ label, config, opts, args }) => {
    describe('When both tools fetch from origin', () => {
      it('Then FETCH_HEAD and the tracking refs agree', async () => {
        // Arrange
        const { ours, theirs } = setUp(label, config);
        const ctx = {
          ...createNodeContext({ workDir: ours }),
          transport: backendTransport(peerRoot),
        };
        const sut = fetch;
        git(theirs, 'fetch', '-q', 'origin', ...args);
        const expected = fetchHead(theirs).replaceAll(peerPath.slice(0, -'.git'.length), SHORT_URL);

        // Act
        await sut(ctx, { remote: 'origin', ...opts });

        // Assert
        expect(fetchHead(ours)).toBe(expected);
        expect(trackingRefs(ours)).toBe(
          trackingRefs(theirs).replace(/refs\/remotes\/origin\/HEAD [0-9a-f]+\n?/, ''),
        );
      });
    });
  });
});
