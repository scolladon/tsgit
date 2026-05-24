import { describe, expect, it } from 'vitest';
import {
  classifyDirectory,
  detectIntegrationProof,
} from '../../../test-pyramid/detect-integration-proof.js';
import { makeManifest } from './manifest-fixture.js';

const sutManifest = makeManifest();

const HEADER = (surface: string, bucket: string, unique = 'enough characters here'): string =>
  `/**\n * @proves\n *   surface: ${surface}\n *   bucket: ${bucket}\n *   unique: ${unique}\n */\n`;

describe('classifyDirectory', () => {
  it('Given a path under test/integration/network/, When classified, Then returns network/', () => {
    // Arrange
    const path = 'test/integration/network/clone-http-backend.test.ts';

    // Act
    const sut = classifyDirectory(path);

    // Assert
    expect(sut).toBe('network/');
  });

  it('Given a path under test/integration/posix-only/, When classified, Then returns posix-only/', () => {
    // Arrange
    const path = 'test/integration/posix-only/node-fs-mode-bits.test.ts';

    // Act
    const sut = classifyDirectory(path);

    // Assert
    expect(sut).toBe('posix-only/');
  });

  it('Given a path under test/integration/win-only/, When classified, Then returns win-only/', () => {
    // Arrange
    const path = 'test/integration/win-only/node-fs-windows-real.test.ts';

    // Act
    const sut = classifyDirectory(path);

    // Assert
    expect(sut).toBe('win-only/');
  });

  it('Given a path directly under test/integration/, When classified, Then returns root', () => {
    // Arrange
    const path = 'test/integration/add-all.test.ts';

    // Act
    const sut = classifyDirectory(path);

    // Assert
    expect(sut).toBe('root');
  });

  it('Given a Windows-style path with backslashes, When classified, Then the classifier normalises separators and still detects the bucket directory', () => {
    // Arrange
    const path = 'test\\integration\\network\\clone-http-backend.test.ts';

    // Act
    const sut = classifyDirectory(path);

    // Assert
    expect(sut).toBe('network/');
  });

  it('Given a path with fewer than three segments, When classified, Then falls through to root (parts[2] is undefined)', () => {
    // Arrange — covers the implicit `undefined` branch in `parts[2]`
    const path = 'leaf.test.ts';

    // Act
    const sut = classifyDirectory(path);

    // Assert
    expect(sut).toBe('root');
  });
});

