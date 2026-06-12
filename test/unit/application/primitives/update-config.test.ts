import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import {
  __resetConfigCacheForTests,
  parseIniSections,
  readConfig,
} from '../../../../src/application/primitives/config-read.js';
import {
  appendConfigEntry,
  applyConfigOpInText,
  type ConfigOperation,
  rawSectionName,
  removeConfigEntry,
  removeConfigSectionInText,
  renameConfigSectionInText,
  setConfigEntryInText,
  setCoreConfigEntryInText,
  updateConfigEntries,
  updateConfigOperations,
  updateCoreConfig,
} from '../../../../src/application/primitives/update-config.js';
import { TsgitError } from '../../../../src/domain/error.js';
import type { Context } from '../../../../src/ports/context.js';

const configPath = (ctx: Context): string => `${ctx.layout.gitDir}/config`;

const seed = async (ctx: Context, content: string): Promise<void> => {
  await ctx.fs.writeUtf8(configPath(ctx), content);
};

describe('primitives/update-config', () => {
  beforeEach(() => {
    __resetConfigCacheForTests();
  });

  describe('setCoreConfigEntryInText', () => {
    describe('Given a [core] section with the key present', () => {
      describe('When setCoreConfigEntryInText', () => {
        it('Then the existing value is replaced', () => {
          // Arrange
          const text = '[core]\n\tsparseCheckout = false\n';

          // Act
          const sut = setCoreConfigEntryInText;
          const result = sut(text, 'sparseCheckout', 'true');

          // Assert — the value flips; the line is rewritten with a tab indent.
          expect(result).toBe('[core]\n\tsparseCheckout = true\n');
        });
      });
    });

    describe('Given a [core] section without the key', () => {
      describe('When setCoreConfigEntryInText', () => {
        it('Then the key is inserted at the end of the section', () => {
          // Arrange
          const text = '[core]\n\tbare = false\n';

          // Act
          const sut = setCoreConfigEntryInText;
          const result = sut(text, 'sparseCheckout', 'true');

          // Assert — inserted at the end of [core], after existing key.
          expect(result).toBe('[core]\n\tbare = false\n\tsparseCheckout = true\n');
        });
      });
    });

    describe('Given a config with no [core] section', () => {
      describe('When setCoreConfigEntryInText', () => {
        it('Then a [core] section is appended', () => {
          // Arrange
          const text = '[user]\n\tname = Ada\n';

          // Act
          const sut = setCoreConfigEntryInText;
          const result = sut(text, 'sparseCheckout', 'true');

          // Assert — the new section is appended at the end of the file.
          expect(result).toBe('[user]\n\tname = Ada\n[core]\n\tsparseCheckout = true\n');
        });
      });
    });

    describe('Given an empty config text and no [core]', () => {
      describe('When setCoreConfigEntryInText', () => {
        it('Then only the [core] section is produced (no leading blank line)', () => {
          // Arrange — empty input must not yield a stray leading newline.
          const text = '';

          // Act
          const sut = setCoreConfigEntryInText;
          const result = sut(text, 'sparseCheckout', 'true');

          // Assert
          expect(result).toBe('[core]\n\tsparseCheckout = true\n');
        });
      });
    });

    describe('Given a config with no [core] and no trailing newline', () => {
      describe('When setCoreConfigEntryInText', () => {
        it('Then a newline is inserted before the appended section', () => {
          // Arrange — the prefix branch must add the missing `\n` separator.
          const text = '[user]\n\tname = Ada';

          // Act
          const sut = setCoreConfigEntryInText;
          const result = sut(text, 'sparseCheckout', 'true');

          // Assert
          expect(result).toBe('[user]\n\tname = Ada\n[core]\n\tsparseCheckout = true\n');
        });
      });
    });

    describe('Given a [core] key whose name differs only in case', () => {
      describe('When setCoreConfigEntryInText', () => {
        it('Then the existing line is replaced (case-insensitive match)', () => {
          // Arrange — git keys are case-insensitive; an upper-cased on-disk key
          // must still be matched and replaced, not duplicated.
          const text = '[core]\n\tSPARSECHECKOUT = false\n';

          // Act
          const sut = setCoreConfigEntryInText;
          const result = sut(text, 'sparseCheckout', 'true');

          // Assert — the line is replaced (re-rendered with the passed-in casing).
          expect(result).toBe('[core]\n\tsparseCheckout = true\n');
        });
      });
    });

    describe('Given other sections, comments and blank lines around [core]', () => {
      describe('When setCoreConfigEntryInText replaces a key', () => {
        it('Then everything else is byte-preserved', () => {
          // Arrange — comments, a blank line, an unrelated section, and unrelated
          // [core] keys (with their own casing/spacing) must survive verbatim.
          const text =
            '# top comment\n[user]\n\tname = Ada\n\n[core]\n\t; core comment\n\tBARE = false\n\tsparseCheckout = false\n[remote "origin"]\n\turl = u\n';

          // Act
          const sut = setCoreConfigEntryInText;
          const result = sut(text, 'sparseCheckout', 'true');

          // Assert — only the sparseCheckout value changed.
          expect(result).toBe(
            '# top comment\n[user]\n\tname = Ada\n\n[core]\n\t; core comment\n\tBARE = false\n\tsparseCheckout = true\n[remote "origin"]\n\turl = u\n',
          );
        });
      });
    });

    describe('Given a key only present under a section after [core]', () => {
      describe('When setCoreConfigEntryInText', () => {
        it('Then it is inserted under [core], not matched in the later section', () => {
          // Arrange — `sparseCheckout` lives under `[other]`; the section scan must
          // stop at the `[other]` header and not reach into it.
          const text = '[core]\n\tbare = false\n[other]\n\tsparseCheckout = false\n';

          // Act
          const sut = setCoreConfigEntryInText;
          const result = sut(text, 'sparseCheckout', 'true');

          // Assert — inserted at end of [core] (after existing key); the [other] line is untouched.
          expect(result).toBe(
            '[core]\n\tbare = false\n\tsparseCheckout = true\n[other]\n\tsparseCheckout = false\n',
          );
        });
      });
    });

    describe('Given a `[core "sub"]` subsection', () => {
      describe('When setCoreConfigEntryInText', () => {
        it('Then the subsection is NOT treated as [core]', () => {
          // Arrange — a `[core "x"]` header must not satisfy the `[core]` match;
          // with no plain `[core]`, a new one is appended.
          const text = '[core "sub"]\n\tsparseCheckout = false\n';

          // Act
          const sut = setCoreConfigEntryInText;
          const result = sut(text, 'sparseCheckout', 'true');

          // Assert — the subsection survives; a real [core] is appended.
          expect(result).toBe(
            '[core "sub"]\n\tsparseCheckout = false\n[core]\n\tsparseCheckout = true\n',
          );
        });
      });
    });

    describe('Given an explicitly empty `[core ""]` header (distinct from [core])', () => {
      describe('When setCoreConfigEntryInText inserts sparseCheckout', () => {
        it('Then [core ""] is NOT matched and a new [core] section is appended', () => {
          // Arrange — [core ""] has subsection="", which is distinct from [core]
          // (subsection=undefined). setCoreConfigEntryInText targets core with no
          // subsection, so it must not edit [core ""] in place.
          const text = '[core ""]\n\tbare = false\n';

          // Act
          const sut = setCoreConfigEntryInText;
          const result = sut(text, 'sparseCheckout', 'true');

          // Assert — [core ""] is left byte-identical; a new [core] is appended.
          expect(result).toBe('[core ""]\n\tbare = false\n[core]\n\tsparseCheckout = true\n');
        });
      });
    });

    describe('Given a [core] body line lacking `=` whose text would key-match after dropping its last char', () => {
      describe('When setCoreConfigEntryInText', () => {
        it('Then the `=`-less line is not mistaken for the key', () => {
          // Arrange — `sparseCheckoutX` has no `=`. Without the valueless-key guard,
          // the line would be mistaken for a key match. The key must be inserted at the
          // end of the section (after the valueless line).
          const text = '[core]\n\tsparseCheckoutX\n';

          // Act
          const sut = setCoreConfigEntryInText;
          const result = sut(text, 'sparseCheckout', 'true');

          // Assert — the key is inserted at the end of the section; the `=`-less line survives.
          expect(result).toBe('[core]\n\tsparseCheckoutX\n\tsparseCheckout = true\n');
        });
      });
    });

    describe('Given a [core] header line with surrounding whitespace', () => {
      describe('When setCoreConfigEntryInText', () => {
        it('Then it is still recognized as [core]', () => {
          // Arrange — `  [core]  ` trims to `[core]`; the trimmed compare must match.
          const text = '  [core]  \n\tbare = false\n';

          // Act
          const sut = setCoreConfigEntryInText;
          const result = sut(text, 'sparseCheckout', 'true');

          // Assert — the original header line is preserved verbatim; key inserted at end.
          expect(result).toBe('  [core]  \n\tbare = false\n\tsparseCheckout = true\n');
        });
      });
    });

    describe('Given a key under a later section whose header is indented', () => {
      describe('When setCoreConfigEntryInText', () => {
        it('Then the section scan stops at the trimmed header (does not reach into it)', () => {
          // Arrange — `  [other]  ` is a real section header only after trimming.
          // Without the trim, the scan would not see it as a boundary and would
          // replace `sparseCheckout` inside `[other]` instead of inserting under [core].
          const text = '[core]\n\tbare = false\n  [other]  \n\tsparseCheckout = false\n';

          // Act
          const sut = setCoreConfigEntryInText;
          const result = sut(text, 'sparseCheckout', 'true');

          // Assert — inserted at end of [core] (after bare); the `[other]` line is byte-preserved.
          expect(result).toBe(
            '[core]\n\tbare = false\n\tsparseCheckout = true\n  [other]  \n\tsparseCheckout = false\n',
          );
        });
      });
    });

    describe('Given a [core] body line that starts with `[` but has no closing `]`', () => {
      describe('When setCoreConfigEntryInText replaces a later key', () => {
        it('Then that line is not treated as a section boundary', () => {
          // Arrange — `[not-a-header` starts with `[` yet is not a real header (no `]`).
          // The scan must require BOTH brackets, else it stops here and inserts a
          // duplicate instead of replacing the real `sparseCheckout` line below it.
          const text = '[core]\n\t[not-a-header\n\tsparseCheckout = false\n';

          // Act
          const sut = setCoreConfigEntryInText;
          const result = sut(text, 'sparseCheckout', 'true');

          // Assert — the existing `sparseCheckout` line is replaced in place.
          expect(result).toBe('[core]\n\t[not-a-header\n\tsparseCheckout = true\n');
        });
      });
    });

    describe('Given a [core] body line that ends with `]` but does not start with `[`', () => {
      describe('When setCoreConfigEntryInText runs on this malformed content', () => {
        it('Then CONFIG_PARSE_ERROR is thrown (malformed key grammar)', () => {
          // Arrange — `not-a-header]` fails the valueless-key grammar (contains `]`).
          // The tokenizer refuses this malformed content, matching git's own write refusal.
          const text = '[core]\n\tnot-a-header]\n\tsparseCheckout = false\n';
          let caught: unknown;

          // Act
          try {
            setCoreConfigEntryInText(text, 'sparseCheckout', 'true');
          } catch (err) {
            caught = err;
          }

          // Assert — refusal on malformed body line
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data;
          expect(data.code).toBe('CONFIG_PARSE_ERROR');
          if (data.code === 'CONFIG_PARSE_ERROR') {
            expect(data.line).toBe(2);
          }
        });
      });
    });

    describe('Given a `[Core]` header (mixed case)', () => {
      describe('When setCoreConfigEntryInText', () => {
        it('Then it is matched and updated in place (no duplicate section)', () => {
          // Arrange — git section names are case-insensitive; a `[Core]` header
          // must be edited in place, not joined by an appended duplicate `[core]`.
          const text = '[Core]\n\tsparseCheckout = false\n';

          // Act
          const sut = setCoreConfigEntryInText;
          const result = sut(text, 'sparseCheckout', 'true');

          // Assert — the existing line is replaced; no second `[core]` appears.
          expect(result).toBe('[Core]\n\tsparseCheckout = true\n');
        });
      });
    });

    describe('Given a `[CORE]` header (upper case)', () => {
      describe('When setCoreConfigEntryInText', () => {
        it('Then it is matched and updated in place (no duplicate section)', () => {
          // Arrange — an all-caps header is still the core section.
          const text = '[CORE]\n\tbare = false\n';

          // Act
          const sut = setCoreConfigEntryInText;
          const result = sut(text, 'sparseCheckout', 'true');

          // Assert — the key is inserted at end of `[CORE]`; no appended `[core]`.
          expect(result).toBe('[CORE]\n\tbare = false\n\tsparseCheckout = true\n');
        });
      });
    });

    describe('Given a `[Core "sub"]` subsection (mixed case)', () => {
      describe('When setCoreConfigEntryInText', () => {
        it('Then the subsection is NOT treated as [core]', () => {
          // Arrange — case-insensitivity must not bleed into the subsection: a
          // `[Core "sub"]` header still must not satisfy the plain `[core]` match.
          const text = '[Core "sub"]\n\tsparseCheckout = false\n';

          // Act
          const sut = setCoreConfigEntryInText;
          const result = sut(text, 'sparseCheckout', 'true');

          // Assert — the subsection survives; a real [core] is appended.
          expect(result).toBe(
            '[Core "sub"]\n\tsparseCheckout = false\n[core]\n\tsparseCheckout = true\n',
          );
        });
      });
    });

    describe('Given a key containing a newline', () => {
      describe('When setCoreConfigEntryInText', () => {
        it('Then it throws INVALID_OPTION', () => {
          // Arrange — a `\n` in the key would let line surgery splice a forged
          // section into `.git/config`.
          let caught: unknown;

          // Act
          try {
            setCoreConfigEntryInText('[core]\n', 'spar\nseCheckout', 'true');
          } catch (err) {
            caught = err;
          }

          // Assert — try/catch + direct `.data` field assertions.
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data;
          expect(data.code).toBe('INVALID_OPTION');
          if (data.code === 'INVALID_OPTION') {
            expect(data.option).toBe('config');
            expect(data.reason).toBe('key must not contain a newline or NUL');
          }
        });
      });
    });

    describe('Given a value containing a newline', () => {
      describe('When setCoreConfigEntryInText', () => {
        it('Then the newline is escaped as \\n and " is escaped as \\", value unquoted', () => {
          // Arrange & Act — LF is escaped to `\n`; `"` is escaped to `\"`; neither triggers
          // quoting, so the value is emitted unquoted.
          const sut = setCoreConfigEntryInText;
          const result = sut('[core]\n', 'sparseCheckout', 'true\n[remote "evil"]');

          // Assert — unquoted, LF → \n, " → \".
          expect(result).toBe('[core]\n\tsparseCheckout = true\\n[remote \\"evil\\"]\n');
        });
      });
    });

    describe('Given a value containing a carriage return', () => {
      describe('When setCoreConfigEntryInText', () => {
        it('Then the value is double-quoted with the raw CR inside (CR is accepted)', () => {
          // Arrange & Act — CR triggers quoting and passes through raw; it is no longer rejected.
          const sut = setCoreConfigEntryInText;
          const result = sut('[core]\n', 'sparseCheckout', 'true\r[harmless]');

          // Assert — quoted because CR triggers quoting; CR byte is raw inside quotes.
          expect(result).toBe('[core]\n\tsparseCheckout = "true\r[harmless]"\n');
        });
      });
    });

    describe('Given a value containing a NUL byte', () => {
      describe('When setCoreConfigEntryInText', () => {
        it('Then it throws INVALID_OPTION', () => {
          // Arrange — `\0` is rejected so a NUL-bearing value cannot reach the file.
          let caught: unknown;

          // Act
          try {
            setCoreConfigEntryInText('[core]\n', 'sparseCheckout', 'true\0x');
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data).toMatchObject({
            code: 'INVALID_OPTION',
            option: 'config',
            reason: 'value must not contain a NUL byte',
          });
        });
      });
    });
  });

  describe('updateCoreConfig', () => {
    describe('Given a missing .git/config', () => {
      describe('When updateCoreConfig', () => {
        it('Then the file is created with a [core] section', async () => {
          // Arrange — a missing file is treated as empty text.
          const ctx = createMemoryContext();

          // Act
          await updateCoreConfig(ctx, { sparseCheckout: 'true' });

          // Assert
          const written = await ctx.fs.readUtf8(configPath(ctx));
          expect(written).toBe('[core]\n\tsparseCheckout = true\n');
        });
      });
    });

    describe('Given an existing config', () => {
      describe('When updateCoreConfig', () => {
        it('Then the result is written back to .git/config', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, '[core]\n\tbare = false\n');

          // Act
          await updateCoreConfig(ctx, { sparseCheckout: 'true' });

          // Assert — end-of-section insertion: sparseCheckout lands after bare
          const written = await ctx.fs.readUtf8(configPath(ctx));
          expect(written).toBe('[core]\n\tbare = false\n\tsparseCheckout = true\n');
        });
      });
    });

    describe('Given multiple entries', () => {
      describe('When updateCoreConfig', () => {
        it('Then every entry is folded into the [core] section', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, '[core]\n\tbare = false\n');

          // Act
          await updateCoreConfig(ctx, { sparseCheckout: 'true', sparseCheckoutCone: 'false' });

          // Assert — both keys land under [core]; each key appended at end of section in fold order.
          const written = await ctx.fs.readUtf8(configPath(ctx));
          expect(written).toBe(
            '[core]\n\tbare = false\n\tsparseCheckout = true\n\tsparseCheckoutCone = false\n',
          );
        });
      });
    });

    describe('Given a config cached by readConfig', () => {
      describe('When updateCoreConfig writes', () => {
        it('Then a subsequent readConfig sees the new value', async () => {
          // Arrange — prime the readConfig cache with the stale value.
          const ctx = createMemoryContext();
          await seed(ctx, '[core]\n\tsparseCheckout = false\n');
          const before = await readConfig(ctx);
          expect(before.core?.sparseCheckout).toBe(false);

          // Act
          await updateCoreConfig(ctx, { sparseCheckout: 'true' });

          // Assert — the cache was invalidated, so the re-read reflects the write.
          const after = await readConfig(ctx);
          expect(after.core?.sparseCheckout).toBe(true);
        });
      });
    });

    describe('Given no entries', () => {
      describe('When updateCoreConfig', () => {
        it('Then the config is written back unchanged', async () => {
          // Arrange — an empty fold leaves the text identical.
          const ctx = createMemoryContext();
          await seed(ctx, '[core]\n\tbare = true\n');

          // Act
          await updateCoreConfig(ctx, {});

          // Assert
          const written = await ctx.fs.readUtf8(configPath(ctx));
          expect(written).toBe('[core]\n\tbare = true\n');
        });
      });
    });

    describe('Given fs.readUtf8 rejects with a non-FILE_NOT_FOUND TsgitError', () => {
      describe('When updateCoreConfig', () => {
        it('Then the error propagates', async () => {
          // Arrange — only FILE_NOT_FOUND is swallowed; other codes must propagate.
          const ctx = createMemoryContext();
          const denied = new TsgitError({ code: 'PERMISSION_DENIED', path: '/x/config' });
          vi.spyOn(ctx.fs, 'readUtf8').mockRejectedValue(denied);

          // Act
          let caught: unknown;
          try {
            await updateCoreConfig(ctx, { sparseCheckout: 'true' });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data).toEqual({
            code: 'PERMISSION_DENIED',
            path: '/x/config',
          });
        });
      });
    });

    describe('Given fs.readUtf8 rejects with a non-TsgitError', () => {
      describe('When updateCoreConfig', () => {
        it('Then the error is rethrown', async () => {
          // Arrange
          const ctx = createMemoryContext();
          const boom = new Error('disk on fire');
          vi.spyOn(ctx.fs, 'readUtf8').mockRejectedValue(boom);

          // Act
          let caught: unknown;
          try {
            await updateCoreConfig(ctx, { sparseCheckout: 'true' });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBe(boom);
        });
      });
    });
  });

  describe('setConfigEntryInText', () => {
    describe('Given an empty section name with no subsection', () => {
      describe('When setConfigEntryInText is called', () => {
        it('Then it throws INVALID_OPTION instead of writing an unparseable [] header', () => {
          // Arrange
          let caught: unknown;
          try {
            setConfigEntryInText('', '', undefined, 'k', 'v');
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data;
          expect(data.code).toBe('INVALID_OPTION');
          if (data.code === 'INVALID_OPTION') {
            expect(data.option).toBe('config');
            expect(data.reason).toBe('section name must not be empty without a subsection');
          }
        });
      });
    });

    describe('Given no matching section', () => {
      describe('When setConfigEntryInText', () => {
        it('Then the section is appended', () => {
          // Arrange & Act
          const sut = setConfigEntryInText;
          const result = sut('', 'extensions', undefined, 'partialClone', 'origin');

          // Assert
          expect(result).toBe('[extensions]\n\tpartialClone = origin\n');
        });
      });
    });

    describe('Given a subsection', () => {
      describe('When setConfigEntryInText', () => {
        it('Then the subsectioned header is rendered', () => {
          // Arrange & Act
          const sut = setConfigEntryInText;
          const result = sut('', 'remote', 'origin', 'url', 'https://e/r.git');

          // Assert
          expect(result).toBe('[remote "origin"]\n\turl = https://e/r.git\n');
        });
      });
    });

    describe('Given an existing section without the key', () => {
      describe('When setConfigEntryInText', () => {
        it('Then the key is inserted at the end of the section', () => {
          // Arrange
          const text = '[remote "origin"]\n\turl = https://e/r.git\n';

          // Act
          const sut = setConfigEntryInText;
          const result = sut(text, 'remote', 'origin', 'promisor', 'true');

          // Assert — inserted at the end of the section, after existing key
          expect(result).toBe('[remote "origin"]\n\turl = https://e/r.git\n\tpromisor = true\n');
        });
      });
    });

    describe('Given an existing key', () => {
      describe('When setConfigEntryInText', () => {
        it('Then its value is replaced', () => {
          // Arrange
          const text = '[remote "origin"]\n\tpromisor = false\n';

          // Act
          const sut = setConfigEntryInText;
          const result = sut(text, 'remote', 'origin', 'promisor', 'true');

          // Assert
          expect(result).toBe('[remote "origin"]\n\tpromisor = true\n');
        });
      });
    });

    describe('Given a subsection differing only in case', () => {
      describe('When setConfigEntryInText', () => {
        it('Then it is NOT matched (case-sensitive)', () => {
          // Arrange
          const text = '[remote "Origin"]\n\turl = old\n';

          // Act
          const sut = setConfigEntryInText;
          const result = sut(text, 'remote', 'origin', 'promisor', 'true');

          // Assert
          expect(result).toBe(
            '[remote "Origin"]\n\turl = old\n[remote "origin"]\n\tpromisor = true\n',
          );
        });
      });
    });

    describe('Given a section header differing only in case', () => {
      describe('When setConfigEntryInText', () => {
        it('Then it IS matched (case-insensitive)', () => {
          // Arrange
          const text = '[EXTENSIONS]\n\tpartialClone = a\n';

          // Act
          const sut = setConfigEntryInText;
          const result = sut(text, 'extensions', undefined, 'partialClone', 'b');

          // Assert
          expect(result).toBe('[EXTENSIONS]\n\tpartialClone = b\n');
        });
      });
    });

    describe('Given a subsection containing a newline', () => {
      describe('When setConfigEntryInText', () => {
        it('Then it throws INVALID_OPTION', () => {
          // Arrange
          let caught: unknown;
          try {
            setConfigEntryInText('', 'remote', 'ori\ngin', 'url', 'u');
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data.code).toBe('INVALID_OPTION');
        });
      });
    });

    describe('Given a subsection containing a quote (a"b)', () => {
      describe('When setConfigEntryInText', () => {
        it('Then the quote is escaped and the header is rendered as [s "a\\"b"]', () => {
          // Arrange & Act
          const sut = setConfigEntryInText;
          const result = sut('', 's', 'a"b', 'k', 'v');

          // Assert — git escapes " → \" inside the subsection quotes
          expect(result).toBe('[s "a\\"b"]\n\tk = v\n');
        });
      });
    });

    describe('Given a subsection containing a backslash (a\\b)', () => {
      describe('When setConfigEntryInText', () => {
        it('Then the backslash is escaped and the header is rendered as [s "a\\\\b"]', () => {
          // Arrange & Act
          const sut = setConfigEntryInText;
          const result = sut('', 's', 'a\\b', 'k', 'v');

          // Assert — git escapes \ → \\ inside the subsection quotes
          expect(result).toBe('[s "a\\\\b"]\n\tk = v\n');
        });
      });
    });

    describe('Given a subsection containing a backslash followed by a quote (a\\"b)', () => {
      describe('When setConfigEntryInText', () => {
        it('Then backslash is escaped first, then quote: header is [s "a\\\\\\"b"]', () => {
          // Arrange & Act — escape order: \ → \\ first, then " → \"
          const sut = setConfigEntryInText;
          const result = sut('', 's', 'a\\"b', 'k', 'v');

          // Assert — a\"b (a + \ + " + b) → a\\\"b (a + \\ + \" + b) inside the header quotes
          // Three backslashes in the output: two for escaped-\, one before the escaped-"
          expect(result).toBe('[s "a\\\\\\"b"]\n\tk = v\n');
        });
      });
    });

    describe('Given a subsection containing a bracket (a]b)', () => {
      describe('When setConfigEntryInText', () => {
        it('Then the bracket is written raw inside the quotes', () => {
          // Arrange & Act — ] is not escaped by git inside subsection quotes
          const sut = setConfigEntryInText;
          const result = sut('', 's', 'a]b', 'k', 'v');

          // Assert — raw ] inside quotes
          expect(result).toBe('[s "a]b"]\n\tk = v\n');
        });
      });
    });

    describe('Given a subsection containing a CR (a\\rb)', () => {
      describe('When setConfigEntryInText', () => {
        it('Then the CR is written raw inside the quotes (accepted by git)', () => {
          // Arrange & Act — CR is accepted and written verbatim
          const sut = setConfigEntryInText;
          const result = sut('', 's', 'a\rb', 'k', 'v');

          // Assert — raw CR inside subsection quotes
          expect(result).toBe('[s "a\rb"]\n\tk = v\n');
        });
      });
    });

    describe('Given a subsection containing a LF', () => {
      describe('When setConfigEntryInText', () => {
        it('Then it throws INVALID_OPTION (LF is forbidden by git)', () => {
          // Arrange
          let caught: unknown;

          // Act
          try {
            setConfigEntryInText('', 's', 'a\nb', 'k', 'v');
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data;
          expect(data.code).toBe('INVALID_OPTION');
          if (data.code !== 'INVALID_OPTION') throw new Error('unreachable');
          expect(data.option).toBe('config');
          expect(data.reason).toContain('newline');
        });
      });
    });

    describe('Given a subsection containing a NUL', () => {
      describe('When setConfigEntryInText', () => {
        it('Then it throws INVALID_OPTION (NUL is forbidden)', () => {
          // Arrange
          let caught: unknown;

          // Act
          try {
            setConfigEntryInText('', 's', 'a\0b', 'k', 'v');
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data;
          expect(data.code).toBe('INVALID_OPTION');
          if (data.code !== 'INVALID_OPTION') throw new Error('unreachable');
          expect(data.option).toBe('config');
          expect(data.reason).toContain('newline');
        });
      });
    });

    describe('Given text already holding [s "a\\"b"] with k = v, When setConfigEntryInText adds k2 under subsection a"b', () => {
      describe('When setConfigEntryInText', () => {
        it('Then k2 lands inside the existing section without duplicating the header', () => {
          // Arrange — pre-existing escaped header (as the writer would produce)
          const text = '[s "a\\"b"]\n\tk = v\n';

          // Act
          const sut = setConfigEntryInText;
          const result = sut(text, 's', 'a"b', 'k2', 'w');

          // Assert — k2 inserted at end of section (after k); header NOT duplicated
          expect(result).toBe('[s "a\\"b"]\n\tk = v\n\tk2 = w\n');
        });
      });
    });

    describe('Given a rendered subsection, When the output is re-parsed via parseIniSections', () => {
      describe('When round-tripping subsection a"b through render then parse', () => {
        it('Then the parsed subsection equals the original', () => {
          // Arrange
          const subsection = 'a"b';

          // Act
          const text = setConfigEntryInText('', 's', subsection, 'k', 'v');
          const sections = parseIniSections(text);

          // Assert — round-trip: render → parse returns same subsection
          expect(sections).toHaveLength(1);
          expect(sections[0]?.subsection).toBe(subsection);
        });
      });
    });

    describe('Given a section name containing a bracket', () => {
      describe('When setConfigEntryInText', () => {
        it('Then it throws INVALID_OPTION', () => {
          // Arrange
          let caught: unknown;
          try {
            setConfigEntryInText('', 'core]\n[evil', undefined, 'k', 'v');
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data;
          expect(data.code).toBe('INVALID_OPTION');
          if (data.code !== 'INVALID_OPTION') throw new Error('unreachable');
          expect(data.option).toBe('config');
          expect(data.reason).toContain('section');
        });
      });
    });

    describe('Given a value containing #', () => {
      describe('When setConfigEntryInText', () => {
        it('Then the rendered line is double-quoted', () => {
          // Arrange & Act — `#` would start an inline comment unquoted, so the writer must quote.
          const sut = setConfigEntryInText;
          const result = sut('', 'pager', undefined, 'log', 'less # paginate');

          // Assert
          expect(result).toBe('[pager]\n\tlog = "less # paginate"\n');
        });
      });
    });

    describe('Given a value containing ;', () => {
      describe('When setConfigEntryInText', () => {
        it('Then the rendered line is double-quoted', () => {
          // Arrange & Act — `;` is the second comment delimiter.
          const sut = setConfigEntryInText;
          const result = sut('', 'pager', undefined, 'log', 'less ; paginate');

          // Assert
          expect(result).toBe('[pager]\n\tlog = "less ; paginate"\n');
        });
      });
    });

    describe('Given a value with a leading space', () => {
      describe('When setConfigEntryInText', () => {
        it('Then the rendered line is double-quoted', () => {
          // Arrange & Act — leading whitespace would be trimmed by the parser without quotes.
          const sut = setConfigEntryInText;
          const result = sut('', 'user', undefined, 'name', ' Ada');

          // Assert
          expect(result).toBe('[user]\n\tname = " Ada"\n');
        });
      });
    });

    describe('Given a value with a leading tab', () => {
      describe('When setConfigEntryInText', () => {
        it('Then the TAB is escaped to \\t and the value is NOT quoted (tab is not a quote trigger)', () => {
          // Arrange & Act — leading TAB is escaped unconditionally; it does not trigger quoting.
          const sut = setConfigEntryInText;
          const result = sut('', 'user', undefined, 'name', '\tAda');

          // Assert — unquoted; leading TAB escaped to \t so no trimming risk.
          expect(result).toBe('[user]\n\tname = \\tAda\n');
        });
      });
    });

    describe('Given a value with a trailing space', () => {
      describe('When setConfigEntryInText', () => {
        it('Then the rendered line is double-quoted', () => {
          // Arrange & Act
          const sut = setConfigEntryInText;
          const result = sut('', 'user', undefined, 'name', 'Ada ');

          // Assert
          expect(result).toBe('[user]\n\tname = "Ada "\n');
        });
      });
    });

    describe('Given a value with a trailing tab', () => {
      describe('When setConfigEntryInText', () => {
        it('Then the TAB is escaped to \\t and the value is NOT quoted (tab is not a quote trigger)', () => {
          // Arrange & Act — trailing TAB is escaped unconditionally; it does not trigger quoting.
          const sut = setConfigEntryInText;
          const result = sut('', 'user', undefined, 'name', 'Ada\t');

          // Assert — unquoted; trailing TAB escaped to \t.
          expect(result).toBe('[user]\n\tname = Ada\\t\n');
        });
      });
    });

    describe('Given a value containing an embedded "', () => {
      describe('When setConfigEntryInText', () => {
        it('Then the quote is escaped unconditionally but the value is NOT wrapped in quotes', () => {
          // Arrange & Act — embedded " does not trigger quoting; it is always escaped.
          const sut = setConfigEntryInText;
          const result = sut('', 'user', undefined, 'name', 'Ada "Lovelace"');

          // Assert — unquoted; each " → \".
          expect(result).toBe('[user]\n\tname = Ada \\"Lovelace\\"\n');
        });
      });
    });

    describe('Given a value containing an embedded \\', () => {
      describe('When setConfigEntryInText', () => {
        it('Then the backslash is escaped unconditionally but the value is NOT wrapped in quotes', () => {
          // Arrange & Act — embedded \ does not trigger quoting; it is always escaped.
          const sut = setConfigEntryInText;
          const result = sut('', 'core', undefined, 'editor', 'C:\\bin\\vim');

          // Assert — unquoted; each \ → \\.
          expect(result).toBe('[core]\n\teditor = C:\\\\bin\\\\vim\n');
        });
      });
    });

    describe('Given a value containing an embedded newline', () => {
      describe('When setConfigEntryInText', () => {
        it('Then the newline is escaped as \\n and the value is NOT wrapped in quotes', () => {
          // Arrange & Act — LF does not trigger quoting; it is escaped unconditionally to \n.
          const sut = setConfigEntryInText;
          const result = sut('', 'alias', undefined, 'lg', 'log\nshort');

          // Assert — unquoted; LF → \n.
          expect(result).toBe('[alias]\n\tlg = log\\nshort\n');
        });
      });
    });

    describe('Given a plain alphanumeric value', () => {
      describe('When setConfigEntryInText', () => {
        it('Then no quotes are added (backward-compatible)', () => {
          // Arrange & Act — values that do not trigger any quoting rule must render verbatim.
          const sut = setConfigEntryInText;
          const result = sut('', 'user', undefined, 'name', 'Ada');

          // Assert
          expect(result).toBe('[user]\n\tname = Ada\n');
        });
      });
    });

    describe('Given a value containing only an embedded tab (no other trigger)', () => {
      describe('When setConfigEntryInText', () => {
        it('Then the TAB is escaped to \\t and the value is NOT quoted', () => {
          // Arrange & Act — embedded TAB is escaped unconditionally to \t; no quoting trigger.
          const sut = setConfigEntryInText;
          const result = sut('', 'user', undefined, 'name', 'A\tB');

          // Assert — unquoted; TAB → \t.
          expect(result).toBe('[user]\n\tname = A\\tB\n');
        });
      });
    });

    describe('Given a value with both embedded \\n and embedded \\', () => {
      describe('When setConfigEntryInText', () => {
        it('Then both are escaped (backslashes first, then newlines), unquoted', () => {
          // Arrange & Act — escape order matters: backslashes escaped first, then LF;
          // neither triggers quoting, so the result is unquoted.
          const sut = setConfigEntryInText;
          const result = sut('', 'alias', undefined, 'lg', 'a\\b\nc');

          // Assert
          expect(result).toBe('[alias]\n\tlg = a\\\\b\\nc\n');
        });
      });
    });

    describe('Given a value containing a semicolon (a;b)', () => {
      describe('When setConfigEntryInText', () => {
        it('Then the rendered line is double-quoted (semicolon triggers quoting)', () => {
          // Arrange & Act
          const sut = setConfigEntryInText;
          const result = sut('', 'test', undefined, 'k', 'a;b');

          // Assert
          expect(result).toBe('[test]\n\tk = "a;b"\n');
        });
      });
    });

    describe('Given a value containing a hash (a#b)', () => {
      describe('When setConfigEntryInText', () => {
        it('Then the rendered line is double-quoted (hash triggers quoting)', () => {
          // Arrange & Act
          const sut = setConfigEntryInText;
          const result = sut('', 'test', undefined, 'k', 'a#b');

          // Assert
          expect(result).toBe('[test]\n\tk = "a#b"\n');
        });
      });
    });

    describe('Given a value with a leading space ( a)', () => {
      describe('When setConfigEntryInText', () => {
        it('Then the rendered line is double-quoted (leading space triggers quoting)', () => {
          // Arrange & Act
          const sut = setConfigEntryInText;
          const result = sut('', 'test', undefined, 'k', ' a');

          // Assert
          expect(result).toBe('[test]\n\tk = " a"\n');
        });
      });
    });

    describe('Given a value with a trailing space (a )', () => {
      describe('When setConfigEntryInText', () => {
        it('Then the rendered line is double-quoted (trailing space triggers quoting)', () => {
          // Arrange & Act
          const sut = setConfigEntryInText;
          const result = sut('', 'test', undefined, 'k', 'a ');

          // Assert
          expect(result).toBe('[test]\n\tk = "a "\n');
        });
      });
    });

    describe('Given a value containing a CR (a\\rb)', () => {
      describe('When setConfigEntryInText', () => {
        it('Then the rendered line is double-quoted with raw CR inside the quotes', () => {
          // Arrange & Act — CR triggers quoting; CR itself passes through raw (not escaped).
          const sut = setConfigEntryInText;
          const result = sut('', 'test', undefined, 'k', 'a\rb');

          // Assert — the actual CR byte is inside the quotes, verbatim.
          expect(result).toBe('[test]\n\tk = "a\rb"\n');
        });
      });
    });

    describe('Given a value containing an embedded " (a"b)', () => {
      describe('When setConfigEntryInText', () => {
        it('Then the quote is escaped but the value is NOT quoted (new grammar)', () => {
          // Arrange & Act — quote does not trigger quoting; it is escaped unconditionally.
          const sut = setConfigEntryInText;
          const result = sut('', 'test', undefined, 'k', 'a"b');

          // Assert — unquoted, with \" escape.
          expect(result).toBe('[test]\n\tk = a\\"b\n');
        });
      });
    });

    describe('Given a value containing a single backslash (a\\b)', () => {
      describe('When setConfigEntryInText', () => {
        it('Then the backslash is escaped to \\\\ but the value is NOT quoted (new grammar)', () => {
          // Arrange & Act — backslash does not trigger quoting; escaped unconditionally.
          const sut = setConfigEntryInText;
          const result = sut('', 'test', undefined, 'k', 'a\\b');

          // Assert — unquoted, with \\ escape.
          expect(result).toBe('[test]\n\tk = a\\\\b\n');
        });
      });
    });

    describe('Given a value containing a LF (a\\nb)', () => {
      describe('When setConfigEntryInText', () => {
        it('Then LF is escaped to \\n and the value is NOT quoted (new grammar)', () => {
          // Arrange & Act — LF does not trigger quoting; escaped unconditionally.
          const sut = setConfigEntryInText;
          const result = sut('', 'test', undefined, 'k', 'a\nb');

          // Assert — unquoted, with \n escape.
          expect(result).toBe('[test]\n\tk = a\\nb\n');
        });
      });
    });

    describe('Given a value containing a TAB (a\\tb)', () => {
      describe('When setConfigEntryInText', () => {
        it('Then TAB is escaped to \\t and the value is NOT quoted (new grammar)', () => {
          // Arrange & Act — TAB does not trigger quoting; escaped unconditionally.
          const sut = setConfigEntryInText;
          const result = sut('', 'test', undefined, 'k', 'a\tb');

          // Assert — unquoted, with \t escape.
          expect(result).toBe('[test]\n\tk = a\\tb\n');
        });
      });
    });

    describe('Given a value with a leading TAB (\\ta)', () => {
      describe('When setConfigEntryInText', () => {
        it('Then the TAB is escaped to \\t and the value is NOT quoted (new grammar)', () => {
          // Arrange & Act — leading TAB is escaped (not raw), so no trimming risk;
          // escape does not trigger quoting.
          const sut = setConfigEntryInText;
          const result = sut('', 'test', undefined, 'k', '\ta');

          // Assert — unquoted, TAB escaped.
          expect(result).toBe('[test]\n\tk = \\ta\n');
        });
      });
    });

    describe('Given a combo value (a; b"c\\d ) with trailing space', () => {
      describe('When setConfigEntryInText', () => {
        it('Then it is quoted (trailing space) with both " and \\ escaped inside', () => {
          // Arrange & Act — trailing space triggers quoting; " and \ are escaped inside.
          const sut = setConfigEntryInText;
          const result = sut('', 'test', undefined, 'k', 'a; b"c\\d ');

          // Assert — quoted because of trailing space; semicolon is safe inside quotes;
          // " → \", \ → \\ applied unconditionally before wrapping.
          expect(result).toBe('[test]\n\tk = "a; b\\"c\\\\d "\n');
        });
      });
    });

    describe('Given a value containing a C0 control byte (\\x01)', () => {
      describe('When setConfigEntryInText', () => {
        it('Then the byte passes through verbatim and the value is NOT quoted', () => {
          // Arrange & Act — C0 controls (except NUL) are accepted and written raw.
          const sut = setConfigEntryInText;
          const result = sut('', 'test', undefined, 'k', 'a\x01b');

          // Assert — verbatim, unquoted.
          expect(result).toBe('[test]\n\tk = a\x01b\n');
        });
      });
    });

    describe('Given a value containing a DEL byte (\\x7f)', () => {
      describe('When setConfigEntryInText', () => {
        it('Then the byte passes through verbatim and the value is NOT quoted', () => {
          // Arrange & Act — DEL is accepted and written raw.
          const sut = setConfigEntryInText;
          const result = sut('', 'test', undefined, 'k', 'a\x7fb');

          // Assert — verbatim, unquoted.
          expect(result).toBe('[test]\n\tk = a\x7fb\n');
        });
      });
    });

    describe('Given a valueless entry for the key', () => {
      describe('When setConfigEntryInText replaces it', () => {
        it('Then the valueless line is replaced with the canonical key = value form', () => {
          // Arrange
          const text = '[a]\n\tkey\n';

          // Act
          const sut = setConfigEntryInText;
          const result = sut(text, 'a', undefined, 'key', 'replaced');

          // Assert — byte-exact: tab indent, space around =, trailing newline preserved.
          expect(result).toBe('[a]\n\tkey = replaced\n');
        });
      });
    });

    describe('Given a valueless entry whose name is a different case from the set key', () => {
      describe('When setConfigEntryInText matches case-insensitively', () => {
        it('Then the valueless line is replaced (case-insensitive key match)', () => {
          // Arrange
          const text = '[a]\n\tkey\n';

          // Act
          const sut = setConfigEntryInText;
          const result = sut(text, 'a', undefined, 'KEY', 'replaced');

          // Assert — valueless `key` line matched via case-insensitive comparison.
          expect(result).toBe('[a]\n\tKEY = replaced\n');
        });
      });
    });

    describe('Given a valueless line for a DIFFERENT key in the same section', () => {
      describe('When setConfigEntryInText targets another key', () => {
        it('Then the valueless line for the other key is not matched', () => {
          // Arrange — `other` is valueless; we set `key`, which is absent.
          const text = '[a]\n\tother\n';

          // Act
          const sut = setConfigEntryInText;
          const result = sut(text, 'a', undefined, 'key', 'v');

          // Assert — `other` line untouched; `key` inserted at end of section.
          expect(result).toBe('[a]\n\tother\n\tkey = v\n');
        });
      });
    });

    describe('Given a valueless line for the key in a LATER section', () => {
      describe('When setConfigEntryInText targets the first section', () => {
        it('Then the later section valueless line is not matched (section-stop)', () => {
          // Arrange — `key` is valueless in `[b]`, absent in `[a]`.
          const text = '[a]\n\tother = v\n[b]\n\tkey\n';

          // Act
          const sut = setConfigEntryInText;
          const result = sut(text, 'a', undefined, 'key', 'w');

          // Assert — new entry inserted at end of [a]; [b] section untouched.
          expect(result).toBe('[a]\n\tother = v\n\tkey = w\n[b]\n\tkey\n');
        });
      });
    });

    describe('Given a multi-line entry (backslash continuation)', () => {
      describe('When setConfigEntryInText replaces the key', () => {
        it('Then every physical line of the spanned entry is replaced by one canonical line', () => {
          // Arrange — row A: two-line continuation entry
          const text = '[a]\n\tkey = one\\\n   two\n\tother = x\n';

          // Act
          const sut = setConfigEntryInText;
          const result = sut(text, 'a', undefined, 'key', 'newval');

          // Assert — all span lines replaced by a single canonical line
          expect(result).toBe('[a]\n\tkey = newval\n\tother = x\n');
        });
      });
    });

    describe('Given a chained continuation entry', () => {
      describe('When setConfigEntryInText replaces the key', () => {
        it('Then chained continuation lines are all replaced', () => {
          // Arrange — row A2: three-line continuation entry
          const text = '[a]\n\tkey = one\\\n   two\\\n   three\n\tother = x\n';

          // Act
          const sut = setConfigEntryInText;
          const result = sut(text, 'a', undefined, 'key', 'newval');

          // Assert — all three span lines replaced by one canonical line
          expect(result).toBe('[a]\n\tkey = newval\n\tother = x\n');
        });
      });
    });

    describe('Given a quoted continuation entry', () => {
      describe('When setConfigEntryInText replaces the key', () => {
        it('Then a quoted continuation span is replaced whole', () => {
          // Arrange — row E1: continuation inside a quote
          const text = '[a]\n\tkey = "one\\\n   two"\n\tother = x\n';

          // Act
          const sut = setConfigEntryInText;
          const result = sut(text, 'a', undefined, 'key', 'newval');

          // Assert — the quoted continuation span removed entirely
          expect(result).toBe('[a]\n\tkey = newval\n\tother = x\n');
        });
      });
    });

    describe('Given a backslash inside a trailing comment', () => {
      describe('When setConfigEntryInText replaces the key', () => {
        it('Then a backslash inside a trailing comment does not extend the replaced span', () => {
          // Arrange — row E2: \\ in a comment is NOT a continuation
          const text = '[a]\n\tkey = one # c\\\n\tnext = x\n';

          // Act
          const sut = setConfigEntryInText;
          const result = sut(text, 'a', undefined, 'key', 'newval');

          // Assert — only the first line replaced; next = x line preserved
          expect(result).toBe('[a]\n\tkey = newval\n\tnext = x\n');
        });
      });
    });

    describe('Given a continuation tail that looks like a key line', () => {
      describe('When setConfigEntryInText targets url', () => {
        it('Then a continuation tail that looks like a key line is never matched', () => {
          // Arrange — row K: url = fake is inside the continuation of note
          const text = '[a]\n\tnote = first\\\n\turl = fake\n\turl = real\n';

          // Act
          const sut = setConfigEntryInText;
          const result = sut(text, 'a', undefined, 'url', 'NEW');

          // Assert — only the actual url entry is replaced, not the continuation tail
          expect(result).toBe('[a]\n\tnote = first\\\n\turl = fake\n\turl = NEW\n');
        });
      });
    });

    describe('Given a continuation tail that looks like a section header', () => {
      describe('When setConfigEntryInText targets key in [a]', () => {
        it('Then a continuation tail that looks like a section header does not end the section', () => {
          // Arrange — row L: [x] is inside the continuation of note (a value tail),
          // not a real header; key = old lives in section [a], not a separate [x] section
          const text = '[a]\n\tnote = v\\\n[x]\n\tkey = old\n';

          // Act — the reader sees key as being in [a]; we replace a.key
          const sut = setConfigEntryInText;
          const result = sut(text, 'a', undefined, 'key', 'NEW');

          // Assert — key replaced in place; note's continuation is preserved
          expect(result).toBe('[a]\n\tnote = v\\\n[x]\n\tkey = NEW\n');
        });
      });
    });

    describe('Given a section whose last entry has a multi-line tail, and a new key', () => {
      describe('When setConfigEntryInText inserts a new key', () => {
        it('Then a new key is inserted after the multi-line tail of the last entry', () => {
          // Arrange — row C: other is new, must land after the two-line span
          const text = '[a]\n\tkey = one\\\n   two\n';

          // Act
          const sut = setConfigEntryInText;
          const result = sut(text, 'a', undefined, 'other', 'val');

          // Assert — other lands after the full span of key
          expect(result).toBe('[a]\n\tkey = one\\\n   two\n\tother = val\n');
        });
      });
    });

    describe('Given a section followed by another section', () => {
      describe('When setConfigEntryInText inserts a new key into the first section', () => {
        it('Then a new key is inserted at the end of the section, not after the header', () => {
          // Arrange — row I1: new key goes after last entry of [a], before [b]
          const text = '[a]\n\tkey = one\n[b]\n\tk = v\n';

          // Act
          const sut = setConfigEntryInText;
          const result = sut(text, 'a', undefined, 'other', 'val');

          // Assert — inserted at end of [a] block, before [b]
          expect(result).toBe('[a]\n\tkey = one\n\tother = val\n[b]\n\tk = v\n');
        });
      });
    });

    describe('Given a section with trailing blank and comment lines before the next section', () => {
      describe('When setConfigEntryInText inserts a new key', () => {
        it('Then a new key is inserted after the last entry, before trailing blank and comment lines', () => {
          // Arrange — row I2: blank and comment after last entry, before [b]
          const text = '[a]\n\tkey = one\n\n# trailing comment\n[b]\n\tk = v\n';

          // Act
          const sut = setConfigEntryInText;
          const result = sut(text, 'a', undefined, 'other', 'val');

          // Assert — inserted after last entry, blank and comment preserved after
          expect(result).toBe(
            '[a]\n\tkey = one\n\tother = val\n\n# trailing comment\n[b]\n\tk = v\n',
          );
        });
      });
    });

    describe('Given an empty section', () => {
      describe('When setConfigEntryInText inserts a new key', () => {
        it('Then a new key in an empty section is inserted right after the header', () => {
          // Arrange — row I3: [a] is empty (no entries), [b] follows
          const text = '[a]\n[b]\n\tk = v\n';

          // Act
          const sut = setConfigEntryInText;
          const result = sut(text, 'a', undefined, 'other', 'val');

          // Assert — inserted right after the [a] header
          expect(result).toBe('[a]\n\tother = val\n[b]\n\tk = v\n');
        });
      });
    });

    describe('Given duplicate section blocks', () => {
      describe('When setConfigEntryInText inserts a new key', () => {
        it('Then the last duplicate section block receives the new key', () => {
          // Arrange — row I4: two [a] blocks, new key goes to the last one
          const text = '[a]\n\tk1 = x\n[b]\n\tk = v\n[a]\n\tk2 = y\n';

          // Act
          const sut = setConfigEntryInText;
          const result = sut(text, 'a', undefined, 'new', 'val');

          // Assert — new key added at end of last [a] block
          expect(result).toBe('[a]\n\tk1 = x\n[b]\n\tk = v\n[a]\n\tk2 = y\n\tnew = val\n');
        });
      });
    });

    describe('Given duplicate section blocks where first block has the key', () => {
      describe('When setConfigEntryInText replaces the key', () => {
        it('Then an existing key is replaced in the first block where it lives', () => {
          // Arrange — row M: key exists in first [a] block, should be replaced there
          const text = '[a]\n\tkey = x\n[b]\n\tk = v\n[a]\n\tother = y\n';

          // Act
          const sut = setConfigEntryInText;
          const result = sut(text, 'a', undefined, 'key', 'NEW');

          // Assert — replaced in the first [a] block
          expect(result).toBe('[a]\n\tkey = NEW\n[b]\n\tk = v\n[a]\n\tother = y\n');
        });
      });
    });

    describe('Given one block holding the same key twice', () => {
      describe('When setConfigEntryInText replaces the key', () => {
        it('Then only the first occurrence is rewritten and the second survives', () => {
          // Arrange — git itself refuses a bare set on a multi-valued key
          // (the configSet porcelain mirrors that refusal); the primitive's
          // contract is first-match-only, never replace-all
          const sut = setConfigEntryInText;
          const text = '[a]\n\tkey = x\n\tkey = y\n';

          // Act
          const result = sut(text, 'a', undefined, 'key', 'NEW');

          // Assert — first occurrence replaced, second untouched
          expect(result).toBe('[a]\n\tkey = NEW\n\tkey = y\n');
        });
      });
    });

    describe('Given text with an unclosed value quote', () => {
      describe('When setConfigEntryInText runs standalone', () => {
        it('Then CONFIG_PARSE_ERROR carries the 1-based line', () => {
          // Arrange
          let caught: unknown;

          // Act
          try {
            setConfigEntryInText('[a]\n\tk = "unclosed\n', 'a', undefined, 'k', 'v');
          } catch (err) {
            caught = err;
          }

          // Assert — try/catch + direct .data assertions
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data;
          expect(data.code).toBe('CONFIG_PARSE_ERROR');
          if (data.code === 'CONFIG_PARSE_ERROR') {
            expect(data.line).toBe(2);
          }
        });
      });
    });

    describe('Given a section at EOF without a trailing newline', () => {
      describe('When a new key is inserted', () => {
        it('Then the file gains a single trailing newline', () => {
          // Arrange — file ends with k = v with no trailing LF
          const text = '[a]\n\tk = v';

          // Act
          const sut = setConfigEntryInText;
          const result = sut(text, 'a', undefined, 'new', 'x');

          // Assert — new entry added, trailing newline added
          expect(result).toBe('[a]\n\tk = v\n\tnew = x\n');
        });
      });
    });

    describe('Given an existing entry at EOF without a trailing newline', () => {
      describe('When the entry is replaced', () => {
        it('Then the rewritten entry is terminated with a newline', () => {
          // Arrange — file ends with the replaced entry, no trailing LF
          const sut = setConfigEntryInText;
          const text = '[a]\n\tk = old';

          // Act
          const result = sut(text, 'a', undefined, 'k', 'new');

          // Assert — git's writer always terminates the rewritten pair
          expect(result).toBe('[a]\n\tk = new\n');
        });
      });
    });

    // ---------------------------------------------------------------------------
    // Identity matrix — [s] vs [s ""] are distinct targets (rows 1–6 of pinned table)
    // ---------------------------------------------------------------------------

    describe('Given both.conf ([s] and [s ""]) and target subsection=undefined', () => {
      describe('When setConfigEntryInText sets s.k to v', () => {
        it('Then only [s] is updated, [s ""] is untouched', () => {
          // Arrange
          const sut = setConfigEntryInText;
          const text = '[s]\n\tk = a\n[s ""]\n\tk = b\n';

          // Act
          const result = sut(text, 's', undefined, 'k', 'v');

          // Assert — [s] updated in place; [s ""] byte-identical
          expect(result).toBe('[s]\n\tk = v\n[s ""]\n\tk = b\n');
        });
      });
    });

    describe('Given both.conf ([s] and [s ""]) and target subsection=""', () => {
      describe('When setConfigEntryInText sets s..k to v', () => {
        it('Then only [s ""] is updated, [s] is untouched (direction pin)', () => {
          // Arrange
          const sut = setConfigEntryInText;
          const text = '[s]\n\tk = a\n[s ""]\n\tk = b\n';

          // Act
          const result = sut(text, 's', '', 'k', 'v');

          // Assert — [s ""] updated in place; [s] byte-identical
          expect(result).toBe('[s]\n\tk = a\n[s ""]\n\tk = v\n');
        });
      });
    });

    describe('Given rev.conf ([s ""] first then [s]) and target subsection=undefined', () => {
      describe('When setConfigEntryInText sets s.k to v', () => {
        it('Then only [s] is updated, [s ""] is untouched', () => {
          // Arrange
          const sut = setConfigEntryInText;
          const text = '[s ""]\n\tk = b\n[s]\n\tk = a\n';

          // Act
          const result = sut(text, 's', undefined, 'k', 'v');

          // Assert — [s] updated in place (even though [s ""] appears first); [s ""] unchanged
          expect(result).toBe('[s ""]\n\tk = b\n[s]\n\tk = v\n');
        });
      });
    });

    describe('Given rev.conf ([s ""] first then [s]) and target subsection=""', () => {
      describe('When setConfigEntryInText sets s..k to v', () => {
        it('Then only [s ""] is updated, [s] is untouched (direction pin)', () => {
          // Arrange
          const sut = setConfigEntryInText;
          const text = '[s ""]\n\tk = b\n[s]\n\tk = a\n';

          // Act
          const result = sut(text, 's', '', 'k', 'v');

          // Assert — [s ""] updated in place; [s] byte-identical
          expect(result).toBe('[s ""]\n\tk = v\n[s]\n\tk = a\n');
        });
      });
    });

    describe('Given empty-only.conf ([s ""] only) and target subsection=undefined', () => {
      describe('When setConfigEntryInText sets s.k to v', () => {
        it('Then [s ""] is NOT matched and a new [s] is appended', () => {
          // Arrange
          const sut = setConfigEntryInText;
          const text = '[s ""]\n\tk = b\n';

          // Act
          const result = sut(text, 's', undefined, 'k', 'v');

          // Assert — [s ""] untouched; new [s] appended at end
          expect(result).toBe('[s ""]\n\tk = b\n[s]\n\tk = v\n');
        });
      });
    });

    describe('Given plain-only.conf ([s] only) and target subsection=""', () => {
      describe('When setConfigEntryInText sets s..k to v', () => {
        it('Then [s] is NOT matched and a new [s ""] is appended (mirror pin)', () => {
          // Arrange
          const sut = setConfigEntryInText;
          const text = '[s]\n\tk = a\n';

          // Act
          const result = sut(text, 's', '', 'k', 'v');

          // Assert — [s] untouched; new [s ""] appended at end
          expect(result).toBe('[s]\n\tk = a\n[s ""]\n\tk = v\n');
        });
      });
    });

    describe('Given a file holding only [ ""] and target section=s subsection=undefined', () => {
      describe('When setConfigEntryInText sets s.k to v', () => {
        it('Then [ ""] is NOT matched and a new [s] is appended', () => {
          // Arrange
          const sut = setConfigEntryInText;
          const text = '[ ""]\n\tk = e\n';

          // Act
          const result = sut(text, 's', undefined, 'k', 'v');

          // Assert — [ ""] untouched; new [s] appended at end
          expect(result).toBe('[ ""]\n\tk = e\n[s]\n\tk = v\n');
        });
      });
    });

    describe('Given both.conf and a new key n, target subsection=undefined', () => {
      describe('When setConfigEntryInText inserts s.n', () => {
        it('Then new key n lands at end of [s] block, not inside [s ""]', () => {
          // Arrange
          const sut = setConfigEntryInText;
          const text = '[s]\n\tk = a\n[s ""]\n\tk = b\n';

          // Act
          const result = sut(text, 's', undefined, 'n', 'v');

          // Assert — n inserted at end of [s]; [s ""] untouched
          expect(result).toBe('[s]\n\tk = a\n\tn = v\n[s ""]\n\tk = b\n');
        });
      });
    });

    describe('Given a [S] section (uppercase) and target s (lowercase, no subsection)', () => {
      describe('When setConfigEntryInText sets s.k to v', () => {
        it('Then [S] is matched case-insensitively and rewritten in place', () => {
          // Arrange
          const sut = setConfigEntryInText;
          const text = '[S]\n\tk = a\n';

          // Act
          const result = sut(text, 's', undefined, 'k', 'v');

          // Assert — [S] rewritten in place; original header casing preserved
          expect(result).toBe('[S]\n\tk = v\n');
        });
      });
    });
  });

  describe('updateConfigEntries', () => {
    describe('Given entries across several sections', () => {
      describe('When updateConfigEntries', () => {
        it('Then every entry is written', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, '[core]\n\tbare = false\n');

          // Act
          await updateConfigEntries(ctx, [
            { section: 'core', key: 'repositoryformatversion', value: '1' },
            { section: 'extensions', key: 'partialClone', value: 'origin' },
            { section: 'remote', subsection: 'origin', key: 'promisor', value: 'true' },
          ]);

          // Assert
          const written = await ctx.fs.readUtf8(configPath(ctx));
          expect(written).toContain('repositoryformatversion = 1');
          expect(written).toContain('[extensions]');
          expect(written).toContain('partialClone = origin');
          expect(written).toContain('[remote "origin"]');
          expect(written).toContain('promisor = true');
        });
      });
    });

    describe('Given a config cached by readConfig', () => {
      describe('When updateConfigEntries writes', () => {
        it('Then a later readConfig sees it', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, '[core]\n\tbare = false\n');
          await readConfig(ctx);

          // Act
          await updateConfigEntries(ctx, [
            { section: 'extensions', key: 'partialClone', value: 'origin' },
          ]);

          // Assert
          const reread = await readConfig(ctx);
          expect(reread.extensions?.partialClone).toBe('origin');
        });
      });
    });
  });

  describe('removeConfigEntry', () => {
    describe('Given a section with the key present', () => {
      describe('When removeConfigEntry', () => {
        it('Then only the matching key line is removed', () => {
          // Arrange
          const text = '[remote "origin"]\n\turl = https://e.com/r\n\tfetch = +A:B\n';

          // Act
          const sut = removeConfigEntry;
          const result = sut(text, 'remote', 'origin', 'url');

          // Assert — header + fetch line preserved.
          expect(result).toBe('[remote "origin"]\n\tfetch = +A:B\n');
        });
      });
    });

    describe('Given a section without the key', () => {
      describe('When removeConfigEntry', () => {
        it('Then the text is byte-identical', () => {
          // Arrange
          const text = '[remote "origin"]\n\tfetch = +A:B\n';

          // Act
          const sut = removeConfigEntry;
          const result = sut(text, 'remote', 'origin', 'url');

          // Assert
          expect(result).toBe(text);
        });
      });
    });

    describe('Given no matching section', () => {
      describe('When removeConfigEntry', () => {
        it('Then the text is byte-identical', () => {
          // Arrange
          const text = '[core]\n\tbare = false\n';

          // Act
          const sut = removeConfigEntry;
          const result = sut(text, 'remote', 'origin', 'url');

          // Assert
          expect(result).toBe(text);
        });
      });
    });

    describe('Given the key appearing twice in one section', () => {
      describe('When removeConfigEntry', () => {
        it('Then every occurrence is removed (--unset-all semantics)', () => {
          // Arrange — two `fetch =` lines, both must go.
          const text = '[remote "origin"]\n\tfetch = +A:B\n\tfetch = +C:D\n\turl = u\n';

          // Act
          const sut = removeConfigEntry;
          const result = sut(text, 'remote', 'origin', 'fetch');

          // Assert
          expect(result).toBe('[remote "origin"]\n\turl = u\n');
        });
      });
    });

    describe('Given the same key in two different sections', () => {
      describe('When removeConfigEntry targets one section', () => {
        it('Then the emptied section is pruned and the other section preserved byte-for-byte', () => {
          // Arrange
          const text = '[remote "origin"]\n\turl = O\n[remote "upstream"]\n\turl = U\n';

          // Act
          const sut = removeConfigEntry;
          const result = sut(text, 'remote', 'origin', 'url');

          // Assert — the emptied origin block is pruned; upstream preserved verbatim.
          expect(result).toBe('[remote "upstream"]\n\turl = U\n');
        });
      });
    });

    describe('Given a key match with different casing', () => {
      describe('When removeConfigEntry', () => {
        it('Then the key is matched case-insensitively (git semantics)', () => {
          // Arrange
          const text = '[remote "origin"]\n\tURL = up\n';

          // Act
          const sut = removeConfigEntry;
          const result = sut(text, 'remote', 'origin', 'url');

          // Assert — sole entry removed, sole block pruned → empty file.
          expect(result).toBe('');
        });
      });
    });

    describe('Given the key in a different section', () => {
      describe('When removeConfigEntry targets a section that has no such key', () => {
        it('Then the key line in the OTHER section is untouched', () => {
          // Arrange — `url` lives only in the second `[remote "B"]` block.
          const text = '[remote "A"]\n\tfetch = +x:y\n[remote "B"]\n\turl = u\n';

          // Act
          const sut = removeConfigEntry;
          const result = sut(text, 'remote', 'A', 'url');

          // Assert — the unrelated section is preserved verbatim.
          expect(result).toBe(text);
        });
      });
    });

    describe('Given a valueless entry for the key', () => {
      describe('When removeConfigEntry removes it', () => {
        it('Then the valueless line is removed and neighbors are preserved byte-for-byte', () => {
          // Arrange
          const text = '[a]\n\tbefore = x\n\tkey\n\tafter = y\n';

          // Act
          const sut = removeConfigEntry;
          const result = sut(text, 'a', undefined, 'key');

          // Assert — `key` line gone; surrounding lines untouched.
          expect(result).toBe('[a]\n\tbefore = x\n\tafter = y\n');
        });
      });
    });

    describe('Given a multi-line entry (backslash continuation) with a neighbor key', () => {
      describe('When removeConfigEntry targets the multi-line key', () => {
        it('Then the whole continuation span is removed', () => {
          // Arrange — row B: head + tail both belong to key = "one   two"
          const text = '[a]\n\tkey = one\\\n   two\n\tother = x\n';

          // Act
          const sut = removeConfigEntry;
          const result = sut(text, 'a', undefined, 'key');

          // Assert — header + other line kept, no orphan tail
          expect(result).toBe('[a]\n\tother = x\n');
        });
      });
    });

    describe('Given multiple multi-line and single-line occurrences of the same key', () => {
      describe('When removeConfigEntry targets the key', () => {
        it('Then every occurrence full span is removed', () => {
          // Arrange — row F
          const text =
            '[a]\n\tkey = one\\\n   two\n\tmid = m\n\tkey = three\n\tkey = four\\\n   five\n';

          // Act
          const sut = removeConfigEntry;
          const result = sut(text, 'a', undefined, 'key');

          // Assert — only mid = m survives
          expect(result).toBe('[a]\n\tmid = m\n');
        });
      });
    });

    describe('Given a multi-line entry whose tail looks like a section header and a following real entry', () => {
      describe('When removeConfigEntry targets the entry that physically follows the lookalike tail', () => {
        it('Then only the real entry line is removed, the lookalike header tail stays', () => {
          // Arrange — row L2: [x] on the third physical line is a continuation tail of [a].note,
          // not a real header; key = old follows and is the real entry in [a]'s token block.
          const text = '[a]\n\tnote = v\\\n[x]\n\tkey = old\n';

          // Act — targeting a.key (not x.key) because the tokenizer correctly sees [x] as a tail
          const sut = removeConfigEntry;
          const result = sut(text, 'a', undefined, 'key');

          // Assert — key = old removed; the continuation [x] line stays as part of note's span
          expect(result).toBe('[a]\n\tnote = v\\\n[x]\n');
        });
      });
    });

    describe('Given a block whose only entry is a multi-line key', () => {
      describe('When removeConfigEntry empties it', () => {
        it('Then a block emptied of its only entry loses its header too', () => {
          // Arrange — row D
          const text = '[a]\n\tkey = one\\\n   two\n[b]\n\tk = v\n';

          // Act
          const sut = removeConfigEntry;
          const result = sut(text, 'a', undefined, 'key');

          // Assert — [a] block pruned entirely
          expect(result).toBe('[b]\n\tk = v\n');
        });
      });
    });

    describe('Given a block whose only entry is a single-line key', () => {
      describe('When removeConfigEntry empties it', () => {
        it('Then a block emptied of its single-line entry loses its header too', () => {
          // Arrange — row D2
          const text = '[a]\n\tkey = one\n[b]\n\tk = v\n';

          // Act
          const sut = removeConfigEntry;
          const result = sut(text, 'a', undefined, 'key');

          // Assert — [a] block pruned
          expect(result).toBe('[b]\n\tk = v\n');
        });
      });
    });

    describe('Given a block that is last in the file and its only entry is removed', () => {
      describe('When removeConfigEntry empties the last block', () => {
        it('Then the emptied last block of the file is removed and the trailing newline preserved', () => {
          // Arrange — row D3
          const text = '[b]\n\tk = v\n[a]\n\tkey = one\\\n   two\n';

          // Act
          const sut = removeConfigEntry;
          const result = sut(text, 'a', undefined, 'key');

          // Assert — [a] last block pruned; [b] block and trailing newline preserved
          expect(result).toBe('[b]\n\tk = v\n');
        });
      });
    });

    describe('Given a trailing section in a file without a final newline', () => {
      describe('When its only entry is unset and the block is pruned', () => {
        it('Then the kept prefix retains its newline terminator', () => {
          // Arrange — [a] is the last block and the file lacks a final LF
          const sut = removeConfigEntry;
          const text = '[b]\n\tk = v\n[a]\n\tkey = one';

          // Act
          const result = sut(text, 'a', undefined, 'key');

          // Assert — git copies the bytes before the removed region verbatim,
          // including the newline that followed the last kept line
          expect(result).toBe('[b]\n\tk = v\n');
        });
      });
    });

    describe('Given a block with a comment and a key entry', () => {
      describe('When removeConfigEntry empties the entries', () => {
        it('Then a comment line in the block keeps the header', () => {
          // Arrange — row D4: comment protects the block
          const text = '[a]\n\t# keep me\n\tkey = one\\\n   two\n[b]\n\tk = v\n';

          // Act
          const sut = removeConfigEntry;
          const result = sut(text, 'a', undefined, 'key');

          // Assert — header + comment kept; blank lines gone with the entry
          expect(result).toBe('[a]\n\t# keep me\n[b]\n\tk = v\n');
        });
      });
    });

    describe('Given a block with multiple key occurrences', () => {
      describe('When removeConfigEntry removes all occurrences', () => {
        it('Then the emptied block is pruned', () => {
          // Arrange — row D5
          const text = '[a]\n\tkey = x\n\tkey = y\\\n   tail\n[b]\n\tk = v\n';

          // Act
          const sut = removeConfigEntry;
          const result = sut(text, 'a', undefined, 'key');

          // Assert — [a] block entirely pruned
          expect(result).toBe('[b]\n\tk = v\n');
        });
      });
    });

    describe('Given a block with a blank line and its only entry is removed', () => {
      describe('When removeConfigEntry empties it', () => {
        it('Then blank lines do not protect the header and are removed with it', () => {
          // Arrange — row D6
          const text = '[a]\n\tkey = one\n\n[b]\n\tk = v\n';

          // Act
          const sut = removeConfigEntry;
          const result = sut(text, 'a', undefined, 'key');

          // Assert — blank does not protect; entire [a] block pruned
          expect(result).toBe('[b]\n\tk = v\n');
        });
      });
    });

    describe('Given a block with a blank line followed by a comment, and entry removed', () => {
      describe('When removeConfigEntry empties the entries', () => {
        it('Then a comment keeps the header and its blank lines', () => {
          // Arrange — row D8: comment after blank → block kept (blank + comment both survive)
          const text = '[a]\n\tkey = one\n\n# c\n[b]\n\tk = v\n';

          // Act
          const sut = removeConfigEntry;
          const result = sut(text, 'a', undefined, 'key');

          // Assert — [a] header + blank + comment all kept
          expect(result).toBe('[a]\n\n# c\n[b]\n\tk = v\n');
        });
      });
    });

    describe('Given two same-name blocks where only the first has the target key', () => {
      describe('When removeConfigEntry removes it', () => {
        it('Then only the emptied block is pruned, a later same-name block survives', () => {
          // Arrange — row D9: per-block rule
          const text = '[a]\n\tkey = x\n[b]\n\tk = v\n[a]\n\tother = y\n';

          // Act
          const sut = removeConfigEntry;
          const result = sut(text, 'a', undefined, 'key');

          // Assert — first [a] block pruned; [b] and second [a] untouched
          expect(result).toBe('[b]\n\tk = v\n[a]\n\tother = y\n');
        });
      });
    });

    describe('Given a block with an inline comment on its header line', () => {
      describe('When removeConfigEntry empties the entries', () => {
        it('Then an inline comment on the header line keeps the header', () => {
          // Arrange — row D10: hasComment=true on header
          const text = '[a] # note\n\tkey = one\n[b]\n\tk = v\n';

          // Act
          const sut = removeConfigEntry;
          const result = sut(text, 'a', undefined, 'key');

          // Assert — header (with its inline comment) kept; [b] preserved
          expect(result).toBe('[a] # note\n[b]\n\tk = v\n');
        });
      });
    });

    describe('Given an already-empty block before the targeted section', () => {
      describe('When removeConfigEntry targets a key elsewhere', () => {
        it('Then the already-empty block is preserved byte-for-byte', () => {
          // Arrange — guard sentinel: pre-existing empty block must not be pruned
          const text = '[empty]\n[a]\n\tkey = v\n\tother = x\n';

          // Act
          const sut = removeConfigEntry;
          const result = sut(text, 'a', undefined, 'key');

          // Assert — [empty] block untouched; [a] block keeps header + other
          expect(result).toBe('[empty]\n[a]\n\tother = x\n');
        });
      });
    });

    describe('Given a block with a lenient bracket body line as the only non-entry token', () => {
      describe('When removeConfigEntry empties the entries', () => {
        it('Then the header is kept because opaque content protects the block', () => {
          // Arrange — guard sentinel: lenient "[half" tokenized as comment → protects block
          const text = '[a]\n\t[half\n\tkey = v\n';

          // Act
          const sut = removeConfigEntry;
          const result = sut(text, 'a', undefined, 'key');

          // Assert — "[half" comment-token keeps the header
          expect(result).toBe('[a]\n\t[half\n');
        });
      });
    });

    // ---------------------------------------------------------------------------
    // Unset identity rows from the pinned table
    // ---------------------------------------------------------------------------

    describe('Given both.conf ([s] k=a and [s ""] k=b), target subsection=undefined', () => {
      describe('When removeConfigEntry removes s.k', () => {
        it('Then only the [s] entry is removed; [s ""] k=b is preserved', () => {
          // Arrange
          const sut = removeConfigEntry;
          const text = '[s]\n\tk = a\n[s ""]\n\tk = b\n';

          // Act
          const result = sut(text, 's', undefined, 'k');

          // Assert — [s] block pruned (was its only entry); [s ""] untouched
          expect(result).toBe('[s ""]\n\tk = b\n');
        });
      });
    });

    describe('Given both.conf ([s] k=a and [s ""] k=b), target subsection=""', () => {
      describe('When removeConfigEntry removes s..k', () => {
        it('Then only the [s ""] entry is removed; [s] k=a is preserved', () => {
          // Arrange
          const sut = removeConfigEntry;
          const text = '[s]\n\tk = a\n[s ""]\n\tk = b\n';

          // Act
          const result = sut(text, 's', '', 'k');

          // Assert — [s ""] block pruned (was its only entry); [s] untouched
          expect(result).toBe('[s]\n\tk = a\n');
        });
      });
    });

    describe('Given three blocks [s] k=a · [s ""] k=b · [s] k=c, target subsection=undefined', () => {
      describe('When removeConfigEntry removes s.k (unset-all semantics)', () => {
        it('Then both [s] entries are removed and [s ""] k=b is preserved', () => {
          // Arrange
          const sut = removeConfigEntry;
          const text = '[s]\n\tk = a\n[s ""]\n\tk = b\n[s]\n\tk = c\n';

          // Act
          const result = sut(text, 's', undefined, 'k');

          // Assert — both [s] blocks pruned; [s ""] preserved
          expect(result).toBe('[s ""]\n\tk = b\n');
        });
      });
    });

    describe('Given three blocks [s ""] k=a · [s ""] k=b · [s] k=c, target subsection=""', () => {
      describe('When removeConfigEntry removes s..k (unset-all semantics)', () => {
        it('Then both [s ""] entries are removed and [s] k=c is preserved', () => {
          // Arrange
          const sut = removeConfigEntry;
          const text = '[s ""]\n\tk = a\n[s ""]\n\tk = b\n[s]\n\tk = c\n';

          // Act
          const result = sut(text, 's', '', 'k');

          // Assert — both [s ""] blocks pruned; [s] preserved
          expect(result).toBe('[s]\n\tk = c\n');
        });
      });
    });

    describe('Given [ "x"] k=a · [ ""] k=e, target section="" subsection="x"', () => {
      describe('When removeConfigEntry removes .x.k', () => {
        it('Then only [ "x"] is removed and pruned; [ ""] k=e is preserved', () => {
          // Arrange — subsection identity holds inside the empty-name family
          const sut = removeConfigEntry;
          const text = '[ "x"]\n\tk = a\n[ ""]\n\tk = e\n';

          // Act
          const result = sut(text, '', 'x', 'k');

          // Assert — [ "x"] pruned; [ ""] preserved byte-identically
          expect(result).toBe('[ ""]\n\tk = e\n');
        });
      });
    });
  });

  // ---------------------------------------------------------------------------
  // rawSectionName — pinned raw-name reductions
  // ---------------------------------------------------------------------------

  describe('rawSectionName', () => {
    describe('Given a plain header [s]', () => {
      describe('When rawSectionName is called', () => {
        it('Then it returns "s"', () => {
          // Arrange
          const sut = rawSectionName;

          // Act
          const result = sut({ section: 's', subsection: undefined });

          // Assert
          expect(result).toBe('s');
        });
      });
    });

    describe('Given a subsectioned header [s "x"]', () => {
      describe('When rawSectionName is called', () => {
        it('Then it returns "s.x"', () => {
          // Arrange
          const sut = rawSectionName;

          // Act
          const result = sut({ section: 's', subsection: 'x' });

          // Assert
          expect(result).toBe('s.x');
        });
      });
    });

    describe('Given an explicitly empty subsection [s ""]', () => {
      describe('When rawSectionName is called', () => {
        it('Then it returns "s." (trailing dot)', () => {
          // Arrange
          const sut = rawSectionName;

          // Act
          const result = sut({ section: 's', subsection: '' });

          // Assert
          expect(result).toBe('s.');
        });
      });
    });

    describe('Given the empty-name family [ ""]', () => {
      describe('When rawSectionName is called', () => {
        it('Then it returns "." (leading dot)', () => {
          // Arrange
          const sut = rawSectionName;

          // Act
          const result = sut({ section: '', subsection: '' });

          // Assert
          expect(result).toBe('.');
        });
      });
    });

    describe('Given the empty-name family [ "x"]', () => {
      describe('When rawSectionName is called', () => {
        it('Then it returns ".x"', () => {
          // Arrange
          const sut = rawSectionName;

          // Act
          const result = sut({ section: '', subsection: 'x' });

          // Assert
          expect(result).toBe('.x');
        });
      });
    });

    describe('Given a deprecated dotted header [s.X] (section="s.X", subsection=undefined)', () => {
      describe('When rawSectionName is called', () => {
        it('Then it returns "s.X" (raw header bytes)', () => {
          // Arrange — parseSectionHeader parses [s.X] as section="s.X", subsection=undefined
          const sut = rawSectionName;

          // Act
          const result = sut({ section: 's.X', subsection: undefined });

          // Assert
          expect(result).toBe('s.X');
        });
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Pinned raw-name reduction rows — removeConfigSectionInText & renameConfigSectionInText
  // ---------------------------------------------------------------------------

  describe('removeConfigSectionInText (pinned raw-name rows)', () => {
    describe('Given [s]k=a and [s ""]k=b (both.conf)', () => {
      describe('When removeConfigSectionInText removes "s"', () => {
        it('Then only [s] is removed, [s ""] is preserved', () => {
          // Arrange
          const text = '[s]\n\tk = a\n[s ""]\n\tk = b\n';
          const sut = removeConfigSectionInText;

          // Act
          const result = sut(text, 's');

          // Assert — s matches only [s], not [s ""]
          expect(result).toBe('[s ""]\n\tk = b\n');
        });
      });

      describe('When removeConfigSectionInText removes "s."', () => {
        it('Then only [s ""] is removed, [s] is preserved', () => {
          // Arrange
          const text = '[s]\n\tk = a\n[s ""]\n\tk = b\n';
          const sut = removeConfigSectionInText;

          // Act
          const result = sut(text, 's.');

          // Assert — trailing-dot name s. matches [s ""] only
          expect(result).toBe('[s]\n\tk = a\n');
        });
      });

      describe('When removeConfigSectionInText removes \'s.""\'', () => {
        it('Then nothing is removed (two-quote-char subsection is a distinct name)', () => {
          // Arrange
          const text = '[s]\n\tk = a\n[s ""]\n\tk = b\n';
          const sut = removeConfigSectionInText;

          // Act
          const result = sut(text, 's.""');

          // Assert — s."" does not match s. or s; text unchanged
          expect(result).toBe(text);
        });
      });
    });

    describe('Given [S]k=a (upper-case section)', () => {
      describe('When removeConfigSectionInText removes "s" (lower-case)', () => {
        it('Then nothing is removed (byte-exact case-sensitive matching)', () => {
          // Arrange
          const text = '[S]\n\tk = a\n';
          const sut = removeConfigSectionInText;

          // Act
          const result = sut(text, 's');

          // Assert — s does not match [S]; text unchanged
          expect(result).toBe(text);
        });
      });
    });

    describe('Given deprecated [s.X]k=a', () => {
      describe('When removeConfigSectionInText removes "s.X"', () => {
        it('Then the deprecated header is removed (raw byte match)', () => {
          // Arrange
          const text = '[s.X]\n\tk = a\n';
          const sut = removeConfigSectionInText;

          // Act
          const result = sut(text, 's.X');

          // Assert — s.X matches deprecated [s.X]
          expect(result).toBe('');
        });
      });

      describe('When removeConfigSectionInText removes "s.x" (lower-case)', () => {
        it('Then nothing is removed (case-sensitive; s.x ≠ s.X)', () => {
          // Arrange
          const text = '[s.X]\n\tk = a\n';
          const sut = removeConfigSectionInText;

          // Act
          const result = sut(text, 's.x');

          // Assert — s.x does not match [s.X]; text unchanged
          expect(result).toBe(text);
        });
      });
    });

    describe('Given [a.b]k=p and [a "b"]k=q (ambiguity)', () => {
      describe('When removeConfigSectionInText removes "a.b"', () => {
        it('Then both blocks are removed (a.b is the raw name of both)', () => {
          // Arrange
          const text = '[a.b]\n\tk = p\n[a "b"]\n\tk = q\n';
          const sut = removeConfigSectionInText;

          // Act
          const result = sut(text, 'a.b');

          // Assert — documented a.b ambiguity; both blocks removed
          expect(result).toBe('');
        });
      });
    });

    describe('Given [s]k=a, [s "x"]k=b, and [s]k=c (multi-block plain)', () => {
      describe('When removeConfigSectionInText removes "s"', () => {
        it('Then both [s] blocks are removed, [s "x"] is preserved', () => {
          // Arrange
          const text = '[s]\n\tk = a\n[s "x"]\n\tk = b\n[s]\n\tk = c\n';
          const sut = removeConfigSectionInText;

          // Act
          const result = sut(text, 's');

          // Assert — multi-block plain removal
          expect(result).toBe('[s "x"]\n\tk = b\n');
        });
      });
    });

    describe('Given [ ""] in name-mix.conf', () => {
      describe('When removeConfigSectionInText removes "."', () => {
        it('Then only [ ""] is removed, [s] and [s ""] are preserved', () => {
          // Arrange
          const text = '[ ""]\n\tk = e\n[s]\n\tk = a\n[s ""]\n\tk = b\n';
          const sut = removeConfigSectionInText;

          // Act
          const result = sut(text, '.');

          // Assert — . matches [ ""] only
          expect(result).toBe('[s]\n\tk = a\n[s ""]\n\tk = b\n');
        });
      });
    });

    describe('Given [ "x"]k=e in the file', () => {
      describe('When removeConfigSectionInText removes ".x"', () => {
        it('Then only [ "x"] is removed', () => {
          // Arrange
          const text = '[ "x"]\n\tk = e\n[s]\n\tk = a\n';
          const sut = removeConfigSectionInText;

          // Act
          const result = sut(text, '.x');

          // Assert — .x matches [ "x"] only
          expect(result).toBe('[s]\n\tk = a\n');
        });
      });
    });

    describe('Given [s     ""] (pre-quote whitespace, whitespace not identity)', () => {
      describe('When removeConfigSectionInText removes "s."', () => {
        it('Then the block is removed (pre-quote whitespace is not part of the raw name)', () => {
          // Arrange — parseSectionHeader strips pre-quote whitespace; raw name is still s.
          const text = '[s     ""]\n\tk = a\n';
          const sut = removeConfigSectionInText;

          // Act
          const result = sut(text, 's.');

          // Assert — whitespace before quote is not identity
          expect(result).toBe('');
        });
      });
    });

    describe('Given [s "a\\"b"] (escaped quote in subsection)', () => {
      describe("When removeConfigSectionInText removes 's.a\"b'", () => {
        it('Then the block is removed (subsection unescaped before joining)', () => {
          // Arrange — parseSectionHeader unescapes \\\" → "; rawSectionName joins s + . + a"b
          const text = '[s "a\\"b"]\n\tk = a\n';
          const sut = removeConfigSectionInText;

          // Act
          const result = sut(text, 's.a"b');

          // Assert — subsection is unescaped before raw-name comparison
          expect(result).toBe('');
        });
      });
    });
  });

  describe('renameConfigSectionInText (pinned raw-name rows)', () => {
    describe('Given [a "b."]k=p and [a.b ""]k=q', () => {
      describe('When renameConfigSectionInText renames "a.b." to { section: "t", subsection: undefined }', () => {
        it('Then both ambiguous headers become [t] (raw a.b. matches both)', () => {
          // Arrange
          const text = '[a "b."]\n\tk = p\n[a.b ""]\n\tk = q\n';
          const sut = renameConfigSectionInText;

          // Act
          const result = sut(text, 'a.b.', { section: 't' });

          // Assert — a.b. is the raw name of both [a "b."] and [a.b ""]
          expect(result).toBe('[t]\n\tk = p\n[t]\n\tk = q\n');
        });
      });
    });

    describe('Given [s]k=a, [s "x"]k=b, and [s]k=c', () => {
      describe('When renameConfigSectionInText renames "s" to { section: "t" }', () => {
        it('Then both [s] blocks become [t], [s "x"] is preserved', () => {
          // Arrange
          const text = '[s]\n\tk = a\n[s "x"]\n\tk = b\n[s]\n\tk = c\n';
          const sut = renameConfigSectionInText;

          // Act
          const result = sut(text, 's', { section: 't' });

          // Assert — multi-block plain rename
          expect(result).toBe('[t]\n\tk = a\n[s "x"]\n\tk = b\n[t]\n\tk = c\n');
        });
      });
    });

    describe('Given [s]k=a (plain header)', () => {
      describe('When renameConfigSectionInText renames "s" to { section: "s", subsection: "" }', () => {
        it('Then the header becomes [s ""] (duplicate-with-empty allowed at primitive level)', () => {
          // Arrange
          const text = '[s]\n\tk = a\n';
          const sut = renameConfigSectionInText;

          // Act
          const result = sut(text, 's', { section: 's', subsection: '' });

          // Assert — rename plain → empty-subsection form
          expect(result).toBe('[s ""]\n\tk = a\n');
        });
      });
    });

    describe('Given [s "x"]k=a', () => {
      describe('When renameConfigSectionInText renames "s.x" to { section: "t" } (cross-family)', () => {
        it('Then the header becomes [t] (cross-family at the primitive level)', () => {
          // Arrange
          const text = '[s "x"]\n\tk = a\n';
          const sut = renameConfigSectionInText;

          // Act
          const result = sut(text, 's.x', { section: 't' });

          // Assert — cross-family rename at primitive level
          expect(result).toBe('[t]\n\tk = a\n');
        });
      });
    });

    describe('Given [s "x"]k=a', () => {
      describe('When renameConfigSectionInText renames "s.x" to { section: "s", subsection: "" }', () => {
        it('Then the header becomes [s ""] (named subsection collapses to the empty form)', () => {
          // Arrange
          const text = '[s "x"]\n\tk = a\n';
          const sut = renameConfigSectionInText;

          // Act
          const result = sut(text, 's.x', { section: 's', subsection: '' });

          // Assert
          expect(result).toBe('[s ""]\n\tk = a\n');
        });
      });
    });

    describe('Given [s "x"]k=a', () => {
      describe('When renameConfigSectionInText renames "s.x" to { section: "", subsection: "" }', () => {
        it('Then the header becomes [ ""] (named form moves into the empty-name family)', () => {
          // Arrange
          const text = '[s "x"]\n\tk = a\n';
          const sut = renameConfigSectionInText;

          // Act
          const result = sut(text, 's.x', { section: '', subsection: '' });

          // Assert
          expect(result).toBe('[ ""]\n\tk = a\n');
        });
      });
    });

    describe('Given [S]k=a (upper-case header)', () => {
      describe('When renameConfigSectionInText renames the byte-exact "S" to { section: "t" }', () => {
        it('Then the header becomes [t] (matching success direction of case sensitivity)', () => {
          // Arrange
          const text = '[S]\n\tk = a\n';
          const sut = renameConfigSectionInText;

          // Act
          const result = sut(text, 'S', { section: 't' });

          // Assert
          expect(result).toBe('[t]\n\tk = a\n');
        });
      });
    });

    describe('Given [s "X"]k=a (upper-case subsection)', () => {
      describe('When renameConfigSectionInText renames the byte-exact "s.X" to { section: "t" }', () => {
        it('Then the header becomes [t] (matching success direction of subsection case)', () => {
          // Arrange
          const text = '[s "X"]\n\tk = a\n';
          const sut = renameConfigSectionInText;

          // Act
          const result = sut(text, 's.X', { section: 't' });

          // Assert
          expect(result).toBe('[t]\n\tk = a\n');
        });
      });
    });
  });

  // ---------------------------------------------------------------------------
  // applyConfigOpInText — removeSection call-site adaptation
  // ---------------------------------------------------------------------------

  describe('applyConfigOpInText (removeSection call-site)', () => {
    describe('Given [s]k=a and [s ""]k=b, and a removeSection op with section "s" (no subsection)', () => {
      describe('When applyConfigOpInText applies the op', () => {
        it('Then only [s] is removed, [s ""] is preserved', () => {
          // Arrange — { kind: "removeSection", section: "s" } maps to raw name "s"
          const text = '[s]\n\tk = a\n[s ""]\n\tk = b\n';
          const op: ConfigOperation = { kind: 'removeSection', section: 's' };

          // Act
          const result = applyConfigOpInText(text, op);

          // Assert
          expect(result).toBe('[s ""]\n\tk = b\n');
        });
      });
    });

    describe('Given [s]k=a and [s ""]k=b, and a removeSection op with section "s" and subsection ""', () => {
      describe('When applyConfigOpInText applies the op', () => {
        it('Then only [s ""] is removed, [s] is preserved', () => {
          // Arrange — the op maps to the raw name "s." addressing only [s ""]
          const text = '[s]\n\tk = a\n[s ""]\n\tk = b\n';
          const op: ConfigOperation = { kind: 'removeSection', section: 's', subsection: '' };

          // Act
          const result = applyConfigOpInText(text, op);

          // Assert
          expect(result).toBe('[s]\n\tk = a\n');
        });
      });
    });
  });

  describe('applyConfigOpInText (renameSection call-site)', () => {
    describe('Given [remote "old"]url=u, and a renameSection op from "old" to "new"', () => {
      describe('When applyConfigOpInText applies the op', () => {
        it('Then the op addresses the raw name remote.old and rewrites the header to [remote "new"]', () => {
          // Arrange
          const text = '[remote "old"]\n\turl = u\n';
          const op: ConfigOperation = {
            kind: 'renameSection',
            section: 'remote',
            from: 'old',
            to: 'new',
          };

          // Act
          const result = applyConfigOpInText(text, op);

          // Assert
          expect(result).toBe('[remote "new"]\n\turl = u\n');
        });
      });
    });
  });

  describe('removeConfigSectionInText', () => {
    describe('Given a section that is the last block', () => {
      describe('When removeConfigSectionInText removes remote.origin', () => {
        it('Then the header and body are gone', () => {
          // Arrange
          const text = '[remote "origin"]\n\turl = u\n\tfetch = +A:B\n';

          // Act
          const sut = removeConfigSectionInText;
          const result = sut(text, 'remote.origin');

          // Assert
          expect(result).toBe('');
        });
      });
    });

    describe('Given a section followed by another section', () => {
      describe('When removeConfigSectionInText removes remote.origin', () => {
        it('Then the following section is preserved byte-for-byte', () => {
          // Arrange
          const text = '[remote "origin"]\n\turl = O\n[remote "upstream"]\n\turl = U\n';

          // Act
          const sut = removeConfigSectionInText;
          const result = sut(text, 'remote.origin');

          // Assert
          expect(result).toBe('[remote "upstream"]\n\turl = U\n');
        });
      });
    });

    describe('Given a section preceded by another section', () => {
      describe('When removeConfigSectionInText removes remote.origin', () => {
        it('Then the preceding section is preserved', () => {
          // Arrange
          const text = '[core]\n\tbare = false\n[remote "origin"]\n\turl = u\n';

          // Act
          const sut = removeConfigSectionInText;
          const result = sut(text, 'remote.origin');

          // Assert
          expect(result).toBe('[core]\n\tbare = false\n');
        });
      });
    });

    describe('Given no matching section', () => {
      describe('When removeConfigSectionInText removes remote.origin', () => {
        it('Then the text is byte-identical', () => {
          // Arrange
          const text = '[core]\n\tbare = false\n';

          // Act
          const sut = removeConfigSectionInText;
          const result = sut(text, 'remote.origin');

          // Assert
          expect(result).toBe(text);
        });
      });
    });

    describe('Given two matching section blocks (corrupt config)', () => {
      describe('When removeConfigSectionInText removes remote.origin', () => {
        it('Then every occurrence is removed', () => {
          // Arrange — two `[remote "origin"]` headers from a manually-edited file.
          const text =
            '[remote "origin"]\n\turl = A\n[core]\n\tbare = false\n[remote "origin"]\n\turl = B\n';

          // Act
          const sut = removeConfigSectionInText;
          const result = sut(text, 'remote.origin');

          // Assert
          expect(result).toBe('[core]\n\tbare = false\n');
        });
      });
    });

    describe('Given a section without a subsection', () => {
      describe('When removeConfigSectionInText removes core (no subsection)', () => {
        it('Then it removes the matching plain section', () => {
          // Arrange
          const text = '[core]\n\tbare = false\n[user]\n\tname = Ada\n';

          // Act
          const sut = removeConfigSectionInText;
          const result = sut(text, 'core');

          // Assert
          expect(result).toBe('[user]\n\tname = Ada\n');
        });
      });
    });

    describe('Given a section followed by another section with no trailing newline', () => {
      describe('When removeConfigSectionInText drops the first', () => {
        it('Then the output has no trailing newline either', () => {
          // Arrange — proves the `endedWithNewline` branch flips correctly.
          const text = '[remote "origin"]\n\turl = u\n[core]\n\tbare = false';

          // Act
          const sut = removeConfigSectionInText;
          const result = sut(text, 'remote.origin');

          // Assert
          expect(result).toBe('[core]\n\tbare = false');
        });
      });
    });

    describe('Given a raw oldName that would be syntactically invalid as a section name', () => {
      describe('When removeConfigSectionInText is called with oldName "core]\\n[evil"', () => {
        it('Then no validation occurs and the text is returned byte-identical (no match)', () => {
          // Arrange — raw matching never validates the old name; an invalid-looking
          // name is just a lookup miss, not a grammar error.
          const text = '[core]\n\ta = b\n';

          // Act
          const sut = removeConfigSectionInText;
          const result = sut(text, 'core]\n[evil');

          // Assert — matches nothing, text unchanged
          expect(result).toBe(text);
        });
      });
    });

    describe('Given a subsection containing a quote (a"b)', () => {
      describe('When removeConfigSectionInText removes remote.a"b', () => {
        it('Then the subsection is matched by its unescaped raw name and the section is removed', () => {
          // Arrange — parseSectionHeader unescapes \" → "; rawSectionName joins to
          // 'remote.a"b'; the raw name 'remote.a"b' matches exactly.
          const text = '[remote "a\\"b"]\n\turl = u\n';

          // Act
          const sut = removeConfigSectionInText;
          const result = sut(text, 'remote.a"b');

          // Assert — the section is removed
          expect(result).toBe('');
        });
      });
    });

    describe('Given a section whose body contains a multi-line tail with no lookalike header', () => {
      describe('When removeConfigSectionInText removes it', () => {
        it('Then the whole block including the tail is dropped (G2)', () => {
          // Arrange — row G2: [a] has a two-line continuation; no header-lookalike inside.
          // Canonical git's section machinery is line-based: body tails that do NOT
          // parse as a section header pass through removal unchanged — the entire block
          // (header + body lines + tails) is dropped. Replicating that byte-for-byte is
          // intended.
          const text = '[a]\n\tkey = one\\\n   two\n[b]\n\tk = v\n';

          // Act
          const sut = removeConfigSectionInText;
          const result = sut(text, 'a');

          // Assert
          expect(result).toBe('[b]\n\tk = v\n');
        });
      });
    });

    describe('Given a section whose body has a continuation tail that parses as a header', () => {
      describe('When removeConfigSectionInText removes the section', () => {
        it('Then removal stops at the lookalike tail, leaving lines the reader considers part of [a] (G3)', () => {
          // Arrange — row G3: `[a]` has `key = one\` then `[b]` on the next line.
          // The reader parses `a.key` as `one[b]` and `a.k` as `v` (the [b] line is
          // a continuation, not a header). But git's remove-section machinery is
          // line-based and treats `[b]` as the start of a new section — so removal
          // stops there, leaving `[b]\n\tk = v\n`. Replicating that byte-for-byte is
          // intended (the reader and writer disagree, same as git).
          const text = '[a]\n\tkey = one\\\n[b]\n\tk = v\n';

          // Act
          const sut = removeConfigSectionInText;
          const result = sut(text, 'a');

          // Assert
          expect(result).toBe('[b]\n\tk = v\n');
        });
      });
    });

    describe('Given a remove-section target whose name appears in continuation tails', () => {
      describe('When removeConfigSectionInText removes all [b] blocks', () => {
        it('Then both real blocks and the lookalike tail are removed, corrupting the preceding value (G5)', () => {
          // Arrange — row G5: `[a]` has `key = one\` then `[b]` (a lookalike tail);
          // two real `[b]` blocks follow. Removing section `b` hits all three — the
          // lookalike tail line is treated as a header and removed too, which corrupts
          // `a.key`'s value (now `one[d]`). Replicating that byte-for-byte is intended.
          const text = '[a]\n\tkey = one\\\n[b]\n\tinside-tail = t\n[b]\n\tk = v\n[d]\n\te = f\n';

          // Act
          const sut = removeConfigSectionInText;
          const result = sut(text, 'b');

          // Assert
          expect(result).toBe('[a]\n\tkey = one\\\n[d]\n\te = f\n');
        });
      });
    });
  });

  describe('removeConfigEntry validation', () => {
    describe('Given a section name containing a bracket', () => {
      describe('When removeConfigEntry', () => {
        it('Then it throws INVALID_OPTION', () => {
          // Arrange
          let caught: unknown;
          try {
            removeConfigEntry('', 'core]\n[evil', undefined, 'k');
          } catch (err) {
            caught = err;
          }

          // Assert
          expect((caught as TsgitError).data.code).toBe('INVALID_OPTION');
        });
      });
    });

    describe('Given a key containing a newline', () => {
      describe('When removeConfigEntry', () => {
        it('Then it throws INVALID_OPTION', () => {
          // Arrange
          let caught: unknown;
          try {
            removeConfigEntry('', 'remote', 'origin', 'k\ney');
          } catch (err) {
            caught = err;
          }

          // Assert
          expect((caught as TsgitError).data.code).toBe('INVALID_OPTION');
        });
      });
    });
  });

  describe('renameConfigSectionInText', () => {
    describe('Given a section block matching oldName remote.old', () => {
      describe('When renameConfigSectionInText renames remote.old to { section: remote, subsection: new }', () => {
        it('Then the header subsection becomes "new" and the body is preserved', () => {
          // Arrange
          const text = '[remote "old"]\n\turl = u\n\tfetch = +A:B\n';

          // Act
          const sut = renameConfigSectionInText;
          const result = sut(text, 'remote.old', { section: 'remote', subsection: 'new' });

          // Assert
          expect(result).toBe('[remote "new"]\n\turl = u\n\tfetch = +A:B\n');
        });
      });
    });

    describe('Given the section is one of several', () => {
      describe('When renameConfigSectionInText renames remote.old to { section: remote, subsection: new }', () => {
        it('Then unrelated sections are preserved', () => {
          // Arrange
          const text =
            '[core]\n\tbare = false\n[remote "old"]\n\turl = u\n[remote "other"]\n\turl = o\n';

          // Act
          const sut = renameConfigSectionInText;
          const result = sut(text, 'remote.old', { section: 'remote', subsection: 'new' });

          // Assert
          expect(result).toBe(
            '[core]\n\tbare = false\n[remote "new"]\n\turl = u\n[remote "other"]\n\turl = o\n',
          );
        });
      });
    });

    describe('Given no matching section', () => {
      describe('When renameConfigSectionInText renames remote.old to { section: remote, subsection: new }', () => {
        it('Then the text is byte-identical', () => {
          // Arrange
          const text = '[remote "other"]\n\turl = o\n';

          // Act
          const sut = renameConfigSectionInText;
          const result = sut(text, 'remote.old', { section: 'remote', subsection: 'new' });

          // Assert
          expect(result).toBe(text);
        });
      });
    });

    describe('Given the same section name twice', () => {
      describe('When renameConfigSectionInText renames remote.old to { section: remote, subsection: new }', () => {
        it('Then every occurrence is renamed', () => {
          // Arrange
          const text = '[remote "old"]\n\turl = A\n[remote "old"]\n\turl = B\n';

          // Act
          const sut = renameConfigSectionInText;
          const result = sut(text, 'remote.old', { section: 'remote', subsection: 'new' });

          // Assert
          expect(result).toBe('[remote "new"]\n\turl = A\n[remote "new"]\n\turl = B\n');
        });
      });
    });

    describe('Given a section with the `from` name in a different section family', () => {
      describe('When renameConfigSectionInText renames remote.old to { section: remote, subsection: new }', () => {
        it('Then only the targeted raw name is renamed, branch.old is untouched', () => {
          // Arrange — `[branch "old"]` raw name is 'branch.old', not 'remote.old'; must not match.
          const text = '[branch "old"]\n\tmerge = m\n[remote "old"]\n\turl = u\n';

          // Act
          const sut = renameConfigSectionInText;
          const result = sut(text, 'remote.old', { section: 'remote', subsection: 'new' });

          // Assert
          expect(result).toBe('[branch "old"]\n\tmerge = m\n[remote "new"]\n\turl = u\n');
        });
      });
    });

    describe('Given a new subsection containing a newline', () => {
      describe('When renameConfigSectionInText is called with to.subsection "ne\\nw"', () => {
        it('Then it throws INVALID_OPTION (LF divergence guard)', () => {
          // Arrange — rejectSubsection fires on the to.subsection before any I/O
          let caught: unknown;
          try {
            renameConfigSectionInText('', 'remote.old', { section: 'remote', subsection: 'ne\nw' });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data;
          expect(data.code).toBe('INVALID_OPTION');
          if (data.code === 'INVALID_OPTION') {
            expect(data.option).toBe('config');
            expect(data.reason).toBe('subsection must not contain a newline or NUL');
          }
        });
      });
    });

    describe('Given a new section name containing a bracket', () => {
      describe('When renameConfigSectionInText is called with to.section "bad]name"', () => {
        it('Then it throws INVALID_OPTION (section guard)', () => {
          // Arrange — rejectSection fires on to.section before any I/O
          let caught: unknown;
          try {
            renameConfigSectionInText('', 'remote.old', { section: 'bad]name' });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data;
          expect(data.code).toBe('INVALID_OPTION');
          if (data.code === 'INVALID_OPTION') {
            expect(data.option).toBe('config');
            expect(data.reason).toBe(
              'section must not contain whitespace, NUL, brackets, quotes, or backslashes',
            );
          }
        });
      });
    });

    describe('Given a new section name containing a space', () => {
      describe('When renameConfigSectionInText is called with to.section "a b"', () => {
        it('Then it throws INVALID_OPTION (unparseable-header guard)', () => {
          // Arrange — a space would render "[a b]", which git refuses to re-read
          let caught: unknown;
          try {
            renameConfigSectionInText('', 'remote.old', { section: 'a b' });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data;
          expect(data.code).toBe('INVALID_OPTION');
          if (data.code === 'INVALID_OPTION') {
            expect(data.option).toBe('config');
            expect(data.reason).toBe(
              'section must not contain whitespace, NUL, brackets, quotes, or backslashes',
            );
          }
        });
      });
    });

    describe('Given a new section name containing an opening bracket', () => {
      describe('When renameConfigSectionInText is called with to.section "a[b"', () => {
        it('Then it throws INVALID_OPTION (unparseable-header guard)', () => {
          // Arrange
          let caught: unknown;
          try {
            renameConfigSectionInText('', 'remote.old', { section: 'a[b' });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data;
          expect(data.code).toBe('INVALID_OPTION');
          if (data.code === 'INVALID_OPTION') {
            expect(data.option).toBe('config');
            expect(data.reason).toBe(
              'section must not contain whitespace, NUL, brackets, quotes, or backslashes',
            );
          }
        });
      });
    });

    describe('Given a new subsection containing a quote (a"b)', () => {
      describe('When renameConfigSectionInText renames remote.old to { section: remote, subsection: a"b }', () => {
        it('Then the quote is escaped and the new header is rendered as [remote "a\\"b"]', () => {
          // Arrange
          const text = '[remote "old"]\n\turl = u\n';

          // Act
          const sut = renameConfigSectionInText;
          const result = sut(text, 'remote.old', { section: 'remote', subsection: 'a"b' });

          // Assert — renderSectionHeader escapes " → \" in the subsection
          expect(result).toBe('[remote "a\\"b"]\n\turl = u\n');
        });
      });
    });

    describe('Given a new subsection containing a backslash (a\\b)', () => {
      describe('When renameConfigSectionInText renames remote.old to { section: remote, subsection: a\\b }', () => {
        it('Then the backslash is escaped and the new header is rendered as [remote "a\\\\b"]', () => {
          // Arrange
          const text = '[remote "old"]\n\turl = u\n';

          // Act
          const sut = renameConfigSectionInText;
          const result = sut(text, 'remote.old', { section: 'remote', subsection: 'a\\b' });

          // Assert — renderSectionHeader escapes \ → \\ in the subsection
          expect(result).toBe('[remote "a\\\\b"]\n\turl = u\n');
        });
      });
    });

    describe('Given a section with a continuation tail that parses as the rename target', () => {
      describe('When renameConfigSectionInText renames b.s to { section: b, subsection: t }', () => {
        it('Then both the real header and the lookalike tail are renamed (N1)', () => {
          // Arrange — row N1: `[a]` has `key = one\` then `[b "s"]` (a lookalike tail);
          // a real `[b "s"]` block follows. Canonical git's rename-section machinery is
          // line-based: the continuation tail that parses as `[b "s"]` is also renamed
          // to `[b "t"]`, changing `a.key`'s value from `one[b "s"]` to `one[b "t"]`.
          // Replicating that byte-for-byte is intended.
          const text = '[a]\n\tkey = one\\\n[b "s"]\n[b "s"]\n\tk = v\n';

          // Act
          const sut = renameConfigSectionInText;
          const result = sut(text, 'b.s', { section: 'b', subsection: 't' });

          // Assert
          expect(result).toBe('[a]\n\tkey = one\\\n[b "t"]\n[b "t"]\n\tk = v\n');
        });
      });
    });

    describe('Given a section with a continuation tail that does NOT parse as the rename target', () => {
      describe('When renameConfigSectionInText renames a.s to { section: a, subsection: t }', () => {
        it('Then the header is renamed and body tails pass through verbatim (N2)', () => {
          // Arrange — row N2: `[a "s"]` has a two-line continuation body tail `   two`.
          // That tail does not parse as any section header, so it passes through verbatim.
          const text = '[a "s"]\n\tkey = one\\\n   two\n[b]\n\tk = v\n';

          // Act
          const sut = renameConfigSectionInText;
          const result = sut(text, 'a.s', { section: 'a', subsection: 't' });

          // Assert
          expect(result).toBe('[a "t"]\n\tkey = one\\\n   two\n[b]\n\tk = v\n');
        });
      });
    });
  });

  describe('removeConfigSectionInText (subsectioned N3)', () => {
    describe('Given a section with a lookalike-tail followed by two real matching blocks', () => {
      describe('When removeConfigSectionInText removes b.s', () => {
        it('Then both real blocks and the lookalike tail line are removed, corrupting the preceding value (N3)', () => {
          // Arrange — row N3: `[a]` has `key = one\` then `[b "s"]` (lookalike tail);
          // two real `[b "s"]` blocks follow. Removing `b.s` hits all three via the
          // line-based machinery. Replicating that byte-for-byte is intended.
          const text =
            '[a]\n\tkey = one\\\n[b "s"]\n\tinside = t\n[b "s"]\n\tk = v\n[d]\n\te = f\n';

          // Act
          const sut = removeConfigSectionInText;
          const result = sut(text, 'b.s');

          // Assert
          expect(result).toBe('[a]\n\tkey = one\\\n[d]\n\te = f\n');
        });
      });
    });
  });

  describe('appendConfigEntry', () => {
    describe('Given an empty section name with no subsection', () => {
      describe('When appendConfigEntry is called', () => {
        it('Then it throws INVALID_OPTION instead of writing an unparseable [] header', () => {
          // Arrange
          let caught: unknown;
          try {
            appendConfigEntry('', '', undefined, 'k', 'v');
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data;
          expect(data.code).toBe('INVALID_OPTION');
          if (data.code === 'INVALID_OPTION') {
            expect(data.option).toBe('config');
            expect(data.reason).toBe('section name must not be empty without a subsection');
          }
        });
      });
    });

    describe('Given an existing section with one prior entry for the key', () => {
      describe('When appendConfigEntry', () => {
        it('Then the new entry is inserted AFTER the existing one (order preserved)', () => {
          // Arrange
          const text = '[remote "r"]\n\tfetch = A\n';

          // Act
          const sut = appendConfigEntry;
          const result = sut(text, 'remote', 'r', 'fetch', 'B');

          // Assert
          expect(result).toBe('[remote "r"]\n\tfetch = A\n\tfetch = B\n');
        });
      });
    });

    describe('Given an existing section with NO prior matching key', () => {
      describe('When appendConfigEntry', () => {
        it('Then the entry is inserted at the end of the section', () => {
          // Arrange
          const text = '[remote "r"]\n\turl = u\n';

          // Act
          const sut = appendConfigEntry;
          const result = sut(text, 'remote', 'r', 'fetch', 'A');

          // Assert — end-of-section insertion: fetch lands after url
          expect(result).toBe('[remote "r"]\n\turl = u\n\tfetch = A\n');
        });
      });
    });

    describe('Given a section is followed by another section', () => {
      describe('When appendConfigEntry', () => {
        it('Then a matching key in the LATER section is NOT considered', () => {
          // Arrange — `fetch = X` lives in the SECOND section; appending to
          // the first must insert at the end of the first section's block.
          const text = '[remote "r"]\n\turl = u\n[remote "other"]\n\tfetch = X\n';

          // Act
          const sut = appendConfigEntry;
          const result = sut(text, 'remote', 'r', 'fetch', 'A');

          // Assert — end-of-section insertion: fetch lands after url, before [remote "other"]
          expect(result).toBe(
            '[remote "r"]\n\turl = u\n\tfetch = A\n[remote "other"]\n\tfetch = X\n',
          );
        });
      });
    });

    describe('Given no matching section', () => {
      describe('When appendConfigEntry', () => {
        it('Then the section is created and the entry appended', () => {
          // Arrange
          const text = '[core]\n\tbare = false\n';

          // Act
          const sut = appendConfigEntry;
          const result = sut(text, 'remote', 'r', 'fetch', 'A');

          // Assert
          expect(result).toBe('[core]\n\tbare = false\n[remote "r"]\n\tfetch = A\n');
        });
      });
    });

    describe('Given a key containing a newline', () => {
      describe('When appendConfigEntry', () => {
        it('Then it throws INVALID_OPTION', () => {
          // Arrange
          let caught: unknown;
          try {
            appendConfigEntry('', 'remote', 'r', 'k\ney', 'v');
          } catch (err) {
            caught = err;
          }

          // Assert
          expect((caught as TsgitError).data.code).toBe('INVALID_OPTION');
        });
      });
    });

    describe('Given a valueless entry as the only prior occurrence of the key', () => {
      describe('When appendConfigEntry inserts after it', () => {
        it('Then the new entry is inserted AFTER the valueless line', () => {
          // Arrange — `key` appears valueless; appending should land after it.
          const text = '[remote "r"]\n\tkey\n';

          // Act
          const sut = appendConfigEntry;
          const result = sut(text, 'remote', 'r', 'key', 'B');

          // Assert — new entry after the valueless line.
          expect(result).toBe('[remote "r"]\n\tkey\n\tkey = B\n');
        });
      });
    });

    describe('Given a section with multiple unrelated keys', () => {
      describe('When appendConfigEntry adds a new fetch entry', () => {
        it('Then the appended entry lands at the end of the section, after unrelated keys', () => {
          // Arrange — row J: fetch = B appended to section that has url, fetch = A, push
          const text = '[remote "o"]\n\turl = u\n\tfetch = A\n\tpush = p\n';

          // Act
          const sut = appendConfigEntry;
          const result = sut(text, 'remote', 'o', 'fetch', 'B');

          // Assert — new fetch entry appended at the end of the section
          expect(result).toBe('[remote "o"]\n\turl = u\n\tfetch = A\n\tpush = p\n\tfetch = B\n');
        });
      });
    });

    describe('Given a section with a multi-line tail entry', () => {
      describe('When appendConfigEntry adds a new entry', () => {
        it('Then the appended entry lands after the multi-line tail', () => {
          // Arrange — row J2: section ends with a multi-line fetch entry
          const text = '[remote "o"]\n\tfetch = A\\\n   tail\n';

          // Act
          const sut = appendConfigEntry;
          const result = sut(text, 'remote', 'o', 'fetch', 'B');

          // Assert — new entry appended after the full span of the continuation
          expect(result).toBe('[remote "o"]\n\tfetch = A\\\n   tail\n\tfetch = B\n');
        });
      });
    });

    // ---------------------------------------------------------------------------
    // Append identity rows 7–9 from the pinned table
    // ---------------------------------------------------------------------------

    describe('Given an empty file, target subsection=""', () => {
      describe('When appendConfigEntry adds s..k with value v', () => {
        it('Then a new [s ""] section is created with k = v', () => {
          // Arrange
          const sut = appendConfigEntry;
          const text = '';

          // Act
          const result = sut(text, 's', '', 'k', 'v');

          // Assert
          expect(result).toBe('[s ""]\n\tk = v\n');
        });
      });
    });

    describe('Given [s ""] with k=v already (from the prior append), target subsection=""', () => {
      describe('When appendConfigEntry adds another s..k with value v2', () => {
        it('Then a second k entry is appended inside [s ""]', () => {
          // Arrange
          const sut = appendConfigEntry;
          const text = '[s ""]\n\tk = v\n';

          // Act
          const result = sut(text, 's', '', 'k', 'v2');

          // Assert — second entry appended inside the same [s ""] block
          expect(result).toBe('[s ""]\n\tk = v\n\tk = v2\n');
        });
      });
    });

    describe('Given empty-only.conf ([s ""] with k=b), target subsection=undefined', () => {
      describe('When appendConfigEntry adds s.k with value x', () => {
        it('Then a new [s] section is appended with k = x', () => {
          // Arrange
          const sut = appendConfigEntry;
          const text = '[s ""]\n\tk = b\n';

          // Act
          const result = sut(text, 's', undefined, 'k', 'x');

          // Assert — [s ""] untouched; new [s] appended
          expect(result).toBe('[s ""]\n\tk = b\n[s]\n\tk = x\n');
        });
      });
    });

    describe('Given [ ""] with k=v already, target section="" subsection=""', () => {
      describe('When appendConfigEntry adds another ..k with value v2', () => {
        it('Then the second entry is appended inside [ ""]', () => {
          // Arrange
          const sut = appendConfigEntry;
          const text = '[ ""]\n\tk = v\n';

          // Act
          const result = sut(text, '', '', 'k', 'v2');

          // Assert — appended inside the same [ ""] block
          expect(result).toBe('[ ""]\n\tk = v\n\tk = v2\n');
        });
      });
    });
  });

  describe('updateConfigOperations', () => {
    describe('Given a set and a removeEntry op', () => {
      describe('When updateConfigOperations', () => {
        it('Then both effects land in one write', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, '[remote "origin"]\n\turl = u\n\tfetch = +A:B\n');
          const ops: ReadonlyArray<ConfigOperation> = [
            { kind: 'set', section: 'core', key: 'bare', value: 'false' },
            { kind: 'removeEntry', section: 'remote', subsection: 'origin', key: 'fetch' },
          ];

          // Act
          await updateConfigOperations(ctx, ops);

          // Assert
          const written = await ctx.fs.readUtf8(configPath(ctx));
          expect(written).toContain('[core]');
          expect(written).toContain('bare = false');
          expect(written).toContain('[remote "origin"]');
          expect(written).toContain('url = u');
          expect(written).not.toContain('fetch = +A:B');
        });
      });
    });

    describe('Given a removeSection followed by a set against the same section', () => {
      describe('When updateConfigOperations', () => {
        it('Then the new section is present', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, '[remote "origin"]\n\turl = old\n');
          const ops: ReadonlyArray<ConfigOperation> = [
            { kind: 'removeSection', section: 'remote', subsection: 'origin' },
            { kind: 'set', section: 'remote', subsection: 'origin', key: 'url', value: 'new' },
          ];

          // Act
          await updateConfigOperations(ctx, ops);

          // Assert
          const written = await ctx.fs.readUtf8(configPath(ctx));
          expect(written).toContain('[remote "origin"]');
          expect(written).toContain('url = new');
          expect(written).not.toContain('url = old');
        });
      });
    });

    describe('Given a renameSection op', () => {
      describe('When updateConfigOperations', () => {
        it('Then the section is renamed and body preserved', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, '[remote "old"]\n\turl = u\n');
          const ops: ReadonlyArray<ConfigOperation> = [
            { kind: 'renameSection', section: 'remote', from: 'old', to: 'new' },
          ];

          // Act
          await updateConfigOperations(ctx, ops);

          // Assert
          const written = await ctx.fs.readUtf8(configPath(ctx));
          expect(written).toContain('[remote "new"]');
          expect(written).toContain('url = u');
          expect(written).not.toContain('[remote "old"]');
        });
      });
    });

    describe('Given an empty batch', () => {
      describe('When updateConfigOperations', () => {
        it('Then the on-disk text is unchanged', async () => {
          // Arrange
          const ctx = createMemoryContext();
          const initial = '[core]\n\tbare = false\n';
          await seed(ctx, initial);

          // Act
          await updateConfigOperations(ctx, []);

          // Assert
          const written = await ctx.fs.readUtf8(configPath(ctx));
          expect(written).toBe(initial);
        });
      });
    });

    describe('Given two appendEntry ops under the same section', () => {
      describe('When updateConfigOperations runs them in order', () => {
        it('Then on-disk order matches the call order (A before B)', async () => {
          // Arrange — order preservation is load-bearing for `remote rename`
          // when a remote carries multiple fetch refspecs; reversing would
          // change `.git/config`'s byte layout.
          const ctx = createMemoryContext();
          await seed(ctx, '');
          const ops: ReadonlyArray<ConfigOperation> = [
            { kind: 'appendEntry', section: 'remote', subsection: 'r', key: 'fetch', value: 'A' },
            { kind: 'appendEntry', section: 'remote', subsection: 'r', key: 'fetch', value: 'B' },
          ];

          // Act
          await updateConfigOperations(ctx, ops);

          // Assert
          const written = await ctx.fs.readUtf8(configPath(ctx));
          const aAt = written.indexOf('fetch = A');
          const bAt = written.indexOf('fetch = B');
          expect(aAt).toBeGreaterThan(-1);
          expect(bAt).toBeGreaterThan(-1);
          expect(aAt).toBeLessThan(bAt);
        });
      });
    });

    describe('Given a config cached by readConfig', () => {
      describe('When updateConfigOperations writes', () => {
        it('Then a later readConfig sees the new state', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, '[remote "origin"]\n\turl = u\n');
          await readConfig(ctx);

          // Act
          await updateConfigOperations(ctx, [
            { kind: 'removeSection', section: 'remote', subsection: 'origin' },
          ]);

          // Assert
          const reread = await readConfig(ctx);
          expect(reread.remote).toBeUndefined();
        });
      });
    });
  });
});

import {
  parseNewSectionName,
  removeConfigSection,
  renameConfigSection,
  setConfigEntry,
  unsetAllConfigEntries,
  unsetConfigEntry,
} from '../../../../src/application/primitives/update-config.js';

describe('setConfigEntry (I/O)', () => {
  describe('Given a missing local config, When setConfigEntry runs', () => {
    it('Then the file is created with the new entry', async () => {
      // Arrange
      const ctx = createMemoryContext();

      // Act
      await setConfigEntry({ ctx, key: 'user.name', value: 'Ada' });

      // Assert
      const text = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`);
      expect(text).toBe('[user]\n\tname = Ada\n');
    });
  });

  describe('Given an existing user.name = Ada, When setConfigEntry overwrites with Bob', () => {
    it('Then the entry is replaced in place (no duplicate)', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[user]\n\tname = Ada\n');

      // Act
      await setConfigEntry({ ctx, key: 'user.name', value: 'Bob' });

      // Assert
      const text = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`);
      expect(text).toBe('[user]\n\tname = Bob\n');
    });
  });

  describe('Given a value containing a `#`, When setConfigEntry runs', () => {
    it('Then the writer quotes it so it round-trips through the reader', async () => {
      // Arrange
      const ctx = createMemoryContext();

      // Act
      await setConfigEntry({ ctx, key: 'pager.log', value: 'less -R # paginate' });

      // Assert
      const text = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`);
      expect(text).toContain('"less -R # paginate"');
    });
  });

  describe('Given a key that fails parseConfigKey, When setConfigEntry is called', () => {
    it('Then no I/O happens and CONFIG_KEY_INVALID is thrown', async () => {
      // Arrange
      const ctx = createMemoryContext();
      const writeSpy = vi.spyOn(ctx.fs, 'writeUtf8');
      let caught: TsgitError | undefined;

      // Act
      try {
        await setConfigEntry({ ctx, key: '1bad.name', value: 'x' });
      } catch (err) {
        caught = err as TsgitError;
      }

      // Assert
      expect(caught?.data.code).toBe('CONFIG_KEY_INVALID');
      expect(writeSpy).toHaveBeenCalledTimes(0);
    });
  });

  describe('Given a value containing a NUL byte, When setConfigEntry runs', () => {
    it('Then no I/O happens and CONFIG_VALUE_INVALID is thrown with the NUL position', async () => {
      // Arrange
      const ctx = createMemoryContext();
      const writeSpy = vi.spyOn(ctx.fs, 'writeUtf8');
      let caught: TsgitError | undefined;

      // Act
      try {
        await setConfigEntry({ ctx, key: 'user.name', value: 'ab\x00cd' });
      } catch (err) {
        caught = err as TsgitError;
      }

      // Assert
      expect(caught?.data).toEqual({
        code: 'CONFIG_VALUE_INVALID',
        key: 'user.name',
        reason: 'control-character',
        position: 2,
      });
      expect(writeSpy).toHaveBeenCalledTimes(0);
    });
  });

  describe('Given a value containing a CR byte, When setConfigEntry runs', () => {
    it('Then the call succeeds (CR is accepted and written quoted with raw CR)', async () => {
      // Arrange
      const ctx = createMemoryContext();

      // Act + Assert (no throw)
      await expect(
        setConfigEntry({ ctx, key: 'user.name', value: 'x\ry' }),
      ).resolves.toBeUndefined();
    });
  });

  describe('Given a value containing a newline, When setConfigEntry runs', () => {
    it('Then the call succeeds (writer quotes and escapes \\n)', async () => {
      // Arrange
      const ctx = createMemoryContext();

      // Act + Assert (no throw)
      await expect(
        setConfigEntry({ ctx, key: 'user.name', value: 'a\nb' }),
      ).resolves.toBeUndefined();
    });
  });

  describe('Given a value containing a tab, When setConfigEntry runs', () => {
    it('Then the call succeeds verbatim', async () => {
      // Arrange
      const ctx = createMemoryContext();

      // Act + Assert (no throw)
      await expect(
        setConfigEntry({ ctx, key: 'user.name', value: 'a\tb' }),
      ).resolves.toBeUndefined();
    });
  });

  describe('Given scope: worktree without extensions.worktreeConfig, When setConfigEntry runs', () => {
    it('Then it throws CONFIG_SCOPE_NOT_AVAILABLE and no I/O happens', async () => {
      // Arrange
      const ctx = createMemoryContext();
      const writeSpy = vi.spyOn(ctx.fs, 'writeUtf8');
      let caught: TsgitError | undefined;

      // Act
      try {
        await setConfigEntry({ ctx, key: 'user.name', value: 'x', scope: 'worktree' });
      } catch (err) {
        caught = err as TsgitError;
      }

      // Assert
      expect(caught?.data).toEqual({
        code: 'CONFIG_SCOPE_NOT_AVAILABLE',
        scope: 'worktree',
        reason: 'worktree-extension-unset',
      });
      expect(writeSpy).toHaveBeenCalledTimes(0);
    });
  });

  describe('Given a value containing a C0 control byte (\\x01), When setConfigEntry runs', () => {
    it('Then the call succeeds (C0 controls are accepted and written verbatim)', async () => {
      // Arrange
      const ctx = createMemoryContext();

      // Act + Assert (no throw)
      await expect(
        setConfigEntry({ ctx, key: 'user.name', value: 'a\x01b' }),
      ).resolves.toBeUndefined();
    });
  });
});

describe('setConfigEntry round-trip', () => {
  describe('Given a value containing ;, When written and re-parsed via parseIniSections', () => {
    it('Then the parsed value equals the original', () => {
      // Arrange
      const value = 'a;b';

      // Act
      const text = setConfigEntryInText('', 'test', undefined, 'v', value);
      const sections = parseIniSections(text);
      const result = sections[0]?.entries[0]?.value;

      // Assert
      expect(result).toBe(value);
    });
  });

  describe('Given a value containing #, When written and re-parsed via parseIniSections', () => {
    it('Then the parsed value equals the original', () => {
      // Arrange
      const value = 'a#b';

      // Act
      const text = setConfigEntryInText('', 'test', undefined, 'v', value);
      const sections = parseIniSections(text);
      const result = sections[0]?.entries[0]?.value;

      // Assert
      expect(result).toBe(value);
    });
  });

  describe('Given a value with a leading space, When written and re-parsed via parseIniSections', () => {
    it('Then the parsed value equals the original', () => {
      // Arrange
      const value = ' a';

      // Act
      const text = setConfigEntryInText('', 'test', undefined, 'v', value);
      const sections = parseIniSections(text);
      const result = sections[0]?.entries[0]?.value;

      // Assert
      expect(result).toBe(value);
    });
  });

  describe('Given a value with a trailing space, When written and re-parsed via parseIniSections', () => {
    it('Then the parsed value equals the original', () => {
      // Arrange
      const value = 'a ';

      // Act
      const text = setConfigEntryInText('', 'test', undefined, 'v', value);
      const sections = parseIniSections(text);
      const result = sections[0]?.entries[0]?.value;

      // Assert
      expect(result).toBe(value);
    });
  });

  describe('Given a value containing CR (a\\rb), When written and re-parsed via parseIniSections', () => {
    it('Then the parsed value equals the original', () => {
      // Arrange
      const value = 'a\rb';

      // Act
      const text = setConfigEntryInText('', 'test', undefined, 'v', value);
      const sections = parseIniSections(text);
      const result = sections[0]?.entries[0]?.value;

      // Assert
      expect(result).toBe(value);
    });
  });

  describe('Given a value containing " (a"b), When written and re-parsed via parseIniSections', () => {
    it('Then the parsed value equals the original', () => {
      // Arrange
      const value = 'a"b';

      // Act
      const text = setConfigEntryInText('', 'test', undefined, 'v', value);
      const sections = parseIniSections(text);
      const result = sections[0]?.entries[0]?.value;

      // Assert
      expect(result).toBe(value);
    });
  });

  describe('Given a value containing \\ (a\\b), When written and re-parsed via parseIniSections', () => {
    it('Then the parsed value equals the original', () => {
      // Arrange
      const value = 'a\\b';

      // Act
      const text = setConfigEntryInText('', 'test', undefined, 'v', value);
      const sections = parseIniSections(text);
      const result = sections[0]?.entries[0]?.value;

      // Assert
      expect(result).toBe(value);
    });
  });

  describe('Given a value containing LF (a\\nb), When written and re-parsed via parseIniSections', () => {
    it('Then the parsed value equals the original', () => {
      // Arrange
      const value = 'a\nb';

      // Act
      const text = setConfigEntryInText('', 'test', undefined, 'v', value);
      const sections = parseIniSections(text);
      const result = sections[0]?.entries[0]?.value;

      // Assert
      expect(result).toBe(value);
    });
  });

  describe('Given a value containing TAB (a\\tb), When written and re-parsed via parseIniSections', () => {
    it('Then the parsed value equals the original', () => {
      // Arrange
      const value = 'a\tb';

      // Act
      const text = setConfigEntryInText('', 'test', undefined, 'v', value);
      const sections = parseIniSections(text);
      const result = sections[0]?.entries[0]?.value;

      // Assert
      expect(result).toBe(value);
    });
  });

  describe('Given a value with a leading TAB (\\ta), When written and re-parsed via parseIniSections', () => {
    it('Then the parsed value equals the original', () => {
      // Arrange
      const value = '\ta';

      // Act
      const text = setConfigEntryInText('', 'test', undefined, 'v', value);
      const sections = parseIniSections(text);
      const result = sections[0]?.entries[0]?.value;

      // Assert
      expect(result).toBe(value);
    });
  });

  describe('Given a combo value (a; b"c\\d ), When written and re-parsed via parseIniSections', () => {
    it('Then the parsed value equals the original', () => {
      // Arrange
      const value = 'a; b"c\\d ';

      // Act
      const text = setConfigEntryInText('', 'test', undefined, 'v', value);
      const sections = parseIniSections(text);
      const result = sections[0]?.entries[0]?.value;

      // Assert
      expect(result).toBe(value);
    });
  });

  describe('Given a value containing \\x01 (C0 control), When written and re-parsed via parseIniSections', () => {
    it('Then the parsed value equals the original', () => {
      // Arrange
      const value = 'a\x01b';

      // Act
      const text = setConfigEntryInText('', 'test', undefined, 'v', value);
      const sections = parseIniSections(text);
      const result = sections[0]?.entries[0]?.value;

      // Assert
      expect(result).toBe(value);
    });
  });

  describe('Given a value containing \\x7f (DEL), When written and re-parsed via parseIniSections', () => {
    it('Then the parsed value equals the original', () => {
      // Arrange
      const value = 'a\x7fb';

      // Act
      const text = setConfigEntryInText('', 'test', undefined, 'v', value);
      const sections = parseIniSections(text);
      const result = sections[0]?.entries[0]?.value;

      // Assert
      expect(result).toBe(value);
    });
  });
});

describe('unsetConfigEntry (I/O)', () => {
  describe('Given user.name = Ada in local, When unsetConfigEntry runs', () => {
    it('Then the key line is gone', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[user]\n\tname = Ada\n');

      // Act
      await unsetConfigEntry({ ctx, key: 'user.name' });

      // Assert
      const text = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`);
      expect(text).not.toContain('Ada');
    });
  });

  describe('Given user.name absent, When unsetConfigEntry runs', () => {
    it('Then no I/O happens (idempotent)', async () => {
      // Arrange
      const ctx = createMemoryContext();
      const writeSpy = vi.spyOn(ctx.fs, 'writeUtf8');

      // Act
      await unsetConfigEntry({ ctx, key: 'user.name' });

      // Assert
      expect(writeSpy).toHaveBeenCalledTimes(0);
    });
  });

  describe('Given a multi-valued key, When unsetConfigEntry runs', () => {
    it('Then it throws CONFIG_MULTIPLE_VALUES with requested=remove', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[user]\n\tname = Ada\n\tname = Bob\n');
      let caught: TsgitError | undefined;

      // Act
      try {
        await unsetConfigEntry({ ctx, key: 'user.name' });
      } catch (err) {
        caught = err as TsgitError;
      }

      // Assert
      expect(caught?.data).toEqual({
        code: 'CONFIG_MULTIPLE_VALUES',
        key: 'user.name',
        count: 2,
        requested: 'remove',
        scope: 'local',
      });
    });
  });

  describe('Given an invalid key, When unsetConfigEntry runs', () => {
    it('Then it throws CONFIG_KEY_INVALID and no I/O happens', async () => {
      // Arrange
      const ctx = createMemoryContext();
      const writeSpy = vi.spyOn(ctx.fs, 'writeUtf8');
      let caught: TsgitError | undefined;

      // Act
      try {
        await unsetConfigEntry({ ctx, key: '1bad.name' });
      } catch (err) {
        caught = err as TsgitError;
      }

      // Assert
      expect(caught?.data.code).toBe('CONFIG_KEY_INVALID');
      expect(writeSpy).toHaveBeenCalledTimes(0);
    });
  });
});

