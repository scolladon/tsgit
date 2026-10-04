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
