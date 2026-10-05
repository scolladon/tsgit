import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { removeBranchState } from '../../../../../src/application/commands/internal/branch-state.js';
import type { Context } from '../../../../../src/ports/context.js';

type Logged = readonly [level: string, message: string];

const OID = '1234567890123456789012345678901234567890';

const loggingContext = (): { readonly ctx: Context; readonly logged: Logged[] } => {
  const logged: Logged[] = [];
  const logger = { warn: (message: string) => logged.push(['warn', message]) };
  return { ctx: { ...createMemoryContext(), logger }, logged };
};

const plant = (ctx: Context, name: string, content = `${OID}\n`): Promise<void> =>
  ctx.fs.writeUtf8(`${ctx.layout.gitDir}/${name}`, content);

describe('removeBranchState', () => {
  describe('Given a cherry-pick and a revert both stopped', () => {
    describe('When the removal is announced', () => {
      it('Then git warns of each cancelled operation, pick first', async () => {
        // Arrange
        const { ctx, logged } = loggingContext();
        await plant(ctx, 'CHERRY_PICK_HEAD');
        await plant(ctx, 'REVERT_HEAD');
        const sut = removeBranchState;

        // Act
        await sut(ctx, 'announce');

        // Assert
        expect(logged).toEqual([
          ['warn', 'cancelling a cherry picking in progress'],
          ['warn', 'cancelling a revert in progress'],
        ]);
      });
    });

    describe('When the removal is silent', () => {
      it('Then nothing is reported and both markers are gone', async () => {
        // Arrange
        const { ctx, logged } = loggingContext();
        await plant(ctx, 'CHERRY_PICK_HEAD');
        await plant(ctx, 'REVERT_HEAD');
        const sut = removeBranchState;

        // Act
        await sut(ctx, 'silent');

        // Assert
        expect(logged).toEqual([]);
        const result = await ctx.fs.exists(`${ctx.layout.gitDir}/REVERT_HEAD`);
        expect(result).toBe(false);
      });
    });
  });

  describe('Given a stopped revert whose sequencer todo is empty', () => {
    describe('When the branch state is removed', () => {
      it('Then the finished sequencer goes too', async () => {
        // Arrange
        const { ctx } = loggingContext();
        await plant(ctx, 'REVERT_HEAD');
        await plant(ctx, 'sequencer/todo', '');
        const sut = removeBranchState;

        // Act
        await sut(ctx, 'silent');

        // Assert
        const result = await ctx.fs.exists(`${ctx.layout.gitDir}/sequencer`);
        expect(result).toBe(false);
      });
    });
  });

  describe('Given a stopped pick whose todo holds one unterminated line', () => {
    describe('When the branch state is removed', () => {
      it('Then the finished sequencer goes too', async () => {
        // Arrange
        const { ctx } = loggingContext();
        await plant(ctx, 'CHERRY_PICK_HEAD');
        await plant(ctx, 'sequencer/todo', 'pick 1234567 one');
        const sut = removeBranchState;

        // Act
        await sut(ctx, 'silent');

        // Assert
        const result = await ctx.fs.exists(`${ctx.layout.gitDir}/sequencer`);
        expect(result).toBe(false);
      });
    });
  });
});
