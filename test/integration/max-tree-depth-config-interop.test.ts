/**
 * Cross-tool interop — the repo-wide eager `core.maxTreeDepth` refusal.
 * Builds ONE repository with real git (deterministic dates, signing off),
 * poisons its local config with an invalid `core.maxTreeDepth`, then proves
 * canonical git's refusal/survival split at that boundary matches tsgit's:
 * four previously-ungated commands (archive, fsck, grep, bundle create) now
 * refuse; config/init/remote and the two bundle-reading commands survive; and
 * the gate observes the effective (last-wins) value, not line position.
 * clone is pinned separately: git's refusal there is SOURCE-side only, so
 * this client-only clone deliberately grows no destination-side gate.
 *
 * @proves
 *   surface:        repo-state
 *   bucket:         cross-tool-interop
 *   unique:         an invalid core.maxTreeDepth refuses the same operational surface real git refuses (git 2.55.0) and survives the same porcelain surface real git survives, keyed on the effective last-wins value
 *   interopSurface: archive, bundleCreate, bundleListHeads, bundleVerify, config, fsck, grep, init, log, remote, status
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { add } from '../../src/application/commands/add.js';
import { archive } from '../../src/application/commands/archive.js';
import { bundleCreate } from '../../src/application/commands/bundle-create.js';
import { bundleListHeads } from '../../src/application/commands/bundle-list-heads.js';
import { bundleVerify } from '../../src/application/commands/bundle-verify.js';
import { commit } from '../../src/application/commands/commit.js';
import { configGet, configList, configSet } from '../../src/application/commands/config.js';
import { fsck } from '../../src/application/commands/fsck.js';
import { grep } from '../../src/application/commands/grep.js';
import { init } from '../../src/application/commands/init.js';
import { log } from '../../src/application/commands/log.js';
import { remoteList } from '../../src/application/commands/remote.js';
import { revParse } from '../../src/application/commands/rev-parse.js';
import { status } from '../../src/application/commands/status.js';
import { invalidateConfigCache } from '../../src/application/primitives/config-read.js';
import { TsgitError } from '../../src/domain/error.js';
import type { Context } from '../../src/ports/context.js';
import { GIT_AVAILABLE, git, runGit, runGitEnv, tryRunGitWithExit } from './interop-helpers.js';

const SETUP_TIMEOUT = 60_000;

const datedEnv = (epoch: number): NodeJS.ProcessEnv => ({
  ...runGitEnv(),
  GIT_AUTHOR_NAME: 'A U Thor',
  GIT_AUTHOR_EMAIL: 'author@example.com',
  GIT_AUTHOR_DATE: `${epoch} +0000`,
  GIT_COMMITTER_NAME: 'A U Thor',
  GIT_COMMITTER_EMAIL: 'author@example.com',
  GIT_COMMITTER_DATE: `${epoch} +0000`,
});

interface BadNumericData {
  readonly code: string;
  readonly key: string;
  readonly value: string;
  readonly reason: string;
}

/** Assert `op` rejects with the eager gate's exact refusal shape. */
const assertRefusesWithBadMaxTreeDepth = async (op: () => Promise<unknown>): Promise<void> => {
  let caught: unknown;
  try {
    await op();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(TsgitError);
  const data = (caught as TsgitError).data as BadNumericData;
  expect(data.code).toBe('CONFIG_BAD_NUMERIC_VALUE');
  expect(data.key).toBe('core.maxtreedepth');
  expect(data.value).toBe('2.5');
  expect(data.reason).toBe('invalid unit');
};

describe.skipIf(!GIT_AVAILABLE)('core.maxTreeDepth eager refusal — cross-tool interop', () => {
  let dir = '';
  let configPath = '';
  let baseConfigText = '';
  let bundleFile = '';
  let ctx: Context;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-maxtreedepth-config-'));
    configPath = path.join(dir, '.git', 'config');

    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.name', 'A U Thor');
    git(dir, 'config', 'user.email', 'author@example.com');
    git(dir, 'config', 'commit.gpgsign', 'false');

    writeFileSync(path.join(dir, 'file.txt'), 'hello\n');
    git(dir, 'add', '-A');
    runGit(['-C', dir, 'commit', '-q', '--no-gpg-sign', '-m', 'c0'], {
      env: datedEnv(1_700_000_000),
    });

    // Build the bundle WHILE config is still valid — bundle create itself
    // joins the refused set once the config below is poisoned.
    bundleFile = path.join(dir, 'repo.bundle');
    git(dir, 'bundle', 'create', bundleFile, '--all');

    // The clean, git-generated config text — N7/N8 rebuild their own
    // (in)valid maxTreeDepth suffix on top of this, never on top of the
    // already-poisoned text below.
    baseConfigText = readFileSync(configPath, 'utf8');

    // Poison AFTER every valid-state git operation above.
    writeFileSync(configPath, `${baseConfigText}[core]\n\tmaxTreeDepth = 2.5\n`);

    // Built AFTER every git write above — the per-Context loose-object fanout
    // cache is invalidated only by tsgit's own writeObject.
    ctx = createNodeContext({ workDir: dir });
  }, SETUP_TIMEOUT);

  afterAll(async () => rm(dir, { recursive: true, force: true }));

  // ─────────────────────────────────────────────────────────────────────
  // N1 / N2 / N2b — the config porcelain survives; the invalid value reads
  // back verbatim.
  // ─────────────────────────────────────────────────────────────────────

  describe('Given a repo whose local config holds an invalid core.maxTreeDepth', () => {
    describe('When the config porcelain reads or writes', () => {
      it('Then git config --get user.name exits 0 and configGet succeeds', async () => {
        // Arrange + Act — against the shared beforeAll repo, whose local
        // config already holds an invalid core.maxTreeDepth.
        const g = tryRunGitWithExit(['-C', dir, 'config', '--get', 'user.name']);
        const result = await configGet(ctx, { key: 'user.name' });

        // Assert
        expect(g.exitCode).toBe(0);
        expect(result.value).toBe('A U Thor');
      });

      it('Then git config --list exits 0 and configList succeeds', async () => {
        // Arrange + Act — against the shared beforeAll repo, whose local
        // config already holds an invalid core.maxTreeDepth.
        const g = tryRunGitWithExit(['-C', dir, 'config', '--list']);
        const result = await configList(ctx);

        // Assert
        expect(g.exitCode).toBe(0);
        expect(result.entries.length).toBeGreaterThan(0);
      });

      it('Then git config --local --list exits 0 and configList (local scope) succeeds', async () => {
        // Arrange + Act — against the shared beforeAll repo, whose local
        // config already holds an invalid core.maxTreeDepth.
        const g = tryRunGitWithExit(['-C', dir, 'config', '--local', '--list']);
        const result = await configList(ctx, { scope: 'local' });

        // Assert
        expect(g.exitCode).toBe(0);
        expect(result.entries.length).toBeGreaterThan(0);
      });

      it('Then git config --get core.maxTreeDepth reads 2.5 back and configGet matches verbatim', async () => {
        // Arrange + Act — against the shared beforeAll repo, whose local
        // config already holds an invalid core.maxTreeDepth.
        const g = tryRunGitWithExit(['-C', dir, 'config', '--get', 'core.maxTreeDepth']);
        const result = await configGet(ctx, { key: 'core.maxTreeDepth' });

        // Assert — this is the row that fails on any per-entry strict variant.
        expect(g.exitCode).toBe(0);
        expect(g.stdout.trim()).toBe('2.5');
        expect(result.value).toBe('2.5');
      });

      it('Then a git config write exits 0 and configSet succeeds', async () => {
        // Arrange + Act — against the shared beforeAll repo, whose local
        // config already holds an invalid core.maxTreeDepth.
        const g = tryRunGitWithExit(['-C', dir, 'config', 'interop.gitMark', 'git-wrote-this']);
        const result = await configSet(ctx, {
          key: 'interop.tsgitMark',
          value: 'tsgit-wrote-this',
        });

        // Assert
        expect(g.exitCode).toBe(0);
        expect(result.value).toBe('tsgit-wrote-this');
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // N3 — the already-gated four refuse.
  // ─────────────────────────────────────────────────────────────────────

  describe('Given a repo whose local config holds an invalid core.maxTreeDepth', () => {
    describe('When an operational command runs', () => {
      it('Then git log exits 128 and tsgit log throws', async () => {
        // Arrange + Act — against the shared beforeAll repo, whose local
        // config already holds an invalid core.maxTreeDepth.
        const g = tryRunGitWithExit(['-C', dir, 'log']);

        // Assert
        expect(g.exitCode).toBe(128);
        await assertRefusesWithBadMaxTreeDepth(() => log(ctx));
      });

      it('Then git rev-parse HEAD exits 128 and tsgit revParse throws', async () => {
        // Arrange + Act — against the shared beforeAll repo, whose local
        // config already holds an invalid core.maxTreeDepth.
        const g = tryRunGitWithExit(['-C', dir, 'rev-parse', 'HEAD']);

        // Assert
        expect(g.exitCode).toBe(128);
        await assertRefusesWithBadMaxTreeDepth(() => revParse(ctx, 'HEAD'));
      });

      it('Then git add exits 128 and tsgit add throws', async () => {
        // Arrange + Act — against the shared beforeAll repo, whose local
        // config already holds an invalid core.maxTreeDepth.
        const g = tryRunGitWithExit(['-C', dir, 'add', '-A']);

        // Assert
        expect(g.exitCode).toBe(128);
        await assertRefusesWithBadMaxTreeDepth(() => add(ctx, ['file.txt']));
      });

      it('Then git commit exits 128 and tsgit commit throws', async () => {
        // Arrange + Act — against the shared beforeAll repo, whose local
        // config already holds an invalid core.maxTreeDepth.
        const g = tryRunGitWithExit(['-C', dir, 'commit', '-q', '--no-gpg-sign', '-m', 'nope']);

        // Assert
        expect(g.exitCode).toBe(128);
        await assertRefusesWithBadMaxTreeDepth(() => commit(ctx, { message: 'nope' }));
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // N3b — the five newly-gated commands refuse.
  // ─────────────────────────────────────────────────────────────────────

  describe('Given a repo whose local config holds an invalid core.maxTreeDepth', () => {
    describe('When a newly-gated command runs', () => {
      it('Then git archive --format=tar exits 128 and tsgit archive throws', async () => {
        // Arrange + Act — against the shared beforeAll repo, whose local
        // config already holds an invalid core.maxTreeDepth.
        const g = tryRunGitWithExit(['-C', dir, 'archive', '--format=tar', 'HEAD']);

        // Assert
        expect(g.exitCode).toBe(128);
        await assertRefusesWithBadMaxTreeDepth(() => archive(ctx, { treeish: 'HEAD' }));
      });

      it('Then git fsck exits 128 and tsgit fsck throws', async () => {
        // Arrange + Act — against the shared beforeAll repo, whose local
        // config already holds an invalid core.maxTreeDepth.
        const g = tryRunGitWithExit(['-C', dir, 'fsck']);

        // Assert
        expect(g.exitCode).toBe(128);
        await assertRefusesWithBadMaxTreeDepth(() => fsck(ctx));
      });

      it('Then git grep exits 128 and tsgit grep throws', async () => {
        // Arrange + Act — against the shared beforeAll repo, whose local
        // config already holds an invalid core.maxTreeDepth.
        const g = tryRunGitWithExit(['-C', dir, 'grep', 'hello']);

        // Assert
        expect(g.exitCode).toBe(128);
        await assertRefusesWithBadMaxTreeDepth(() => grep(ctx, { patterns: [{ fixed: 'hello' }] }));
      });

      it('Then git bundle create exits 128 and tsgit bundleCreate throws', async () => {
        // Arrange + Act — against the shared beforeAll repo, whose local
        // config already holds an invalid core.maxTreeDepth.
        const g = tryRunGitWithExit([
          '-C',
          dir,
          'bundle',
          'create',
          path.join(dir, 'refused.bundle'),
          '--all',
        ]);

        // Assert
        expect(g.exitCode).toBe(128);
        await assertRefusesWithBadMaxTreeDepth(() => bundleCreate(ctx, { all: true }));
      });

      // clone's refusal is SOURCE-side only, and that is the whole point of
      // these two rows. Git refuses while serving a local-path clone whose
      // SOURCE carries the bad config — the serving process reads its own
      // config at startup. Git does NOT read the destination's config: an
      // occupied destination fails with "already exists" first. tsgit's
      // clone is client-only and reaches its source through a transport, so
      // it has no analogue for the source-side read and deliberately grows
      // no destination-side gate — one would refuse where git succeeds.
      it('Then git clone FROM the poisoned repo exits 128 (source-side config read)', async () => {
        // Arrange + Act — against the shared beforeAll repo, whose local
        // config already holds an invalid core.maxTreeDepth.
        const target = path.join(os.tmpdir(), `tsgit-maxtreedepth-clone-${Date.now()}`);
        const g = tryRunGitWithExit(['-C', dir, 'clone', '.', target]);

        // Assert
        expect(g.exitCode).toBe(128);
      });

      it('Then git clone INTO the poisoned repo reports occupancy, not the bad config', async () => {
        // Arrange + Act — the destination is the shared beforeAll repo
        // itself, whose local config already holds an invalid
        // core.maxTreeDepth.
        const g = tryRunGitWithExit(['clone', dir, dir]);

        // Assert — occupancy wins; the config is never read. The absence
        // oracle is the config-error signature, not the key name: the
        // fixture directory is itself named `…-maxtreedepth-config-…`, so a
        // bare key-name check matches the path git echoes back.
        expect(g.exitCode).toBe(128);
        expect(g.stderr).toContain('already exists');
        expect(g.stderr).not.toContain('bad numeric config value');
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // N3c / N4 — config's siblings (remote, init) stay ungated.
  // ─────────────────────────────────────────────────────────────────────

  describe('Given a repo whose local config holds an invalid core.maxTreeDepth', () => {
    describe('When remote -v runs', () => {
      it('Then git remote -v exits 0 and tsgit remoteList succeeds', async () => {
        // Arrange + Act — against the shared beforeAll repo, whose local
        // config already holds an invalid core.maxTreeDepth.
        const g = tryRunGitWithExit(['-C', dir, 'remote', '-v']);
        const result = await remoteList(ctx);

        // Assert
        expect(g.exitCode).toBe(0);
        expect(result.remotes).toEqual([]);
      });
    });

    describe('When init re-runs against the same directory', () => {
      it('Then git init exits 0 (a harmless re-init)', () => {
        // Arrange + Act — against the shared beforeAll repo, whose local
        // config already holds an invalid core.maxTreeDepth.
        const g = tryRunGitWithExit(['-C', dir, 'init']);

        // Assert
        expect(g.exitCode).toBe(0);
      });

      // tsgit's init() has no re-init no-op path at all — ANY existing
      // `${gitDir}/HEAD` throws ALREADY_INITIALIZED, independent of config
      // validity (see src/application/commands/init.ts). init.ts is
      // deliberately untouched by this gate, so the faithful proof here is
      // negative: the refusal reason is unrelated to core.maxTreeDepth, not
      // that tsgit mirrors git's re-init success.
      it('Then tsgit init throws ALREADY_INITIALIZED, never CONFIG_BAD_NUMERIC_VALUE', async () => {
        // Arrange + Act — against the shared beforeAll repo, whose local
        // config already holds an invalid core.maxTreeDepth.
        let caught: unknown;
        try {
          await init(ctx);
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('ALREADY_INITIALIZED');
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // The bundle pin — list-heads / verify were never gated; measured exit 0
  // against real git 2.55.0 with this same invalid value, so they stay
  // ungated and this row records that survival as an assertion.
  // ─────────────────────────────────────────────────────────────────────

  describe('Given a bundle git built while config was still valid', () => {
    describe('When bundle list-heads / verify run against the now-poisoned repo', () => {
      it('Then git bundle list-heads exits 0 and tsgit bundleListHeads succeeds (ungated)', async () => {
        // Arrange + Act — against the shared beforeAll repo, whose local
        // config already holds an invalid core.maxTreeDepth.
        const g = tryRunGitWithExit(['-C', dir, 'bundle', 'list-heads', bundleFile]);
        const result = await bundleListHeads(ctx, { path: bundleFile });

        // Assert
        expect(g.exitCode).toBe(0);
        expect(result.refs.length).toBeGreaterThan(0);
      });

      it('Then git bundle verify exits 0 and tsgit bundleVerify succeeds (ungated)', async () => {
        // Arrange + Act — against the shared beforeAll repo, whose local
        // config already holds an invalid core.maxTreeDepth.
        const g = tryRunGitWithExit(['-C', dir, 'bundle', 'verify', bundleFile]);
        const result = await bundleVerify(ctx, { path: bundleFile });

        // Assert
        expect(g.exitCode).toBe(0);
        expect(result.missingPrerequisites).toHaveLength(0);
        expect(result.refs.length).toBeGreaterThan(0);
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // N7 / N8 — the gate observes the EFFECTIVE (last-wins) value, not line
  // position. These rewrite the shared repo's config, so they run last.
  // ─────────────────────────────────────────────────────────────────────

  describe('Given maxTreeDepth = 2.5 (line 2) then maxTreeDepth = 2048 (line 3) — invalid-then-valid', () => {
    describe('When status runs', () => {
      it('Then git status --porcelain exits 0 and tsgit status succeeds', async () => {
        // Arrange
        writeFileSync(
          configPath,
          `${baseConfigText}[core]\n\tmaxTreeDepth = 2.5\n\tmaxTreeDepth = 2048\n`,
        );
        invalidateConfigCache(ctx);

        // Act
        const g = tryRunGitWithExit(['-C', dir, 'status', '--porcelain']);

        // Assert
        expect(g.exitCode).toBe(0);
        await status(ctx);
      });
    });
  });

  describe('Given maxTreeDepth = 2048 (line 2) then maxTreeDepth = 2.5 (line 3) — valid-then-invalid', () => {
    describe('When status runs', () => {
      it('Then git status --porcelain exits 128 and tsgit status throws', async () => {
        // Arrange
        writeFileSync(
          configPath,
          `${baseConfigText}[core]\n\tmaxTreeDepth = 2048\n\tmaxTreeDepth = 2.5\n`,
        );
        invalidateConfigCache(ctx);

        // Act
        const g = tryRunGitWithExit(['-C', dir, 'status', '--porcelain']);

        // Assert
        expect(g.exitCode).toBe(128);
        await assertRefusesWithBadMaxTreeDepth(() => status(ctx));
      });
    });
  });
});
