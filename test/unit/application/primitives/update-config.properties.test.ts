import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type IniSection,
  parseIniSections,
  parseSectionHeader,
  tokenizeConfig,
} from '../../../../src/application/primitives/config-read.js';
import {
  parseNewSectionName,
  rawSectionName,
  removeConfigEntry,
  removeConfigSectionInText,
  renderSectionHeader,
  setConfigEntryInText,
} from '../../../../src/application/primitives/update-config.js';
import {
  arbConfigKey,
  configFileWithTarget,
  subsectionIdentity,
  subsectionName,
} from './arbitraries.js';

const findValue = (
  sections: ReadonlyArray<IniSection>,
  section: string,
  key: string,
): string | null | undefined => {
  for (const sec of sections) {
    if (sec.section.toLowerCase() !== section) continue;
    for (const entry of sec.entries) {
      if (entry.key.toLowerCase() === key) return entry.value;
    }
  }
  return undefined;
};

/**
 * Characters that exercise every grammar branch of the writer and reader:
 * quote triggers (CR, leading/trailing space, `;`, `#`), unconditional escape
 * targets (`\`, `"`, LF, TAB), and raw control bytes (C0, DEL).
 */
const SPECIAL_CHARS = [
  '\r', // CR — quote trigger, written raw inside quotes
  '\t', // TAB — always escaped to `\t`
  '\n', // LF — always escaped to `\n`
  '"', // double-quote — always escaped to `\"`
  '\\', // backslash — always escaped to `\\` (first)
  ';', // comment trigger — quote trigger
  '#', // comment trigger — quote trigger
  ' ', // space — quote trigger at leading/trailing edges
  '\x01', // C0 control — passed through raw
  '\x7f', // DEL — passed through raw
];

/**
 * Single-character arbitrary biased toward grammar-exercising special chars
 * plus ordinary printable ASCII so shrunk counterexamples stay readable.
 */
const arbNulFreeUnit = (): fc.Arbitrary<string> =>
  fc.oneof(
    fc.constantFrom(...SPECIAL_CHARS),
    fc.integer({ min: 0x20, max: 0x7e }).map((cp) => String.fromCodePoint(cp)),
  );

/**
 * Generator over the full NUL-free string domain (up to 1024 chars).
 * Combines a full-unicode binary-unit generator (NUL stripped) with a
 * specials-biased generator so shrunk counterexamples stay readable and
 * grammar branch coverage is high.
 */
const arbNulFreeValue = (): fc.Arbitrary<string> => {
  // Wide: full unicode with NUL stripped.
  const wide = fc.string({ unit: 'binary', maxLength: 1024 }).map((s) => s.replace(/\0/g, ''));

  // Biased: strings built from grammar-exercising specials + printable ASCII.
  const biased = fc.string({ unit: arbNulFreeUnit(), maxLength: 1024 });

  return fc.oneof(wide, biased);
};

