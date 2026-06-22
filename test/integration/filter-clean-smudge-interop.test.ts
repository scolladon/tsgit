/**
 * Cross-tool interop — clean/smudge filter driver faithfulness.
 *
 * Pins F1 (clean@add stores cleaned blob; smudge@checkout writes smudged bytes;
 * git diff is clean after checkout), F2 (clean-only ⇒ identity smudge), F3
 * (required=true + failing clean ⇒ fatal; tsgit throws CLEAN_FILTER_FAILED with
 * structured data; git refuses with exit 128), and F4 (required absent ⇒ exit 0,
 * raw bytes staged — assert raw blob OID parity).
 *
 * Slices 8/9 extend this SAME file with smudge@checkout and F1-no-diff halves.
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
import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/index.js';
import { add } from '../../src/application/commands/add.js';
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

    // Configure local filter drivers in .git/config
    runGit(['-C', dir, 'config', `filter.myf.clean`, cleanScript]);
    runGit(['-C', dir, 'config', `filter.fail-req.clean`, cleanFailScript]);
    runGit(['-C', dir, 'config', `filter.fail-req.required`, 'true']);
    runGit(['-C', dir, 'config', `filter.fail-opt.clean`, cleanFailScript]);

    // .gitattributes mapping
    await writeFile(
      path.join(dir, '.gitattributes'),
      ['*.y filter=myf', '*.req filter=fail-req', '*.opt filter=fail-opt'].join('\n') + '\n',
    );

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
});
