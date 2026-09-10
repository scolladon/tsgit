import { describe, expect, it } from 'vitest';

import {
  type CorpusRow,
  computeSizeRatio,
  formatRatio,
  type PackMeasurement,
  parseVerifyPackReadout,
  renderCorpusReport,
  renderHistogram,
  renderTypeReadout,
  type TypeReadout,
} from '../../pack-size-compare.js';

// A recorded `git verify-pack -v` sample, trimmed from a real 2.55.0 run over
// a single-blob evolving-content repo: one commit line (must be ignored),
// two blob base lines, three tree base lines, and a five-deep blob delta
// chain (each row deltas against the previous), followed by the trailer git
// prints (`non delta:`, the `chain length =` histogram, the final `: ok`).
const SAMPLE_VERIFY_PACK_OUTPUT = [
  'd09f687cd68cb7d11ad2e16dc3fafc4a9e17f722 commit 176 131 12',
  'a324b7b805b9d5e838aee9a2286bacd98407e415 blob   8192 4731 7986',
  'bc02e27754287b63b53dacbd4ae7ee13a4e23441 blob   4096 4110 12717',
  'd256b31454c914207225a7958d1c0d0cb65ec5b8 tree   67 75 16827',
  '7c956fd54eb94d2a3c193bbcd7173adfe8700bc5 tree   67 75 16902',
  '084127c9362bf7b31b16c6de8368fb3bd768010b tree   67 75 17069',
  'a314815efa3dd3c050fb95d908df64d9502bbd4f blob   77 92 16977 1 bc02e27754287b63b53dacbd4ae7ee13a4e23441',
  '79adb699710578b76fa607a935fd827b69a7262f blob   76 91 17144 2 a314815efa3dd3c050fb95d908df64d9502bbd4f',
  '4dd3052ede0ef4add589c62d569a35ff01fc201d blob   77 92 17310 3 79adb699710578b76fa607a935fd827b69a7262f',
  '6e3e12d55896cad5d12eaa7679b1570080ec2ac2 blob   77 92 17477 4 4dd3052ede0ef4add589c62d569a35ff01fc201d',
  '5455dac927143770462c8c92edc40e62a96f3aae blob   77 92 17644 5 6e3e12d55896cad5d12eaa7679b1570080ec2ac2',
  'non delta: 13 objects',
  'chain length = 1: 1 objects',
  'chain length = 2: 1 objects',
  'chain length = 3: 1 objects',
  'chain length = 4: 1 objects',
  'chain length = 5: 1 objects',
  '/tmp/example/.git/objects/pack/pack-abc123.pack: ok',
].join('\n');

describe('parseVerifyPackReadout', () => {
  describe('Given a recorded verify-pack sample with commit, tree and chained blob delta lines', () => {
    describe('When the driver parses the readout', () => {
      it('Then blob and tree lines are counted into separate base/delta partitions', () => {
        // Arrange
        const sut = parseVerifyPackReadout;

        // Act
        const result = sut(SAMPLE_VERIFY_PACK_OUTPUT);

        // Assert
        expect(result.blob.baseCount).toBe(2);
        expect(result.blob.deltaCount).toBe(5);
        expect(result.tree.baseCount).toBe(3);
        expect(result.tree.deltaCount).toBe(0);
      });

      it('Then the blob histogram records one object at each depth 1 through 5', () => {
        // Arrange
        const sut = parseVerifyPackReadout;

        // Act
        const result = sut(SAMPLE_VERIFY_PACK_OUTPUT);

        // Assert
        expect([...result.blob.histogram.entries()].sort(([a], [b]) => a - b)).toEqual([
          [1, 1],
          [2, 1],
          [3, 1],
          [4, 1],
          [5, 1],
        ]);
      });
    });
  });

  describe('Given blob deltas chain deeper than any tree object in the sample', () => {
    describe('When the driver parses the readout', () => {
      it('Then blob and tree max depth disagree, proving the two readouts are not merged', () => {
        // Arrange
        const sut = parseVerifyPackReadout;

        // Act
        const result = sut(SAMPLE_VERIFY_PACK_OUTPUT);

        // Assert
        expect(result.blob.maxDepth).toBe(5);
        expect(result.tree.maxDepth).toBe(0);
        expect(result.blob.maxDepth).not.toBe(result.tree.maxDepth);
      });
    });
  });

  describe('Given a commit line mixed into the sample', () => {
    describe('When the driver parses the readout', () => {
      it('Then the commit line contributes to neither the blob nor the tree partition', () => {
        // Arrange
        const sut = parseVerifyPackReadout;

        // Act
        const result = sut(SAMPLE_VERIFY_PACK_OUTPUT);

        // Assert — 2 blob base + 5 blob delta + 3 tree base = 10 tracked
        // lines; a commit line counted in either partition would inflate this.
        const totalTracked =
          result.blob.baseCount +
          result.blob.deltaCount +
          result.tree.baseCount +
          result.tree.deltaCount;
        expect(totalTracked).toBe(10);
      });
    });
  });
});

