import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import {
  type AutostashSection,
  configuredAutostash,
} from '../../../../../src/application/commands/internal/autostash-config.js';

const SECTIONS: ReadonlyArray<AutostashSection> = ['rebase', 'merge', 'pull'];

const SETTINGS = [
  ['a key without a value', '\tautostash\n', true],
  ['true', '\tautostash = true\n', true],
  ['false', '\tautostash = false\n', false],
  ['no', '\tautostash = no\n', false],
  ['an empty value', '\tautostash =\n', false],
  ['no autostash key', '\tother = true\n', undefined],
] as const;

const CASES = SECTIONS.flatMap((section) =>
  SETTINGS.map(([title, body, expected]) => [section, title, body, expected] as const),
);

describe('configuredAutostash', () => {
  describe.each(CASES)('Given the %s section with %s', (section, _title, body, expected) => {
    describe('When the setting is read', () => {
      it('Then it resolves as git reads the boolean', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, `[${section}]\n${body}`);
        const sut = configuredAutostash;

        // Act
        const result = await sut(ctx, section);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });
});
