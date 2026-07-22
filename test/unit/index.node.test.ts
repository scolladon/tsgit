/**
 * Unit coverage for the Node-runtime entry point (src/index.node.ts).
 *
 * Stryker runs only `test/unit`, so the option-defaulting branches of the
 * Node shim (insecure-HTTP default, delta-cache entry cap, layout-discovery
 * `bare` flag) must be exercised here — the integration suite does not feed
 * the mutation runner.
 */
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { NodeSshTransport } from '../../src/adapters/node/node-ssh-transport.js';
import { TsgitError } from '../../src/domain/index.js';
import { openRepository } from '../../src/index.node.js';

let tmpdir: string;

beforeEach(async () => {
  tmpdir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-node-unit-'));
});

afterEach(async () => {
  await rm(tmpdir, { recursive: true, force: true });
});

describe('Node shim — allowInsecureHttp default', () => {
  describe('Given no allowInsecureHttp option', () => {
    describe('When an http:// request is made', () => {
      it('Then the transport rejects with the HTTPS-required reason', async () => {
        // Arrange — allowInsecure config lets the SSRF wrapper pass the URL through
        // to the inner NodeHttpTransport, whose own HTTPS guard is what we probe.
        // Default allowInsecureHttp must be false: kills the L60 BooleanLiteral
        // `false` → `true` mutant (which would let the http:// request connect and
        // surface a different — connection — error instead).
        const sut = await openRepository({
          cwd: tmpdir,
          config: {
            allowInsecure: true,
            allowPrivateNetworks: true,
            dnsResolver: async () => ['127.0.0.1'],
          },
        });

        try {
          // Act
          let thrown: unknown;
          try {
            await sut.ctx.transport.request({
              url: 'http://127.0.0.1:1/',
              method: 'GET',
              headers: {},
            });
          } catch (e) {
            thrown = e;
          }

          // Assert — the inner transport's HTTPS guard fired (not a connect error).
          expect((thrown as { data: { code: string; reason: string } }).data.code).toBe(
            'NETWORK_ERROR',
          );
          expect((thrown as { data: { reason: string } }).data.reason).toContain('HTTPS required');
        } finally {
          await sut.dispose();
        }
      });
    });
  });
});

describe('Node shim — allowInsecureHttp enabled', () => {
  describe('Given allowInsecureHttp is true', () => {
    describe('When an http:// request is made', () => {
      it('Then the inner transport allows plaintext and surfaces the connect error', async () => {
        // Arrange — allowInsecureHttp:true must reach the inner NodeHttpTransport
        // so its HTTPS guard stands down. Kills the L64 ObjectLiteral mutant that
        // replaces `{ allowInsecureHttp: opts.allowInsecureHttp ?? false }` with
        // `{}`: the empty object defaults the transport to insecure=false, which
        // would reject with `HTTPS required` instead of attempting the socket.
        const sut = await openRepository({
          cwd: tmpdir,
          allowInsecureHttp: true,
          config: {
            allowInsecure: true,
            allowPrivateNetworks: true,
            dnsResolver: async () => ['127.0.0.1'],
          },
        });

        try {
          // Act
          let thrown: unknown;
          try {
            await sut.ctx.transport.request({
              url: 'http://127.0.0.1:1/',
              method: 'GET',
              headers: {},
            });
          } catch (e) {
            thrown = e;
          }

          // Assert — the socket was attempted (refused), not blocked by the guard.
          const data = (thrown as { data: { code: string; reason: string } }).data;
          expect(data.code).toBe('NETWORK_ERROR');
          expect(data.reason).toBe('Connection refused');
        } finally {
          await sut.dispose();
        }
      });
    });
  });
});

describe('Node shim — deltaCacheMaxEntries option', () => {
  describe('Given an explicit deltaCacheMaxEntries of 3', () => {
    describe('When a 4th tiny entry is set', () => {
      it('Then the cache evicts down to the cap', async () => {
        // Arrange — kills the L72 LogicalOperator `??` → `&&` mutant: with `&&`
        // the supplied cap (3) would be replaced by DEFAULT_DELTA_CACHE_ENTRIES
        // (65 536), so the 4th entry would NOT trigger eviction.
        const sut = await openRepository({ cwd: tmpdir, deltaCacheMaxEntries: 3 });
        const one = new Uint8Array([1]);

        try {
          // Act
          sut.ctx.deltaCache.set('a', one, 1);
          sut.ctx.deltaCache.set('b', one, 1);
          sut.ctx.deltaCache.set('c', one, 1);
          sut.ctx.deltaCache.set('d', one, 1);

          // Assert
          expect(sut.ctx.deltaCache.entryCount).toBe(3);
        } finally {
          await sut.dispose();
        }
      });
    });
  });
});

describe('Node shim — discoverLayout bare flag', () => {
  describe('Given a cwd whose parent contains a real .git directory', () => {
    describe('When openRepository runs', () => {
      it('Then the discovered layout has bare:false', async () => {
        // Arrange — a real .git directory so discoverLayout returns its own
        // object literal (not the synthetic fallback).
        await mkdir(path.join(tmpdir, '.git'), { recursive: true });
        const sub = path.join(tmpdir, 'nested');
        await mkdir(sub, { recursive: true });

        // Act
        const sut = await openRepository({ cwd: sub });

        try {
          // Assert — discoverLayout found the parent .git and reported bare:false.
          expect(sut.ctx.layout.bare).toBe(false);
          expect(sut.ctx.layout.gitDir).toContain('.git');
        } finally {
          await sut.dispose();
        }
      });

      it('Then the walk climbs to the ancestor that owns .git', async () => {
        // Arrange — .git lives in the parent; the walk must ascend one level.
        // Every stop-early / fall-back mutant on the loop guards (isDirectory
        // match, block body, parent===current terminator) would yield the
        // synthetic fallback rooted at `nested` instead of the discovered
        // ancestor, so asserting the exact discovered workDir kills them all.
        await mkdir(path.join(tmpdir, '.git'), { recursive: true });
        const sub = path.join(tmpdir, 'nested');
        await mkdir(sub, { recursive: true });
        const ancestor = await realpath(tmpdir);

        // Act
        const sut = await openRepository({ cwd: sub });

        try {
          // Assert — workDir is the .git-owning ancestor, not the cwd itself.
          expect(sut.ctx.layout.workDir).toBe(ancestor);
          expect(sut.ctx.layout.gitDir).toBe(path.join(ancestor, '.git'));
        } finally {
          await sut.dispose();
        }
      });
    });
  });
});

