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

import type { RefName } from '../objects/index.js';
import { ObjectId as ObjectIdFactory, RefName as RefNameFactory } from '../objects/index.js';
import { invalidPackedRefs } from './error.js';
import type { PackedRefEntry, PackedRefs } from './ref-types.js';
import { isSafeRefName } from './ref-validation.js';

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
    if (!isSafeRefName(name)) {
      throw invalidPackedRefs(`packed refname is dangerous: ${name.slice(0, 80)}`);
    }
    const id = ObjectIdFactory.from(sha);
    entries.push({ name: RefNameFactory.from(name), id });
  }

  return entries;
}

/** One line per entry, in the order given, each annotated tag's `^` peel
 *  line following its own ref line. */
function renderEntries(entries: ReadonlyArray<PackedRefEntry>): ReadonlyArray<string> {
  const lines: string[] = [];
  for (const entry of entries) {
    lines.push(`${entry.id} ${entry.name}`);
    if (entry.peeled !== undefined) {
      lines.push(`^${entry.peeled}`);
    }
  }
  return lines;
}

export function serializePackedRefs(refs: PackedRefs): string {
  if (refs.entries.length === 0) {
    return '';
  }

  const sorted = [...refs.entries].sort((a, b) =>
    // Stryker disable next-line ConditionalExpression,EqualityOperator: equivalent — V8's stable sort only moves an element when the comparator returns < 0; the second ternary only ever yields 1 or 0, so its condition (>, >=, <=, true, false) never changes any final position
    (a.name as string) < (b.name as string) ? -1 : (a.name as string) > (b.name as string) ? 1 : 0,
  );

  return `${[buildHeaderLine(refs), ...renderEntries(sorted)].join('\n')}\n`;
}

/** {@link packedRefsWithout}'s result: the surviving entries, in their
 *  original relative order, and the rewrite's text — so a caller caching the
 *  parsed file can adopt `entries` without re-parsing `content` (a lookup by
 *  name, or a name-sorted listing, reads the two identically). */
export interface PackedRefsRewrite {
  readonly entries: ReadonlyArray<PackedRefEntry>;
  readonly content: string;
}

/**
 * git's `write_with_updates`: the names to drop are walked in byte order
 * alongside the snapshot in the order it is held, and a name is dropped only
 * where the two walks meet. A snapshot whose order really is sorted meets
 * every one of them; a snapshot a `sorted` header claims but whose lines do
 * not honour lets the walk step past a name, and that line survives the
 * rewrite exactly as git leaves it.
 */
function keptAfterDrops(
  entries: ReadonlyArray<PackedRefEntry>,
  names: ReadonlySet<RefName>,
): ReadonlyArray<PackedRefEntry> {
  const dropping = [...names].sort();
  const kept: PackedRefEntry[] = [];
  let next = 0;
  for (const entry of entries) {
    // Equivalent mutant, deliberately not suppressed — a line-level disable would also silence the detected mutants sharing this line. past the end `dropping[next]` is undefined and compares false against any name, so widening or dropping this bound still halts the walk on the same step.
    while (next < dropping.length && (dropping[next] as string) < (entry.name as string)) next++;
    if (dropping[next] === entry.name) next++;
    else kept.push(entry);
  }
  return kept;
}

/**
 * git's `packed-refs` rewrite without `names` (the files backend's delete
 * path): the survivors are re-serialized under git's own canonical header
 * (`buildHeaderLine`'s traits, never the file's old header), in the order the
 * snapshot holds them, with every surviving line and `^` value copied
 * verbatim — never re-peeled, never reading an object. Dropping the last
 * entry leaves the header line alone.
 */
export function packedRefsWithout(
  entries: ReadonlyArray<PackedRefEntry>,
  names: ReadonlySet<RefName>,
): PackedRefsRewrite {
  const kept = keptAfterDrops(entries, names);
  const header = buildHeaderLine({ entries: [], peeling: 'fully', sorted: true });
  return { entries: kept, content: `${[header, ...renderEntries(kept)].join('\n')}\n` };
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
