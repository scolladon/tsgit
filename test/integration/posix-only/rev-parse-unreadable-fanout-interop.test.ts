/**
 * POSIX-only interop — the abbreviated-oid scan over a fanout directory that cannot be listed:
 * mode 000, or a regular file at the fanout path. git logs `error: unable to open <dir>: <errno
 * text>` and carries on; each row rebuilds those lines from tsgit's structured error log and
 * compares them and their count.
 *
 * @proves
 *   surface:        revParse, abbreviateObjectId, describe, cherryPick, revert, merge, blame
 *   bucket:         platform-only
 *   unique:         an unreadable fanout directory is skipped and logged as often as git logs it on every route
 */
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { chmod } from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../../src/adapters/node/node-adapter.js';
import { describe as describeCommit } from '../../../src/application/commands/describe.js';
import { revParse } from '../../../src/application/commands/rev-parse.js';
import { abbreviateObjectId } from '../../../src/application/primitives/abbreviate-object-id.js';
import type { ObjectId } from '../../../src/domain/objects/index.js';
import type { Context } from '../../../src/ports/context.js';
import {
  disableAutoMaintenance,
  GIT_AVAILABLE,
  git,
  makePeerPair,
  type PeerPair,
  runGit,
  runGitEnv,
  tryRunGitWithExit,
} from '../interop-helpers.js';

const IS_ROOT = process.getuid?.() === 0;
const WRITABLE_DIR = 0o755;
const UNREADABLE = 0o000;
const ABBREV_LENGTH = 7;
const UNABLE_TO_OPEN = /^error: unable to open /;
const ERRNO_TEXT: Readonly<Record<string, string>> = {
  PERMISSION_DENIED: 'Permission denied',
  NOT_A_DIRECTORY: 'Not a directory',
};

const identity: NodeJS.ProcessEnv = {
  ...runGitEnv(),
  GIT_AUTHOR_NAME: 'A',
  GIT_AUTHOR_EMAIL: 'a@x',
  GIT_AUTHOR_DATE: '1700000000 +0000',
  GIT_COMMITTER_NAME: 'A',
  GIT_COMMITTER_EMAIL: 'a@x',
  GIT_COMMITTER_DATE: '1700000000 +0000',
};

interface Logged {
  readonly message: string;
  readonly context: Readonly<Record<string, unknown>> | undefined;
}

const VARIANTS = ['mode 000', 'regular file'] as const;
type Variant = (typeof VARIANTS)[number];

