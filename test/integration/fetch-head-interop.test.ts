/**
 * Cross-tool interop — the `FETCH_HEAD` a fetch writes. git's `get_ref_map`
 * marks the refs for merging — the current branch's configured upstream, an
 * exact first refspec, every command-line refspec — and `store_updated_refs`
 * lists them first, the rest `not-for-merge`, each described by its kind and
 * the shortened url; tags follow only into the fetched history, the ones whose
 * objects arrive with the pack appended by `backfill_tags`, and an unreachable
 * tag never. Command-line refspecs still update the tracking refs the
 * configured refspecs (or `--refmap`) map them onto. tsgit fetches through
 * `git http-backend`, git over a local path; the url each tool records is
 * swapped for one before the files are compared.
 *
 * @proves
 *   surface:        fetch
 *   bucket:         cross-tool-interop
 *   unique:         fetch writes FETCH_HEAD and honours command-line refspecs and refmap
 */
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { type FetchOptions, fetch } from '../../src/application/commands/fetch.js';
import { backendTransport, protocolV2BackendTransport } from './http-backend-transport.js';
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
  runGit(['-C', work, 'tag', 'tt', 'HEAD^{tree}']);
  const orphan = git(work, 'commit-tree', '-m', 'orphan', 'HEAD^{tree}').trim();
  runGit(['-C', work, 'tag', 'far', orphan]);
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
  git(
    dir,
    'for-each-ref',
    '--format=%(refname) %(objectname)',
    'refs/remotes',
    'refs/heads',
    'refs/tags',
  );

/** `refs/remotes/origin/HEAD`'s symref target and its reflog's old/new oids and message. */
const remoteHeadLog = (dir: string): ReadonlyArray<string> => {
  const log = path.join(dir, '.git', 'logs', 'refs', 'remotes', 'origin', 'HEAD');
  if (!existsSync(log)) return [];
  const entries = readFileSync(log, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0);
  const target = git(dir, 'symbolic-ref', 'refs/remotes/origin/HEAD');
  return [target, ...entries.map((line) => `${line.slice(0, 81)} ${line.split('\t')[1]}`)];
};

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
    {
      label: 'follow-never',
      config: [['remote.origin.followRemoteHEAD', 'never']],
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
      label: 'cli-storing',
      config: [],
      opts: { refspecs: ['main:refs/heads/x'] },
      args: ['main:refs/heads/x'],
    },
    {
      label: 'cli-empty-refmap',
      config: [],
      opts: { refspecs: ['main'], refmap: [''] },
      args: ['--refmap=', 'main'],
    },
    { label: 'cli-tag-word', config: [], opts: { refspecs: ['tag', 'v1'] }, args: ['tag', 'v1'] },
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
        expect(trackingRefs(ours)).toBe(trackingRefs(theirs));
        expect(remoteHeadLog(ours)).toEqual(remoteHeadLog(theirs));
      });
    });
  });
});

describe.skipIf(!GIT_AVAILABLE)('fetch of an object id interop', () => {
  describe.each([
    { label: 'oid-alone', specs: (oid: string) => [oid] },
    { label: 'oid-storing', specs: (oid: string) => [`${oid}:refs/heads/x`] },
  ])('Given the $label command-line refspec', ({ label, specs }) => {
    describe('When both tools fetch it from origin', () => {
      it('Then FETCH_HEAD, the stored refs and the followed tags agree', async () => {
        // Arrange
        const { ours, theirs } = setUp(label, []);
        const refspecs = specs(git(peerPath, 'rev-parse', 'main').trim());
        const ctx = {
          ...createNodeContext({ workDir: ours }),
          transport: backendTransport(peerRoot),
        };
        const sut = fetch;
        git(theirs, 'fetch', '-q', 'origin', ...refspecs);
        const expected = fetchHead(theirs).replaceAll(peerPath.slice(0, -'.git'.length), SHORT_URL);

        // Act
        await sut(ctx, { remote: 'origin', refspecs });

        // Assert
        expect(fetchHead(ours)).toBe(expected);
        expect(trackingRefs(ours)).toBe(trackingRefs(theirs));
      });
    });
  });
});

describe.skipIf(!GIT_AVAILABLE)('fetch of the remote HEAD over protocol v2 interop', () => {
  describe.each([
    { label: 'v2-head-cli', unset: false, opts: { refspecs: ['HEAD'] }, args: ['HEAD'] },
    { label: 'v2-no-fetch-refspec', unset: true, opts: {}, args: [] },
  ] as ReadonlyArray<{
    label: string;
    unset: boolean;
    opts: FetchOptions;
    args: ReadonlyArray<string>;
  }>)('Given the $label fetch over protocol v2', ({ label, unset, opts, args }) => {
    describe('When both tools fetch from origin', () => {
      it('Then FETCH_HEAD lists the remote HEAD as git lists it', async () => {
        // Arrange
        const { ours, theirs } = setUp(label, []);
        if (unset) {
          for (const dir of [ours, theirs]) {
            runGit(['-C', dir, 'config', '--unset', 'remote.origin.fetch']);
          }
        }
        const ctx = {
          ...createNodeContext({ workDir: ours }),
          transport: protocolV2BackendTransport(peerRoot),
        };
        const sut = fetch;
        git(theirs, '-c', 'protocol.version=2', 'fetch', '-q', 'origin', ...args);
        const expected = fetchHead(theirs).replaceAll(peerPath.slice(0, -'.git'.length), SHORT_URL);

        // Act
        await sut(ctx, { remote: 'origin', ...opts });

        // Assert
        expect(fetchHead(ours)).toBe(expected);
      });
    });
  });
});
