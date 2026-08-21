import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../../src/adapters/memory/memory-adapter.js';
import { runRevIndexHealthPass } from '../../../../../../src/application/commands/internal/fsck/rev-index-health.js';
import type {
  FsckFinding,
  FsckOptions,
} from '../../../../../../src/application/commands/internal/fsck/types.js';
import { packPositionMap } from '../../../../../../src/application/primitives/internal/pack-positions.js';
import { permissionDenied } from '../../../../../../src/domain/error.js';
import { entryOffsets, parsePackIndex } from '../../../../../../src/domain/storage/index.js';
import type { Context } from '../../../../../../src/ports/context.js';
import { writeSyntheticPack, writeSyntheticRevIndex } from '../../../primitives/pack-fixture.js';

const sut = runRevIndexHealthPass;

const enc = new TextEncoder();

const idxFilePath = (ctx: Context, name: string): string =>
  `${ctx.layout.gitDir}/objects/pack/pack-${name}.idx`;

const onePackEntry = (content: string) => [
  { kind: 'base' as const, type: 'blob' as const, content: enc.encode(content) },
];

const manyPackEntries = (n: number, prefix: string) =>
  Array.from({ length: n }, (_unused, i) => ({
    kind: 'base' as const,
    type: 'blob' as const,
    content: enc.encode(`${prefix}-${i}`),
  }));

/** The pack's own reverse-index body, derived from its real `.idx` — the
 *  same reference `runRevIndexHealthPass` itself compares against. */
async function correctBody(ctx: Context, name: string): Promise<Uint32Array> {
  const idxBytes = await ctx.fs.read(idxFilePath(ctx, name));
  return packPositionMap(parsePackIndex(idxBytes, 20));
}

/** The same table, derived WITHOUT the production helper: each `.idx` entry
 *  paired with its own offset, sorted by offset, projected back to index
 *  position — the independent oracle proving `correctBody` is a real
 *  reordering and not whatever the code under test happens to compute. */
async function offsetSortedBody(ctx: Context, name: string): Promise<ReadonlyArray<number>> {
  const idxBytes = await ctx.fs.read(idxFilePath(ctx, name));
  return entryOffsets(parsePackIndex(idxBytes, 20))
    .map((offset, indexPosition) => ({ offset, indexPosition }))
    .sort((left, right) => left.offset - right.offset)
    .map((entry) => entry.indexPosition);
}

function findingsOfType<T extends FsckFinding['type']>(
  result: { readonly findings: ReadonlyArray<FsckFinding> },
  type: T,
): ReadonlyArray<Extract<FsckFinding, { type: T }>> {
  return result.findings.filter(
    (finding): finding is Extract<FsckFinding, { type: T }> => finding.type === type,
  );
}

describe('Given a 4-object pack whose ids sort differently from its pack offsets', () => {
  describe('When the reference body every healthy fixture below is written from is derived', () => {
    it('Then it is a genuine permutation, not the identity, and equals the offset-sorted .idx', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await writeSyntheticPack(ctx, 'reference', manyPackEntries(4, 'reference'));
      const sut = correctBody;

      // Act
      const result = await sut(ctx, 'reference');

      // Assert
      const stored = [...result];
      expect([...stored].sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
      expect(stored).not.toEqual([0, 1, 2, 3]);
      expect(stored).toEqual([...(await offsetSortedBody(ctx, 'reference'))]);
    });
  });
});

describe('Given a pack with a healthy .rev', () => {
  describe('When the rev-index health pass runs', () => {
    it('Then no finding is emitted and exitBit is 0', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await writeSyntheticPack(ctx, 'clean-one', onePackEntry('clean-one-content'));
      await writeSyntheticRevIndex(ctx, 'clean-one', [0]);

      // Act
      const result = await sut(ctx, {});

      // Assert
      expect(result.findings).toHaveLength(0);
      expect(result.exitBit).toBe(0);
    });
  });
});

describe('Given a pack with no .rev file on disk', () => {
  describe('When the rev-index health pass runs', () => {
    it('Then no finding is emitted and exitBit is 0', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await writeSyntheticPack(ctx, 'no-rev', onePackEntry('no-rev-content'));

      // Act
      const result = await sut(ctx, {});

      // Assert
      expect(result.findings).toHaveLength(0);
      expect(result.exitBit).toBe(0);
    });
  });
});

