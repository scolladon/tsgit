import type { TreeEntry } from '../objects/index.js';
import { FILE_MODE } from '../objects/index.js';
import { constructPathWithFanout, constructSubtreePath, determineFanout } from './fanout.js';
import { unpackSubtree } from './load.js';
import { nibbleHex } from './trie.js';
import type { NotesTrie, Slot, SubtreeReader, WritePlan, WritePlanEntry } from './types.js';

const HEX_PER_BYTE = 2;

const preservedEntry = (entry: TreeEntry, prefix: string): WritePlanEntry => ({
  name: prefix === '' ? entry.name : `${constructSubtreePath(prefix)}/${entry.name}`,
  mode: entry.mode,
  oid: entry.id,
});

const emitSlot = async (
  slot: Slot,
  index: number,
  read: SubtreeReader,
  n: number,
  fanout: number,
  prefix: string,
): Promise<ReadonlyArray<WritePlanEntry>> => {
  if (slot.kind === 'empty') return [];
  if (slot.kind === 'note')
    return [
      { name: constructPathWithFanout(slot.key, fanout), mode: FILE_MODE.REGULAR, oid: slot.val },
    ];
  if (slot.kind === 'internal')
    return (await walkForWrite(slot.node, read, n + 1, fanout, prefix + nibbleHex(index))).entries;
  if (n < HEX_PER_BYTE * fanout)
    return [{ name: constructSubtreePath(slot.prefix), mode: FILE_MODE.DIRECTORY, oid: slot.oid }];
  return (
    await walkForWrite(
      await unpackSubtree(slot, read),
      read,
      slot.prefix.length,
      fanout,
      slot.prefix,
    )
  ).entries;
};

const walkForWrite = async (
  node: NotesTrie,
  read: SubtreeReader,
  n: number,
  fanout: number,
  prefix: string,
): Promise<WritePlan> => {
  const effective = determineFanout(node, n, fanout);
  const slotEntries: WritePlanEntry[] = [];
  for (const [index, slot] of node.slots.entries()) {
    slotEntries.push(...(await emitSlot(slot, index, read, n, effective, prefix)));
  }
  const preserved = node.preserved.map((entry) => preservedEntry(entry, prefix));
  return { entries: [...slotEntries, ...preserved] };
};

/**
 * Walks the trie to emit one flat tree level. Fanout is per-subtree and threaded:
 * each node uses its own `determineFanout` result to name leaves and passes it
 * down. Notes carry their full fanout path (`constructPathWithFanout`), so the
 * flat plan needs no per-level prefixing; the bridge regroups multi-segment names
 * into nested trees.
 */
export const planWrite = (
  trie: NotesTrie,
  read: SubtreeReader,
  n = 0,
  fanout = 0,
): Promise<WritePlan> => walkForWrite(trie, read, n, fanout, '');
