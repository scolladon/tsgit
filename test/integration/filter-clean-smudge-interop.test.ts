/**
 * Cross-tool interop — clean/smudge filter driver faithfulness.
 *
 * Pins F1 (clean@add stores cleaned blob; smudge@checkout writes smudged bytes;
 * git diff is clean after checkout), F2 (clean-only ⇒ identity smudge), F3
 * (required=true + failing clean ⇒ fatal; tsgit throws CLEAN_FILTER_FAILED with
 * structured data; git refuses with exit 128), and F4 (required absent ⇒ exit 0,
 * raw bytes staged — assert raw blob OID parity).
 *
 * F-EXEC pins the stdin→stdout driver contract: the driver receives no positional
 * arguments (argc=0), content on stdin, result on stdout.
 *
 * Drivers are trivial portable stdin→stdout scripts (`LC_ALL=C tr a-z A-Z` for
 * clean / uppercase, `LC_ALL=C tr A-Z a-z` for smudge / lowercase). The `tr`
 * binary reads stdin — no filename argument — which matches the F-EXEC contract
 * (clean/smudge are pure stdin→stdout; contrast textconv which takes argv[1]).
 *
 * Isolation is load-bearing: `runGit` from interop-helpers scrubs all `GIT_*`
 * env vars, points `HOME` at a non-existent path, and sets `GIT_CONFIG_NOSYSTEM=1`
 * — no global/system/XDG git config engages.
 */
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/index.js';
import { add } from '../../src/application/commands/add.js';
import { checkout } from '../../src/application/commands/checkout.js';
import { status } from '../../src/application/commands/status.js';
import { readBlob } from '../../src/application/primitives/read-blob.js';
import { readIndex } from '../../src/application/primitives/read-index.js';
import { TsgitError } from '../../src/domain/index.js';
import type { ObjectId } from '../../src/domain/objects/object-id.js';
import { GIT_AVAILABLE, git, runGit, runGitEnv, tryRunGit } from './interop-helpers.js';

const SETUP_TIMEOUT = 120_000;

const IDENTITY = {
  GIT_AUTHOR_NAME: 'Ada',
  GIT_AUTHOR_EMAIL: 'ada@example.com',
  GIT_COMMITTER_NAME: 'Ada',
  GIT_COMMITTER_EMAIL: 'ada@example.com',
} as const;

const dateEnv = (epoch: number): NodeJS.ProcessEnv => ({
  ...runGitEnv(),
  ...IDENTITY,
  GIT_AUTHOR_DATE: `${epoch} +0000`,
  GIT_COMMITTER_DATE: `${epoch} +0000`,
});

const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

