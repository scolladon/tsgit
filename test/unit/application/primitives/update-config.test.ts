import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import {
  __resetConfigCacheForTests,
  readConfig,
} from '../../../../src/application/primitives/config-read.js';
import {
  appendConfigEntry,
  type ConfigOperation,
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
          const sut = setCoreConfigEntryInText(text, 'sparseCheckout', 'true');

          // Assert — the value flips; the line is rewritten with a tab indent.
          expect(sut).toBe('[core]\n\tsparseCheckout = true\n');
        });
      });
    });

    describe('Given a [core] section without the key', () => {
      describe('When setCoreConfigEntryInText', () => {
        it('Then the key is inserted right after the header', () => {
          // Arrange
          const text = '[core]\n\tbare = false\n';

          // Act
          const sut = setCoreConfigEntryInText(text, 'sparseCheckout', 'true');

          // Assert — inserted immediately after `[core]`, before the existing key.
          expect(sut).toBe('[core]\n\tsparseCheckout = true\n\tbare = false\n');
        });
      });
    });

    describe('Given a config with no [core] section', () => {
      describe('When setCoreConfigEntryInText', () => {
        it('Then a [core] section is appended', () => {
          // Arrange
          const text = '[user]\n\tname = Ada\n';

          // Act
          const sut = setCoreConfigEntryInText(text, 'sparseCheckout', 'true');

          // Assert — the new section is appended at the end of the file.
          expect(sut).toBe('[user]\n\tname = Ada\n[core]\n\tsparseCheckout = true\n');
        });
      });
    });

    describe('Given an empty config text and no [core]', () => {
      describe('When setCoreConfigEntryInText', () => {
        it('Then only the [core] section is produced (no leading blank line)', () => {
          // Arrange — empty input must not yield a stray leading newline.
          const text = '';

          // Act
          const sut = setCoreConfigEntryInText(text, 'sparseCheckout', 'true');

          // Assert
          expect(sut).toBe('[core]\n\tsparseCheckout = true\n');
        });
      });
    });

    describe('Given a config with no [core] and no trailing newline', () => {
      describe('When setCoreConfigEntryInText', () => {
        it('Then a newline is inserted before the appended section', () => {
          // Arrange — the prefix branch must add the missing `\n` separator.
          const text = '[user]\n\tname = Ada';

          // Act
          const sut = setCoreConfigEntryInText(text, 'sparseCheckout', 'true');

          // Assert
          expect(sut).toBe('[user]\n\tname = Ada\n[core]\n\tsparseCheckout = true\n');
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
          const sut = setCoreConfigEntryInText(text, 'sparseCheckout', 'true');

          // Assert — the line is replaced (re-rendered with the passed-in casing).
          expect(sut).toBe('[core]\n\tsparseCheckout = true\n');
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
          const sut = setCoreConfigEntryInText(text, 'sparseCheckout', 'true');

          // Assert — only the sparseCheckout value changed.
          expect(sut).toBe(
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
          const sut = setCoreConfigEntryInText(text, 'sparseCheckout', 'true');

          // Assert — inserted under [core]; the [other] line is untouched.
          expect(sut).toBe(
            '[core]\n\tsparseCheckout = true\n\tbare = false\n[other]\n\tsparseCheckout = false\n',
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
          const sut = setCoreConfigEntryInText(text, 'sparseCheckout', 'true');

          // Assert — the subsection survives; a real [core] is appended.
          expect(sut).toBe(
            '[core "sub"]\n\tsparseCheckout = false\n[core]\n\tsparseCheckout = true\n',
          );
        });
      });
    });

    describe('Given an explicitly empty `[core ""]` header', () => {
      describe('When setCoreConfigEntryInText', () => {
        it('Then it is treated as the [core] section', () => {
          // Arrange — git writes `[core ""]` for an empty subsection; it is the
          // core section and must be edited in place.
          const text = '[core ""]\n\tbare = false\n';

          // Act
          const sut = setCoreConfigEntryInText(text, 'sparseCheckout', 'true');

          // Assert — the key is inserted under the `[core ""]` header.
          expect(sut).toBe('[core ""]\n\tsparseCheckout = true\n\tbare = false\n');
        });
      });
    });

    describe('Given a [core] body line lacking `=` whose text would key-match after dropping its last char', () => {
      describe('When setCoreConfigEntryInText', () => {
        it('Then the `=`-less line is not mistaken for the key', () => {
          // Arrange — `sparseCheckoutX` has no `=`. Without the `indexOf('=') === -1`
          // guard, `slice(0, -1)` would yield `sparseCheckout` and falsely match the
          // key, replacing this malformed line instead of inserting a fresh entry.
          const text = '[core]\n\tsparseCheckoutX\n';

          // Act
          const sut = setCoreConfigEntryInText(text, 'sparseCheckout', 'true');

          // Assert — the key is inserted after the header; the `=`-less line survives.
          expect(sut).toBe('[core]\n\tsparseCheckout = true\n\tsparseCheckoutX\n');
        });
      });
    });

    describe('Given a [core] header line with surrounding whitespace', () => {
      describe('When setCoreConfigEntryInText', () => {
        it('Then it is still recognized as [core]', () => {
          // Arrange — `  [core]  ` trims to `[core]`; the trimmed compare must match.
          const text = '  [core]  \n\tbare = false\n';

          // Act
          const sut = setCoreConfigEntryInText(text, 'sparseCheckout', 'true');

          // Assert — the original header line is preserved verbatim.
          expect(sut).toBe('  [core]  \n\tsparseCheckout = true\n\tbare = false\n');
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
          const sut = setCoreConfigEntryInText(text, 'sparseCheckout', 'true');

          // Assert — inserted under [core]; the `[other]` line is byte-preserved.
          expect(sut).toBe(
            '[core]\n\tsparseCheckout = true\n\tbare = false\n  [other]  \n\tsparseCheckout = false\n',
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
          const sut = setCoreConfigEntryInText(text, 'sparseCheckout', 'true');

          // Assert — the existing `sparseCheckout` line is replaced in place.
          expect(sut).toBe('[core]\n\t[not-a-header\n\tsparseCheckout = true\n');
        });
      });
    });

    describe('Given a [core] body line that ends with `]` but does not start with `[`', () => {
      describe('When setCoreConfigEntryInText replaces a later key', () => {
        it('Then that line is not treated as a section boundary', () => {
          // Arrange — `not-a-header]` ends with `]` yet is not a real header (no `[`).
          // The scan must require BOTH brackets, else it stops here and inserts a
          // duplicate instead of replacing the real `sparseCheckout` line below it.
          const text = '[core]\n\tnot-a-header]\n\tsparseCheckout = false\n';

          // Act
          const sut = setCoreConfigEntryInText(text, 'sparseCheckout', 'true');

          // Assert — the existing `sparseCheckout` line is replaced in place.
          expect(sut).toBe('[core]\n\tnot-a-header]\n\tsparseCheckout = true\n');
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
          const sut = setCoreConfigEntryInText(text, 'sparseCheckout', 'true');

          // Assert — the existing line is replaced; no second `[core]` appears.
          expect(sut).toBe('[Core]\n\tsparseCheckout = true\n');
        });
      });
    });

    describe('Given a `[CORE]` header (upper case)', () => {
      describe('When setCoreConfigEntryInText', () => {
        it('Then it is matched and updated in place (no duplicate section)', () => {
          // Arrange — an all-caps header is still the core section.
          const text = '[CORE]\n\tbare = false\n';

          // Act
          const sut = setCoreConfigEntryInText(text, 'sparseCheckout', 'true');

          // Assert — the key is inserted under `[CORE]`; no appended `[core]`.
          expect(sut).toBe('[CORE]\n\tsparseCheckout = true\n\tbare = false\n');
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
          const sut = setCoreConfigEntryInText(text, 'sparseCheckout', 'true');

          // Assert — the subsection survives; a real [core] is appended.
          expect(sut).toBe(
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
        it('Then the line is double-quoted with the newline escaped (no fake section injected)', () => {
          // Arrange & Act — `\n` is escaped to literal `\n` inside the quoted value;
          // no raw newline reaches disk, so the on-disk text cannot host an injected section.
          const sut = setCoreConfigEntryInText(
            '[core]\n',
            'sparseCheckout',
            'true\n[remote "evil"]',
          );

          // Assert — exactly one logical line, and the `[remote "evil"]` token is inside the quoted value.
          expect(sut).toBe('[core]\n\tsparseCheckout = "true\\n[remote \\"evil\\"]"\n');
        });
      });
    });

    describe('Given a value containing a carriage return', () => {
      describe('When setCoreConfigEntryInText', () => {
        it('Then it throws INVALID_OPTION', () => {
          // Arrange — `\r` is rejected alongside `\n` so a CRLF-style splice fails too.
          let caught: unknown;

          // Act
          try {
            setCoreConfigEntryInText('[core]\n', 'sparseCheckout', 'true\r[evil]');
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data.code).toBe('INVALID_OPTION');
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
          expect((caught as TsgitError).data.code).toBe('INVALID_OPTION');
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

          // Assert
          const written = await ctx.fs.readUtf8(configPath(ctx));
          expect(written).toBe('[core]\n\tsparseCheckout = true\n\tbare = false\n');
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

          // Assert — both keys land under [core]; later-folded key is inserted first.
          const written = await ctx.fs.readUtf8(configPath(ctx));
          expect(written).toBe(
            '[core]\n\tsparseCheckoutCone = false\n\tsparseCheckout = true\n\tbare = false\n',
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
    describe('Given no matching section', () => {
      describe('When setConfigEntryInText', () => {
        it('Then the section is appended', () => {
          // Arrange & Act
          const sut = setConfigEntryInText('', 'extensions', undefined, 'partialClone', 'origin');

          // Assert
          expect(sut).toBe('[extensions]\n\tpartialClone = origin\n');
        });
      });
    });

    describe('Given a subsection', () => {
      describe('When setConfigEntryInText', () => {
        it('Then the subsectioned header is rendered', () => {
          // Arrange & Act
          const sut = setConfigEntryInText('', 'remote', 'origin', 'url', 'https://e/r.git');

          // Assert
          expect(sut).toBe('[remote "origin"]\n\turl = https://e/r.git\n');
        });
      });
    });

    describe('Given an existing section without the key', () => {
      describe('When setConfigEntryInText', () => {
        it('Then the key is inserted after the header', () => {
          // Arrange
          const text = '[remote "origin"]\n\turl = https://e/r.git\n';

          // Act
          const sut = setConfigEntryInText(text, 'remote', 'origin', 'promisor', 'true');

          // Assert
          expect(sut).toBe('[remote "origin"]\n\tpromisor = true\n\turl = https://e/r.git\n');
        });
      });
    });

    describe('Given an existing key', () => {
      describe('When setConfigEntryInText', () => {
        it('Then its value is replaced', () => {
          // Arrange
          const text = '[remote "origin"]\n\tpromisor = false\n';

          // Act
          const sut = setConfigEntryInText(text, 'remote', 'origin', 'promisor', 'true');

          // Assert
          expect(sut).toBe('[remote "origin"]\n\tpromisor = true\n');
        });
      });
    });

    describe('Given a subsection differing only in case', () => {
      describe('When setConfigEntryInText', () => {
        it('Then it is NOT matched (case-sensitive)', () => {
          // Arrange
          const text = '[remote "Origin"]\n\turl = old\n';

          // Act
          const sut = setConfigEntryInText(text, 'remote', 'origin', 'promisor', 'true');

          // Assert
          expect(sut).toBe(
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
          const sut = setConfigEntryInText(text, 'extensions', undefined, 'partialClone', 'b');

          // Assert
          expect(sut).toBe('[EXTENSIONS]\n\tpartialClone = b\n');
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

    describe('Given a subsection containing a quote', () => {
      describe('When setConfigEntryInText', () => {
        it('Then it throws INVALID_OPTION', () => {
          // Arrange
          let caught: unknown;
          try {
            setConfigEntryInText('', 'remote', 'ori"gin', 'url', 'u');
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data;
          expect(data.code).toBe('INVALID_OPTION');
          if (data.code !== 'INVALID_OPTION') throw new Error('unreachable');
          expect(data.option).toBe('config');
          expect(data.reason).toContain('quote');
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
          const sut = setConfigEntryInText('', 'pager', undefined, 'log', 'less # paginate');

          // Assert
          expect(sut).toBe('[pager]\n\tlog = "less # paginate"\n');
        });
      });
    });

    describe('Given a value containing ;', () => {
      describe('When setConfigEntryInText', () => {
        it('Then the rendered line is double-quoted', () => {
          // Arrange & Act — `;` is the second comment delimiter.
          const sut = setConfigEntryInText('', 'pager', undefined, 'log', 'less ; paginate');

          // Assert
          expect(sut).toBe('[pager]\n\tlog = "less ; paginate"\n');
        });
      });
    });

    describe('Given a value with a leading space', () => {
      describe('When setConfigEntryInText', () => {
        it('Then the rendered line is double-quoted', () => {
          // Arrange & Act — leading whitespace would be trimmed by the parser without quotes.
          const sut = setConfigEntryInText('', 'user', undefined, 'name', ' Ada');

          // Assert
          expect(sut).toBe('[user]\n\tname = " Ada"\n');
        });
      });
    });

    describe('Given a value with a leading tab', () => {
      describe('When setConfigEntryInText', () => {
        it('Then the rendered line is double-quoted', () => {
          // Arrange & Act
          const sut = setConfigEntryInText('', 'user', undefined, 'name', '\tAda');

          // Assert
          expect(sut).toBe('[user]\n\tname = "\tAda"\n');
        });
      });
    });

    describe('Given a value with a trailing space', () => {
      describe('When setConfigEntryInText', () => {
        it('Then the rendered line is double-quoted', () => {
          // Arrange & Act
          const sut = setConfigEntryInText('', 'user', undefined, 'name', 'Ada ');

          // Assert
          expect(sut).toBe('[user]\n\tname = "Ada "\n');
        });
      });
    });

    describe('Given a value with a trailing tab', () => {
      describe('When setConfigEntryInText', () => {
        it('Then the rendered line is double-quoted', () => {
          // Arrange & Act
          const sut = setConfigEntryInText('', 'user', undefined, 'name', 'Ada\t');

          // Assert
          expect(sut).toBe('[user]\n\tname = "Ada\t"\n');
        });
      });
    });

    describe('Given a value containing an embedded "', () => {
      describe('When setConfigEntryInText', () => {
        it('Then the quote is escaped inside a double-quoted line', () => {
          // Arrange & Act
          const sut = setConfigEntryInText('', 'user', undefined, 'name', 'Ada "Lovelace"');

          // Assert
          expect(sut).toBe('[user]\n\tname = "Ada \\"Lovelace\\""\n');
        });
      });
    });

    describe('Given a value containing an embedded \\', () => {
      describe('When setConfigEntryInText', () => {
        it('Then the backslash is escaped inside a double-quoted line', () => {
          // Arrange & Act
          const sut = setConfigEntryInText('', 'core', undefined, 'editor', 'C:\\bin\\vim');

          // Assert
          expect(sut).toBe('[core]\n\teditor = "C:\\\\bin\\\\vim"\n');
        });
      });
    });

    describe('Given a value containing an embedded newline', () => {
      describe('When setConfigEntryInText', () => {
        it('Then the newline is escaped as a literal \\n inside a double-quoted line', () => {
          // Arrange & Act — the writer never emits a raw `\n` inside a value (would forge a config line).
          const sut = setConfigEntryInText('', 'alias', undefined, 'lg', 'log\nshort');

          // Assert
          expect(sut).toBe('[alias]\n\tlg = "log\\nshort"\n');
        });
      });
    });

    describe('Given a plain alphanumeric value', () => {
      describe('When setConfigEntryInText', () => {
        it('Then no quotes are added (backward-compatible)', () => {
          // Arrange & Act — values that do not trigger any quoting rule must render verbatim.
          const sut = setConfigEntryInText('', 'user', undefined, 'name', 'Ada');

          // Assert
          expect(sut).toBe('[user]\n\tname = Ada\n');
        });
      });
    });

    describe('Given a value containing only an embedded tab (no other trigger)', () => {
      describe('When setConfigEntryInText', () => {
        it('Then the value is emitted verbatim (no quotes)', () => {
          // Arrange & Act — embedded tabs (not leading/trailing) survive a round-trip without quoting.
          const sut = setConfigEntryInText('', 'user', undefined, 'name', 'A\tB');

          // Assert
          expect(sut).toBe('[user]\n\tname = A\tB\n');
        });
      });
    });

    describe('Given a value with both embedded \\n and embedded \\', () => {
      describe('When setConfigEntryInText', () => {
        it('Then both are escaped (backslashes first, then newlines)', () => {
          // Arrange & Act — escape order matters: replacing `\n` before `\\` would double-escape backslashes.
          const sut = setConfigEntryInText('', 'alias', undefined, 'lg', 'a\\b\nc');

          // Assert
          expect(sut).toBe('[alias]\n\tlg = "a\\\\b\\nc"\n');
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
          const sut = removeConfigEntry(text, 'remote', 'origin', 'url');

          // Assert — header + fetch line preserved.
          expect(sut).toBe('[remote "origin"]\n\tfetch = +A:B\n');
        });
      });
    });

    describe('Given a section without the key', () => {
      describe('When removeConfigEntry', () => {
        it('Then the text is byte-identical', () => {
          // Arrange
          const text = '[remote "origin"]\n\tfetch = +A:B\n';

          // Act
          const sut = removeConfigEntry(text, 'remote', 'origin', 'url');

          // Assert
          expect(sut).toBe(text);
        });
      });
    });

    describe('Given no matching section', () => {
      describe('When removeConfigEntry', () => {
        it('Then the text is byte-identical', () => {
          // Arrange
          const text = '[core]\n\tbare = false\n';

          // Act
          const sut = removeConfigEntry(text, 'remote', 'origin', 'url');

          // Assert
          expect(sut).toBe(text);
        });
      });
    });

    describe('Given the key appearing twice in one section', () => {
      describe('When removeConfigEntry', () => {
        it('Then every occurrence is removed (--unset-all semantics)', () => {
          // Arrange — two `fetch =` lines, both must go.
          const text = '[remote "origin"]\n\tfetch = +A:B\n\tfetch = +C:D\n\turl = u\n';

          // Act
          const sut = removeConfigEntry(text, 'remote', 'origin', 'fetch');

          // Assert
          expect(sut).toBe('[remote "origin"]\n\turl = u\n');
        });
      });
    });

    describe('Given the same key in two different sections', () => {
      describe('When removeConfigEntry targets one section', () => {
        it('Then the other section is preserved byte-for-byte', () => {
          // Arrange
          const text = '[remote "origin"]\n\turl = O\n[remote "upstream"]\n\turl = U\n';

          // Act
          const sut = removeConfigEntry(text, 'remote', 'origin', 'url');

          // Assert
          expect(sut).toBe('[remote "origin"]\n[remote "upstream"]\n\turl = U\n');
        });
      });
    });

    describe('Given a key match with different casing', () => {
      describe('When removeConfigEntry', () => {
        it('Then the key is matched case-insensitively (git semantics)', () => {
          // Arrange
          const text = '[remote "origin"]\n\tURL = up\n';

          // Act
          const sut = removeConfigEntry(text, 'remote', 'origin', 'url');

          // Assert — case-insensitive match removed the entry.
          expect(sut).toBe('[remote "origin"]\n');
        });
      });
    });

    describe('Given the key in a different section', () => {
      describe('When removeConfigEntry targets a section that has no such key', () => {
        it('Then the key line in the OTHER section is untouched', () => {
          // Arrange — `url` lives only in the second `[remote "B"]` block.
          const text = '[remote "A"]\n\tfetch = +x:y\n[remote "B"]\n\turl = u\n';

          // Act
          const sut = removeConfigEntry(text, 'remote', 'A', 'url');

          // Assert — the unrelated section is preserved verbatim.
          expect(sut).toBe(text);
        });
      });
    });
  });

  describe('removeConfigSectionInText', () => {
    describe('Given a section that is the last block', () => {
      describe('When removeConfigSectionInText', () => {
        it('Then the header and body are gone', () => {
          // Arrange
          const text = '[remote "origin"]\n\turl = u\n\tfetch = +A:B\n';

          // Act
          const sut = removeConfigSectionInText(text, 'remote', 'origin');

          // Assert
          expect(sut).toBe('');
        });
      });
    });

    describe('Given a section followed by another section', () => {
      describe('When removeConfigSectionInText', () => {
        it('Then the following section is preserved byte-for-byte', () => {
          // Arrange
          const text = '[remote "origin"]\n\turl = O\n[remote "upstream"]\n\turl = U\n';

          // Act
          const sut = removeConfigSectionInText(text, 'remote', 'origin');

          // Assert
          expect(sut).toBe('[remote "upstream"]\n\turl = U\n');
        });
      });
    });

    describe('Given a section preceded by another section', () => {
      describe('When removeConfigSectionInText', () => {
        it('Then the preceding section is preserved', () => {
          // Arrange
          const text = '[core]\n\tbare = false\n[remote "origin"]\n\turl = u\n';

          // Act
          const sut = removeConfigSectionInText(text, 'remote', 'origin');

          // Assert
          expect(sut).toBe('[core]\n\tbare = false\n');
        });
      });
    });

    describe('Given no matching section', () => {
      describe('When removeConfigSectionInText', () => {
        it('Then the text is byte-identical', () => {
          // Arrange
          const text = '[core]\n\tbare = false\n';

          // Act
          const sut = removeConfigSectionInText(text, 'remote', 'origin');

          // Assert
          expect(sut).toBe(text);
        });
      });
    });

    describe('Given two matching section blocks (corrupt config)', () => {
      describe('When removeConfigSectionInText', () => {
        it('Then every occurrence is removed', () => {
          // Arrange — two `[remote "origin"]` headers from a manually-edited file.
          const text =
            '[remote "origin"]\n\turl = A\n[core]\n\tbare = false\n[remote "origin"]\n\turl = B\n';

          // Act
          const sut = removeConfigSectionInText(text, 'remote', 'origin');

          // Assert
          expect(sut).toBe('[core]\n\tbare = false\n');
        });
      });
    });

    describe('Given a section without a subsection', () => {
      describe('When removeConfigSectionInText (no subsection)', () => {
        it('Then it removes the matching plain section', () => {
          // Arrange
          const text = '[core]\n\tbare = false\n[user]\n\tname = Ada\n';

          // Act
          const sut = removeConfigSectionInText(text, 'core', undefined);

          // Assert
          expect(sut).toBe('[user]\n\tname = Ada\n');
        });
      });
    });

    describe('Given a section followed by another section with no trailing newline', () => {
      describe('When removeConfigSectionInText drops the first', () => {
        it('Then the output has no trailing newline either', () => {
          // Arrange — proves the `endedWithNewline` branch flips correctly.
          const text = '[remote "origin"]\n\turl = u\n[core]\n\tbare = false';

          // Act
          const sut = removeConfigSectionInText(text, 'remote', 'origin');

          // Assert
          expect(sut).toBe('[core]\n\tbare = false');
        });
      });
    });

    describe('Given a section name containing a bracket', () => {
      describe('When removeConfigSectionInText', () => {
        it('Then it throws INVALID_OPTION', () => {
          // Arrange
          let caught: unknown;
          try {
            removeConfigSectionInText('', 'core]\n[evil', undefined);
          } catch (err) {
            caught = err;
          }

          // Assert
          expect((caught as TsgitError).data.code).toBe('INVALID_OPTION');
        });
      });
    });

    describe('Given a subsection containing a quote', () => {
      describe('When removeConfigSectionInText', () => {
        it('Then it throws INVALID_OPTION', () => {
          // Arrange
          let caught: unknown;
          try {
            removeConfigSectionInText('', 'remote', 'a"b');
          } catch (err) {
            caught = err;
          }

          // Assert
          expect((caught as TsgitError).data.code).toBe('INVALID_OPTION');
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
    describe('Given a section block matching `from`', () => {
      describe('When renameConfigSectionInText', () => {
        it('Then the header subsection becomes `to` and the body is preserved', () => {
          // Arrange
          const text = '[remote "old"]\n\turl = u\n\tfetch = +A:B\n';

          // Act
          const sut = renameConfigSectionInText(text, 'remote', 'old', 'new');

          // Assert
          expect(sut).toBe('[remote "new"]\n\turl = u\n\tfetch = +A:B\n');
        });
      });
    });

    describe('Given the section is one of several', () => {
      describe('When renameConfigSectionInText', () => {
        it('Then unrelated sections are preserved', () => {
          // Arrange
          const text =
            '[core]\n\tbare = false\n[remote "old"]\n\turl = u\n[remote "other"]\n\turl = o\n';

          // Act
          const sut = renameConfigSectionInText(text, 'remote', 'old', 'new');

          // Assert
          expect(sut).toBe(
            '[core]\n\tbare = false\n[remote "new"]\n\turl = u\n[remote "other"]\n\turl = o\n',
          );
        });
      });
    });

    describe('Given no matching section', () => {
      describe('When renameConfigSectionInText', () => {
        it('Then the text is byte-identical', () => {
          // Arrange
          const text = '[remote "other"]\n\turl = o\n';

          // Act
          const sut = renameConfigSectionInText(text, 'remote', 'old', 'new');

          // Assert
          expect(sut).toBe(text);
        });
      });
    });

    describe('Given the same section name twice', () => {
      describe('When renameConfigSectionInText', () => {
        it('Then every occurrence is renamed', () => {
          // Arrange
          const text = '[remote "old"]\n\turl = A\n[remote "old"]\n\turl = B\n';

          // Act
          const sut = renameConfigSectionInText(text, 'remote', 'old', 'new');

          // Assert
          expect(sut).toBe('[remote "new"]\n\turl = A\n[remote "new"]\n\turl = B\n');
        });
      });
    });

    describe('Given a section with the `from` name in a different section family', () => {
      describe('When renameConfigSectionInText', () => {
        it('Then only the targeted family is renamed', () => {
          // Arrange — `[branch "old"]` must NOT be renamed when family is `remote`.
          const text = '[branch "old"]\n\tmerge = m\n[remote "old"]\n\turl = u\n';

          // Act
          const sut = renameConfigSectionInText(text, 'remote', 'old', 'new');

          // Assert
          expect(sut).toBe('[branch "old"]\n\tmerge = m\n[remote "new"]\n\turl = u\n');
        });
      });
    });

    describe('Given a target subsection containing a newline', () => {
      describe('When renameConfigSectionInText', () => {
        it('Then it throws INVALID_OPTION', () => {
          // Arrange
          let caught: unknown;
          try {
            renameConfigSectionInText('', 'remote', 'old', 'ne\nw');
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data.code).toBe('INVALID_OPTION');
        });
      });
    });
  });

  describe('appendConfigEntry', () => {
    describe('Given an existing section with one prior entry for the key', () => {
      describe('When appendConfigEntry', () => {
        it('Then the new entry is inserted AFTER the existing one (order preserved)', () => {
          // Arrange
          const text = '[remote "r"]\n\tfetch = A\n';

          // Act
          const sut = appendConfigEntry(text, 'remote', 'r', 'fetch', 'B');

          // Assert
          expect(sut).toBe('[remote "r"]\n\tfetch = A\n\tfetch = B\n');
        });
      });
    });

    describe('Given an existing section with NO prior matching key', () => {
      describe('When appendConfigEntry', () => {
        it('Then the entry is inserted directly after the header', () => {
          // Arrange
          const text = '[remote "r"]\n\turl = u\n';

          // Act
          const sut = appendConfigEntry(text, 'remote', 'r', 'fetch', 'A');

          // Assert
          expect(sut).toBe('[remote "r"]\n\tfetch = A\n\turl = u\n');
        });
      });
    });

    describe('Given a section is followed by another section', () => {
      describe('When appendConfigEntry', () => {
        it('Then a matching key in the LATER section is NOT considered', () => {
          // Arrange — `fetch = X` lives in the SECOND section; appending to
          // the first must insert under the first's header, not after the
          // unrelated later section's entry.
          const text = '[remote "r"]\n\turl = u\n[remote "other"]\n\tfetch = X\n';

          // Act
          const sut = appendConfigEntry(text, 'remote', 'r', 'fetch', 'A');

          // Assert
          expect(sut).toBe('[remote "r"]\n\tfetch = A\n\turl = u\n[remote "other"]\n\tfetch = X\n');
        });
      });
    });

    describe('Given no matching section', () => {
      describe('When appendConfigEntry', () => {
        it('Then the section is created and the entry appended', () => {
          // Arrange
          const text = '[core]\n\tbare = false\n';

          // Act
          const sut = appendConfigEntry(text, 'remote', 'r', 'fetch', 'A');

          // Assert
          expect(sut).toBe('[core]\n\tbare = false\n[remote "r"]\n\tfetch = A\n');
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
    it('Then it throws CONFIG_VALUE_INVALID at the CR position', async () => {
      // Arrange
      const ctx = createMemoryContext();
      let caught: TsgitError | undefined;

      // Act
      try {
        await setConfigEntry({ ctx, key: 'user.name', value: 'x\ry' });
      } catch (err) {
        caught = err as TsgitError;
      }

      // Assert
      expect((caught?.data as { reason: string; position: number }).reason).toBe(
        'control-character',
      );
      expect((caught?.data as { reason: string; position: number }).position).toBe(1);
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

  describe('Given a cross-family rename (remote.origin → branch.main), When renameConfigSection runs', () => {
    it('Then it throws INVALID_OPTION', async () => {
      // Arrange
      const ctx = createMemoryContext();
      let caught: TsgitError | undefined;

      // Act
      try {
        await renameConfigSection({
          ctx,
          oldName: 'remote.origin',
          newName: 'branch.main',
        });
      } catch (err) {
        caught = err as TsgitError;
      }

      // Assert
      expect(caught?.data.code).toBe('INVALID_OPTION');
    });
  });

  describe('Given oldName with no subsection (just "user"), When renameConfigSection runs', () => {
    it('Then it throws INVALID_OPTION', async () => {
      // Arrange
      const ctx = createMemoryContext();
      let caught: TsgitError | undefined;

      // Act
      try {
        await renameConfigSection({ ctx, oldName: 'user', newName: 'user.x' });
      } catch (err) {
        caught = err as TsgitError;
      }

      // Assert
      expect(caught?.data.code).toBe('INVALID_OPTION');
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

  describe('Given a malformed sectionName (no dot), When removeConfigSection runs', () => {
    it('Then it throws INVALID_OPTION', async () => {
      // Arrange
      const ctx = createMemoryContext();
      let caught: TsgitError | undefined;

      // Act
      try {
        await removeConfigSection({ ctx, sectionName: 'remote' });
      } catch (err) {
        caught = err as TsgitError;
      }

      // Assert
      expect(caught?.data.code).toBe('INVALID_OPTION');
    });
  });
});
