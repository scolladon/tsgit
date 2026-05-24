import { describe, expect, it } from 'vitest';
import {
  basename,
  invalidWalkInput,
  operationAborted,
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
    describe("Given fileNotFound('/repo/missing.txt')", () => {
      describe('When checking data', () => {
        it('Then code is FILE_NOT_FOUND and path preserved', () => {
          // Arrange & Act
          const sut = fileNotFound('/repo/missing.txt');

          // Assert
          expect(sut.data).toEqual({ code: 'FILE_NOT_FOUND', path: '/repo/missing.txt' });
        });
      });
    });

    describe("Given fileExists('/repo/already.txt')", () => {
      describe('When checking data', () => {
        it('Then code is FILE_EXISTS and path preserved', () => {
          // Arrange & Act
          const sut = fileExists('/repo/already.txt');

          // Assert
          expect(sut.data).toEqual({ code: 'FILE_EXISTS', path: '/repo/already.txt' });
        });
      });
    });

    describe("Given notADirectory('/repo/file.txt')", () => {
      describe('When checking data', () => {
        it('Then code is NOT_A_DIRECTORY and path preserved', () => {
          // Arrange & Act
          const sut = notADirectory('/repo/file.txt');

          // Assert
          expect(sut.data).toEqual({ code: 'NOT_A_DIRECTORY', path: '/repo/file.txt' });
        });
      });
    });

    describe("Given directoryNotEmpty('/repo/dir')", () => {
      describe('When checking data', () => {
        it('Then code is DIRECTORY_NOT_EMPTY and path preserved', () => {
          // Arrange & Act
          const sut = directoryNotEmpty('/repo/dir');

          // Assert
          expect(sut.data).toEqual({ code: 'DIRECTORY_NOT_EMPTY', path: '/repo/dir' });
        });
      });
    });

    describe("Given permissionDenied('/etc/shadow')", () => {
      describe('When checking data', () => {
        it('Then code is PERMISSION_DENIED and path preserved', () => {
          // Arrange & Act
          const sut = permissionDenied('/etc/shadow');

          // Assert
          expect(sut.data).toEqual({ code: 'PERMISSION_DENIED', path: '/etc/shadow' });
        });
      });
    });

    describe("Given unsupportedOperation('symlink', 'OPFS does not support')", () => {
      describe('When checking data', () => {
        it('Then code, operation, reason populated', () => {
          // Arrange & Act
          const sut = unsupportedOperation('symlink', 'OPFS does not support');

          // Assert
          expect(sut.data).toEqual({
            code: 'UNSUPPORTED_OPERATION',
            operation: 'symlink',
            reason: 'OPFS does not support',
          });
        });
      });
    });

    describe("Given hashFailed('crypto.subtle unavailable')", () => {
      describe('When checking data', () => {
        it('Then code is HASH_FAILED and reason preserved', () => {
          // Arrange & Act
          const sut = hashFailed('crypto.subtle unavailable');

          // Assert
          expect(sut.data).toEqual({ code: 'HASH_FAILED', reason: 'crypto.subtle unavailable' });
        });
      });
    });

    describe("Given compressFailed('zlib error')", () => {
      describe('When checking data', () => {
        it('Then code is COMPRESS_FAILED and reason preserved', () => {
          // Arrange & Act
          const sut = compressFailed('zlib error');

          // Assert
          expect(sut.data).toEqual({ code: 'COMPRESS_FAILED', reason: 'zlib error' });
        });
      });
    });

    describe("Given decompressFailed('corrupt data')", () => {
      describe('When checking data', () => {
        it('Then code is DECOMPRESS_FAILED and reason preserved', () => {
          // Arrange & Act
          const sut = decompressFailed('corrupt data');

          // Assert
          expect(sut.data).toEqual({ code: 'DECOMPRESS_FAILED', reason: 'corrupt data' });
        });
      });
    });

    describe("Given httpError(404, 'Not Found')", () => {
      describe('When checking data', () => {
        it('Then code, statusCode, reason populated', () => {
          // Arrange & Act
          const sut = httpError(404, 'Not Found');

          // Assert
          expect(sut.data).toEqual({ code: 'HTTP_ERROR', statusCode: 404, reason: 'Not Found' });
        });
      });
    });

    describe("Given networkError('Connection refused')", () => {
      describe('When checking data', () => {
        it('Then code is NETWORK_ERROR and reason preserved', () => {
          // Arrange & Act
          const sut = networkError('Connection refused');

          // Assert
          expect(sut.data).toEqual({ code: 'NETWORK_ERROR', reason: 'Connection refused' });
        });
      });
    });
  });

  describe('TsgitError class (AdapterError)', () => {
    describe('Given an adapter TsgitError', () => {
      describe('When checking instanceof Error', () => {
        it('Then returns true', () => {
          // Arrange & Act
          const sut = fileNotFound('/x');

          // Assert
          expect(sut).toBeInstanceOf(Error);
        });
      });
      describe('When accessing .name', () => {
        it("Then equals 'TsgitError'", () => {
          // Arrange & Act
          const sut = fileNotFound('/x');

          // Assert
          expect(sut.name).toBe('TsgitError');
        });
      });
      describe('When accessing.message', () => {
        it('Then contains the error code', () => {
          // Arrange & Act
          const sut = fileNotFound('/x');

          // Assert
          expect(sut.message).toContain('FILE_NOT_FOUND');
        });
      });
    });
  });

  describe('path sanitization in error.message (security)', () => {
    describe('Given FILE_NOT_FOUND with absolute path', () => {
      describe('When reading message', () => {
        it('Then contains sanitized prefix and basename ONLY (not full path)', () => {
          // Arrange & Act
          const sut = fileNotFound('/etc/passwd/secret.txt');

          // Assert
          expect(sut.message).toContain('file not found: secret.txt');
          expect(sut.message).not.toContain('/etc/passwd');
          expect(sut.data.code === 'FILE_NOT_FOUND' && sut.data.path).toBe(
            '/etc/passwd/secret.txt',
          );
        });
      });
    });

    describe('Given FILE_EXISTS with absolute path', () => {
      describe('When reading message', () => {
        it('Then contains sanitized prefix and basename ONLY', () => {
          // Arrange & Act
          const sut = fileExists('/home/user/.ssh/id_rsa');

          // Assert
          expect(sut.message).toContain('file already exists: id_rsa');
          expect(sut.message).not.toContain('/home/user');
        });
      });
    });

    describe('Given NOT_A_DIRECTORY with absolute path', () => {
      describe('When reading message', () => {
        it('Then contains sanitized prefix and basename ONLY', () => {
          // Arrange & Act
          const sut = notADirectory('/var/lib/data.txt');

          // Assert
          expect(sut.message).toContain('not a directory: data.txt');
          expect(sut.message).not.toContain('/var/lib');
        });
      });
    });

    describe('Given DIRECTORY_NOT_EMPTY with absolute path', () => {
      describe('When reading message', () => {
        it('Then contains sanitized prefix and basename ONLY', () => {
          // Arrange & Act
          const sut = directoryNotEmpty('/var/lib/old-dir');

          // Assert
          expect(sut.message).toContain('directory not empty: old-dir');
          expect(sut.message).not.toContain('/var/lib');
        });
      });
    });

    describe('Given PERMISSION_DENIED with absolute path', () => {
      describe('When reading message', () => {
        it('Then contains sanitized prefix and basename ONLY', () => {
          // Arrange & Act
          const sut = permissionDenied('/private/keys/secret.pem');

          // Assert
          expect(sut.message).toContain('permission denied: secret.pem');
          expect(sut.message).not.toContain('/private/keys');
        });
      });
    });
  });

  describe('extractDetail message formatting', () => {
    describe('Given UNSUPPORTED_OPERATION', () => {
      describe('When reading message', () => {
        it('Then contains operation and reason', () => {
          // Arrange & Act
          const sut = unsupportedOperation('symlink', 'OPFS does not support');

          // Assert
          expect(sut.message).toContain('symlink');
          expect(sut.message).toContain('OPFS does not support');
        });
      });
    });

    describe('Given HASH_FAILED', () => {
      describe('When reading message', () => {
        it('Then contains sanitized prefix and reason', () => {
          // Arrange & Act
          const sut = hashFailed('subtle.digest threw');

          // Assert
          expect(sut.message).toContain('hash computation failed: subtle.digest threw');
        });
      });
    });

    describe('Given COMPRESS_FAILED', () => {
      describe('When reading message', () => {
        it('Then contains exact sanitized prefix (not the decompression prefix)', () => {
          // Arrange & Act
          const sut = compressFailed('zlib deflateSync failed');

          // Assert — `decompression failed:...` is a distinct case; the message must not fall through to it.
          expect(sut.message).toContain(
            'COMPRESS_FAILED: compression failed: zlib deflateSync failed',
          );
          expect(sut.message).not.toContain('decompression failed');
        });
      });
    });

    describe('Given DECOMPRESS_FAILED', () => {
      describe('When reading message', () => {
        it('Then contains reason', () => {
          // Arrange & Act
          const sut = decompressFailed('invalid inflate stream');

          // Assert
          expect(sut.message).toContain('invalid inflate stream');
        });
      });
    });

    describe('Given HTTP_ERROR', () => {
      describe('When reading message', () => {
        it('Then contains status code and reason', () => {
          // Arrange & Act
          const sut = httpError(500, 'Internal Server Error');

          // Assert
          expect(sut.message).toContain('500');
          expect(sut.message).toContain('Internal Server Error');
        });
      });
    });

    describe('Given NETWORK_ERROR', () => {
      describe('When reading message', () => {
        it('Then equals the documented format with reason', () => {
          // Arrange & Act
          const sut = networkError('DNS resolution failed');

          // Assert
          expect(sut.message).toBe('NETWORK_ERROR: network error: DNS resolution failed');
        });
      });
    });

    describe('Given OPERATION_ABORTED', () => {
      describe('When reading message', () => {
        it('Then equals the documented constant format', () => {
          // Arrange & Act
          const sut = operationAborted();

          // Assert
          expect(sut.message).toBe('OPERATION_ABORTED: operation aborted');
        });
      });
    });

    describe('Given TREE_CYCLE_DETECTED', () => {
      describe('When reading message', () => {
        it('Then contains id', () => {
          // Arrange & Act
          const sut = new TsgitErrorClass({
            code: 'TREE_CYCLE_DETECTED',
            id: 'abc123' as never,
          });

          // Assert
          expect(sut.message).toContain('tree cycle detected: abc123');
        });
      });
    });

    describe('Given TREE_DEPTH_EXCEEDED', () => {
      describe('When reading message', () => {
        it('Then contains depth', () => {
          // Arrange & Act
          const sut = new TsgitErrorClass({ code: 'TREE_DEPTH_EXCEEDED', depth: 42 });

          // Assert
          expect(sut.message).toContain('tree depth exceeded: 42');
        });
      });
    });

    describe('Given DELTA_CHAIN_TOO_DEEP', () => {
      describe('When reading message', () => {
        it('Then contains depth', () => {
          // Arrange & Act
          const sut = new TsgitErrorClass({ code: 'DELTA_CHAIN_TOO_DEEP', depth: 51 });

          // Assert
          expect(sut.message).toContain('delta chain too deep: 51');
        });
      });
    });

    describe('Given INVALID_DIFF_INPUT', () => {
      describe('When reading message', () => {
        it('Then equals the documented format with reason', () => {
          // Arrange & Act
          const sut = new TsgitErrorClass({ code: 'INVALID_DIFF_INPUT', reason: 'tree is null' });

          // Assert
          expect(sut.message).toBe('INVALID_DIFF_INPUT: invalid diff input: tree is null');
        });
      });
    });

    describe('Given OBJECT_NOT_FOUND', () => {
      describe('When reading message', () => {
        it('Then equals the documented format with id', () => {
          // Arrange & Act
          const sut = new TsgitErrorClass({
            code: 'OBJECT_NOT_FOUND',
            id: 'deadbeef' as never,
          });

          // Assert
          expect(sut.message).toBe('OBJECT_NOT_FOUND: object not found: deadbeef');
        });
      });
    });

    describe('Given OBJECT_HASH_MISMATCH', () => {
      describe('When reading message', () => {
        it('Then equals the documented format with expected and actual', () => {
          // Arrange & Act
          const sut = new TsgitErrorClass({
            code: 'OBJECT_HASH_MISMATCH',
            expected: 'aaa' as never,
            actual: 'bbb' as never,
          });

          // Assert
          expect(sut.message).toBe(
            'OBJECT_HASH_MISMATCH: object hash mismatch: expected=aaa actual=bbb',
          );
        });
      });
    });

    describe('Given UNEXPECTED_OBJECT_TYPE', () => {
      describe('When reading message', () => {
        it('Then equals the documented format with expected, actual and id', () => {
          // Arrange & Act
          const sut = new TsgitErrorClass({
            code: 'UNEXPECTED_OBJECT_TYPE',
            expected: 'commit' as never,
            actual: 'blob' as never,
            id: 'cafe' as never,
          });

          // Assert
          expect(sut.message).toBe(
            'UNEXPECTED_OBJECT_TYPE: unexpected object type: expected=commit actual=blob id=cafe',
          );
        });
      });
    });

    describe('Given TREE_ENTRY_LIMIT_EXCEEDED', () => {
      describe('When reading message', () => {
        it('Then equals the documented format with count and limit', () => {
          // Arrange & Act
          const sut = new TsgitErrorClass({
            code: 'TREE_ENTRY_LIMIT_EXCEEDED',
            count: 9001,
            limit: 4096,
          });

          // Assert
          expect(sut.message).toBe(
            'TREE_ENTRY_LIMIT_EXCEEDED: tree entry limit exceeded: count=9001 limit=4096',
          );
        });
      });
    });

    describe('Given REF_NOT_FOUND', () => {
      describe('When reading message', () => {
        it('Then equals the documented format with name', () => {
          // Arrange & Act
          const sut = new TsgitErrorClass({
            code: 'REF_NOT_FOUND',
            name: 'refs/heads/missing' as never,
          });

          // Assert
          expect(sut.message).toBe('REF_NOT_FOUND: ref not found: refs/heads/missing');
        });
      });
    });

    describe('Given REF_CHAIN_TOO_DEEP', () => {
      describe('When reading message', () => {
        it('Then equals the documented format with depth and joined chain', () => {
          // Arrange & Act
          const sut = new TsgitErrorClass({
            code: 'REF_CHAIN_TOO_DEEP',
            depth: 6,
            chain: ['HEAD', 'refs/heads/a', 'refs/heads/b'] as never,
          });

          // Assert
          expect(sut.message).toBe(
            'REF_CHAIN_TOO_DEEP: ref chain too deep: depth=6 chain=HEAD->refs/heads/a->refs/heads/b',
          );
        });
      });
    });

    describe('Given REF_CYCLE_DETECTED', () => {
      describe('When reading message', () => {
        it('Then equals the documented format with joined chain', () => {
          // Arrange & Act
          const sut = new TsgitErrorClass({
            code: 'REF_CYCLE_DETECTED',
            chain: ['refs/heads/a', 'refs/heads/b', 'refs/heads/a'] as never,
          });

          // Assert
          expect(sut.message).toBe(
            'REF_CYCLE_DETECTED: ref cycle detected: refs/heads/a->refs/heads/b->refs/heads/a',
          );
        });
      });
    });

    describe('Given REF_LOCKED', () => {
      describe('When reading message', () => {
        it('Then equals the documented format with name', () => {
          // Arrange & Act
          const sut = new TsgitErrorClass({
            code: 'REF_LOCKED',
            name: 'refs/heads/main' as never,
          });

          // Assert
          expect(sut.message).toBe('REF_LOCKED: ref locked: refs/heads/main');
        });
      });
    });

    describe('Given REF_UPDATE_CONFLICT', () => {
      describe('When reading message', () => {
        it('Then equals the documented format with name, expected and actual', () => {
          // Arrange & Act
          const sut = new TsgitErrorClass({
            code: 'REF_UPDATE_CONFLICT',
            name: 'refs/heads/main' as never,
            expected: 'aaa' as never,
            actual: 'bbb' as never,
          });

          // Assert
          expect(sut.message).toBe(
            'REF_UPDATE_CONFLICT: ref update conflict: name=refs/heads/main expected=aaa actual=bbb',
          );
        });
      });
    });

    describe('Given INVALID_WALK_INPUT', () => {
      describe('When reading message', () => {
        it('Then equals the documented format with reason', () => {
          // Arrange & Act
          const sut = invalidWalkInput('start commit is undefined');

          // Assert
          expect(sut.message).toBe(
            'INVALID_WALK_INPUT: invalid walk input: start commit is undefined',
          );
        });
      });
    });

    describe('Given REFSPEC_INVALID', () => {
      describe('When reading message', () => {
        it('Then equals the documented format with raw and reason', () => {
          // Arrange & Act
          const sut = new TsgitErrorClass({
            code: 'REFSPEC_INVALID',
            raw: 'bad:spec:extra',
            reason: 'too many colons',
          });

          // Assert
          expect(sut.message).toBe(
            'REFSPEC_INVALID: invalid refspec "bad:spec:extra": too many colons',
          );
        });
      });
    });
  });

  describe('basename helper', () => {
    describe('Given empty string', () => {
      describe('When basename', () => {
        it('Then returns empty string', () => {
          // Arrange
          const sut = basename('');

          // Assert
          expect(sut).toBe('');
        });
      });
    });

    describe("Given '/'", () => {
      describe('When basename', () => {
        it("Then returns '/' (fallback)", () => {
          // Arrange
          const sut = basename('/');

          // Assert
          expect(sut).toBe('/');
        });
      });
    });

    describe("Given '//'", () => {
      describe('When basename', () => {
        it("Then returns '//' (multi-root fallback)", () => {
          // Arrange
          const sut = basename('//');

          // Assert
          expect(sut).toBe('//');
        });
      });
    });

    describe("Given 'foo'", () => {
      describe('When basename', () => {
        it("Then returns 'foo'", () => {
          // Arrange
          const sut = basename('foo');

          // Assert
          expect(sut).toBe('foo');
        });
      });
    });

    describe("Given '/a/b/c.txt'", () => {
      describe('When basename', () => {
        it("Then returns 'c.txt'", () => {
          // Arrange
          const sut = basename('/a/b/c.txt');

          // Assert
          expect(sut).toBe('c.txt');
        });
      });
    });

    describe("Given Windows path 'C:\\\\\\\\a\\\\\\\\b\\\\\\\\c.txt'", () => {
      describe('When basename', () => {
        it("Then returns 'c.txt'", () => {
          // Arrange
          const sut = basename('C:\\a\\b\\c.txt');

          // Assert
          expect(sut).toBe('c.txt');
        });
      });
    });

    describe("Given mixed separators '/a\\\\\\\\b/c.txt'", () => {
      describe('When basename', () => {
        it("Then returns 'c.txt'", () => {
          // Arrange
          const sut = basename('/a\\b/c.txt');

          // Assert
          expect(sut).toBe('c.txt');
        });
      });
    });

    describe("Given trailing slash '/a/b/'", () => {
      describe('When basename', () => {
        it("Then returns 'b'", () => {
          // Arrange
          const sut = basename('/a/b/');

          // Assert
          expect(sut).toBe('b');
        });
      });
    });

    describe("Given trailing backslash 'C:\\\\\\\\a\\\\\\\\b\\\\\\\\'", () => {
      describe('When basename', () => {
        it("Then returns 'b'", () => {
          // Arrange
          const sut = basename('C:\\a\\b\\');

          // Assert
          expect(sut).toBe('b');
        });
      });
    });

    describe("Given single-segment path with trailing slash 'foo/'", () => {
      describe('When basename', () => {
        it("Then returns 'foo' (no separator)", () => {
          // Arrange — proves loop walks to segments[0] (kills `i > 0` mutant where segment[0] is the last valid one)
          const sut = basename('foo/');

          // Assert
          expect(sut).toBe('foo');
        });
      });
    });
  });

  describe('TsgitError.data type guard', () => {
    describe('Given AdapterError', () => {
      describe('When accessing data.code', () => {
        it('Then matches discriminated union', () => {
          // Arrange
          const sut: TsgitError = fileNotFound('/x');

          // Act
          const code = sut.data.code;

          // Assert
          expect(code).toBe('FILE_NOT_FOUND');
        });
      });
    });
  });

  describe('ApplicationError variants', () => {
    describe('Given RESOURCE_LOCKED', () => {
      describe('When TsgitError.message is read', () => {
        it('Then it equals the documented format', () => {
          // Arrange & Act
          const sut = new TsgitErrorClass({
            code: 'RESOURCE_LOCKED',
            resource: 'index',
            path: '/repo/.git/index.lock',
          });

          // Assert
          expect(sut.message).toBe('RESOURCE_LOCKED: index locked: index.lock');
        });
      });
    });

    describe('Given PACK_TOO_LARGE', () => {
      describe('When TsgitError.message is read', () => {
        it('Then it equals the documented format', () => {
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
    });
  });

  describe('extractDetail exhaustive guard', () => {
    describe('Given TsgitError with unknown code bypassing the type system', () => {
      describe('When reading message', () => {
        it('Then default branch stringifies the data', () => {
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
  });
});
