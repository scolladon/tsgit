/**
 * The local refs a push matches its sources against: every ref under `refs/`,
 * and each symref — `HEAD` included — onto the ref it finally resolves to.
 */
import type { RefName } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import { getRefStore } from '../../primitives/ref-store.js';
import type { LocalPushRefs } from './push-explicit-match.js';
import { readHeadRaw } from './repo-state.js';

const REFS_PREFIX = 'refs/' as RefName;
const HEAD = 'HEAD';
/** git's `SYMREF_MAXDEPTH`: a chain, or a loop, is followed no further. */
const SYMREF_MAX_DEPTH = 5;

const finalTarget = (target: string, targets: ReadonlyMap<string, string>): string => {
  let at = target;
  for (let depth = 1; depth < SYMREF_MAX_DEPTH; depth += 1) {
    const next = targets.get(at);
    if (next === undefined) return at;
    at = next;
  }
  return at;
};

export const readLocalPushRefs = async (ctx: Context): Promise<LocalPushRefs> => {
  const entries = await getRefStore(ctx).listRefs(REFS_PREFIX);
  const targets = new Map<string, string>();
  for (const { name, value } of entries)
    if (value.kind === 'symbolic') targets.set(name, value.target);
  const head = await readHeadRaw(ctx);
  if (head.kind === 'symbolic') targets.set(HEAD, head.target);
  const symrefs = new Map<string, string>();
  for (const [name, target] of targets) symrefs.set(name, finalTarget(target, targets));
  return { names: entries.map((entry) => entry.name), symrefs };
};
