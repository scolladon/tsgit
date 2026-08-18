/**
 * Every internal `requireWorkTree(ctx, '<label>')` re-check carries a label
 * that becomes `WORK_TREE_REQUIRED`'s `data.operation` when the primitive is
 * invoked directly on a work-tree-less (bare) `Context`. Command-level entry
 * gates are pinned by each command's own bare-repo test; this file pins the
 * DEFENSIVE re-checks inside primitives and submodule verbs — sites a
 * command-level test never exercises because the command's own earlier gate
 * (same `ctx`) always fires first.
 */
import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { init } from '../../../../src/application/commands/init.js';
import { applySparseCheckout } from '../../../../src/application/commands/internal/apply-sparse-checkout.js';
import {
  materializeFile,
  removeFile,
  renameInWorkingTree,
} from '../../../../src/application/commands/internal/working-tree.js';
import {
  submoduleDeinit,
  submoduleInit,
  submoduleList,
  submoduleSync,
} from '../../../../src/application/commands/submodule.js';
import { compareWorkingTreeDelta } from '../../../../src/application/primitives/compare-working-tree-entry.js';
import { buildAttributeProvider } from '../../../../src/application/primitives/internal/read-gitattributes.js';
import { readGitignore } from '../../../../src/application/primitives/internal/read-gitignore.js';
import { deriveSubmoduleCloneContext } from '../../../../src/application/primitives/internal/submodule-context.js';
import { createLeadingPathScanner } from '../../../../src/application/primitives/internal/symlinked-leading-path.js';
import {
  removeWorkingTreeFile,
  writeWorkingTreeEntry,
  writeWorkingTreeEntryStream,
  writeWorkingTreeFile,
  writeWorkingTreeFileStream,
} from '../../../../src/application/primitives/internal/write-working-tree-file.js';
import { materializeTree } from '../../../../src/application/primitives/materialize-tree.js';
import { createWorkdirEntry } from '../../../../src/application/primitives/snapshot/workdir-entry.js';
import { walkWorkingTree } from '../../../../src/application/primitives/walk-working-tree.js';
import { writeTree } from '../../../../src/application/primitives/write-tree.js';
import { TsgitError } from '../../../../src/domain/error.js';
import type { GitIndex, IndexEntry } from '../../../../src/domain/git-index/index.js';
import { STAGE0_FLAGS } from '../../../../src/domain/git-index/index.js';
import { FILE_MODE } from '../../../../src/domain/objects/file-mode.js';
import type { FilePath, ObjectId } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';
import { asBareContext } from '../commands/fixtures.js';

const EMPTY_INDEX: GitIndex = {
  version: 2,
  entries: [],
  extensions: [],
  trailerSha: new Uint8Array(0),
};

const DUMMY_ID = '0'.repeat(40) as ObjectId;

const DUMMY_ENTRY: IndexEntry = {
  ctimeSeconds: 0,
  ctimeNanoseconds: 0,
  mtimeSeconds: 0,
  mtimeNanoseconds: 0,
  dev: 0,
  ino: 0,
  mode: FILE_MODE.REGULAR,
  uid: 0,
  gid: 0,
  fileSize: 0,
  id: DUMMY_ID,
  flags: STAGE0_FLAGS,
  path: 'a.txt' as FilePath,
};

/** A bare `Context` (no work tree) with a real HEAD, so `assertOperationalRepository` passes. */
const bareCtx = async (): Promise<Context> => {
  const ctx = createMemoryContext();
  await init(ctx);
  return asBareContext(ctx);
};

const emptySource = async function* (): AsyncIterable<Uint8Array> {};

/**
 * A bare `Context` paired with a `LeadingPathScanner` built BEFORE going bare
 * (the scanner closes over the seeded context's real `workDir`). Passing this
 * scanner explicitly to a `write-working-tree-file` primitive skips
 * `resolveScanner`'s own `createLeadingPathScanner(ctx)` call — which would
 * otherwise throw its OWN `WORK_TREE_REQUIRED` (labelled
 * 'createLeadingPathScanner') before the primitive's own re-check is ever
 * reached — so the primitive's `unlinkSymlinkedLeadingComponent` probe
 * resolves successfully and the primitive's own gate fires next.
 */
const bareCtxWithScanner = async (): Promise<{
  readonly ctx: Context;
  readonly scanner: ReturnType<typeof createLeadingPathScanner>;
}> => {
  const seeded = createMemoryContext();
  await init(seeded);
  const scanner = createLeadingPathScanner(seeded);
  return { ctx: asBareContext(seeded), scanner };
};

/** Runs `thunk`, capturing any rejection so it can be asserted by the caller. */
const catchOperation = async (thunk: () => Promise<unknown>): Promise<unknown> => {
  let caught: unknown;
  try {
    await thunk();
  } catch (err) {
    caught = err;
  }
  return caught;
};

