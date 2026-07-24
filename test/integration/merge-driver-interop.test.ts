/**
 * Cross-tool interop — custom merge drivers. Builds the same diverged graph in
 * a canonical-git peer and a tsgit repo with an identical `.gitattributes`
 * `merge=<driver>` mapping + `[merge "<driver>"]` config, runs the merge on both
 * tools, and asserts the resulting commit / index (`git ls-files --stage`) /
 * working tree agree byte-for-byte for: an external driver that resolves cleanly
 * (exit 0), an external driver that conflicts (exit ≠ 0), `-merge` binary
 * take-ours, a `merge=text` no-op, a user driver configured under a built-in name
 * (`text`/`binary`/`union`) overriding the built-in, a selected but driverless
 * section refusing lazily ("lacks command line"), and an absent registration
 * falling back to the built-in text conflict.
 *
 * @proves
 *   surface:        repo.merge.run
 *   bucket:         cross-tool-interop
 *   unique:         custom merge-driver resolution + invocation match git
 *   interopSurface: merge
 */
import { readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AuthorIdentity } from '../../src/domain/objects/index.js';
import { openRepository } from '../../src/index.node.js';
import type { Repository } from '../../src/repository.js';
import {
  GIT_AVAILABLE,
  lsStage,
  makePeerPair,
  type PeerPair,
  runGit,
  runGitEnv,
  tryRunGit,
} from './interop-helpers.js';

const AUTHOR: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const COMMIT_ENV: NodeJS.ProcessEnv = {
  ...runGitEnv(),
  GIT_AUTHOR_NAME: AUTHOR.name,
  GIT_AUTHOR_EMAIL: AUTHOR.email,
  GIT_AUTHOR_DATE: `${AUTHOR.timestamp} ${AUTHOR.timezoneOffset}`,
  GIT_COMMITTER_NAME: AUTHOR.name,
  GIT_COMMITTER_EMAIL: AUTHOR.email,
  GIT_COMMITTER_DATE: `${AUTHOR.timestamp} ${AUTHOR.timezoneOffset}`,
};

