/**
 * Unit coverage for the Node-runtime entry point (src/index.node.ts).
 *
 * Stryker runs only `test/unit`, so the option-defaulting branches of the
 * Node shim (insecure-HTTP default, delta-cache entry cap, layout-discovery
 * `bare` flag) must be exercised here — the integration suite does not feed
 * the mutation runner.
 */
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
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

/**
 * Marks `dir` as a valid git directory: `objects/`, `refs/`, and a `HEAD`
 * file. `findLayout`'s directory validation skips a `.git` that lacks these,
 * continuing the walk upward instead of accepting a bare `mkdir`.
 */
const makeGitDir = async (dir: string): Promise<void> => {
  await mkdir(path.join(dir, 'objects'), { recursive: true });
  await mkdir(path.join(dir, 'refs'), { recursive: true });
  await writeFile(path.join(dir, 'HEAD'), 'ref: refs/heads/main\n');
};

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

describe('Node shim — findLayout bare flag', () => {
  describe('Given a cwd whose parent contains a real .git directory', () => {
    describe('When openRepository runs', () => {
      it('Then the discovered layout has bare:false', async () => {
        // Arrange — a valid .git directory so findLayout returns its own
        // object literal (not the synthetic fallback).
        await makeGitDir(path.join(tmpdir, '.git'));
        const sub = path.join(tmpdir, 'nested');
        await mkdir(sub, { recursive: true });

        // Act
        const sut = await openRepository({ cwd: sub });

        try {
          // Assert — findLayout found the parent .git and reported bare:false.
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
        await makeGitDir(path.join(tmpdir, '.git'));
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

describe('Node shim — explicit layout option validation ordering', () => {
  describe('Given gitDir: "" (empty string)', () => {
    describe('When openRepository runs', () => {
      it('Then it throws INVALID_OPTION{option: "gitDir"} rather than resolving a layout at cwd', async () => {
        // Arrange / Act
        let caught: unknown;
        try {
          await openRepository({ cwd: tmpdir, gitDir: '' });
        } catch (err) {
          caught = err;
        }

        // Assert — validateOptions runs BEFORE resolveNodeLayout in this
        // shim; an empty gitDir must never reach layout resolution.
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data;
        expect(data.code).toBe('INVALID_OPTION');
        if (data.code === 'INVALID_OPTION') {
          expect(data.option).toBe('gitDir');
        }
      });
    });
  });
});

describe('Node shim — bare option forwarding', () => {
  describe('Given bare: true', () => {
    describe('When openRepository runs', () => {
      it('Then layout.bare is true and workDir is absent', async () => {
        // Arrange & Act
        const sut = await openRepository({ cwd: tmpdir, bare: true });

        try {
          // Assert
          expect(sut.ctx.layout.bare).toBe(true);
          expect(sut.ctx.layout.workDir).toBeUndefined();
        } finally {
          await sut.dispose();
        }
      });
    });
  });
});

describe('Node shim — gitDir option forwarding', () => {
  describe('Given an explicit gitDir', () => {
    describe('When openRepository runs', () => {
      it('Then layout.gitDir reflects it, not the <cwd>/.git default', async () => {
        // Arrange
        const customGitDir = path.join(tmpdir, 'custom.git');

        // Act
        const sut = await openRepository({ cwd: tmpdir, gitDir: customGitDir });

        try {
          // Assert — not yet realpath-able (does not exist), so it stays literal.
          expect(sut.ctx.layout.gitDir).toBe(customGitDir);
        } finally {
          await sut.dispose();
        }
      });
    });
  });
});

describe('Node shim — ceilingDirs option forwarding', () => {
  describe('Given a discoverable repository above cwd, bounded by ceilingDirs', () => {
    describe('When openRepository runs', () => {
      it('Then discovery stops at the ceiling and falls back to the bootstrap layout', async () => {
        // Arrange — a valid repo at tmpdir/.git, discoverable by a walk from
        // tmpdir/a/b UNLESS ceilingDirs stops it at tmpdir/a first.
        await makeGitDir(path.join(tmpdir, '.git'));
        const inner = path.join(tmpdir, 'a', 'b');
        await mkdir(inner, { recursive: true });
        const resolvedInner = await realpath(inner);

        // Act
        const sut = await openRepository({
          cwd: inner,
          ceilingDirs: [path.join(tmpdir, 'a')],
        });

        try {
          // Assert — the ceiling was honoured: tmpdir/.git was never reached,
          // so the synthetic bootstrap layout (rooted at `inner`) wins instead.
          expect(sut.ctx.layout.gitDir).toBe(path.join(resolvedInner, '.git'));
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
        // findLayout to return undefined, exercising the synthetic
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
    describe('When a path inside the repo workDir is probed', () => {
      // Runs on every platform: makeWorktreeFs hands the raw adapter the
      // repo's workDir followed by the caller's paths, and the adapter
      // compares them through the native `PathPolicy` (native separator,
      // drive/UNC aware) instead of assuming POSIX shape.
      it('Then the raw adapter is rooted at the workDir and reaches it', async () => {
        // Arrange — unsafeRawAdapters:true exposes the raw NodeFileSystem the
        // Node shim builds via makeWorktreeFs, rooted at the workDir plus the
        // worktree paths (here derived from the resolved cwd). The
        // ArrayDeclaration mutant swaps that argument array for `[]`, leaving
        // the adapter with no root at all — it then refuses to construct
        // (UNSUPPORTED_OPERATION), so building the fs throws instead of
        // returning one. A directory inside the repo must therefore stay
        // reachable. Every path is derived from the repo's own resolved
        // workDir so the created directory, the worktree root and the probe
        // all share one canonical form — the containment prefix stays
        // case-exact on every platform (incl. Windows, where tmpdir's 8.3
        // short form would otherwise diverge from realpath).
        const sut = await openRepository({ cwd: tmpdir, unsafeRawAdapters: true });
        // A fresh `openRepository({ cwd: tmpdir })` over an empty dir always
        // yields a work tree (the not-yet-a-repository fallback).
        const resolvedWorkDir = sut.ctx.layout.workDir as string;
        await mkdir(path.join(resolvedWorkDir, 'inside'), { recursive: true });
        const worktreeFs = sut.ctx.worktreeFs;
        const rawFs = worktreeFs?.(path.join(resolvedWorkDir, 'wt'));

        try {
          // Act — probe an existing directory inside the common ancestor.
          const result = await rawFs?.exists(path.join(resolvedWorkDir, 'inside'));

          // Assert — reachable under the correct root; the mutant root would throw.
          expect(worktreeFs).toBeDefined();
          expect(result).toBe(true);
        } finally {
          await sut.dispose();
        }
      });
    });
  });
});

describe('Node shim — worktreeFs raw adapter root (bare repository)', () => {
  describe('Given a bare repository (no work tree) and unsafeRawAdapters', () => {
    describe('When a path inside the caller-supplied worktree root is probed', () => {
      it('Then the raw adapter is rooted at exactly the supplied paths, with no bogus extra root', async () => {
        // Arrange — bare: layout.workDir is undefined, so makeWorktreeFs's
        // roots array is `[...[], ...worktreePaths]` — exactly worktreePaths.
        // The ArrayDeclaration mutant on the empty-branch literal would inject
        // a bogus non-absolute root ("Stryker was here"), breaking containment.
        const sut = await openRepository({ cwd: tmpdir, bare: true, unsafeRawAdapters: true });
        const wtPath = path.join(tmpdir, 'wt');
        await mkdir(path.join(wtPath, 'inside'), { recursive: true });
        const worktreeFs = sut.ctx.worktreeFs;
        const rawFs = worktreeFs?.(wtPath);

        try {
          // Act — probe an existing directory inside the supplied root.
          const result = await rawFs?.exists(path.join(wtPath, 'inside'));

          // Assert
          expect(worktreeFs).toBeDefined();
          expect(result).toBe(true);
        } finally {
          await sut.dispose();
        }
      });
    });
  });
});

describe('Given a directory whose HEAD is a dangling symlink into refs/', () => {
  describe('When openRepository discovers it', () => {
    it('Then the node probe reads the link text and the directory qualifies as a git directory', async () => {
      // Arrange
      const tmp = await mkdtemp(path.join(os.tmpdir(), 'tsgit-node-dangling-link-'));
      try {
        const dir = path.join(tmp, 'legacy.git');
        await mkdir(path.join(dir, 'objects'), { recursive: true });
        await mkdir(path.join(dir, 'refs'), { recursive: true });
        await symlink('refs/heads/main', path.join(dir, 'HEAD'));

        // Act
        const repo = await openRepository({ cwd: dir });

        try {
          // Assert
          expect(repo.ctx.layout.gitDir).toBe(await realpath(dir));
          expect(repo.ctx.layout.bare).toBe(true);
        } finally {
          await repo.dispose();
        }
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
    });
  });
});
