/**
 * Cross-tool interop — clean/smudge filter driver faithfulness.
 *
 * Pins the round trip (clean@add stores the cleaned blob; smudge@checkout
 * writes the smudged bytes; the peer's own diff is clean after checkout), the
 * clean-only case (identity smudge), the fatal case (required=true + failing
 * clean; tsgit throws CLEAN_FILTER_FAILED with structured data; git refuses
 * with exit 128), and the graceful case (required absent ⇒ exit 0, raw bytes
 * staged — assert raw blob OID parity).
 *
 * The driver contract itself is pinned too: the driver receives no positional
 * arguments (argc=0), content on stdin, result on stdout.
 *
 * Drivers are trivial portable stdin→stdout scripts (`LC_ALL=C tr a-z A-Z` for
 * clean / uppercase, `LC_ALL=C tr A-Z a-z` for smudge / lowercase). The `tr`
 * binary reads stdin — no filename argument — which matches that contract
 * (clean/smudge are pure stdin→stdout; contrast textconv which takes argv[1]).
 *
 * Isolation is load-bearing: `runGit` from interop-helpers scrubs all `GIT_*`
 * env vars, points `HOME` at a non-existent path, and sets `GIT_CONFIG_NOSYSTEM=1`
 * — no global/system/XDG git config engages.
 *
 * @proves
 *   surface:        add.filters, checkout.filters
 *   bucket:         cross-tool-interop
 *   unique:         clean and smudge drivers take content on stdin with no positional argv, and required decides whether a failure is fatal
 *   interopSurface: add, status, stash
 */
import { chmod, mkdtemp, readFile, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/index.js';
import { add } from '../../src/application/commands/add.js';
import { checkout } from '../../src/application/commands/checkout.js';
import { reset } from '../../src/application/commands/reset.js';
import { stashPush } from '../../src/application/commands/stash.js';
import { status } from '../../src/application/commands/status.js';
import { readBlob } from '../../src/application/primitives/read-blob.js';
import { readIndex } from '../../src/application/primitives/read-index.js';
import { TsgitError } from '../../src/domain/index.js';
import type { ObjectId } from '../../src/domain/objects/object-id.js';
import type { Context } from '../../src/ports/context.js';
import { blobAt, enc, FILTER_FIXTURE } from './eol-interop-fixtures.js';
import {
  GIT_AVAILABLE,
  git,
  runGit,
  runGitEnv,
  tryRunGit,
  tryRunGitWithExit,
} from './interop-helpers.js';

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
  let fexecSmudgeLogFile = '';
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

    // Always-failing clean driver (for the fatal and the graceful clean rows)
    cleanFailScript = path.join(dir, '.git', 'clean-fail.sh');
    await writeFile(cleanFailScript, '#!/bin/sh\nexit 1\n');
    await chmod(cleanFailScript, 0o755);

    // Portable smudge (stdin→stdout lowercase) — inverse of clean-upper.sh
    const smudgeScript = path.join(dir, '.git', 'smudge-lower.sh');
    await writeFile(smudgeScript, '#!/bin/sh\nLC_ALL=C tr A-Z a-z\n');
    await chmod(smudgeScript, 0o755);

    // Always-failing smudge driver (for the fatal and the graceful smudge rows)
    smudgeFailScript = path.join(dir, '.git', 'smudge-fail.sh');
    await writeFile(smudgeFailScript, '#!/bin/sh\nexit 1\n');
    await chmod(smudgeFailScript, 0o755);

    // Argc-logging driver: echo stdin→stdout, append argc to a log file (clean side)
    fexecLogFile = path.join(dir, '.git', 'fexec-argc.log');
    const fexecScript = path.join(dir, '.git', 'fexec-log.sh');
    await writeFile(fexecScript, `#!/bin/sh\necho $# >> "${fexecLogFile}"\nLC_ALL=C tr a-z A-Z\n`);
    await chmod(fexecScript, 0o755);

    // Argc-logging smudge driver: echo stdin→stdout lowercase, append argc to log file
    fexecSmudgeLogFile = path.join(dir, '.git', 'fexec-smudge-argc.log');
    const fexecSmudgeScript = path.join(dir, '.git', 'fexec-smudge-log.sh');
    await writeFile(
      fexecSmudgeScript,
      `#!/bin/sh\necho $# >> "${fexecSmudgeLogFile}"\nLC_ALL=C tr A-Z a-z\n`,
    );
    await chmod(fexecSmudgeScript, 0o755);

    // Configure local filter drivers in .git/config
    runGit(['-C', dir, 'config', `filter.myf.clean`, cleanScript]);
    runGit(['-C', dir, 'config', `filter.myf.smudge`, smudgeScript]);
    runGit(['-C', dir, 'config', `filter.fail-req.clean`, cleanFailScript]);
    runGit(['-C', dir, 'config', `filter.fail-req.required`, 'true']);
    runGit(['-C', dir, 'config', `filter.fail-opt.clean`, cleanFailScript]);
    // smudge-required — smudge fails + required=true → fatal
    runGit(['-C', dir, 'config', `filter.smudge-req.clean`, cleanScript]);
    runGit(['-C', dir, 'config', `filter.smudge-req.smudge`, smudgeFailScript]);
    runGit(['-C', dir, 'config', `filter.smudge-req.required`, 'true']);
    // smudge-optional — smudge fails, no required → raw bytes written
    runGit(['-C', dir, 'config', `filter.smudge-opt.clean`, cleanScript]);
    runGit(['-C', dir, 'config', `filter.smudge-opt.smudge`, smudgeFailScript]);
    // clean-only (no smudge configured) — identity smudge
    runGit(['-C', dir, 'config', `filter.c2.clean`, cleanScript]);
    // Argc-logging driver wired as clean
    runGit(['-C', dir, 'config', `filter.fexec.clean`, fexecScript]);
    // Argc-logging driver wired as smudge (with a clean pass-through)
    runGit(['-C', dir, 'config', `filter.fexec2.clean`, cleanScript]);
    runGit(['-C', dir, 'config', `filter.fexec2.smudge`, fexecSmudgeScript]);

    // .gitattributes mapping
    await writeFile(
      path.join(dir, '.gitattributes'),
      `${['*.y filter=myf', '*.req filter=fail-req', '*.opt filter=fail-opt', '*.c2 filter=c2', '*.fx filter=fexec', '*.fs filter=fexec2', '*.sr filter=smudge-req', '*.so filter=smudge-opt'].join('\n')}\n`,
    );

    // Commit .gitattributes as the repository root so no test leaves it untracked
    runGit(['-C', dir, 'add', '.gitattributes']);
    runGit(['-C', dir, 'commit', '-q', '-m', 'init'], { env: dateEnv(nextEpoch()) });

    ctx = createNodeContext({ workDir: dir });
  }, SETUP_TIMEOUT);

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // ── clean: stores the cleaned blob ─────────────────────────────────────────

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

  // ── required=true + clean failure → fatal ──────────────────────────────────

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

  // ── required absent → exit 0, raw bytes staged ─────────────────────────────

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

  // ── smudge: checkout writes smudged bytes; tsgit status is clean ───────────

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

  // ── clean-only filter → identity smudge → worktree = blob bytes ────────────

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

  // ── smudge required=true + failing smudge → fatal; file NOT written ────────

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

  // ── smudge optional (no required) + failing smudge → raw bytes, succeeds ─────

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
        const result = await readBlob(ctx, gitBlobOid as ObjectId);
        expect(dec(result.content)).toBe('HELLO SMUDGE OPT\n');
      });
    });
  });

  // ── driver receives stdin, writes stdout, no positional args ────────────────

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

  // ── smudge driver receives stdin, writes stdout, no positional args ─────────────────

  describe('Given a .fs file under filter=fexec2 whose smudge driver logs $# to a file', () => {
    describe('When tsgit checkout restores the file', () => {
      it('Then the smudge driver received argc=0 (stdin→stdout only) and worktree bytes are lowercased', async () => {
        // Arrange — add the file (clean driver uppercases it)
        const rawContent = 'hello smudge exec\n';
        await writeFile(path.join(dir, 'fexec-smudge.fs'), rawContent);
        runGit(['-C', dir, 'add', 'fexec-smudge.fs']);
        doCommit('add fexec-smudge.fs');

        // Remove the working file so checkout writes fresh from blob
        runGit(['-C', dir, 'rm', '--cached', 'fexec-smudge.fs']);
        // Also delete from disk so tsgit checkout re-writes it
        const { rm: fsRm } = await import('node:fs/promises');
        await fsRm(path.join(dir, 'fexec-smudge.fs'), { force: true });
        // Re-stage blob so checkout has something to restore
        runGit(['-C', dir, 'checkout', 'HEAD', '--', 'fexec-smudge.fs']);
        await fsRm(path.join(dir, 'fexec-smudge.fs'), { force: true });

        // Clear the log file so we count only this invocation
        const { writeFile: wf } = await import('node:fs/promises');
        await wf(fexecSmudgeLogFile, '');

        // Act — tsgit checkout triggers the fexec2 smudge driver
        await checkout(ctx, { paths: ['fexec-smudge.fs'] });

        // Assert argc=0: the log file must end with "0"
        const logContent = await readFile(fexecSmudgeLogFile, 'utf8');
        const logLines = logContent
          .trim()
          .split('\n')
          .filter((l) => l.length > 0);
        expect(logLines.at(-1)).toBe('0');

        // Assert worktree bytes are lowercase (smudge driver ran stdin→stdout)
        const worktreeBytes = await readFile(path.join(dir, 'fexec-smudge.fs'), 'utf8');
        expect(worktreeBytes).toBe('hello smudge exec\n');
      });
    });
  });
});