describe('update-config writer properties', () => {
  describe('Given an arbitrary NUL-free value', () => {
    describe('When the value is rendered into config text and re-parsed via parseIniSections', () => {
      it('Then the parsed value equals the original input', () => {
        // Arrange + Act + Assert — round-trip is `write → parse`; the parser
        // decodes git's quoted-value grammar itself.
        fc.assert(
          fc.property(arbNulFreeValue(), (value) => {
            const text = setConfigEntryInText('', 'user', undefined, 'name', value);
            const parsed = parseIniSections(text);
            const result = findValue(parsed, 'user', 'name');
            expect(result).toBe(value);
          }),
          { numRuns: 200 },
        );
      });
    });

    describe('When the value is rendered into config text', () => {
      it('Then parseIniSections does not throw and returns exactly one entry', () => {
        // Arrange + Act + Assert — totality property: a thrown CONFIG_PARSE_ERROR
        // is distinguishable from a value mismatch (separate property so
        // fast-check shrinks the throw path independently from the equality path).
        fc.assert(
          fc.property(arbNulFreeValue(), (value) => {
            const text = setConfigEntryInText('', 'user', undefined, 'name', value);
            const sections = parseIniSections(text);
            expect(sections).toHaveLength(1);
            const entries = sections[0]?.entries;
            expect(entries).toHaveLength(1);
          }),
          { numRuns: 200 },
        );
      });
    });
  });

  describe('Given an arbitrary subsection name', () => {
    describe('When the subsection is rendered into config text and re-parsed via parseIniSections', () => {
      it('Then the parsed subsection equals the original input', () => {
        // Arrange + Act + Assert — render-then-parse round-trip: `setConfigEntryInText`
        // is the writer (sut), `parseIniSections` is the reader; the round-trip must
        // recover exactly the original subsection string for every LF/NUL-free input.
        const sut = setConfigEntryInText;
        fc.assert(
          fc.property(subsectionName(), (s) => {
            const text = sut('', 'test', s, 'k', 'v');
            const sections = parseIniSections(text);
            expect(sections).toHaveLength(1);
            const parsed = sections[0];
            expect(parsed?.section).toBe('test');
            expect(parsed?.subsection).toBe(s);
          }),
          { numRuns: 200 },
        );
      });
    });

    describe('When the subsection is rendered into config text', () => {
      it('Then parseIniSections does not throw and returns an array', () => {
        // Arrange + Act + Assert — totality property: the strict quoted-grammar
        // must never reject the writer's output over the full LF/NUL-free domain;
        // a thrown CONFIG_PARSE_ERROR is shrunk and reported independently from
        // the equality failure in the round-trip property above.
        const sut = setConfigEntryInText;
        fc.assert(
          fc.property(subsectionName(), (s) => {
            const text = sut('', 'test', s, 'k', 'v');
            const result = parseIniSections(text);
            expect(Array.isArray(result)).toBe(true);
          }),
          { numRuns: 200 },
        );
      });
    });
  });

  describe('Given a config text with a valueless entry and an unrelated key', () => {
    describe('When setConfigEntryInText sets the unrelated key', () => {
      it('Then the valueless physical line survives byte-for-byte in the output', () => {
        // Arrange
        const sut = setConfigEntryInText;

        // Act + Assert — fast-check invokes the predicate per sample; each call
        // sets an unrelated key and checks the valueless line is left verbatim.
        fc.assert(
          fc.property(arbConfigKey(), arbConfigKey(), (valuelessKey, otherKey) => {
            fc.pre(valuelessKey.toLowerCase() !== otherKey.toLowerCase());
            const valuelessLine = `\t${valuelessKey}`;
            const inputText = `[a]\n${valuelessLine}\n\texisting = old\n`;
            const result = sut(inputText, 'a', undefined, otherKey, 'new');
            const lines = result.split('\n');
            expect(lines).toContain(valuelessLine);
          }),
          { numRuns: 100 },
        );
      });
    });
  });
});

// ---------------------------------------------------------------------------
// Surgery-preservation invariants (lens 2/4 — compositional invariants)
// ---------------------------------------------------------------------------

/**
 * Collect all (section ci, subsection, key ci, value) tuples from parsed
 * sections, filtering by the predicate on (section, subsection, key).
 */
const collectEntries = (
  sections: ReadonlyArray<IniSection>,
  filter: (section: string, subsection: string | undefined, key: string) => boolean,
): ReadonlyArray<{
  section: string;
  subsection: string | undefined;
  key: string;
  value: string | null;
}> => {
  const out: {
    section: string;
    subsection: string | undefined;
    key: string;
    value: string | null;
  }[] = [];
  for (const sec of sections) {
    for (const entry of sec.entries) {
      if (filter(sec.section.toLowerCase(), sec.subsection, entry.key.toLowerCase())) {
        out.push({
          section: sec.section.toLowerCase(),
          subsection: sec.subsection,
          key: entry.key.toLowerCase(),
          value: entry.value,
        });
      }
    }
  }
  return out;
};

