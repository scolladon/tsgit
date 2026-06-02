/**
 * Compose the byte-faithful `git show <obj…>` stream from per-object render
 * nodes, reproducing git's `shown_one` separator semantics: a blank line
 * precedes each commit / tree / tag entry once anything has been shown (never
 * the first, never after the last); blobs neither emit nor consume the
 * separator; the tag → target blank line is the same separator (the target
 * inherits the flag). Commits de-duplicate by oid across the whole walk.
 */
import { encode } from '../objects/encoding.js';
import type { ObjectId } from '../objects/index.js';

export type ShowStreamNode =
  | { readonly kind: 'commit'; readonly id: ObjectId; readonly text: string }
  | { readonly kind: 'tree'; readonly text: string }
  | { readonly kind: 'blob'; readonly content: Uint8Array }
  | { readonly kind: 'tag'; readonly text: string; readonly target: ShowStreamNode };

const SEPARATOR = encode('\n');

interface StreamState {
  shownOne: boolean;
}

export function renderShowStream(nodes: ReadonlyArray<ShowStreamNode>): Uint8Array {
  const chunks: Uint8Array[] = [];
  const shownCommits = new Set<ObjectId>();
  const state: StreamState = { shownOne: false };
  for (const node of nodes) {
    emit(node, chunks, shownCommits, state);
  }
  return concat(chunks);
}

function emit(
  node: ShowStreamNode,
  chunks: Uint8Array[],
  shownCommits: Set<ObjectId>,
  state: StreamState,
): void {
  if (node.kind === 'blob') {
    chunks.push(node.content);
    return;
  }
  if (node.kind === 'commit') {
    if (shownCommits.has(node.id)) return;
    shownCommits.add(node.id);
  }
  if (state.shownOne) chunks.push(SEPARATOR);
  chunks.push(encode(node.text));
  state.shownOne = true;
  if (node.kind === 'tag') {
    emit(node.target, chunks, shownCommits, state);
  }
}

function concat(chunks: ReadonlyArray<Uint8Array>): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
