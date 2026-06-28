/**
 * Bundle scenario — seeds a single root commit containing one regular file,
 * creates a full-history bundle via `repo.bundle.create`, writes the bytes
 * to the adapter's filesystem, then calls `repo.bundle.verify` and
 * `repo.bundle.listHeads` on that path. Projects to counts and booleans so
 * oids never appear in the assertion. Runs identically on Node, memory, and
 * browser (OPFS) adapters.
 *
 * Surfaces closed:
 *   commands: bundle (create / verify / listHeads)
 */
import { AUTHOR, FILES, MESSAGES } from '../fixtures.ts';
import type { Scenario } from './types.ts';

interface BundleScenarioResult {
  readonly refCount: number;
  readonly prerequisitesPresent: boolean;
  readonly recordsCompleteHistory: boolean;
  readonly headCount: number;
}

export const bundleScenario: Scenario<BundleScenarioResult> = {
  name: 'bundle',
  // verify's full per-entry pack walk feeds DecompressionStream truncated deflate
  // prefixes by design (progressive-prefix scan). workerd rejects incomplete
  // streams with an uncatchable internal exception ("Called close() on a
  // decompression stream with incomplete data"), crashing the worker. Vendoring
  // a pure-JS inflate was declined. The scenario runs on Node/Deno/Bun/browsers
  // where DecompressionStream is lenient about early close.
  unsupportedRuntimes: ['workers'],
  inputs: { files: [FILES.helloA], author: AUTHOR, message: MESSAGES.seed },
  expected: {
    // --all on a fresh single-commit repo: HEAD + refs/heads/main
    refCount: 2,
    // Full-history bundle — no prerequisites to be missing.
    prerequisitesPresent: true,
    // No prerequisite lines means the bundle records complete history.
    recordsCompleteHistory: true,
    // list-heads returns the same ref set as the header.
    headCount: 2,
  },
  run: async (repo, inputs) => {
    // Arrange — seed a healthy root commit
    await repo.init();
    await repo.add(inputs.files.map((file) => file.path));
    await repo.commit({ message: inputs.message, author: inputs.author });

    const bundlePath = `${repo.ctx.layout.workDir}/bundle.bundle`;

    // Act — create, persist, then read
    const createResult = await repo.bundle.create({ all: true });
    await repo.ctx.fs.write(bundlePath, createResult.bytes);

    const verifyResult = await repo.bundle.verify({ path: bundlePath });
    const listHeadsResult = await repo.bundle.listHeads({ path: bundlePath });

    // Assert — project to counts and booleans only (no oids)
    return {
      refCount: createResult.refs.length,
      prerequisitesPresent: verifyResult.prerequisitesPresent,
      recordsCompleteHistory: verifyResult.recordsCompleteHistory,
      headCount: listHeadsResult.refs.length,
    };
  },
};
