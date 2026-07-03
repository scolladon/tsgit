import { describe, expect, it } from 'vitest';
import {
  ambiguousOidPrefix,
  cleanFilterFailed,
  invalidSequencerTodo,
  noPromisorRemote,
  pathNotInTree,
  signedPushUnsupported,
  signingFailed,
  smudgeFilterFailed,
  worktreeFileAbsent,
} from '../../../src/domain/commands/error.js';
import {
  basename,
  dirname,
  invalidWalkInput,
  operationAborted,
  orderInvariantViolation,
  snapshotRequired,
  TsgitError as TsgitErrorClass,
  type TsgitErrorData,
  workdirRace,
} from '../../../src/domain/error.js';
import {
  compressFailed,
  decompressFailed,
  directoryNotEmpty,
  fileExists,
  fileNotFound,
  hashFailed,
  httpError,
  mvBadSource,
  mvDestinationDirectoryMissing,
  mvDestinationExists,
  mvDestinationNotDirectory,
  mvIntoSelf,
  mvMultipleSourcesSameTarget,
  mvOverlappingSources,
  mvSourceNotTracked,
  networkError,
  notADirectory,
  noUpstreamConfigured,
  permissionDenied,
  type TsgitError,
  unsupportedOperation,
} from '../../../src/domain/index.js';
import type { FilePath, ObjectId, RefName } from '../../../src/domain/objects/index.js';
import { invalidFilterSpec, remoteFilterUnsupported } from '../../../src/domain/protocol/error.js';
import type { WorkdirStat } from '../../../src/domain/snapshot/index.js';

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

    describe('Given NO_UPSTREAM_CONFIGURED', () => {
      describe('When reading message', () => {
        it('Then names the branch with no tracking information', () => {
          // Arrange & Act
          const sut = noUpstreamConfigured('refs/heads/main' as RefName);

          // Assert
          expect(sut.message).toContain('no upstream configured for refs/heads/main');
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

  describe('dirname helper', () => {
    describe("Given a slash-less path 'abc'", () => {
      describe('When dirname', () => {
        it("Then returns '' (no parent)", () => {
          // Arrange & Act — multi-char so the `=== -1` and `-1` mutants (which
          // would slice off the last char → 'ab') are distinguishable from ''.
          const sut = dirname('abc');

          // Assert
          expect(sut).toBe('');
        });
      });
    });

    describe("Given a nested path 'a/b/c'", () => {
      describe('When dirname', () => {
        it("Then returns the parent 'a/b'", () => {
          // Arrange & Act
          const sut = dirname('a/b/c');

          // Assert
          expect(sut).toBe('a/b');
        });
      });
    });

    describe("Given a root-level absolute leaf '/leaf'", () => {
      describe('When dirname', () => {
        it("Then returns '' (slash at index 0)", () => {
          // Arrange & Act
          const sut = dirname('/leaf');

          // Assert
          expect(sut).toBe('');
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

  describe('CommandError — mv refusals', () => {
    describe("Given mvSourceNotTracked('u.txt', 'd/u.txt')", () => {
      describe('When checking data and message', () => {
        it('Then code/source/destination and the faithful message render', () => {
          // Arrange & Act
          const sut = mvSourceNotTracked('u.txt' as FilePath, 'd/u.txt' as FilePath);

          // Assert
          expect(sut.data).toEqual({
            code: 'MV_SOURCE_NOT_TRACKED',
            source: 'u.txt',
            destination: 'd/u.txt',
          });
          expect(sut.message).toBe(
            'MV_SOURCE_NOT_TRACKED: not under version control, source=u.txt, destination=d/u.txt',
          );
        });
      });
    });

    describe("Given mvBadSource('a.txt', 'z.txt')", () => {
      describe('When checking data and message', () => {
        it('Then code/source/destination and the faithful message render', () => {
          // Arrange & Act
          const sut = mvBadSource('a.txt' as FilePath, 'z.txt' as FilePath);

          // Assert
          expect(sut.data).toEqual({
            code: 'MV_BAD_SOURCE',
            source: 'a.txt',
            destination: 'z.txt',
          });
          expect(sut.message).toBe('MV_BAD_SOURCE: bad source, source=a.txt, destination=z.txt');
        });
      });
    });

    describe("Given mvDestinationExists('a.txt', 'keep.txt')", () => {
      describe('When checking data and message', () => {
        it('Then code/source/destination and the faithful message render', () => {
          // Arrange & Act
          const sut = mvDestinationExists('a.txt' as FilePath, 'keep.txt' as FilePath);

          // Assert
          expect(sut.data).toEqual({
            code: 'MV_DESTINATION_EXISTS',
            source: 'a.txt',
            destination: 'keep.txt',
          });
          expect(sut.message).toBe(
            'MV_DESTINATION_EXISTS: destination exists, source=a.txt, destination=keep.txt',
          );
        });
      });
    });

    describe("Given mvIntoSelf('a.txt', 'a.txt')", () => {
      describe('When checking data and message', () => {
        it('Then code/source/destination and the faithful message render', () => {
          // Arrange & Act
          const sut = mvIntoSelf('a.txt' as FilePath, 'a.txt' as FilePath);

          // Assert
          expect(sut.data).toEqual({
            code: 'MV_INTO_SELF',
            source: 'a.txt',
            destination: 'a.txt',
          });
          expect(sut.message).toBe(
            'MV_INTO_SELF: can not move directory into itself, source=a.txt, destination=a.txt',
          );
        });
      });
    });

    describe("Given mvDestinationNotDirectory('a.txt', 'nope.txt')", () => {
      describe('When checking data and message', () => {
        it('Then the message names the destination and omits the source=…,destination=… suffix', () => {
          // Arrange & Act
          const sut = mvDestinationNotDirectory('a.txt' as FilePath, 'nope.txt' as FilePath);

          // Assert
          expect(sut.data).toEqual({
            code: 'MV_DESTINATION_NOT_DIRECTORY',
            source: 'a.txt',
            destination: 'nope.txt',
          });
          expect(sut.message).toBe(
            "MV_DESTINATION_NOT_DIRECTORY: destination 'nope.txt' is not a directory, source=a.txt",
          );
        });
      });
    });

    describe("Given mvDestinationDirectoryMissing('a.txt', 'missing/')", () => {
      describe('When checking data and message', () => {
        it('Then code/source/destination and the faithful message render', () => {
          // Arrange & Act
          const sut = mvDestinationDirectoryMissing('a.txt' as FilePath, 'missing/' as FilePath);

          // Assert
          expect(sut.data).toEqual({
            code: 'MV_DESTINATION_DIRECTORY_MISSING',
            source: 'a.txt',
            destination: 'missing/',
          });
          expect(sut.message).toBe(
            'MV_DESTINATION_DIRECTORY_MISSING: destination directory does not exist, source=a.txt, destination=missing/',
          );
        });
      });
    });

    describe("Given mvMultipleSourcesSameTarget('a.txt', 'd/a.txt')", () => {
      describe('When checking data and message', () => {
        it('Then code/source/destination and the faithful message render', () => {
          // Arrange & Act
          const sut = mvMultipleSourcesSameTarget('a.txt' as FilePath, 'd/a.txt' as FilePath);

          // Assert
          expect(sut.data).toEqual({
            code: 'MV_MULTIPLE_SOURCES_SAME_TARGET',
            source: 'a.txt',
            destination: 'd/a.txt',
          });
          expect(sut.message).toBe(
            'MV_MULTIPLE_SOURCES_SAME_TARGET: multiple sources for the same target, source=a.txt, destination=d/a.txt',
          );
        });
      });
    });

    describe("Given mvOverlappingSources('a/b', 'a')", () => {
      describe('When checking data and message', () => {
        it('Then code/child/parent and the faithful message render', () => {
          // Arrange & Act
          const sut = mvOverlappingSources('a/b' as FilePath, 'a' as FilePath);

          // Assert
          expect(sut.data).toEqual({ code: 'MV_OVERLAPPING_SOURCES', child: 'a/b', parent: 'a' });
          expect(sut.message).toBe(
            "MV_OVERLAPPING_SOURCES: cannot move both 'a/b' and its parent directory 'a'",
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

  describe('Given central-switch error codes, When reading their message', () => {
    it('Then PATH_NOT_IN_TREE names the path and the rev', () => {
      // Arrange & Act
      const sut = pathNotInTree('HEAD', 'missing.txt');

      // Assert
      expect(sut.message).toContain("path 'missing.txt' does not exist in 'HEAD'");
    });

    it('Then WORKTREE_FILE_ABSENT names the unreadable working-tree file', () => {
      // Arrange & Act
      const sut = worktreeFileAbsent('f.txt');

      // Assert
      expect(sut.message).toContain("cannot read working-tree file 'f.txt'");
    });

    it('Then NO_PROMISOR_REMOTE explains the missing promisor remote', () => {
      // Arrange & Act
      const sut = noPromisorRemote();

      // Assert
      expect(sut.message).toContain(
        'no promisor remote configured; this repository is not a partial clone',
      );
    });

    it('Then INVALID_FILTER_SPEC quotes the spec and reason', () => {
      // Arrange & Act
      const sut = invalidFilterSpec('blob:none', 'unsupported');

      // Assert
      expect(sut.message).toContain('invalid object filter "blob:none": unsupported');
    });

    it('Then REMOTE_FILTER_UNSUPPORTED states the remote lacks filtering', () => {
      // Arrange & Act
      const sut = remoteFilterUnsupported();

      // Assert
      expect(sut.message).toContain('remote does not support partial-clone object filtering');
    });

    it('Then SNAPSHOT_REQUIRED includes the reason', () => {
      // Arrange & Act
      const sut = snapshotRequired('index changed');

      // Assert
      expect(sut.message).toContain('snapshot required: index changed');
    });

    it('Then WORKDIR_RACE reports both observed and current stats', () => {
      // Arrange
      const observed = { mode: 0o100644, size: 2, mtimeMs: 1 } as unknown as WorkdirStat;
      const current = { mode: 0o100644, size: 4, mtimeMs: 3 } as unknown as WorkdirStat;

      // Act
      const sut = workdirRace('a.txt', observed, current);

      // Assert
      expect(sut.message).toContain(
        'working-tree changed under us at a.txt (observed mtime=1 size=2, current mtime=3 size=4)',
      );
    });

    it('Then ORDER_INVARIANT_VIOLATION names both rows in order', () => {
      // Arrange & Act
      const sut = orderInvariantViolation('row-a', 'row-b');

      // Assert
      expect(sut.message).toContain('row order broken: row-a followed by row-b');
    });

    it('Then AMBIGUOUS_OID_PREFIX reports the prefix and candidate count', () => {
      // Arrange
      const candidates = ['1', '2'] as unknown as ReadonlyArray<ObjectId>;

      // Act
      const sut = ambiguousOidPrefix('abc', candidates);

      // Assert
      expect(sut.message).toContain('short object id abc is ambiguous (2 candidates)');
    });

    it('Then INVALID_SEQUENCER_TODO includes the reason', () => {
      // Arrange & Act
      const sut = invalidSequencerTodo('bad line');

      // Assert
      expect(sut.message).toContain('invalid sequencer todo: bad line');
    });
  });
});

describe('cleanFilterFailed error', () => {
  describe('Given cleanFilterFailed factory with path, filter name and exitCode', () => {
    describe('When accessing .data', () => {
      it('Then data carries code CLEAN_FILTER_FAILED, path, filter, exitCode', () => {
        // Arrange & Act
        const sut = cleanFilterFailed('src/file.bin' as never, 'lfs', 1);

        // Assert
        expect(sut.data.code).toBe('CLEAN_FILTER_FAILED');
        expect(sut.data.code === 'CLEAN_FILTER_FAILED' && sut.data.path).toBe('src/file.bin');
        expect(sut.data.code === 'CLEAN_FILTER_FAILED' && sut.data.filter).toBe('lfs');
        expect(sut.data.code === 'CLEAN_FILTER_FAILED' && sut.data.exitCode).toBe(1);
      });
    });
  });

  describe('Given cleanFilterFailed with exitCode 128', () => {
    describe('When accessing .data.exitCode', () => {
      it('Then exitCode is preserved as 128', () => {
        // Arrange & Act
        const sut = cleanFilterFailed('blob.dat' as never, 'myfilter', 128);

        // Assert
        expect(sut.data.code).toBe('CLEAN_FILTER_FAILED');
        expect(sut.data.code === 'CLEAN_FILTER_FAILED' && sut.data.exitCode).toBe(128);
      });
    });
  });

  describe('Given cleanFilterFailed factory', () => {
    describe('When reading .message', () => {
      it('Then message contains filter name, file basename and exitCode', () => {
        // Arrange & Act
        const sut = cleanFilterFailed('repo/assets/photo.png' as never, 'lfs-clean', 2);

        // Assert
        expect(sut.message).toContain('lfs-clean');
        expect(sut.message).toContain('photo.png');
        expect(sut.message).toContain('2');
      });
    });
  });

  describe('Given cleanFilterFailed factory', () => {
    describe('When reading .message prefix', () => {
      it('Then message starts with "clean filter" (not "smudge filter" via case fall-through)', () => {
        // Arrange & Act
        const sut = cleanFilterFailed('dir/file.dat' as never, 'myfilter', 3);

        // Assert — the CLEAN_FILTER_FAILED case must return its own message, not fall through
        // to the SMUDGE_FILTER_FAILED case which starts with "smudge filter".
        expect(sut.message).toMatch(/^CLEAN_FILTER_FAILED: clean filter '/);
      });
    });
  });
});

describe('smudgeFilterFailed error', () => {
  describe('Given smudgeFilterFailed factory with path, filter name and exitCode', () => {
    describe('When accessing .data', () => {
      it('Then data carries code SMUDGE_FILTER_FAILED, path, filter, exitCode', () => {
        // Arrange & Act
        const sut = smudgeFilterFailed('src/file.bin' as never, 'lfs', 1);

        // Assert
        expect(sut.data.code).toBe('SMUDGE_FILTER_FAILED');
        expect(sut.data.code === 'SMUDGE_FILTER_FAILED' && sut.data.path).toBe('src/file.bin');
        expect(sut.data.code === 'SMUDGE_FILTER_FAILED' && sut.data.filter).toBe('lfs');
        expect(sut.data.code === 'SMUDGE_FILTER_FAILED' && sut.data.exitCode).toBe(1);
      });
    });
  });

  describe('Given smudgeFilterFailed with exitCode 128', () => {
    describe('When accessing .data.exitCode', () => {
      it('Then exitCode is preserved as 128', () => {
        // Arrange & Act
        const sut = smudgeFilterFailed('blob.dat' as never, 'myfilter', 128);

        // Assert
        expect(sut.data.code).toBe('SMUDGE_FILTER_FAILED');
        expect(sut.data.code === 'SMUDGE_FILTER_FAILED' && sut.data.exitCode).toBe(128);
      });
    });
  });

  describe('Given smudgeFilterFailed factory', () => {
    describe('When reading .message', () => {
      it('Then message contains filter name, file basename and exitCode', () => {
        // Arrange & Act
        const sut = smudgeFilterFailed('repo/assets/photo.png' as never, 'lfs-smudge', 2);

        // Assert
        expect(sut.message).toContain('lfs-smudge');
        expect(sut.message).toContain('photo.png');
        expect(sut.message).toContain('2');
      });
    });
  });
});

describe('signingFailed error', () => {
  describe('Given signingFailed factory with reason "signer-failed" and format "openpgp"', () => {
    describe('When reading .message', () => {
      it('Then message contains the reason and the format', () => {
        // Arrange & Act
        const sut = signingFailed('signer-failed', 'openpgp');

        // Assert
        expect(sut.message).toContain('signer-failed');
        expect(sut.message).toContain('openpgp');
      });
    });
  });

  describe('Given signingFailed factory with reason "off-node" and no format', () => {
    describe('When reading .message', () => {
      it('Then message contains the reason and omits any format suffix', () => {
        // Arrange & Act
        const sut = signingFailed('off-node');

        // Assert
        expect(sut.message).toContain('off-node');
        expect(sut.message).not.toContain('format=');
      });
    });
  });

  describe('Given signingFailed factory', () => {
    describe('When reading .message prefix', () => {
      it('Then message starts with "gpg failed to sign the data" (not a fall-through case)', () => {
        // Arrange & Act
        const sut = signingFailed('unsupported-format', 'x509');

        // Assert
        expect(sut.message).toMatch(/^SIGNING_FAILED: gpg failed to sign the data \(/);
      });
    });
  });
});

describe('signedPushUnsupported error', () => {
  describe('Given signedPushUnsupported factory with a remote name', () => {
    describe('When reading .message', () => {
      it('Then message states the receiving end does not support --signed push', () => {
        // Arrange & Act
        const sut = signedPushUnsupported('origin');

        // Assert
        expect(sut.message).toBe(
          'SIGNED_PUSH_UNSUPPORTED: the receiving end does not support --signed push',
        );
      });
    });
  });
});
