import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type IniSection,
  parseIniSections,
} from '../../../../src/application/primitives/config-read.js';
import { setConfigEntryInText } from '../../../../src/application/primitives/update-config.js';

const findValue = (
  sections: ReadonlyArray<IniSection>,
  section: string,
  key: string,
): string | undefined => {
  for (const sec of sections) {
    if (sec.section.toLowerCase() !== section) continue;
    for (const entry of sec.entries) {
      if (entry.key.toLowerCase() === key) return entry.value;
    }
  }
  return undefined;
};

// Values inside the `assertValueSafe`-survivable subset (CLAUDE.md): ASCII
// printable + `\t` + `\n`, excluding NUL/CR and other control chars. Length
// is capped at 1024 to keep numRuns budget honest.
const arbSafeValue = (): fc.Arbitrary<string> =>
  fc.string({ maxLength: 1024 }).map((s) => s.replace(/[^\x20-\x7e\t\n]/g, ''));

describe('update-config writer properties', () => {
  describe('Given an arbitrary value in the assertValueSafe-survivable subset', () => {
    describe('When the value is rendered into config text and re-parsed via parseIniSections', () => {
      it('Then the parsed value equals the original input', () => {
        // Arrange + Act + Assert — round-trip is `write → parse`; the parser
        // decodes git's quoted-value grammar itself.
        fc.assert(
          fc.property(arbSafeValue(), (value) => {
            const text = setConfigEntryInText('', 'user', undefined, 'name', value);
            const parsed = parseIniSections(text);
            const rawValue = findValue(parsed, 'user', 'name');
            expect(rawValue).toBe(value);
          }),
          { numRuns: 200 },
        );
      });
    });
  });
});
