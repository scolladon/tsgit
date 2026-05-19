import { describe, expect, it } from 'vitest';

import {
  nativePolicy,
  posixPolicy,
  selectNativePolicy,
  windowsPolicy,
} from '../../../../src/adapters/node/path-policy.js';

describe('selectNativePolicy', () => {
  it('Given platform = "win32", When selectNativePolicy is called, Then returns windowsPolicy', () => {
    // Arrange & Act
    const sut = selectNativePolicy('win32');

    // Assert
    expect(sut).toBe(windowsPolicy);
  });

  it('Given platform = "darwin", When selectNativePolicy is called, Then returns posixPolicy', () => {
    // Arrange & Act
    const sut = selectNativePolicy('darwin');

    // Assert
    expect(sut).toBe(posixPolicy);
  });

  it('Given platform = "linux", When selectNativePolicy is called, Then returns posixPolicy', () => {
    // Arrange & Act
    const sut = selectNativePolicy('linux');

    // Assert
    expect(sut).toBe(posixPolicy);
  });

  it('Given an unrecognised platform string, When selectNativePolicy is called, Then it falls back to posixPolicy', () => {
    // Arrange & Act — guards the default arm of the ternary against a
    // ConditionalExpression mutant that would flip the fallback to
    // windowsPolicy. Any non-"win32" platform must yield posixPolicy.
    const sut = selectNativePolicy('freebsd' as NodeJS.Platform);

    // Assert
    expect(sut).toBe(posixPolicy);
  });
});

describe('nativePolicy', () => {
  it('Given the host platform, When nativePolicy is inspected, Then it matches selectNativePolicy(process.platform)', () => {
    // Act
    const sut = nativePolicy;

    // Assert
    expect(sut).toBe(selectNativePolicy(process.platform));
  });
});

describe('posixPolicy', () => {
  it('Given posix policy, When sep is read, Then it is forward slash', () => {
    expect(posixPolicy.sep).toBe('/');
  });

  it('Given posix policy, When caseInsensitive is read, Then it is false', () => {
    expect(posixPolicy.caseInsensitive).toBe(false);
  });

  it('Given mixed-case input, When normalizeForCompare runs, Then identity is returned', () => {
    expect(posixPolicy.normalizeForCompare('/Users/Foo')).toBe('/Users/Foo');
  });

  it('Given an absolute POSIX path, When rootOf is called, Then returns "/"', () => {
    expect(posixPolicy.rootOf('/foo/bar')).toBe('/');
  });
});

describe('windowsPolicy', () => {
  it('Given windows policy, When sep is read, Then it is backslash', () => {
    expect(windowsPolicy.sep).toBe('\\');
  });

  it('Given windows policy, When caseInsensitive is read, Then it is true', () => {
    expect(windowsPolicy.caseInsensitive).toBe(true);
  });

  it('Given mixed-case input, When normalizeForCompare runs, Then returns lowercased string', () => {
    expect(windowsPolicy.normalizeForCompare('C:\\Users\\Foo')).toBe('c:\\users\\foo');
  });

  it('Given a Windows drive-letter path, When rootOf is called, Then returns the drive prefix with trailing separator', () => {
    expect(windowsPolicy.rootOf('C:\\Users\\Foo')).toBe('C:\\');
  });

  it('Given a UNC path, When rootOf is called, Then returns the server+share prefix', () => {
    expect(windowsPolicy.rootOf('\\\\server\\share\\file.bin')).toBe('\\\\server\\share\\');
  });
});
