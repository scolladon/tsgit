import { describe, expect, it } from 'vitest';
import { resolveRef } from '../../../../src/application/primitives/resolve-ref.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import type { TsgitError } from '../../../../src/domain/error.js';
import type { ObjectId, RefName, Tag, Tree } from '../../../../src/domain/objects/index.js';
import { buildSeededContext } from './fixtures.js';

const MAIN_ID = 'a'.repeat(40) as ObjectId;
const OTHER_ID = 'b'.repeat(40) as ObjectId;

describe('resolveRef', () => {
  it('Given a loose ref, When resolveRef is called, Then returns the id', async () => {
    const ctx = await buildSeededContext({
      refs: [{ name: 'refs/heads/main' as RefName, id: MAIN_ID }],
    });
    const sut = await resolveRef(ctx, 'refs/heads/main' as RefName);
    expect(sut).toBe(MAIN_ID);
  });

  it('Given a packed-only ref, When resolveRef is called, Then returns the id', async () => {
    const ctx = await buildSeededContext({
      packedRefs: [{ name: 'refs/tags/v1' as RefName, id: MAIN_ID }],
    });
    const sut = await resolveRef(ctx, 'refs/tags/v1' as RefName);
    expect(sut).toBe(MAIN_ID);
  });

  it('Given loose shadowing packed, When resolveRef is called, Then loose wins', async () => {
    const ctx = await buildSeededContext({
      refs: [{ name: 'refs/heads/main' as RefName, id: MAIN_ID }],
      packedRefs: [{ name: 'refs/heads/main' as RefName, id: OTHER_ID }],
    });
    const sut = await resolveRef(ctx, 'refs/heads/main' as RefName);
    expect(sut).toBe(MAIN_ID);
  });

  it('Given a symbolic chain HEAD→refs/heads/main, When resolveRef HEAD, Then returns main.id', async () => {
    const ctx = await buildSeededContext({
      refs: [{ name: 'refs/heads/main' as RefName, id: MAIN_ID }],
    });
    await ctx.fs.writeUtf8('/repo/.git/HEAD', 'ref: refs/heads/main\n');
    const sut = await resolveRef(ctx, 'HEAD');
    expect(sut).toBe(MAIN_ID);
  });

  it('Given a symbolic ref cycle, When resolveRef is called, Then throws REF_CYCLE_DETECTED', async () => {
    const ctx = await buildSeededContext();
    await ctx.fs.writeUtf8('/repo/.git/HEAD', 'ref: refs/heads/loop\n');
    await ctx.fs.writeUtf8('/repo/.git/refs/heads/loop', 'ref: HEAD\n');
    try {
      await resolveRef(ctx, 'HEAD');
      expect.unreachable();
    } catch (error) {
      expect((error as TsgitError).data.code).toBe('REF_CYCLE_DETECTED');
    }
  });

  it('Given a missing ref, When resolveRef is called, Then throws REF_NOT_FOUND', async () => {
    const ctx = await buildSeededContext();
    try {
      await resolveRef(ctx, 'refs/heads/nope' as RefName);
      expect.unreachable();
    } catch (error) {
      expect((error as TsgitError).data.code).toBe('REF_NOT_FOUND');
    }
  });

  it('Given symbolic depth 4 with maxSymbolicDepth 5, When resolveRef is called, Then succeeds (just-under)', async () => {
    const ctx = await buildSeededContext({
      refs: [{ name: 'refs/heads/final' as RefName, id: MAIN_ID }],
    });
    await ctx.fs.writeUtf8('/repo/.git/refs/heads/a', 'ref: refs/heads/b\n');
    await ctx.fs.writeUtf8('/repo/.git/refs/heads/b', 'ref: refs/heads/c\n');
    await ctx.fs.writeUtf8('/repo/.git/refs/heads/c', 'ref: refs/heads/d\n');
    await ctx.fs.writeUtf8('/repo/.git/refs/heads/d', 'ref: refs/heads/final\n');
    const sut = await resolveRef(ctx, 'refs/heads/a' as RefName, { maxSymbolicDepth: 5 });
    expect(sut).toBe(MAIN_ID);
  });

  it('Given symbolic depth exactly 5 with maxSymbolicDepth 5 (at cap), When resolveRef is called, Then succeeds', async () => {
    const ctx = await buildSeededContext({
      refs: [{ name: 'refs/heads/final' as RefName, id: MAIN_ID }],
    });
    await ctx.fs.writeUtf8('/repo/.git/refs/heads/a', 'ref: refs/heads/b\n');
    await ctx.fs.writeUtf8('/repo/.git/refs/heads/b', 'ref: refs/heads/c\n');
    await ctx.fs.writeUtf8('/repo/.git/refs/heads/c', 'ref: refs/heads/d\n');
    await ctx.fs.writeUtf8('/repo/.git/refs/heads/d', 'ref: refs/heads/e\n');
    await ctx.fs.writeUtf8('/repo/.git/refs/heads/e', 'ref: refs/heads/final\n');
    const sut = await resolveRef(ctx, 'refs/heads/a' as RefName, { maxSymbolicDepth: 5 });
    expect(sut).toBe(MAIN_ID);
  });

  it('Given symbolic depth 6 with maxSymbolicDepth 5, When resolveRef is called, Then throws REF_CHAIN_TOO_DEEP', async () => {
    const ctx = await buildSeededContext({
      refs: [{ name: 'refs/heads/final' as RefName, id: MAIN_ID }],
    });
    await ctx.fs.writeUtf8('/repo/.git/refs/heads/s1', 'ref: refs/heads/s2\n');
    await ctx.fs.writeUtf8('/repo/.git/refs/heads/s2', 'ref: refs/heads/s3\n');
    await ctx.fs.writeUtf8('/repo/.git/refs/heads/s3', 'ref: refs/heads/s4\n');
    await ctx.fs.writeUtf8('/repo/.git/refs/heads/s4', 'ref: refs/heads/s5\n');
    await ctx.fs.writeUtf8('/repo/.git/refs/heads/s5', 'ref: refs/heads/s6\n');
    await ctx.fs.writeUtf8('/repo/.git/refs/heads/s6', 'ref: refs/heads/final\n');
    try {
      await resolveRef(ctx, 'refs/heads/s1' as RefName, { maxSymbolicDepth: 5 });
      expect.unreachable();
    } catch (error) {
      expect((error as TsgitError).data.code).toBe('REF_CHAIN_TOO_DEEP');
    }
  });

  it('Given an annotated tag pointing to a commit and peel=true, When resolveRef is called, Then returns the peeled object id', async () => {
    const ctx = await buildSeededContext();
    const tree: Tree = { type: 'tree', entries: [], id: '' as ObjectId };
    const treeId = await writeObject(ctx, tree);
    const tag: Tag = {
      type: 'tag',
      id: '' as ObjectId,
      data: {
        object: treeId,
        objectType: 'tree',
        tagName: 'v1',
        tagger: { name: 'a', email: 'a@a', timestamp: 0, timezoneOffset: '+0000' },
        message: 'v1',
        extraHeaders: [],
      },
    };
    const tagId = await writeObject(ctx, tag);
    await ctx.fs.writeUtf8('/repo/.git/refs/tags/v1', `${tagId}\n`);
    const sut = await resolveRef(ctx, 'refs/tags/v1' as RefName, { peel: true });
    expect(sut).toBe(treeId);
  });

  it('Given an invalid ref name, When resolveRef is called, Then throws INVALID_REF', async () => {
    const ctx = await buildSeededContext();
    try {
      await resolveRef(ctx, '..' as RefName);
      expect.unreachable();
    } catch (error) {
      expect((error as TsgitError).data.code).toBe('INVALID_REF');
    }
  });

  it('Given a symbolic ref whose target is an absolute path, When resolveRef is called, Then throws INVALID_REF (validateRefName + containment defense in depth)', async () => {
    const ctx = await buildSeededContext();
    await ctx.fs.writeUtf8('/repo/.git/HEAD', 'ref: /etc/passwd\n');
    try {
      await resolveRef(ctx, 'HEAD');
      expect.unreachable();
    } catch (error) {
      expect((error as TsgitError).data.code).toBe('INVALID_REF');
    }
  });

  it('Given HEAD as the direct input, When resolveRef is called, Then bypasses validateRefName (HEAD is never rejected as invalid)', async () => {
    // Kills ConditionalExpression `false` on the `current !== 'HEAD'` guard:
    // under `false`, validateRefName would be called on 'HEAD' and throw.
    const ctx = await buildSeededContext({
      refs: [{ name: 'refs/heads/main' as RefName, id: MAIN_ID }],
    });
    await ctx.fs.writeUtf8('/repo/.git/HEAD', 'ref: refs/heads/main\n');
    const sut = await resolveRef(ctx, 'HEAD');
    expect(sut).toBe(MAIN_ID);
  });

  it('Given a symbolic ref cycle of length 2, When resolveRef is called, Then thrown chain contains both refs (kills ArrayDeclaration [] mutant)', async () => {
    // Kills the `[...chain, current]` ArrayDeclaration `[]` mutant: empties the
    // chain, producing an empty cycle array.
    const ctx = await buildSeededContext();
    await ctx.fs.writeUtf8('/repo/.git/refs/heads/loop-a', 'ref: refs/heads/loop-b\n');
    await ctx.fs.writeUtf8('/repo/.git/refs/heads/loop-b', 'ref: refs/heads/loop-a\n');
    try {
      await resolveRef(ctx, 'refs/heads/loop-a' as RefName);
      expect.unreachable();
    } catch (error) {
      const data = (error as TsgitError).data;
      expect(data.code).toBe('REF_CYCLE_DETECTED');
      if (data.code === 'REF_CYCLE_DETECTED') {
        expect(data.chain.length).toBeGreaterThan(1);
        expect(data.chain).toContain('refs/heads/loop-a');
      }
    }
  });

  it('Given a tag chain at peel depth 5 (at cap), When resolveRef peel=true, Then returns the final object', async () => {
    // Kills the peel-depth `depth -= 1` AssignmentOperator and the exceeds guard.
    const ctx = await buildSeededContext();
    const tree: Tree = { type: 'tree', entries: [], id: '' as ObjectId };
    const treeId = await writeObject(ctx, tree);
    let currentId: ObjectId = treeId;
    let currentType: 'tree' | 'tag' = 'tree';
    for (let i = 0; i < 5; i += 1) {
      const tag: Tag = {
        type: 'tag',
        id: '' as ObjectId,
        data: {
          object: currentId,
          objectType: currentType,
          tagName: `v${i}`,
          tagger: { name: 'a', email: 'a@a', timestamp: 0, timezoneOffset: '+0000' },
          message: `v${i}`,
          extraHeaders: [],
        },
      };
      currentId = await writeObject(ctx, tag);
      currentType = 'tag';
    }
    await ctx.fs.writeUtf8('/repo/.git/refs/tags/deep', `${currentId}\n`);
    const sut = await resolveRef(ctx, 'refs/tags/deep' as RefName, {
      peel: true,
      maxPeelDepth: 5,
    });
    expect(sut).toBe(treeId);
  });

  it('Given a tag chain at peel depth 6 with maxPeelDepth=5, When resolveRef peel=true, Then throws REF_CHAIN_TOO_DEEP', async () => {
    // Kills the peel-depth guard `exceedsMaxPeelDepth` ConditionalExpression `false`.
    const ctx = await buildSeededContext();
    const tree: Tree = { type: 'tree', entries: [], id: '' as ObjectId };
    const treeId = await writeObject(ctx, tree);
    let currentId: ObjectId = treeId;
    let currentType: 'tree' | 'tag' = 'tree';
    for (let i = 0; i < 6; i += 1) {
      const tag: Tag = {
        type: 'tag',
        id: '' as ObjectId,
        data: {
          object: currentId,
          objectType: currentType,
          tagName: `p${i}`,
          tagger: { name: 'a', email: 'a@a', timestamp: 0, timezoneOffset: '+0000' },
          message: `p${i}`,
          extraHeaders: [],
        },
      };
      currentId = await writeObject(ctx, tag);
      currentType = 'tag';
    }
    await ctx.fs.writeUtf8('/repo/.git/refs/tags/too-deep', `${currentId}\n`);
    try {
      await resolveRef(ctx, 'refs/tags/too-deep' as RefName, {
        peel: true,
        maxPeelDepth: 5,
      });
      expect.unreachable();
    } catch (error) {
      expect((error as TsgitError).data.code).toBe('REF_CHAIN_TOO_DEEP');
    }
  });

  it('Given a symbolic ref whose target contains `..`, When resolveRef is called, Then throws INVALID_REF via containment check', async () => {
    // Kills the assertContainment BlockStatement `{}` and isContainedRefSegment
    // ConditionalExpression `false` mutants.
    const ctx = await buildSeededContext();
    await ctx.fs.writeUtf8('/repo/.git/HEAD', 'ref: refs/../escape\n');
    try {
      await resolveRef(ctx, 'HEAD');
      expect.unreachable();
    } catch (error) {
      expect((error as TsgitError).data.code).toBe('INVALID_REF');
    }
  });
});