describe('detectIntegrationProof', () => {
  it('Given an empty file list, When run, Then returns empty findings and an empty accepted list', () => {
    // Arrange + Act
    const sut = detectIntegrationProof(sutManifest, []);

    // Assert
    expect(sut.missing).toEqual([]);
    expect(sut.duplicate).toEqual([]);
    expect(sut.misplaced).toEqual([]);
    expect(sut.accepted).toEqual([]);
  });

  it('Given a unit-tier file, When run, Then it is ignored by the integration heuristic', () => {
    // Arrange
    const files = [{ path: 'test/unit/some.test.ts', source: HEADER('clone', 'real-http') }];

    // Act
    const sut = detectIntegrationProof(sutManifest, files);

    // Assert
    expect(sut.accepted).toEqual([]);
    expect(sut.missing).toEqual([]);
  });

  it('Given an integration file with a valid header, When run, Then no finding fires and the accepted list carries the record', () => {
    // Arrange
    const files = [
      {
        path: 'test/integration/network/clone-http-backend.test.ts',
        source: HEADER('clone', 'real-http'),
      },
    ];

    // Act
    const sut = detectIntegrationProof(sutManifest, files);

    // Assert
    expect(sut.missing).toEqual([]);
    expect(sut.duplicate).toEqual([]);
    expect(sut.misplaced).toEqual([]);
    expect(sut.accepted).toHaveLength(1);
    const first = sut.accepted[0];
    expect(first?.surface).toBe('clone');
    expect(first?.bucket).toBe('real-http');
    expect(first?.directory).toBe('network/');
  });

  it('Given an integration file without the @proves header, When run, Then the missing finding propagates the parser reason', () => {
    // Arrange
    const files = [
      {
        path: 'test/integration/no-header.test.ts',
        source: '/**\n * No proves block here.\n */\n',
      },
    ];

    // Act
    const sut = detectIntegrationProof(sutManifest, files);

    // Assert
    expect(sut.missing).toHaveLength(1);
    const first = sut.missing[0];
    expect(first?.reason).toBe('no-proves-block');
    expect(first?.path).toBe('test/integration/no-header.test.ts');
  });

  it('Given two non-platform files sharing a (surface, bucket) pair, When run, Then duplicate lists both paths sorted', () => {
    // Arrange
    const files = [
      {
        path: 'test/integration/network/zeta-clone.test.ts',
        source: HEADER('clone', 'real-http'),
      },
      {
        path: 'test/integration/network/alpha-clone.test.ts',
        source: HEADER('clone', 'real-http'),
      },
    ];

    // Act
    const sut = detectIntegrationProof(sutManifest, files);

    // Assert
    expect(sut.duplicate).toHaveLength(1);
    const dup = sut.duplicate[0];
    expect(dup?.surface).toBe('clone');
    expect(dup?.bucket).toBe('real-http');
    expect(dup?.paths).toEqual([
      'test/integration/network/alpha-clone.test.ts',
      'test/integration/network/zeta-clone.test.ts',
    ]);
  });

  it('Given posix-only and win-only files sharing a platform-only pair, When run, Then the exemption suppresses the duplicate', () => {
    // Arrange
    const files = [
      {
        path: 'test/integration/posix-only/node-fs-links.test.ts',
        source: HEADER('nodeFs.links', 'platform-only'),
      },
      {
        path: 'test/integration/win-only/node-fs-links-junctions.test.ts',
        source: HEADER('nodeFs.links', 'platform-only'),
      },
    ];

    // Act
    const sut = detectIntegrationProof(sutManifest, files);

    // Assert
    expect(sut.duplicate).toEqual([]);
    expect(sut.accepted).toHaveLength(2);
  });

  it('Given two files sharing a platform-only pair where one lives at root, When run, Then the exemption does NOT apply', () => {
    // Arrange
    const files = [
      {
        path: 'test/integration/posix-only/node-fs-links.test.ts',
        source: HEADER('nodeFs.links', 'platform-only'),
      },
      {
        path: 'test/integration/node-fs-links-root.test.ts',
        source: HEADER('nodeFs.links', 'platform-only'),
      },
    ];

    // Act
    const sut = detectIntegrationProof(sutManifest, files);

    // Assert
    expect(sut.duplicate).toHaveLength(1);
  });

  it('Given a real-http bucket file at the integration root, When run, Then a misplaced finding records network/ as expected', () => {
    // Arrange
    const files = [
      {
        path: 'test/integration/clone-misplaced.test.ts',
        source: HEADER('clone', 'real-http'),
      },
    ];

    // Act
    const sut = detectIntegrationProof(sutManifest, files);

    // Assert
    expect(sut.misplaced).toHaveLength(1);
    const placed = sut.misplaced[0];
    expect(placed?.actual).toBe('root');
    expect(placed?.expected).toEqual(['network/']);
  });

  it('Given a multi-adapter-parity bucket file under network/, When run, Then a misplaced finding fires with root expected', () => {
    // Arrange
    const files = [
      {
        path: 'test/integration/network/should-be-root.test.ts',
        source: HEADER('sparseCheckout', 'multi-adapter-parity'),
      },
    ];

    // Act
    const sut = detectIntegrationProof(sutManifest, files);

    // Assert
    expect(sut.misplaced).toHaveLength(1);
    expect(sut.misplaced[0]?.expected).toEqual(['root']);
  });

  it('Given a real-fs bucket file under posix-only/, When run, Then no misplaced finding fires because real-fs allows posix-only', () => {
    // Arrange
    const files = [
      {
        path: 'test/integration/posix-only/fs-portable.test.ts',
        source: HEADER('submodules.walk', 'real-fs'),
      },
    ];

    // Act
    const sut = detectIntegrationProof(sutManifest, files);

    // Assert
    expect(sut.misplaced).toEqual([]);
  });

  it('Given a cross-tool-interop bucket file under posix-only/, When run, Then a misplaced finding fires because cross-tool-interop is root-only', () => {
    // Arrange
    const files = [
      {
        path: 'test/integration/posix-only/should-be-root.test.ts',
        source: HEADER('reflog', 'cross-tool-interop'),
      },
    ];

    // Act
    const sut = detectIntegrationProof(sutManifest, files);

    // Assert
    expect(sut.misplaced).toHaveLength(1);
    expect(sut.misplaced[0]?.actual).toBe('posix-only/');
  });

  it('Given multiple duplicate groups mixed in order, When run, Then duplicate findings are returned sorted by surface', () => {
    // Arrange
    const files = [
      {
        path: 'test/integration/network/zeta-fetch.test.ts',
        source: HEADER('fetch', 'real-http'),
      },
      {
        path: 'test/integration/network/alpha-fetch.test.ts',
        source: HEADER('fetch', 'real-http'),
      },
      {
        path: 'test/integration/network/zeta-clone.test.ts',
        source: HEADER('clone', 'real-http'),
      },
      {
        path: 'test/integration/network/alpha-clone.test.ts',
        source: HEADER('clone', 'real-http'),
      },
    ];

    // Act
    const sut = detectIntegrationProof(sutManifest, files);

    // Assert
    expect(sut.duplicate.map((d) => d.surface)).toEqual(['clone', 'fetch']);
  });
});
