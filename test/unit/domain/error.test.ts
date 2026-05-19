import { describe, expect, it } from 'vitest';
import {
  basename,
  TsgitError as TsgitErrorClass,
  type TsgitErrorData,
} from '../../../src/domain/error.js';
import {
  compressFailed,
  decompressFailed,
  directoryNotEmpty,
  fileExists,
  fileNotFound,
  hashFailed,
  httpError,
  networkError,
  notADirectory,
  permissionDenied,
  type TsgitError,
  unsupportedOperation,
} from '../../../src/domain/index.js';

describe('domain error — AdapterError', () => {
  describe('factory functions', () => {
    it("Given fileNotFound('/repo/missing.txt'), When checking data, Then code is FILE_NOT_FOUND and path preserved", () => {
      // Arrange & Act
      const sut = fileNotFound('/repo/missing.txt');

      // Assert
      expect(sut.data).toEqual({ code: 'FILE_NOT_FOUND', path: '/repo/missing.txt' });
    });

    it("Given fileExists('/repo/already.txt'), When checking data, Then code is FILE_EXISTS and path preserved", () => {
      // Arrange & Act
      const sut = fileExists('/repo/already.txt');

      // Assert
      expect(sut.data).toEqual({ code: 'FILE_EXISTS', path: '/repo/already.txt' });
    });

    it("Given notADirectory('/repo/file.txt'), When checking data, Then code is NOT_A_DIRECTORY and path preserved", () => {
      // Arrange & Act
      const sut = notADirectory('/repo/file.txt');

      // Assert
      expect(sut.data).toEqual({ code: 'NOT_A_DIRECTORY', path: '/repo/file.txt' });
    });

    it("Given directoryNotEmpty('/repo/dir'), When checking data, Then code is DIRECTORY_NOT_EMPTY and path preserved", () => {
      // Arrange & Act
      const sut = directoryNotEmpty('/repo/dir');

      // Assert
      expect(sut.data).toEqual({ code: 'DIRECTORY_NOT_EMPTY', path: '/repo/dir' });
    });

    it("Given permissionDenied('/etc/shadow'), When checking data, Then code is PERMISSION_DENIED and path preserved", () => {
      // Arrange & Act
      const sut = permissionDenied('/etc/shadow');

      // Assert
      expect(sut.data).toEqual({ code: 'PERMISSION_DENIED', path: '/etc/shadow' });
    });

    it("Given unsupportedOperation('symlink', 'OPFS does not support'), When checking data, Then code, operation, reason populated", () => {
      // Arrange & Act
      const sut = unsupportedOperation('symlink', 'OPFS does not support');

      // Assert
      expect(sut.data).toEqual({
        code: 'UNSUPPORTED_OPERATION',
        operation: 'symlink',
        reason: 'OPFS does not support',
      });
    });

    it("Given hashFailed('crypto.subtle unavailable'), When checking data, Then code is HASH_FAILED and reason preserved", () => {
      // Arrange & Act
      const sut = hashFailed('crypto.subtle unavailable');

      // Assert
      expect(sut.data).toEqual({ code: 'HASH_FAILED', reason: 'crypto.subtle unavailable' });
    });

    it("Given compressFailed('zlib error'), When checking data, Then code is COMPRESS_FAILED and reason preserved", () => {
      // Arrange & Act
      const sut = compressFailed('zlib error');

      // Assert
      expect(sut.data).toEqual({ code: 'COMPRESS_FAILED', reason: 'zlib error' });
    });

    it("Given decompressFailed('corrupt data'), When checking data, Then code is DECOMPRESS_FAILED and reason preserved", () => {
      // Arrange & Act
      const sut = decompressFailed('corrupt data');

      // Assert
      expect(sut.data).toEqual({ code: 'DECOMPRESS_FAILED', reason: 'corrupt data' });
    });

    it("Given httpError(404, 'Not Found'), When checking data, Then code, statusCode, reason populated", () => {
      // Arrange & Act
      const sut = httpError(404, 'Not Found');

      // Assert
      expect(sut.data).toEqual({ code: 'HTTP_ERROR', statusCode: 404, reason: 'Not Found' });
    });

    it("Given networkError('Connection refused'), When checking data, Then code is NETWORK_ERROR and reason preserved", () => {
      // Arrange & Act
      const sut = networkError('Connection refused');

      // Assert
      expect(sut.data).toEqual({ code: 'NETWORK_ERROR', reason: 'Connection refused' });
    });
  });

  describe('TsgitError class (AdapterError)', () => {
    it('Given an adapter TsgitError, When checking instanceof Error, Then returns true', () => {
      // Arrange & Act
      const sut = fileNotFound('/x');

      // Assert
      expect(sut).toBeInstanceOf(Error);
    });

    it("Given an adapter TsgitError, When accessing .name, Then equals 'TsgitError'", () => {
      // Arrange & Act
      const sut = fileNotFound('/x');

      // Assert
      expect(sut.name).toBe('TsgitError');
    });

    it('Given an adapter TsgitError, When accessing .message, Then contains the error code', () => {
      // Arrange & Act
      const sut = fileNotFound('/x');

      // Assert
      expect(sut.message).toContain('FILE_NOT_FOUND');
    });
  });

  describe('path sanitization in error.message (security)', () => {
    it('Given FILE_NOT_FOUND with absolute path, When reading message, Then contains sanitized prefix and basename ONLY (not full path)', () => {
      // Arrange & Act
      const sut = fileNotFound('/etc/passwd/secret.txt');

      // Assert
      expect(sut.message).toContain('file not found: secret.txt');
      expect(sut.message).not.toContain('/etc/passwd');
      expect(sut.data.code === 'FILE_NOT_FOUND' && sut.data.path).toBe('/etc/passwd/secret.txt');
    });

    it('Given FILE_EXISTS with absolute path, When reading message, Then contains sanitized prefix and basename ONLY', () => {
      // Arrange & Act
      const sut = fileExists('/home/user/.ssh/id_rsa');

      // Assert
      expect(sut.message).toContain('file already exists: id_rsa');
      expect(sut.message).not.toContain('/home/user');
    });

    it('Given NOT_A_DIRECTORY with absolute path, When reading message, Then contains sanitized prefix and basename ONLY', () => {
      // Arrange & Act
      const sut = notADirectory('/var/lib/data.txt');

      // Assert
      expect(sut.message).toContain('not a directory: data.txt');
      expect(sut.message).not.toContain('/var/lib');
    });

    it('Given DIRECTORY_NOT_EMPTY with absolute path, When reading message, Then contains sanitized prefix and basename ONLY', () => {
      // Arrange & Act
      const sut = directoryNotEmpty('/var/lib/old-dir');

      // Assert
      expect(sut.message).toContain('directory not empty: old-dir');
      expect(sut.message).not.toContain('/var/lib');
    });

    it('Given PERMISSION_DENIED with absolute path, When reading message, Then contains sanitized prefix and basename ONLY', () => {
      // Arrange & Act
      const sut = permissionDenied('/private/keys/secret.pem');

      // Assert
      expect(sut.message).toContain('permission denied: secret.pem');
      expect(sut.message).not.toContain('/private/keys');
    });
  });

  describe('extractDetail message formatting', () => {
    it('Given UNSUPPORTED_OPERATION, When reading message, Then contains operation and reason', () => {
      // Arrange & Act
      const sut = unsupportedOperation('symlink', 'OPFS does not support');

      // Assert
      expect(sut.message).toContain('symlink');
      expect(sut.message).toContain('OPFS does not support');
    });

    it('Given HASH_FAILED, When reading message, Then contains sanitized prefix and reason', () => {
      // Arrange & Act
      const sut = hashFailed('subtle.digest threw');

      // Assert
      expect(sut.message).toContain('hash computation failed: subtle.digest threw');
    });

    it('Given COMPRESS_FAILED, When reading message, Then contains exact sanitized prefix (not the decompression prefix)', () => {
      // Arrange & Act
      const sut = compressFailed('zlib deflateSync failed');

      // Assert — `decompression failed: ...` is a distinct case; the message must not fall through to it.
      expect(sut.message).toContain('COMPRESS_FAILED: compression failed: zlib deflateSync failed');
      expect(sut.message).not.toContain('decompression failed');
    });

    it('Given DECOMPRESS_FAILED, When reading message, Then contains reason', () => {
      // Arrange & Act
      const sut = decompressFailed('invalid inflate stream');

      // Assert
      expect(sut.message).toContain('invalid inflate stream');
    });

    it('Given HTTP_ERROR, When reading message, Then contains status code and reason', () => {
      // Arrange & Act
      const sut = httpError(500, 'Internal Server Error');

      // Assert
      expect(sut.message).toContain('500');
      expect(sut.message).toContain('Internal Server Error');
    });

    it('Given NETWORK_ERROR, When reading message, Then contains reason', () => {
      // Arrange & Act
      const sut = networkError('DNS resolution failed');

      // Assert
      expect(sut.message).toContain('DNS resolution failed');
    });

    it('Given TREE_CYCLE_DETECTED, When reading message, Then contains id', () => {
      // Arrange & Act
      const sut = new TsgitErrorClass({
        code: 'TREE_CYCLE_DETECTED',
        id: 'abc123' as never,
      });

      // Assert
      expect(sut.message).toContain('tree cycle detected: abc123');
    });

    it('Given TREE_DEPTH_EXCEEDED, When reading message, Then contains depth', () => {
      // Arrange & Act
      const sut = new TsgitErrorClass({ code: 'TREE_DEPTH_EXCEEDED', depth: 42 });

      // Assert
      expect(sut.message).toContain('tree depth exceeded: 42');
    });

    it('Given DELTA_CHAIN_TOO_DEEP, When reading message, Then contains depth', () => {
      // Arrange & Act
      const sut = new TsgitErrorClass({ code: 'DELTA_CHAIN_TOO_DEEP', depth: 51 });

      // Assert
      expect(sut.message).toContain('delta chain too deep: 51');
    });
  });

  describe('basename helper', () => {
    it('Given empty string, When basename, Then returns empty string', () => {
      // Arrange
      const sut = basename('');

      // Assert
      expect(sut).toBe('');
    });

    it("Given '/', When basename, Then returns '/' (fallback)", () => {
      // Arrange
      const sut = basename('/');

      // Assert
      expect(sut).toBe('/');
    });

    it("Given '//', When basename, Then returns '//' (multi-root fallback)", () => {
      // Arrange
      const sut = basename('//');

      // Assert
      expect(sut).toBe('//');
    });

    it("Given 'foo', When basename, Then returns 'foo'", () => {
      // Arrange
      const sut = basename('foo');

      // Assert
      expect(sut).toBe('foo');
    });

    it("Given '/a/b/c.txt', When basename, Then returns 'c.txt'", () => {
      // Arrange
      const sut = basename('/a/b/c.txt');

      // Assert
      expect(sut).toBe('c.txt');
    });

    it("Given Windows path 'C:\\\\a\\\\b\\\\c.txt', When basename, Then returns 'c.txt'", () => {
      // Arrange
      const sut = basename('C:\\a\\b\\c.txt');

      // Assert
      expect(sut).toBe('c.txt');
    });

    it("Given mixed separators '/a\\\\b/c.txt', When basename, Then returns 'c.txt'", () => {
      // Arrange
      const sut = basename('/a\\b/c.txt');

      // Assert
      expect(sut).toBe('c.txt');
    });

    it("Given trailing slash '/a/b/', When basename, Then returns 'b'", () => {
      // Arrange
      const sut = basename('/a/b/');

      // Assert
      expect(sut).toBe('b');
    });

    it("Given trailing backslash 'C:\\\\a\\\\b\\\\', When basename, Then returns 'b'", () => {
      // Arrange
      const sut = basename('C:\\a\\b\\');

      // Assert
      expect(sut).toBe('b');
    });

    it("Given single-segment path with trailing slash 'foo/', When basename, Then returns 'foo' (no separator)", () => {
      // Arrange — proves loop walks to segments[0] (kills `i > 0` mutant where segment[0] is the last valid one)
      const sut = basename('foo/');

      // Assert
      expect(sut).toBe('foo');
    });
  });

  describe('TsgitError.data type guard', () => {
    it('Given AdapterError, When accessing data.code, Then matches discriminated union', () => {
      // Arrange
      const sut: TsgitError = fileNotFound('/x');

      // Act
      const code = sut.data.code;

      // Assert
      expect(code).toBe('FILE_NOT_FOUND');
    });
  });

  describe('Phase 9 ApplicationError additions', () => {
    it('Given RESOURCE_LOCKED, When TsgitError.message is read, Then it equals the documented format', () => {
      // Arrange & Act
      const sut = new TsgitErrorClass({
        code: 'RESOURCE_LOCKED',
        resource: 'index',
        path: '/repo/.git/index.lock',
      });

      // Assert
      expect(sut.message).toBe('RESOURCE_LOCKED: index locked: index.lock');
    });

    it('Given PACK_TOO_LARGE, When TsgitError.message is read, Then it equals the documented format', () => {
      // Arrange & Act
      const sut = new TsgitErrorClass({
        code: 'PACK_TOO_LARGE',
        objectCount: 100_000_000,
        limit: 50_000_000,
      });

      // Assert
      expect(sut.message).toBe(
        'PACK_TOO_LARGE: pack contains 100000000 objects, exceeds limit 50000000',
      );
    });
  });

  describe('extractDetail exhaustive guard', () => {
    it('Given TsgitError with unknown code bypassing the type system, When reading message, Then default branch stringifies the data', () => {
      // Arrange — craft an invalid data shape to exercise the exhaustive never-case.
      const bogus = { code: 'BOGUS_UNKNOWN_CODE' } as unknown as TsgitErrorData;

      // Act
      const sut = new TsgitErrorClass(bogus);

      // Assert
      expect(sut.message).toContain('BOGUS_UNKNOWN_CODE');
      expect(sut.message).toContain('[object Object]');
    });
  });
});
