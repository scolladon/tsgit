/**
 * Cross-tool interop — the `HEAD` identity cache a `Context` carries across
 * commands is genuinely re-validated against the real filesystem (never
 * silently stale after an external rewrite), and the real Node adapter's
 * non-degenerate `ino` is what collapses an unchanged second read to a
 * single `lstat`.
 *
 * Before this file, both proofs lived only through a synthetic proxy
 * (`withNodeIdentity`, faking a Node-shaped identity over the memory
 * adapter) — nothing rewrote HEAD with real git between two tsgit commands
 * sharing one Context, and nothing measured the REAL Node filesystem's own
 * call shape.
 *
 * @proves
 *   surface:        rev-parse
 *   bucket:         cross-tool-interop
 *   unique:         a real-git HEAD rewrite between two tsgit commands on
 *                    one Context is observed, not served stale; the real
 *                    Node adapter's lstat identity collapses an unchanged
 *                    second read to a single lstat
 *   interopSurface: HEAD
 */
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { revParse } from '../../src/application/commands/rev-parse.js';
import type { Context } from '../../src/ports/context.js';
import { instrumentedContext } from '../unit/application/primitives/fixtures.js';
import { disableAutoMaintenance, GIT_AVAILABLE, git } from './interop-helpers.js';

const SETUP_TIMEOUT = 60_000;

const headPathOf = (ctx: Context): string => `${ctx.layout.gitDir}/HEAD`;

const initRepo = (dir: string): void => {
  git(dir, 'init', '-q', '-b', 'main');
  disableAutoMaintenance(dir);
  git(dir, 'config', 'user.name', 'Ada');
  git(dir, 'config', 'user.email', 'ada@example.com');
  git(dir, 'config', 'commit.gpgsign', 'false');
};

describe.skipIf(!GIT_AVAILABLE)('HEAD identity freshness interop', () => {
  describe('Given HEAD rewritten by real git between two revParse(HEAD) calls on one Context', () => {
    let dir = '';
    let mainId = '';
    let sideId = '';
    let ctx: Context;

    beforeAll(async () => {
      dir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-head-freshness-'));
      initRepo(dir);
      git(dir, 'commit', '-q', '--allow-empty', '-m', 'on main');
      mainId = git(dir, 'rev-parse', 'HEAD').trim();
      git(dir, 'checkout', '-q', '-b', 'side');
      git(dir, 'commit', '-q', '--allow-empty', '-m', 'on side');
      sideId = git(dir, 'rev-parse', 'HEAD').trim();
      git(dir, 'checkout', '-q', 'main');
      ctx = createNodeContext({ workDir: dir });
    }, SETUP_TIMEOUT);

    afterAll(async () => rm(dir, { recursive: true, force: true }));

    describe(
      'When revParse(HEAD) runs, git retargets HEAD to refs/heads/side ' +
        '(same length as refs/heads/main), and revParse(HEAD) runs again on the SAME Context',
      () => {
        it('Then the second call reports the NEW target — the cached identity is never stale', async () => {
          // Arrange / Act — 'refs/heads/side' is the same length as
          // 'refs/heads/main', so this cannot pass by accident on a
          // size-only staleness check; only a genuine lstat-identity
          // re-check (mtime/ctime/ino) catches the rewrite.
          const first = await revParse(ctx, 'HEAD');
          git(dir, 'symbolic-ref', 'HEAD', 'refs/heads/side');
          const second = await revParse(ctx, 'HEAD');

          // Assert
          expect(first).toBe(mainId);
          expect(second).toBe(sideId);
        });
      },
    );
  });

  describe('Given HEAD unchanged between two revParse(HEAD) calls on one REAL Node Context', () => {
    let dir = '';
    let commitId = '';

    beforeAll(async () => {
      dir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-head-freshness-lstat-only-'));
      initRepo(dir);
      git(dir, 'commit', '-q', '--allow-empty', '-m', 'root');
      commitId = git(dir, 'rev-parse', 'HEAD').trim();
    }, SETUP_TIMEOUT);

    afterAll(async () => rm(dir, { recursive: true, force: true }));

    describe('When revParse(HEAD) runs twice with no external change', () => {
      it('Then the second gate issues lstat only on HEAD — the real Node adapter reports a non-degenerate ino', async () => {
        // Arrange — the REAL NodeFileSystem, not a synthetic ino!==0 proxy.
        const base = createNodeContext({ workDir: dir });
        const { ctx, calls } = instrumentedContext(base);
        const headPath = headPathOf(ctx);

        // Act
        const first = await revParse(ctx, 'HEAD');
        const before = calls().length;
        const second = await revParse(ctx, 'HEAD');
        const duringSecondCall = calls()
          .slice(before)
          .filter((c) => c.path === headPath);

        // Assert
        expect(first).toBe(commitId);
        expect(second).toBe(commitId);
        expect(duringSecondCall).toEqual([{ method: 'lstat', path: headPath }]);
      });
    });
  });
});
