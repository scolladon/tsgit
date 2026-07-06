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

describe('Given an attached branch, a central remote, and no branch.merge configured', () => {
  describe('When planPushRefspecs runs with an unset push.default (simple is the default mode)', () => {
    it('Then it throws NO_UPSTREAM_CONFIGURED, not the old unconditional current-branch push', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await seedRepo(ctx, {});
      const config: ParsedConfig = {};
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
      expect(data.code).toBe('NO_UPSTREAM_CONFIGURED');
      expect(data).toMatchObject({ branch: 'refs/heads/main' });
    });
  });
});

describe('Given an attached branch and a push.default mode other than current', () => {
  describe('When planPushRefspecs runs with no explicit refspec', () => {
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

describe('Given push.default=nothing and an attached branch', () => {
  describe('When planPushRefspecs runs with no explicit refspec', () => {
    it('Then it throws PUSH_DEFAULT_NOTHING', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await seedRepo(ctx, {});
      const config: ParsedConfig = { push: { default: 'nothing' } };
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
      expect(data.code).toBe('PUSH_DEFAULT_NOTHING');
    });
  });
});

describe('Given push.default=nothing and a detached HEAD', () => {
  describe('When planPushRefspecs runs with no explicit refspec', () => {
    it('Then it throws PUSH_DEFAULT_NOTHING', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await seedRepo(ctx, { head: '4444444444444444444444444444444444444444' });
      const config: ParsedConfig = { push: { default: 'nothing' } };
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
      expect(data.code).toBe('PUSH_DEFAULT_NOTHING');
    });
  });
});

describe('Given explicit refspecs and push.default=nothing', () => {
  describe('When planPushRefspecs runs', () => {
    it('Then the explicit refspecs win and push.default is never consulted', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await seedRepo(ctx, {});
      const config: ParsedConfig = { push: { default: 'nothing' } };
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

describe('Given push.default=upstream and a detached HEAD', () => {
  describe('When planPushRefspecs runs with no explicit refspec', () => {
    it('Then it throws PUSH_DETACHED_NO_REFSPEC', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await seedRepo(ctx, { head: '5555555555555555555555555555555555555555' });
      const config: ParsedConfig = { push: { default: 'upstream' } };
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

describe('Given push.default=upstream with a triangular remote and branch.merge set', () => {
  describe('When planPushRefspecs runs with no explicit refspec', () => {
    it('Then it throws PUSH_REMOTE_NOT_UPSTREAM even though an upstream is configured', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await seedRepo(ctx, {});
      const config: ParsedConfig = {
        push: { default: 'upstream' },
        remotePushDefault: 'pushdef',
        branch: new Map([['main', { remote: 'origin', merge: 'refs/heads/main' }]]),
      };
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
      expect(data.code).toBe('PUSH_REMOTE_NOT_UPSTREAM');
      expect(data).toMatchObject({ remote: 'pushdef', branch: 'refs/heads/main' });
    });
  });
});

describe('Given push.default=upstream with a triangular remote and no branch.merge configured', () => {
  describe('When planPushRefspecs runs with no explicit refspec', () => {
    it('Then it throws PUSH_REMOTE_NOT_UPSTREAM, not NO_UPSTREAM_CONFIGURED (triangular dominates)', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await seedRepo(ctx, {});
      const config: ParsedConfig = {
        push: { default: 'upstream' },
        remotePushDefault: 'pushdef',
        branch: new Map([['main', { remote: 'origin' }]]),
      };
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
      expect(data.code).toBe('PUSH_REMOTE_NOT_UPSTREAM');
      expect(data).toMatchObject({ remote: 'pushdef', branch: 'refs/heads/main' });
    });
  });
});

describe('Given push.default=upstream and an explicit opts.remote overriding a central branch.remote', () => {
  describe('When planPushRefspecs runs with no explicit refspec', () => {
    it('Then the explicit remote is treated as the push remote for the triangular check', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await seedRepo(ctx, {});
      const config: ParsedConfig = {
        push: { default: 'upstream' },
        branch: new Map([['main', { remote: 'origin', merge: 'refs/heads/main' }]]),
      };
      const head = await readHeadRaw(ctx);

      // Act
      let caught: unknown;
      try {
        await planPushRefspecs(ctx, config, { remote: 'other-remote' }, head);
      } catch (error) {
        caught = error;
      }

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      const data = (caught as TsgitError).data;
      expect(data.code).toBe('PUSH_REMOTE_NOT_UPSTREAM');
      expect(data).toMatchObject({ remote: 'other-remote', branch: 'refs/heads/main' });
    });
  });
});

describe('Given push.default=upstream with a central remote and no branch.merge configured', () => {
  describe('When planPushRefspecs runs with no explicit refspec', () => {
    it('Then it throws NO_UPSTREAM_CONFIGURED', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await seedRepo(ctx, {});
      const config: ParsedConfig = {
        push: { default: 'upstream' },
        branch: new Map([['main', { remote: 'origin' }]]),
      };
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
      expect(data.code).toBe('NO_UPSTREAM_CONFIGURED');
      expect(data).toMatchObject({ branch: 'refs/heads/main' });
    });
  });
});

describe('Given push.default=upstream with a central remote and branch.merge set to a different name', () => {
  describe('When planPushRefspecs runs with no explicit refspec', () => {
    it('Then the plan pushes the current branch to the configured upstream ref', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await seedRepo(ctx, {});
      const config: ParsedConfig = {
        push: { default: 'upstream' },
        branch: new Map([['main', { remote: 'origin', merge: 'refs/heads/other' }]]),
      };
      const head = await readHeadRaw(ctx);

      // Act
      const result = await planPushRefspecs(ctx, config, {}, head);

      // Assert
      expect(result).toEqual({
        kind: 'fixed',
        refspecs: [
          { force: 'normal', src: 'refs/heads/main', dst: 'refs/heads/other', isDelete: false },
        ],
      });
    });
  });
});

describe('Given push.default=simple and a detached HEAD', () => {
  describe('When planPushRefspecs runs with no explicit refspec', () => {
    it('Then it throws PUSH_DETACHED_NO_REFSPEC', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await seedRepo(ctx, { head: '6666666666666666666666666666666666666666' });
      const config: ParsedConfig = { push: { default: 'simple' } };
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

describe('Given push.default=simple with a triangular remote and branch.merge set to a different name', () => {
  describe('When planPushRefspecs runs with no explicit refspec', () => {
    it('Then the plan pushes the current branch to the same-named ref, bypassing the name-mismatch check', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await seedRepo(ctx, {});
      const config: ParsedConfig = {
        push: { default: 'simple' },
        remotePushDefault: 'pushdef',
        branch: new Map([['main', { remote: 'origin', merge: 'refs/heads/other' }]]),
      };
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

describe('Given push.default=simple with a central remote and no branch.merge configured', () => {
  describe('When planPushRefspecs runs with no explicit refspec', () => {
    it('Then it throws NO_UPSTREAM_CONFIGURED', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await seedRepo(ctx, {});
      const config: ParsedConfig = {
        push: { default: 'simple' },
        branch: new Map([['main', { remote: 'origin' }]]),
      };
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
      expect(data.code).toBe('NO_UPSTREAM_CONFIGURED');
      expect(data).toMatchObject({ branch: 'refs/heads/main' });
    });
  });
});

describe('Given push.default=simple with a central remote and branch.merge set to a different name', () => {
  describe('When planPushRefspecs runs with no explicit refspec', () => {
    it('Then it throws PUSH_UPSTREAM_NAME_MISMATCH', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await seedRepo(ctx, {});
      const config: ParsedConfig = {
        push: { default: 'simple' },
        branch: new Map([['main', { remote: 'origin', merge: 'refs/heads/other' }]]),
      };
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
      expect(data.code).toBe('PUSH_UPSTREAM_NAME_MISMATCH');
      expect(data).toMatchObject({ branch: 'refs/heads/main', upstream: 'refs/heads/other' });
    });
  });
});

describe('Given push.default=simple with a central remote and branch.merge set to the same name', () => {
  describe('When planPushRefspecs runs with no explicit refspec', () => {
    it('Then the plan pushes the current branch to the configured upstream ref', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await seedRepo(ctx, {});
      const config: ParsedConfig = {
        push: { default: 'simple' },
        branch: new Map([['main', { remote: 'origin', merge: 'refs/heads/main' }]]),
      };
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
