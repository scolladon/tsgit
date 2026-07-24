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
import { ObjectId, RefName } from '../../../../../src/domain/objects/object-id.js';
import type { Advertisement } from '../../../../../src/domain/protocol/index.js';
import { seedRepo } from '../fixtures.js';

const EMPTY_ADVERTISEMENT: Advertisement = { refs: [], capabilities: [] };
const OID_A = ObjectId.from('a'.repeat(40));
const OID_B = ObjectId.from('b'.repeat(40));

describe('Given push.default=current and an attached branch', () => {
  describe('When planPushRefspecs runs with no explicit refspec', () => {
    it('Then the plan pushes the current branch to the same-named ref', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await seedRepo(ctx, {});
      const config: ParsedConfig = { push: { default: 'current' } };
      const head = await readHeadRaw(ctx);

      // Act
      const result = await planPushRefspecs(config, {}, head);

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

describe('Given a detached HEAD with no explicit refspec', () => {
  describe('When planPushRefspecs runs under a push.default that requires an attached branch', () => {
    it.each([
      {
        pushDefault: 'current' as const,
        head: '1111111111111111111111111111111111111111',
        label: 'push.default=current throws PUSH_DETACHED_NO_REFSPEC',
      },
      {
        pushDefault: 'upstream' as const,
        head: '5555555555555555555555555555555555555555',
        label: 'push.default=upstream throws PUSH_DETACHED_NO_REFSPEC',
      },
      {
        pushDefault: 'simple' as const,
        head: '6666666666666666666666666666666666666666',
        label: 'push.default=simple throws PUSH_DETACHED_NO_REFSPEC',
      },
    ])('Then $label', async ({ pushDefault, head: detachedHead }) => {
      // Arrange
      const ctx = createMemoryContext();
      await seedRepo(ctx, { head: detachedHead });
      const config: ParsedConfig = { push: { default: pushDefault } };
      const head = await readHeadRaw(ctx);

      // Act
      let caught: unknown;
      try {
        await planPushRefspecs(config, {}, head);
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
  describe('When planPushRefspecs runs with no explicit refspec', () => {
    it.each([
      {
        config: {} as ParsedConfig,
        label:
          'an unset push.default (simple is the default mode) throws NO_UPSTREAM_CONFIGURED, not the old unconditional current-branch push',
      },
      {
        config: {
          push: { default: 'upstream' },
          branch: new Map([['main', { remote: 'origin' }]]),
        } as ParsedConfig,
        label: 'push.default=upstream throws NO_UPSTREAM_CONFIGURED',
      },
      {
        config: {
          push: { default: 'simple' },
          branch: new Map([['main', { remote: 'origin' }]]),
        } as ParsedConfig,
        label: 'push.default=simple throws NO_UPSTREAM_CONFIGURED',
      },
    ])('Then $label', async ({ config }) => {
      // Arrange
      const ctx = createMemoryContext();
      await seedRepo(ctx, {});
      const head = await readHeadRaw(ctx);

      // Act
      let caught: unknown;
      try {
        await planPushRefspecs(config, {}, head);
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

describe('Given push.default=matching and an attached branch', () => {
  describe('When planPushRefspecs runs with no explicit refspec', () => {
    it('Then it returns a deferred matching plan, without resolving any refspec yet', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await seedRepo(ctx, {});
      const config: ParsedConfig = { push: { default: 'matching' } };
      const head = await readHeadRaw(ctx);

      // Act
      const result = await planPushRefspecs(config, {}, head);

      // Assert
      expect(result).toEqual({ kind: 'matching' });
    });
  });
});

describe('Given push.default=matching and a detached HEAD', () => {
  describe('When planPushRefspecs runs with no explicit refspec', () => {
    it('Then it still returns a deferred matching plan, proving matching is HEAD-independent', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await seedRepo(ctx, { head: '3333333333333333333333333333333333333333' });
      const config: ParsedConfig = { push: { default: 'matching' } };
      const head = await readHeadRaw(ctx);

      // Act
      const result = await planPushRefspecs(config, {}, head);

      // Assert — no detached refusal, unlike current/upstream/simple/nothing.
      expect(result).toEqual({ kind: 'matching' });
    });
  });
});

describe('Given push.default=nothing', () => {
  describe('When planPushRefspecs runs with no usable explicit refspec', () => {
    it.each([
      {
        head: undefined,
        opts: {},
        label: 'an attached branch with no explicit refspec throws PUSH_DEFAULT_NOTHING',
      },
      {
        head: '4444444444444444444444444444444444444444',
        opts: {},
        label: 'a detached HEAD with no explicit refspec throws PUSH_DEFAULT_NOTHING',
      },
      {
        head: undefined,
        opts: { refspecs: [] },
        label:
          'an empty explicit refspecs array falls through to push.default and throws PUSH_DEFAULT_NOTHING (opts.refspecs.length > 0 is load-bearing)',
      },
    ])('Then $label', async ({ head: detachedHead, opts }) => {
      // Arrange
      const ctx = createMemoryContext();
      await seedRepo(ctx, detachedHead === undefined ? {} : { head: detachedHead });
      const config: ParsedConfig = { push: { default: 'nothing' } };
      const head = await readHeadRaw(ctx);

      // Act
      let caught: unknown;
      try {
        await planPushRefspecs(config, opts, head);
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

describe('Given push.default=upstream with a triangular remote', () => {
  describe('When planPushRefspecs runs with no explicit refspec', () => {
    it.each([
      {
        config: {
          push: { default: 'upstream' },
          remotePushDefault: 'pushdef',
          branch: new Map([['main', { remote: 'origin', merge: 'refs/heads/main' }]]),
        } as ParsedConfig,
        opts: {},
        expectedRemote: 'pushdef',
        label:
          'branch.merge set: throws PUSH_REMOTE_NOT_UPSTREAM even though an upstream is configured',
      },
      {
        config: {
          push: { default: 'upstream' },
          remotePushDefault: 'pushdef',
          branch: new Map([['main', { remote: 'origin' }]]),
        } as ParsedConfig,
        opts: {},
        expectedRemote: 'pushdef',
        label:
          'no branch.merge configured: throws PUSH_REMOTE_NOT_UPSTREAM, not NO_UPSTREAM_CONFIGURED (triangular dominates)',
      },
      {
        config: {
          push: { default: 'upstream' },
          branch: new Map([['main', { remote: 'origin', merge: 'refs/heads/main' }]]),
        } as ParsedConfig,
        opts: { remote: 'other-remote' },
        expectedRemote: 'other-remote',
        label:
          'an explicit opts.remote overriding a central branch.remote is treated as the push remote for the triangular check',
      },
    ])('Then $label', async ({ config, opts, expectedRemote }) => {
      // Arrange
      const ctx = createMemoryContext();
      await seedRepo(ctx, {});
      const head = await readHeadRaw(ctx);

      // Act
      let caught: unknown;
      try {
        await planPushRefspecs(config, opts, head);
      } catch (error) {
        caught = error;
      }

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      const data = (caught as TsgitError).data;
      expect(data.code).toBe('PUSH_REMOTE_NOT_UPSTREAM');
      expect(data).toMatchObject({ remote: expectedRemote, branch: 'refs/heads/main' });
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
      const result = await planPushRefspecs(config, {}, head);

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
      const result = await planPushRefspecs(config, {}, head);

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
        await planPushRefspecs(config, {}, head);
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
      const result = await planPushRefspecs(config, {}, head);

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
      const result = finalizePushRefspecs(plan, EMPTY_ADVERTISEMENT, []);

      // Assert
      expect(result).toBe(plan.refspecs);
    });
  });
});

describe('Given a matching refspec plan', () => {
  const plan: PushRefspecPlan = { kind: 'matching' };
  const MAIN = RefName.from('refs/heads/main');
  const FEATURE = RefName.from('refs/heads/feature');

  describe('When finalizePushRefspecs resolves it against an advertisement with only some local branches present', () => {
    it('Then it pushes only the locally-present branches that the remote also advertises', () => {
      // Arrange
      const adv: Advertisement = {
        capabilities: [],
        refs: [{ name: 'refs/heads/main', id: OID_A }],
      };

      // Act
      const result = finalizePushRefspecs(plan, adv, [MAIN, FEATURE]);

      // Assert
      expect(result).toEqual([
        { force: 'normal', src: 'refs/heads/main', dst: 'refs/heads/main', isDelete: false },
      ]);
    });
  });

  describe('When finalizePushRefspecs resolves it against an advertisement carrying every local branch', () => {
    it('Then it pushes every local branch, one refspec per name', () => {
      // Arrange
      const adv: Advertisement = {
        capabilities: [],
        refs: [
          { name: 'refs/heads/main', id: OID_A },
          { name: 'refs/heads/feature', id: OID_B },
        ],
      };

      // Act
      const result = finalizePushRefspecs(plan, adv, [MAIN, FEATURE]);

      // Assert
      expect(result).toEqual([
        { force: 'normal', src: 'refs/heads/main', dst: 'refs/heads/main', isDelete: false },
        {
          force: 'normal',
          src: 'refs/heads/feature',
          dst: 'refs/heads/feature',
          isDelete: false,
        },
      ]);
    });
  });

  describe('When finalizePushRefspecs resolves it against an advertisement that shares no branch name with any local branch', () => {
    it('Then it returns an empty refspec list, a no-op push', () => {
      // Arrange
      const adv: Advertisement = {
        capabilities: [],
        refs: [{ name: 'refs/heads/unrelated', id: OID_A }],
      };

      // Act
      const result = finalizePushRefspecs(plan, adv, [MAIN, FEATURE]);

      // Assert
      expect(result).toEqual([]);
    });
  });
});
