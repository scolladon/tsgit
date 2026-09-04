/**
 * Scaled bench: `readBlob` against a deep-delta-chain pack (evolving
 * single-file fixture, chain depth ≈ 43).
 *
 * Cold reads a fresh repository per call, paying the full chain replay;
 * warm reuses one repository so the LRU delta-base cache hits. The deepest
 * object is the worst case for chain replay — a shallower object would not
 * exercise the memory-pressure path this scenario exists to measure. The
 * shared-ancestor scenario below is the one that exercises the offset-keyed
 * delta-base cache: it reads several tips known (via `verify-pack -v`'s
 * base-sha column) to sit on the SAME linear ancestor path, in one registry
 * generation, so later reads hit levels an earlier read already cached — the
 * isolated cold row above never revisits an offset within its own single
 * walk, so it cannot show that reuse and instead just carries the cache's
 * bookkeeping cost.
 */
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';

import * as git from 'isomorphic-git';
import type { ObjectId } from '../../src/domain/objects/index.js';
import { openRepository } from '../../src/index.node.js';
import { DELTA_CHAIN_FIXTURE } from './support/fixture-generator.js';
import { resolveScaledContext, scaledScenario } from './support/scaled-bench.js';

const execFileAsync = promisify(execFile);

const ctx = await resolveScaledContext(DELTA_CHAIN_FIXTURE);

scaledScenario(
  ctx,
  'When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git',
  (fixture) => {
    const deepId = fixture.firstBlobId as ObjectId;
    const sut = async (): Promise<void> => {
      const repo = await openRepository({ cwd: fixture.cwd });
      try {
        await repo.primitives.readBlob(deepId);
      } finally {
        await repo.dispose();
      }
    };
    return {
      sut,
      baseline: async (): Promise<void> => {
        await git.readBlob({ fs, dir: fixture.cwd, oid: fixture.firstBlobId });
      },
    };
  },
);

scaledScenario(
  ctx,
  'When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git',
  async (fixture) => {
    const repo = await openRepository({ cwd: fixture.cwd });
    const deepId = fixture.firstBlobId as ObjectId;
    await repo.primitives.readBlob(deepId);

    const sut = async (): Promise<void> => {
      await repo.primitives.readBlob(deepId);
    };
    return {
      teardown: () => repo.dispose(),
      sut,
      baseline: async (): Promise<void> => {
        await git.readBlob({ fs, dir: fixture.cwd, oid: fixture.firstBlobId });
      },
    };
  },
);

// Child env with GIT_* stripped — GIT_DIR/GIT_WORK_TREE from a hook would override
// `-C <cwd>` and redirect rev-parse/verify-pack to the wrong repo.
const gitEnv = (): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));

const resolvePackIndexPath = async (cwd: string): Promise<string> => {
  const { stdout } = await execFileAsync(
    'git',
    ['-C', cwd, 'rev-parse', '--git-path', 'objects/pack'],
    { env: gitEnv() },
  );
  const packDir = stdout.trim();
  const absolutePackDir = path.isAbsolute(packDir) ? packDir : path.join(cwd, packDir);
  const idxName = fs.readdirSync(absolutePackDir).find((name) => name.endsWith('.idx'));
  if (idxName === undefined) {
    throw new Error(`no pack .idx found under ${absolutePackDir}`);
  }
  return path.join(absolutePackDir, idxName);
};

/**
 * Walks `verify-pack -v`'s per-blob base-sha column from the deepest chain
 * object back to its root base, returning the full linear ancestor path
 * (deepest first). Every object on this path is a REAL OFS/REF base of the
 * one before it — the only way to guarantee a set of tips actually share a
 * cached offset, rather than hoping git's delta-window heuristic happened to
 * pick adjacent commits as delta partners.
 */
const resolveAncestorChain = async (cwd: string, deepestOid: string): Promise<string[]> => {
  const idxPath = await resolvePackIndexPath(cwd);
  const { stdout } = await execFileAsync('git', ['-C', cwd, 'verify-pack', '-v', idxPath], {
    env: gitEnv(),
  });
  const baseOf = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    const tokens = line.trim().split(/\s+/);
    if (tokens[1] !== 'blob' || tokens.length < 7) continue;
    const [sha, , , , , , baseSha] = tokens;
    if (sha !== undefined && baseSha !== undefined) baseOf.set(sha, baseSha);
  }
  const chain: string[] = [deepestOid];
  let current = deepestOid;
  for (;;) {
    const base = baseOf.get(current);
    if (base === undefined) break;
    chain.push(base);
    current = base;
  }
  return chain;
};

// Eight indices spread evenly across the resolved ancestor path (deepest
// first) — the shared-ancestor scenario's read set.
const SHARED_ANCESTOR_TIP_COUNT = 8;
const pickEvenlySpaced = (chain: readonly string[], count: number): string[] => {
  if (chain.length <= count) return [...chain];
  const step = (chain.length - 1) / (count - 1);
  return Array.from({ length: count }, (_unused, i) => chain[Math.round(i * step)]!);
};

scaledScenario(
  ctx,
  'When readBlob() reads 8 tips sharing deep OFS ancestor levels in one registry generation, Then measure tsgit',
  async (fixture) => {
    const chain = await resolveAncestorChain(fixture.cwd, fixture.firstBlobId);
    const tips = pickEvenlySpaced(chain, SHARED_ANCESTOR_TIP_COUNT) as ObjectId[];
    const sut = async (): Promise<void> => {
      const repo = await openRepository({ cwd: fixture.cwd });
      try {
        for (const id of tips) {
          await repo.primitives.readBlob(id);
        }
      } finally {
        await repo.dispose();
      }
    };
    return { sut };
  },
);
