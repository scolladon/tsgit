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
      describe('When setCoreConfigEntryInText runs on this malformed content', () => {
        it('Then it refuses with CONFIG_PARSE_ERROR on line 2 like git refuses the write', () => {
          // Arrange — `[not-a-header` starts with `[` but never closes, so it is not
          // a valid header and has no key char at its first column; git refuses the
          // whole write ("invalid section name") rather than replacing in place.
          const text = '[core]\n\t[not-a-header\n\tsparseCheckout = false\n';

          // Act + Assert
          const sut = setCoreConfigEntryInText;
          try {
            sut(text, 'sparseCheckout', 'true');
            expect.unreachable('setCoreConfigEntryInText must refuse the malformed bracket line');
          } catch (err) {
            if (!(err instanceof TsgitError)) throw err;
            expect(err.data.code).toBe('CONFIG_PARSE_ERROR');
            if (err.data.code === 'CONFIG_PARSE_ERROR') {
              expect(err.data.line).toBe(2);
            }
          }
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

    describe('Given a key line before the first section header, matching the target key', () => {
      describe('When setConfigEntryInText', () => {
        it('Then the pre-header line is left intact and the key is inserted inside the section', () => {
          // Arrange — `promisor` appears as an orphan line before any header; it is
          // not inside [remote "origin"], so it must NOT be treated as the match.
          const text = 'promisor = orphan\n[remote "origin"]\n\turl = u\n';

          // Act
          const sut = setConfigEntryInText;
          const result = sut(text, 'remote', 'origin', 'promisor', 'new');

          // Assert — orphan preserved; new key inserted at the end of the section block
          expect(result).toBe(
            'promisor = orphan\n[remote "origin"]\n\turl = u\n\tpromisor = new\n',
          );
        });
      });
    });

    describe('Given a key line before the first header and no matching target section', () => {
      describe('When setConfigEntryInText appends a fresh section', () => {
        it('Then the new section is appended at EOF, not spliced next to the pre-header line', () => {
          // Arrange — no [foo] block exists; the orphan pre-header entry must not
          // become the insertion anchor.
          const text = 'orphan = x\n[other]\n\ta = 1\n';

          // Act
          const sut = setConfigEntryInText;
          const result = sut(text, 'foo', undefined, 'k', 'v');

          // Assert — appended as a new [foo] section at the end of the file
          expect(result).toBe('orphan = x\n[other]\n\ta = 1\n[foo]\n\tk = v\n');
        });
      });
    });

    describe('Given the target block is followed by two or more unrelated sections', () => {
      describe('When setConfigEntryInText inserts a new key', () => {
        it('Then the key lands inside the first target block, not appended as a duplicate section', () => {
          // Arrange — [a] then [b] then [c]; the insertion point of [a] must survive
          // the later, non-target headers.
          const text = '[a]\n\tx = 1\n[b]\n\ty = 2\n[c]\n\tz = 3\n';

          // Act
          const sut = setConfigEntryInText;
          const result = sut(text, 'a', undefined, 'new', 'val');

          // Assert — inserted after `x = 1`, inside the original [a] block
          expect(result).toBe('[a]\n\tx = 1\n\tnew = val\n[b]\n\ty = 2\n[c]\n\tz = 3\n');
        });
      });
    });

    describe('Given a config that starts with a blank line and has no trailing newline', () => {
      describe('When setConfigEntryInText replaces an existing key on the final line', () => {
        it('Then the last-line entry is tokenized and replaced in place', () => {
          // Arrange — leading blank + no trailing newline: the trailing-newline flag
          // must come from `endsWith('\n')`, not `startsWith('\n')`.
          const text = '\n[a]\n\tk = v';

          // Act
          const sut = setConfigEntryInText;
          const result = sut(text, 'a', undefined, 'k', 'new');

          // Assert — the final `k` line is found and rewritten; no duplicate is inserted
          expect(result).toBe('\n[a]\n\tk = new\n');
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

    describe('Given a value with an escaping-relevant characteristic', () => {
      describe('When setConfigEntryInText renders it', () => {
        it.each([
          {
            section: 'pager',
            key: 'log',
            value: 'less # paginate',
            expected: '[pager]\n\tlog = "less # paginate"\n',
            label: 'a # triggers quoting',
          },
          {
            section: 'pager',
            key: 'log',
            value: 'less ; paginate',
            expected: '[pager]\n\tlog = "less ; paginate"\n',
            label: 'a ; triggers quoting',
          },
          {
            section: 'user',
            key: 'name',
            value: ' Ada',
            expected: '[user]\n\tname = " Ada"\n',
            label: 'a leading space triggers quoting',
          },
          {
            section: 'user',
            key: 'name',
            value: '\tAda',
            expected: '[user]\n\tname = \\tAda\n',
            label: 'a leading TAB is escaped and NOT quoted',
          },
          {
            section: 'user',
            key: 'name',
            value: 'Ada ',
            expected: '[user]\n\tname = "Ada "\n',
            label: 'a trailing space triggers quoting',
          },
          {
            section: 'user',
            key: 'name',
            value: 'Ada\t',
            expected: '[user]\n\tname = Ada\\t\n',
            label: 'a trailing TAB is escaped and NOT quoted',
          },
          {
            section: 'user',
            key: 'name',
            value: 'Ada "Lovelace"',
            expected: '[user]\n\tname = Ada \\"Lovelace\\"\n',
            label: 'an embedded " is escaped unconditionally, unquoted',
          },
          {
            section: 'core',
            key: 'editor',
            value: 'C:\\bin\\vim',
            expected: '[core]\n\teditor = C:\\\\bin\\\\vim\n',
            label: 'an embedded \\ is escaped unconditionally, unquoted',
          },
          {
            section: 'alias',
            key: 'lg',
            value: 'log\nshort',
            expected: '[alias]\n\tlg = log\\nshort\n',
            label: 'an embedded newline is escaped to \\n, unquoted',
          },
          {
            section: 'user',
            key: 'name',
            value: 'Ada',
            expected: '[user]\n\tname = Ada\n',
            label: 'a plain alphanumeric value is not quoted',
          },
          {
            section: 'user',
            key: 'name',
            value: 'A\tB',
            expected: '[user]\n\tname = A\\tB\n',
            label: 'an embedded TAB is escaped and NOT quoted',
          },
          {
            section: 'alias',
            key: 'lg',
            value: 'a\\b\nc',
            expected: '[alias]\n\tlg = a\\\\b\\nc\n',
            label: 'embedded \\ and \\n are both escaped (backslash first), unquoted',
          },
          {
            section: 'test',
            key: 'k',
            value: 'a;b',
            expected: '[test]\n\tk = "a;b"\n',
            label: 'a semicolon triggers quoting',
          },
          {
            section: 'test',
            key: 'k',
            value: 'a#b',
            expected: '[test]\n\tk = "a#b"\n',
            label: 'a hash triggers quoting',
          },
          {
            section: 'test',
            key: 'k',
            value: ' a',
            expected: '[test]\n\tk = " a"\n',
            label: 'a leading space triggers quoting (short value)',
          },
          {
            section: 'test',
            key: 'k',
            value: 'a ',
            expected: '[test]\n\tk = "a "\n',
            label: 'a trailing space triggers quoting (short value)',
          },
          {
            section: 'test',
            key: 'k',
            value: 'a\rb',
            expected: '[test]\n\tk = "a\rb"\n',
            label: 'a CR triggers quoting, with the raw CR inside the quotes',
          },
          {
            section: 'test',
            key: 'k',
            value: 'a"b',
            expected: '[test]\n\tk = a\\"b\n',
            label: 'an embedded " is escaped but does NOT trigger quoting',
          },
          {
            section: 'test',
            key: 'k',
            value: 'a\\b',
            expected: '[test]\n\tk = a\\\\b\n',
            label: 'an embedded \\ is escaped but does NOT trigger quoting',
          },
          {
            section: 'test',
            key: 'k',
            value: 'a\nb',
            expected: '[test]\n\tk = a\\nb\n',
            label: 'an embedded LF is escaped to \\n but does NOT trigger quoting',
          },
          {
            section: 'test',
            key: 'k',
            value: 'a\tb',
            expected: '[test]\n\tk = a\\tb\n',
            label: 'an embedded TAB is escaped to \\t but does NOT trigger quoting',
          },
          {
            section: 'test',
            key: 'k',
            value: '\ta',
            expected: '[test]\n\tk = \\ta\n',
            label: 'a leading TAB is escaped but does NOT trigger quoting',
          },
          {
            section: 'test',
            key: 'k',
            value: 'a; b"c\\d ',
            expected: '[test]\n\tk = "a; b\\"c\\\\d "\n',
            label: 'a trailing space triggers quoting, with " and \\ escaped inside',
          },
          {
            section: 'test',
            key: 'k',
            value: 'a\x01b',
            expected: '[test]\n\tk = a\x01b\n',
            label: 'a C0 control byte (\\x01) passes through verbatim, unquoted',
          },
          {
            section: 'test',
            key: 'k',
            value: 'a\x7fb',
            expected: '[test]\n\tk = a\x7fb\n',
            label: 'a DEL byte (\\x7f) passes through verbatim, unquoted',
          },
        ])('Then $label', ({ section, key, value, expected }) => {
          // Arrange
          const sut = setConfigEntryInText;

          // Act
          const result = sut('', section, undefined, key, value);

          // Assert
          expect(result).toBe(expected);
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
    // Identity matrix — [s] vs [s ""] are distinct targets
    // ---------------------------------------------------------------------------

    describe('Given a config text with [s]/[s ""]/[ ""] identity-matrix blocks', () => {
      describe('When setConfigEntryInText sets or inserts an entry', () => {
        it.each([
          {
            text: '[s]\n\tk = a\n[s ""]\n\tk = b\n',
            section: 's',
            subsection: undefined,
            key: 'k',
            expected: '[s]\n\tk = v\n[s ""]\n\tk = b\n',
            label:
              'both.conf, target subsection=undefined: only [s] is updated, [s ""] is untouched',
          },
          {
            text: '[s]\n\tk = a\n[s ""]\n\tk = b\n',
            section: 's',
            subsection: '',
            key: 'k',
            expected: '[s]\n\tk = a\n[s ""]\n\tk = v\n',
            label:
              'both.conf, target subsection="": only [s ""] is updated, [s] is untouched (direction pin)',
          },
          {
            text: '[s ""]\n\tk = b\n[s]\n\tk = a\n',
            section: 's',
            subsection: undefined,
            key: 'k',
            expected: '[s ""]\n\tk = b\n[s]\n\tk = v\n',
            label:
              'rev.conf, target subsection=undefined: only [s] is updated (even appearing second)',
          },
          {
            text: '[s ""]\n\tk = b\n[s]\n\tk = a\n',
            section: 's',
            subsection: '',
            key: 'k',
            expected: '[s ""]\n\tk = v\n[s]\n\tk = a\n',
            label:
              'rev.conf, target subsection="": only [s ""] is updated, [s] is untouched (direction pin)',
          },
          {
            text: '[s ""]\n\tk = b\n',
            section: 's',
            subsection: undefined,
            key: 'k',
            expected: '[s ""]\n\tk = b\n[s]\n\tk = v\n',
            label:
              'empty-only.conf, target subsection=undefined: [s ""] is NOT matched, [s] is appended',
          },
          {
            text: '[s]\n\tk = a\n',
            section: 's',
            subsection: '',
            key: 'k',
            expected: '[s]\n\tk = a\n[s ""]\n\tk = v\n',
            label:
              'plain-only.conf, target subsection="": [s] is NOT matched, [s ""] is appended (mirror pin)',
          },
          {
            text: '[ ""]\n\tk = e\n',
            section: 's',
            subsection: undefined,
            key: 'k',
            expected: '[ ""]\n\tk = e\n[s]\n\tk = v\n',
            label: '[ ""] only: [ ""] is NOT matched and a new [s] is appended',
          },
          {
            text: '[s]\n\tk = a\n[s ""]\n\tk = b\n',
            section: 's',
            subsection: undefined,
            key: 'n',
            expected: '[s]\n\tk = a\n\tn = v\n[s ""]\n\tk = b\n',
            label: 'both.conf, new key n: it lands at end of [s] block, not inside [s ""]',
          },
          {
            text: '[S]\n\tk = a\n',
            section: 's',
            subsection: undefined,
            key: 'k',
            expected: '[S]\n\tk = v\n',
            label:
              '[S] uppercase, target s lowercase: matched case-insensitively, rewritten in place',
          },
        ])('Then $label', ({ text, section, subsection, key, expected }) => {
          // Arrange
          const sut = setConfigEntryInText;

          // Act
          const result = sut(text, section, subsection, key, 'v');

          // Assert
          expect(result).toBe(expected);
        });
      });
    });

    describe('Given a same-line header+entry block', () => {
      describe('When setConfigEntryInText is applied', () => {
        it.each([
          {
            text: '[a] key = v\n',
            key: 'key',
            value: 'x2',
            expected: '[a]\n\tkey = x2\n',
            label:
              'replacing the same-line key splits the header onto its own line above the rewritten entry',
          },
          {
            text: '[a] key\n',
            key: 'key',
            value: 'x2',
            expected: '[a]\n\tkey = x2\n',
            label:
              'replacing a valueless same-line key splits the header and the entry gains the value',
          },
          {
            text: '[a] key = v\n',
            key: 'other',
            value: 'y',
            expected: '[a] key = v\n\tother = y\n',
            label:
              'setting a NEW key in a same-line block leaves the header verbatim and appends below',
          },
          {
            text: '[a] key = v\n\tk2 = w\n',
            key: 'key',
            value: 'x2',
            expected: '[a]\n\tkey = x2\n\tk2 = w\n',
            label:
              'replacing the same-line key with a following body entry splits the header and keeps the body verbatim',
          },
          {
            text: 'o = 1\n[a]\n\tk = v\n',
            key: 'k',
            value: 'x2',
            expected: 'o = 1\n[a]\n\tk = x2\n',
            label:
              'replacing an entry under a section below an orphan line preserves the orphan line',
          },
        ])('Then $label', ({ text, key, value, expected }) => {
          // Arrange
          const sut = setConfigEntryInText;

          // Act
          const result = sut(text, 'a', undefined, key, value);

          // Assert
          expect(result).toBe(expected);
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

    describe('Given a config that starts with a blank line and has no trailing newline', () => {
      describe('When removeConfigEntry drops the key on the final line', () => {
        it('Then the last-line entry is tokenized and removed', () => {
          // Arrange — leading blank + no trailing newline: the trailing-newline flag
          // must come from `endsWith('\n')`, not `startsWith('\n')`, or the final
          // `k` line is never tokenized and the removal silently no-ops.
          const text = '\n[a]\n\tx = keep\n\tk = v';

          // Act
          const sut = removeConfigEntry;
          const result = sut(text, 'a', undefined, 'k');

          // Assert — `k` removed, protecting `x` line keeps the block
          expect(result).toBe('\n[a]\n\tx = keep\n');
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

    describe('Given a block with a bracket-shaped non-header body line (`[half`)', () => {
      describe('When removeConfigEntry runs on this malformed content', () => {
        it('Then it refuses with CONFIG_PARSE_ERROR on line 2 like git refuses the unset', () => {
          // Arrange — `[half` is not a valid header and has no key char at column 0;
          // git refuses the whole unset ("invalid section name") and leaves the file.
          const text = '[a]\n\t[half\n\tkey = v\n';

          // Act + Assert
          const sut = removeConfigEntry;
          try {
            sut(text, 'a', undefined, 'key');
            expect.unreachable('removeConfigEntry must refuse the malformed bracket line');
          } catch (err) {
            if (!(err instanceof TsgitError)) throw err;
            expect(err.data.code).toBe('CONFIG_PARSE_ERROR');
            if (err.data.code === 'CONFIG_PARSE_ERROR') {
              expect(err.data.line).toBe(2);
            }
          }
        });
      });
    });

    // ---------------------------------------------------------------------------
    // Unset identity rows from the pinned table
    // ---------------------------------------------------------------------------

    describe('Given a config text with [s]/[s ""]/[ "x"] identity-matrix blocks', () => {
      describe('When removeConfigEntry removes a targeted key', () => {
        it.each([
          {
            text: '[s]\n\tk = a\n[s ""]\n\tk = b\n',
            section: 's',
            subsection: undefined,
            expected: '[s ""]\n\tk = b\n',
            label:
              'both.conf, target subsection=undefined: only the [s] entry is removed; [s ""] k=b is preserved',
          },
          {
            text: '[s]\n\tk = a\n[s ""]\n\tk = b\n',
            section: 's',
            subsection: '',
            expected: '[s]\n\tk = a\n',
            label:
              'both.conf, target subsection="": only the [s ""] entry is removed; [s] k=a is preserved',
          },
          {
            text: '[s]\n\tk = a\n[s ""]\n\tk = b\n[s]\n\tk = c\n',
            section: 's',
            subsection: undefined,
            expected: '[s ""]\n\tk = b\n',
            label:
              'three blocks, target subsection=undefined: both [s] entries are removed (unset-all), [s ""] k=b is preserved',
          },
          {
            text: '[s ""]\n\tk = a\n[s ""]\n\tk = b\n[s]\n\tk = c\n',
            section: 's',
            subsection: '',
            expected: '[s]\n\tk = c\n',
            label:
              'three blocks, target subsection="": both [s ""] entries are removed (unset-all), [s] k=c is preserved',
          },
          {
            text: '[ "x"]\n\tk = a\n[ ""]\n\tk = e\n',
            section: '',
            subsection: 'x',
            expected: '[ ""]\n\tk = e\n',
            label: 'empty-name family: only [ "x"] is removed and pruned; [ ""] k=e is preserved',
          },
        ])('Then $label', ({ text, section, subsection, expected }) => {
          // Arrange
          const sut = removeConfigEntry;

          // Act
          const result = sut(text, section, subsection, 'k');

          // Assert
          expect(result).toBe(expected);
        });
      });
    });

    describe('Given a same-line header+entry block', () => {
      describe('When removeConfigEntry unsets a key', () => {
        it.each([
          {
            text: '[a] key = v\n',
            key: 'key',
            expected: '',
            label:
              'unsetting the only same-line key prunes the whole physical line (header and entry)',
          },
          {
            text: '[a] key\n',
            key: 'key',
            expected: '',
            label: 'unsetting the only valueless same-line key prunes the whole physical line',
          },
          {
            text: '[a] key = v\n\tk2 = w\n',
            key: 'k2',
            expected: '[a] key = v\n',
            label: 'unsetting a NON-matching key leaves the same-line header line verbatim',
          },
          {
            text: '[a] key = v\n\t# keep\n',
            key: 'key',
            expected: '[a]\n\t# keep\n',
            label:
              'unsetting the same-line key with a surviving comment splits the header and keeps the comment',
          },
          {
            text: '[a] key = v\n\tk2 = w\n',
            key: 'key',
            expected: '[a]\n\tk2 = w\n',
            label:
              'unsetting the same-line key with a surviving entry splits the header and keeps the entry',
          },
          {
            text: '[a] key = 1\n[a] key = 2\n',
            key: 'key',
            expected: '',
            label: 'unset-all spanning two same-line blocks of the same key prunes every block',
          },
          {
            text: '[a] key = v\n\tkey = w\n\tk2 = keep\n',
            key: 'key',
            expected: '[a]\n\tk2 = keep\n',
            label:
              'unsetting a key matched both same-line and below re-emits the header alone and drops every occurrence',
          },
          {
            text: '[a] key = one\\\n  two\n\t# keep\n',
            key: 'key',
            expected: '[a]\n\t# keep\n',
            label:
              'unsetting a same-line key with a continuation tail re-emits the header alone and drops the tail lines',
          },
        ])('Then $label', ({ text, key, expected }) => {
          // Arrange
          const sut = removeConfigEntry;

          // Act
          const result = sut(text, 'a', undefined, key);

          // Assert
          expect(result).toBe(expected);
        });
      });
    });
  });

  // ---------------------------------------------------------------------------
  // rawSectionName — pinned raw-name reductions
  // ---------------------------------------------------------------------------

  describe('rawSectionName', () => {
    describe('Given various section/subsection combinations', () => {
      describe('When rawSectionName is called', () => {
        it.each([
          {
            section: 's',
            subsection: undefined,
            expected: 's',
            label: 'a plain header returns "s"',
          },
          {
            section: 's',
            subsection: 'x',
            expected: 's.x',
            label: 'a subsectioned header returns "s.x"',
          },
          {
            section: 's',
            subsection: '',
            expected: 's.',
            label: 'an explicitly empty subsection returns "s." (trailing dot)',
          },
          {
            section: '',
            subsection: '',
            expected: '.',
            label: 'the empty-name family [ ""] returns "." (leading dot)',
          },
          {
            section: '',
            subsection: 'x',
            expected: '.x',
            label: 'the empty-name family [ "x"] returns ".x"',
          },
          {
            section: 's.X',
            subsection: undefined,
            expected: 's.X',
            label: 'a deprecated dotted header [s.X] returns "s.X" (raw header bytes)',
          },
        ])('Then $label', ({ section, subsection, expected }) => {
          // Arrange
          const sut = rawSectionName;

          // Act
          const result = sut({ section, subsection });

          // Assert
          expect(result).toBe(expected);
        });
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Pinned raw-name reduction rows — removeConfigSectionInText & renameConfigSectionInText
  // ---------------------------------------------------------------------------

  describe('removeConfigSectionInText (pinned raw-name rows)', () => {
    describe('Given a config text and a raw section name to remove', () => {
      describe('When removeConfigSectionInText is called', () => {
        it.each([
          {
            text: '[s]\n\tk = a\n[s ""]\n\tk = b\n',
            name: 's',
            expected: '[s ""]\n\tk = b\n',
            label: 'only [s] is removed, [s ""] is preserved',
          },
          {
            text: '[s]\n\tk = a\n[s ""]\n\tk = b\n',
            name: 's.',
            expected: '[s]\n\tk = a\n',
            label: 'only [s ""] is removed (trailing-dot name), [s] is preserved',
          },
          {
            text: '[s]\n\tk = a\n[s ""]\n\tk = b\n',
            name: 's.""',
            expected: '[s]\n\tk = a\n[s ""]\n\tk = b\n',
            label: 'nothing is removed (two-quote-char subsection is a distinct name)',
          },
          {
            text: '[S]\n\tk = a\n',
            name: 's',
            expected: '[S]\n\tk = a\n',
            label:
              'nothing is removed for a lower-case name against an upper-case header (byte-exact case-sensitive matching)',
          },
          {
            text: '[s.X]\n\tk = a\n',
            name: 's.X',
            expected: '',
            label: 'a deprecated header is removed (raw byte match)',
          },
          {
            text: '[s.X]\n\tk = a\n',
            name: 's.x',
            expected: '[s.X]\n\tk = a\n',
            label:
              'nothing is removed for a lower-case deprecated name (case-sensitive; s.x ≠ s.X)',
          },
          {
            text: '[a.b]\n\tk = p\n[a "b"]\n\tk = q\n',
            name: 'a.b',
            expected: '',
            label: 'both blocks are removed (a.b is the raw name of both — documented ambiguity)',
          },
          {
            text: '[s]\n\tk = a\n[s "x"]\n\tk = b\n[s]\n\tk = c\n',
            name: 's',
            expected: '[s "x"]\n\tk = b\n',
            label: 'both [s] blocks are removed, [s "x"] is preserved (multi-block plain)',
          },
          {
            text: '[ ""]\n\tk = e\n[s]\n\tk = a\n[s ""]\n\tk = b\n',
            name: '.',
            expected: '[s]\n\tk = a\n[s ""]\n\tk = b\n',
            label: 'only [ ""] is removed, [s] and [s ""] are preserved',
          },
          {
            text: '[ "x"]\n\tk = e\n[s]\n\tk = a\n',
            name: '.x',
            expected: '[s]\n\tk = a\n',
            label: 'only [ "x"] is removed',
          },
          {
            text: '[s     ""]\n\tk = a\n',
            name: 's.',
            expected: '',
            label: 'the block is removed (pre-quote whitespace is not part of the raw name)',
          },
          {
            text: '[s "a\\"b"]\n\tk = a\n',
            name: 's.a"b',
            expected: '',
            label: 'the block is removed (subsection unescaped before joining)',
          },
        ])('Then $label', ({ text, name, expected }) => {
          // Arrange
          const sut = removeConfigSectionInText;

          // Act
          const result = sut(text, name);

          // Assert
          expect(result).toBe(expected);
        });
      });
    });
  });

  describe('renameConfigSectionInText (pinned raw-name rows)', () => {
    describe('Given a config text, a raw old name, and a new identity', () => {
      describe('When renameConfigSectionInText is called', () => {
        it.each([
          {
            text: '[a "b."]\n\tk = p\n[a.b ""]\n\tk = q\n',
            oldName: 'a.b.',
            newIdentity: { section: 't' },
            expected: '[t]\n\tk = p\n[t]\n\tk = q\n',
            label: 'both ambiguous headers become [t] (raw a.b. matches both)',
          },
          {
            text: '[s]\n\tk = a\n[s "x"]\n\tk = b\n[s]\n\tk = c\n',
            oldName: 's',
            newIdentity: { section: 't' },
            expected: '[t]\n\tk = a\n[s "x"]\n\tk = b\n[t]\n\tk = c\n',
            label: 'both [s] blocks become [t], [s "x"] is preserved (multi-block plain rename)',
          },
          {
            text: '[s]\n\tk = a\n',
            oldName: 's',
            newIdentity: { section: 's', subsection: '' },
            expected: '[s ""]\n\tk = a\n',
            label: 'the header becomes [s ""] (duplicate-with-empty allowed at primitive level)',
          },
          {
            text: '[s "x"]\n\tk = a\n',
            oldName: 's.x',
            newIdentity: { section: 't' },
            expected: '[t]\n\tk = a\n',
            label: 'the header becomes [t] (cross-family at the primitive level)',
          },
          {
            text: '[s "x"]\n\tk = a\n',
            oldName: 's.x',
            newIdentity: { section: 's', subsection: '' },
            expected: '[s ""]\n\tk = a\n',
            label: 'the header becomes [s ""] (named subsection collapses to the empty form)',
          },
          {
            text: '[s "x"]\n\tk = a\n',
            oldName: 's.x',
            newIdentity: { section: '', subsection: '' },
            expected: '[ ""]\n\tk = a\n',
            label: 'the header becomes [ ""] (named form moves into the empty-name family)',
          },
          {
            text: '[S]\n\tk = a\n',
            oldName: 'S',
            newIdentity: { section: 't' },
            expected: '[t]\n\tk = a\n',
            label: 'the byte-exact "S" old name matches [S] (case sensitivity success direction)',
          },
          {
            text: '[s "X"]\n\tk = a\n',
            oldName: 's.X',
            newIdentity: { section: 't' },
            expected: '[t]\n\tk = a\n',
            label:
              'the byte-exact "s.X" old name matches [s "X"] (subsection case success direction)',
          },
        ])('Then $label', ({ text, oldName, newIdentity, expected }) => {
          // Arrange
          const sut = renameConfigSectionInText;

          // Act
          const result = sut(text, oldName, newIdentity);

          // Assert
          expect(result).toBe(expected);
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
          // Arrange — the header scan unescapes \" → "; rawSectionName joins to
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

    describe('Given a leading comment line before the first section header', () => {
      describe('When removeConfigSectionInText removes "s"', () => {
        it('Then the leading comment is preserved and the matching section is dropped', () => {
          // Arrange — skipping starts false; content before the first header must pass through
          const text = '# repository config\n[s]\n\tk = a\n[t]\n\tk = b\n';
          const sut = removeConfigSectionInText;

          // Act
          const result = sut(text, 's');

          // Assert
          expect(result).toBe('# repository config\n[t]\n\tk = b\n');
        });
      });
    });

    describe('Given an indented section header "  [s]"', () => {
      describe('When removeConfigSectionInText removes "s"', () => {
        it('Then the indented header and its body are removed (trim is applied before header detection and matching)', () => {
          // Arrange — git accepts leading whitespace before a header; both isSectionHeader
          // and matchesRawSectionName must trim before parsing
          const text = '  [s]\n\tk = a\n[t]\n\tk = b\n';
          const sut = removeConfigSectionInText;

          // Act
          const result = sut(text, 's');

          // Assert
          expect(result).toBe('[t]\n\tk = b\n');
        });
      });
    });

    describe('Given a body line ending in "]" inside a removed section', () => {
      describe('When removeConfigSectionInText removes "s"', () => {
        it('Then the body line is dropped along with the rest of the section (isSectionHeader requires both "[" prefix and "]" suffix)', () => {
          // Arrange — a value like `val = [x]` ends in ] but does not start with [;
          // the logical-OR pre-filter mutant would stop skipping here and preserve
          // subsequent body lines incorrectly
          const text = '[s]\n\tval = [x]\n\tother = z\n[t]\n\tk = b\n';
          const sut = removeConfigSectionInText;

          // Act
          const result = sut(text, 's');

          // Assert
          expect(result).toBe('[t]\n\tk = b\n');
        });
      });
    });

    describe('Given a body line starting with "[" but without a closing "]" inside a removed section', () => {
      describe('When removeConfigSectionInText removes "s"', () => {
        it('Then the body line is dropped along with the rest of the section (isSectionHeader requires the "]" suffix)', () => {
          // Arrange — a malformed line `[no-close` starts with [ but lacks ] ;
          // the endsWith-empty-string mutant would stop skipping here and preserve
          // subsequent body lines incorrectly
          const text = '[s]\n\tk = a\n[no-close\n\tother = z\n[t]\n\tk = b\n';
          const sut = removeConfigSectionInText;

          // Act
          const result = sut(text, 's');

          // Assert
          expect(result).toBe('[t]\n\tk = b\n');
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

    describe('Given various invalid new-identity inputs', () => {
      describe('When renameConfigSectionInText validates the new identity', () => {
        it.each([
          {
            oldName: 'remote.old',
            newIdentity: { section: 'remote', subsection: 'ne\nw' },
            reason: 'subsection must not contain a newline or NUL',
            label:
              'a new subsection containing a newline throws INVALID_OPTION (LF divergence guard)',
          },
          {
            oldName: 'remote.old',
            newIdentity: { section: 'bad]name' },
            reason: 'section must not contain whitespace, NUL, brackets, quotes, or backslashes',
            label: 'a new section name containing a bracket throws INVALID_OPTION (section guard)',
          },
          {
            oldName: 'remote.old',
            newIdentity: { section: 'a b' },
            reason: 'section must not contain whitespace, NUL, brackets, quotes, or backslashes',
            label:
              'a new section name containing a space throws INVALID_OPTION (unparseable-header guard)',
          },
          {
            oldName: 'x',
            newIdentity: { section: '' },
            reason: 'section name must not be empty without a subsection',
            label:
              'a new name with an empty section and no subsection throws INVALID_OPTION instead of writing an unparseable [] header',
          },
          {
            oldName: 'remote.old',
            newIdentity: { section: 'a[b' },
            reason: 'section must not contain whitespace, NUL, brackets, quotes, or backslashes',
            label:
              'a new section name containing an opening bracket throws INVALID_OPTION (unparseable-header guard)',
          },
        ])('Then $label', ({ oldName, newIdentity, reason }) => {
          // Arrange
          let caught: unknown;

          // Act
          try {
            renameConfigSectionInText('', oldName, newIdentity);
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data;
          expect(data.code).toBe('INVALID_OPTION');
          if (data.code === 'INVALID_OPTION') {
            expect(data.option).toBe('config');
            expect(data.reason).toBe(reason);
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

    describe('Given an indented section header "  [s]"', () => {
      describe('When renameConfigSectionInText renames "s" to { section: "t" }', () => {
        it('Then the indented header is matched and renamed (leading gap is skipped before parsing)', () => {
          // Arrange — the header scan skips the leading gap before recognising the bracket span
          const text = '  [s]\n\tk = a\n';
          const sut = renameConfigSectionInText;

          // Act
          const result = sut(text, 's', { section: 't' });

          // Assert
          expect(result).toBe('[t]\n\tk = a\n');
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

  describe('renameConfigSectionInText (same-line header blocks)', () => {
    describe('Given a same-line header+entry block matching the old name', () => {
      describe('When renameConfigSectionInText renames "a" to { section: "b" }', () => {
        it('Then the header is split onto its own line and the entry follows on a tab line', () => {
          // Arrange — git re-emits the new header, then the entry on its own line
          const text = '[a] key = v\n';

          // Act
          const sut = renameConfigSectionInText;
          const result = sut(text, 'a', { section: 'b' });

          // Assert
          expect(result).toBe('[b]\n\tkey = v\n');
        });
      });
    });

    describe('Given a same-line header with a following body entry', () => {
      describe('When renameConfigSectionInText renames "a" to { section: "b" }', () => {
        it('Then the header splits and both the same-line and body entries are preserved', () => {
          // Arrange
          const text = '[a] key = v\n\tk2 = w\n';

          // Act
          const sut = renameConfigSectionInText;
          const result = sut(text, 'a', { section: 'b' });

          // Assert
          expect(result).toBe('[b]\n\tkey = v\n\tk2 = w\n');
        });
      });
    });

    describe('Given a same-line valueless entry', () => {
      describe('When renameConfigSectionInText renames "a" to { section: "b" }', () => {
        it('Then the valueless entry is preserved verbatim after the split', () => {
          // Arrange
          const text = '[a] key\n';

          // Act
          const sut = renameConfigSectionInText;
          const result = sut(text, 'a', { section: 'b' });

          // Assert
          expect(result).toBe('[b]\n\tkey\n');
        });
      });
    });

    describe('Given a header with only trailing spaces after the closing bracket', () => {
      describe('When renameConfigSectionInText renames "a" to { section: "b" }', () => {
        it('Then the trailing spaces are dropped and the body is re-emitted from the section', () => {
          // Arrange — `[a]  ` carries no same-line entry, only trailing GIT_SPACE
          const text = '[a]  \n\tk = v\n';

          // Act
          const sut = renameConfigSectionInText;
          const result = sut(text, 'a', { section: 'b' });

          // Assert
          expect(result).toBe('[b]\n\tk = v\n');
        });
      });
    });

    describe('Given a same-line entry with a no-space `key=v` tail and extra `]`-to-key gap', () => {
      describe('When renameConfigSectionInText renames "a" to { section: "b" }', () => {
        it('Then the entry tail is copied raw and only the `]`-to-key gap normalises', () => {
          // Arrange — the raw `key=v` is not re-rendered to `key = v`
          const text = '[a]   key=v\n';

          // Act
          const sut = renameConfigSectionInText;
          const result = sut(text, 'a', { section: 'b' });

          // Assert
          expect(result).toBe('[b]\n\tkey=v\n');
        });
      });
    });

    describe('Given a same-line entry with a trailing comment in its tail', () => {
      describe('When renameConfigSectionInText renames "a" to { section: "b" }', () => {
        it('Then the trailing comment is copied raw with the rest of the tail', () => {
          // Arrange
          const text = '[a] key = v ; cmt\n';

          // Act
          const sut = renameConfigSectionInText;
          const result = sut(text, 'a', { section: 'b' });

          // Assert
          expect(result).toBe('[b]\n\tkey = v ; cmt\n');
        });
      });
    });

    describe('Given a same-line entry whose value continues onto the next line', () => {
      describe('When renameConfigSectionInText renames "a" to { section: "b" }', () => {
        it('Then the continuation tail survives the split verbatim', () => {
          // Arrange — backslash-newline continuation in the same-line value
          const text = '[a] key = one\\\n  two\n';

          // Act
          const sut = renameConfigSectionInText;
          const result = sut(text, 'a', { section: 'b' });

          // Assert
          expect(result).toBe('[b]\n\tkey = one\\\n  two\n');
        });
      });
    });

    describe('Given a same-line header that does not match the old name', () => {
      describe('When renameConfigSectionInText renames "a" to { section: "b" }', () => {
        it('Then the non-matching same-line block is copied byte-for-byte', () => {
          // Arrange — only `[a]` is renamed; `[c] k = v` keeps its same-line form
          const text = '[a] key = v\n[c] k = v\n';

          // Act
          const sut = renameConfigSectionInText;
          const result = sut(text, 'a', { section: 'b' });

          // Assert
          expect(result).toBe('[b]\n\tkey = v\n[c] k = v\n');
        });
      });
    });

    describe('Given a file containing a block with a key the read path would refuse', () => {
      describe('When renameConfigSectionInText renames a different block', () => {
        it('Then it succeeds without throwing and copies the bad-key block verbatim', () => {
          // Arrange — `bad!key` would throw on a tokenizing read; section ops stay lenient
          const text = '[a]\n\tbad!key = v\n[b]\n\tk = w\n';

          // Act
          const sut = renameConfigSectionInText;
          const result = sut(text, 'b', { section: 'c' });

          // Assert
          expect(result).toBe('[a]\n\tbad!key = v\n[c]\n\tk = w\n');
        });
      });
    });

    describe('Given a file whose matched block itself holds a key the read path would refuse', () => {
      describe('When renameConfigSectionInText renames the bad-key block', () => {
        it('Then it succeeds and copies the bad-key body verbatim under the new header', () => {
          // Arrange
          const text = '[a]\n\tbad!key = v\n[b]\n\tk = w\n';

          // Act
          const sut = renameConfigSectionInText;
          const result = sut(text, 'a', { section: 'c' });

          // Assert
          expect(result).toBe('[c]\n\tbad!key = v\n[b]\n\tk = w\n');
        });
      });
    });
  });

  describe('chained section headers on one physical line', () => {
    describe('Given `[a][b]\\nx=1` with the body keyed on the last section', () => {
      describe('When setConfigEntryInText sets b.x to v2', () => {
        it('Then the chained header line is preserved and only the body entry is replaced', () => {
          // Arrange — the writer keys the block on the last header; the chain
          // line stays verbatim, the body entry becomes the canonical form.
          const text = '[a][b]\nx=1\n';

          // Act
          const sut = setConfigEntryInText;
          const result = sut(text, 'b', undefined, 'x', 'v2');

          // Assert
          expect(result).toBe('[a][b]\n\tx = v2\n');
        });
      });
    });

    describe('Given `[a][b]\\nx=1` whose first header is `a`', () => {
      describe('When renameConfigSectionInText renames "a"', () => {
        it('Then the chain line keys on `a`, the `[b]` tail is copied raw onto a tab line', () => {
          // Arrange — recognition keys the line on its FIRST header `a`; the
          // `[b]` chain is the raw tail re-emitted after the rendered header.
          const text = '[a][b]\nx=1\n';

          // Act
          const sut = renameConfigSectionInText;
          const result = sut(text, 'a', { section: 'c' });

          // Assert
          expect(result).toBe('[c]\n\t[b]\nx=1\n');
        });
      });
    });

    describe('Given `[a][b]\\nx=1` whose first header is `a`', () => {
      describe('When removeConfigSectionInText removes "b"', () => {
        it('Then it is a no-op because the line keys on its first header `a`, not `b`', () => {
          // Arrange — `b` is not a line-leading header, so it matches nothing.
          const text = '[a][b]\nx=1\n';

          // Act
          const sut = removeConfigSectionInText;
          const result = sut(text, 'b');

          // Assert
          expect(result).toBe('[a][b]\nx=1\n');
        });
      });
    });
  });

  describe('removeConfigSectionInText (same-line header blocks)', () => {
    describe('Given a same-line header block matching the old name', () => {
      describe('When removeConfigSectionInText removes "a"', () => {
        it('Then the whole same-line block is removed leaving an empty file', () => {
          // Arrange
          const text = '[a] key = v\n';

          // Act
          const sut = removeConfigSectionInText;
          const result = sut(text, 'a');

          // Assert
          expect(result).toBe('');
        });
      });
    });

    describe('Given a same-line block followed by a body and a plain following section', () => {
      describe('When removeConfigSectionInText removes "a"', () => {
        it('Then the matched block and body are dropped and the following section is verbatim', () => {
          // Arrange — `[c]`'s original `k3=x` bytes are preserved (not re-rendered)
          const text = '[a] key = v\n\tk2=w\n[c]\n\tk3=x\n';

          // Act
          const sut = removeConfigSectionInText;
          const result = sut(text, 'a');

          // Assert
          expect(result).toBe('[c]\n\tk3=x\n');
        });
      });
    });

    describe('Given two same-line blocks where only the first matches', () => {
      describe('When removeConfigSectionInText removes "a"', () => {
        it('Then only the matching block is removed and the other keeps its same-line form', () => {
          // Arrange — `[b] k2 = v2` is kept verbatim, not rewritten to a split form
          const text = '[a] k1 = v1\n[b] k2 = v2\n';

          // Act
          const sut = removeConfigSectionInText;
          const result = sut(text, 'a');

          // Assert
          expect(result).toBe('[b] k2 = v2\n');
        });
      });
    });

    describe('Given an orphan line above the matched section', () => {
      describe('When removeConfigSectionInText removes "a"', () => {
        it('Then the orphan line is preserved and the section is removed', () => {
          // Arrange — `o = 1` precedes the first header and is outside every block
          const text = 'o = 1\n[a]\n\tk = v\n';

          // Act
          const sut = removeConfigSectionInText;
          const result = sut(text, 'a');

          // Assert
          expect(result).toBe('o = 1\n');
        });
      });
    });

    describe('Given a file containing a block with a key the read path would refuse', () => {
      describe('When removeConfigSectionInText removes a different block', () => {
        it('Then it succeeds without throwing and keeps the bad-key block verbatim', () => {
          // Arrange
          const text = '[a]\n\tbad!key = v\n[b]\n\tk = w\n';

          // Act
          const sut = removeConfigSectionInText;
          const result = sut(text, 'b');

          // Assert
          expect(result).toBe('[a]\n\tbad!key = v\n');
        });
      });
    });

    describe('Given a file containing a block with a value the read path would refuse', () => {
      describe('When removeConfigSectionInText removes a different block', () => {
        it('Then it succeeds without throwing and keeps the malformed-value block verbatim', () => {
          // Arrange — `"unclosed` is an unterminated quoted value
          const text = '[a]\n\tk = "unclosed\n[b]\n\tk = w\n';

          // Act
          const sut = removeConfigSectionInText;
          const result = sut(text, 'b');

          // Assert
          expect(result).toBe('[a]\n\tk = "unclosed\n');
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

    describe('Given a config that starts with a blank line and has no trailing newline', () => {
      describe('When appendConfigEntry adds an entry to the section on the final line', () => {
        it('Then the entry lands at EOF with a terminating newline, after the existing key', () => {
          // Arrange — leading blank + no trailing newline. The tokenizer flag and the
          // splice boundary both key off `endsWith('\n')`; a `startsWith('\n')` (or a
          // hard-true) flip would drop the final line or clamp the insert one line early.
          const text = '\n[a]\n\tk = v';

          // Act
          const sut = appendConfigEntry;
          const result = sut(text, 'a', undefined, 'k', 'B');

          // Assert — B appended after v, at the very end, newline-terminated
          expect(result).toBe('\n[a]\n\tk = v\n\tk = B\n');
        });
      });
    });

    describe('Given a section whose last entry continues across the file trailing newline', () => {
      describe('When appendConfigEntry adds a new key', () => {
        it('Then the entry is inserted at the writable boundary without a spurious blank line', () => {
          // Arrange — a backslash-continuation on the final content line consumes the
          // trailing-newline slot, so the entry span ends at `lines.length`; the splice
          // boundary must stay `lines.length - 1`, not `+ 1`.
          const text = '[a]\n\tk = v\\\n';

          // Act
          const sut = appendConfigEntry;
          const result = sut(text, 'a', undefined, 'x', '1');

          // Assert — no extra blank line is introduced before the appended entry
          expect(result).toBe('[a]\n\tk = v\\\n\tx = 1\n');
        });
      });
    });

    describe('Given a non-empty config with no trailing newline and no matching section', () => {
      describe('When appendConfigEntry creates a new section', () => {
        it('Then a newline separates the preserved original text from the appended section', () => {
          // Arrange — the prefix branch must add the missing `\n` AND keep the original
          // bytes: `endsWith('\n')` decides, and the `${text}\n` template supplies both.
          const text = '[a]\n\tk = v';

          // Act
          const sut = appendConfigEntry;
          const result = sut(text, 'b', undefined, 'x', '1');

          // Assert — original preserved, newline-joined to the new [b] section
          expect(result).toBe('[a]\n\tk = v\n[b]\n\tx = 1\n');
        });
      });
    });

    // ---------------------------------------------------------------------------
    // Append identity rows 7–9 from the pinned table
    // ---------------------------------------------------------------------------

    describe('Given various pinned identity fixtures', () => {
      describe('When appendConfigEntry appends a new entry', () => {
        it.each([
          {
            text: '',
            section: 's',
            subsection: '',
            value: 'v',
            expected: '[s ""]\n\tk = v\n',
            label:
              'an empty file, target subsection="": a new [s ""] section is created with k = v',
          },
          {
            text: '[s ""]\n\tk = v\n',
            section: 's',
            subsection: '',
            value: 'v2',
            expected: '[s ""]\n\tk = v\n\tk = v2\n',
            label:
              '[s ""] with k=v already, target subsection="": a second k entry is appended inside [s ""]',
          },
          {
            text: '[s ""]\n\tk = b\n',
            section: 's',
            subsection: undefined,
            value: 'x',
            expected: '[s ""]\n\tk = b\n[s]\n\tk = x\n',
            label:
              'empty-only.conf, target subsection=undefined: a new [s] section is appended with k = x',
          },
          {
            text: '[ ""]\n\tk = v\n',
            section: '',
            subsection: '',
            value: 'v2',
            expected: '[ ""]\n\tk = v\n\tk = v2\n',
            label:
              '[ ""] with k=v already, target section="" subsection="": the second entry is appended inside [ ""]',
          },
        ])('Then $label', ({ text, section, subsection, value, expected }) => {
          // Arrange
          const sut = appendConfigEntry;

          // Act
          const result = sut(text, section, subsection, 'k', value);

          // Assert
          expect(result).toBe(expected);
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

  describe('Given a value with a byte that setConfigEntry accepts, When setConfigEntry runs', () => {
    it.each([
      { value: 'x\ry', label: 'a CR byte: accepted, written quoted with raw CR' },
      { value: 'a\nb', label: 'a newline: accepted, the writer quotes and escapes \\n' },
      { value: 'a\tb', label: 'a tab: accepted, written verbatim' },
      { value: 'a\x01b', label: 'a C0 control byte (\\x01): accepted, written verbatim' },
    ])('Then $label — setConfigEntry succeeds', async ({ value }) => {
      // Arrange
      const ctx = createMemoryContext();

      // Act + Assert (no throw)
      await expect(setConfigEntry({ ctx, key: 'user.name', value })).resolves.toBeUndefined();
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
});

describe('setConfigEntry round-trip', () => {
  describe('Given a value with a special character, When written and re-parsed via parseIniSections', () => {
    it.each([
      { value: 'a;b', label: 'containing ;' },
      { value: 'a#b', label: 'containing #' },
      { value: ' a', label: 'with a leading space' },
      { value: 'a ', label: 'with a trailing space' },
      { value: 'a\rb', label: 'containing CR (a\\rb)' },
      { value: 'a"b', label: 'containing " (a"b)' },
      { value: 'a\\b', label: 'containing \\ (a\\b)' },
      { value: 'a\nb', label: 'containing LF (a\\nb)' },
      { value: 'a\tb', label: 'containing TAB (a\\tb)' },
      { value: '\ta', label: 'with a leading TAB (\\ta)' },
      { value: 'a; b"c\\d ', label: 'a combo (a; b"c\\d )' },
      { value: 'a\x01b', label: 'containing \\x01 (C0 control)' },
      { value: 'a\x7fb', label: 'containing \\x7f (DEL)' },
    ])('Then the parsed value equals the original for a value $label', ({ value }) => {
      // Arrange
      const sut = setConfigEntryInText;

      // Act
      const text = sut('', 'test', undefined, 'v', value);
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
    describe('When parseNewSectionName parses the input', () => {
      it.each([
        { input: 't.a.b', expected: { section: 't', subsection: 'a.b' }, label: 'first-dot split' },
        { input: '1num', expected: { section: '1num' }, label: 'digit-leading accepted' },
        {
          input: 't-x',
          expected: { section: 't-x' },
          label: 'a hyphen in the section is accepted',
        },
        {
          input: 't.bad!sub',
          expected: { section: 't', subsection: 'bad!sub' },
          label: 'the subsection is free after the first dot',
        },
        {
          input: 't.with"quote',
          expected: { section: 't', subsection: 'with"quote' },
          label: 'a quote in the subsection is accepted',
        },
        { input: 'T.Y', expected: { section: 'T', subsection: 'Y' }, label: 'case is preserved' },
        {
          input: 't.',
          expected: { section: 't', subsection: '' },
          label: 'a trailing dot means an empty subsection',
        },
        { input: '.', expected: { section: '', subsection: '' }, label: 'a lone dot' },
        { input: '.x', expected: { section: '', subsection: 'x' }, label: 'a leading dot' },
        { input: 'a', expected: { section: 'a' }, label: 'a single alnum char' },
        {
          input: 'tz.y',
          expected: { section: 'tz', subsection: 'y' },
          label: 'a letter-only section',
        },
      ])('Then returns $expected for $label', ({ input, expected }) => {
        // Arrange + Act
        const result = sut(input);
        // Assert
        expect(result).toEqual(expected);
      });
    });
  });

  describe('Given refused new-name inputs', () => {
    describe('When parseNewSectionName parses the input', () => {
      it.each([
        { input: '', label: 'an empty string' },
        { input: 't_x', label: 'an underscore in the section' },
        { input: 'bad!name', label: 'a bang in the section' },
        { input: 't!x.y', label: 'a bad char before the first dot' },
      ])(
        'Then throws INVALID_OPTION with reason "invalid section name: $input" for $label',
        ({ input }) => {
          // Arrange
          let caught: TsgitError | undefined;

          // Act
          try {
            sut(input);
          } catch (err) {
            caught = err as TsgitError;
          }

          // Assert
          expect(caught?.data).toEqual({
            code: 'INVALID_OPTION',
            option: 'config',
            reason: `invalid section name: ${input}`,
          });
        },
      );
    });
  });
});

describe('renameConfigSection — extended porcelain I/O', () => {
  const bothConf = '[s]\n\tk = a\n[s ""]\n\tk = b\n';
  const mixConf = '[s]\n\tk = a\n[s "x"]\n\tk = b\n[s ""]\n\tk = c\n';
  const nameMixConf = '[ ""]\n\tk = e\n[s]\n\tk = a\n[s ""]\n\tk = b\n';

  describe('Given both.conf seeded ([s] k=a · [s ""] k=b)', () => {
    describe('When renameConfigSection renames a raw old name to a new name', () => {
      it.each([
        {
          oldName: 's',
          newName: 't',
          expected: '[t]\n\tk = a\n[s ""]\n\tk = b\n',
          label: '"s" (plain) to "t": only [s] becomes [t], [s ""] is unchanged',
        },
        {
          oldName: 's.',
          newName: 't.',
          expected: '[s]\n\tk = a\n[t ""]\n\tk = b\n',
          label: '"s." (trailing-dot) to "t.": only [s ""] becomes [t ""], [s] is unchanged',
        },
        {
          oldName: 's.',
          newName: 't',
          expected: '[s]\n\tk = a\n[t]\n\tk = b\n',
          label: '"s." to "t" (trailing-dot to plain): [s ""] becomes [t], [s] unchanged',
        },
        {
          oldName: 's',
          newName: 's.',
          expected: '[s ""]\n\tk = a\n[s ""]\n\tk = b\n',
          label:
            '"s" to "s." (plain to trailing-dot): [s] becomes a second [s ""] (duplicate headers allowed)',
        },
      ])('Then $label', async ({ oldName, newName, expected }) => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, bothConf);

        // Act
        await renameConfigSection({ ctx, oldName, newName });

        // Assert
        const text = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`);
        expect(text).toBe(expected);
      });
    });
  });

  describe('Given mix.conf seeded ([s] k=a · [s "x"] k=b · [s ""] k=c)', () => {
    describe('When renameConfigSection renames a raw old name to a new name', () => {
      it.each([
        {
          oldName: 's',
          newName: 't',
          expected: '[t]\n\tk = a\n[s "x"]\n\tk = b\n[s ""]\n\tk = c\n',
          label: '"s" to "t": only [s] becomes [t], [s "x"] and [s ""] are unchanged',
        },
        {
          oldName: 's.x',
          newName: 't.y',
          expected: '[s]\n\tk = a\n[t "y"]\n\tk = b\n[s ""]\n\tk = c\n',
          label: '"s.x" to "t.y": only [s "x"] becomes [t "y"]',
        },
        {
          oldName: 's.x',
          newName: 't',
          expected: '[s]\n\tk = a\n[t]\n\tk = b\n[s ""]\n\tk = c\n',
          label: '"s.x" to "t" (subsection to plain): [s "x"] becomes [t]',
        },
        {
          oldName: 's',
          newName: 't.y',
          expected: '[t "y"]\n\tk = a\n[s "x"]\n\tk = b\n[s ""]\n\tk = c\n',
          label: '"s" to "t.y" (plain to subsectioned): [s] becomes [t "y"]',
        },
      ])('Then $label', async ({ oldName, newName, expected }) => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, mixConf);

        // Act
        await renameConfigSection({ ctx, oldName, newName });

        // Assert
        const text = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`);
        expect(text).toBe(expected);
      });
    });
  });

  describe('Given name-mix.conf seeded ([ ""] k=e · [s] k=a · [s ""] k=b)', () => {
    describe('When renameConfigSection renames a raw old name to a new name', () => {
      it.each([
        {
          oldName: '.',
          newName: 't',
          expected: '[t]\n\tk = e\n[s]\n\tk = a\n[s ""]\n\tk = b\n',
          label: '"." to "t": [ ""] becomes [t]',
        },
        {
          oldName: '.',
          newName: 't.',
          expected: '[t ""]\n\tk = e\n[s]\n\tk = a\n[s ""]\n\tk = b\n',
          label: '"." to "t.": [ ""] becomes [t ""]',
        },
        {
          oldName: '.',
          newName: '.x',
          expected: '[ "x"]\n\tk = e\n[s]\n\tk = a\n[s ""]\n\tk = b\n',
          label: '"." to ".x": [ ""] becomes [ "x"]',
        },
        {
          oldName: '.',
          newName: 's.x',
          expected: '[s "x"]\n\tk = e\n[s]\n\tk = a\n[s ""]\n\tk = b\n',
          label: '"." to "s.x": [ ""] becomes [s "x"]',
        },
        {
          oldName: 's',
          newName: '.',
          expected: '[ ""]\n\tk = e\n[ ""]\n\tk = a\n[s ""]\n\tk = b\n',
          label: '"s" to "." on name-mix.conf: [s] becomes a second [ ""] block',
        },
      ])('Then $label', async ({ oldName, newName, expected }) => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, nameMixConf);

        // Act
        await renameConfigSection({ ctx, oldName, newName });

        // Assert
        const text = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`);
        expect(text).toBe(expected);
      });
    });
  });

  describe('Given CONFIG_SECTION_NOT_FOUND scenarios', () => {
    describe('When renameConfigSection is called with a name that matches nothing', () => {
      it.each([
        {
          seed: '[S]\n\tk = a\n',
          oldName: 's',
          label: 'a case-mismatched old name ("s" vs [S])',
        },
        { seed: undefined, oldName: 'bad!name', label: 'old name "bad!name" (never validated)' },
        { seed: undefined, oldName: '', label: 'old name "" (empty, never validated)' },
      ])(
        'Then throws CONFIG_SECTION_NOT_FOUND with name "$oldName" for $label',
        async ({ seed, oldName }) => {
          // Arrange
          const ctx = createMemoryContext();
          if (seed !== undefined) {
            await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, seed);
          }
          let caught: TsgitError | undefined;

          // Act
          try {
            await renameConfigSection({ ctx, oldName, newName: 't' });
          } catch (err) {
            caught = err as TsgitError;
          }

          // Assert
          expect(caught?.data).toEqual({
            code: 'CONFIG_SECTION_NOT_FOUND',
            name: oldName,
            scope: 'local',
          });
        },
      );
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
    describe('When removeConfigSection is called with a name that matches nothing', () => {
      it.each([
        {
          seed: '[s]\n\tk = a\n',
          sectionName: 's.',
          label: '"s." on a plain-only config',
        },
        {
          seed: '[s ""]\n\tk = b\n',
          sectionName: 's',
          label: '"s" on an empty-only config',
        },
        { seed: undefined, sectionName: '', label: '"" (empty string, never validated)' },
        {
          seed: '[s]\n\tk = a\n',
          sectionName: '.',
          label: '"." when [ ""] is absent',
        },
      ])(
        'Then throws CONFIG_SECTION_NOT_FOUND with name "$sectionName" for $label',
        async ({ seed, sectionName }) => {
          // Arrange
          const ctx = createMemoryContext();
          if (seed !== undefined) {
            await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, seed);
          }
          let caught: TsgitError | undefined;

          // Act
          try {
            await removeConfigSection({ ctx, sectionName });
          } catch (err) {
            caught = err as TsgitError;
          }

          // Assert
          expect(caught?.data).toEqual({
            code: 'CONFIG_SECTION_NOT_FOUND',
            name: sectionName,
            scope: 'local',
          });
        },
      );
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
    describe('Given a config seed and an empty-section-name key', () => {
      describe('When setConfigEntry writes it', () => {
        it.each([
          {
            seed: undefined,
            key: '..k',
            expected: '[ ""]\n\tk = v\n',
            label: 'an empty .git/config and key "..k": the file is [ ""]\\n\\tk = v\\n',
          },
          {
            seed: undefined,
            key: '.x.k',
            expected: '[ "x"]\n\tk = v\n',
            label: 'an empty .git/config and key ".x.k": the file is [ "x"]\\n\\tk = v\\n',
          },
          {
            seed: '[s]\n\tk = a\n',
            key: '..k',
            expected: '[s]\n\tk = a\n[ ""]\n\tk = v\n',
            label:
              'plain-only.conf ([s] k=a) seeded, key "..k": [s] is untouched and a new [ ""] section is appended',
          },
        ])('Then $label', async ({ seed, key, expected }) => {
          // Arrange
          const ctx = createMemoryContext();
          const path = `${ctx.layout.gitDir}/config`;
          if (seed !== undefined) {
            await ctx.fs.writeUtf8(path, seed);
          }

          // Act
          await setConfigEntry({ ctx, key, value: 'v' });

          // Assert
          const result = await ctx.fs.readUtf8(path);
          expect(result).toBe(expected);
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
