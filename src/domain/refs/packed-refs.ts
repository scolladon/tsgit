import { ObjectId as ObjectIdFactory, RefName as RefNameFactory } from '../objects/index.js';
import { invalidPackedRefs } from './error.js';
import type { PackedRefEntry, PackedRefs } from './ref-types.js';

const HEADER_PREFIX = '# pack-refs with:';

export function parsePackedRefs(content: string): PackedRefs {
  if (content === '') {
    return { entries: [], peeling: 'none', sorted: false };
  }

  const lines = content.split('\n');
  const { peeling, sorted, startIndex } = parseHeader(lines);
  const entries = parseEntries(lines, startIndex);

  return { entries, peeling, sorted };
}

function parseHeader(lines: ReadonlyArray<string>): {
  readonly peeling: 'none' | 'tags' | 'fully';
  readonly sorted: boolean;
  readonly startIndex: number;
} {
  const firstLine = lines[0];
  if (firstLine?.startsWith(HEADER_PREFIX)) {
    const traitStr = firstLine.slice(HEADER_PREFIX.length).trim();
    const traits = traitStr === '' ? [] : traitStr.split(/\s+/);
    const hasPeeled = traits.includes('peeled');
    const hasFullyPeeled = traits.includes('fully-peeled');
    const sorted = traits.includes('sorted');
    const peeling = hasFullyPeeled ? 'fully' : hasPeeled ? 'tags' : 'none';
    return { peeling, sorted, startIndex: 1 };
  }
  return { peeling: 'none', sorted: false, startIndex: 0 };
}

function parseEntries(
  lines: ReadonlyArray<string>,
  startIndex: number,
): ReadonlyArray<PackedRefEntry> {
  const entries: PackedRefEntry[] = [];

  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined || line === '' || line.startsWith('#')) {
      continue;
    }

    if (line.startsWith('^')) {
      if (entries.length === 0) {
        throw invalidPackedRefs('peel line without preceding ref entry');
      }
      const peeled = ObjectIdFactory.from(line.slice(1));
      const lastIndex = entries.length - 1;
      const last = entries[lastIndex] as PackedRefEntry;
      entries[lastIndex] = { ...last, peeled };
      continue;
    }

    const spaceIdx = line.indexOf(' ');
    if (spaceIdx === -1) {
      throw invalidPackedRefs(`invalid ref line format: ${line.slice(0, 80)}`);
    }

    const sha = line.slice(0, spaceIdx);
    const name = line.slice(spaceIdx + 1);
    const id = ObjectIdFactory.from(sha);
    entries.push({ name: RefNameFactory.from(name), id });
  }

  return entries;
}

export function serializePackedRefs(refs: PackedRefs): string {
  if (refs.entries.length === 0) {
    return '';
  }

  const sorted = [...refs.entries].sort((a, b) =>
    (a.name as string) < (b.name as string) ? -1 : (a.name as string) > (b.name as string) ? 1 : 0,
  );

  const lines: string[] = [];
  lines.push(buildHeaderLine(refs));

  for (const entry of sorted) {
    lines.push(`${entry.id} ${entry.name}`);
    if (entry.peeled !== undefined) {
      lines.push(`^${entry.peeled}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

function buildHeaderLine(refs: PackedRefs): string {
  const traits: string[] = [];
  if (refs.peeling === 'tags' || refs.peeling === 'fully') {
    traits.push('peeled');
  }
  if (refs.peeling === 'fully') {
    traits.push('fully-peeled');
  }
  if (refs.sorted) {
    traits.push('sorted');
  }
  return traits.length > 0 ? `# pack-refs with: ${traits.join(' ')}` : '# pack-refs with:';
}