describe('unsetAllConfigEntries (I/O)', () => {
  describe('Given a multi-valued key, When unsetAllConfigEntries runs', () => {
    it('Then every matching line is removed', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await ctx.fs.writeUtf8(
        `${ctx.layout.gitDir}/config`,
        '[remote "origin"]\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n\tfetch = +refs/tags/*:refs/tags/*\n',
      );

      // Act
      await unsetAllConfigEntries({ ctx, key: 'remote.origin.fetch' });

      // Assert
      const text = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`);
      expect(text).not.toContain('fetch =');
    });
  });

  describe('Given the key absent, When unsetAllConfigEntries runs', () => {
    it('Then no I/O happens', async () => {
      // Arrange
      const ctx = createMemoryContext();
      const writeSpy = vi.spyOn(ctx.fs, 'writeUtf8');

      // Act
      await unsetAllConfigEntries({ ctx, key: 'user.email' });

      // Assert
      expect(writeSpy).toHaveBeenCalledTimes(0);
    });
  });
});

describe('renameConfigSection (I/O)', () => {
  describe('Given [remote "origin"], When renamed to remote.upstream', () => {
    it('Then the section header is rewritten', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await ctx.fs.writeUtf8(
        `${ctx.layout.gitDir}/config`,
        '[remote "origin"]\n\turl = git@example.com:r.git\n',
      );

      // Act
      await renameConfigSection({
        ctx,
        oldName: 'remote.origin',
        newName: 'remote.upstream',
      });

      // Assert
      const text = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`);
      expect(text).toContain('[remote "upstream"]');
      expect(text).not.toContain('[remote "origin"]');
    });
  });

  describe('Given a missing section, When renameConfigSection runs', () => {
    it('Then it throws CONFIG_SECTION_NOT_FOUND', async () => {
      // Arrange
      const ctx = createMemoryContext();
      let caught: TsgitError | undefined;

      // Act
      try {
        await renameConfigSection({
          ctx,
          oldName: 'remote.origin',
          newName: 'remote.upstream',
        });
      } catch (err) {
        caught = err as TsgitError;
      }

      // Assert
      expect(caught?.data).toEqual({
        code: 'CONFIG_SECTION_NOT_FOUND',
        name: 'remote.origin',
        scope: 'local',
      });
    });
  });

  describe('Given [remote "origin"] seeded, When renameConfigSection renames remote.origin to branch.main', () => {
    it('Then the header is rewritten to [branch "main"] (cross-family allowed)', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await ctx.fs.writeUtf8(
        `${ctx.layout.gitDir}/config`,
        '[remote "origin"]\n\turl = git@example.com:r.git\n',
      );

      // Act
      await renameConfigSection({
        ctx,
        oldName: 'remote.origin',
        newName: 'branch.main',
      });

      // Assert
      const text = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`);
      expect(text).toBe('[branch "main"]\n\turl = git@example.com:r.git\n');
    });
  });

  describe('Given no [user] block seeded, When renameConfigSection renames "user" to "team"', () => {
    it('Then it throws CONFIG_SECTION_NOT_FOUND with name "user"', async () => {
      // Arrange
      const ctx = createMemoryContext();
      let caught: TsgitError | undefined;

      // Act
      try {
        await renameConfigSection({ ctx, oldName: 'user', newName: 'team' });
      } catch (err) {
        caught = err as TsgitError;
      }

      // Assert
      expect(caught?.data).toEqual({
        code: 'CONFIG_SECTION_NOT_FOUND',
        name: 'user',
        scope: 'local',
      });
    });
  });

  describe('Given [user] block seeded, When renameConfigSection renames "user" to "team"', () => {
    it('Then the header becomes [team] and the body is preserved', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[user]\n\tname = Ada\n');

      // Act
      await renameConfigSection({ ctx, oldName: 'user', newName: 'team' });

      // Assert
      const text = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`);
      expect(text).toBe('[team]\n\tname = Ada\n');
    });
  });
});

