import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import {
  finalizePushRefspecs,
  type PushRefspecPlan,
  planPushRefspecs,
} from '../../../../../src/application/commands/internal/push-refspecs.js';
import type { ParsedConfig } from '../../../../../src/application/primitives/config-read.js';
import { readHeadRaw } from '../../../../../src/application/primitives/internal/repo-state.js';
import { TsgitError } from '../../../../../src/domain/index.js';
import type { Advertisement } from '../../../../../src/domain/protocol/index.js';
import { seedRepo } from '../fixtures.js';

const EMPTY_ADVERTISEMENT: Advertisement = { refs: [], capabilities: [] };

describe('Given push.default=current and an attached branch', () => {
  describe('When planPushRefspecs runs with no explicit refspec', () => {
    it('Then the plan pushes the current branch to the same-named ref', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await seedRepo(ctx, {});
      const config: ParsedConfig = { push: { default: 'current' } };
      const head = await readHeadRaw(ctx);

      // Act
      const result = await planPushRefspecs(ctx, config, {}, head);

      // Assert
      expect(result).toEqual({
        kind: 'fixed',
        refspecs: [
          { force: 'normal', src: 'refs/heads/main', dst: 'refs/heads/main', isDelete: false },
        ],
      });
    });
  });
});

describe('Given push.default=current and a detached HEAD', () => {
  describe('When planPushRefspecs runs with no explicit refspec', () => {
    it('Then it throws PUSH_DETACHED_NO_REFSPEC', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await seedRepo(ctx, { head: '1111111111111111111111111111111111111111' });
      const config: ParsedConfig = { push: { default: 'current' } };
      const head = await readHeadRaw(ctx);

      // Act
      let caught: unknown;
      try {
        await planPushRefspecs(ctx, config, {}, head);
      } catch (error) {
        caught = error;
      }

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      const data = (caught as TsgitError).data;
      expect(data.code).toBe('PUSH_DETACHED_NO_REFSPEC');
    });
  });
});

describe('Given explicit refspecs and push.default=current with a detached HEAD', () => {
  describe('When planPushRefspecs runs', () => {
    it('Then the explicit refspecs win and push.default is never consulted', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await seedRepo(ctx, { head: '2222222222222222222222222222222222222222' });
      const config: ParsedConfig = { push: { default: 'current' } };
      const head = await readHeadRaw(ctx);

      // Act
      const result = await planPushRefspecs(
        ctx,
        config,
        { refspecs: ['refs/heads/feature:refs/heads/feature'] },
        head,
      );

      // Assert
      expect(result).toEqual({
        kind: 'explicit',
        refspecs: [
          {
            force: 'normal',
            src: 'refs/heads/feature',
            dst: 'refs/heads/feature',
            isDelete: false,
          },
        ],
      });
    });
  });
});

describe('Given an attached branch and a push.default mode other than current', () => {
  describe('When planPushRefspecs runs with no explicit refspec', () => {
    it('Then an unset push.default still falls back to the current-branch HEAD default', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await seedRepo(ctx, {});
      const config: ParsedConfig = {};
      const head = await readHeadRaw(ctx);

      // Act
      const result = await planPushRefspecs(ctx, config, {}, head);

      // Assert
      expect(result).toEqual({
        kind: 'fixed',
        refspecs: [
          { force: 'normal', src: 'refs/heads/main', dst: 'refs/heads/main', isDelete: false },
        ],
      });
    });

    it('Then push.default=matching still falls back to the current-branch HEAD default', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await seedRepo(ctx, {});
      const config: ParsedConfig = { push: { default: 'matching' } };
      const head = await readHeadRaw(ctx);

      // Act
      const result = await planPushRefspecs(ctx, config, {}, head);

      // Assert
      expect(result).toEqual({
        kind: 'fixed',
        refspecs: [
          { force: 'normal', src: 'refs/heads/main', dst: 'refs/heads/main', isDelete: false },
        ],
      });
    });
  });
});

describe('Given a detached HEAD and a push.default mode other than current', () => {
  describe('When planPushRefspecs runs with no explicit refspec', () => {
    it('Then it refuses with the pre-existing INVALID_OPTION error, unchanged from before', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await seedRepo(ctx, { head: '3333333333333333333333333333333333333333' });
      const config: ParsedConfig = { push: { default: 'matching' } };
      const head = await readHeadRaw(ctx);

      // Act
      let caught: unknown;
      try {
        await planPushRefspecs(ctx, config, {}, head);
      } catch (error) {
        caught = error;
      }

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      const data = (caught as TsgitError).data;
      expect(data.code).toBe('INVALID_OPTION');
      expect(data).toMatchObject({
        option: 'refspecs',
        reason: 'no-default-refspec (HEAD is detached)',
      });
    });
  });
});

describe('Given an explicit or fixed refspec plan', () => {
  describe('When finalizePushRefspecs resolves it against an advertisement', () => {
    it('Then it passes the refspecs through unchanged', () => {
      // Arrange
      const plan: PushRefspecPlan = {
        kind: 'fixed',
        refspecs: [
          { force: 'normal', src: 'refs/heads/main', dst: 'refs/heads/main', isDelete: false },
        ],
      };

      // Act
      const result = finalizePushRefspecs(plan, EMPTY_ADVERTISEMENT);

      // Assert
      expect(result).toBe(plan.refspecs);
    });
  });
});

describe('Given a matching refspec plan', () => {
  describe('When finalizePushRefspecs resolves it against an advertisement', () => {
    it('Then it returns an empty placeholder list', () => {
      // Arrange
      const plan: PushRefspecPlan = { kind: 'matching' };

      // Act
      const result = finalizePushRefspecs(plan, EMPTY_ADVERTISEMENT);

      // Assert
      expect(result).toEqual([]);
    });
  });
});
