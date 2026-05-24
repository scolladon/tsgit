import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import {
  __resetConfigCacheForTests,
  readConfig,
} from '../../../../src/application/primitives/config-read.js';
import {
  setConfigEntry,
  setCoreConfigEntry,
  updateConfigEntries,
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

  describe('setCoreConfigEntry', () => {
    it('Given a [core] section with the key present, When setCoreConfigEntry, Then the existing value is replaced', () => {
      // Arrange
      const text = '[core]\n\tsparseCheckout = false\n';

      // Act
      const sut = setCoreConfigEntry(text, 'sparseCheckout', 'true');

      // Assert — the value flips; the line is rewritten with a tab indent.
      expect(sut).toBe('[core]\n\tsparseCheckout = true\n');
    });

    it('Given a [core] section without the key, When setCoreConfigEntry, Then the key is inserted right after the header', () => {
      // Arrange
      const text = '[core]\n\tbare = false\n';

      // Act
      const sut = setCoreConfigEntry(text, 'sparseCheckout', 'true');

      // Assert — inserted immediately after `[core]`, before the existing key.
      expect(sut).toBe('[core]\n\tsparseCheckout = true\n\tbare = false\n');
    });

    it('Given a config with no [core] section, When setCoreConfigEntry, Then a [core] section is appended', () => {
      // Arrange
      const text = '[user]\n\tname = Ada\n';

      // Act
      const sut = setCoreConfigEntry(text, 'sparseCheckout', 'true');

      // Assert — the new section is appended at the end of the file.
      expect(sut).toBe('[user]\n\tname = Ada\n[core]\n\tsparseCheckout = true\n');
    });

    it('Given an empty config text and no [core], When setCoreConfigEntry, Then only the [core] section is produced (no leading blank line)', () => {
      // Arrange — empty input must not yield a stray leading newline.
      const text = '';

      // Act
      const sut = setCoreConfigEntry(text, 'sparseCheckout', 'true');

      // Assert
      expect(sut).toBe('[core]\n\tsparseCheckout = true\n');
    });

    it('Given a config with no [core] and no trailing newline, When setCoreConfigEntry, Then a newline is inserted before the appended section', () => {
      // Arrange — the prefix branch must add the missing `\n` separator.
      const text = '[user]\n\tname = Ada';

      // Act
      const sut = setCoreConfigEntry(text, 'sparseCheckout', 'true');

      // Assert
      expect(sut).toBe('[user]\n\tname = Ada\n[core]\n\tsparseCheckout = true\n');
    });

    it('Given a [core] key whose name differs only in case, When setCoreConfigEntry, Then the existing line is replaced (case-insensitive match)', () => {
      // Arrange — git keys are case-insensitive; an upper-cased on-disk key
      // must still be matched and replaced, not duplicated.
      const text = '[core]\n\tSPARSECHECKOUT = false\n';

      // Act
      const sut = setCoreConfigEntry(text, 'sparseCheckout', 'true');

      // Assert — the line is replaced (re-rendered with the passed-in casing).
      expect(sut).toBe('[core]\n\tsparseCheckout = true\n');
    });

    it('Given other sections, comments and blank lines around [core], When setCoreConfigEntry replaces a key, Then everything else is byte-preserved', () => {
      // Arrange — comments, a blank line, an unrelated section, and unrelated
      // [core] keys (with their own casing/spacing) must survive verbatim.
      const text =
        '# top comment\n[user]\n\tname = Ada\n\n[core]\n\t; core comment\n\tBARE = false\n\tsparseCheckout = false\n[remote "origin"]\n\turl = u\n';

      // Act
      const sut = setCoreConfigEntry(text, 'sparseCheckout', 'true');

      // Assert — only the sparseCheckout value changed.
      expect(sut).toBe(
        '# top comment\n[user]\n\tname = Ada\n\n[core]\n\t; core comment\n\tBARE = false\n\tsparseCheckout = true\n[remote "origin"]\n\turl = u\n',
      );
    });

    it('Given a key only present under a section after [core], When setCoreConfigEntry, Then it is inserted under [core], not matched in the later section', () => {
      // Arrange — `sparseCheckout` lives under `[other]`; the section scan must
      // stop at the `[other]` header and not reach into it.
      const text = '[core]\n\tbare = false\n[other]\n\tsparseCheckout = false\n';

      // Act
      const sut = setCoreConfigEntry(text, 'sparseCheckout', 'true');

      // Assert — inserted under [core]; the [other] line is untouched.
      expect(sut).toBe(
        '[core]\n\tsparseCheckout = true\n\tbare = false\n[other]\n\tsparseCheckout = false\n',
      );
    });

    it('Given a `[core "sub"]` subsection, When setCoreConfigEntry, Then the subsection is NOT treated as [core]', () => {
      // Arrange — a `[core "x"]` header must not satisfy the `[core]` match;
      // with no plain `[core]`, a new one is appended.
      const text = '[core "sub"]\n\tsparseCheckout = false\n';

      // Act
      const sut = setCoreConfigEntry(text, 'sparseCheckout', 'true');

      // Assert — the subsection survives; a real [core] is appended.
      expect(sut).toBe('[core "sub"]\n\tsparseCheckout = false\n[core]\n\tsparseCheckout = true\n');
    });

    it('Given an explicitly empty `[core ""]` header, When setCoreConfigEntry, Then it is treated as the [core] section', () => {
      // Arrange — git writes `[core ""]` for an empty subsection; it is the
      // core section and must be edited in place.
      const text = '[core ""]\n\tbare = false\n';

      // Act
      const sut = setCoreConfigEntry(text, 'sparseCheckout', 'true');

      // Assert — the key is inserted under the `[core ""]` header.
      expect(sut).toBe('[core ""]\n\tsparseCheckout = true\n\tbare = false\n');
    });

    it('Given a [core] body line lacking `=` whose text would key-match after dropping its last char, When setCoreConfigEntry, Then the `=`-less line is not mistaken for the key', () => {
      // Arrange — `sparseCheckoutX` has no `=`. Without the `indexOf('=') === -1`
      // guard, `slice(0, -1)` would yield `sparseCheckout` and falsely match the
      // key, replacing this malformed line instead of inserting a fresh entry.
      const text = '[core]\n\tsparseCheckoutX\n';

      // Act
      const sut = setCoreConfigEntry(text, 'sparseCheckout', 'true');

      // Assert — the key is inserted after the header; the `=`-less line survives.
      expect(sut).toBe('[core]\n\tsparseCheckout = true\n\tsparseCheckoutX\n');
    });

    it('Given a [core] header line with surrounding whitespace, When setCoreConfigEntry, Then it is still recognized as [core]', () => {
      // Arrange — `  [core]  ` trims to `[core]`; the trimmed compare must match.
      const text = '  [core]  \n\tbare = false\n';

      // Act
      const sut = setCoreConfigEntry(text, 'sparseCheckout', 'true');

      // Assert — the original header line is preserved verbatim.
      expect(sut).toBe('  [core]  \n\tsparseCheckout = true\n\tbare = false\n');
    });

    it('Given a key under a later section whose header is indented, When setCoreConfigEntry, Then the section scan stops at the trimmed header (does not reach into it)', () => {
      // Arrange — `  [other]  ` is a real section header only after trimming.
      // Without the trim, the scan would not see it as a boundary and would
      // replace `sparseCheckout` inside `[other]` instead of inserting under [core].
      const text = '[core]\n\tbare = false\n  [other]  \n\tsparseCheckout = false\n';

      // Act
      const sut = setCoreConfigEntry(text, 'sparseCheckout', 'true');

      // Assert — inserted under [core]; the `[other]` line is byte-preserved.
      expect(sut).toBe(
        '[core]\n\tsparseCheckout = true\n\tbare = false\n  [other]  \n\tsparseCheckout = false\n',
      );
    });

    it('Given a [core] body line that starts with `[` but has no closing `]`, When setCoreConfigEntry replaces a later key, Then that line is not treated as a section boundary', () => {
      // Arrange — `[not-a-header` starts with `[` yet is not a real header (no `]`).
      // The scan must require BOTH brackets, else it stops here and inserts a
      // duplicate instead of replacing the real `sparseCheckout` line below it.
      const text = '[core]\n\t[not-a-header\n\tsparseCheckout = false\n';

      // Act
      const sut = setCoreConfigEntry(text, 'sparseCheckout', 'true');

      // Assert — the existing `sparseCheckout` line is replaced in place.
      expect(sut).toBe('[core]\n\t[not-a-header\n\tsparseCheckout = true\n');
    });

    it('Given a [core] body line that ends with `]` but does not start with `[`, When setCoreConfigEntry replaces a later key, Then that line is not treated as a section boundary', () => {
      // Arrange — `not-a-header]` ends with `]` yet is not a real header (no `[`).
      // The scan must require BOTH brackets, else it stops here and inserts a
      // duplicate instead of replacing the real `sparseCheckout` line below it.
      const text = '[core]\n\tnot-a-header]\n\tsparseCheckout = false\n';

      // Act
      const sut = setCoreConfigEntry(text, 'sparseCheckout', 'true');

      // Assert — the existing `sparseCheckout` line is replaced in place.
      expect(sut).toBe('[core]\n\tnot-a-header]\n\tsparseCheckout = true\n');
    });

    it('Given a `[Core]` header (mixed case), When setCoreConfigEntry, Then it is matched and updated in place (no duplicate section)', () => {
      // Arrange — git section names are case-insensitive; a `[Core]` header
      // must be edited in place, not joined by an appended duplicate `[core]`.
      const text = '[Core]\n\tsparseCheckout = false\n';

      // Act
      const sut = setCoreConfigEntry(text, 'sparseCheckout', 'true');

      // Assert — the existing line is replaced; no second `[core]` appears.
      expect(sut).toBe('[Core]\n\tsparseCheckout = true\n');
    });

    it('Given a `[CORE]` header (upper case), When setCoreConfigEntry, Then it is matched and updated in place (no duplicate section)', () => {
      // Arrange — an all-caps header is still the core section.
      const text = '[CORE]\n\tbare = false\n';

      // Act
      const sut = setCoreConfigEntry(text, 'sparseCheckout', 'true');

      // Assert — the key is inserted under `[CORE]`; no appended `[core]`.
      expect(sut).toBe('[CORE]\n\tsparseCheckout = true\n\tbare = false\n');
    });

    it('Given a `[Core "sub"]` subsection (mixed case), When setCoreConfigEntry, Then the subsection is NOT treated as [core]', () => {
      // Arrange — case-insensitivity must not bleed into the subsection: a
      // `[Core "sub"]` header still must not satisfy the plain `[core]` match.
      const text = '[Core "sub"]\n\tsparseCheckout = false\n';

      // Act
      const sut = setCoreConfigEntry(text, 'sparseCheckout', 'true');

      // Assert — the subsection survives; a real [core] is appended.
      expect(sut).toBe('[Core "sub"]\n\tsparseCheckout = false\n[core]\n\tsparseCheckout = true\n');
    });

    it('Given a key containing a newline, When setCoreConfigEntry, Then it throws INVALID_OPTION', () => {
      // Arrange — a `\n` in the key would let line surgery splice a forged
      // section into `.git/config`.
      let caught: unknown;

      // Act
      try {
        setCoreConfigEntry('[core]\n', 'spar\nseCheckout', 'true');
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

    it('Given a value containing a newline, When setCoreConfigEntry, Then it throws INVALID_OPTION', () => {
      // Arrange — a `\n` in the value would inject a fake config section.
      let caught: unknown;

      // Act
      try {
        setCoreConfigEntry('[core]\n', 'sparseCheckout', 'true\n[remote "evil"]');
      } catch (err) {
        caught = err;
      }

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      const data = (caught as TsgitError).data;
      expect(data.code).toBe('INVALID_OPTION');
      if (data.code === 'INVALID_OPTION') {
        expect(data.option).toBe('config');
        expect(data.reason).toBe('value must not contain a newline or NUL');
      }
    });

    it('Given a value containing a carriage return, When setCoreConfigEntry, Then it throws INVALID_OPTION', () => {
      // Arrange — `\r` is rejected alongside `\n` so a CRLF-style splice fails too.
      let caught: unknown;

      // Act
      try {
        setCoreConfigEntry('[core]\n', 'sparseCheckout', 'true\r[evil]');
      } catch (err) {
        caught = err;
      }

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      expect((caught as TsgitError).data.code).toBe('INVALID_OPTION');
    });

    it('Given a value containing a NUL byte, When setCoreConfigEntry, Then it throws INVALID_OPTION', () => {
      // Arrange — `\0` is rejected so a NUL-bearing value cannot reach the file.
      let caught: unknown;

      // Act
      try {
        setCoreConfigEntry('[core]\n', 'sparseCheckout', 'true\0x');
      } catch (err) {
        caught = err;
      }

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      expect((caught as TsgitError).data.code).toBe('INVALID_OPTION');
    });
  });

  describe('updateCoreConfig', () => {
    it('Given a missing .git/config, When updateCoreConfig, Then the file is created with a [core] section', async () => {
      // Arrange — a missing file is treated as empty text.
      const ctx = createMemoryContext();

      // Act
      await updateCoreConfig(ctx, { sparseCheckout: 'true' });

      // Assert
      const written = await ctx.fs.readUtf8(configPath(ctx));
      expect(written).toBe('[core]\n\tsparseCheckout = true\n');
    });

    it('Given an existing config, When updateCoreConfig, Then the result is written back to .git/config', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await seed(ctx, '[core]\n\tbare = false\n');

      // Act
      await updateCoreConfig(ctx, { sparseCheckout: 'true' });

      // Assert
      const written = await ctx.fs.readUtf8(configPath(ctx));
      expect(written).toBe('[core]\n\tsparseCheckout = true\n\tbare = false\n');
    });

    it('Given multiple entries, When updateCoreConfig, Then every entry is folded into the [core] section', async () => {
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

    it('Given a config cached by readConfig, When updateCoreConfig writes, Then a subsequent readConfig sees the new value', async () => {
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

    it('Given no entries, When updateCoreConfig, Then the config is written back unchanged', async () => {
      // Arrange — an empty fold leaves the text identical.
      const ctx = createMemoryContext();
      await seed(ctx, '[core]\n\tbare = true\n');

      // Act
      await updateCoreConfig(ctx, {});

      // Assert
      const written = await ctx.fs.readUtf8(configPath(ctx));
      expect(written).toBe('[core]\n\tbare = true\n');
    });

    it('Given fs.readUtf8 rejects with a non-FILE_NOT_FOUND TsgitError, When updateCoreConfig, Then the error propagates', async () => {
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
      expect((caught as TsgitError).data).toEqual({ code: 'PERMISSION_DENIED', path: '/x/config' });
    });

    it('Given fs.readUtf8 rejects with a non-TsgitError, When updateCoreConfig, Then the error is rethrown', async () => {
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

  describe('setConfigEntry', () => {
    it('Given no matching section, When setConfigEntry, Then the section is appended', () => {
      // Arrange & Act
      const sut = setConfigEntry('', 'extensions', undefined, 'partialClone', 'origin');

      // Assert
      expect(sut).toBe('[extensions]\n\tpartialClone = origin\n');
    });

    it('Given a subsection, When setConfigEntry, Then the subsectioned header is rendered', () => {
      // Arrange & Act
      const sut = setConfigEntry('', 'remote', 'origin', 'url', 'https://e/r.git');

      // Assert
      expect(sut).toBe('[remote "origin"]\n\turl = https://e/r.git\n');
    });

    it('Given an existing section without the key, When setConfigEntry, Then the key is inserted after the header', () => {
      // Arrange
      const text = '[remote "origin"]\n\turl = https://e/r.git\n';

      // Act
      const sut = setConfigEntry(text, 'remote', 'origin', 'promisor', 'true');

      // Assert
      expect(sut).toBe('[remote "origin"]\n\tpromisor = true\n\turl = https://e/r.git\n');
    });

    it('Given an existing key, When setConfigEntry, Then its value is replaced', () => {
      // Arrange
      const text = '[remote "origin"]\n\tpromisor = false\n';

      // Act
      const sut = setConfigEntry(text, 'remote', 'origin', 'promisor', 'true');

      // Assert
      expect(sut).toBe('[remote "origin"]\n\tpromisor = true\n');
    });

    it('Given a subsection differing only in case, When setConfigEntry, Then it is NOT matched (case-sensitive)', () => {
      // Arrange
      const text = '[remote "Origin"]\n\turl = old\n';

      // Act
      const sut = setConfigEntry(text, 'remote', 'origin', 'promisor', 'true');

      // Assert
      expect(sut).toBe('[remote "Origin"]\n\turl = old\n[remote "origin"]\n\tpromisor = true\n');
    });

    it('Given a section header differing only in case, When setConfigEntry, Then it IS matched (case-insensitive)', () => {
      // Arrange
      const text = '[EXTENSIONS]\n\tpartialClone = a\n';

      // Act
      const sut = setConfigEntry(text, 'extensions', undefined, 'partialClone', 'b');

      // Assert
      expect(sut).toBe('[EXTENSIONS]\n\tpartialClone = b\n');
    });

    it('Given a subsection containing a newline, When setConfigEntry, Then it throws INVALID_OPTION', () => {
      // Arrange
      let caught: unknown;
      try {
        setConfigEntry('', 'remote', 'ori\ngin', 'url', 'u');
      } catch (err) {
        caught = err;
      }

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      expect((caught as TsgitError).data.code).toBe('INVALID_OPTION');
    });

    it('Given a subsection containing a quote, When setConfigEntry, Then it throws INVALID_OPTION', () => {
      // Arrange
      let caught: unknown;
      try {
        setConfigEntry('', 'remote', 'ori"gin', 'url', 'u');
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

    it('Given a section name containing a bracket, When setConfigEntry, Then it throws INVALID_OPTION', () => {
      // Arrange
      let caught: unknown;
      try {
        setConfigEntry('', 'core]\n[evil', undefined, 'k', 'v');
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

  describe('updateConfigEntries', () => {
    it('Given entries across several sections, When updateConfigEntries, Then every entry is written', async () => {
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

    it('Given a config cached by readConfig, When updateConfigEntries writes, Then a later readConfig sees it', async () => {
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
