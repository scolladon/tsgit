/**
 * Cross-tool interop — push's object enumeration against git's send-pack,
 * which feeds `pack-objects --revs` and types each object as its walk meets
 * it. A local commit naming a blob as its tree or parent, or naming a parent
 * the store lacks, kills git's pack-objects before a byte is sent; both tools
 * push to their own bare peer served by `git http-backend`, and both peers are
 * left without the ref.
 *
 * Before any pack, git measures each update's fast-forward — forced or not —
 * by looking both ends up into the push's object table, then walking: a walk
 * parent whose pointers that table already typed otherwise fails to parse, and
 * git dies on it before the peer moves.
 *
 * A ref git refuses to push — not a fast-forward, an end that is not a
 * commit, an advertised end missing locally, an existing tag, a stale lease —
 * is reported per ref while the rest are sent, and its new value still feeds
 * the pack; an atomic push instead fails every other ref and sends nothing.
 *
 * @proves
 *   surface:        push
 *   bucket:         cross-tool-interop
 *   unique:         push enumerates its pack with git's typed walk and refuses exactly where git's pack-objects dies
 *   interopSurface: closure
 */
import { cpSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { push } from '../../src/application/commands/push.js';
import type { ObjectId } from '../../src/domain/objects/index.js';
import type { Context } from '../../src/ports/context.js';
import { backendTransport } from './http-backend-transport.js';
import { GIT_AVAILABLE, runGit, tryRunGitWithExit } from './interop-helpers.js';

const PEER_URL = 'https://example.com/peer.git';
const IDENT_LINES = 'author a <a@b> 1700000000 +0000\ncommitter a <a@b> 1700000000 +0000\n\nm\n';
const ABSENT_PARENT = `cd${'0'.repeat(38)}`;

let root: string;
let count = 0;

beforeAll(() => {
  if (!GIT_AVAILABLE) return;
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'tsgit-interop-push-types-')));
});