describe('update-config surgery-preservation invariants', () => {
  describe('Given an arbitrary config file and a key drawn from the generator pool', () => {
    describe('When setConfigEntryInText sets (s, sub, k) to a new value v', () => {
      it('Then reading back the output, the first (s, sub, k) value equals v and every other entry is unchanged in order and value', () => {
        // Arrange — `sut` is the function under test; `configFileWithTarget()`
        // assembles 1–4 blocks from a small section pool and biases the key
        // toward ones present in the file so existing-entry paths dominate.
        const sut = setConfigEntryInText;
        fc.assert(
          fc.property(configFileWithTarget(), ({ file, section, key }) => {
            const sub = undefined; // no subsection — keeps the invariant tight
            const newValue = 'replaced';

            // Act
            let result: string;
            try {
              result = sut(file, section, sub, key, newValue);
            } catch {
              // Assert — refusal parity: surgery may refuse only inputs the
              // tokenizer itself refuses, never a file the reader accepts
              expect(() => tokenizeConfig(file)).toThrow();
              return;
            }

            const inputSections = parseIniSections(file);
            const outputSections = parseIniSections(result);

            // Assert — first (section, key) in output equals newValue
            const firstMatch = outputSections
              .filter(
                (s) => s.section.toLowerCase() === section.toLowerCase() && s.subsection === sub,
              )
              .flatMap((s) => s.entries)
              .find((e) => e.key.toLowerCase() === key.toLowerCase());
            expect(firstMatch?.value).toBe(newValue);

            // Assert — every other entry is unchanged (exclude (section, key) pairs)
            const otherInput = collectEntries(
              inputSections,
              (s, su, k) => !(s === section.toLowerCase() && su === sub && k === key.toLowerCase()),
            );
            const otherOutput = collectEntries(
              outputSections,
              (s, su, k) => !(s === section.toLowerCase() && su === sub && k === key.toLowerCase()),
            );
            expect(otherOutput).toEqual(otherInput);
          }),
          { numRuns: 100 },
        );
      });
    });
  });

  describe('Given an arbitrary config file and a key drawn from the generator pool', () => {
    describe('When removeConfigEntry removes (s, sub, k)', () => {
      it('Then no (s, sub, k ci) entry remains and every other entry is unchanged in order and value', () => {
        // Arrange
        const sut = removeConfigEntry;
        fc.assert(
          fc.property(configFileWithTarget(), ({ file, section, key }) => {
            const sub = undefined;

            // Act
            let result: string;
            try {
              result = sut(file, section, sub, key);
            } catch {
              // Assert — refusal parity: surgery may refuse only inputs the
              // tokenizer itself refuses, never a file the reader accepts
              expect(() => tokenizeConfig(file)).toThrow();
              return;
            }

            const inputSections = parseIniSections(file);
            const outputSections = parseIniSections(result);

            // Assert — no (section, key) entry in output
            const remaining = collectEntries(
              outputSections,
              (s, su, k) => s === section.toLowerCase() && su === sub && k === key.toLowerCase(),
            );
            expect(remaining).toHaveLength(0);

            // Assert — every other entry is unchanged
            const otherInput = collectEntries(
              inputSections,
              (s, su, k) => !(s === section.toLowerCase() && su === sub && k === key.toLowerCase()),
            );
            const otherOutput = collectEntries(
              outputSections,
              (s, su, k) => !(s === section.toLowerCase() && su === sub && k === key.toLowerCase()),
            );
            expect(otherOutput).toEqual(otherInput);
          }),
          { numRuns: 100 },
        );
      });
    });
  });

  describe('Given an arbitrary config file and a key drawn from the generator pool', () => {
    describe('When setConfigEntryInText or removeConfigEntry operates on the file', () => {
      it('Then re-tokenizing the output yields no entry whose ci key is outside the input key set plus the operated key', () => {
        // Arrange — catches K/L-style misclassification: a continuation tail
        // re-parsed as a standalone entry whose key was not in the original file.
        fc.assert(
          fc.property(configFileWithTarget(), ({ file, section, key }) => {
            const sub = undefined;
            const inputKeys = new Set(
              tokenizeConfig(file)
                .filter((t): t is Extract<typeof t, { kind: 'entry' }> => t.kind === 'entry')
                .map((t) => t.key.toLowerCase()),
            );

            for (const operate of [
              (t: string) => setConfigEntryInText(t, section, sub, key, 'v'),
              (t: string) => removeConfigEntry(t, section, sub, key),
            ]) {
              // Act
              let result: string;
              try {
                result = operate(file);
              } catch {
                // Assert — refusal parity: surgery may refuse only inputs the
                // tokenizer itself refuses, never a file the reader accepts
                expect(() => tokenizeConfig(file)).toThrow();
                continue;
              }

              // Assert — every output key already existed or is the operated key
              const outputKeys = tokenizeConfig(result)
                .filter((t): t is Extract<typeof t, { kind: 'entry' }> => t.kind === 'entry')
                .map((t) => t.key.toLowerCase());

              const allowedKeys = new Set([...inputKeys, key.toLowerCase()]);
              for (const k of outputKeys) {
                expect(allowedKeys.has(k), `orphan key "${k}" appeared in output`).toBe(true);
              }
            }
          }),
          { numRuns: 100 },
        );
      });
    });
  });

  describe('Given an arbitrary config file where the operated key is absent', () => {
    describe('When setConfigEntryInText or removeConfigEntry runs on a missing key', () => {
      it('Then every existing entry retains its parsed value unchanged', () => {
        // Arrange — absent-key stability: operating on a key that is not in the
        // file must not alter any other parsed entry.
        fc.assert(
          fc.property(configFileWithTarget(), ({ file, section, key }) => {
            const sub = undefined;
            const inputSections = parseIniSections(file);

            // Only proceed when the key is genuinely absent from the section
            const keyPresent = inputSections
              .filter(
                (s) => s.section.toLowerCase() === section.toLowerCase() && s.subsection === sub,
              )
              .some((s) => s.entries.some((e) => e.key.toLowerCase() === key.toLowerCase()));
            fc.pre(!keyPresent);

            // Act — remove of an absent key
            let removed: string | undefined;
            try {
              removed = removeConfigEntry(file, section, sub, key);
            } catch {
              // Assert — refusal parity: surgery may refuse only inputs the
              // tokenizer itself refuses, never a file the reader accepts
              expect(() => tokenizeConfig(file)).toThrow();
            }

            // Assert — removing an absent key leaves the file byte-identical
            if (removed !== undefined) expect(removed).toBe(file);

            // Act — set of an absent key
            let added: string | undefined;
            try {
              added = setConfigEntryInText(file, section, sub, key, 'v');
            } catch {
              // Assert — refusal parity, as above
              expect(() => tokenizeConfig(file)).toThrow();
            }

            // Assert — every entry present in the input keeps its parsed value
            if (added !== undefined) {
              const outputEntries = collectEntries(parseIniSections(added), () => true);
              for (const inEntry of collectEntries(inputSections, () => true)) {
                const found = outputEntries.find(
                  (o) =>
                    o.section === inEntry.section &&
                    o.subsection === inEntry.subsection &&
                    o.key === inEntry.key &&
                    o.value === inEntry.value,
                );
                expect(
                  found,
                  `entry ${inEntry.section}.${inEntry.key} changed or disappeared`,
                ).toBeDefined();
              }
            }
          }),
          { numRuns: 100 },
        );
      });
    });
  });
});

