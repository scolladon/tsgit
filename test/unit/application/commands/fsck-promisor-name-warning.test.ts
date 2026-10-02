/**
 * A `/`-leading promisor remote: git warns while it registers promisor remotes,
 * which fsck does only once its walk consults one — with a root to mark, or a
 * ref naming an object it cannot parse. An unborn repository with nothing
 * rooted never does.
 */
import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { fsck } from '../../../../src/application/commands/fsck.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import type { ObjectId } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';

const enc = new TextEncoder();

/** An unborn repository with a `/`-leading promisor remote, and the warnings it logs. */
const unbornWithSlashPromisor = async (): Promise<{ ctx: Context; warnings: string[] }> => {
  const warnings: string[] = [];
  const base = createMemoryContext();
  const ctx: Context = {
    ...base,
    logger: { warn: (message, context) => warnings.push(`${message} ${String(context?.remote)}`) },
  };
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[remote "/x"]\n\tpromisor = true\n');
  return { ctx, warnings };
};

const PROMISOR_WARNING = /promisor remote name cannot begin with '\/' \/x$/;

describe('Given an unborn repository with a /-leading promisor remote and no object', () => {
  describe('When fsck runs', () => {
    it('Then nothing warns — no walk consults a promisor remote', async () => {
      // Arrange
      const { ctx, warnings } = await unbornWithSlashPromisor();
      const sut = fsck;

      // Act
      await sut(ctx);

      // Assert
      expect(warnings.filter((line) => PROMISOR_WARNING.test(line))).toEqual([]);
    });
  });
});

describe('Given an unborn repository with a /-leading promisor remote and an unreachable blob', () => {
  describe('When fsck runs', () => {
    it('Then nothing warns — nothing is rooted', async () => {
      // Arrange
      const { ctx, warnings } = await unbornWithSlashPromisor();
      await writeObject(ctx, { type: 'blob', id: '' as ObjectId, content: enc.encode('a\n') });
      const sut = fsck;

      // Act
      await sut(ctx);

      // Assert
      expect(warnings.filter((line) => PROMISOR_WARNING.test(line))).toEqual([]);
    });
  });
});

describe('Given a /-leading promisor remote and a ref naming an object no store holds', () => {
  describe('When fsck runs', () => {
    it('Then it warns once — the ref sends git to its promisor remotes', async () => {
      // Arrange
      const { ctx, warnings } = await unbornWithSlashPromisor();
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${'1'.repeat(40)}\n`);
      const sut = fsck;

      // Act
      await sut(ctx);

      // Assert
      expect(warnings.filter((line) => PROMISOR_WARNING.test(line))).toHaveLength(1);
    });
  });
});

const MISSING = '1'.repeat(40);
const reflogNamingMissing = `${'0'.repeat(40)} ${MISSING} A <a@b> 1700000000 +0000\tx\n`;

describe('Given an unborn repository with a /-leading promisor remote and a reflog entry naming a missing object', () => {
  describe('When fsck runs', () => {
    it('Then it warns once — git asks whether the missing object is promised', async () => {
      // Arrange
      const { ctx, warnings } = await unbornWithSlashPromisor();
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/logs/HEAD`, reflogNamingMissing);
      const sut = fsck;

      // Act
      await sut(ctx);

      // Assert
      expect(warnings.filter((line) => PROMISOR_WARNING.test(line))).toHaveLength(1);
    });
  });
});

describe('Given an unborn repository with a malformed remote promisor flag and a reflog entry naming a missing object', () => {
  describe('When fsck runs', () => {
    it('Then it refuses the flag, as git loads its promisor remotes there', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[remote "y"]\n\tpromisor = bogus\n');
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/logs/HEAD`, reflogNamingMissing);
      const sut = fsck;

      // Act
      const result = await sut(ctx).then(
        () => undefined,
        (err: { readonly data?: unknown }) => err.data,
      );

      // Assert
      expect(result).toMatchObject({ code: 'CONFIG_BAD_BOOLEAN_VALUE', key: 'remote.y.promisor' });
    });
  });
});
