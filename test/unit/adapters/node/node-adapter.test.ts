import { homedir } from 'node:os';
import * as nodePath from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildLayout,
  createNodeContext,
  resolveHomeDir,
} from '../../../../src/adapters/node/node-adapter.js';
import { NodeCommandRunner } from '../../../../src/adapters/node/node-command-runner.js';
import { NodeCompressor } from '../../../../src/adapters/node/node-compressor.js';
import { NodeFileSystem } from '../../../../src/adapters/node/node-file-system.js';
import { NodeHashService } from '../../../../src/adapters/node/node-hash-service.js';
import { NodeHookRunner } from '../../../../src/adapters/node/node-hook-runner.js';
import { NodeHttpTransport } from '../../../../src/adapters/node/node-http-transport.js';
import { NodeSshTransport } from '../../../../src/adapters/node/node-ssh-transport.js';
import { TsgitError } from '../../../../src/domain/index.js';

describe('createNodeContext', () => {
  describe('Given workDir only', () => {
    describe('When creating context', () => {
      it('Then gitDir defaults to <workDir>/.git', () => {
        // Arrange
        const workDir = '/tmp/tsgit-ctx-test';

        // Act
        const sut = createNodeContext({ workDir });

        // Assert
        expect(sut.layout.workDir).toBe(nodePath.resolve(workDir));
        expect(sut.layout.gitDir).toBe(nodePath.join(nodePath.resolve(workDir), '.git'));
        expect(sut.layout.bare).toBe(false);
      });
    });
  });

  describe('Given explicit gitDir', () => {
    describe('When creating context', () => {
      it('Then uses resolved absolute gitDir', () => {
        // Arrange
        const workDir = '/tmp/tsgit-explicit-wt';
        const gitDir = '/tmp/tsgit-explicit-git';

        // Act
        const sut = createNodeContext({ workDir, gitDir });

        // Assert
        expect(sut.layout.gitDir).toBe(nodePath.resolve(gitDir));
      });
    });
  });

  describe('Given a runtime with a non-empty home directory', () => {
    describe('When creating context', () => {
      it('Then layout.homeDir matches os.homedir()', () => {
        // Arrange
        const expected = homedir();

        // Act
        const sut = createNodeContext({ workDir: '/tmp/tsgit-home' });

        // Assert — when the runtime provides a home dir, the layout surfaces it.
        if (expected === '') {
          expect(sut.layout.homeDir).toBeUndefined();
        } else {
          expect(sut.layout.homeDir).toBe(expected);
        }
      });
    });
  });

  describe('Given bare=true', () => {
    describe('When creating context', () => {
      it('Then config.bare is true', () => {
        // Arrange / Act
        const sut = createNodeContext({ workDir: '/tmp/tsgit-bare', bare: true });

        // Assert
        expect(sut.layout.bare).toBe(true);
      });
    });
  });

  describe('Given AbortSignal', () => {
    describe('When creating context', () => {
      it('Then signal is forwarded', () => {
        // Arrange
        const controller = new AbortController();

        // Act
        const sut = createNodeContext({ workDir: '/tmp/tsgit-sig', signal: controller.signal });

        // Assert
        expect(sut.signal).toBe(controller.signal);
      });
    });
  });

  describe('Given no signal', () => {
    describe('When creating context', () => {
      it('Then signal is undefined and the key is absent', () => {
        // Arrange / Act
        const sut = createNodeContext({ workDir: '/tmp/tsgit-nosig' });

        // Assert — no stray `signal: undefined` key (exactOptionalPropertyTypes).
        expect(sut.signal).toBeUndefined();
        expect('signal' in sut).toBe(false);
      });
    });
  });

  describe('Given default options', () => {
    describe('When creating context', () => {
      it('Then ctx.hooks is wired (a NodeHookRunner)', () => {
        // Arrange / Act
        const sut = createNodeContext({ workDir: '/tmp/tsgit-hooks-on' });

        // Assert — hooks run by default, like git (ADR-066).
        expect(sut.hooks).toBeInstanceOf(NodeHookRunner);
      });
    });
  });

  describe('Given hooks: false', () => {
    describe('When creating context', () => {
      it('Then ctx.hooks is undefined', () => {
        // Arrange / Act
        const sut = createNodeContext({ workDir: '/tmp/tsgit-hooks-off', hooks: false });

        // Assert — the explicit opt-out detaches the runner.
        expect(sut.hooks).toBeUndefined();
      });
    });
  });

  describe('Given default options', () => {
    describe('When creating context', () => {
      it('Then ctx.command is wired (a NodeCommandRunner)', () => {
        // Arrange / Act
        const sut = createNodeContext({ workDir: '/tmp/tsgit-command-on' });

        // Assert — external merge drivers run by default, like git.
        expect(sut.command).toBeInstanceOf(NodeCommandRunner);
      });
    });
  });

  describe('Given command: false', () => {
    describe('When creating context', () => {
      it('Then ctx.command is undefined', () => {
        // Arrange / Act
        const sut = createNodeContext({ workDir: '/tmp/tsgit-command-off', command: false });

        // Assert — the explicit opt-out detaches the runner.
        expect(sut.command).toBeUndefined();
      });
    });
  });

  describe('Given default options (ssh transport)', () => {
    describe('When creating context', () => {
      it('Then ctx.ssh is a NodeSshTransport', () => {
        // Arrange / Act
        const sut = createNodeContext({ workDir: '/tmp/tsgit-ssh-on' });

        // Assert — node contexts can reach ssh/scp remotes out of the box.
        expect(sut.ssh).toBeInstanceOf(NodeSshTransport);
      });
    });
  });

  describe('Given ssh: false', () => {
    describe('When creating context', () => {
      it('Then ctx.ssh is undefined', () => {
        // Arrange / Act
        const sut = createNodeContext({ workDir: '/tmp/tsgit-ssh-off', ssh: false });

        // Assert — the explicit opt-out makes ssh remotes refuse as unavailable.
        expect(sut.ssh).toBeUndefined();
      });
    });
  });

  describe('Given no options', () => {
    describe('When creating context', () => {
      it('Then each port is its expected concrete class (no field-swap)', () => {
        // Arrange / Act
        const sut = createNodeContext({ workDir: '/tmp/tsgit-ports' });

        // Assert — distinct class checks catch a mutant that swaps two port fields in the factory.
        expect(sut.fs).toBeInstanceOf(NodeFileSystem);
        expect(sut.hash).toBeInstanceOf(NodeHashService);
        expect(sut.compressor).toBeInstanceOf(NodeCompressor);
        expect(sut.transport).toBeInstanceOf(NodeHttpTransport);
        expect(sut.hash.algorithm).toBe('sha1');
      });
    });
  });

  describe('Given deltaCacheMaxEntries=1', () => {
    describe('When inserting two entries', () => {
      it('Then the delta cache evicts down to one (entry cap honored)', () => {
        // Arrange — large byte budget so eviction can only be triggered by the entry cap.
        const sut = createNodeContext({
          workDir: '/tmp/tsgit-delta-entries',
          deltaCacheMaxBytes: 1_000_000,
          deltaCacheMaxEntries: 1,
        });

        // Act
        sut.deltaCache.set('a', new Uint8Array([1]), 1);
        sut.deltaCache.set('b', new Uint8Array([2]), 1);

        // Assert — the configured cap of 1 is forwarded, so the LRU keeps only the newest entry.
        expect(sut.deltaCache.entryCount).toBe(1);
        expect(sut.deltaCache.has('b')).toBe(true);
        expect(sut.deltaCache.has('a')).toBe(false);
      });
    });
  });

  describe('Given created context', () => {
    describe('When attempting to mutate', () => {
      it('Then properties are frozen', () => {
        // Arrange
        const sut = createNodeContext({ workDir: '/tmp/tsgit-frozen' });

        // Act / Assert
        expect(Object.isFrozen(sut)).toBe(true);
      });
    });
  });

  describe('Given relative workDir', () => {
    describe('When creating context', () => {
      it('Then workDir is resolved to absolute', () => {
        // Arrange
        const relative = 'some/rel/path';

        // Act
        const sut = createNodeContext({ workDir: relative });

        // Assert
        expect(nodePath.isAbsolute(sut.layout.workDir)).toBe(true);
      });
    });
  });

  describe('Given allowInsecureHttp=true', () => {
    describe('When transport receives http:// URL', () => {
      it('Then bypasses HTTPS guard (opt-in propagates through factory)', async () => {
        // Arrange — proves `createNodeContext` forwards `allowInsecureHttp: true` to the transport
        // (kills the ObjectLiteral mutant that would swallow it by passing `{}` to NodeHttpTransport).
        const sut = createNodeContext({
          workDir: '/tmp/tsgit-insecure-opt-in',
          allowInsecureHttp: true,
        });

        // Act — send to a closed local port so the request fails at the network layer, not at the HTTPS guard.
        let caught: unknown;
        try {
          await sut.transport.request({
            url: 'http://127.0.0.1:1/anything',
            method: 'GET',
            headers: {},
          });
        } catch (err) {
          caught = err;
        }

        // Assert — when the opt-in reached the transport, the reason is a network error (e.g. ECONNREFUSED),
        // not the HTTPS-required gate that would fire without opt-in propagation.
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data;
        expect(data.code).toBe('NETWORK_ERROR');
        if (data.code === 'NETWORK_ERROR') {
          expect(data.reason).not.toContain('HTTPS required');
        }
      });
    });
  });

  describe('Given no allowInsecureHttp', () => {
    describe('When transport receives http:// URL', () => {
      it('Then rejects with NETWORK_ERROR (default is secure)', async () => {
        // Arrange — proves createNodeContext defaults allowInsecureHttp to false
        // (kills the `?? true` mutant that would silently allow plaintext HTTP).
        const sut = createNodeContext({ workDir: '/tmp/tsgit-insecure-default' });

        // Act
        let caught: unknown;
        try {
          await sut.transport.request({
            url: 'http://example.invalid/resource',
            method: 'GET',
            headers: {},
          });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data;
        expect(data.code).toBe('NETWORK_ERROR');
        expect(data.code === 'NETWORK_ERROR' && data.reason).toContain('HTTPS required');
      });
    });
  });
});

describe('resolveHomeDir', () => {
  describe('Given an empty string', () => {
    describe('When resolved', () => {
      it('Then returns undefined', () => {
        // Arrange
        const sut = resolveHomeDir('');

        // Assert
        expect(sut).toBeUndefined();
      });
    });
  });

  describe('Given a non-empty path', () => {
    describe('When resolved', () => {
      it('Then returns the path verbatim', () => {
        // Arrange
        const sut = resolveHomeDir('/home/me');

        // Assert
        expect(sut).toBe('/home/me');
      });
    });
  });
});

describe('buildLayout', () => {
  describe('Given homeDir=undefined', () => {
    describe('When built', () => {
      it('Then layout has no homeDir key', () => {
        // Arrange
        const sut = buildLayout('/wt', '/wt/.git', false, undefined);

        // Assert
        expect(sut).toEqual({ workDir: '/wt', gitDir: '/wt/.git', bare: false });
        expect('homeDir' in sut).toBe(false);
      });
    });
  });

  describe('Given homeDir set', () => {
    describe('When built', () => {
      it('Then layout.homeDir matches', () => {
        // Arrange
        const sut = buildLayout('/wt', '/wt/.git', true, '/home/me');

        // Assert
        expect(sut.homeDir).toBe('/home/me');
        expect(sut.bare).toBe(true);
      });
    });
  });
});