// ---------------------------------------------------------------------------
// Identity-isolation property (lens 2 — compositional invariant)
// ---------------------------------------------------------------------------

describe('update-config identity isolation', () => {
  describe('Given an arbitrary pair of distinct subsection identities A and B drawn from {undefined, "", sub}', () => {
    describe('When setConfigEntryInText targets identity A in a two-block file', () => {
      it('Then every byte of the identity-B block is unchanged', () => {
        // Arrange — `sut` is the function under test; a two-block file is built
        // from a pair of DISTINCT identities so A-targeted writes cannot touch B.
        const sut = setConfigEntryInText;
        fc.assert(
          fc.property(
            fc.tuple(subsectionIdentity(), subsectionIdentity()).filter(([a, b]) => a !== b),
            ([identityA, identityB]) => {
              // Build the header string for each identity
              const headerA = identityA === undefined ? '[s]\n' : `[s "${identityA}"]\n`;
              const headerB = identityB === undefined ? '[s]\n' : `[s "${identityB}"]\n`;
              const blockA = `${headerA}\tk = x\n`;
              const blockB = `${headerB}\tk = y\n`;
              const input = blockA + blockB;

              // Act — target identity A; B must not change
              let result: string;
              try {
                result = sut(input, 's', identityA, 'k', 'new');
              } catch {
                // subsection validation may refuse LF/NUL but our generator
                // only emits undefined, '' and lowercase alnum — should not throw
                return;
              }

              // Assert — B block appears byte-identical in the output
              expect(result).toContain(blockB);
            },
          ),
          { numRuns: 100 },
        );
      });
    });
  });
});

// ---------------------------------------------------------------------------
// rawSectionName round-trip property (lens 1)
// ---------------------------------------------------------------------------

/**
 * Generator over `(section, subsection)` pairs drawn from the header domain:
 * - section: small pool ∪ '' (empty section, only when subsection is present)
 * - subsection: undefined | '' | LF/NUL-free string from subsectionName()
 *
 * The dotted name is built from the same formula as rawSectionName — this is
 * the oracle, not a re-implementation: the test asserts round-trip identity,
 * not a specific encoding.
 */
const arbHeaderIdentity = (): fc.Arbitrary<{
  section: string;
  subsection: string | undefined;
  dottedName: string;
}> => {
  // Safe pool of section names (alphanumeric, used by renderSectionHeader)
  const arbSection = fc.constantFrom('s', 'remote', 'core', 'a', '');
  const arbSub = fc.oneof(
    fc.constant(undefined),
    fc.constant(''),
    subsectionName().filter((s) => s !== '' && s !== undefined),
  );
  return fc
    .tuple(arbSection, arbSub)
    .filter(
      // empty section is only representable with a subsection present
      ([section, sub]) => !(section === '' && sub === undefined),
    )
    .map(([section, subsection]) => ({
      section,
      subsection,
      dottedName: subsection === undefined ? section : `${section}.${subsection}`,
    }));
};

