/**
 * Tier-1 `rev-list` command — the reachability core of git's `git rev-list`:
 * enumerate the objects reachable from `wants` and not reachable from `not`.
 * Delegates to the shared closure engine's walk tier — the engine's only
 * tier so far; a bitmap tier and its `useBitmapIndex` control arrive later.
 * Structured output only: no `--pretty`/`--format`/`--date`/`--abbrev`/
 * `--header`/`-z`/`--object-names` — every one of those is presentation.
 *
 * Ordering is deterministic for a given call but is not git's own order —
 * every equality check against the result compares it as a set.
 */
import type { FilePath, ObjectId } from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import { computeClosure } from '../primitives/internal/closure-engine.js';
import { assertOperationalRepository } from './internal/repo-state.js';
import { revParse } from './rev-parse.js';

export interface RevListOptions {
  /** Revisions to walk from. Defaults to `['HEAD']`. */
  readonly wants?: ReadonlyArray<string>;
  /** Revisions whose reachability is excluded (git's `--not` / `^rev`). */
  readonly not?: ReadonlyArray<string>;
  /** Include trees and blobs, not just commits and tags. */
  readonly objects?: boolean;
  /**
   * Documents intent only: `entries` is always populated and `count` is
   * always `entries.length` on the same call — there is no separate
   * count-only fast path, since the walk already computes the whole set to
   * count it.
   */
  readonly count?: boolean;
}

export interface RevListEntry {
  readonly id: ObjectId;
  readonly type: 'commit' | 'tree' | 'blob' | 'tag';
  /** Present on trees/blobs under `objects`. */
  readonly path?: FilePath;
}

export interface RevListResult {
  readonly entries: ReadonlyArray<RevListEntry>;
  /** `entries.length`. With `objects` it counts objects; without it, commits and tags. */
  readonly count: number;
}

const DEFAULT_WANTS: ReadonlyArray<string> = ['HEAD'];

export const revList = async (ctx: Context, opts: RevListOptions = {}): Promise<RevListResult> => {
  await assertOperationalRepository(ctx);
  const wants = await Promise.all((opts.wants ?? DEFAULT_WANTS).map((rev) => revParse(ctx, rev)));
  const not = await Promise.all((opts.not ?? []).map((rev) => revParse(ctx, rev)));
  const closure = await computeClosure(ctx, { wants, not, objects: opts.objects ?? false });
  const entries: RevListEntry[] = closure.objects.map((object) =>
    object.path === undefined
      ? { id: object.id, type: object.type }
      : { id: object.id, type: object.type, path: object.path },
  );
  return { entries, count: entries.length };
};