afterAll(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

const freshDir = (name: string): string => {
  count += 1;
  return path.join(root, `${name}-${count}`);
};

/** A bare peer under its own project root, accepting pushes over http-backend. */
const makePeer = (): { readonly root: string; readonly bare: string } => {
  const peerRoot = freshDir('peer');
  const bare = path.join(peerRoot, 'peer.git');
  runGit(['init', '-q', '--bare', '-b', 'main', bare]);
  runGit(['-C', bare, 'config', 'http.receivepack', 'true']);
  return { root: peerRoot, bare };
};

/** A commit stored as spelt, naming `tree` and `parents` whatever they are. */
const writeLiteralCommit = (dir: string, tree: string, parents: ReadonlyArray<string>): string =>
  runGit(['-C', dir, 'hash-object', '-t', 'commit', '-w', '--stdin', '--literally'], {
    input: `tree ${tree}\n${parents.map((p) => `parent ${p}\n`).join('')}${IDENT_LINES}`,
  }).trim();

/** A repository whose `main` is the commit `naming` builds from a stored blob. */
const buildRepo = (naming: (dir: string, blob: string) => string): string => {
  const dir = freshDir('repo');
  runGit(['init', '-q', '-b', 'main', dir]);
  runGit(['-C', dir, 'remote', 'add', 'origin', PEER_URL]);
  const blob = runGit(['-C', dir, 'hash-object', '-w', '--stdin'], { input: 'hi\n' }).trim();
  runGit(['-C', dir, 'update-ref', 'refs/heads/main', naming(dir, blob)]);
  return dir;
};

const emptyTreeOf = (dir: string): string => runGit(['-C', dir, 'mktree'], { input: '' }).trim();

/** git's pack-objects death, rebuilt from the logged `error:` lines and the refusal's data. */
const deathOf = (logged: ReadonlyArray<string>, error: unknown): string => {
  const data = (error as { data?: { code?: string; commit?: string; id?: string } }).data;
  const fatal =
    data?.code === 'BAD_TREE_OBJECT'
      ? `fatal: bad tree object ${data.id}`
      : `fatal: Failed to traverse parents of commit ${data?.commit}`;
  return `${logged.map((line) => `error: ${line}\n`).join('')}${fatal}\n`;
};

const capturing = (dir: string): { readonly ctx: Context; readonly logged: string[] } => {
  const logged: string[] = [];
  const base = createNodeContext({ workDir: dir });
  return { ctx: { ...base, logger: { error: (line: string) => logged.push(line) } }, logged };
};

const refsOf = (bare: string): string =>
  runGit(['-C', bare, 'for-each-ref', '--format=%(refname)']).trim();

describe.skipIf(!GIT_AVAILABLE)('push interop — object types assigned while enumerating', () => {
  describe.each([
    ['names a blob as its tree', (dir: string, blob: string) => writeLiteralCommit(dir, blob, [])],
    [
      'names a blob as its parent',
      (dir: string, blob: string) => writeLiteralCommit(dir, emptyTreeOf(dir), [blob]),
    ],
    [
      'names a parent the store lacks',
      (dir: string) => writeLiteralCommit(dir, emptyTreeOf(dir), [ABSENT_PARENT]),
    ],
  ] as const)('Given a branch whose commit %s', (_label, naming) => {
    describe('When both tools push it to a bare peer', () => {
      it('Then both die enumerating the pack the same way and leave the peer without the ref', async () => {
        // Arrange
        const dir = buildRepo(naming);
        const gitPeer = makePeer();
        const peer = makePeer();
        const git = tryRunGitWithExit(['-C', dir, 'push', gitPeer.bare, 'main']);
        const { ctx, logged } = capturing(dir);
        const sut = push;

        // Act
        let caught: unknown;
        try {
          await sut(
            { ...ctx, transport: backendTransport(peer.root) },
            { remote: 'origin', refspecs: ['main'] },
          );
        } catch (error) {
          caught = error;
        }

        // Assert
        expect(git.exitCode).not.toBe(0);
        expect(git.stderr.startsWith(deathOf(logged, caught))).toBe(true);
        expect(refsOf(gitPeer.bare)).toBe('');
        expect(refsOf(peer.bare)).toBe('');
      });
    });
  });
});

/** A bare peer whose `main` already stands on `advertised`, its objects copied from `dir`. */
const makeSeededPeer = (
  dir: string,
  advertised: string,
): { readonly root: string; readonly bare: string } => {
  const peer = makePeer();
  cpSync(path.join(dir, '.git', 'objects'), path.join(peer.bare, 'objects'), { recursive: true });
  runGit(['-C', peer.bare, 'update-ref', 'refs/heads/main', advertised]);
  return peer;
};

describe.skipIf(!GIT_AVAILABLE)(
  'push interop — fast-forward walk against the push object table',
  () => {
    describe.each([
      ['unforced', [], {}],
      ['forced', ['--force'], { force: true }],
    ] as const)(
      "Given the local tip's parent whose own parent is the tree the tip carries, %s",
      (_label, flags, opts) => {
        describe('When both tools push it over an unrelated advertised commit', () => {
          it('Then both fail to parse that parent in the walk and the peer keeps its ref', async () => {
            // Arrange
            let parent = '';
            let advertised = '';
            const dir = buildRepo((repo, blob) => {
              const tree = emptyTreeOf(repo);
              const parentTree = runGit(['-C', repo, 'mktree'], {
                input: `100644 blob ${blob}\tb\n`,
              }).trim();
              parent = writeLiteralCommit(repo, parentTree, [tree]);
              advertised = writeLiteralCommit(repo, parentTree, []);
              return writeLiteralCommit(repo, tree, [parent]);
            });
            const gitPeer = makeSeededPeer(dir, advertised);
            const peer = makeSeededPeer(dir, advertised);
            const git = tryRunGitWithExit(['-C', dir, 'push', ...flags, gitPeer.bare, 'main']);
            const { ctx, logged } = capturing(dir);
            const tree = emptyTreeOf(dir);
            const sut = push;

            // Act
            let caught: unknown;
            try {
              await sut(
                { ...ctx, transport: backendTransport(peer.root) },
                { remote: 'origin', refspecs: ['main'], ...opts },
              );
            } catch (error) {
              caught = error;
            }

            // Assert
            const typingLines = [
              `object ${tree} is a tree, not a commit`,
              `bad parent ${tree} in commit ${parent}`,
            ];
            expect(git.exitCode).toBe(128);
            expect(
              git.stderr.startsWith(
                `${typingLines.map((line) => `error: ${line}\n`).join('')}error: could not parse commit ${parent}\n`,
              ),
            ).toBe(true);
            expect(logged).toEqual(typingLines);
            expect((caught as { data?: unknown }).data).toEqual({
              code: 'COMMIT_PARSE_FAILED',
              id: parent,
            });
            expect(runGit(['-C', gitPeer.bare, 'rev-parse', 'main']).trim()).toBe(advertised);
            expect(runGit(['-C', peer.bare, 'rev-parse', 'main']).trim()).toBe(advertised);
          });
        });
      },
    );
  },
);

/** git's porcelain wording for each client-side rejection. */
const REJECTION_TEXT: Readonly<Record<string, string>> = {
  'non-fast-forward': 'non-fast-forward',
  'needs-force': 'needs force',
  'fetch-first': 'fetch first',
  'already-exists': 'already exists',
  'stale-info': 'stale info',
  'atomic-push-failed': 'atomic push failed',
};

/** The repository and the peer both tools push to, seeded identically. */
const buildRejectionScene = (): {
  readonly dir: string;
  readonly gitPeer: { readonly root: string; readonly bare: string };
  readonly peer: { readonly root: string; readonly bare: string };
} => {
  const dir = buildRepo((repo, blob) => {
    const tree = runGit(['-C', repo, 'mktree'], { input: `100644 blob ${blob}\ta\n` }).trim();
    return writeLiteralCommit(repo, tree, []);
  });
  const base = runGit(['-C', dir, 'rev-parse', 'main']).trim();
  const tree = runGit(['-C', dir, 'rev-parse', 'main^{tree}']).trim();
  const other = writeLiteralCommit(dir, emptyTreeOf(dir), []);
  const gitPeer = makePeer();
  const seeds = [`${base}:refs/heads/seed`, `${other}:refs/heads/main`, `${other}:refs/tags/v1`];
  runGit(['-C', dir, 'push', '-q', gitPeer.bare, ...seeds, `${other}:refs/heads/ahead`]);
  runGit(['-C', gitPeer.bare, 'update-ref', 'refs/misc/tree', tree]);
  const ahead = writeLiteralCommit(gitPeer.bare, tree, [other]);
  runGit(['-C', gitPeer.bare, 'update-ref', 'refs/heads/ahead', ahead]);
  const peer = { root: freshDir('peer'), bare: '' };
  cpSync(gitPeer.root, peer.root, { recursive: true });
  const blob = runGit(['-C', dir, 'hash-object', '-w', '--stdin'], { input: 'r\n' }).trim();
  const tip = runGit(['-C', dir, 'mktree'], { input: `100644 blob ${blob}\tr\n` }).trim();
  runGit(['-C', dir, 'update-ref', 'refs/heads/main', writeLiteralCommit(dir, tip, [base])]);
  for (const name of ['refs/heads/tree', 'refs/heads/ahead', 'refs/heads/new', 'refs/tags/v1']) {
    runGit(['-C', dir, 'update-ref', name, base]);
  }
  return { dir, gitPeer, peer: { ...peer, bare: path.join(peer.root, 'peer.git') } };
};

const objectsOf = (bare: string): string =>
  runGit(['-C', bare, 'cat-file', '--batch-all-objects', '--batch-check=%(objectname)']);

describe.skipIf(!GIT_AVAILABLE)('push interop — client-side rejections per ref', () => {
  describe('Given refs git rejects for each local reason beside a new ref', () => {
    describe('When both tools push them to identical peers', () => {
      it('Then both report the same per-ref verdicts, send the same objects and move the same refs', async () => {
        // Arrange
        const { dir, gitPeer, peer } = buildRejectionScene();
        const sources: Readonly<Record<string, string>> = {
          'refs/heads/main': 'refs/heads/main',
          'refs/misc/tree': 'refs/heads/tree',
          'refs/heads/ahead': 'refs/heads/ahead',
          'refs/tags/v1': 'refs/tags/v1',
          'refs/heads/new': 'refs/heads/new',
        };
        const refspecs = ['main', 'tree:refs/misc/tree', 'ahead', 'refs/tags/v1', 'new'];
        const git = tryRunGitWithExit([
          '-C',
          dir,
          'push',
          '--porcelain',
          gitPeer.bare,
          ...refspecs,
        ]);
        const { ctx } = capturing(dir);
        const sut = push;

        // Act
        const result = await sut(
          { ...ctx, transport: backendTransport(peer.root) },
          { remote: 'origin', refspecs },
        );

        // Assert
        const rebuilt = result.pushedRefs.map((ref) =>
          ref.status === 'ok'
            ? `*\t${sources[ref.name]}:${ref.name}\t[new branch]`
            : `!\t${sources[ref.name]}:${ref.name}\t[rejected] (${REJECTION_TEXT[ref.rejection ?? '']})`,
        );
        const gitLines = git.stdout.split('\n').filter((line) => /^[*!]\t/.test(line));
        expect(git.exitCode).toBe(1);
        // git prints its accepted refs first, then its rejected ones, each in remote-ref order.
        const display = [
          ...rebuilt.filter((line) => line.startsWith('*')),
          ...rebuilt.filter((line) => line.startsWith('!')),
        ];
        expect(display).toEqual(gitLines);
        expect(objectsOf(peer.bare)).toBe(objectsOf(gitPeer.bare));
        expect(refsOf(peer.bare)).toBe(refsOf(gitPeer.bare));
      });
    });
  });
});

const refStateOf = (bare: string): string =>
  runGit(['-C', bare, 'for-each-ref', '--format=%(refname) %(objectname)']).trim();

/** git's porcelain `!` line for each rejected ref of a tsgit result. */
const rejectedLines = (
  pushedRefs: ReadonlyArray<{ readonly name: string; readonly rejection?: string }>,
): ReadonlyArray<string> =>
  pushedRefs
    .filter((ref) => ref.rejection !== undefined)
    .map(
      (ref) => `!\t${ref.name}:${ref.name}\t[rejected] (${REJECTION_TEXT[ref.rejection ?? '']})`,
    );

const gitRejectedLines = (stdout: string): ReadonlyArray<string> =>
  stdout.split('\n').filter((line) => line.startsWith('!\t'));

describe.skipIf(!GIT_AVAILABLE)('push interop — stale leases and atomic pushes', () => {
  describe('Given a lease that holds for one ref and is stale for another', () => {
    describe('When both tools push them to identical peers', () => {
      it('Then both reject the stale ref as stale info and move the other', async () => {
        // Arrange
        const { dir, gitPeer, peer } = buildRejectionScene();
        const expected = runGit(['-C', gitPeer.bare, 'rev-parse', 'refs/heads/main']).trim();
        const git = tryRunGitWithExit([
          '-C',
          dir,
          'push',
          '--porcelain',
          `--force-with-lease=refs/heads/main:${expected}`,
          `--force-with-lease=refs/heads/ahead:${expected}`,
          gitPeer.bare,
          'main',
          'ahead',
        ]);
        const { ctx } = capturing(dir);
        const sut = push;

        // Act
        const result = await sut(
          { ...ctx, transport: backendTransport(peer.root) },
          { remote: 'origin', refspecs: ['main', 'ahead'], forceWithLease: expected as ObjectId },
        );

        // Assert
        expect(git.exitCode).toBe(1);
        expect(rejectedLines(result.pushedRefs)).toEqual(gitRejectedLines(git.stdout));
        expect(refStateOf(peer.bare)).toBe(refStateOf(gitPeer.bare));
      });
    });
  });

  describe('Given an automatic lease over a tag and a branch with no tracking ref, both on the remote', () => {
    describe('When both tools push them beside a new ref to identical peers', () => {
      it('Then both expect each to be absent, reject both as stale info and move the new ref', async () => {
        // Arrange
        const { dir, gitPeer, peer } = buildRejectionScene();
        const refspecs = ['refs/tags/v1', 'new', 'ahead'];
        const git = tryRunGitWithExit([
          '-C',
          dir,
          'push',
          '--porcelain',
          '--force-with-lease',
          gitPeer.bare,
          ...refspecs,
        ]);
        const { ctx } = capturing(dir);
        const sut = push;

        // Act
        const result = await sut(
          { ...ctx, transport: backendTransport(peer.root) },
          { remote: 'origin', refspecs, forceWithLease: 'auto' },
        );

        // Assert
        expect(git.exitCode).toBe(1);
        expect(rejectedLines(result.pushedRefs)).toEqual(gitRejectedLines(git.stdout));
        expect(refStateOf(peer.bare)).toBe(refStateOf(gitPeer.bare));
      });
    });
  });

  describe('Given an atomic push of a new ref beside a non-fast-forward one', () => {
    describe('When both tools push them to identical peers', () => {
      it('Then both fail the new ref, move nothing and log the same error', async () => {
        // Arrange
        const { dir, gitPeer, peer } = buildRejectionScene();
        const git = tryRunGitWithExit([
          '-C',
          dir,
          'push',
          '--porcelain',
          '--atomic',
          gitPeer.bare,
          'main',
          'new',
        ]);
        const { ctx, logged } = capturing(dir);
        const sut = push;

        // Act
        const result = await sut(
          { ...ctx, transport: backendTransport(peer.root) },
          { remote: 'origin', refspecs: ['main', 'new'], atomic: true },
        );

        // Assert
        expect(git.exitCode).toBe(1);
        expect(rejectedLines(result.pushedRefs)).toEqual(gitRejectedLines(git.stdout));
        expect(logged.map((line) => `error: ${line}`)).toEqual(
          git.stderr.split('\n').filter((line) => line.startsWith('error: atomic')),
        );
        expect(refStateOf(peer.bare)).toBe(refStateOf(gitPeer.bare));
        expect(objectsOf(peer.bare)).toBe(objectsOf(gitPeer.bare));
      });
    });
  });
});
