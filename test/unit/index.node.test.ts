/**
 * Unit coverage for the Node-runtime entry point (src/index.node.ts).
 *
 * Stryker runs only `test/unit`, so the option-defaulting branches of the
 * Node shim (insecure-HTTP default, delta-cache entry cap, layout-discovery
 * `bare` flag) must be exercised here — the integration suite does not feed
 * the mutation runner.
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { NodeSshTransport } from '../../src/adapters/node/node-ssh-transport.js';
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
        // object literal (not the synthetic fallback). Kills the L100 BooleanLiteral
        // `false` → `true` mutant on the discovered layout's `bare` field.
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
});
