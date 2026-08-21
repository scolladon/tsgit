/**
 * Lens-1 round-trip property for the bundle header codec.
 *
 * Property: parseBundleHeader(serializeBundleHeader(h), 'x.bundle') ≡ h
 * modulo prerequisite oid-sort canonicalisation (the serializer sorts
 * prerequisites ascending by oid; the parser returns them in that order).
 * The (version, algorithm) pair is drawn from the legal set — v2 admits
 * only sha1, v3 admits either — which is what catches a v3 emitter that
 * forgets the `@object-format` capability on the sha1 branch: an example
 * test would have to be written to suspect that bug, but a wide sweep of
 * legal pairs finds it for free.
 *
 * Count invariant: number of `-` lines in the output equals prerequisites.length.
 *
 * numRuns: 200 (cheap round-trip property).
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { parseBundleHeader } from '../../../../src/domain/bundle/parse-bundle-header.js';
import { serializeBundleHeader } from '../../../../src/domain/bundle/serialize-bundle-header.js';
import { arbBundleHeaderInputs } from './arbitraries.js';

describe('Given an arbitrary well-formed bundle header', () => {
  describe('When parseBundleHeader(serializeBundleHeader(h))', () => {
    it('Then returns the header with prerequisites oid-sorted and refs in input order', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(arbBundleHeaderInputs(), (h) => {
          const sut = parseBundleHeader;

          // Act
          const bytes = serializeBundleHeader(h);
          const result = sut(bytes, 'x.bundle');

          // Assert: version and algorithm
          expect(result.version).toBe(h.version);
          expect(result.hashAlgorithm).toBe(h.hashAlgorithm);

          // Assert: refs preserved in input order
          expect(result.refs).toEqual(h.refs);

          // Assert: prerequisites are oid-sorted ascending
          const sortedPrereqs = [...h.prerequisites].sort((a, b) => a.oid.localeCompare(b.oid));
          expect(result.prerequisites).toEqual(sortedPrereqs);

          // Assert: packOffset is at the end of the bytes (no pack appended)
          expect(result.packOffset).toBe(bytes.length);
        }),
        { numRuns: 200 },
      );
    });
  });

  describe('When serializing a header with prerequisites', () => {
    it('Then the count of dash-prefixed lines equals prerequisites.length', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(arbBundleHeaderInputs(), (h) => {
          // Act
          const bytes = serializeBundleHeader(h);
          const text = new TextDecoder().decode(bytes);
          const lines = text.split('\n');

          // Assert: count invariant
          const dashLines = lines.filter((line) => line.startsWith('-'));
          expect(dashLines.length).toBe(h.prerequisites.length);
        }),
        { numRuns: 200 },
      );
    });
  });
});
