import { homedir } from 'node:os';
import * as nodePath from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildLayout,
  createNodeContext,
  resolveHomeDir,
} from '../../../../src/adapters/node/node-adapter.js';
import { NodeCompressor } from '../../../../src/adapters/node/node-compressor.js';
import { NodeFileSystem } from '../../../../src/adapters/node/node-file-system.js';
import { NodeHashService } from '../../../../src/adapters/node/node-hash-service.js';
import { NodeHttpTransport } from '../../../../src/adapters/node/node-http-transport.js';
import { TsgitError } from '../../../../src/domain/index.js';

describe('createNodeContext', () => {
  it('Given workDir only, When creating context, Then gitDir defaults to <workDir>/.git', () => {
    // Arrange
    const workDir = '/tmp/tsgit-ctx-test';

    // Act
    const sut = createNodeContext({ workDir });

    // Assert
    expect(sut.layout.workDir).toBe(nodePath.resolve(workDir));
    expect(sut.layout.gitDir).toBe(nodePath.join(nodePath.resolve(workDir), '.git'));
    expect(sut.layout.bare).toBe(false);
  });

  it('Given explicit gitDir, When creating context, Then uses resolved absolute gitDir', () => {
    // Arrange
    const workDir = '/tmp/tsgit-explicit-wt';
    const gitDir = '/tmp/tsgit-explicit-git';

    // Act
    const sut = createNodeContext({ workDir, gitDir });

    // Assert
    expect(sut.layout.gitDir).toBe(nodePath.resolve(gitDir));
  });

  it('Given a runtime with a non-empty home directory, When creating context, Then layout.homeDir matches os.homedir()', () => {
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

  it('Given bare=true, When creating context, Then config.bare is true', () => {
    // Arrange / Act
    const sut = createNodeContext({ workDir: '/tmp/tsgit-bare', bare: true });

    // Assert
    expect(sut.layout.bare).toBe(true);
  });

  it('Given AbortSignal, When creating context, Then signal is forwarded', () => {
    // Arrange
    const controller = new AbortController();

    // Act
    const sut = createNodeContext({ workDir: '/tmp/tsgit-sig', signal: controller.signal });

    // Assert
    expect(sut.signal).toBe(controller.signal);
  });

  it('Given no signal, When creating context, Then signal is undefined', () => {
    // Arrange / Act
    const sut = createNodeContext({ workDir: '/tmp/tsgit-nosig' });

    // Assert
    expect(sut.signal).toBeUndefined();
  });

  it('Given no options, When creating context, Then each port is its expected concrete class (no field-swap)', () => {
    // Arrange / Act
    const sut = createNodeContext({ workDir: '/tmp/tsgit-ports' });

    // Assert — distinct class checks catch a mutant that swaps two port fields in the factory.
    expect(sut.fs).toBeInstanceOf(NodeFileSystem);
    expect(sut.hash).toBeInstanceOf(NodeHashService);
    expect(sut.compressor).toBeInstanceOf(NodeCompressor);
    expect(sut.transport).toBeInstanceOf(NodeHttpTransport);
    expect(sut.hash.algorithm).toBe('sha1');
  });

  it('Given created context, When attempting to mutate, Then properties are frozen', () => {
    // Arrange
    const sut = createNodeContext({ workDir: '/tmp/tsgit-frozen' });

    // Act / Assert
    expect(Object.isFrozen(sut)).toBe(true);
  });

  it('Given relative workDir, When creating context, Then workDir is resolved to absolute', () => {
    // Arrange
    const relative = 'some/rel/path';

    // Act
    const sut = createNodeContext({ workDir: relative });

    // Assert
    expect(nodePath.isAbsolute(sut.layout.workDir)).toBe(true);
  });

  it('Given allowInsecureHttp=true, When transport receives http:// URL, Then bypasses HTTPS guard (opt-in propagates through factory)', async () => {
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

  it('Given no allowInsecureHttp, When transport receives http:// URL, Then rejects with NETWORK_ERROR (default is secure)', async () => {
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

describe('resolveHomeDir', () => {
  it('Given an empty string, When resolved, Then returns undefined', () => {
    expect(resolveHomeDir('')).toBeUndefined();
  });

  it('Given a non-empty path, When resolved, Then returns the path verbatim', () => {
    expect(resolveHomeDir('/home/me')).toBe('/home/me');
  });
});

describe('buildLayout', () => {
  it('Given homeDir=undefined, When built, Then layout has no homeDir key', () => {
    const sut = buildLayout('/wt', '/wt/.git', false, undefined);

    expect(sut).toEqual({ workDir: '/wt', gitDir: '/wt/.git', bare: false });
    expect('homeDir' in sut).toBe(false);
  });

  it('Given homeDir set, When built, Then layout.homeDir matches', () => {
    const sut = buildLayout('/wt', '/wt/.git', true, '/home/me');

    expect(sut.homeDir).toBe('/home/me');
    expect(sut.bare).toBe(true);
  });
});