describe('Node shim — synthetic fallback layout', () => {
  describe('Given a cwd with no .git anywhere in its ancestry', () => {
    describe('When openRepository runs', () => {
      it('Then the fallback layout is a non-bare gitDir under the resolved cwd', async () => {
        // Arrange — a fresh tmpdir with no `.git` on the walk forces
        // discoverLayout to return undefined, exercising the synthetic
        // fallback object literal. Pins its `gitDir` (`<workDir>/.git`, killing
        // the StringLiteral `.git` → `""` mutant that would collapse it to
        // `workDir`) and its `bare: false` field (killing the BooleanLiteral
        // `false` → `true` mutant).
        const resolvedWorkDir = await realpath(tmpdir);

        // Act
        const sut = await openRepository({ cwd: tmpdir });

        try {
          // Assert
          expect(sut.ctx.layout.workDir).toBe(resolvedWorkDir);
          expect(sut.ctx.layout.gitDir).toBe(path.join(resolvedWorkDir, '.git'));
          expect(sut.ctx.layout.bare).toBe(false);
        } finally {
          await sut.dispose();
        }
      });
    });
  });
});

describe('Node shim — ssh/env/runtime context wiring', () => {
  describe('Given a Node-runtime repository', () => {
    describe('When openRepository runs', () => {
      it('Then ctx.ssh is a NodeSshTransport, ctx.env is defined, and ctx.runtime is node', async () => {
        // Arrange & Act
        const sut = await openRepository({ cwd: tmpdir });

        try {
          // Assert
          expect(sut.ctx.ssh).toBeInstanceOf(NodeSshTransport);
          expect(sut.ctx.env).toBeDefined();
          expect(sut.ctx.runtime).toBe('node');
        } finally {
          await sut.dispose();
        }
      });
    });
  });

  describe('Given GIT_NOTES_REF points outside refs/notes/', () => {
    describe('When a notes verb runs through openRepository', () => {
      it('Then the env var is honoured and refused as NOTES_REF_OUTSIDE', async () => {
        // Arrange — env now reaches commands through the wired ctx.env.
        const saved = process.env.GIT_NOTES_REF;
        process.env.GIT_NOTES_REF = 'refs/heads/evil';
        const sut = await openRepository({ cwd: tmpdir });

        try {
          await sut.init();
          // Act
          let caught: unknown;
          try {
            await sut.notes.list();
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data as { code: string; ref?: string };
          expect(data.code).toBe('NOTES_REF_OUTSIDE');
        } finally {
          await sut.dispose();
          if (saved === undefined) {
            delete process.env.GIT_NOTES_REF;
          } else {
            process.env.GIT_NOTES_REF = saved;
          }
        }
      });
    });
  });
});

describe('Node shim — worktreeFs raw adapter root', () => {
  describe('Given the raw worktree filesystem (unsafeRawAdapters)', () => {
    describe('When a path inside the repo/worktree common ancestor is probed', () => {
      // POSIX-only: makeWorktreeFs roots the raw adapter at `commonAncestor`,
      // which operates on absolute POSIX paths and returns a `/`-shaped root.
      // On Windows a real `C:\…` probe can never match that root, so this
      // real-filesystem containment probe runs on POSIX platforms only — the
      // linux mutation run still kills the mutant this test targets.
      it.skipIf(process.platform === 'win32')(
        'Then the raw adapter is rooted at the common ancestor and reaches it',
        async () => {
          // Arrange — unsafeRawAdapters:true exposes the raw NodeFileSystem the
          // Node shim builds via makeWorktreeFs, rooted at the common ancestor of
          // the workDir and the worktree paths (here the resolved cwd). The L87
          // ArrayDeclaration mutant swaps that argument array for `[]`, so
          // commonAncestor([]) collapses to '/', whose containment prefix rejects
          // every real absolute path with PERMISSION_DENIED. A directory inside
          // the repo must therefore stay reachable — the correct root contains it
          // (exists resolves), the mutant root '/' refuses it. Every path is
          // derived from the repo's own resolved workDir so the created directory,
          // the worktree root and the probe all share one canonical form — the
          // containment prefix stays case-exact on every platform (incl. Windows,
          // where tmpdir's 8.3 short form would otherwise diverge from realpath).
          const sut = await openRepository({ cwd: tmpdir, unsafeRawAdapters: true });
          const resolvedWorkDir = sut.ctx.layout.workDir;
          await mkdir(path.join(resolvedWorkDir, 'inside'), { recursive: true });
          const worktreeFs = sut.ctx.worktreeFs;
          expect(worktreeFs).toBeDefined();
          const rawFs = worktreeFs?.(path.join(resolvedWorkDir, 'wt'));

          try {
            // Act — probe an existing directory inside the common ancestor.
            const result = await rawFs?.exists(path.join(resolvedWorkDir, 'inside'));

            // Assert — reachable under the correct root; the mutant root would throw.
            expect(result).toBe(true);
          } finally {
            await sut.dispose();
          }
        },
      );
    });
  });
});