const assertWorkTreeRequired = (caught: unknown, operation: string): void => {
  expect(caught).toBeInstanceOf(TsgitError);
  expect((caught as TsgitError).data).toMatchObject({
    code: 'WORK_TREE_REQUIRED',
    operation,
  });
};

describe('Work-tree-gate labels (defensive re-checks unreachable through a command wrapper)', () => {
  describe('Given a bare context', () => {
    describe('When applySparseCheckout runs', () => {
      it("Then throws WORK_TREE_REQUIRED tagged 'sparse-checkout'", async () => {
        // Arrange
        const ctx = await bareCtx();

        // Act
        const caught = await catchOperation(() => applySparseCheckout(ctx, { matcher: undefined }));

        // Assert
        assertWorkTreeRequired(caught, 'sparse-checkout');
      });
    });

    describe('When materializeFile runs', () => {
      it("Then throws WORK_TREE_REQUIRED tagged 'workingTree'", async () => {
        // Arrange
        const ctx = await bareCtx();

        // Act
        const caught = await catchOperation(() =>
          materializeFile(ctx, 'a.txt', new Uint8Array(), FILE_MODE.REGULAR),
        );

        // Assert
        assertWorkTreeRequired(caught, 'workingTree');
      });
    });

    describe('When removeFile runs', () => {
      it("Then throws WORK_TREE_REQUIRED tagged 'workingTree'", async () => {
        // Arrange
        const ctx = await bareCtx();

        // Act
        const caught = await catchOperation(() => removeFile(ctx, 'a.txt'));

        // Assert
        assertWorkTreeRequired(caught, 'workingTree');
      });
    });

    describe('When renameInWorkingTree runs', () => {
      it("Then throws WORK_TREE_REQUIRED tagged 'workingTree'", async () => {
        // Arrange
        const ctx = await bareCtx();

        // Act
        const caught = await catchOperation(() => renameInWorkingTree(ctx, 'a.txt', 'b.txt'));

        // Assert
        assertWorkTreeRequired(caught, 'workingTree');
      });
    });

    describe('When submoduleInit runs', () => {
      it("Then throws WORK_TREE_REQUIRED tagged 'submodule init'", async () => {
        // Arrange
        const ctx = await bareCtx();

        // Act
        const caught = await catchOperation(() => submoduleInit(ctx, {}));

        // Assert
        assertWorkTreeRequired(caught, 'submodule init');
      });
    });

    describe('When submoduleSync runs', () => {
      it("Then throws WORK_TREE_REQUIRED tagged 'submodule sync'", async () => {
        // Arrange
        const ctx = await bareCtx();

        // Act
        const caught = await catchOperation(() => submoduleSync(ctx, {}));

        // Assert
        assertWorkTreeRequired(caught, 'submodule sync');
      });
    });

    describe('When submoduleDeinit runs', () => {
      it("Then throws WORK_TREE_REQUIRED tagged 'submodule deinit'", async () => {
        // Arrange
        const ctx = await bareCtx();

        // Act
        const caught = await catchOperation(() => submoduleDeinit(ctx, {}));

        // Assert
        assertWorkTreeRequired(caught, 'submodule deinit');
      });
    });

    describe('When submoduleList runs', () => {
      it("Then throws WORK_TREE_REQUIRED tagged 'submodule status'", async () => {
        // Arrange
        const ctx = await bareCtx();

        // Act
        const caught = await catchOperation(() => submoduleList(ctx, {}));

        // Assert
        assertWorkTreeRequired(caught, 'submodule status');
      });
    });

    describe('When compareWorkingTreeDelta runs', () => {
      it("Then throws WORK_TREE_REQUIRED tagged 'compareWorkingTreeEntry'", async () => {
        // Arrange
        const ctx = await bareCtx();

        // Act
        const caught = await catchOperation(() => compareWorkingTreeDelta(ctx, DUMMY_ENTRY));

        // Assert
        assertWorkTreeRequired(caught, 'compareWorkingTreeEntry');
      });
    });

    describe('When buildAttributeProvider runs', () => {
      it("Then throws WORK_TREE_REQUIRED tagged 'buildAttributeProvider'", async () => {
        // Arrange
        const ctx = await bareCtx();

        // Act
        const caught = await catchOperation(() => buildAttributeProvider(ctx));

        // Assert
        assertWorkTreeRequired(caught, 'buildAttributeProvider');
      });
    });

    describe('When readGitignore runs', () => {
      it("Then throws WORK_TREE_REQUIRED tagged 'readGitignore'", async () => {
        // Arrange
        const ctx = await bareCtx();

        // Act
        const caught = await catchOperation(() => readGitignore(ctx, ''));

        // Assert
        assertWorkTreeRequired(caught, 'readGitignore');
      });
    });

    describe('When deriveSubmoduleCloneContext runs', () => {
      it("Then throws WORK_TREE_REQUIRED tagged 'deriveSubmoduleContext'", async () => {
        // Arrange
        const ctx = await bareCtx();

        // Act
        const caught = await catchOperation(async () =>
          deriveSubmoduleCloneContext(ctx, 'sub', 'libs/sub' as FilePath),
        );

        // Assert
        assertWorkTreeRequired(caught, 'deriveSubmoduleContext');
      });
    });

    describe('When writeWorkingTreeFile runs with a pre-built leading-path scanner', () => {
      it("Then throws WORK_TREE_REQUIRED tagged 'writeWorkingTreeFile'", async () => {
        // Arrange
        const { ctx, scanner } = await bareCtxWithScanner();

        // Act
        const caught = await catchOperation(() =>
          writeWorkingTreeFile(ctx, 'a.txt' as FilePath, new Uint8Array(), scanner),
        );

        // Assert
        assertWorkTreeRequired(caught, 'writeWorkingTreeFile');
      });
    });

    describe('When writeWorkingTreeEntry runs with a pre-built leading-path scanner', () => {
      it("Then throws WORK_TREE_REQUIRED tagged 'writeWorkingTreeFile'", async () => {
        // Arrange
        const { ctx, scanner } = await bareCtxWithScanner();

        // Act
        const caught = await catchOperation(() =>
          writeWorkingTreeEntry(
            ctx,
            'a.txt' as FilePath,
            new Uint8Array(),
            FILE_MODE.REGULAR,
            scanner,
          ),
        );

        // Assert
        assertWorkTreeRequired(caught, 'writeWorkingTreeFile');
      });
    });

    describe('When writeWorkingTreeFileStream runs with a pre-built leading-path scanner', () => {
      it("Then throws WORK_TREE_REQUIRED tagged 'writeWorkingTreeFile'", async () => {
        // Arrange
        const { ctx, scanner } = await bareCtxWithScanner();

        // Act
        const caught = await catchOperation(() =>
          writeWorkingTreeFileStream(ctx, 'a.txt' as FilePath, emptySource(), scanner),
        );

        // Assert
        assertWorkTreeRequired(caught, 'writeWorkingTreeFile');
      });
    });

    describe('When writeWorkingTreeEntryStream runs with a pre-built leading-path scanner', () => {
      it("Then throws WORK_TREE_REQUIRED tagged 'writeWorkingTreeFile'", async () => {
        // Arrange
        const { ctx, scanner } = await bareCtxWithScanner();

        // Act
        const caught = await catchOperation(() =>
          writeWorkingTreeEntryStream(
            ctx,
            'a.txt' as FilePath,
            emptySource(),
            FILE_MODE.REGULAR,
            scanner,
          ),
        );

        // Assert
        assertWorkTreeRequired(caught, 'writeWorkingTreeFile');
      });
    });

    describe('When removeWorkingTreeFile runs', () => {
      it("Then throws WORK_TREE_REQUIRED tagged 'writeWorkingTreeFile'", async () => {
        // Arrange
        const ctx = await bareCtx();

        // Act
        const caught = await catchOperation(() => removeWorkingTreeFile(ctx, 'a.txt' as FilePath));

        // Assert
        assertWorkTreeRequired(caught, 'writeWorkingTreeFile');
      });
    });

    describe('When materializeTree runs', () => {
      it("Then throws WORK_TREE_REQUIRED tagged 'materializeTree'", async () => {
        // Arrange
        const seeded = createMemoryContext();
        await init(seeded);
        const emptyTree = await writeTree(seeded, []);
        const ctx = asBareContext(seeded);

        // Act
        const caught = await catchOperation(() =>
          materializeTree(ctx, { targetTree: emptyTree, currentIndex: EMPTY_INDEX }),
        );

        // Assert
        assertWorkTreeRequired(caught, 'materializeTree');
      });
    });

    describe('When createWorkdirEntry runs', () => {
      it("Then throws WORK_TREE_REQUIRED tagged 'createWorkdirEntry'", async () => {
        // Arrange
        const ctx = await bareCtx();

        // Act
        const caught = await catchOperation(async () =>
          createWorkdirEntry(ctx, {
            source: 'workdir',
            path: 'a.txt' as FilePath,
            mode: FILE_MODE.REGULAR,
            kind: 'file',
            stat: { mode: FILE_MODE.REGULAR, size: 0, mtimeMs: 0 },
          }),
        );

        // Assert
        assertWorkTreeRequired(caught, 'createWorkdirEntry');
      });
    });

    describe('When walkWorkingTree runs', () => {
      it("Then throws WORK_TREE_REQUIRED tagged 'walkWorkingTree'", async () => {
        // Arrange
        const ctx = await bareCtx();

        // Act
        const caught = await catchOperation(async () => {
          for await (const _entry of walkWorkingTree(ctx)) break;
        });

        // Assert
        assertWorkTreeRequired(caught, 'walkWorkingTree');
      });
    });
  });
});
