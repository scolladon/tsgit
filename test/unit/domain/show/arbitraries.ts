import fc from 'fast-check';

/** A git identity timestamp: integer seconds, including pre-epoch. */
export const arbTimestamp = (): fc.Arbitrary<number> =>
  fc.integer({ min: -2_000_000_000, max: 2_000_000_000 });

/** A `±HHMM` timezone offset string (the `parseIdentity`-validated shape). */
export const arbTimezoneOffset = (): fc.Arbitrary<string> =>
  fc
    .record({
      sign: fc.constantFrom('+', '-'),
      hours: fc.integer({ min: 0, max: 23 }),
      minutes: fc.integer({ min: 0, max: 59 }),
    })
    .map(
      ({ sign, hours, minutes }) =>
        `${sign}${String(hours).padStart(2, '0')}${String(minutes).padStart(2, '0')}`,
    );