describe('Given a pack whose bad-magic .rev is present but unreadable (permission denied)', () => {
  describe('When the rev-index health pass runs', () => {
    it('Then no finding is emitted and exitBit is 0 — the unreadable classification masks a real fault', async () => {
      // Arrange — the planted `.rev` has a bad signature, so a pass that read
      // it would score bit 64; silence is only explainable by the unreadable
      // classification, the guard's other arm.
      const ctx = createMemoryContext();
      await writeSyntheticPack(ctx, 'unreadable-rev', onePackEntry('unreadable-rev-content'));
      await writeSyntheticRevIndex(ctx, 'unreadable-rev', [0], { magic: 0 });
      const revPath = `${ctx.layout.gitDir}/objects/pack/pack-unreadable-rev.rev`;
      const wrapped: Context = {
        ...ctx,
        fs: {
          ...ctx.fs,
          readSlice: async (path: string, offset: number, length: number) => {
            if (path === revPath) throw permissionDenied(path);
            return ctx.fs.readSlice(path, offset, length);
          },
        },
      };

      // Act
      const result = await sut(wrapped, {});

      // Assert
      expect(result.findings).toHaveLength(0);
      expect(result.exitBit).toBe(0);
    });
  });
});

describe('Given a multi-object pack whose .idx carries no fault, with a correctly-derived .rev', () => {
  describe('When the rev-index health pass runs', () => {
    it('Then no finding is emitted and exitBit is 0', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await writeSyntheticPack(ctx, 'clean-many', manyPackEntries(3, 'clean-many'));
      const body = await correctBody(ctx, 'clean-many');
      await writeSyntheticRevIndex(ctx, 'clean-many', body);

      // Act
      const result = await sut(ctx, {});

      // Assert
      expect(result.findings).toHaveLength(0);
      expect(result.exitBit).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// LOAD FAMILY — a `.rev` that never reaches usable
// ---------------------------------------------------------------------------

describe('Given a pack whose .rev fails to load', () => {
  describe('When the rev-index health pass runs', () => {
    it('Then a bad-magic .rev produces one pack-rev-index-invalid naming the signature fault', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await writeSyntheticPack(ctx, 'bad-magic', onePackEntry('bad-magic-content'));
      await writeSyntheticRevIndex(ctx, 'bad-magic', [0], { magic: 0 });

      // Act
      const result = await sut(ctx, {});

      // Assert
      const invalid = findingsOfType(result, 'pack-rev-index-invalid');
      expect(invalid).toHaveLength(1);
      expect(invalid[0]!.pack).toBe('pack-bad-magic');
      expect(invalid[0]!.reason).toBe('invalid signature: expected 0x52494458, got 0x00000000');
      expect(result.exitBit).toBe(64);
      expect(findingsOfType(result, 'pack-rev-index-position-mismatch')).toHaveLength(0);
    });

    it('Then version 2 produces one pack-rev-index-invalid naming the version fault', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await writeSyntheticPack(ctx, 'version-2', onePackEntry('version-2-content'));
      await writeSyntheticRevIndex(ctx, 'version-2', [0], { version: 2 });

      // Act
      const result = await sut(ctx, {});

      // Assert
      const invalid = findingsOfType(result, 'pack-rev-index-invalid');
      expect(invalid).toHaveLength(1);
      expect(invalid[0]!.reason).toBe('unsupported version: expected 1, got 2');
      expect(result.exitBit).toBe(64);
      expect(findingsOfType(result, 'pack-rev-index-position-mismatch')).toHaveLength(0);
    });

    it('Then version 0 produces one pack-rev-index-invalid naming the version fault', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await writeSyntheticPack(ctx, 'version-0', onePackEntry('version-0-content'));
      await writeSyntheticRevIndex(ctx, 'version-0', [0], { version: 0 });

      // Act
      const result = await sut(ctx, {});

      // Assert
      const invalid = findingsOfType(result, 'pack-rev-index-invalid');
      expect(invalid).toHaveLength(1);
      expect(invalid[0]!.reason).toBe('unsupported version: expected 1, got 0');
      expect(result.exitBit).toBe(64);
      expect(findingsOfType(result, 'pack-rev-index-position-mismatch')).toHaveLength(0);
    });

    it('Then hashId 0 produces one pack-rev-index-invalid naming the hash-id fault', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await writeSyntheticPack(ctx, 'hash-id-0', onePackEntry('hash-id-0-content'));
      await writeSyntheticRevIndex(ctx, 'hash-id-0', [0], { hashId: 0 });

      // Act
      const result = await sut(ctx, {});

      // Assert
      const invalid = findingsOfType(result, 'pack-rev-index-invalid');
      expect(invalid).toHaveLength(1);
      expect(invalid[0]!.reason).toBe('unsupported hash id: expected 1 or 2, got 0');
      expect(result.exitBit).toBe(64);
      expect(findingsOfType(result, 'pack-rev-index-position-mismatch')).toHaveLength(0);
    });

    it('Then a .rev truncated to 8 bytes produces one pack-rev-index-invalid, too small', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await writeSyntheticPack(ctx, 'trunc-8', onePackEntry('trunc-8-content'));
      await writeSyntheticRevIndex(ctx, 'trunc-8', [0], { truncateTo: 8 });

      // Act
      const result = await sut(ctx, {});

      // Assert
      const invalid = findingsOfType(result, 'pack-rev-index-invalid');
      expect(invalid).toHaveLength(1);
      expect(invalid[0]!.reason).toBe('reverse index is too small');
      expect(result.exitBit).toBe(64);
      expect(findingsOfType(result, 'pack-rev-index-position-mismatch')).toHaveLength(0);
    });

    it('Then a zero-length .rev produces one pack-rev-index-invalid, too small', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await writeSyntheticPack(ctx, 'zero-length', onePackEntry('zero-length-content'));
      await writeSyntheticRevIndex(ctx, 'zero-length', [0], { truncateTo: 0 });

      // Act
      const result = await sut(ctx, {});

      // Assert
      const invalid = findingsOfType(result, 'pack-rev-index-invalid');
      expect(invalid).toHaveLength(1);
      expect(invalid[0]!.reason).toBe('reverse index is too small');
      expect(result.exitBit).toBe(64);
      expect(findingsOfType(result, 'pack-rev-index-position-mismatch')).toHaveLength(0);
    });

    it('Then a .rev truncated to 12 + 2·digestLength − 1 bytes produces one pack-rev-index-invalid, too small', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await writeSyntheticPack(ctx, 'boundary-under', onePackEntry('boundary-under-content'));
      await writeSyntheticRevIndex(ctx, 'boundary-under', [0], { truncateTo: 51 });

      // Act
      const result = await sut(ctx, {});

      // Assert
      const invalid = findingsOfType(result, 'pack-rev-index-invalid');
      expect(invalid).toHaveLength(1);
      expect(invalid[0]!.reason).toBe('reverse index is too small');
      expect(result.exitBit).toBe(64);
      expect(findingsOfType(result, 'pack-rev-index-position-mismatch')).toHaveLength(0);
    });

    it('Then a .rev truncated to exactly 12 + 2·digestLength bytes produces one pack-rev-index-invalid, corrupt', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await writeSyntheticPack(ctx, 'boundary-exact', onePackEntry('boundary-exact-content'));
      await writeSyntheticRevIndex(ctx, 'boundary-exact', [0], { truncateTo: 52 });

      // Act
      const result = await sut(ctx, {});

      // Assert
      const invalid = findingsOfType(result, 'pack-rev-index-invalid');
      expect(invalid).toHaveLength(1);
      expect(invalid[0]!.reason).toBe('reverse index is corrupt');
      expect(result.exitBit).toBe(64);
      expect(findingsOfType(result, 'pack-rev-index-position-mismatch')).toHaveLength(0);
    });

    it('Then four bytes appended to a .rev produce one pack-rev-index-invalid, corrupt', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await writeSyntheticPack(ctx, 'appended-4', onePackEntry('appended-4-content'));
      await writeSyntheticRevIndex(ctx, 'appended-4', [0], { appendBytes: 4 });

      // Act
      const result = await sut(ctx, {});

      // Assert
      const invalid = findingsOfType(result, 'pack-rev-index-invalid');
      expect(invalid).toHaveLength(1);
      expect(invalid[0]!.reason).toBe('reverse index is corrupt');
      expect(result.exitBit).toBe(64);
      expect(findingsOfType(result, 'pack-rev-index-position-mismatch')).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// ACCEPTED BY GIT — shapes canonical git reads without complaint
// ---------------------------------------------------------------------------

describe('Given a pack whose .rev declares hashId 2 in a SHA-1 repository, trailer restamped', () => {
  describe('When the rev-index health pass runs', () => {
    it('Then no finding is emitted — canonical git accepts the hashId/digestLength disagreement', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await writeSyntheticPack(ctx, 'hash-id-2', onePackEntry('hash-id-2-content'));
      await writeSyntheticRevIndex(ctx, 'hash-id-2', [0], { hashId: 2 });

      // Act
      const result = await sut(ctx, {});

      // Assert
      expect(result.findings).toHaveLength(0);
      expect(result.exitBit).toBe(0);
    });
  });
});

describe('Given a pack whose .rev embeds a flipped pack-checksum copy, trailer restamped', () => {
  describe('When the rev-index health pass runs', () => {
    it('Then no finding is emitted — canonical git never checks the embedded pack-checksum copy', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await writeSyntheticPack(ctx, 'flipped-checksum', onePackEntry('flipped-checksum-content'));
      await writeSyntheticRevIndex(ctx, 'flipped-checksum', [0], {
        packChecksum: new Uint8Array(20).fill(0xff),
      });

      // Act
      const result = await sut(ctx, {});

      // Assert
      expect(result.findings).toHaveLength(0);
      expect(result.exitBit).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// DIGEST
// ---------------------------------------------------------------------------

describe('Given a pack whose .rev trailer digest is flipped', () => {
  describe('When the rev-index health pass runs', () => {
    it("Then one pack-rev-index-invalid with reason 'invalid checksum' is emitted, bit 64 set", async () => {
      // Arrange
      const ctx = createMemoryContext();
      await writeSyntheticPack(ctx, 'bad-checksum', onePackEntry('bad-checksum-content'));
      await writeSyntheticRevIndex(ctx, 'bad-checksum', [0], { flipChecksum: true });

      // Act
      const result = await sut(ctx, {});

      // Assert
      const invalid = findingsOfType(result, 'pack-rev-index-invalid');
      expect(invalid).toHaveLength(1);
      expect(invalid[0]!.reason).toBe('invalid checksum');
      expect(result.exitBit).toBe(64);
    });
  });
});

// ---------------------------------------------------------------------------
// BODY
// ---------------------------------------------------------------------------

describe('Given a 4-object pack whose .rev body[0] is out of range, trailer restamped', () => {
  describe('When the rev-index health pass runs', () => {
    it('Then one pack-rev-index-position-mismatch names position 0, bit 64 set', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await writeSyntheticPack(ctx, 'out-of-range', manyPackEntries(4, 'out-of-range'));
      const expected = await correctBody(ctx, 'out-of-range');
      const body = expected.slice();
      body[0] = 999;
      await writeSyntheticRevIndex(ctx, 'out-of-range', body);

      // Act
      const result = await sut(ctx, {});

      // Assert
      const mismatches = findingsOfType(result, 'pack-rev-index-position-mismatch');
      expect(mismatches).toHaveLength(1);
      expect(mismatches[0]!.position).toBe(0);
      expect(mismatches[0]!.expected).toBe(expected[0]);
      expect(mismatches[0]!.stored).toBe(999);
      expect(result.exitBit).toBe(64);
    });
  });
});

describe('Given a 4-object pack whose .rev has body[0] === body[1], trailer restamped', () => {
  describe('When the rev-index health pass runs', () => {
    it('Then one pack-rev-index-position-mismatch names position 0 alone, bit 64 set', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await writeSyntheticPack(ctx, 'duplicate', manyPackEntries(4, 'duplicate'));
      const expected = await correctBody(ctx, 'duplicate');
      const body = expected.slice();
      body[0] = body[1]!;
      await writeSyntheticRevIndex(ctx, 'duplicate', body);

      // Act
      const result = await sut(ctx, {});

      // Assert
      const mismatches = findingsOfType(result, 'pack-rev-index-position-mismatch');
      expect(mismatches).toHaveLength(1);
      expect(mismatches[0]!.position).toBe(0);
      expect(mismatches[0]!.expected).toBe(expected[0]);
      expect(mismatches[0]!.stored).toBe(expected[1]);
      expect(result.exitBit).toBe(64);
    });
  });
});

describe('Given a 4-object pack whose .rev has two wrong positions, trailer restamped', () => {
  describe('When the rev-index health pass runs', () => {
    it('Then one pack-rev-index-position-mismatch is emitted per wrong position, bit 64 set once', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await writeSyntheticPack(ctx, 'two-wrong', manyPackEntries(4, 'two-wrong'));
      const expected = await correctBody(ctx, 'two-wrong');
      const body = expected.slice();
      // Transposition: both touched positions individually disagree with
      // their own reference value (a permutation over distinct positions
      // never repeats a value), so this is exactly two mismatches, not zero.
      const swap = body[0]!;
      body[0] = body[2]!;
      body[2] = swap;
      await writeSyntheticRevIndex(ctx, 'two-wrong', body);

      // Act
      const result = await sut(ctx, {});

      // Assert
      const mismatches = findingsOfType(result, 'pack-rev-index-position-mismatch');
      expect(mismatches).toHaveLength(2);
      const positions = mismatches.map((m) => m.position).sort((a, b) => a - b);
      expect(positions).toEqual([0, 2]);
      expect(result.exitBit).toBe(64);
    });
  });
});

describe('Given a 4-object pack whose .rev has only its last position wrong, trailer restamped', () => {
  describe('When the rev-index health pass runs', () => {
    it('Then one pack-rev-index-position-mismatch names the last position, bit 64 set', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await writeSyntheticPack(ctx, 'last-wrong', manyPackEntries(4, 'last-wrong'));
      const expected = await correctBody(ctx, 'last-wrong');
      const lastPosition = expected.length - 1;
      const body = expected.slice();
      body[lastPosition] = 999;
      await writeSyntheticRevIndex(ctx, 'last-wrong', body);

      // Act
      const result = await sut(ctx, {});

      // Assert
      const mismatches = findingsOfType(result, 'pack-rev-index-position-mismatch');
      expect(mismatches).toHaveLength(1);
      expect(mismatches[0]!.position).toBe(lastPosition);
      expect(mismatches[0]!.stored).toBe(999);
      expect(result.exitBit).toBe(64);
    });
  });
});

// ---------------------------------------------------------------------------
// COMPOSITION
// ---------------------------------------------------------------------------

describe('Given a pack whose .rev has both a flipped trailer and a wrong body position', () => {
  describe('When the rev-index health pass runs', () => {
    it('Then both the invalid and mismatch findings are emitted, bit 64 set once', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await writeSyntheticPack(ctx, 'both-wrong', manyPackEntries(2, 'both-wrong'));
      const expected = await correctBody(ctx, 'both-wrong');
      const body = expected.slice();
      body[0] = 999;
      await writeSyntheticRevIndex(ctx, 'both-wrong', body, { flipChecksum: true });

      // Act
      const result = await sut(ctx, {});

      // Assert
      const invalid = findingsOfType(result, 'pack-rev-index-invalid');
      expect(invalid).toHaveLength(1);
      expect(invalid[0]!.pack).toBe('pack-both-wrong');
      expect(invalid[0]!.reason).toBe('invalid checksum');
      const mismatches = findingsOfType(result, 'pack-rev-index-position-mismatch');
      expect(mismatches).toHaveLength(1);
      expect(mismatches[0]!.position).toBe(0);
      expect(mismatches[0]!.stored).toBe(999);
      expect(result.exitBit).toBe(64);
    });
  });
});

// ---------------------------------------------------------------------------
// UNIVERSE — an unusable .idx masks its .rev entirely
// ---------------------------------------------------------------------------

describe('Given a pack whose .idx is corrupt, with a broken .rev beside it', () => {
  describe('When the rev-index health pass runs', () => {
    it('Then no finding is emitted at all — the pack never joins registry.all()', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await writeSyntheticPack(ctx, 'masked', onePackEntry('masked-content'));
      await ctx.fs.write(idxFilePath(ctx, 'masked'), new Uint8Array(1072));
      await writeSyntheticRevIndex(ctx, 'masked', [0], { magic: 0 });

      // Act
      const result = await sut(ctx, {});

      // Assert
      expect(result.findings).toHaveLength(0);
      expect(result.exitBit).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// MODES — the pass is ungated: identical output in every fsck mode
// ---------------------------------------------------------------------------

const ALL_MODES: ReadonlyArray<{ readonly label: string; readonly opts: FsckOptions }> = [
  { label: 'default', opts: {} },
  { label: 'connectivityOnly', opts: { connectivityOnly: true } },
  { label: 'full: false', opts: { full: false } },
  { label: 'strict', opts: { strict: true } },
];

describe('Given a pack whose .rev fails to load', () => {
  describe('When the rev-index health pass runs under any fsck mode', () => {
    it.each(ALL_MODES)(
      'Then mode $label produces the same finding and bit as the default',
      async ({ opts }) => {
        // Arrange
        const ctx = createMemoryContext();
        await writeSyntheticPack(ctx, 'modes-load', onePackEntry('modes-load-content'));
        await writeSyntheticRevIndex(ctx, 'modes-load', [0], { magic: 0 });

        // Act
        const result = await sut(ctx, opts);

        // Assert
        const invalid = findingsOfType(result, 'pack-rev-index-invalid');
        expect(invalid).toHaveLength(1);
        expect(invalid[0]!.pack).toBe('pack-modes-load');
        expect(invalid[0]!.reason).toBe('invalid signature: expected 0x52494458, got 0x00000000');
        expect(result.exitBit).toBe(64);
      },
    );
  });
});

describe('Given a pack whose .rev trailer digest is flipped', () => {
  describe('When the rev-index health pass runs under any fsck mode', () => {
    it.each(ALL_MODES)(
      'Then mode $label produces the same finding and bit as the default',
      async ({ opts }) => {
        // Arrange
        const ctx = createMemoryContext();
        await writeSyntheticPack(ctx, 'modes-digest', onePackEntry('modes-digest-content'));
        await writeSyntheticRevIndex(ctx, 'modes-digest', [0], { flipChecksum: true });

        // Act
        const result = await sut(ctx, opts);

        // Assert
        const invalid = findingsOfType(result, 'pack-rev-index-invalid');
        expect(invalid).toHaveLength(1);
        expect(invalid[0]!.reason).toBe('invalid checksum');
        expect(result.exitBit).toBe(64);
      },
    );
  });
});

describe('Given a pack whose .rev has a wrong body position', () => {
  describe('When the rev-index health pass runs under any fsck mode', () => {
    it.each(ALL_MODES)(
      'Then mode $label produces the same finding and bit as the default',
      async ({ opts }) => {
        // Arrange
        const ctx = createMemoryContext();
        await writeSyntheticPack(ctx, 'modes-body', manyPackEntries(2, 'modes-body'));
        const expected = await correctBody(ctx, 'modes-body');
        const body = expected.slice();
        body[0] = 999;
        await writeSyntheticRevIndex(ctx, 'modes-body', body);

        // Act
        const result = await sut(ctx, opts);

        // Assert
        const mismatches = findingsOfType(result, 'pack-rev-index-position-mismatch');
        expect(mismatches).toHaveLength(1);
        expect(mismatches[0]!.pack).toBe('pack-modes-body');
        expect(mismatches[0]!.position).toBe(0);
        expect(mismatches[0]!.expected).toBe(expected[0]);
        expect(mismatches[0]!.stored).toBe(999);
        expect(result.exitBit).toBe(64);
      },
    );
  });
});

// ---------------------------------------------------------------------------
// TWO PACKS
// ---------------------------------------------------------------------------

describe('Given two packs each with a corrupt .rev', () => {
  describe('When the rev-index health pass runs', () => {
    it('Then two pack-rev-index-invalid findings are emitted and bit 64 is set once', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await writeSyntheticPack(ctx, 'two-a', onePackEntry('two-a-content'));
      await writeSyntheticRevIndex(ctx, 'two-a', [0], { magic: 0 });
      await writeSyntheticPack(ctx, 'two-b', onePackEntry('two-b-content'));
      await writeSyntheticRevIndex(ctx, 'two-b', [0], { magic: 0 });

      // Act
      const result = await sut(ctx, {});

      // Assert
      const invalid = findingsOfType(result, 'pack-rev-index-invalid');
      expect(invalid).toHaveLength(2);
      expect(invalid.map((f) => f.pack).sort()).toEqual(['pack-two-a', 'pack-two-b']);
      expect(result.exitBit).toBe(64);
    });
  });
});