describe.skipIf(!GIT_AVAILABLE)('filter clean/smudge interop', () => {
  let dir = '';
  let ctx: ReturnType<typeof createNodeContext>;
  let cleanScript = '';
  let cleanFailScript = '';
  let smudgeFailScript = '';
  let fexecLogFile = '';
  let epoch = 1_700_040_000;

  const nextEpoch = (): number => (epoch += 1);

  const doCommit = (message: string): string => {
    runGit(['-C', dir, 'commit', '-q', '-m', message], { env: dateEnv(nextEpoch()) });
    return git(dir, 'rev-parse', 'HEAD').trim();
  };

  beforeAll(async () => {
    dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-filter-clean-interop-')));

    runGit(['init', '-q', '-b', 'main', dir]);
    runGit(['-C', dir, 'config', 'user.name', 'Ada']);
    runGit(['-C', dir, 'config', 'user.email', 'ada@example.com']);
    runGit(['-C', dir, 'config', 'commit.gpgsign', 'false']);

    // Portable clean (stdin→stdout uppercase) — tr reads stdin, no argv
    cleanScript = path.join(dir, '.git', 'clean-upper.sh');
    await writeFile(cleanScript, '#!/bin/sh\nLC_ALL=C tr a-z A-Z\n');
    await chmod(cleanScript, 0o755);

    // Always-failing clean driver (for F3/F4)
    cleanFailScript = path.join(dir, '.git', 'clean-fail.sh');
    await writeFile(cleanFailScript, '#!/bin/sh\nexit 1\n');
    await chmod(cleanFailScript, 0o755);

    // Portable smudge (stdin→stdout lowercase) — inverse of clean-upper.sh
    const smudgeScript = path.join(dir, '.git', 'smudge-lower.sh');
    await writeFile(smudgeScript, '#!/bin/sh\nLC_ALL=C tr A-Z a-z\n');
    await chmod(smudgeScript, 0o755);

    // Always-failing smudge driver (for F6/F7)
    smudgeFailScript = path.join(dir, '.git', 'smudge-fail.sh');
    await writeFile(smudgeFailScript, '#!/bin/sh\nexit 1\n');
    await chmod(smudgeFailScript, 0o755);

    // F-EXEC logging driver: echo stdin→stdout, append argc to a log file
    fexecLogFile = path.join(dir, '.git', 'fexec-argc.log');
    const fexecScript = path.join(dir, '.git', 'fexec-log.sh');
    await writeFile(fexecScript, `#!/bin/sh\necho $# >> "${fexecLogFile}"\nLC_ALL=C tr a-z A-Z\n`);
    await chmod(fexecScript, 0o755);

    // Configure local filter drivers in .git/config
    runGit(['-C', dir, 'config', `filter.myf.clean`, cleanScript]);
    runGit(['-C', dir, 'config', `filter.myf.smudge`, smudgeScript]);
    runGit(['-C', dir, 'config', `filter.fail-req.clean`, cleanFailScript]);
    runGit(['-C', dir, 'config', `filter.fail-req.required`, 'true']);
    runGit(['-C', dir, 'config', `filter.fail-opt.clean`, cleanFailScript]);
    // F6: smudge-required — smudge fails + required=true → fatal
    runGit(['-C', dir, 'config', `filter.smudge-req.clean`, cleanScript]);
    runGit(['-C', dir, 'config', `filter.smudge-req.smudge`, smudgeFailScript]);
    runGit(['-C', dir, 'config', `filter.smudge-req.required`, 'true']);
    // F7: smudge-optional — smudge fails, no required → raw bytes written
    runGit(['-C', dir, 'config', `filter.smudge-opt.clean`, cleanScript]);
    runGit(['-C', dir, 'config', `filter.smudge-opt.smudge`, smudgeFailScript]);
    // F2: clean-only (no smudge configured) — identity smudge
    runGit(['-C', dir, 'config', `filter.c2.clean`, cleanScript]);
    // F-EXEC: logging driver wired as clean
    runGit(['-C', dir, 'config', `filter.fexec.clean`, fexecScript]);

    // .gitattributes mapping
    await writeFile(
      path.join(dir, '.gitattributes'),
      `${['*.y filter=myf', '*.req filter=fail-req', '*.opt filter=fail-opt', '*.c2 filter=c2', '*.fx filter=fexec', '*.sr filter=smudge-req', '*.so filter=smudge-opt'].join('\n')}\n`,
    );

    // Commit .gitattributes as the repository root so no test leaves it untracked
    runGit(['-C', dir, 'add', '.gitattributes']);
    runGit(['-C', dir, 'commit', '-q', '-m', 'init'], { env: dateEnv(nextEpoch()) });

    ctx = createNodeContext({ workDir: dir });
  }, SETUP_TIMEOUT);

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // ── clean-F1: clean stores cleaned blob ────────────────────────────────────

  describe('Given a .y file under filter=myf with an uppercase clean driver', () => {
    describe('When tsgit add stages it', () => {
      it('Then the committed blob OID matches real git cat-file UPPERCASE content', async () => {
        // Arrange — write the file and stage it with real git to get golden OID
        const content = 'Hello World\n';
        await writeFile(path.join(dir, 'f1.y'), content);

        // Git golden: add + cat-file
        git(dir, 'add', 'f1.y');
        doCommit('add f1.y');
        const gitBlobOid = git(dir, 'rev-parse', ':f1.y').trim();
        const gitBlobContent = git(dir, 'cat-file', 'blob', gitBlobOid).trim();

        // Reset index so tsgit stages fresh
        git(dir, 'rm', '--cached', 'f1.y');
        await writeFile(path.join(dir, 'f1.y'), content);

        // Act — tsgit add with NodeCommandRunner (wires the clean filter)
        await add(ctx, ['f1.y']);

        // Assert OID parity: tsgit's staged OID must equal git's
        const tsIndex = await readIndex(ctx);
        const tsEntry = tsIndex.entries.find((e) => e.path === 'f1.y');
        expect(tsEntry).toBeDefined();

        // Assert content is UPPERCASE (cleaned)
        const tsBlob = await readBlob(ctx, tsEntry!.id as ObjectId);
        expect(dec(tsBlob.content)).toBe('HELLO WORLD\n');
        expect(gitBlobContent).toBe('HELLO WORLD');

        // OID parity
        expect(tsEntry!.id).toBe(gitBlobOid);
      });
    });
  });

  // ── F3: required=true + clean failure → fatal ──────────────────────────────

  describe('Given a .req file under filter=fail-req with required=true and a failing clean', () => {
    describe('When tsgit add stages it', () => {
      it('Then tsgit throws CLEAN_FILTER_FAILED with structured data; git refuses with exit 128', async () => {
        // Arrange
        await writeFile(path.join(dir, 'f3.req'), 'Hello World\n');

        // Git golden: refuses with exit 128
        const gitResult = tryRunGit(['-C', dir, 'add', 'f3.req']);
        expect(gitResult.ok).toBe(false);

        // Confirm git did not stage it
        const gitLsFiles = git(dir, 'ls-files', '--', 'f3.req').trim();
        expect(gitLsFiles).toBe('');

        // Act — tsgit: must throw a structured error (not byte-match git's stderr)
        let caught: unknown;
        try {
          await add(ctx, ['f3.req']);
        } catch (err) {
          caught = err;
        }

        // Assert structured error
        expect(caught).toBeInstanceOf(TsgitError);
        const err = caught as TsgitError;
        expect(err.data.code).toBe('CLEAN_FILTER_FAILED');
        expect((err.data as { exitCode: number }).exitCode).toBeGreaterThan(0);
        expect((err.data as { filter: string }).filter).toBe('fail-req');
        expect((err.data as { path: string }).path).toBe('f3.req');

        // Nothing staged by tsgit
        const tsIndex = await readIndex(ctx).catch(() => null);
        const tsEntry = tsIndex?.entries.find((e) => e.path === 'f3.req');
        expect(tsEntry).toBeUndefined();
      });
    });
  });

  // ── F4: required absent → exit 0, raw bytes staged ─────────────────────────

  describe('Given a .opt file under filter=fail-opt with required absent and a failing clean', () => {
    describe('When tsgit add stages it', () => {
      it('Then tsgit stages raw bytes and succeeds; raw blob OID matches git cat-file', async () => {
        // Arrange — remove f3.req from the working tree so git's index-refresh
        // does not cross over it with fail-req (required=true) during this test.
        await rm(path.join(dir, 'f3.req'), { force: true });

        const content = 'Hello World\n';
        await writeFile(path.join(dir, 'f4.opt'), content);

        // Git golden: adds raw bytes (git warns on stderr, exits 0).
        // Use tryRunGit because git writes warnings to stderr but exits 0.
        const gitAddResult = tryRunGit(['-C', dir, 'add', 'f4.opt']);
        expect(gitAddResult.ok).toBe(true);
        const gitBlobOid = git(dir, 'rev-parse', ':f4.opt').trim();
        const gitBlobContent = git(dir, 'cat-file', 'blob', gitBlobOid);

        // Confirm git stored raw bytes (not uppercased — filter failed)
        expect(gitBlobContent).toBe('Hello World\n');

        // Reset index
        git(dir, 'rm', '--cached', 'f4.opt');
        await writeFile(path.join(dir, 'f4.opt'), content);

        // Act — tsgit: must succeed (no throw)
        const result = await add(ctx, ['f4.opt']);
        expect(result.added).toContain('f4.opt');

        // Assert raw blob OID parity with git
        const tsIndex = await readIndex(ctx);
        const tsEntry = tsIndex.entries.find((e) => e.path === 'f4.opt');
        expect(tsEntry).toBeDefined();
        const tsBlob = await readBlob(ctx, tsEntry!.id as ObjectId);

        // Content is raw (not cleaned)
        expect(dec(tsBlob.content)).toBe('Hello World\n');

        // OID parity
        expect(tsEntry!.id).toBe(gitBlobOid);
      });
    });
  });

  // ── smudge-F1: checkout writes smudged bytes; tsgit status is clean ────────

  describe('Given a committed .y file whose blob is UPPERCASE (cleaned) and filter=myf smudge is configured', () => {
    describe('When tsgit checkout restores the file and status is queried', () => {
      it('Then the worktree file has lowercase bytes and tsgit status is clean', async () => {
        // Arrange — create f1s.y, stage+commit via git so HEAD has UPPERCASE blob
        const rawContent = 'hello filter\n';
        await writeFile(path.join(dir, 'f1s.y'), rawContent);
        git(dir, 'add', 'f1s.y');
        doCommit('add f1s.y');

        // Verify git committed UPPERCASE (clean applied at add)
        const gitBlobOid = git(dir, 'rev-parse', 'HEAD:f1s.y').trim();
        const gitBlobContent = git(dir, 'cat-file', 'blob', gitBlobOid);
        expect(gitBlobContent).toBe('HELLO FILTER\n');

        // Remove worktree file so checkout writes it fresh
        await rm(path.join(dir, 'f1s.y'));

        // Act — tsgit checkout restores file (smudge → lowercase)
        await checkout(ctx, { paths: ['f1s.y'] });

        // Assert worktree file has smudged (lowercase) bytes
        const worktreeBytes = await readFile(path.join(dir, 'f1s.y'));
        expect(dec(worktreeBytes)).toBe('hello filter\n');

        // Git diff is clean (peer verification)
        const gitDiff = git(dir, 'diff', '--no-ext-diff', '--', 'f1s.y').trim();
        expect(gitDiff).toBe('');

        // tsgit status: path absent from changes, repo is clean
        const result = await status(ctx);
        const changedPath = result.changes.find((c) => c.path === 'f1s.y');
        expect(changedPath).toBeUndefined();
        expect(result.clean).toBe(true);
      });
    });
  });

  // ── F2: clean-only filter → identity smudge → worktree = blob bytes ────────

  describe('Given a committed .c2 file with filter=c2 (clean-only, no smudge configured)', () => {
    describe('When tsgit checkout restores the file', () => {
      it('Then the worktree file has verbatim blob bytes (identity smudge) and status is clean', async () => {
        // Arrange — create f2.c2, stage+commit via git (UPPERCASE blob stored)
        const rawContent = 'hello c2\n';
        await writeFile(path.join(dir, 'f2.c2'), rawContent);
        git(dir, 'add', 'f2.c2');
        doCommit('add f2.c2');

        const gitBlobOid = git(dir, 'rev-parse', 'HEAD:f2.c2').trim();
        const gitBlobContent = git(dir, 'cat-file', 'blob', gitBlobOid);
        expect(gitBlobContent).toBe('HELLO C2\n');

        // Remove worktree file so checkout writes it fresh
        await rm(path.join(dir, 'f2.c2'));

        // Act — tsgit checkout: no smudge configured → identity → writes blob bytes
        await checkout(ctx, { paths: ['f2.c2'] });

        // Assert worktree file equals UPPERCASE blob (no smudge applied)
        const worktreeBytes = await readFile(path.join(dir, 'f2.c2'));
        expect(dec(worktreeBytes)).toBe('HELLO C2\n');

        // Git diff is clean
        const gitDiff = git(dir, 'diff', '--no-ext-diff', '--', 'f2.c2').trim();
        expect(gitDiff).toBe('');

        // tsgit status: clean
        const result = await status(ctx);
        const changedPath = result.changes.find((c) => c.path === 'f2.c2');
        expect(changedPath).toBeUndefined();
        expect(result.clean).toBe(true);
      });
    });
  });

  // ── F6: smudge required=true + failing smudge → fatal; file NOT written ────

  describe('Given a .sr file under filter=smudge-req (required=true) with a failing smudge', () => {
    describe('When checkout is attempted after the worktree file is removed', () => {
      it('Then real git exits 128 and writes no file; tsgit throws SMUDGE_FILTER_FAILED and writes no file', async () => {
        // Arrange — create f6.sr, stage+commit via git (clean=upper succeeds → UPPERCASE blob stored)
        const rawContent = 'hello smudge req\n';
        await writeFile(path.join(dir, 'f6.sr'), rawContent);
        git(dir, 'add', 'f6.sr');
        doCommit('add f6.sr');

        // Verify git committed UPPERCASE (clean applied at add)
        const gitBlobOid = git(dir, 'rev-parse', 'HEAD:f6.sr').trim();
        const gitBlobContent = git(dir, 'cat-file', 'blob', gitBlobOid);
        expect(gitBlobContent).toBe('HELLO SMUDGE REQ\n');

        // Remove worktree file
        await rm(path.join(dir, 'f6.sr'));

        // Git golden: required=true + smudge failure → exit 128, file NOT written
        const gitResult = tryRunGit(['-C', dir, 'checkout', '--', 'f6.sr']);
        expect(gitResult.ok).toBe(false);

        // Git leaves the worktree file absent
        let gitFilePresent = true;
        try {
          await readFile(path.join(dir, 'f6.sr'));
        } catch {
          gitFilePresent = false;
        }
        expect(gitFilePresent).toBe(false);

        // Act — tsgit: must throw a structured error
        let caught: unknown;
        try {
          await checkout(ctx, { paths: ['f6.sr'] });
        } catch (err) {
          caught = err;
        }

        // Assert structured error
        expect(caught).toBeInstanceOf(TsgitError);
        const err = caught as TsgitError;
        expect(err.data.code).toBe('SMUDGE_FILTER_FAILED');
        expect((err.data as { exitCode: number }).exitCode).toBeGreaterThan(0);
        expect((err.data as { filter: string }).filter).toBe('smudge-req');
        expect((err.data as { path: string }).path).toBe('f6.sr');

        // tsgit leaves the worktree file absent (not written on failure)
        let tsFilePresent = true;
        try {
          await readFile(path.join(dir, 'f6.sr'));
        } catch {
          tsFilePresent = false;
        }
        expect(tsFilePresent).toBe(false);
      });
    });
  });

  // ── F7: smudge optional (no required) + failing smudge → raw bytes, succeeds ─

  describe('Given a .so file under filter=smudge-opt (required absent) with a failing smudge', () => {
    describe('When checkout is performed after the worktree file is removed', () => {
      it('Then both git and tsgit write raw blob bytes and succeed; worktree bytes are identical', async () => {
        // Arrange — create f7.so, stage+commit via git (clean=upper succeeds → UPPERCASE blob stored)
        const rawContent = 'hello smudge opt\n';
        await writeFile(path.join(dir, 'f7.so'), rawContent);
        git(dir, 'add', 'f7.so');
        doCommit('add f7.so');

        // Verify git committed UPPERCASE (clean applied at add)
        const gitBlobOid = git(dir, 'rev-parse', 'HEAD:f7.so').trim();
        const gitBlobContent = git(dir, 'cat-file', 'blob', gitBlobOid);
        expect(gitBlobContent).toBe('HELLO SMUDGE OPT\n');

        // Remove worktree file
        await rm(path.join(dir, 'f7.so'));

        // Git golden: required absent + smudge failure → exit 0, raw blob bytes written
        const gitResult = tryRunGit(['-C', dir, 'checkout', '--', 'f7.so']);
        expect(gitResult.ok).toBe(true);

        // Git writes raw blob bytes (UPPERCASE — no smudge transform applied)
        const gitWorktreeBytes = await readFile(path.join(dir, 'f7.so'));
        expect(dec(gitWorktreeBytes)).toBe('HELLO SMUDGE OPT\n');

        // Remove again so tsgit writes fresh
        await rm(path.join(dir, 'f7.so'));

        // Act — tsgit checkout: must succeed (no throw), write raw blob bytes
        await checkout(ctx, { paths: ['f7.so'] });

        // Assert tsgit worktree bytes = git worktree bytes = raw blob bytes
        const tsWorktreeBytes = await readFile(path.join(dir, 'f7.so'));
        expect(dec(tsWorktreeBytes)).toBe('HELLO SMUDGE OPT\n');

        // OID parity: tsgit wrote the same bytes git did
        expect(dec(tsWorktreeBytes)).toBe(dec(gitWorktreeBytes));

        // Committed blob bytes are UPPERCASE (cleaned); worktree = blob bytes (raw, no smudge)
        const sut = await readBlob(ctx, gitBlobOid as ObjectId);
        expect(dec(sut.content)).toBe('HELLO SMUDGE OPT\n');
      });
    });
  });

  // ── F-EXEC: driver receives stdin, writes stdout, no positional args ────────

  describe('Given a .fx file under filter=fexec whose clean driver logs $# to a file', () => {
    describe('When tsgit add stages it', () => {
      it('Then the driver received argc=0 (stdin→stdout only) and the blob content matches', async () => {
        // Arrange
        const rawContent = 'hello exec\n';
        await writeFile(path.join(dir, 'fexec.fx'), rawContent);

        // Act — tsgit add triggers the fexec clean driver
        await add(ctx, ['fexec.fx']);

        // Assert argc=0: the log file must contain a single line with "0"
        const logContent = await readFile(fexecLogFile, 'utf8');
        const logLines = logContent.trim().split('\n');
        expect(logLines.at(-1)).toBe('0');

        // Assert blob content is UPPERCASE (clean driver ran stdin→stdout)
        const tsIndex = await readIndex(ctx);
        const tsEntry = tsIndex.entries.find((e) => e.path === 'fexec.fx');
        expect(tsEntry).toBeDefined();
        const tsBlob = await readBlob(ctx, tsEntry!.id as ObjectId);
        expect(dec(tsBlob.content)).toBe('HELLO EXEC\n');
      });
    });
  });
});