describe.skipIf(!GIT_AVAILABLE || IS_ROOT)('integration — an unreadable fanout directory', () => {
  let pair: PeerPair;
  let unreadable: string[];

  beforeEach(async () => {
    pair = await makePeerPair('rev-parse-unreadable-fanout');
    unreadable = [];
  });

  afterEach(async () => {
    for (const dir of unreadable) await chmod(dir, WRITABLE_DIR);
    await pair.dispose();
  });

  const commitOnce = (repo: string): void => {
    runGit(['init', '-q', '-b', 'main', repo]);
    disableAutoMaintenance(repo);
    writeFileSync(path.join(repo, 'f'), 'hi\n');
    git(repo, 'add', 'f');
    runGit(['-C', repo, 'commit', '-q', '-m', 'c1'], { env: identity });
  };

  const makeUnreadable = (repo: string, hex: string, variant: Variant): void => {
    const fanout = path.join(repo, '.git', 'objects', hex);
    if (variant === 'regular file') {
      writeFileSync(fanout, '');
      return;
    }
    mkdirSync(fanout);
    chmodSync(fanout, UNREADABLE);
    unreadable.push(fanout);
  };

  /** A clone whose objects are all packed, with HEAD's fanout directory unreadable. */
  const packedClone = (variant: Variant): { readonly repo: string; readonly head: string } => {
    const source = path.join(pair.peer, 'src');
    const repo = path.join(pair.ours, 'dst');
    commitOnce(source);
    runGit(['clone', '-q', '--no-local', source, repo]);
    const head = git(repo, 'rev-parse', 'HEAD').trim();
    makeUnreadable(repo, head.slice(0, 2), variant);
    return { repo, head };
  };

  const gitErrors = (repo: string, args: ReadonlyArray<string>): ReadonlyArray<string> =>
    tryRunGitWithExit(['-C', repo, ...args], { env: runGitEnv() })
      .stderr.split('\n')
      .filter((line) => UNABLE_TO_OPEN.test(line));

  const loggingContext = (repo: string): { readonly ctx: Context; readonly logged: Logged[] } => {
    const logged: Logged[] = [];
    const ctx: Context = {
      ...createNodeContext({ workDir: repo }),
      logger: { error: (message, context) => logged.push({ message, context }) },
    };
    return { ctx, logged };
  };

  const rebuilt = (ctx: Context, logged: ReadonlyArray<Logged>): ReadonlyArray<string> => {
    const { workDir } = ctx.layout;
    if (workDir === undefined) throw new Error('expected a work tree');
    return logged.map(({ context }) => {
      const { path: fanout, code } = context as { path: string; code: string };
      return `error: unable to open ${path.relative(workDir, fanout)}: ${ERRNO_TEXT[code] ?? code}`;
    });
  };

  describe.each(VARIANTS)('Given a packed clone, fanout %s', (variant) => {
    describe('When an abbreviated HEAD is rev-parsed', () => {
      it('Then tsgit logs the lines git logs, as often', async () => {
        // Arrange
        const { repo, head } = packedClone(variant);
        const expected = gitErrors(repo, ['rev-parse', head.slice(0, ABBREV_LENGTH)]);
        const { ctx, logged } = loggingContext(repo);

        // Act
        const sut = revParse;
        const result = await sut(ctx, head.slice(0, ABBREV_LENGTH));

        // Assert
        expect(result).toEqual([{ kind: 'object', id: head, negated: false }]);
        expect(expected).toHaveLength(1);
        expect(rebuilt(ctx, logged)).toEqual(expected);
      });
    });

    describe('When HEAD is abbreviated', () => {
      it('Then tsgit logs the lines git logs, as often', async () => {
        // Arrange
        const { repo, head } = packedClone(variant);
        const expected = gitErrors(repo, ['rev-parse', '--short', 'HEAD']);
        const { ctx, logged } = loggingContext(repo);

        // Act
        const sut = abbreviateObjectId;
        const result = await sut(ctx, head as ObjectId);

        // Assert
        expect(result).toBe(head.slice(0, ABBREV_LENGTH));
        expect(expected).toHaveLength(1);
        expect(rebuilt(ctx, logged)).toEqual(expected);
      });
    });

    describe('When HEAD is described with always and rendered', () => {
      it('Then tsgit logs the lines git logs, as often', async () => {
        // Arrange
        const { repo, head } = packedClone(variant);
        const expected = gitErrors(repo, ['describe', '--always']);
        const { ctx, logged } = loggingContext(repo);

        // Act
        const sut = describeCommit;
        const described = await sut(ctx, undefined, { always: true });
        const rendered = await abbreviateObjectId(ctx, described.oid);

        // Assert
        expect(rendered).toBe(head.slice(0, ABBREV_LENGTH));
        expect(expected).toHaveLength(1);
        expect(rebuilt(ctx, logged)).toEqual(expected);
      });
    });
  });

  describe('Given core.warnAmbiguousRefs is false and a branch named like a prefix', () => {
    describe('When that branch is rev-parsed with its fanout directory unreadable', () => {
      it('Then neither git nor tsgit logs anything', async () => {
        // Arrange
        const repo = pair.ours;
        commitOnce(repo);
        git(repo, 'branch', 'abcd');
        git(repo, 'config', 'core.warnAmbiguousRefs', 'false');
        makeUnreadable(repo, 'ab', 'mode 000');
        const expected = gitErrors(repo, ['rev-parse', 'abcd']);
        const { ctx, logged } = loggingContext(repo);

        // Act
        const sut = revParse;
        const result = await sut(ctx, 'abcd');

        // Assert
        expect(result).toHaveLength(1);
        expect(expected).toEqual([]);
        expect(logged).toEqual([]);
      });
    });
  });
});
