/**
 * Packed-refs serializer/parser. Emits `# pack-refs with: <traits>`
 * header + one line per ref + optional `^<peeled-sha>` lines for
 * annotated tags. Round-trips against canonical `git pack-refs --all`.
 *
 * @writes
 *   surface: packedRefs
 *   kind:    byte-identical
 *   format:  git-packed-refs
 */
import { ObjectId as ObjectIdFactory, RefName as RefNameFactory } from '../objects/index.js';
import { invalidPackedRefs } from './error.js';
import type { PackedRefEntry, PackedRefs } from './ref-types.js';

const HEADER_PREFIX = '# pack-refs with:';

export function parsePackedRefs(content: string): PackedRefs {
  // Stryker disable next-line ConditionalExpression,BlockStatement,StringLiteral: equivalent — falling through with '' yields ''.split('\n')=[''], parseHeader gives peeling='none'/sorted=false, parseEntries skips the empty line, producing the identical {entries:[],peeling:'none',sorted:false}.
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
    // Stryker disable next-line MethodExpression: equivalent — traits are matched via includes(); the fixed prefix words ('#','pack-refs','with:') never equal a trait name, and split(/\s+/) tolerates surrounding whitespace, so dropping slice/trim leaves trait detection unchanged.
    const traitStr = firstLine.slice(HEADER_PREFIX.length).trim();
    // Stryker disable next-line ConditionalExpression,StringLiteral,ArrayDeclaration,Regex: equivalent — '' and split('') both yield no trait matches; traitStr is never the Stryker literal; ['Stryker was here'] contains no trait name; /\s/ vs /\s+/ only differs by empty-string fragments which includes() ignores.
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

  // Stryker disable next-line EqualityOperator: equivalent — at i===lines.length, lines[i] is undefined and the `line === undefined` guard continues, producing no entry.
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
    // Stryker disable next-line ConditionalExpression,EqualityOperator: equivalent — V8's stable sort only moves an element when the comparator returns < 0; the second ternary only ever yields 1 or 0, so its condition (>, >=, <=, true, false) never changes any final position
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
  // Canonical git emits a trailing space after the trait list (e.g.
  // `# pack-refs with: peeled fully-peeled sorted `); preserve it so the
  // file is byte-identical to `git pack-refs --all` output.
  return traits.length > 0 ? `# pack-refs with: ${traits.join(' ')} ` : '# pack-refs with:';
}
