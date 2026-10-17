import { describe, expect, it } from 'vitest';
import type { IndexEntry } from '../../../../src/domain/git-index/index-entry.js';
import {
  parseResolveUndo,
  type ResolveUndoRecord,
  type ResolveUndoStage,
  recordResolveUndo,
  resolveUndoRecordOf,
  serializeResolveUndo,
} from '../../../../src/domain/git-index/resolve-undo.js';
import { bytesToHex, hexToBytes } from '../../../../src/domain/objects/encoding.js';
import {
  FILE_MODE,
  type FileMode,
  type FilePath,
  type ObjectId,
} from '../../../../src/domain/objects/index.js';

const sut = parseResolveUndo;

const BASE = '1111111111111111111111111111111111111111' as ObjectId;
const OURS = '2222222222222222222222222222222222222222' as ObjectId;
const THEIRS = '3333333333333333333333333333333333333333' as ObjectId;
const DIGEST = 20;

const concat = (...parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

const text = (value: string): Uint8Array => new TextEncoder().encode(value);

/** git's `resolve_undo_write` record: path, three octal modes, then one id per non-zero mode. */
const record = (
  path: string,
  modes: readonly [string, string, string],
  ids: ReadonlyArray<ObjectId>,
) => concat(text(`${path}\0${modes.join('\0')}\0`), ...ids.map((id) => hexToBytes(id)));

describe('Given a resolve-undo record with all three stages', () => {
  describe('When it is parsed', () => {
    it('Then every stage carries its mode and id, in stage order', () => {
      // Arrange
      const data = record('f', ['100644', '100755', '120000'], [BASE, OURS, THEIRS]);

      // Act
      const result = sut(data, DIGEST);

      // Assert
      expect(result).toEqual([
        {
          path: 'f',
          stages: [
            { stage: 1, mode: 0o100644, id: BASE },
            { stage: 2, mode: 0o100755, id: OURS },
            { stage: 3, mode: 0o120000, id: THEIRS },
          ],
        },
      ]);
    });
  });
});

describe('Given two records, the first without a base stage', () => {
  describe('When they are parsed', () => {
    it('Then a zero mode carries no id and the next record follows', () => {
      // Arrange
      const data = concat(
        record('a', ['0', '100644', '100644'], [OURS, THEIRS]),
        record('b', ['100644', '0', '0'], [BASE]),
      );

      // Act
      const result = sut(data, DIGEST);

      // Assert
      expect(result).toEqual([
        {
          path: 'a',
          stages: [
            { stage: 2, mode: 0o100644, id: OURS },
            { stage: 3, mode: 0o100644, id: THEIRS },
          ],
        },
        { path: 'b', stages: [{ stage: 1, mode: 0o100644, id: BASE }] },
      ]);
    });
  });
});

describe('Given an empty extension', () => {
  describe('When it is parsed', () => {
    it('Then it holds no record', () => {
      // Arrange
      const data = new Uint8Array(0);

      // Act
      const result = sut(data, DIGEST);

      // Assert
      expect(result).toEqual([]);
    });
  });
});

describe.each([
  { label: 'a path with no NUL', data: text('f') },
  { label: 'a path that ends the data', data: text('f\0') },
  {
    label: 'an empty mode',
    data: concat(text('f\0\u0000100644\u0000100644\0'), hexToBytes(OURS), hexToBytes(THEIRS)),
  },
  {
    label: 'a non-octal mode',
    data: concat(
      text('f\u0000100648\u0000100644\u0000100644\0'),
      hexToBytes(BASE),
      hexToBytes(OURS),
      hexToBytes(THEIRS),
    ),
  },
  { label: 'a mode with no NUL', data: text('f\u0000100644') },
  { label: 'a last mode that ends the data', data: text('f\u0000000\u0000000\u0000000\0') },
  {
    label: 'an id cut short',
    data: concat(
      text('f\u0000100644\u0000000\u0000000\0'),
      hexToBytes(BASE).subarray(0, DIGEST - 1),
    ),
  },
])('Given $label', ({ data }) => {
  describe('When it is parsed', () => {
    it('Then the whole extension is refused, as git drops it', () => {
      // Arrange
      const input = data;

      // Act
      const result = sut(input, DIGEST);

      // Assert
      expect(result).toBeUndefined();
    });
  });
});

describe('Given a malformed record after a valid one', () => {
  describe('When they are parsed', () => {
    it('Then the valid one is dropped too', () => {
      // Arrange
      const data = concat(record('a', ['100644', '0', '0'], [BASE]), text('b'));

      // Act
      const result = sut(data, DIGEST);

      // Assert
      expect(result).toBeUndefined();
    });
  });
});

describe('Given mode fields git reads through strtoul', () => {
  describe.each([
    { field: ' 100644', mode: 0o100644 },
    { field: '\t\n+100644', mode: 0o100644 },
    { field: '0100644', mode: 0o100644 },
    { field: '-100644', mode: 2 ** 32 - 0o100644 },
    { field: '-0', mode: 0 },
    { field: '7'.repeat(23), mode: 2 ** 32 - 1 },
    { field: `2${'0'.repeat(21)}`, mode: 2 ** 32 - 1 },
    { field: `-1${'7'.repeat(21)}`, mode: 1 },
  ])('When the stage-1 mode is "$field"', ({ field, mode }) => {
    it('Then it decodes to the unsigned int git stores', () => {
      // Arrange
      const ids = mode === 0 ? [OURS] : [BASE, OURS];
      const data = record('f', [field, '100644', '0'], ids);
      const ours = { stage: 2, mode: 0o100644, id: OURS };

      // Act
      const result = sut(data, DIGEST);

      // Assert
      expect(result).toEqual([
        { path: 'f', stages: mode === 0 ? [ours] : [{ stage: 1, mode, id: BASE }, ours] },
      ]);
    });
  });

  describe.each([' ', '+', '-', ' +', '+-1', '1 '])('When the stage-1 mode is "%s"', (field) => {
    it('Then the extension is refused as git refuses it', () => {
      // Arrange
      const data = concat(
        record('f', [field, '0', '0'], []),
        record('g', ['100644', '0', '0'], [BASE]),
      );

      // Act
      const result = sut(data, DIGEST);

      // Assert
      expect(result).toBeUndefined();
    });
  });
});

describe('Given a record whose path bytes are not UTF-8', () => {
  describe('When it is parsed', () => {
    it('Then the raw bytes are kept beside the replacement-character view', () => {
      // Arrange
      const pathBytes = Uint8Array.from([0x61, 0x2f, 0xff]);
      const data = concat(pathBytes, text('\u0000100644\u00000\u00000\0'), hexToBytes(BASE));

      // Act
      const result = sut(data, DIGEST);

      // Assert
      expect(result).toEqual([
        {
          path: 'a/�',
          pathBytes,
          stages: [{ stage: 1, mode: 0o100644, id: BASE }],
        },
      ]);
    });
  });
});

describe('Given a record whose path starts with a byte order mark', () => {
  describe('When it is parsed', () => {
    it('Then the mark is kept in the path', () => {
      // Arrange
      const data = record('﻿f', ['100644', '0', '0'], [BASE]);

      // Act
      const result = sut(data, DIGEST);

      // Assert
      expect(result?.[0]?.path).toBe('﻿f');
    });
  });
});

const F = 'f' as FilePath;
const stage = (n: 1 | 2 | 3, id: ObjectId, mode = 0o100644): ResolveUndoStage => ({
  stage: n,
  mode,
  id,
});
const NUL_MODES = (...modes: ReadonlyArray<string>): string =>
  `${modes.map((mode) => bytesToHex(text(mode))).join('00')}00`;

describe('Given a record with the stages of a resolved path', () => {
  describe.each([
    {
      label: 'all three stages',
      stages: [stage(1, BASE), stage(2, OURS), stage(3, THEIRS)],
      modes: ['100644', '100644', '100644'],
      ids: [BASE, OURS, THEIRS],
    },
    {
      label: 'no theirs stage',
      stages: [stage(1, BASE), stage(2, OURS)],
      modes: ['100644', '100644', '0'],
      ids: [BASE, OURS],
    },
    {
      label: 'no ours stage',
      stages: [stage(1, BASE), stage(3, THEIRS)],
      modes: ['100644', '0', '100644'],
      ids: [BASE, THEIRS],
    },
    {
      label: 'no base stage',
      stages: [stage(2, OURS), stage(3, THEIRS)],
      modes: ['0', '100644', '100644'],
      ids: [OURS, THEIRS],
    },
    {
      label: 'only the theirs stage',
      stages: [stage(3, THEIRS)],
      modes: ['0', '0', '100644'],
      ids: [THEIRS],
    },
  ])('When serialized with $label', ({ stages, modes, ids }) => {
    it('Then it is the path, three octal modes and the present ids', () => {
      // Arrange
      const records = [{ path: F, stages }];
      const expected = `66${'00'}${NUL_MODES(...modes)}${ids.map((id) => id).join('')}`;

      // Act
      const result = serializeResolveUndo(records);

      // Assert
      expect(bytesToHex(result)).toBe(expected);
    });
  });
});

describe('Given a record whose path is not UTF-8', () => {
  describe('When serialized', () => {
    it('Then its raw bytes are written', () => {
      // Arrange
      const pathBytes = Uint8Array.from([0x61, 0xff]);
      const records = [{ path: 'a\ufffd' as FilePath, pathBytes, stages: [stage(1, BASE)] }];

      // Act
      const result = serializeResolveUndo(records);

      // Assert
      expect(bytesToHex(result.subarray(0, 3))).toBe('61ff00');
    });
  });
});

describe('Given two records', () => {
  describe('When serialized', () => {
    it('Then they are written in the given order, unsorted', () => {
      // Arrange
      const records = [
        { path: 'b' as FilePath, stages: [stage(1, BASE)] },
        { path: 'a' as FilePath, stages: [stage(1, OURS)] },
      ];

      // Act
      const result = serializeResolveUndo(records);

      // Assert
      expect(parseResolveUndo(result, DIGEST)?.map((r) => r.path)).toEqual(['b', 'a']);
    });
  });
});

const rec = (path: string, ...stages: ReadonlyArray<ResolveUndoStage>): ResolveUndoRecord => ({
  path: path as FilePath,
  stages,
});

describe('Given recorded resolve-undo records', () => {
  describe('When none was recorded before', () => {
    it('Then the resolved records are returned sorted by path', () => {
      // Arrange
      const resolved = [rec('h', stage(1, BASE)), rec('f', stage(2, OURS))];

      // Act
      const result = recordResolveUndo([], resolved);

      // Assert
      expect(result).toEqual([rec('f', stage(2, OURS)), rec('h', stage(1, BASE))]);
    });
  });

  describe('When a path sorts before and another after an existing one', () => {
    it('Then each is inserted at its sorted place and the existing one is kept', () => {
      // Arrange
      const existing = [rec('g', stage(1, BASE))];
      const resolved = [rec('h', stage(2, OURS)), rec('f', stage(3, THEIRS))];

      // Act
      const result = recordResolveUndo(existing, resolved);

      // Assert
      expect(result).toEqual([
        rec('f', stage(3, THEIRS)),
        rec('g', stage(1, BASE)),
        rec('h', stage(2, OURS)),
      ]);
    });
  });

  describe('When a record concerns a path already recorded with other stages', () => {
    it('Then the resolved stages replace theirs and a stale stage is kept', () => {
      // Arrange
      const existing = [rec('f', stage(2, OURS), stage(3, THEIRS))];
      const resolved = [rec('f', stage(1, BASE), stage(2, THEIRS))];

      // Act
      const result = recordResolveUndo(existing, resolved);

      // Assert
      expect(result).toEqual([rec('f', stage(1, BASE), stage(2, THEIRS), stage(3, THEIRS))]);
    });
  });

  describe('When a lossy path and its escaped twin are recorded', () => {
    it('Then they are separate keys', () => {
      // Arrange
      const lossy = { ...rec('a\ufffd', stage(1, BASE)), pathBytes: Uint8Array.of(0x61, 0xff) };
      const plain = rec('a\ufffd', stage(1, OURS));

      // Act
      const result = recordResolveUndo([lossy], [plain]);

      // Assert
      expect(result).toHaveLength(2);
    });
  });
});

const unmerged = (n: 1 | 2 | 3, id: ObjectId, mode: FileMode = FILE_MODE.REGULAR): IndexEntry => ({
  ctimeSeconds: 0,
  ctimeNanoseconds: 0,
  mtimeSeconds: 0,
  mtimeNanoseconds: 0,
  dev: 0,
  ino: 0,
  mode,
  uid: 0,
  gid: 0,
  fileSize: 0,
  id,
  flags: { assumeValid: false, stage: n, skipWorktree: false, intentToAdd: false },
  path: F,
});

describe('Given the unmerged stages of a path', () => {
  describe('When a record is built from a symlink stage', () => {
    it('Then the stage carries the symlink mode as a number', () => {
      // Arrange
      const stages = [unmerged(2, OURS, FILE_MODE.SYMLINK)];

      // Act
      const result = resolveUndoRecordOf(stages);

      // Assert
      expect(result).toEqual(rec('f', stage(2, OURS, 0o120000)));
    });
  });

  describe('When a record is built from stages 1 and 3', () => {
    it('Then it holds those two stages', () => {
      // Arrange
      const stages = [unmerged(1, BASE), unmerged(3, THEIRS)];

      // Act
      const result = resolveUndoRecordOf(stages);

      // Assert
      expect(result.stages).toEqual([stage(1, BASE), stage(3, THEIRS)]);
    });
  });

  describe('When the first stage has a non-UTF-8 path', () => {
    it('Then the record keeps the raw bytes', () => {
      // Arrange
      const pathBytes = Uint8Array.of(0x61, 0xff);
      const stages = [{ ...unmerged(1, BASE), pathBytes }];

      // Act
      const result = resolveUndoRecordOf(stages);

      // Assert
      expect(result.pathBytes).toEqual(pathBytes);
    });
  });

  describe('When the first stage has a UTF-8 path', () => {
    it('Then the record carries no pathBytes key', () => {
      // Arrange
      const stages = [unmerged(1, BASE)];

      // Act
      const result = resolveUndoRecordOf(stages);

      // Assert
      expect('pathBytes' in result).toBe(false);
    });
  });
});
