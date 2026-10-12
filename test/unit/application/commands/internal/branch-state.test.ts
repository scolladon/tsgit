import { describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { removeBranchState } from '../../../../../src/application/commands/internal/branch-state.js';
import { permissionDenied } from '../../../../../src/domain/error.js';
import type { Context } from '../../../../../src/ports/context.js';

type Logged = readonly [level: string, message: string];

const OID = '1234567890123456789012345678901234567890';

const loggingContext = (): { readonly ctx: Context; readonly logged: Logged[] } => {
  const logged: Logged[] = [];
  const logger = {
    warn: (message: string) => logged.push(['warn', message]),
    error: (message: string) => logged.push(['error', message]),
  };
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

  describe('Given a stopped revert and a sequencer without a todo', () => {
    describe('When the branch state is removed', () => {
      it('Then the sequencer stays and the marker goes', async () => {
        // Arrange
        const { ctx } = loggingContext();
        await plant(ctx, 'REVERT_HEAD');
        await plant(ctx, 'sequencer/head');
        const sut = removeBranchState;

        // Act
        await sut(ctx, 'silent');

        // Assert
        const sequencerHead = await ctx.fs.exists(`${ctx.layout.gitDir}/sequencer/head`);
        const marker = await ctx.fs.exists(`${ctx.layout.gitDir}/REVERT_HEAD`);
        expect([sequencerHead, marker]).toEqual([true, false]);
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

  describe('Given an AUTO_MERGE that holds no object id', () => {
    describe('When the branch state is removed', () => {
      it('Then git reports the broken ref once per cleanup that deletes it, and leaves it in place', async () => {
        // Arrange
        const { ctx, logged } = loggingContext();
        await plant(ctx, 'AUTO_MERGE', 'garbage\n');
        const sut = removeBranchState;

        // Act
        await sut(ctx, 'silent');

        // Assert
        const broken =
          "cannot lock ref 'AUTO_MERGE': unable to resolve reference 'AUTO_MERGE': reference broken";
        expect(logged).toEqual([
          ['error', broken],
          ['error', broken],
        ]);
        const result = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/AUTO_MERGE`);
        expect(result).toBe('garbage\n');
      });
    });
  });

  describe('Given an AUTO_MERGE naming a tree', () => {
    describe('When the branch state is removed', () => {
      it('Then AUTO_MERGE is gone', async () => {
        // Arrange
        const { ctx } = loggingContext();
        await plant(ctx, 'AUTO_MERGE');
        const sut = removeBranchState;

        // Act
        await sut(ctx, 'silent');

        // Assert
        const result = await ctx.fs.exists(`${ctx.layout.gitDir}/AUTO_MERGE`);
        expect(result).toBe(false);
      });
    });
  });
});

describe('removeBranchState — the state files it unlinks', () => {
  describe('Given a dangling symbolic link at SQUASH_MSG and at MERGE_MSG', () => {
    describe('When the branch state is removed', () => {
      it("Then both links are gone, as git's unlink removes the link itself", async () => {
        // Arrange
        const { ctx } = loggingContext();
        await ctx.fs.symlink('nowhere', `${ctx.layout.gitDir}/SQUASH_MSG`);
        await ctx.fs.symlink('nowhere', `${ctx.layout.gitDir}/MERGE_MSG`);
        const sut = removeBranchState;

        // Act
        await sut(ctx, 'silent');

        // Assert
        const result = await Promise.all(
          ['SQUASH_MSG', 'MERGE_MSG'].map((name) =>
            ctx.fs.lexists?.(`${ctx.layout.gitDir}/${name}`),
          ),
        );
        expect(result).toEqual([false, false]);
      });
    });
  });

  describe('Given no state file at all', () => {
    describe('When the branch state is removed', () => {
      it('Then each state file costs one removal and no presence probe', async () => {
        // Arrange
        const { ctx } = loggingContext();
        const exists = vi.spyOn(ctx.fs, 'exists');
        const rm = vi.spyOn(ctx.fs, 'rm');
        const sut = removeBranchState;

        // Act
        await sut(ctx, 'silent');

        // Assert
        const stateFiles = ['SQUASH_MSG', 'MERGE_HEAD', 'MERGE_RR', 'MERGE_MSG', 'MERGE_MODE'].map(
          (name) => `${ctx.layout.gitDir}/${name}`,
        );
        expect(
          exists.mock.calls.map(([path]) => path).filter((p) => stateFiles.includes(p)),
        ).toEqual([]);
        expect(rm.mock.calls.map(([path]) => path).filter((p) => stateFiles.includes(p))).toEqual(
          stateFiles,
        );
      });
    });
  });

  describe('Given a removal that fails for a reason other than absence', () => {
    describe('When the branch state is removed', () => {
      it('Then the refusal propagates', async () => {
        // Arrange
        const { ctx } = loggingContext();
        await plant(ctx, 'SQUASH_MSG');
        const fault = permissionDenied(`${ctx.layout.gitDir}/SQUASH_MSG`);
        vi.spyOn(ctx.fs, 'rm').mockRejectedValue(fault);
        const sut = removeBranchState;

        // Act
        const result = await sut(ctx, 'silent').catch((error: unknown) => error);

        // Assert
        expect(result).toBe(fault);
      });
    });
  });
});