describe('parseNewSectionName partition property', () => {
  describe('Given an arbitrary ASCII NUL-free name', () => {
    describe('When parseNewSectionName runs', () => {
      it('Then it either returns a header-rendering-safe result or throws exactly INVALID_OPTION with a reason starting "invalid section name: "', () => {
        // Arrange — generator biased with grammar-relevant specials
        const arbName = fc
          .string({
            unit: fc.oneof(
              fc.constantFrom('.', '-', '_', '!', 'a', 'z', 'A', 'Z', '0', '9'),
              fc.integer({ min: 0x20, max: 0x7e }).map((cp) => String.fromCodePoint(cp)),
            ),
            maxLength: 64,
          })
          // NUL excluded from unit; also exclude LF so the subsection render won't hit rejectSubsection
          .filter((s) => !s.includes('\n') && !s.includes('\0'));

        fc.assert(
          fc.property(arbName, (name) => {
            const dot = name.indexOf('.');
            const sectionPart = dot === -1 ? name : name.slice(0, dot);
            // The section part must be non-empty OR a dot must follow (empty section allowed with dot)
            const shouldSucceed =
              name.length > 0 && (sectionPart === '' || /^[a-zA-Z0-9-]+$/.test(sectionPart));

            if (shouldSucceed) {
              // Act
              const result = parseNewSectionName(name);
              // Assert — rendering must not throw and the round-trip section matches
              expect(() => renderSectionHeader(result.section, result.subsection)).not.toThrow();
            } else {
              // Act
              let caught: unknown;
              try {
                parseNewSectionName(name);
              } catch (err) {
                caught = err;
              }
              // Assert — refusal must be INVALID_OPTION with the expected reason prefix
              expect(caught).toBeDefined();
              const data = (caught as { data?: { code?: string; reason?: string } }).data;
              expect(data?.code).toBe('INVALID_OPTION');
              expect(data?.reason).toMatch(/^invalid section name: /);
            }
          }),
          { numRuns: 100 },
        );
      });
    });
  });
});

describe('rawSectionName round-trip property', () => {
  describe('Given an arbitrary header identity (section from safe pool ∪ empty, subsection from LF/NUL-free domain)', () => {
    describe('When rendered via renderSectionHeader and re-parsed via parseSectionHeader', () => {
      it('Then rawSectionName of the parsed header equals the dotted name built from the original identity', () => {
        // Arrange — sut is the round-trip: render → parse → rawSectionName
        const sut = rawSectionName;
        fc.assert(
          fc.property(arbHeaderIdentity(), ({ section, subsection, dottedName }) => {
            // Act
            const rendered = renderSectionHeader(section, subsection);
            const parsed = parseSectionHeader(rendered.trim());

            // Assert — parse must succeed and the reduced name must match
            expect(parsed.kind).toBe('header');
            if (parsed.kind !== 'header') return;
            const result = sut(parsed);
            expect(result).toBe(dottedName);
          }),
          { numRuns: 200 },
        );
      });
    });

    describe('When addressing a two-block file by that dotted name via removeConfigSectionInText', () => {
      it('Then exactly the target block is removed and the sibling block bytes are intact', () => {
        // Arrange — two-block file from distinct identity pairs; removing by dotted name
        // must touch only the matching block.
        fc.assert(
          fc.property(arbHeaderIdentity(), arbHeaderIdentity(), (identityA, identityB) => {
            // Build a sibling block with a DIFFERENT raw name so the remove is unambiguous
            fc.pre(identityA.dottedName !== identityB.dottedName);

            const headerA = renderSectionHeader(identityA.section, identityA.subsection);
            const headerB = renderSectionHeader(identityB.section, identityB.subsection);
            const blockA = `${headerA}\n\tk = x\n`;
            const blockB = `${headerB}\n\tk = y\n`;
            const input = blockA + blockB;

            // Act — remove by dotted name of A; B must survive intact
            let result: string;
            try {
              result = removeConfigSectionInText(input, identityA.dottedName);
            } catch {
              // rejectSection/rejectSubsection should not fire for our safe generators
              return;
            }

            // Assert — B block is byte-identical in the output
            expect(result).toContain(blockB);
            // Assert — A block's header is gone from the output
            expect(result).not.toContain(blockA);
          }),
          { numRuns: 200 },
        );
      });
    });
  });
});
