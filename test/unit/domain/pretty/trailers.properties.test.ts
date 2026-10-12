import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DEFAULT_TRAILER_OPTIONS, formatTrailers } from '../../../../src/domain/pretty/trailers.js';

const NUM_RUNS = 200;

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

const subjectArb = fc.stringMatching(/^[A-Za-z][A-Za-z ]{0,20}$/);
const bodyArb = fc.option(fc.stringMatching(/^[A-Za-z][A-Za-z .]{0,30}$/), { nil: undefined });
const keyArb = fc.stringMatching(/^[A-Za-z][A-Za-z0-9-]{0,10}$/);
const valueArb = fc.stringMatching(/^[A-Za-z0-9]([A-Za-z0-9 ]{0,12}[A-Za-z0-9])?$/);
const trailersArb = fc.array(fc.tuple(keyArb, valueArb), { minLength: 1, maxLength: 6 });

describe('Given a message ending in generated trailers, When formatting with only', () => {
  it('Then every trailer comes back, one per line, in order', () => {
    fc.assert(
      fc.property(subjectArb, bodyArb, trailersArb, (subject, body, trailers) => {
        // Arrange
        const lines = trailers.map(([key, value]) => `${key}: ${value}\n`);
        const paragraphs = [subject, ...(body === undefined ? [] : [body]), lines.join('')];
        const message = encode(paragraphs.join('\n\n'));
        const sut = formatTrailers;

        // Act
        const result = sut(message, { ...DEFAULT_TRAILER_OPTIONS, onlyTrailers: true });

        // Assert
        expect(decode(result)).toBe(lines.join(''));
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
