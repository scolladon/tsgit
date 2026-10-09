import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { resolveRevision } from '../../../../src/application/commands/rev-parse.js';
import { rejectionRecordingContext } from '../../../fixtures/rejection-recording-context.js';
import { seedRepo } from './fixtures.js';

const TREE_OID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

describe('Given a configured repository with HEAD on a loose branch and no packed-refs', () => {
  describe('When resolveRevision(HEAD) walks every dwim candidate', () => {
    it('Then no ref probe is answered by a refusal', async () => {
      // Arrange
      const base = createMemoryContext();
      const { commitIds } = await seedRepo(base, { commits: [{ tree: TREE_OID }] });
      await seedRepo(base, { refs: { 'refs/heads/main': commitIds[0] as string } });
      await base.fs.writeUtf8(`${base.layout.gitDir}/config`, '[core]\n');
      const { ctx, rejections } = rejectionRecordingContext(base);

      // Act
      await resolveRevision(ctx, 'HEAD');

      // Assert
      const result = rejections().filter(({ path }) => String(path).startsWith(ctx.layout.gitDir));
      expect(result).toEqual([]);
    });
  });
});