describe('removeConfigSection (I/O)', () => {
  describe('Given [remote "origin"] present, When removeConfigSection runs', () => {
    it('Then the block is gone', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await ctx.fs.writeUtf8(
        `${ctx.layout.gitDir}/config`,
        '[remote "origin"]\n\turl = x\n[user]\n\tname = Ada\n',
      );

      // Act
      await removeConfigSection({ ctx, sectionName: 'remote.origin' });

      // Assert
      const text = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`);
      expect(text).not.toContain('[remote "origin"]');
      expect(text).toContain('[user]');
    });
  });

  describe('Given the section absent, When removeConfigSection runs', () => {
    it('Then it throws CONFIG_SECTION_NOT_FOUND', async () => {
      // Arrange
      const ctx = createMemoryContext();
      let caught: TsgitError | undefined;

      // Act
      try {
        await removeConfigSection({ ctx, sectionName: 'remote.origin' });
      } catch (err) {
        caught = err as TsgitError;
      }

      // Assert
      expect(caught?.data).toEqual({
        code: 'CONFIG_SECTION_NOT_FOUND',
        name: 'remote.origin',
        scope: 'local',
      });
    });
  });

  describe('Given only [remote "origin"] present, When removeConfigSection is called with "remote" (no dot)', () => {
    it('Then it throws CONFIG_SECTION_NOT_FOUND with name "remote" (old name never validated)', async () => {
      // Arrange — only [remote "origin"] present; raw name "remote" matches nothing
      const ctx = createMemoryContext();
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[remote "origin"]\n\turl = x\n');
      let caught: TsgitError | undefined;

      // Act
      try {
        await removeConfigSection({ ctx, sectionName: 'remote' });
      } catch (err) {
        caught = err as TsgitError;
      }

      // Assert
      expect(caught?.data).toEqual({
        code: 'CONFIG_SECTION_NOT_FOUND',
        name: 'remote',
        scope: 'local',
      });
    });
  });
});

describe('parseNewSectionName', () => {
  const sut = parseNewSectionName;

  describe('Given accepted new-name inputs', () => {
    describe('When parseNewSectionName parses "t.a.b"', () => {
      it('Then returns { section: "t", subsection: "a.b" } (first-dot split)', () => {
        // Arrange + Act
        const result = sut('t.a.b');
        // Assert
        expect(result).toEqual({ section: 't', subsection: 'a.b' });
      });
    });

    describe('When parseNewSectionName parses "1num"', () => {
      it('Then returns { section: "1num" } (digit-leading accepted)', () => {
        // Arrange + Act
        const result = sut('1num');
        // Assert
        expect(result).toEqual({ section: '1num' });
      });
    });

    describe('When parseNewSectionName parses "t-x"', () => {
      it('Then returns { section: "t-x" }', () => {
        // Arrange + Act
        const result = sut('t-x');
        // Assert
        expect(result).toEqual({ section: 't-x' });
      });
    });

    describe('When parseNewSectionName parses "t.bad!sub"', () => {
      it('Then returns { section: "t", subsection: "bad!sub" } (subsection free after first dot)', () => {
        // Arrange + Act
        const result = sut('t.bad!sub');
        // Assert
        expect(result).toEqual({ section: 't', subsection: 'bad!sub' });
      });
    });

    describe("When parseNewSectionName parses 't.with\"quote'", () => {
      it('Then returns { section: "t", subsection: \'with"quote\' } (quote in subsection accepted)', () => {
        // Arrange + Act
        const result = sut('t.with"quote');
        // Assert
        expect(result).toEqual({ section: 't', subsection: 'with"quote' });
      });
    });

    describe('When parseNewSectionName parses "T.Y"', () => {
      it('Then returns { section: "T", subsection: "Y" } (case preserved)', () => {
        // Arrange + Act
        const result = sut('T.Y');
        // Assert
        expect(result).toEqual({ section: 'T', subsection: 'Y' });
      });
    });

    describe('When parseNewSectionName parses "t."', () => {
      it('Then returns { section: "t", subsection: "" } (trailing dot = empty subsection)', () => {
        // Arrange + Act
        const result = sut('t.');
        // Assert
        expect(result).toEqual({ section: 't', subsection: '' });
      });
    });

    describe('When parseNewSectionName parses "."', () => {
      it('Then returns { section: "", subsection: "" }', () => {
        // Arrange + Act
        const result = sut('.');
        // Assert
        expect(result).toEqual({ section: '', subsection: '' });
      });
    });

    describe('When parseNewSectionName parses ".x"', () => {
      it('Then returns { section: "", subsection: "x" }', () => {
        // Arrange + Act
        const result = sut('.x');
        // Assert
        expect(result).toEqual({ section: '', subsection: 'x' });
      });
    });

    describe('When parseNewSectionName parses "a" (single alnum char)', () => {
      it('Then returns { section: "a" }', () => {
        // Arrange + Act
        const result = sut('a');
        // Assert
        expect(result).toEqual({ section: 'a' });
      });
    });

    describe('When parseNewSectionName parses "tz.y" (letter-only section)', () => {
      it('Then returns { section: "tz", subsection: "y" }', () => {
        // Arrange + Act
        const result = sut('tz.y');
        // Assert
        expect(result).toEqual({ section: 'tz', subsection: 'y' });
      });
    });
  });

  describe('Given refused new-name inputs', () => {
    describe('When parseNewSectionName parses "" (empty)', () => {
      it('Then throws INVALID_OPTION with reason "invalid section name: "', () => {
        // Arrange
        let caught: TsgitError | undefined;

        // Act
        try {
          sut('');
        } catch (err) {
          caught = err as TsgitError;
        }

        // Assert
        expect(caught?.data).toEqual({
          code: 'INVALID_OPTION',
          option: 'config',
          reason: 'invalid section name: ',
        });
      });
    });

    describe('When parseNewSectionName parses "t_x" (underscore in section)', () => {
      it('Then throws INVALID_OPTION with reason "invalid section name: t_x"', () => {
        // Arrange
        let caught: TsgitError | undefined;

        // Act
        try {
          sut('t_x');
        } catch (err) {
          caught = err as TsgitError;
        }

        // Assert
        expect(caught?.data).toEqual({
          code: 'INVALID_OPTION',
          option: 'config',
          reason: 'invalid section name: t_x',
        });
      });
    });

    describe('When parseNewSectionName parses "bad!name" (bang in section)', () => {
      it('Then throws INVALID_OPTION with reason "invalid section name: bad!name"', () => {
        // Arrange
        let caught: TsgitError | undefined;

        // Act
        try {
          sut('bad!name');
        } catch (err) {
          caught = err as TsgitError;
        }

        // Assert
        expect(caught?.data).toEqual({
          code: 'INVALID_OPTION',
          option: 'config',
          reason: 'invalid section name: bad!name',
        });
      });
    });

    describe('When parseNewSectionName parses "t!x.y" (bad char before first dot)', () => {
      it('Then throws INVALID_OPTION with reason "invalid section name: t!x.y"', () => {
        // Arrange
        let caught: TsgitError | undefined;

        // Act
        try {
          sut('t!x.y');
        } catch (err) {
          caught = err as TsgitError;
        }

        // Assert
        expect(caught?.data).toEqual({
          code: 'INVALID_OPTION',
          option: 'config',
          reason: 'invalid section name: t!x.y',
        });
      });
    });
  });
});

describe('renameConfigSection — extended porcelain I/O', () => {
  const bothConf = '[s]\n\tk = a\n[s ""]\n\tk = b\n';
  const mixConf = '[s]\n\tk = a\n[s "x"]\n\tk = b\n[s ""]\n\tk = c\n';
  const nameMixConf = '[ ""]\n\tk = e\n[s]\n\tk = a\n[s ""]\n\tk = b\n';

  describe('Given both.conf seeded ([s] k=a · [s ""] k=b)', () => {
    describe('When renameConfigSection renames "s" (plain) to "t"', () => {
      it('Then only [s] becomes [t], [s ""] is unchanged', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, bothConf);

        // Act
        await renameConfigSection({ ctx, oldName: 's', newName: 't' });

        // Assert
        const text = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`);
        expect(text).toBe('[t]\n\tk = a\n[s ""]\n\tk = b\n');
      });
    });

    describe('When renameConfigSection renames "s." (trailing-dot) to "t."', () => {
      it('Then only [s ""] becomes [t ""], [s] is unchanged', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, bothConf);

        // Act
        await renameConfigSection({ ctx, oldName: 's.', newName: 't.' });

        // Assert
        const text = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`);
        expect(text).toBe('[s]\n\tk = a\n[t ""]\n\tk = b\n');
      });
    });

    describe('When renameConfigSection renames "s." to "t" (trailing-dot to plain)', () => {
      it('Then [s ""] becomes [t], [s] unchanged', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, bothConf);

        // Act
        await renameConfigSection({ ctx, oldName: 's.', newName: 't' });

        // Assert
        const text = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`);
        expect(text).toBe('[s]\n\tk = a\n[t]\n\tk = b\n');
      });
    });

    describe('When renameConfigSection renames "s" to "s." (plain to trailing-dot)', () => {
      it('Then [s] becomes a second [s ""] (duplicate headers allowed)', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, bothConf);

        // Act
        await renameConfigSection({ ctx, oldName: 's', newName: 's.' });

        // Assert
        const text = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`);
        expect(text).toBe('[s ""]\n\tk = a\n[s ""]\n\tk = b\n');
      });
    });
  });

  describe('Given mix.conf seeded ([s] k=a · [s "x"] k=b · [s ""] k=c)', () => {
    describe('When renameConfigSection renames "s" to "t"', () => {
      it('Then only [s] becomes [t], [s "x"] and [s ""] are unchanged', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, mixConf);

        // Act
        await renameConfigSection({ ctx, oldName: 's', newName: 't' });

        // Assert
        const text = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`);
        expect(text).toBe('[t]\n\tk = a\n[s "x"]\n\tk = b\n[s ""]\n\tk = c\n');
      });
    });

    describe('When renameConfigSection renames "s.x" to "t.y"', () => {
      it('Then only [s "x"] becomes [t "y"]', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, mixConf);

        // Act
        await renameConfigSection({ ctx, oldName: 's.x', newName: 't.y' });

        // Assert
        const text = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`);
        expect(text).toBe('[s]\n\tk = a\n[t "y"]\n\tk = b\n[s ""]\n\tk = c\n');
      });
    });

    describe('When renameConfigSection renames "s.x" to "t" (subsection to plain)', () => {
      it('Then [s "x"] becomes [t]', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, mixConf);

        // Act
        await renameConfigSection({ ctx, oldName: 's.x', newName: 't' });

        // Assert
        const text = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`);
        expect(text).toBe('[s]\n\tk = a\n[t]\n\tk = b\n[s ""]\n\tk = c\n');
      });
    });

    describe('When renameConfigSection renames "s" to "t.y" (plain to subsectioned)', () => {
      it('Then [s] becomes [t "y"]', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, mixConf);

        // Act
        await renameConfigSection({ ctx, oldName: 's', newName: 't.y' });

        // Assert
        const text = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`);
        expect(text).toBe('[t "y"]\n\tk = a\n[s "x"]\n\tk = b\n[s ""]\n\tk = c\n');
      });
    });
  });

  describe('Given name-mix.conf seeded ([ ""] k=e · [s] k=a · [s ""] k=b)', () => {
    describe('When renameConfigSection renames "." to "t"', () => {
      it('Then [ ""] becomes [t]', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, nameMixConf);

        // Act
        await renameConfigSection({ ctx, oldName: '.', newName: 't' });

        // Assert
        const text = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`);
        expect(text).toBe('[t]\n\tk = e\n[s]\n\tk = a\n[s ""]\n\tk = b\n');
      });
    });

    describe('When renameConfigSection renames "." to "t."', () => {
      it('Then [ ""] becomes [t ""]', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, nameMixConf);

        // Act
        await renameConfigSection({ ctx, oldName: '.', newName: 't.' });

        // Assert
        const text = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`);
        expect(text).toBe('[t ""]\n\tk = e\n[s]\n\tk = a\n[s ""]\n\tk = b\n');
      });
    });

    describe('When renameConfigSection renames "." to ".x"', () => {
      it('Then [ ""] becomes [ "x"]', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, nameMixConf);

        // Act
        await renameConfigSection({ ctx, oldName: '.', newName: '.x' });

        // Assert
        const text = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`);
        expect(text).toBe('[ "x"]\n\tk = e\n[s]\n\tk = a\n[s ""]\n\tk = b\n');
      });
    });

    describe('When renameConfigSection renames "." to "s.x"', () => {
      it('Then [ ""] becomes [s "x"]', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, nameMixConf);

        // Act
        await renameConfigSection({ ctx, oldName: '.', newName: 's.x' });

        // Assert
        const text = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`);
        expect(text).toBe('[s "x"]\n\tk = e\n[s]\n\tk = a\n[s ""]\n\tk = b\n');
      });
    });

    describe('When renameConfigSection renames "s" to "." on name-mix.conf', () => {
      it('Then [s] becomes a second [ ""] block', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, nameMixConf);

        // Act
        await renameConfigSection({ ctx, oldName: 's', newName: '.' });

        // Assert
        const text = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`);
        expect(text).toBe('[ ""]\n\tk = e\n[ ""]\n\tk = a\n[s ""]\n\tk = b\n');
      });
    });
  });

  describe('Given CONFIG_SECTION_NOT_FOUND scenarios', () => {
    describe('When renameConfigSection is called with case-mismatched old name ("s" vs [S])', () => {
      it('Then throws CONFIG_SECTION_NOT_FOUND with name "s"', async () => {
        // Arrange — file has [S] but we search for s (case-sensitive raw match)
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[S]\n\tk = a\n');
        let caught: TsgitError | undefined;

        // Act
        try {
          await renameConfigSection({ ctx, oldName: 's', newName: 't' });
        } catch (err) {
          caught = err as TsgitError;
        }

        // Assert
        expect(caught?.data).toEqual({
          code: 'CONFIG_SECTION_NOT_FOUND',
          name: 's',
          scope: 'local',
        });
      });
    });

    describe('When renameConfigSection is called with old name "bad!name"', () => {
      it('Then throws CONFIG_SECTION_NOT_FOUND with name "bad!name" (old name never validated)', async () => {
        // Arrange
        const ctx = createMemoryContext();
        let caught: TsgitError | undefined;

        // Act
        try {
          await renameConfigSection({ ctx, oldName: 'bad!name', newName: 't' });
        } catch (err) {
          caught = err as TsgitError;
        }

        // Assert
        expect(caught?.data).toEqual({
          code: 'CONFIG_SECTION_NOT_FOUND',
          name: 'bad!name',
          scope: 'local',
        });
      });
    });

    describe('When renameConfigSection is called with old name "" (empty)', () => {
      it('Then throws CONFIG_SECTION_NOT_FOUND with name "" (old name never validated)', async () => {
        // Arrange
        const ctx = createMemoryContext();
        let caught: TsgitError | undefined;

        // Act
        try {
          await renameConfigSection({ ctx, oldName: '', newName: 't' });
        } catch (err) {
          caught = err as TsgitError;
        }

        // Assert
        expect(caught?.data).toEqual({
          code: 'CONFIG_SECTION_NOT_FOUND',
          name: '',
          scope: 'local',
        });
      });
    });
  });

  describe('Given new name contains a LF in its subsection part', () => {
    describe('When renameConfigSection is called with newName "t.a\\nb"', () => {
      it('Then throws INVALID_OPTION before any I/O (tsgit refuses LF in subsections)', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[s]\n\tk = a\n');
        const writeSpy = vi.spyOn(ctx.fs, 'writeUtf8');
        let caught: TsgitError | undefined;

        // Act
        try {
          await renameConfigSection({ ctx, oldName: 's', newName: 't.a\nb' });
        } catch (err) {
          caught = err as TsgitError;
        }

        // Assert
        expect(caught?.data).toEqual({
          code: 'INVALID_OPTION',
          option: 'config',
          reason: 'subsection must not contain a newline or NUL',
        });
        expect(writeSpy).not.toHaveBeenCalled();
      });
    });
  });
});

