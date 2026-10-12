/**
 * Cross-tool interop — the messages a conflicted rebase stop leaves behind.
 * git writes the stop message to `MERGE_MSG` as well as `rebase-merge/message`;
 * a squash/fixup meld stop keeps the combined message (`message-squash`) with
 * no conflicts list, and `message-fixup` holds the group base's message while
 * every melded member is a plain fixup. Every row replays the same todo in two
 * repositories, stops each tool on the same conflict, and compares the files.
 *
 * @proves
 *   surface:        rebase
 *   bucket:         cross-tool-interop
 *   unique:         a rebase conflict stop writes MERGE_MSG, message and message-fixup as git does
 *   interopSurface: rebase
 */

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RebaseInstruction } from '../../src/index.node.js';
import { openRepository } from '../../src/index.node.js';
import { GIT_AVAILABLE, runGit, runGitEnv, tryRunGitWithExit } from './interop-helpers.js';

const ROW_TIMEOUT = 60_000;
const EPOCH = 1_700_000_000;
const DATED_ENV = {
  ...runGitEnv(),
  GIT_AUTHOR_NAME: 'A',
  GIT_AUTHOR_EMAIL: 'a@x',
  GIT_COMMITTER_NAME: 'A',
  GIT_COMMITTER_EMAIL: 'a@x',
  GIT_AUTHOR_DATE: `${EPOCH} +0000`,
  GIT_COMMITTER_DATE: `${EPOCH} +0000`,
  GIT_EDITOR: 'true',
};

const STOP_FILES = [
  'MERGE_MSG',
  'rebase-merge/message',
  'rebase-merge/message-squash',
  'rebase-merge/message-fixup',
] as const;

let root: string;

const dated = (dir: string, ...args: ReadonlyArray<string>): string =>
  runGit(['-C', dir, ...args], { env: DATED_ENV });

const commitFile = (dir: string, file: string, message: ReadonlyArray<string>): void => {
  writeFileSync(path.join(dir, file), `${file}-${message[0]}\n`);
  dated(dir, 'add', file);
  dated(dir, 'commit', '-q', ...message.flatMap((paragraph) => ['-m', paragraph]));
};

/** base → side: c0 (a), c1 (b), c2 (f, conflicting with main's f). */
const setUp = (dir: string): ReadonlyArray<string> => {
  runGit(['init', '-q', '-b', 'main', dir], { env: DATED_ENV });
  dated(dir, 'config', 'user.name', 'A');
  dated(dir, 'config', 'user.email', 'a@x');
  commitFile(dir, 'f', ['base']);
  dated(dir, 'checkout', '-q', '-b', 'side');
  commitFile(dir, 'a', ['c0', 'c0 body']);
  commitFile(dir, 'b', ['c1']);
  commitFile(dir, 'f', ['c2']);
  dated(dir, 'checkout', '-q', 'main');
  commitFile(dir, 'f', ['main']);
  dated(dir, 'checkout', '-q', 'side');
  return ['side~2', 'side~1', 'side'].map((rev) => dated(dir, 'rev-parse', rev).trim());
};

type Action = RebaseInstruction['action'];

const ROWS: ReadonlyArray<{ readonly label: string; readonly actions: ReadonlyArray<Action> }> = [
  { label: 'a pick', actions: ['pick', 'pick', 'pick'] },
  { label: 'a fixup after its pick', actions: ['pick', 'pick', 'fixup'] },
  { label: 'a second fixup', actions: ['pick', 'fixup', 'fixup'] },
  { label: 'a squash', actions: ['pick', 'pick', 'squash'] },
  { label: 'a fixup after a squash', actions: ['pick', 'squash', 'fixup'] },
];

const stopFiles = (dir: string): ReadonlyArray<string> =>
  STOP_FILES.map((file) => {
    const full = path.join(dir, '.git', file);
    return existsSync(full) ? `${file}:\n${readFileSync(full, 'utf8')}` : `${file}: absent`;
  });

const twin = async (label: string, actions: ReadonlyArray<Action>) => {
  const slug = label.replaceAll(/\W+/g, '-');
  const theirs = path.join(root, `${slug}-git`);
  const ours = path.join(root, `${slug}-ts`);
  const oids = setUp(theirs);
  setUp(ours);
  const todo = actions.map((action, i) => `${action} ${oids[i]} x\n`).join('');
  const todoFile = path.join(root, `${slug}.todo`);
  writeFileSync(todoFile, todo);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(EPOCH * 1000);
  const repo = await openRepository({ cwd: ours });
  const interactive = actions.map((action, i) => ({ action, oid: oids.at(i) ?? '' }));
  return { theirs, ours, todoFile, repo, interactive };
};

beforeAll(() => {
  if (!GIT_AVAILABLE) return;
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'tsgit-interop-rebase-stop-msg-')));
});

afterAll(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe.skipIf(!GIT_AVAILABLE)('rebase stop messages interop', () => {
  describe.each(ROWS)('Given $label that conflicts', ({ label, actions }) => {
    describe('When both tools stop on it', () => {
      it(
        'Then MERGE_MSG, message, message-squash and message-fixup match git',
        async () => {
          // Arrange
          const { theirs, ours, todoFile, repo, interactive } = await twin(label, actions);

          // Act
          const sequenceEditor = `cp ${todoFile}`;
          tryRunGitWithExit(
            ['-C', theirs, '-c', `sequence.editor=${sequenceEditor}`, 'rebase', '-i', 'main'],
            {
              env: DATED_ENV,
            },
          );
          await repo.rebase.run({ upstream: 'main', interactive });

          // Assert
          expect(stopFiles(ours)).toEqual(stopFiles(theirs));
        },
        ROW_TIMEOUT,
      );
    });
  });

  describe('Given a tsgit stop on a fixup after its pick', () => {
    describe('When git continues it', () => {
      it(
        'Then git folds the fixup into its pick, as it does from its own stop',
        async () => {
          // Arrange
          const label = 'continued fixup';
          const { theirs, ours, todoFile, repo, interactive } = await twin(label, [
            'pick',
            'pick',
            'fixup',
          ]);
          const sequenceEditor = `cp ${todoFile}`;
          tryRunGitWithExit(
            ['-C', theirs, '-c', `sequence.editor=${sequenceEditor}`, 'rebase', '-i', 'main'],
            {
              env: DATED_ENV,
            },
          );
          await repo.rebase.run({ upstream: 'main', interactive });
          for (const dir of [theirs, ours]) {
            writeFileSync(path.join(dir, 'f'), 'resolved\n');
            dated(dir, 'add', 'f');
          }

          // Act
          for (const dir of [theirs, ours]) dated(dir, 'rebase', '--continue');

          // Assert
          const history = (dir: string) => dated(dir, 'log', '--format=%s%n%b%T', 'main..');
          expect(history(ours)).toBe(history(theirs));
        },
        ROW_TIMEOUT,
      );
    });
  });
});