describe('computeSizeRatio', () => {
  describe('Given ours and peer report the same object count', () => {
    describe('When the driver computes the size ratio', () => {
      it('Then it returns oursBytes divided by peerBytes', () => {
        // Arrange
        const sut = computeSizeRatio;

        // Act
        const result = sut({
          oursBytes: 50,
          peerBytes: 200,
          oursObjectCount: 10,
          peerObjectCount: 10,
        });

        // Assert
        expect(result).toBe(0.25);
      });
    });
  });

  describe('Given ours and peer report different object counts', () => {
    describe('When the driver computes the size ratio', () => {
      it('Then it throws, naming both counts, instead of returning a ratio', () => {
        // Arrange
        const sut = computeSizeRatio;

        // Act
        let caught: unknown;
        try {
          sut({ oursBytes: 50, peerBytes: 200, oursObjectCount: 11, peerObjectCount: 10 });
        } catch (error) {
          caught = error;
        }

        // Assert
        expect(caught).toBeInstanceOf(Error);
        expect((caught as Error).message).toContain('11');
        expect((caught as Error).message).toContain('10');
      });
    });
  });
});

describe('formatRatio', () => {
  describe('Given a ratio value', () => {
    describe('When the driver formats it', () => {
      it('Then it renders a × prefix with two decimal places', () => {
        // Arrange
        const sut = formatRatio;

        // Act
        const result = sut(5.4321);

        // Assert
        expect(result).toBe('×5.43');
      });
    });
  });
});

describe('renderHistogram', () => {
  describe('Given a histogram with entries recorded out of depth order', () => {
    describe('When the driver renders it', () => {
      it('Then entries print sorted by depth ascending', () => {
        // Arrange
        const sut = renderHistogram;
        const histogram = new Map([
          [3, 1],
          [1, 2],
        ]);

        // Act
        const result = sut(histogram);

        // Assert
        expect(result).toBe('1:2, 3:1');
      });
    });
  });
});

describe('renderTypeReadout', () => {
  describe('Given a type readout with base, delta counts and a histogram', () => {
    describe('When the driver renders it', () => {
      it('Then the summary carries base, delta, maxDepth and the histogram', () => {
        // Arrange
        const sut = renderTypeReadout;
        const readout: TypeReadout = {
          baseCount: 2,
          deltaCount: 5,
          histogram: new Map([
            [1, 1],
            [5, 1],
          ]),
          maxDepth: 5,
        };

        // Act
        const result = sut(readout);

        // Assert
        expect(result).toBe('base=2 delta=5 maxDepth=5 histogram={1:1, 5:1}');
      });
    });
  });
});

const emptyReadout = (): TypeReadout => ({
  baseCount: 0,
  deltaCount: 0,
  histogram: new Map(),
  maxDepth: 0,
});

const buildMeasurement = (bytes: number, objectCount: number): PackMeasurement => ({
  bytes,
  objectCount,
  readout: { blob: emptyReadout(), tree: emptyReadout() },
});

describe('renderCorpusReport', () => {
  describe('Given ours and peer measurements with matching object counts', () => {
    describe('When the driver renders the corpus report', () => {
      it('Then the report names the corpus, the git version and the ratio', () => {
        // Arrange
        const sut = renderCorpusReport;
        const row: CorpusRow = {
          corpus: 'MEDIUM',
          gitVersion: 'git version 2.55.0',
          ours: buildMeasurement(50, 10),
          peer: buildMeasurement(200, 10),
        };

        // Act
        const result = sut(row);

        // Assert
        expect(result).toContain('MEDIUM');
        expect(result).toContain('git version 2.55.0');
        expect(result).toContain('×0.25');
      });
    });
  });

  describe('Given ours and peer measurements with mismatched object counts', () => {
    describe('When the driver renders the corpus report', () => {
      it('Then it throws rather than reporting a ratio over incomparable packs', () => {
        // Arrange
        const sut = renderCorpusReport;
        const row: CorpusRow = {
          corpus: 'MEDIUM',
          gitVersion: 'git version 2.55.0',
          ours: buildMeasurement(50, 11),
          peer: buildMeasurement(200, 10),
        };

        // Act
        let caught: unknown;
        try {
          sut(row);
        } catch (error) {
          caught = error;
        }

        // Assert
        expect(caught).toBeInstanceOf(Error);
        expect((caught as Error).message).toContain('11');
      });
    });
  });
});