describe('removeConfigSection — extended porcelain I/O', () => {
  const bothConf = '[s]\n\tk = a\n[s ""]\n\tk = b\n';
  const mixConf = '[s]\n\tk = a\n[s "x"]\n\tk = b\n[s ""]\n\tk = c\n';
  const nameMixConf = '[ ""]\n\tk = e\n[s]\n\tk = a\n[s ""]\n\tk = b\n';

  describe('Given both.conf ([s] k=a · [s ""] k=b)', () => {
    describe('When removeConfigSection removes "s" (plain)', () => {
      it('Then only [s] is removed; [s ""] k=b survives', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, bothConf);

        // Act
        await removeConfigSection({ ctx, sectionName: 's' });

        // Assert
        const text = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`);
        expect(text).toBe('[s ""]\n\tk = b\n');
      });
    });

    describe('When removeConfigSection removes "s." (trailing-dot)', () => {
      it('Then only [s ""] is removed; [s] k=a survives', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, bothConf);

        // Act
        await removeConfigSection({ ctx, sectionName: 's.' });

        // Assert
        const text = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`);
        expect(text).toBe('[s]\n\tk = a\n');
      });
    });

    describe('When removeConfigSection removes \'s.""\'', () => {
      it('Then throws CONFIG_SECTION_NOT_FOUND (two-quote-char name matches nothing)', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, bothConf);
        let caught: TsgitError | undefined;

        // Act
        try {
          await removeConfigSection({ ctx, sectionName: 's.""' });
        } catch (err) {
          caught = err as TsgitError;
        }

        // Assert
        expect(caught?.data).toEqual({
          code: 'CONFIG_SECTION_NOT_FOUND',
          name: 's.""',
          scope: 'local',
        });
      });
    });
  });

  describe('Given mix.conf ([s] k=a · [s "x"] k=b · [s ""] k=c)', () => {
    describe('When removeConfigSection removes "s" (plain)', () => {
      it('Then only [s] is removed; [s "x"] and [s ""] survive', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, mixConf);

        // Act
        await removeConfigSection({ ctx, sectionName: 's' });

        // Assert
        const text = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`);
        expect(text).toBe('[s "x"]\n\tk = b\n[s ""]\n\tk = c\n');
      });
    });
  });

  describe('Given name-mix.conf ([ ""] k=e · [s] k=a · [s ""] k=b)', () => {
    describe('When removeConfigSection removes "." (empty-name section)', () => {
      it('Then only [ ""] is removed; [s] and [s ""] survive', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, nameMixConf);

        // Act
        await removeConfigSection({ ctx, sectionName: '.' });

        // Assert
        const text = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`);
        expect(text).toBe('[s]\n\tk = a\n[s ""]\n\tk = b\n');
      });
    });
  });

  describe('Given CONFIG_SECTION_NOT_FOUND scenarios', () => {
    describe('When removeConfigSection is called with "s." on a plain-only config', () => {
      it('Then throws CONFIG_SECTION_NOT_FOUND with name "s."', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[s]\n\tk = a\n');
        let caught: TsgitError | undefined;

        // Act
        try {
          await removeConfigSection({ ctx, sectionName: 's.' });
        } catch (err) {
          caught = err as TsgitError;
        }

        // Assert
        expect(caught?.data).toEqual({
          code: 'CONFIG_SECTION_NOT_FOUND',
          name: 's.',
          scope: 'local',
        });
      });
    });

    describe('When removeConfigSection is called with "s" on an empty-only config', () => {
      it('Then throws CONFIG_SECTION_NOT_FOUND with name "s"', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[s ""]\n\tk = b\n');
        let caught: TsgitError | undefined;

        // Act
        try {
          await removeConfigSection({ ctx, sectionName: 's' });
        } catch (err) {
          caught = err as TsgitError;
        }

        // Assert
        expect(caught?.data).toEqual({
          code: 'CONFIG_SECTION_NOT_FOUND',
          name: 's',
          scope: 'local',
        });
      });
    });

    describe('When removeConfigSection is called with "" (empty string)', () => {
      it('Then throws CONFIG_SECTION_NOT_FOUND with name "" (old name never validated)', async () => {
        // Arrange
        const ctx = createMemoryContext();
        let caught: TsgitError | undefined;

        // Act
        try {
          await removeConfigSection({ ctx, sectionName: '' });
        } catch (err) {
          caught = err as TsgitError;
        }

        // Assert
        expect(caught?.data).toEqual({
          code: 'CONFIG_SECTION_NOT_FOUND',
          name: '',
          scope: 'local',
        });
      });
    });

    describe('When removeConfigSection is called with "." when [ ""] is absent', () => {
      it('Then throws CONFIG_SECTION_NOT_FOUND with name "."', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[s]\n\tk = a\n');
        let caught: TsgitError | undefined;

        // Act
        try {
          await removeConfigSection({ ctx, sectionName: '.' });
        } catch (err) {
          caught = err as TsgitError;
        }

        // Assert
        expect(caught?.data).toEqual({
          code: 'CONFIG_SECTION_NOT_FOUND',
          name: '.',
          scope: 'local',
        });
      });
    });
  });
});