describe.skipIf(!GIT_AVAILABLE)('merge interop — custom merge drivers', () => {
  let pair: PeerPair;
  let repo: Repository;

  beforeEach(async () => {
    pair = await makePeerPair('merge-driver');
    runGit(['init', '-q', '-b', 'main', pair.peer]);
    repo = await openRepository({ cwd: pair.ours });
    await repo.init();
  });

  afterEach(async () => {
    await repo.dispose();
    await pair.dispose();
  });

  const writeBoth = async (rel: string, content: string): Promise<void> => {
    await writeFile(path.join(pair.peer, rel), content);
    await writeFile(path.join(pair.ours, rel), content);
  };

  const commitBoth = async (message: string, paths: ReadonlyArray<string>): Promise<void> => {
    runGit(['-C', pair.peer, 'add', ...paths]);
    await repo.add(paths);
    runGit(['-C', pair.peer, 'commit', '-q', '-m', message], {
      env: COMMIT_ENV,
    });
    await repo.commit({ message, author: AUTHOR, committer: AUTHOR });
  };

  const branchBoth = async (name: string): Promise<void> => {
    runGit(['-C', pair.peer, 'checkout', '-q', '-b', name]);
    await repo.branch.create({ name });
    await repo.checkout({ rev: name });
  };

  const checkoutBoth = async (rev: string): Promise<void> => {
    runGit(['-C', pair.peer, 'checkout', '-q', rev]);
    await repo.checkout({ rev });
  };

  const configureDriverBoth = (driver: string): void => {
    for (const dir of [pair.peer, pair.ours]) {
      runGit(['-C', dir, 'config', 'merge.custom.driver', driver]);
    }
  };

  const stageOf = (dir: string): string => lsStage(dir);
  const headOf = (dir: string): string => runGit(['-C', dir, 'rev-parse', 'HEAD']).trim();
  const read = (dir: string, rel: string): Promise<string> => readFile(path.join(dir, rel), 'utf8');

  /** Diverge data.txt: base, theirs, ours each whole-file-different (built-in would conflict). */
  const setupDiverged = async (attributes: string, driver?: string): Promise<void> => {
    if (driver !== undefined) configureDriverBoth(driver);
    await writeBoth('.gitattributes', attributes);
    await writeBoth('data.txt', 'base\n');
    await commitBoth('base', ['.gitattributes', 'data.txt']);
    await branchBoth('theirs');
    await writeBoth('data.txt', 'theirs\n');
    await commitBoth('theirs', ['data.txt']);
    await checkoutBoth('main');
    await writeBoth('data.txt', 'ours\n');
    await commitBoth('ours', ['data.txt']);
    // Fresh ctx so the merge reads the driver config written above.
    await repo.dispose();
    repo = await openRepository({ cwd: pair.ours });
  };

  describe('Given an external driver that resolves cleanly (exit 0)', () => {
    describe('When merging on both tools', () => {
      it('Then the driver output lands and the commit/index/worktree match git', async () => {
        // Arrange — driver takes theirs (`cp %B %A`); built-in would conflict.
        await setupDiverged('data.txt merge=custom\n', 'cp %B %A');

        // Act
        runGit(['-C', pair.peer, 'merge', '--no-ff', '-m', 'm', 'theirs'], {
          env: COMMIT_ENV,
        });
        const result = await repo.merge.run({
          rev: 'theirs',
          message: 'm',
          author: AUTHOR,
          committer: AUTHOR,
        });

        // Assert
        expect(result.kind).toBe('merge');
        expect(headOf(pair.ours)).toBe(headOf(pair.peer));
        expect(stageOf(pair.ours)).toBe(stageOf(pair.peer));
        expect(await read(pair.ours, 'data.txt')).toBe('theirs\n');
      });
    });
  });

  describe('Given an external driver that conflicts (exit ≠ 0)', () => {
    describe('When merging on both tools', () => {
      it('Then both leave the driver output + stage 1/2/3 index, matching git', async () => {
        // Arrange — driver writes theirs then exits non-zero (no `;`/`#`, so git
        // stores the command unquoted and both tools read it identically).
        await setupDiverged('data.txt merge=custom\n', 'cp %B %A && false');

        // Act — git's merge exits non-zero (conflict); tsgit returns a conflict.
        const peerMerge = tryRunGit(['-C', pair.peer, 'merge', '--no-ff', '-m', 'm', 'theirs'], {
          env: COMMIT_ENV,
        });
        const result = await repo.merge.run({ rev: 'theirs', message: 'm', author: AUTHOR });

        // Assert
        expect(peerMerge.ok).toBe(false);
        expect(result.kind).toBe('conflict');
        expect(headOf(pair.ours)).toBe(headOf(pair.peer));
        expect(stageOf(pair.ours)).toBe(stageOf(pair.peer));
        expect(await read(pair.ours, 'data.txt')).toBe('theirs\n');
      });
    });
  });

  describe('Given a `-merge` (binary) attribute', () => {
    describe('When both sides change the file', () => {
      it('Then both take ours and record a stage 1/2/3 conflict, matching git', async () => {
        // Arrange — `-merge` forces a take-ours conflict, no driver needed.
        await setupDiverged('data.txt -merge\n');

        // Act
        const peerMerge = tryRunGit(['-C', pair.peer, 'merge', '--no-ff', '-m', 'm', 'theirs'], {
          env: COMMIT_ENV,
        });
        const result = await repo.merge.run({ rev: 'theirs', message: 'm', author: AUTHOR });

        // Assert
        expect(peerMerge.ok).toBe(false);
        expect(result.kind).toBe('conflict');
        expect(stageOf(pair.ours)).toBe(stageOf(pair.peer));
        expect(await read(pair.ours, 'data.txt')).toBe('ours\n');
      });
    });
  });

  describe('Given a `merge=union` attribute on an overlapping change', () => {
    describe('When both sides change the same line', () => {
      it('Then both concatenate the two sides with no markers, matching git', async () => {
        // Arrange — ours and theirs overlap on the middle line (built-in would conflict);
        // union resolves cleanly by keeping both sides between the shared edges.
        await writeBoth('.gitattributes', 'file.txt merge=union\n');
        await writeBoth('file.txt', 'a\nb\nc\n');
        await commitBoth('base', ['.gitattributes', 'file.txt']);
        await branchBoth('theirs');
        await writeBoth('file.txt', 'a\nY\nc\n');
        await commitBoth('theirs', ['file.txt']);
        await checkoutBoth('main');
        await writeBoth('file.txt', 'a\nX\nc\n');
        await commitBoth('ours', ['file.txt']);

        // Act
        runGit(['-C', pair.peer, 'merge', '--no-ff', '-m', 'm', 'theirs'], {
          env: COMMIT_ENV,
        });
        const result = await repo.merge.run({
          rev: 'theirs',
          message: 'm',
          author: AUTHOR,
          committer: AUTHOR,
        });

        // Assert
        expect(result.kind).toBe('merge');
        expect(headOf(pair.ours)).toBe(headOf(pair.peer));
        expect(stageOf(pair.ours)).toBe(stageOf(pair.peer));
        expect(await read(pair.ours, 'file.txt')).toBe(await read(pair.peer, 'file.txt'));
        expect(await read(pair.ours, 'file.txt')).toBe('a\nX\nY\nc\n');
      });
    });
  });

  const BUILTIN_OVERRIDE_MATRIX: ReadonlyArray<{
    label: 'text' | 'binary' | 'union';
  }> = [{ label: 'text' }, { label: 'binary' }, { label: 'union' }];

  describe('Given a configured driver on a built-in merge-driver name', () => {
    describe('When merging on both tools', () => {
      it.each(BUILTIN_OVERRIDE_MATRIX)(
        'Then the configured driver overrides the built-in $label merge, matching git',
        async ({ label: builtinName }) => {
          // Arrange — driver takes theirs (`cp %B %A`); the built-in driver
          // would otherwise conflict / take ours / concatenate instead.
          for (const dir of [pair.peer, pair.ours]) {
            runGit(['-C', dir, 'config', `merge.${builtinName}.driver`, 'cp %B %A']);
          }
          await setupDiverged(`data.txt merge=${builtinName}\n`);

          // Act
          runGit(['-C', pair.peer, 'merge', '--no-ff', '-m', 'm', 'theirs'], {
            env: COMMIT_ENV,
          });
          const result = await repo.merge.run({
            rev: 'theirs',
            message: 'm',
            author: AUTHOR,
            committer: AUTHOR,
          });

          // Assert
          expect(result.kind).toBe('merge');
          expect(headOf(pair.ours)).toBe(headOf(pair.peer));
          expect(stageOf(pair.ours)).toBe(stageOf(pair.peer));
          expect(await read(pair.ours, 'data.txt')).toBe('theirs\n');
        },
      );
    });
  });

  describe('Given a `merge=text` attribute on non-overlapping edits', () => {
    describe('When the clean built-in merge runs on both tools', () => {
      it('Then it merges like a plain text merge and matches git', async () => {
        // Arrange — explicit text driver; disjoint edits merge cleanly.
        await writeBoth('.gitattributes', 'file.txt merge=text\n');
        await writeBoth('file.txt', 'line1\nline2\nline3\n');
        await commitBoth('base', ['.gitattributes', 'file.txt']);
        await branchBoth('theirs');
        await writeBoth('file.txt', 'line1\nline2\nTHEIRS\n');
        await commitBoth('theirs', ['file.txt']);
        await checkoutBoth('main');
        await writeBoth('file.txt', 'OURS\nline2\nline3\n');
        await commitBoth('ours', ['file.txt']);

        // Act
        runGit(['-C', pair.peer, 'merge', '--no-ff', '-m', 'm', 'theirs'], {
          env: COMMIT_ENV,
        });
        const result = await repo.merge.run({
          rev: 'theirs',
          message: 'm',
          author: AUTHOR,
          committer: AUTHOR,
        });

        // Assert
        expect(result.kind).toBe('merge');
        expect(headOf(pair.ours)).toBe(headOf(pair.peer));
        expect(stageOf(pair.ours)).toBe(stageOf(pair.peer));
        expect(await read(pair.ours, 'file.txt')).toBe('OURS\nline2\nTHEIRS\n');
      });
    });
  });

  describe('Given a selected merge driver that is registered but has no `driver` command', () => {
    describe('When both sides change the file differently', () => {
      it('Then both refuse lazily with "lacks command line", leaving ours and a clean index', async () => {
        // Arrange — `merge.x.name` is set (registers the section) but no `merge.x.driver`.
        for (const dir of [pair.peer, pair.ours]) {
          runGit(['-C', dir, 'config', 'merge.x.name', 'x']);
        }
        await setupDiverged('data.txt merge=x\n');

        // Act
        const peerMerge = tryRunGit(['-C', pair.peer, 'merge', '--no-ff', '-m', 'm', 'theirs'], {
          env: COMMIT_ENV,
        });
        let tsgitError: { data?: { code?: string; name?: string } } | undefined;
        try {
          await repo.merge.run({ rev: 'theirs', message: 'm', author: AUTHOR, committer: AUTHOR });
        } catch (err) {
          tsgitError = err as { data?: { code?: string; name?: string } };
        }

        // Assert
        expect(peerMerge.ok).toBe(false);
        expect(peerMerge.stderr).toContain('custom merge driver x lacks command line.');
        expect(tsgitError?.data?.code).toBe('MERGE_DRIVER_MISSING_COMMAND');
        expect(tsgitError?.data?.name).toBe('x');
        expect(await read(pair.ours, 'data.txt')).toBe('ours\n');
        expect(await read(pair.peer, 'data.txt')).toBe('ours\n');
        expect(stageOf(pair.ours)).toBe(stageOf(pair.peer));
        expect(stageOf(pair.ours)).not.toMatch(/ [1-3]\t/);
      });
    });
  });

  describe('Given an empty/absent driver registration for a `merge=<name>` attribute', () => {
    describe('When both sides change the file differently', () => {
      it('Then both fall back to the built-in text conflict identically', async () => {
        // Arrange — `merge=x` with no `merge.x.*` key configured on either tool.
        await setupDiverged('data.txt merge=x\n');

        // Act
        const peerMerge = tryRunGit(['-C', pair.peer, 'merge', '--no-ff', '-m', 'm', 'theirs'], {
          env: COMMIT_ENV,
        });
        const result = await repo.merge.run({ rev: 'theirs', message: 'm', author: AUTHOR });

        // Assert
        expect(peerMerge.ok).toBe(false);
        expect(result.kind).toBe('conflict');
        expect(stageOf(pair.ours)).toBe(stageOf(pair.peer));
        expect(await read(pair.ours, 'data.txt')).toBe(await read(pair.peer, 'data.txt'));
      });
    });
  });
});