describe.skipIf(!GIT_AVAILABLE)('Given a required driver that configures no clean command', () => {
  const PAST = new Date('2020-01-01T00:00:00Z');
  const LATER = new Date('2020-01-01T00:01:00Z');
  let root = '';

  beforeAll(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-filter-required-')));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** A committed `f` under `filter=d`, its index entry settled non-racy, then
   *  `[filter "d"] required` armed with no clean command. */
  const twin = async (slug: string): Promise<string> => {
    const repo = path.join(root, slug);
    runGit(['init', '-q', '-b', 'main', repo]);
    await writeFile(path.join(repo, '.gitattributes'), 'f filter=d\n');
    await writeFile(path.join(repo, 'f'), 'hi\n');
    for (const name of ['f', '.gitattributes']) await utimes(path.join(repo, name), PAST, PAST);
    runGit(['-C', repo, 'add', '.']);
    runGit(['-C', repo, 'commit', '-q', '-m', 'c'], { env: dateEnv(1_700_050_000) });
    runGit(['-C', repo, 'config', 'filter.d.required', 'true']);
    return repo;
  };

  const makeRacy = (repo: string): Promise<void> =>
    utimes(path.join(repo, '.git', 'index'), PAST, PAST);
  const makeStatDirty = (repo: string): Promise<void> => utimes(path.join(repo, 'f'), LATER, LATER);

  describe.each([
    { label: 'status on a racy file', git: ['status', '--porcelain'], arm: makeRacy, run: status },
    {
      label: 'status on a stat-dirty file',
      git: ['status', '--porcelain'],
      arm: makeStatDirty,
      run: status,
    },
    {
      label: 'stash on a stat-dirty file',
      git: ['stash'],
      arm: makeStatDirty,
      run: (c: ReturnType<typeof createNodeContext>) => stashPush(c),
    },
    {
      label: 'add f on a stat-dirty file',
      git: ['add', 'f'],
      arm: makeStatDirty,
      run: (c: ReturnType<typeof createNodeContext>) => add(c, ['f']),
    },
  ])('When git and tsgit run $label', ({ label, git: args, arm, run }) => {
    it("Then both die on f's clean filter", async () => {
      // Arrange
      const slug = label.replace(/[^a-z]+/g, '-');
      const gitRepo = await twin(`git-${slug}`);
      const tsgitRepo = await twin(`tsgit-${slug}`);
      await arm(gitRepo);
      await arm(tsgitRepo);
      const sut = run;

      // Act
      const g = tryRunGitWithExit(['-C', gitRepo, ...args]);
      const result = await sut(createNodeContext({ workDir: tsgitRepo })).catch(
        (err: unknown) => err,
      );

      // Assert
      expect(g.exitCode).toBe(128);
      expect(g.stderr).toContain("fatal: f: clean filter 'd' failed");
      expect((result as TsgitError).data).toEqual({
        code: 'CLEAN_FILTER_FAILED',
        path: 'f',
        filter: 'd',
      });
    });
  });
});

/** A long-running v2 filter: cleans by upper-casing, refuses content holding `FAIL`. */
const PROCESS_FILTER = `
const pkt = (text) => Buffer.concat([Buffer.from((text.length + 4).toString(16).padStart(4, '0')), Buffer.from(text)]);
const flush = Buffer.from('0000');
const write = (...parts) => process.stdout.write(Buffer.concat(parts));
const answers = [
  () => write(pkt('git-filter-server\\n'), pkt('version=2\\n'), flush),
  () => write(pkt('capability=clean\\n'), flush),
  () => undefined,
  (data) => data.includes('FAIL')
    ? write(pkt('status=error\\n'), flush)
    : write(pkt('status=success\\n'), flush, pkt(data.toString().toUpperCase()), flush, flush),
];
let buffered = Buffer.alloc(0);
let pending = [];
let step = 0;
process.stdin.on('data', (chunk) => {
  buffered = Buffer.concat([buffered, chunk]);
  while (buffered.length >= 4) {
    const length = parseInt(buffered.subarray(0, 4).toString(), 16);
    if (length !== 0 && buffered.length < length) return;
    if (length !== 0) pending.push(buffered.subarray(4, length));
    buffered = buffered.subarray(length === 0 ? 4 : length);
    if (length !== 0) continue;
    answers[step](Buffer.concat(pending));
    pending = [];
    step = step === 3 ? 2 : step + 1;
  }
});
`;

describe.skipIf(!GIT_AVAILABLE)('Given a filter.<d>.process driver beside a clean command', () => {
  let root = '';
  let filterCommand = '';

  beforeAll(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-filter-process-')));
    const script = path.join(root, 'filter.cjs');
    await writeFile(script, PROCESS_FILTER);
    filterCommand = `"${process.execPath}" "${script}"`;
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const twin = async (slug: string, content: string, required: boolean): Promise<string> => {
    const repo = path.join(root, slug);
    runGit(['init', '-q', '-b', 'main', repo]);
    await writeFile(path.join(repo, '.gitattributes'), 'f filter=d\n');
    await writeFile(path.join(repo, 'f'), content);
    runGit(['-C', repo, 'config', 'filter.d.process', filterCommand]);
    runGit(['-C', repo, 'config', 'filter.d.clean', 'sed s/h/X/']);
    runGit(['-C', repo, 'config', 'filter.d.required', String(required)]);
    return repo;
  };

  describe('When git and tsgit add f', () => {
    it('Then both stage the process-cleaned blob, the clean command unused', async () => {
      // Arrange
      const gitRepo = await twin('git-ok', 'hi\n', true);
      const tsgitRepo = await twin('tsgit-ok', 'hi\n', true);
      const sut = add;

      // Act
      runGit(['-C', gitRepo, 'add', 'f']);
      await sut(createNodeContext({ workDir: tsgitRepo }), ['f']);

      // Assert
      const staged = (repo: string): string => git(repo, 'rev-parse', ':f').trim();
      expect(staged(tsgitRepo)).toBe(staged(gitRepo));
      expect(git(tsgitRepo, 'cat-file', '-p', ':f')).toBe('HI\n');
    });
  });

  describe.each([
    { required: true, label: 'required' },
    { required: false, label: 'optional' },
  ])('When git and tsgit add f the $label process refuses', ({ required }) => {
    it(`Then both ${required ? 'die' : 'stage the raw bytes'}`, async () => {
      // Arrange
      const gitRepo = await twin(`git-fail-${required}`, 'FAIL\n', required);
      const tsgitRepo = await twin(`tsgit-fail-${required}`, 'FAIL\n', required);
      const sut = add;

      // Act
      const g = tryRunGitWithExit(['-C', gitRepo, 'add', 'f']);
      const result = await sut(createNodeContext({ workDir: tsgitRepo }), ['f']).catch(
        (err: unknown) => err,
      );

      // Assert
      expect(g.exitCode).toBe(required ? 128 : 0);
      if (required) {
        expect(g.stderr).toContain("fatal: f: clean filter 'd' failed");
        expect((result as TsgitError).data).toEqual({
          code: 'CLEAN_FILTER_FAILED',
          path: 'f',
          filter: 'd',
        });
        return;
      }
      expect(git(tsgitRepo, 'rev-parse', ':f')).toBe(git(gitRepo, 'rev-parse', ':f'));
    });
  });
});

/**
 * A long-running v2 filter advertising the capabilities in argv[2]: smudges by
 * lower-casing, cleans by upper-casing, refuses content holding `FAIL`, and
 * appends one line to argv[3] per process start.
 */
const SMUDGE_PROCESS_FILTER = `// v2 process filter: capabilities from argv[2] (comma list); smudge => lowercase, clean => uppercase; counts processes in argv[3] file
const fs = require('node:fs');
const caps = (process.argv[2] || 'clean,smudge').split(',');
if (process.argv[3]) fs.appendFileSync(process.argv[3], 'start\\n');
const pkt = (text) => Buffer.concat([Buffer.from((Buffer.byteLength(text) + 4).toString(16).padStart(4, '0')), Buffer.from(text)]);
const flush = Buffer.from('0000');
const write = (...parts) => process.stdout.write(Buffer.concat(parts));
let buffered = Buffer.alloc(0); let pending = []; let step = 0; let command = '';
const answers = [
  () => write(pkt('git-filter-server\\n'), pkt('version=2\\n'), flush),
  () => write(...caps.map((c) => pkt(\`capability=\${c}\\n\`)), flush),
  (data) => { command = data.toString(); if (process.argv[4]) fs.appendFileSync(process.argv[4], JSON.stringify(command) + '\\n'); },
  (data) => {
    const text = data.toString();
    if (text.includes('FAIL')) return write(pkt('status=error\\n'), flush);
    const out = command.includes('command=smudge') ? text.toLowerCase() : text.toUpperCase();
    write(pkt('status=success\\n'), flush, ...(out.length ? [pkt(out)] : []), flush, flush);
  },
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

describe.skipIf(!GIT_AVAILABLE)('Given a filter.<d>.process driver on checkout', () => {
  let root = '';
  let script = '';

  beforeAll(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-filter-smudge-process-')));
    script = path.join(root, 'filter.cjs');
    await writeFile(script, SMUDGE_PROCESS_FILTER);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** A repository holding `a.t` = `MiXeD`, committed unfiltered, then armed with `config`. */
  const twin = async (slug: string, config: ReadonlyArray<readonly [string, string]>) => {
    const repo = path.join(root, slug);
    runGit(['init', '-q', '-b', 'main', repo]);
    await writeFile(path.join(repo, '.gitattributes'), '*.t filter=d\n');
    await writeFile(path.join(repo, 'a.t'), 'MiXeD\n');
    runGit(['-C', repo, 'add', '.']);
    runGit(['-C', repo, '-c', 'user.name=A', '-c', 'user.email=a@a', 'commit', '-q', '-m', 'c']);
    for (const [key, value] of config) runGit(['-C', repo, 'config', key, value]);
    await rm(path.join(repo, 'a.t'));
    return repo;
  };

  const processCommand = (capabilities: string): string =>
    `"${process.execPath}" "${script}" ${capabilities}`;

  const worktreeFile = async (repo: string): Promise<string | undefined> =>
    readFile(path.join(repo, 'a.t'), 'utf8').catch(() => undefined);

  describe.each([
    {
      label: 'a process advertising smudge',
      config: () => [['filter.d.process', processCommand('clean,smudge')]] as const,
      written: 'mixed\n',
    },
    {
      label: 'a process advertising only clean',
      config: () => [['filter.d.process', processCommand('clean')]] as const,
      written: 'MiXeD\n',
    },
    {
      label: 'an empty process beside a smudge command',
      config: () =>
        [
          ['filter.d.process', ''],
          ['filter.d.smudge', 'tr A-Z a-z'],
        ] as const,
      written: 'MiXeD\n',
    },
    {
      label: 'a required driver configuring no command',
      config: () => [['filter.d.required', 'true']] as const,
      written: 'MiXeD\n',
    },
  ])('When git and tsgit check out a.t through $label', ({ label, config, written }) => {
    it('Then both write the same working-tree bytes', async () => {
      // Arrange
      const slug = label.replace(/[^a-z]+/gi, '-');
      const gitRepo = await twin(`git-${slug}`, config());
      const tsgitRepo = await twin(`tsgit-${slug}`, config());
      const sut = checkout;

      // Act
      runGit(['-C', gitRepo, 'checkout', '--', 'a.t']);
      await sut(createNodeContext({ workDir: tsgitRepo }), { paths: ['a.t'] });

      // Assert
      expect(await worktreeFile(gitRepo)).toBe(written);
      expect(await worktreeFile(tsgitRepo)).toBe(written);
    });
  });

  describe.each([
    {
      label: 'a process advertising only clean',
      config: () => [['filter.d.process', processCommand('clean')]] as const,
    },
    { label: 'only a clean command', config: () => [['filter.d.clean', 'cat']] as const },
  ])(
    'When git and tsgit check out a.t through a required driver with $label',
    ({ label, config }) => {
      it('Then both die and write nothing', async () => {
        // Arrange
        const armed = (): ReadonlyArray<readonly [string, string]> => [
          ...config(),
          ['filter.d.required', 'true'],
        ];
        const slug = label.replace(/[^a-z]+/gi, '-');
        const gitRepo = await twin(`git-req-${slug}`, armed());
        const tsgitRepo = await twin(`tsgit-req-${slug}`, armed());
        const sut = checkout;

        // Act
        const g = tryRunGitWithExit(['-C', gitRepo, 'checkout', '--', 'a.t']);
        const result = await sut(createNodeContext({ workDir: tsgitRepo }), {
          paths: ['a.t'],
        }).catch((err: unknown) => err);

        // Assert
        expect(g.exitCode).toBe(128);
        expect(g.stderr).toContain('fatal: a.t: smudge filter d failed');
        expect((result as TsgitError).data).toEqual({
          code: 'SMUDGE_FILTER_FAILED',
          path: 'a.t',
          filter: 'd',
        });
        expect(await worktreeFile(tsgitRepo)).toBe(await worktreeFile(gitRepo));
      });
    },
  );

  describe('When git and tsgit add through a required driver whose empty process shadows its clean command', () => {
    it('Then both die', async () => {
      // Arrange
      const config = [
        ['filter.d.process', ''],
        ['filter.d.clean', 'tr a-z A-Z'],
        ['filter.d.required', 'true'],
      ] as const;
      const gitRepo = await twin('git-empty-process-clean', config);
      const tsgitRepo = await twin('tsgit-empty-process-clean', config);
      await writeFile(path.join(gitRepo, 'c.t'), 'mixed\n');
      await writeFile(path.join(tsgitRepo, 'c.t'), 'mixed\n');
      const sut = add;

      // Act
      const g = tryRunGitWithExit(['-C', gitRepo, 'add', 'c.t']);
      const result = await sut(createNodeContext({ workDir: tsgitRepo }), ['c.t']).catch(
        (err: unknown) => err,
      );

      // Assert
      expect(g.exitCode).toBe(128);
      expect(g.stderr).toContain("fatal: c.t: clean filter 'd' failed");
      expect((result as TsgitError).data).toEqual({
        code: 'CLEAN_FILTER_FAILED',
        path: 'c.t',
        filter: 'd',
      });
    });
  });
});

describe.skipIf(!GIT_AVAILABLE)(
  'Given a stateful filter.<d>.process driver counting its starts',
  () => {
    let root = '';
    let script = '';

    beforeAll(async () => {
      root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-filter-process-pool-')));
      script = path.join(root, 'filter.cjs');
      await writeFile(script, SMUDGE_PROCESS_FILTER);
    });

    afterAll(async () => {
      await rm(root, { recursive: true, force: true });
    });

    /** A repository holding three filtered files, armed with a counting process driver. */
    const twin = async (slug: string) => {
      const repo = path.join(root, slug);
      runGit(['init', '-q', '-b', 'main', repo]);
      await writeFile(path.join(repo, '.gitattributes'), '*.t filter=d\n');
      for (const name of ['a', 'b', 'c'])
        await writeFile(path.join(repo, `${name}.t`), `${name}\n`);
      runGit(['-C', repo, 'add', '.']);
      runGit(['-C', repo, '-c', 'user.name=A', '-c', 'user.email=a@a', 'commit', '-q', '-m', 'c']);
      const counter = path.join(root, `${slug}.count`);
      const log = path.join(root, `${slug}.log`);
      const command = `"${process.execPath}" "${script}" clean,smudge "${counter}" "${log}"`;
      runGit(['-C', repo, 'config', 'filter.d.process', command]);
      return {
        repo,
        starts: async () => (await readFile(counter, 'utf8')).split('\n').length - 1,
        requests: () => readFile(log, 'utf8'),
        forgetRequests: () => writeFile(log, ''),
      };
    };

    describe('When git and tsgit check out many filtered files of varied sizes', () => {
      it('Then both ask the driver for every path in the same order', async () => {
        // Arrange
        const names = Array.from({ length: 24 }, (_, index) => `f${index}.t`);
        const gitTwin = await twin('git-order');
        const tsgitTwin = await twin('tsgit-order');
        for (const repo of [gitTwin.repo, tsgitTwin.repo]) {
          for (const [index, name] of names.entries()) {
            await writeFile(path.join(repo, name), 'x'.repeat((index * 7919) % 50_000));
          }
          runGit(['-C', repo, '-c', 'filter.d.process=', 'add', '.']);
          runGit([
            '-C',
            repo,
            '-c',
            'user.name=A',
            '-c',
            'user.email=a@a',
            'commit',
            '-qm',
            'more',
          ]);
          for (const name of names) await rm(path.join(repo, name));
        }
        await gitTwin.forgetRequests();
        await tsgitTwin.forgetRequests();
        const sut = checkout;

        // Act
        runGit(['-C', gitTwin.repo, 'checkout', '--', ...names]);
        await sut(createNodeContext({ workDir: tsgitTwin.repo }), { paths: names });

        // Assert
        const gitRequests = await gitTwin.requests();
        expect(gitRequests.split('\n')).toHaveLength(names.length + 1);
        expect(await tsgitTwin.requests()).toBe(gitRequests);
      });
    });

    describe('When git and tsgit check out three filtered files', () => {
      it('Then both start the driver once', async () => {
        // Arrange
        const gitTwin = await twin('git-checkout');
        const tsgitTwin = await twin('tsgit-checkout');
        const paths = ['a.t', 'b.t', 'c.t'];
        for (const name of paths) {
          await rm(path.join(gitTwin.repo, name));
          await rm(path.join(tsgitTwin.repo, name));
        }
        const sut = checkout;

        // Act
        runGit(['-C', gitTwin.repo, 'checkout', '--', ...paths]);
        await sut(createNodeContext({ workDir: tsgitTwin.repo }), { paths });

        // Assert
        expect(await gitTwin.starts()).toBe(1);
        expect(await tsgitTwin.starts()).toBe(1);
      });
    });

    describe('When git and tsgit add three changed filtered files', () => {
      it('Then both start the driver once', async () => {
        // Arrange
        const gitTwin = await twin('git-add');
        const tsgitTwin = await twin('tsgit-add');
        const paths = ['a.t', 'b.t', 'c.t'];
        for (const name of paths) {
          await writeFile(path.join(gitTwin.repo, name), 'changed\n');
          await writeFile(path.join(tsgitTwin.repo, name), 'changed\n');
        }
        const sut = add;

        // Act
        runGit(['-C', gitTwin.repo, 'add', ...paths]);
        await sut(createNodeContext({ workDir: tsgitTwin.repo }), paths);

        // Assert
        expect(await gitTwin.starts()).toBe(1);
        expect(await tsgitTwin.starts()).toBe(1);
      });
    });

    describe('When git and tsgit report the status of three touched filtered files', () => {
      it('Then both start the driver once', async () => {
        // Arrange
        const gitTwin = await twin('git-status');
        const tsgitTwin = await twin('tsgit-status');
        const later = new Date(Date.now() + 60_000);
        for (const name of ['a.t', 'b.t', 'c.t']) {
          await utimes(path.join(gitTwin.repo, name), later, later);
          await utimes(path.join(tsgitTwin.repo, name), later, later);
        }
        const sut = status;

        // Act
        runGit(['-C', gitTwin.repo, 'status', '--porcelain']);
        await sut(createNodeContext({ workDir: tsgitTwin.repo }));

        // Assert
        expect(await gitTwin.starts()).toBe(1);
        expect(await tsgitTwin.starts()).toBe(1);
      });
    });
  },
);

describe.skipIf(!GIT_AVAILABLE)('Given a required smudge driver that cannot start', () => {
  let root = '';

  beforeAll(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-filter-missing-command-')));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe('When git checks out through a missing command and tsgit has no command runner', () => {
    it('Then both die and write nothing', async () => {
      // Arrange
      const twin = async (slug: string): Promise<string> => {
        const repo = path.join(root, slug);
        runGit(['init', '-q', '-b', 'main', repo]);
        await writeFile(path.join(repo, '.gitattributes'), '*.t filter=d\n');
        await writeFile(path.join(repo, 'a.t'), 'A\n');
        runGit(['-C', repo, 'add', '.']);
        runGit(['-C', repo, '-c', 'user.name=A', '-c', 'user.email=a@a', 'commit', '-qm', 'c']);
        runGit(['-C', repo, 'config', 'filter.d.smudge', '/nonexistent/cmd']);
        runGit(['-C', repo, 'config', 'filter.d.required', 'true']);
        await rm(path.join(repo, 'a.t'));
        return repo;
      };
      const gitRepo = await twin('git');
      const tsgitRepo = await twin('tsgit');
      const { command: _runner, ...withoutRunner } = createNodeContext({ workDir: tsgitRepo });
      const sut = checkout;

      // Act
      const g = tryRunGitWithExit(['-C', gitRepo, 'checkout', '--', 'a.t']);
      const result = await sut(withoutRunner, { paths: ['a.t'] }).catch((err: unknown) => err);

      // Assert
      expect(g.exitCode).toBe(128);
      expect(g.stderr).toContain('fatal: a.t: smudge filter d failed');
      expect((result as TsgitError).data).toEqual({
        code: 'SMUDGE_FILTER_FAILED',
        path: 'a.t',
        filter: 'd',
      });
      expect(await readFile(path.join(tsgitRepo, 'a.t')).catch(() => undefined)).toBeUndefined();
      expect(await readFile(path.join(gitRepo, 'a.t')).catch(() => undefined)).toBeUndefined();
    });
  });
});

describe.skipIf(!GIT_AVAILABLE)('Given a filter.<d>.process driver over two branches', () => {
  let root = '';
  let script = '';

  beforeAll(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-filter-checkout-meta-')));
    script = path.join(root, 'filter.cjs');
    await writeFile(script, SMUDGE_PROCESS_FILTER);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** `main` and `other` disagree on `a.t`; the driver logs every request it is sent. */
  const twin = async (slug: string) => {
    const repo = path.join(root, slug);
    // Fixed dates: both twins must hold the same commit ids, whatever second each is built in.
    const env = {
      ...runGitEnv(),
      GIT_AUTHOR_DATE: '@1700000000 +0000',
      GIT_COMMITTER_DATE: '@1700000000 +0000',
    };
    const commit = (message: string) =>
      runGit(['-C', repo, '-c', 'user.name=A', '-c', 'user.email=a@a', 'commit', '-qam', message], {
        env,
      });
    runGit(['init', '-q', '-b', 'main', repo]);
    await writeFile(path.join(repo, '.gitattributes'), '*.t filter=d\n');
    await writeFile(path.join(repo, 'a.t'), 'A\n');
    runGit(['-C', repo, 'add', '.']);
    commit('c');
    runGit(['-C', repo, 'branch', 'other']);
    runGit(['-C', repo, 'tag', 'v1']);
    const annotate = (name: string, target: string) =>
      runGit(
        ['-C', repo, '-c', 'user.name=A', '-c', 'user.email=a@a', 'tag', '-am', 't', name, target],
        {
          env,
        },
      );
    annotate('v2', 'HEAD');
    annotate('vt', 'HEAD^{tree}');
    await writeFile(path.join(repo, 'a.t'), 'B\n');
    commit('d');
    const log = path.join(root, `${slug}.log`);
    runGit([
      '-C',
      repo,
      'config',
      'filter.d.process',
      `"${process.execPath}" "${script}" clean,smudge "" "${log}"`,
    ]);
    // Smudge `a.t` through the driver and record its stat, as a checkout leaves it.
    runGit(['-C', repo, 'reset', '-q', '--hard']);
    await writeFile(log, '');
    return {
      repo,
      smudges: async () =>
        (await readFile(log, 'utf8')).split('\n').filter((line) => line.includes('smudge')),
    };
  };

  describe.each([
    {
      label: 'switch to the other branch',
      git: ['checkout', '-q', 'other'],
      tsgit: (ctx: Context) => checkout(ctx, { rev: 'other' }),
    },
    {
      label: 'detach at the other branch',
      git: ['checkout', '-q', '--detach', 'other'],
      tsgit: (ctx: Context) => checkout(ctx, { rev: 'other', detach: true }),
    },
    {
      label: 'hard-reset to the other branch',
      git: ['reset', '-q', '--hard', 'other'],
      tsgit: (ctx: Context) => reset(ctx, { rev: 'other', mode: 'hard' }),
    },
    {
      label: 'create and switch to a branch at the other branch',
      git: ['checkout', '-q', '-b', 'topic', 'other'],
      tsgit: (ctx: Context) => checkout(ctx, { rev: 'other', createBranch: { name: 'topic' } }),
    },
  ])('When git and tsgit $label', ({ git: args, tsgit }) => {
    it('Then both send the driver the same ref and treeish', async () => {
      // Arrange
      const gitTwin = await twin(`git-${args.join('-')}`);
      const tsgitTwin = await twin(`tsgit-${args.join('-')}`);
      const sut = tsgit;

      // Act
      runGit(['-C', gitTwin.repo, ...args]);
      await sut(createNodeContext({ workDir: tsgitTwin.repo }));

      // Assert
      const gitSmudges = await gitTwin.smudges();
      expect(gitSmudges.join()).toContain('ref=refs/heads/other');
      expect(await tsgitTwin.smudges()).toEqual(gitSmudges);
    });
  });

  /** `rev` is handed to both tools verbatim; `objectOf` hands both the object id it names instead. */
  describe.each([
    { label: 'the other branch', rev: 'other' },
    { label: 'HEAD', rev: 'HEAD' },
    { label: 'a tag', rev: 'v1' },
    { label: 'an annotated tag of a commit', rev: 'v2' },
    { label: 'an annotated tag of a tree', rev: 'vt' },
    { label: 'the index', rev: undefined },
    { label: 'a revision expression', rev: 'other~0' },
    { label: 'the other branch via restore', rev: 'other', restore: true },
    { label: 'a commit id', objectOf: 'other' },
    { label: 'a tree id', objectOf: 'other^{tree}' },
  ])(
    'When git and tsgit restore a modified path from $label',
    ({ label, rev, restore, objectOf }) => {
      it('Then both send the driver the same ref and treeish', async () => {
        // Arrange
        const slug = `restore-${label.replaceAll(' ', '-')}`;
        const gitTwin = await twin(`git-${slug}`);
        const tsgitTwin = await twin(`tsgit-${slug}`);
        const source =
          objectOf === undefined ? rev : runGit(['-C', gitTwin.repo, 'rev-parse', objectOf]).trim();
        const gitArgs =
          restore === true
            ? ['restore', '-s', `${source}`]
            : ['checkout', '-q', ...(source === undefined ? [] : [source]), '--'];
        await writeFile(path.join(gitTwin.repo, 'a.t'), 'zz\n');
        await writeFile(path.join(tsgitTwin.repo, 'a.t'), 'zz\n');
        const sut = checkout;

        // Act
        runGit(['-C', gitTwin.repo, ...gitArgs, 'a.t']);
        await sut(createNodeContext({ workDir: tsgitTwin.repo }), {
          paths: ['a.t'],
          ...(source !== undefined && { source }),
        });

        // Assert
        const gitSmudges = await gitTwin.smudges();
        expect(gitSmudges).toHaveLength(1);
        expect(await tsgitTwin.smudges()).toEqual(gitSmudges);
      });
    },
  );

  describe.each([
    { label: 'no tracking', flags: [] as string[], track: undefined },
    { label: 'direct tracking', flags: ['--track'], track: 'direct' as const },
  ])('When git and tsgit create and switch to a branch with $label', ({ flags, track }) => {
    it('Then both write the same branch, HEAD, reflog messages and tracking config', async () => {
      // Arrange
      const gitTwin = await twin(`git-create-${flags.join('')}`);
      const tsgitTwin = await twin(`tsgit-create-${flags.join('')}`);
      const sut = checkout;
      const state = async (repo: string) => {
        const lastMessage = async (log: string) =>
          (await readFile(path.join(repo, '.git', 'logs', log), 'utf8'))
            .trimEnd()
            .split('\t')
            .at(-1);
        return {
          head: await readFile(path.join(repo, '.git', 'HEAD'), 'utf8'),
          headMessage: await lastMessage('HEAD'),
          branchMessage: await lastMessage('refs/heads/topic'),
          tracking: tryRunGitWithExit(['-C', repo, 'config', '--get-regexp', '^branch\\.topic\\.'])
            .stdout,
          tree: runGit(['-C', repo, 'rev-parse', 'topic^{tree}']),
        };
      };

      // Act
      runGit(['-C', gitTwin.repo, 'checkout', '-q', '-b', 'topic', ...flags, 'other']);
      await sut(createNodeContext({ workDir: tsgitTwin.repo }), {
        rev: 'other',
        createBranch: { name: 'topic', ...(track !== undefined && { track }) },
      });

      // Assert
      expect(await state(tsgitTwin.repo)).toEqual(await state(gitTwin.repo));
    });
  });
});

describe.skipIf(!GIT_AVAILABLE)(
  'Given a filter.<d>.process driver with an unusual handshake',
  () => {
    let root = '';

    beforeAll(async () => {
      root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-filter-handshake-')));
    });

    afterAll(async () => {
      await rm(root, { recursive: true, force: true });
    });

    /** A repo with `a.t` under the driver; `version` is the line the driver greets with. */
    const twin = async (slug: string, capabilities: string, version: string) => {
      const repo = path.join(root, slug);
      const script = path.join(root, `${slug}.cjs`);
      await writeFile(
        script,
        SMUDGE_PROCESS_FILTER.replace("pkt('version=2\\n')", `pkt('${version}')`),
      );
      runGit(['init', '-q', '-b', 'main', repo]);
      await writeFile(path.join(repo, '.gitattributes'), '*.t filter=d\n');
      await writeFile(path.join(repo, 'a.t'), 'a\n');
      const command = `"${process.execPath}" "${script}" ${capabilities}`;
      runGit(['-C', repo, 'config', 'filter.d.process', command]);
      return { repo, command };
    };

    describe('When git and tsgit add through a driver advertising an unknown capability', () => {
      it('Then both die naming the driver command and the capability', async () => {
        // Arrange
        const gitTwin = await twin('git-unknown-capability', 'clean,bogus', 'version=2\\n');
        const tsgitTwin = await twin('tsgit-unknown-capability', 'clean,bogus', 'version=2\\n');
        const sut = add;

        // Act
        const git = tryRunGitWithExit(['-C', gitTwin.repo, 'add', 'a.t']);
        const result = await sut(createNodeContext({ workDir: tsgitTwin.repo }), ['a.t']).catch(
          (error: unknown) => error,
        );

        // Assert
        expect(git.exitCode).toBe(128);
        expect(git.stderr).toContain(
          `fatal: subprocess '${gitTwin.command}' requested unsupported capability 'bogus'`,
        );
        expect((result as TsgitError).data).toEqual({
          code: 'FILTER_UNSUPPORTED_CAPABILITY',
          command: tsgitTwin.command,
          capability: 'bogus',
        });
      });
    });

    describe('When git and tsgit add through a driver greeting with a zero-padded version', () => {
      it('Then both read it as version 2 and stage the cleaned blob', async () => {
        // Arrange
        const gitTwin = await twin('git-padded-version', 'clean', 'version=02\\n');
        const tsgitTwin = await twin('tsgit-padded-version', 'clean', 'version=02\\n');
        const sut = add;

        // Act
        runGit(['-C', gitTwin.repo, 'add', 'a.t']);
        await sut(createNodeContext({ workDir: tsgitTwin.repo }), ['a.t']);

        // Assert
        const staged = (repo: string) => runGit(['-C', repo, 'ls-files', '-s']);
        expect(staged(gitTwin.repo)).toContain(
          runGit(['-C', gitTwin.repo, 'hash-object', '--stdin'], { input: 'A\n' }).trim(),
        );
        expect(staged(tsgitTwin.repo)).toEqual(staged(gitTwin.repo));
      });
    });
  },
);

describe.skipIf(!GIT_AVAILABLE || process.platform === 'win32')(
  'Given a clean filter under text and ident',
  () => {
    let root = '';

    beforeAll(async () => {
      root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-filter-order-')));
    });

    afterAll(async () => {
      await rm(root, { recursive: true, force: true });
    });

    const repoWithFilter = async (slug: string): Promise<string> => {
      const repo = path.join(root, slug);
      runGit(['init', '-q', '-b', 'main', repo]);
      await writeFile(path.join(repo, '.gitattributes'), `${FILTER_FIXTURE.attributes}\n`);
      await writeFile(path.join(repo, 'f'), FILTER_FIXTURE.worktree);
      runGit(['-C', repo, 'config', 'filter.t.clean', FILTER_FIXTURE.clean]);
      return repo;
    };

    describe('When git and tsgit add a file', () => {
      it('Then both stage the clean output, converted to LF, with the ident collapsed', async () => {
        // Arrange
        const gitRepo = await repoWithFilter('git');
        const tsgitRepo = await repoWithFilter('tsgit');
        const sut = add;

        // Act
        runGit(['-C', gitRepo, 'add', 'f']);
        await sut(createNodeContext({ workDir: tsgitRepo }), ['f']);

        // Assert
        const staged = (repo: string) => enc(blobAt(repo, 'f'));
        expect(staged(gitRepo)).toBe('ZN$Id$NaRNbN');
        expect(staged(tsgitRepo)).toBe(staged(gitRepo));
      });
    });

    describe('When git and tsgit restore the committed file under core.autocrlf=true and a smudge driver', () => {
      it('Then the smudge received the CRs and the expanded $Id: <oid> $, in both tools', async () => {
        // Arrange
        const committed = async (slug: string): Promise<string> => {
          const repo = await repoWithFilter(slug);
          runGit(['-C', repo, 'config', 'user.name', 'Ada']);
          runGit(['-C', repo, 'config', 'user.email', 'ada@example.com']);
          runGit(['-C', repo, 'config', 'commit.gpgsign', 'false']);
          runGit(['-C', repo, 'add', 'f']);
          runGit(['-C', repo, 'commit', '-q', '-m', 'one']);
          runGit(['-C', repo, 'config', 'filter.t.smudge', FILTER_FIXTURE.smudge]);
          runGit(['-C', repo, 'config', 'core.autocrlf', 'true']);
          await rm(path.join(repo, 'f'));
          return repo;
        };
        const gitRepo = await committed('git-checkout');
        const tsgitRepo = await committed('tsgit-checkout');
        const sut = checkout;

        // Act
        runGit(['-C', gitRepo, 'checkout', '--', 'f']);
        await sut(createNodeContext({ workDir: tsgitRepo }), { paths: ['f'] });

        // Assert
        const worktree = async (repo: string) =>
          enc(new Uint8Array(await readFile(path.join(repo, 'f'))));
        const oid = git(gitRepo, 'rev-parse', ':f').trim();
        expect(await worktree(gitRepo)).toBe(`ZRN#Id: ${oid} #RNarRNbRN`);
        expect(await worktree(tsgitRepo)).toBe(await worktree(gitRepo));
      });
    });
  },
);
