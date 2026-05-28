import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type IniSection,
  parseIniSections,
} from '../../../../src/application/primitives/config-read.js';
import { setConfigEntryInText } from '../../../../src/application/primitives/update-config.js';

// Inline value unquoter for property round-trips. The production unquoter lives
// at the porcelain reader layer (slice 7 — `getConfigValue`); this test helper
// stays scoped to the property file to avoid leaking a half-public surface.
// Mirrors canonical-git's quoted-value semantics for the writer's grammar.
const unquoteValue = (raw: string): string => {
  if (raw.length < 2 || !raw.startsWith('"') || !raw.endsWith('"')) return raw;
  const body = raw.slice(1, -1);
  const out: string[] = [];
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch !== '\\') {
      out.push(ch as string);
      continue;
    }
    const next = body[i + 1];
    if (next === 'n') out.push('\n');
    else if (next === 't') out.push('\t');
    else if (next === '"') out.push('"');
    else if (next === '\\') out.push('\\');
    else out.push(next as string);
    i += 1;
  }
  return out.join('');
};

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
      it('Then the unquoted parsed value equals the original input', () => {
        // Arrange + Act + Assert — round-trip is `write → parse → unquote`.
        fc.assert(
          fc.property(arbSafeValue(), (value) => {
            const text = setConfigEntryInText('', 'user', undefined, 'name', value);
            const parsed = parseIniSections(text);
            const rawValue = findValue(parsed, 'user', 'name');
            expect(rawValue).toBeDefined();
            expect(unquoteValue(rawValue as string)).toBe(value);
          }),
          { numRuns: 200 },
        );
      });
    });
  });
});
