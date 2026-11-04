import { describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import {
  expandRef,
  resolveAmbiguousLadder,
} from '../../../../../src/application/commands/internal/refname-ambiguity.js';
import * as configRead from '../../../../../src/application/primitives/config-read.js';
import * as resolveOidPrefixModule from '../../../../../src/application/primitives/resolve-oid-prefix.js';
import type { ObjectId, RefName } from '../../../../../src/domain/objects/index.js';
import type { Context } from '../../../../../src/ports/context.js';

vi.mock('../../../../../src/application/primitives/config-read.js', async (importOriginal) => ({
  ...(await importOriginal<typeof configRead>()),
  findLastEntries: vi.fn(async () => [undefined, undefined]),
}));

const ID = 'a'.repeat(40) as ObjectId;

describe('expandRef', () => {
  describe('Given a name every namespace resolves, with the ambiguity check on', () => {
    describe('When it is expanded', () => {
      it('Then every namespace is listed and the setting is read once', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const resolve = async (candidate: RefName | 'HEAD') =>
          ({ kind: 'found', id: ID, ref: candidate as RefName }) as const;
        const settingsReads = vi.mocked(configRead.findLastEntries);
        settingsReads.mockClear();
        const sut = expandRef;

        // Act
        const result = await sut(ctx, 'main', resolve);

        // Assert
        expect(result.map((found) => found.ref)).toEqual([
          'main',
          'refs/main',
          'refs/tags/main',
          'refs/heads/main',
          'refs/remotes/main',
          'refs/remotes/main/HEAD',
        ]);
        expect(settingsReads).toHaveBeenCalledTimes(1);
      });
    });
  });
});

type Candidate = RefName | 'HEAD';

const loggedCtx = (warn: (message: string) => void) =>
  ({ ...createMemoryContext(), logger: { warn } }) as unknown as Context;

describe('resolveAmbiguousLadder', () => {
  describe('Given two candidates that both resolve', () => {
    describe('When resolveAmbiguousLadder reads them in quiet mode', () => {
      it('Then it returns the first and warns nothing', async () => {
        // Arrange
        const warnings: string[] = [];
        const ctx = loggedCtx((message) => warnings.push(message));
        const candidates = ['x', 'refs/tags/x'] as Candidate[];
        const read = (candidate: Candidate) => Promise.resolve(`found:${candidate}`);
        const sut = resolveAmbiguousLadder;

        // Act
        const result = await sut(ctx, 'x', candidates, read, { mode: 'quiet' });

        // Assert
        expect(result).toBe('found:x');
        expect(warnings).toEqual([]);
      });
    });
  });

  describe('Given one candidate that resolves under a hex-looking name', () => {
    describe('When resolveAmbiguousLadder reads it in quiet mode', () => {
      it('Then it makes no abbreviation scan', async () => {
        // Arrange
        const ctx = loggedCtx(() => undefined);
        const scan = vi.spyOn(resolveOidPrefixModule, 'resolveOidPrefix');
        const read = (candidate: Candidate) =>
          Promise.resolve(candidate === 'abcd' ? ID : undefined);
        const sut = resolveAmbiguousLadder;

        // Act
        const result = await sut(ctx, 'abcd', ['abcd'] as Candidate[], read, { mode: 'quiet' });

        // Assert
        expect(result).toBe(ID);
        expect(scan).not.toHaveBeenCalled();
      });
    });
  });

  describe('Given a winner followed by a dangling candidate', () => {
    describe('When resolveAmbiguousLadder reads them in quiet mode', () => {
      it('Then the later candidate is still read', async () => {
        // Arrange
        const ctx = loggedCtx(() => undefined);
        const seen: Candidate[] = [];
        const read = (candidate: Candidate) => {
          seen.push(candidate);
          return Promise.resolve(candidate === 'x' ? ID : undefined);
        };
        const candidates = ['x', 'refs/tags/x'] as Candidate[];
        const sut = resolveAmbiguousLadder;

        // Act
        await sut(ctx, 'x', candidates, read, { mode: 'quiet' });

        // Assert
        expect(seen).toEqual(candidates);
      });
    });
  });
});