describe('write-path refusal on malformed config files', () => {
  const malformedHeaderText = '[s "a" x]\n\tk = v\n';
  const malformedValueText = '[s]\n\tk = "x\n';

  describe('setConfigEntry onto a file with a malformed header [s "a" x]', () => {
    describe('Given a config file whose header is [s "a" x]', () => {
      describe('When setConfigEntry is called', () => {
        it('Then it throws CONFIG_INVALID_FILE with sectionName s.a and the config path', async () => {
          // Arrange
          const ctx = createMemoryContext();
          const path = `${ctx.layout.gitDir}/config`;
          await ctx.fs.writeUtf8(path, malformedHeaderText);
          let caught: TsgitError | undefined;

          // Act
          try {
            await setConfigEntry({ ctx, key: 'core.bare', value: 'false' });
          } catch (err) {
            caught = err as TsgitError;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data;
          expect(data.code).toBe('CONFIG_INVALID_FILE');
          if (data.code !== 'CONFIG_INVALID_FILE') throw new Error('unreachable');
          expect(data.sectionName).toBe('s.a');
          expect(data.source).toBe(path);
        });
      });
    });
  });

  describe('setConfigEntry onto a file with a malformed value (unclosed quote)', () => {
    describe('Given a config file whose only malformation is an unclosed value quote', () => {
      describe('When setConfigEntry is called', () => {
        it('Then it throws CONFIG_PARSE_ERROR (not CONFIG_INVALID_FILE)', async () => {
          // Arrange
          const ctx = createMemoryContext();
          const path = `${ctx.layout.gitDir}/config`;
          await ctx.fs.writeUtf8(path, malformedValueText);
          let caught: TsgitError | undefined;

          // Act
          try {
            await setConfigEntry({ ctx, key: 'core.bare', value: 'false' });
          } catch (err) {
            caught = err as TsgitError;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data;
          expect(data.code).toBe('CONFIG_PARSE_ERROR');
          if (data.code !== 'CONFIG_PARSE_ERROR') throw new Error('unreachable');
          expect(data.line).toBe(2);
        });
      });
    });
  });

  describe('setConfigEntry refusal happens before I/O', () => {
    describe('Given a config file with a malformed header', () => {
      describe('When setConfigEntry is called', () => {
        it('Then no bytes are written to the file', async () => {
          // Arrange
          const ctx = createMemoryContext();
          const path = `${ctx.layout.gitDir}/config`;
          await ctx.fs.writeUtf8(path, malformedHeaderText);
          const writeSpy = vi.spyOn(ctx.fs, 'writeUtf8');
          let caught: TsgitError | undefined;

          // Act
          try {
            await setConfigEntry({ ctx, key: 'core.bare', value: 'false' });
          } catch (err) {
            caught = err as TsgitError;
          }

          // Assert
          expect(caught?.data.code).toBe('CONFIG_INVALID_FILE');
          expect(writeSpy).not.toHaveBeenCalled();
        });
      });
    });
  });

  describe('unsetConfigEntry onto a file with a malformed header [s "a" x]', () => {
    describe('Given a config file whose header is [s "a" x]', () => {
      describe('When unsetConfigEntry is called', () => {
        it('Then it throws CONFIG_INVALID_FILE with sectionName s.a and the config path', async () => {
          // Arrange
          const ctx = createMemoryContext();
          const path = `${ctx.layout.gitDir}/config`;
          await ctx.fs.writeUtf8(path, malformedHeaderText);
          let caught: TsgitError | undefined;

          // Act
          try {
            await unsetConfigEntry({ ctx, key: 'core.bare' });
          } catch (err) {
            caught = err as TsgitError;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data;
          expect(data.code).toBe('CONFIG_INVALID_FILE');
          if (data.code !== 'CONFIG_INVALID_FILE') throw new Error('unreachable');
          expect(data.sectionName).toBe('s.a');
          expect(data.source).toBe(path);
        });
      });
    });
  });

  describe('unsetAllConfigEntries onto a file with a malformed header [s "a" x]', () => {
    describe('Given a config file whose header is [s "a" x]', () => {
      describe('When unsetAllConfigEntries is called', () => {
        it('Then it throws CONFIG_INVALID_FILE with sectionName s.a and the config path', async () => {
          // Arrange
          const ctx = createMemoryContext();
          const path = `${ctx.layout.gitDir}/config`;
          await ctx.fs.writeUtf8(path, malformedHeaderText);
          let caught: TsgitError | undefined;

          // Act
          try {
            await unsetAllConfigEntries({ ctx, key: 'core.bare' });
          } catch (err) {
            caught = err as TsgitError;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data;
          expect(data.code).toBe('CONFIG_INVALID_FILE');
          if (data.code !== 'CONFIG_INVALID_FILE') throw new Error('unreachable');
          expect(data.sectionName).toBe('s.a');
          expect(data.source).toBe(path);
        });
      });
    });
  });

  describe('updateConfigEntries onto a file with a malformed header [s "a" x]', () => {
    describe('Given a config file whose header is [s "a" x]', () => {
      describe('When updateConfigEntries is called', () => {
        it('Then it throws CONFIG_INVALID_FILE with sectionName s.a and the config path', async () => {
          // Arrange
          const ctx = createMemoryContext();
          const path = `${ctx.layout.gitDir}/config`;
          await ctx.fs.writeUtf8(path, malformedHeaderText);
          let caught: TsgitError | undefined;

          // Act
          try {
            await updateConfigEntries(ctx, [{ section: 'core', key: 'bare', value: 'false' }]);
          } catch (err) {
            caught = err as TsgitError;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data;
          expect(data.code).toBe('CONFIG_INVALID_FILE');
          if (data.code !== 'CONFIG_INVALID_FILE') throw new Error('unreachable');
          expect(data.sectionName).toBe('s.a');
          expect(data.source).toBe(path);
        });
      });
    });
  });

  describe('updateConfigOperations onto a file with a malformed header [s "a" x]', () => {
    describe('Given a config file whose header is [s "a" x]', () => {
      describe('When updateConfigOperations is called', () => {
        it('Then it throws CONFIG_INVALID_FILE with sectionName s.a and the config path', async () => {
          // Arrange
          const ctx = createMemoryContext();
          const path = `${ctx.layout.gitDir}/config`;
          await ctx.fs.writeUtf8(path, malformedHeaderText);
          let caught: TsgitError | undefined;

          // Act
          try {
            await updateConfigOperations(ctx, [
              { kind: 'set', section: 'core', key: 'bare', value: 'false' },
            ]);
          } catch (err) {
            caught = err as TsgitError;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data;
          expect(data.code).toBe('CONFIG_INVALID_FILE');
          if (data.code !== 'CONFIG_INVALID_FILE') throw new Error('unreachable');
          expect(data.sectionName).toBe('s.a');
          expect(data.source).toBe(path);
        });
      });
    });
  });

  describe('renameConfigSection with a malformed header plus a well-formed section', () => {
    describe('Given a file with [s "a" x] malformed AND [t "x"] well-formed', () => {
      describe('When renameConfigSection renames t.x to t.y', () => {
        it('Then it succeeds, the malformed line is preserved byte-for-byte, and the [t] header is renamed', async () => {
          // Arrange
          const ctx = createMemoryContext();
          const path = `${ctx.layout.gitDir}/config`;
          const initial = '[s "a" x]\n\tbad = v\n[t "x"]\n\tgood = w\n';
          await ctx.fs.writeUtf8(path, initial);

          // Act
          await renameConfigSection({ ctx, oldName: 't.x', newName: 't.y' });

          // Assert
          const result = await ctx.fs.readUtf8(path);
          expect(result).toContain('[s "a" x]');
          expect(result).toContain('[t "y"]');
          expect(result).not.toContain('[t "x"]');
        });
      });
    });
  });

  describe('renameConfigSection whose source is the malformed header itself', () => {
    describe('Given a file with only [s "a" x] (malformed)', () => {
      describe('When renameConfigSection tries to rename s.a', () => {
        it('Then it throws CONFIG_SECTION_NOT_FOUND', async () => {
          // Arrange
          const ctx = createMemoryContext();
          const path = `${ctx.layout.gitDir}/config`;
          await ctx.fs.writeUtf8(path, '[s "a" x]\n\tk = v\n[s "b"]\n\tk = v\n');
          let caught: TsgitError | undefined;

          // Act
          try {
            await renameConfigSection({ ctx, oldName: 's.a', newName: 's.z' });
          } catch (err) {
            caught = err as TsgitError;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data;
          expect(data.code).toBe('CONFIG_SECTION_NOT_FOUND');
        });
      });
    });
  });

  describe('removeConfigSection on a file with a malformed header plus a well-formed section', () => {
    describe('Given a file with [s "a" x] malformed AND [t "x"] well-formed', () => {
      describe('When removeConfigSection removes t.x', () => {
        it('Then it succeeds and the malformed line is preserved byte-for-byte', async () => {
          // Arrange
          const ctx = createMemoryContext();
          const path = `${ctx.layout.gitDir}/config`;
          const initial = '[s "a" x]\n\tbad = v\n[t "x"]\n\tgood = w\n';
          await ctx.fs.writeUtf8(path, initial);

          // Act
          await removeConfigSection({ ctx, sectionName: 't.x' });

          // Assert
          const result = await ctx.fs.readUtf8(path);
          expect(result).toContain('[s "a" x]');
          expect(result).not.toContain('[t "x"]');
        });
      });
    });
  });

  describe('removeConfigSection on a file with a malformed value', () => {
    describe('Given a file with a well-formed header [t "x"] and a malformed-value section', () => {
      describe('When removeConfigSection removes t.x', () => {
        it('Then it succeeds (lenient — malformed values do not block rename/remove)', async () => {
          // Arrange
          const ctx = createMemoryContext();
          const path = `${ctx.layout.gitDir}/config`;
          await ctx.fs.writeUtf8(path, '[s]\n\tk = "x\n[t "x"]\n\tgood = w\n');

          // Act + Assert (no throw)
          await expect(removeConfigSection({ ctx, sectionName: 't.x' })).resolves.toBeUndefined();

          const result = await ctx.fs.readUtf8(path);
          expect(result).not.toContain('[t "x"]');
        });
      });
    });
  });

  // ---------------------------------------------------------------------------
  // unsetConfigEntry identity consistency (I/O)
  // ---------------------------------------------------------------------------

  describe('unsetConfigEntry identity consistency', () => {
    describe('Given both.conf ([s] k=a · [s ""] k=b) seeded into .git/config', () => {
      describe('When unsetConfigEntry removes s.k', () => {
        it('Then the file is exactly [s ""]\\n\\tk = b\\n (no over-delete)', async () => {
          // Arrange
          const ctx = createMemoryContext();
          const path = `${ctx.layout.gitDir}/config`;
          await ctx.fs.writeUtf8(path, '[s]\n\tk = a\n[s ""]\n\tk = b\n');

          // Act
          await unsetConfigEntry({ ctx, key: 's.k' });

          // Assert — only the plain [s] entry is removed; [s ""] is preserved byte-exact
          const result = await ctx.fs.readUtf8(path);
          expect(result).toBe('[s ""]\n\tk = b\n');
        });
      });
    });

    describe('Given [s] k=a · [s] k=c · [s ""] k=b seeded into .git/config', () => {
      describe('When unsetConfigEntry removes s.k', () => {
        it('Then it throws CONFIG_MULTIPLE_VALUES with count=2, key=s.k, requested=remove', async () => {
          // Arrange
          const ctx = createMemoryContext();
          const path = `${ctx.layout.gitDir}/config`;
          await ctx.fs.writeUtf8(path, '[s]\n\tk = a\n\tk = c\n[s ""]\n\tk = b\n');
          let caught: TsgitError | undefined;

          // Act
          try {
            await unsetConfigEntry({ ctx, key: 's.k' });
          } catch (err) {
            caught = err as TsgitError;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = caught?.data;
          expect(data).toEqual({
            code: 'CONFIG_MULTIPLE_VALUES',
            key: 's.k',
            count: 2,
            requested: 'remove',
            scope: 'local',
          });
        });
      });
    });
  });

  // ---------------------------------------------------------------------------
  // empty-section-name writes via I/O wrappers (memory context)
  // ---------------------------------------------------------------------------

  describe('setConfigEntry with empty-section-name keys', () => {
    describe('Given an empty .git/config and key "..k"', () => {
      describe('When setConfigEntry writes ..k = v', () => {
        it('Then the file is [ ""]\\n\\tk = v\\n', async () => {
          // Arrange
          const ctx = createMemoryContext();

          // Act
          await setConfigEntry({ ctx, key: '..k', value: 'v' });

          // Assert
          const result = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`);
          expect(result).toBe('[ ""]\n\tk = v\n');
        });
      });
    });

    describe('Given an empty .git/config and key ".x.k"', () => {
      describe('When setConfigEntry writes .x.k = v', () => {
        it('Then the file is [ "x"]\\n\\tk = v\\n', async () => {
          // Arrange
          const ctx = createMemoryContext();

          // Act
          await setConfigEntry({ ctx, key: '.x.k', value: 'v' });

          // Assert
          const result = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`);
          expect(result).toBe('[ "x"]\n\tk = v\n');
        });
      });
    });

    describe('Given plain-only.conf ([s] k=a) seeded, key "..k"', () => {
      describe('When setConfigEntry writes ..k = v', () => {
        it('Then [s] is untouched and a new [ ""] section is appended', async () => {
          // Arrange
          const ctx = createMemoryContext();
          const path = `${ctx.layout.gitDir}/config`;
          await ctx.fs.writeUtf8(path, '[s]\n\tk = a\n');

          // Act
          await setConfigEntry({ ctx, key: '..k', value: 'v' });

          // Assert
          const result = await ctx.fs.readUtf8(path);
          expect(result).toBe('[s]\n\tk = a\n[ ""]\n\tk = v\n');
        });
      });
    });

    describe('Given [ ""] k=v seeded and key "..k"', () => {
      describe('When unsetConfigEntry removes ..k', () => {
        it('Then the file is empty (block pruned)', async () => {
          // Arrange
          const ctx = createMemoryContext();
          const path = `${ctx.layout.gitDir}/config`;
          await ctx.fs.writeUtf8(path, '[ ""]\n\tk = v\n');

          // Act
          await unsetConfigEntry({ ctx, key: '..k' });

          // Assert — sole entry removed, block pruned to empty
          const result = await ctx.fs.readUtf8(path);
          expect(result).toBe('');
        });
      });
    });
  });
});
