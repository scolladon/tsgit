import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { dwimRefName } from '../../../../../src/application/commands/internal/revision-name.js';
import type { Context } from '../../../../../src/ports/context.js';
import { seedRepo } from '../fixtures.js';

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** A repository whose `refs/heads/main` holds one commit, plus the given symbolic refs. */
const repoWithSymrefs = async (symrefs: Readonly<Record<string, string>>): Promise<Context> => {
  const ctx = createMemoryContext();
  const { commitIds } = await seedRepo(ctx, { commits: [{ tree: EMPTY_TREE }] });
  await seedRepo(ctx, {
    refs: { 'refs/heads/main': commitIds[0] as string, 'refs/tags/main': commitIds[0] as string },
  });
  for (const [name, target] of Object.entries(symrefs)) {
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/${name}`, `ref: ${target}\n`);
  }
  return ctx;
};

describe('Given a name dwim_ref resolves', () => {
  describe.each([
    { name: 'main', symrefs: {}, expected: 'refs/tags/main', label: 'the first namespace wins' },
    {
      name: 'HEAD',
      symrefs: { HEAD: 'refs/heads/main' },
      expected: 'refs/heads/main',
      label: 'a symbolic ref is followed',
    },
    {
      name: 'HEAD',
      symrefs: {
        HEAD: 'refs/heads/a',
        'refs/heads/a': 'refs/heads/b',
        'refs/heads/b': 'refs/heads/c',
        'refs/heads/c': 'refs/heads/main',
      },
      expected: 'refs/heads/main',
      label: 'the longest chain git resolves is followed to its end',
    },
    {
      name: 'gone',
      symrefs: { 'refs/heads/gone': 'refs/heads/missing' },
      expected: undefined,
      label: 'a dangling candidate is skipped',
    },
    {
      name: 'loop',
      symrefs: { 'refs/heads/loop': 'refs/heads/loop' },
      expected: undefined,
      label: 'a broken candidate is skipped',
    },
  ])('When dwimRefName resolves $name and $label', ({ name, symrefs, expected }) => {
    it(`Then it names ${expected}`, async () => {
      // Arrange
      const ctx = await repoWithSymrefs(symrefs);
      const sut = dwimRefName;

      // Act
      const result = await sut(ctx, name);

      // Assert
      expect(result).toBe(expected);
    });
  });
});
