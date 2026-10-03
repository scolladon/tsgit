import { describe, expect, it } from 'vitest';
import {
  type BloomFilterSettings,
  bloomKeyHashes,
  changedPathFilter,
  DEFAULT_BLOOM_FILTER_SETTINGS,
  murmur3Seeded,
} from '../../../../src/domain/commit/bloom-filter.js';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const SEVEN_HIGH_BIT_BYTES = Uint8Array.of(0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff);
const V2_SETTINGS: BloomFilterSettings = { ...DEFAULT_BLOOM_FILTER_SETTINGS, hashVersion: 2 };
const hex = (data: Uint8Array): string => Buffer.from(data).toString('hex');

describe('murmur3Seeded', () => {
  describe.each([
    { label: 'the empty string', data: bytes(''), expected: 0x00000000 },
    { label: 'a 12-byte string', data: bytes('Hello world!'), expected: 0x627b0c2c },
    {
      label: 'a string with a 3-byte tail',
      data: bytes('The quick brown fox jumps over the lazy dog'),
      expected: 0x2e4ff723,
    },
    { label: 'seven high-bit bytes', data: SEVEN_HIGH_BIT_BYTES, expected: 0xa183ccfd },
  ])('Given $label under hash version 2 and seed 0', ({ data, expected }) => {
    describe('When hashed', () => {
      it('Then it matches git t0095', () => {
        // Arrange
        const sut = murmur3Seeded;

        // Act
        const result = sut(0, data, 2);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });

  describe('Given seven high-bit bytes under hash version 1', () => {
    describe('When hashed', () => {
      it("Then it reads each byte as git's signed char", () => {
        // Arrange
        const sut = murmur3Seeded;

        // Act
        const result = sut(0, SEVEN_HIGH_BIT_BYTES, 1);

        // Assert
        expect(result).toBe(0xdd92776e);
      });
    });
  });

  describe.each([
    { length: 1, v1: 0xc09f0b3e },
    { length: 2, v1: 0x75e4cebf },
  ])('Given a $length-byte high-bit tail under hash version 1', ({ length, v1 }) => {
    describe('When hashed with seed 0', () => {
      it('Then the tail bytes are sign-extended too', () => {
        // Arrange
        const sut = murmur3Seeded;

        // Act
        const result = sut(0, SEVEN_HIGH_BIT_BYTES.subarray(0, length), 1);

        // Assert
        expect(result).toBe(v1);
      });
    });
  });
});

describe('bloomKeyHashes', () => {
  describe('Given a path under the default settings', () => {
    describe('When its key is filled', () => {
      it('Then the hashes step by the second seed hash, as git t0095 pins', () => {
        // Arrange
        const sut = bloomKeyHashes;

        // Act
        const result = sut(bytes('file.txt'), DEFAULT_BLOOM_FILTER_SETTINGS);

        // Assert
        expect(result).toEqual([
          0x20ab385b, 0xf5237fe2, 0xc99bc769, 0x9e140ef0, 0x728c5677, 0x47049dfe, 0x1b7ce585,
        ]);
      });
    });
  });

  describe('Given a high-bit path', () => {
    describe('When its key is filled under each hash version', () => {
      it('Then version 1 and version 2 disagree', () => {
        // Arrange
        const sut = bloomKeyHashes;
        const path = bytes('été');

        // Act
        const result = [sut(path, DEFAULT_BLOOM_FILTER_SETTINGS)[0], sut(path, V2_SETTINGS)[0]];

        // Assert
        expect(result).toEqual([0x386209cd, 0x274724fb]);
      });
    });
  });
});

describe('changedPathFilter', () => {
  describe('Given no changed path', () => {
    describe('When the filter is built', () => {
      it('Then it is the one zero byte git writes for an empty commit', () => {
        // Arrange
        const sut = changedPathFilter;

        // Act
        const result = sut([], DEFAULT_BLOOM_FILTER_SETTINGS);

        // Assert
        expect(hex(result)).toBe('00');
      });
    });
  });

  describe('Given ten files added under one directory', () => {
    describe('When the filter is built', () => {
      it('Then it counts the directory too and matches git t0095', () => {
        // Arrange
        const sut = changedPathFilter;
        const paths = Array.from({ length: 10 }, (_, i) => bytes(`smallDir/${i}`));

        // Act
        const result = sut(paths, DEFAULT_BLOOM_FILTER_SETTINGS);

        // Assert
        expect(hex(result)).toBe('02b3c4a034e7feebcb47fea0e872');
      });
    });
  });

  describe('Given nested paths sharing their leading directories', () => {
    describe('When the filter is built', () => {
      it('Then each leading directory is added once', () => {
        // Arrange
        const sut = changedPathFilter;
        const explicit = sut(
          [bytes('d'), bytes('d/e'), bytes('d/e/f'), bytes('d/e/g')],
          V2_SETTINGS,
        );

        // Act
        const result = sut([bytes('d/e/f'), bytes('d/e/g')], V2_SETTINGS);

        // Assert
        expect(result).toEqual(explicit);
        expect(result).toHaveLength(5);
      });
    });
  });

  describe.each([
    { label: 'exactly the maximum', files: 511, expectedLength: 640 },
    { label: 'one past the maximum', files: 512, expectedLength: 1 },
  ])('Given distinct paths, directory included, numbering $label', ({ files, expectedLength }) => {
    describe('When the filter is built', () => {
      it(`Then it is ${expectedLength} byte(s) long`, () => {
        // Arrange
        const sut = changedPathFilter;
        const paths = Array.from({ length: files }, (_, i) => bytes(`bigDir/${i}`));

        // Act
        const result = sut(paths, DEFAULT_BLOOM_FILTER_SETTINGS);

        // Assert
        expect(result).toHaveLength(expectedLength);
      });
    });
  });

  describe('Given more distinct paths than the maximum', () => {
    describe('When the filter is built', () => {
      it("Then it is git's single 0xFF too-large marker", () => {
        // Arrange
        const sut = changedPathFilter;
        const paths = Array.from({ length: 513 }, (_, i) => bytes(`${i}`));

        // Act
        const result = sut(paths, DEFAULT_BLOOM_FILTER_SETTINGS);

        // Assert
        expect(hex(result)).toBe('ff');
      });
    });
  });
});
