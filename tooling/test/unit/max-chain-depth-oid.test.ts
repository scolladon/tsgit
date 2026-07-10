import { describe, expect, it } from 'vitest';

import { maxChainDepthOid } from '../../../test/bench/support/fixture-generator.ts';

describe('maxChainDepthOid', () => {
  describe('Given a verify-pack -v output with deltified and non-blob lines interleaved', () => {
    describe('When maxChainDepthOid runs', () => {
      it('Then it returns the oid with the maximum chain-depth column', () => {
        // Arrange
        const output = [
          'aaaa0000000000000000000000000000000000 commit 200 130 0',
          'bbbb0000000000000000000000000000000000 blob   4096 512 12345',
          'cccc0000000000000000000000000000000000 blob   4096 300 12857 1 bbbb0000000000000000000000000000000000',
          'dddd0000000000000000000000000000000000 blob   4096 300 13157 40 cccc0000000000000000000000000000000000',
          'eeee0000000000000000000000000000000000 blob   4096 300 13457 43 dddd0000000000000000000000000000000000',
          'ffff0000000000000000000000000000000000 blob   4096 300 13757 42 eeee0000000000000000000000000000000000',
          'chain length = 1: 1 object',
          'non delta: 1 object',
        ].join('\n');

        // Act
        const result = maxChainDepthOid(output);

        // Assert
        expect(result).toBe('eeee0000000000000000000000000000000000');
      });
    });
  });

  describe('Given a verify-pack -v output where the deepest line is not the last one', () => {
    describe('When maxChainDepthOid runs', () => {
      it('Then it still returns the deepest oid, proving it scans every line', () => {
        // Arrange
        const output = [
          'aaaa0000000000000000000000000000000000 blob   4096 512 12345',
          'bbbb0000000000000000000000000000000000 blob   4096 300 12857 43 aaaa0000000000000000000000000000000000',
          'cccc0000000000000000000000000000000000 blob   4096 300 13157 5 bbbb0000000000000000000000000000000000',
          'dddd0000000000000000000000000000000000 blob   4096 300 13457 2 cccc0000000000000000000000000000000000',
        ].join('\n');

        // Act
        const result = maxChainDepthOid(output);

        // Assert
        expect(result).toBe('bbbb0000000000000000000000000000000000');
      });
    });
  });

  describe('Given two deltified blob lines tied at the maximum chain depth', () => {
    describe('When maxChainDepthOid runs', () => {
      it('Then it deterministically returns the first-encountered oid', () => {
        // Arrange
        const output = [
          'aaaa0000000000000000000000000000000000 blob   4096 512 12345',
          'bbbb0000000000000000000000000000000000 blob   4096 300 12857 43 aaaa0000000000000000000000000000000000',
          'cccc0000000000000000000000000000000000 blob   4096 300 13157 43 bbbb0000000000000000000000000000000000',
        ].join('\n');

        // Act
        const result = maxChainDepthOid(output);

        // Assert
        expect(result).toBe('bbbb0000000000000000000000000000000000');
      });
    });
  });

  describe('Given a verify-pack -v output with only base blob lines (no deltified lines)', () => {
    describe('When maxChainDepthOid runs', () => {
      it('Then it throws, because base lines carry no chain-depth column to rank', () => {
        // Arrange — five-token base blob lines only: no chain-depth column, so the
        // length guard must exclude every one and leave no candidate. A guard that
        // admitted them would rank Number(undefined)=NaN and return the last oid.
        const output = [
          'aaaa0000000000000000000000000000000000 blob   4096 512 12345',
          'bbbb0000000000000000000000000000000000 blob   4096 600 16441',
        ].join('\n');

        // Act / Assert
        expect(() => maxChainDepthOid(output)).toThrow(
          'verify-pack output has no deltified blob lines',
        );
      });
    });
  });
});
